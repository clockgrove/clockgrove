// Phaser 4.2.1 candidate: built-in lights and normal maps for the lit surfaces, small custom GLSL
// (Shader game objects) for what the lighting lacks, and the Bloom action on the camera. Spike code.
import type {
  ScenePatch,
  SceneProjection,
  SceneTransientCue,
  WorldObjectId,
} from "@clockgrove/contracts";
import Phaser from "phaser";
import { applyScenePatch } from "../../../../apps/web/src/world-scene-adapter.js";
import {
  type BakeoffAdapter,
  type CameraState,
  type CandidateDescription,
  type CandidateOptions,
  type FeatureSupport,
  LOOK_FEATURES,
  type LookFeature,
  type QualityTier,
  registerCandidate,
  type SceneIntent,
  TIER_FEATURES,
  type Unsubscribe,
} from "../contract.js";
import { type AssetId, materialSet } from "../inputs/materials.js";
import {
  CAMERA_ELEVATION_DEGREES,
  GROUND,
  isoProject,
  type LightRig,
  lightRigOf,
  PIXELS_PER_METRE,
  spritesOf,
  WALL,
} from "../inputs/scene.js";

type Kind = "albedo" | "dark" | "sheen" | "emissive";
const KINDS: readonly Kind[] = ["albedo", "dark", "sheen", "emissive"];
type Maps = Record<Kind | "normal", HTMLCanvasElement>;
type Image = Phaser.GameObjects.Image;

const WIND_STRIPS = 8;
const RAIN_POOL = 1200;
const SIN_E = Math.sin((CAMERA_ELEVATION_DEGREES * Math.PI) / 180);
const DEPTH_FOG = 500;
const DEPTH_RAIN = 600;
const REFLECTED = 3;

interface AssetInfo {
  readonly key: string;
  readonly strips: number;
  readonly bounds: readonly number[];
  readonly weights: readonly number[];
  readonly phases: readonly number[];
  readonly texH: number;
}
interface Piece {
  readonly objectId: string;
  readonly info: AssetInfo | null;
  readonly images: Record<Kind, Image[]>;
  left: number;
  top: number;
  wpx: number;
  hpx: number;
}

const canvasOf = (data: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext("2d")
    ?.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
};

/** Wetness derived maps: a black darkening layer and a grey sheen layer, both shaped by the silhouette. */
function mapsOf(assetId: AssetId): { maps: Maps; w: number; h: number; wind: Uint8ClampedArray } {
  const set = materialSet(assetId);
  const dark = new Uint8ClampedArray(set.width * set.height * 4);
  const sheen = new Uint8ClampedArray(set.width * set.height * 4);
  for (let i = 0; i < set.width * set.height * 4; i += 4) {
    const alpha = set.albedo[i + 3] ?? 0;
    const rough = set.roughnessWetness[i] ?? 255;
    const wet = (set.roughnessWetness[i + 1] ?? 0) / 255;
    dark[i + 3] = alpha * wet;
    const shine = (255 - rough) * wet;
    sheen[i] = shine;
    sheen[i + 1] = shine;
    sheen[i + 2] = shine;
    sheen[i + 3] = alpha;
  }
  const make = (data: Uint8ClampedArray) => canvasOf(data, set.width, set.height);
  return {
    maps: {
      albedo: make(set.albedo),
      normal: make(set.normal),
      emissive: make(set.emissive),
      dark: make(dark),
      sheen: make(sheen),
    },
    w: set.width,
    h: set.height,
    wind: set.wind,
  };
}

/** A pure hash of an integer and a channel to 0..1, so rain depends on nothing but time. */
function hash01(i: number, k: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4_294_967_296;
}
const packRgb = (c: readonly [number, number, number]): number =>
  ((Math.round(Math.min(1, Math.max(0, c[0])) * 255) << 16) |
    (Math.round(Math.min(1, Math.max(0, c[1])) * 255) << 8) |
    Math.round(Math.min(1, Math.max(0, c[2])) * 255)) >>>
  0;

const FRAGMENT_HEAD = [
  "#pragma phaserTemplate(shaderName)",
  "#pragma phaserTemplate(extensions)",
  "#pragma phaserTemplate(features)",
  "#ifdef GL_FRAGMENT_PRECISION_HIGH",
  "precision highp float;",
  "#else",
  "precision mediump float;",
  "#endif",
  "#pragma phaserTemplate(fragmentDefine)",
  "varying vec2 outTexCoord;",
  "#pragma phaserTemplate(outVariables)",
  "#pragma phaserTemplate(fragmentHeader)",
].join("\n");

// Fog: exponential in view depth, with depth recovered from the screen row the way isoProject maps it.
const FOG_BODY = `
uniform vec3 uFogColor; uniform float uDensity; uniform float uScale; uniform float uSin; uniform vec2 uSize;
void main () {
  float sy = (1.0 - outTexCoord.y) * uSize.y;
  float d = max(0.0, 3.0 + (uSize.y * 0.5 - sy) / uScale * 1.41421356 / uSin);
  float a = 1.0 - exp(-uDensity * d);
  gl_FragColor = vec4(uFogColor * a, a);
}`;

// Puddles: each fragment inside a ground ellipse samples the sprites mirrored about their base, lights
// them by distance to the two point lights, tints them dark and lays them over a water colour.
const PUDDLE_BODY = `
uniform sampler2D uA0; uniform sampler2D uA1; uniform sampler2D uA2;
uniform sampler2D uE0; uniform sampler2D uE1; uniform sampler2D uE2;
uniform vec4 uR0; uniform vec4 uR1; uniform vec4 uR2;
uniform vec4 uP0; uniform vec4 uP1; uniform vec4 uL0; uniform vec4 uL1;
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uAmbient; uniform vec3 uWater;
uniform vec2 uSize; uniform float uScale; uniform float uSin; uniform float uTime; uniform float uRain; uniform float uEmit;

vec3 lightAt (vec2 s) {
  vec3 lit = uAmbient;
  float d0 = distance(s, uL0.xy); lit += uC0 * uL0.w * clamp(1.0 - d0 * d0 / max(uL0.z * uL0.z, 1.0), 0.0, 1.0) * 0.6;
  float d1 = distance(s, uL1.xy); lit += uC1 * uL1.w * clamp(1.0 - d1 * d1 / max(uL1.z * uL1.z, 1.0), 0.0, 1.0) * 0.6;
  return lit;
}
vec4 mirrored (sampler2D a, sampler2D e, vec4 r, vec2 p) {
  float baseY = r.y + r.w;
  vec2 s = vec2(p.x, 2.0 * baseY - p.y);
  vec2 uv = vec2((s.x - r.x) / max(r.z, 1.0), (s.y - r.y) / max(r.w, 1.0));
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(1.0, r.z) * step(p.y, baseY + r.w);
  vec2 c = clamp(uv, 0.0, 1.0);
  vec4 tex = texture2D(a, c);
  vec3 glow = texture2D(e, c).rgb * uEmit;
  vec3 colour = tex.rgb / max(tex.a, 0.001) * lightAt(s) + glow;
  return vec4(colour, tex.a * inside);
}
float puddleMask (vec4 q, vec2 p) {
  vec2 d = p - q.xy;
  float right = d.x / uScale; float up = -d.y / uScale;
  float sum = right * 1.41421356; float diff = up * 1.41421356 / uSin;
  float gx = (sum - diff) * 0.5 / max(q.z, 0.001); float gy = (sum + diff) * 0.5 / max(q.w, 0.001);
  return (1.0 - smoothstep(0.7, 1.0, gx * gx + gy * gy)) * step(0.001, q.z);
}
void main () {
  vec2 p = vec2(outTexCoord.x, 1.0 - outTexCoord.y) * uSize;
  float mask = max(puddleMask(uP0, p), puddleMask(uP1, p));
  vec3 refl = vec3(0.0); float ra = 0.0;
  vec4 m0 = mirrored(uA0, uE0, uR0, p); refl = mix(refl, m0.rgb, m0.a); ra = ra + m0.a * (1.0 - ra);
  vec4 m1 = mirrored(uA1, uE1, uR1, p); refl = mix(refl, m1.rgb, m1.a); ra = ra + m1.a * (1.0 - ra);
  vec4 m2 = mirrored(uA2, uE2, uR2, p); refl = mix(refl, m2.rgb, m2.a); ra = ra + m2.a * (1.0 - ra);
  refl *= vec3(0.55, 0.65, 0.8);
  float ripple = 0.5 + 0.5 * sin(length(p) * 0.35 - uTime * 0.004);
  vec3 colour = mix(uWater, refl, ra * 0.85) + uRain * 0.03 * ripple;
  float alpha = mask * (0.6 + 0.3 * ra);
  gl_FragColor = vec4(colour * alpha, alpha);
}`;

class PhaserBakeoff implements BakeoffAdapter {
  private game: Phaser.Game | undefined;
  private scene: Phaser.Scene | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private projection: SceneProjection | undefined;
  private rig: LightRig | undefined;
  private tier: QualityTier = "high";
  private camera: CameraState = { panX: 0, panY: 0.5, zoom: 1 };
  private cameraKey = "";
  private reduced = false;
  private time = 0;
  private selected: WorldObjectId | undefined;
  private focused: WorldObjectId | undefined;
  private readonly handlers = new Set<(intent: SceneIntent) => void>();
  private readonly assets = new Map<AssetId, AssetInfo>();
  private pieces: Piece[] = [];
  private env: Piece | undefined;
  private envGeneration = 0;
  private envKeys: string[] = [];
  private envBytes = 0;
  private textureBytes = 0;
  private bloom: Phaser.Types.Actions.AddEffectBloomReturn | undefined;
  private lights: Phaser.GameObjects.Light[] = [];
  private lightSpecs: LightRig["lights"] = [];
  private rain: Image[] = [];
  private puddleShader: Phaser.GameObjects.Shader | undefined;
  private fogShader: Phaser.GameObjects.Shader | undefined;
  private rects: number[][] = [];
  private signature = "";
  private readonly pixel = new Uint8Array(4);

  constructor(private readonly options: CandidateOptions) {}

  private get scale(): number {
    return PIXELS_PER_METRE * this.camera.zoom;
  }
  private get features() {
    return TIER_FEATURES[this.tier];
  }

  init(): Promise<void> {
    const owner = this;
    const { host, width, height } = this.options;
    return new Promise<void>((resolve, reject) => {
      try {
        this.game = new Phaser.Game({
          type: Phaser.WEBGL,
          parent: host,
          width,
          height,
          backgroundColor: "#000000",
          banner: false,
          audio: { noAudio: true },
          scale: { mode: Phaser.Scale.NONE, zoom: 1 },
          render: { preserveDrawingBuffer: true, antialiasGL: false, maxLights: 10 },
          scene: {
            create() {
              try {
                owner.onCreate(this);
                resolve();
              } catch (error) {
                reject(error);
              }
            },
          },
        });
      } catch (error) {
        reject(error);
      }
    }).then(() => {
      // Booting starts Phaser's own rAF loop after create; frames here are stepped by renderFrame only.
      this.game?.loop.stop();
    });
  }

  private onCreate(scene: Phaser.Scene): void {
    this.scene = scene;
    const renderer = scene.sys.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    this.gl = renderer.gl as WebGL2RenderingContext;
    scene.lights.enable();
    const streak = document.createElement("canvas");
    streak.width = 3;
    streak.height = 28;
    const ctx = streak.getContext("2d");
    if (ctx) {
      const fade = ctx.createLinearGradient(0, 0, 0, 28);
      fade.addColorStop(0, "rgba(255,255,255,0)");
      fade.addColorStop(1, "rgba(255,255,255,0.9)");
      ctx.fillStyle = fade;
      ctx.fillRect(1, 0, 1, 28);
    }
    this.addTexture("rain-streak", streak, null, [[0, 28]]);
    // Bloom is built once at full strength; tiers switch it off or halve it.
    this.bloom = Phaser.Actions.AddEffectBloom(scene.cameras.main, {
      threshold: 0.55,
      blurRadius: 2,
      blurSteps: 4,
      blurQuality: 0,
      blendAmount: 1,
      useInternal: true,
    })[0];
    if (this.projection) this.build();
  }

  /** Registers a canvas as a texture with strip frames s0..sN and an optional normal-map data source. */
  private addTexture(
    key: string,
    canvas: HTMLCanvasElement,
    normal: HTMLCanvasElement | null,
    rows: readonly (readonly [number, number])[],
  ): number {
    const texture = this.scene?.textures.addCanvas(key, canvas);
    if (!texture) throw new Error(`phaser: texture ${key} already exists`);
    if (normal) texture.setDataSource(normal);
    rows.forEach(([y0, y1], i) => {
      texture.add(`s${i}`, 0, 0, y0, canvas.width, y1 - y0);
    });
    const bytes = canvas.width * canvas.height * 4 * (normal ? 2 : 1);
    return bytes;
  }

  private assetInfo(assetId: AssetId): AssetInfo {
    const known = this.assets.get(assetId);
    if (known) return known;
    const { maps, w, h, wind } = mapsOf(assetId);
    const band = (i: number) =>
      [Math.floor((i * h) / WIND_STRIPS), Math.floor(((i + 1) * h) / WIND_STRIPS)] as const;
    const weights: number[] = [];
    const phases: number[] = [];
    for (let i = 0; i < WIND_STRIPS; i++) {
      const [y0, y1] = band(i);
      let r = 0;
      let g = 0;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < w; x++) {
          r += wind[(y * w + x) * 4] ?? 0;
          g += wind[(y * w + x) * 4 + 1] ?? 0;
        }
      const n = Math.max(1, (y1 - y0) * w);
      weights.push(r / n / 255);
      phases.push(g / n / 255);
    }
    const windy = Math.max(...weights) > 0.02;
    const strips = windy ? WIND_STRIPS : 1;
    const rows = windy ? Array.from({ length: strips }, (_, i) => band(i)) : [[0, h] as const];
    for (const kind of KINDS)
      this.textureBytes += this.addTexture(
        `${assetId}:${kind}`,
        maps[kind],
        kind === "dark" || kind === "emissive" ? null : maps.normal,
        rows,
      );
    const info: AssetInfo = {
      key: assetId,
      strips,
      bounds: windy ? [...rows.map((r) => r[0]), h] : [0, h],
      weights,
      phases,
      texH: h,
    };
    this.assets.set(assetId, info);
    return info;
  }

  private makeImages(prefix: string, strips: number, depth: number): Record<Kind, Image[]> {
    const scene = this.scene;
    if (!scene) throw new Error("phaser: scene not ready");
    const images = { albedo: [], dark: [], sheen: [], emissive: [] } as Record<Kind, Image[]>;
    KINDS.forEach((kind, layer) => {
      for (let i = 0; i < strips; i++) {
        const image = scene.add
          .image(0, 0, `${prefix}:${kind}`, `s${i}`)
          .setOrigin(0, 0)
          .setDepth(depth + layer);
        if (kind === "albedo" || kind === "sheen") image.setLighting(true);
        if (kind === "sheen" || kind === "emissive") image.setBlendMode(Phaser.BlendModes.ADD);
        images[kind].push(image);
      }
    });
    return images;
  }

  private destroyPiece(piece: Piece): void {
    for (const kind of KINDS) for (const image of piece.images[kind]) image.destroy();
  }

  /** Rebuilds the sprites and the shaders that depend on them; lights and weather follow `refresh`. */
  private build(): void {
    const scene = this.scene;
    const projection = this.projection;
    if (!scene || !projection) return;
    for (const piece of this.pieces) this.destroyPiece(piece);
    this.pieces = [];
    this.puddleShader?.destroy();
    this.fogShader?.destroy();
    const sprites = spritesOf(projection);
    sprites.forEach((sprite, index) => {
      const info = this.assetInfo(sprite.assetId);
      this.pieces.push({
        objectId: sprite.objectId,
        info,
        images: this.makeImages(info.key, info.strips, 10 + index * 10),
        left: 0,
        top: 0,
        wpx: 0,
        hpx: 0,
      });
    });
    this.signature = JSON.stringify(sprites.map((s) => [s.objectId, s.assetId, s.x, s.y, s.z]));

    const reflected = this.pieces.slice(0, REFLECTED);
    const albedo = reflected.map((p) => `${p.info?.key}:albedo`);
    const emissive = reflected.map((p) => `${p.info?.key}:emissive`);
    while (albedo.length > 0 && albedo.length < REFLECTED) {
      albedo.push(albedo[0] ?? "");
      emissive.push(emissive[0] ?? "");
    }
    if (albedo.length > 0) {
      this.puddleShader = scene.add
        .shader(
          {
            name: "BakeoffPuddle",
            fragmentSource: FRAGMENT_HEAD + PUDDLE_BODY,
            setupUniforms: (set: (name: string, value: unknown) => void) =>
              this.puddleUniforms(set),
          },
          this.options.width / 2,
          this.options.height / 2,
          this.options.width,
          this.options.height,
          [...albedo, ...emissive],
        )
        .setDepth(4);
    }
    this.fogShader = scene.add
      .shader(
        {
          name: "BakeoffFog",
          fragmentSource: FRAGMENT_HEAD + FOG_BODY,
          setupUniforms: (set: (name: string, value: unknown) => void) => this.fogUniforms(set),
        },
        this.options.width / 2,
        this.options.height / 2,
        this.options.width,
        this.options.height,
      )
      .setDepth(DEPTH_FOG);
    if (this.rain.length === 0)
      for (let i = 0; i < RAIN_POOL; i++)
        this.rain.push(
          scene.add
            .image(0, 0, "rain-streak", "s0")
            .setOrigin(0.5, 0)
            .setDepth(DEPTH_RAIN)
            .setVisible(false),
        );
    this.bakeEnvironment();
    this.refresh();
  }

  /** Ground and wall are affine-warped into the camera's view once per camera, then lit like sprites. */
  private bakeEnvironment(): void {
    const scene = this.scene;
    if (!scene) return;
    if (this.env) this.destroyPiece(this.env);
    for (const key of this.envKeys) scene.textures.remove(key);
    this.envKeys = [];
    this.textureBytes -= this.envBytes;
    this.envBytes = 0;
    const { width, height } = this.options;
    const targets = {} as Maps;
    const contexts = {} as Record<Kind | "normal", CanvasRenderingContext2D | null>;
    for (const name of ["albedo", "dark", "sheen", "emissive", "normal"] as const) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      targets[name] = canvas;
      contexts[name] = canvas.getContext("2d");
    }
    const emissiveContext = contexts.emissive;
    if (emissiveContext) {
      emissiveContext.fillStyle = "#000";
      emissiveContext.fillRect(0, 0, width, height);
    }
    const warp = (
      assetId: AssetId,
      tl: readonly [number, number, number],
      tr: readonly [number, number, number],
      bl: readonly [number, number, number],
    ) => {
      const { maps, w, h } = mapsOf(assetId);
      const a = isoProject(tl[0], tl[1], tl[2], this.camera, width, height);
      const b = isoProject(tr[0], tr[1], tr[2], this.camera, width, height);
      const c = isoProject(bl[0], bl[1], bl[2], this.camera, width, height);
      for (const name of ["albedo", "dark", "sheen", "emissive", "normal"] as const) {
        const ctx = contexts[name];
        if (!ctx) continue;
        ctx.setTransform(
          (b.sx - a.sx) / w,
          (b.sy - a.sy) / w,
          (c.sx - a.sx) / h,
          (c.sy - a.sy) / h,
          a.sx,
          a.sy,
        );
        ctx.drawImage(maps[name], 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    };
    const gx0 = GROUND.centreX - GROUND.width / 2;
    const gx1 = GROUND.centreX + GROUND.width / 2;
    const gyTop = GROUND.centreY + GROUND.depth / 2;
    const gyBottom = GROUND.centreY - GROUND.depth / 2;
    warp(GROUND.assetId, [gx0, gyTop, 0], [gx1, gyTop, 0], [gx0, gyBottom, 0]);
    warp(
      WALL.assetId,
      [WALL.x0, WALL.y, WALL.height],
      [WALL.x1, WALL.y, WALL.height],
      [WALL.x0, WALL.y, 0],
    );
    const prefix = `env${this.envGeneration++}`;
    for (const kind of KINDS) {
      const key = `${prefix}:${kind}`;
      this.envBytes += this.addTexture(
        key,
        targets[kind],
        kind === "albedo" || kind === "sheen" ? targets.normal : null,
        [[0, height]],
      );
      this.envKeys.push(key);
    }
    this.textureBytes += this.envBytes;
    this.env = {
      objectId: "environment",
      info: null,
      images: this.makeImages(prefix, 1, 0),
      left: 0,
      top: 0,
      wpx: width,
      hpx: height,
    };
    this.styleLayers();
  }

  /** Lights, ambient, background and the per-tier layer switches, from the current projection's rig. */
  private refresh(): void {
    const scene = this.scene;
    const projection = this.projection;
    if (!scene || !projection) return;
    const rig = lightRigOf(projection);
    this.rig = rig;
    scene.cameras.main.setBackgroundColor(packRgb(rig.clearColor));
    const ambient = [0, 1, 2].map(
      (i) =>
        (rig.ambient.color[i] ?? 0) * rig.ambient.intensity +
        (rig.sky.color[i] ?? 0) * rig.sky.intensity * 0.3,
    );
    scene.lights.setAmbientColor(packRgb(ambient as [number, number, number]));
    for (const light of this.lights) scene.lights.removeLight(light);
    this.lights = rig.lights.map((spec) =>
      scene.lights.addLight(0, 0, 1, packRgb(spec.color), spec.intensity, 1),
    );
    this.lightSpecs = rig.lights;
    this.layout();
    this.styleLayers();
  }

  /** Everything that depends on the camera or the rig but not on time. */
  private layout(): void {
    const { width, height } = this.options;
    const projection = this.projection;
    if (!projection) return;
    const sprites = spritesOf(projection);
    this.pieces.forEach((piece, i) => {
      const sprite = sprites[i];
      if (!sprite) return;
      const base = isoProject(sprite.x, sprite.y, sprite.z, this.camera, width, height);
      const top = isoProject(
        sprite.x,
        sprite.y,
        sprite.z + sprite.height,
        this.camera,
        width,
        height,
      );
      piece.wpx = sprite.width * this.scale;
      piece.hpx = base.sy - top.sy;
      piece.left = base.sx - piece.wpx / 2;
      piece.top = top.sy;
    });
    this.rects = this.pieces.slice(0, REFLECTED).map((p) => [p.left, p.top, p.wpx, p.hpx]);
    this.lights.forEach((light, i) => {
      const spec = this.lightSpecs[i];
      if (!spec) return;
      const at = isoProject(spec.x, spec.y, spec.z, this.camera, width, height);
      light.setPosition(at.sx, at.sy);
      light.radius = spec.range * this.scale;
      light.z = 0.6 * this.scale;
    });
  }

  /** Tier switches: which layers draw and how strongly. */
  private styleLayers(): void {
    const rig = this.rig;
    if (!rig) return;
    const f = this.features;
    const lit = rig.lights.length > 0 ? 1 : 0;
    const style = (piece: Piece | undefined) => {
      if (!piece) return;
      for (const image of piece.images.dark)
        image.setVisible(f.wetness).setAlpha(0.5 * rig.wetness);
      for (const image of piece.images.sheen)
        image.setVisible(f.wetness).setAlpha(0.8 * rig.wetness);
      for (const image of piece.images.emissive)
        image.setVisible(f.emissive && lit > 0).setAlpha(lit);
      const tint =
        piece.objectId === this.selected
          ? 0xfff1a8
          : piece.objectId === this.focused
            ? 0xa8d8ff
            : 0xffffff;
      for (const image of piece.images.albedo) image.setTint(tint);
    };
    style(this.env);
    for (const piece of this.pieces) style(piece);
    this.puddleShader?.setVisible(f.reflections && rig.puddles.length > 0);
    this.fogShader?.setVisible(f.fog);
    const bloom = this.bloom;
    if (bloom) {
      bloom.parallelFilters.active = f.bloom !== "off";
      bloom.parallelFilters.blend.amount = f.bloom === "half" ? 0.5 : 1;
    }
  }

  private fogUniforms(set: (name: string, value: unknown) => void): void {
    const rig = this.rig;
    if (!rig) return;
    set("uFogColor", [...rig.fog.color]);
    set("uDensity", rig.fog.density);
    set("uScale", this.scale);
    set("uSin", SIN_E);
    set("uSize", [this.options.width, this.options.height]);
  }

  private puddleUniforms(set: (name: string, value: unknown) => void): void {
    const rig = this.rig;
    if (!rig) return;
    const { width, height } = this.options;
    const dim = [width, height];
    set("uSize", dim);
    set("uScale", this.scale);
    set("uSin", SIN_E);
    set("uTime", this.time);
    set("uRain", rig.rain);
    set("uEmit", rig.lights.length > 0 ? 1 : 0);
    set(
      "uAmbient",
      [0, 1, 2].map(
        (i) =>
          (rig.ambient.color[i] ?? 0) * rig.ambient.intensity +
          (rig.sky.color[i] ?? 0) * rig.sky.intensity * 0.3,
      ),
    );
    set(
      "uWater",
      rig.fog.color.map((c) => c * 0.45),
    );
    for (let i = 0; i < REFLECTED; i++) {
      set(`uA${i}`, i);
      set(`uE${i}`, REFLECTED + i);
      set(`uR${i}`, this.rects[i] ?? [0, 0, 0, 0]);
    }
    for (let i = 0; i < 2; i++) {
      const puddle = rig.puddles[i];
      const at = puddle ? isoProject(puddle.x, puddle.y, 0, this.camera, width, height) : undefined;
      set(`uP${i}`, puddle && at ? [at.sx, at.sy, puddle.rx, puddle.ry] : [0, 0, 0, 0]);
      const spec = rig.lights.find((l) => l.role === (i === 0 ? "lantern" : "window"));
      const light = spec
        ? isoProject(spec.x, spec.y, spec.z, this.camera, width, height)
        : undefined;
      const flicker = spec ? this.flicker(spec.flicker) : 0;
      set(
        `uL${i}`,
        spec && light
          ? [light.sx, light.sy, spec.range * this.scale, spec.intensity * flicker]
          : [0, 0, 1, 0],
      );
      set(`uC${i}`, spec ? [...spec.color] : [0, 0, 0]);
    }
  }

  private flicker(amplitude: number): number {
    const t = this.time;
    return 1 + amplitude * (0.5 * Math.sin(t * 0.017) + 0.5 * Math.sin(t * 0.043 + 1.3));
  }

  /** Animated state as a pure function of time: flicker, wind sway and rain. */
  private animate(t: number): void {
    const rig = this.rig;
    if (!rig) return;
    this.time = t;
    const { width, height } = this.options;
    this.lights.forEach((light, i) => {
      const spec = this.lightSpecs[i];
      if (spec) light.intensity = spec.intensity * this.flicker(spec.flicker);
    });
    const windy = this.features.wind;
    for (const piece of this.pieces) {
      const info = piece.info;
      if (!info) continue;
      for (let i = 0; i < info.strips; i++) {
        const y0 = piece.top + ((info.bounds[i] ?? 0) / info.texH) * piece.hpx;
        const y1 = piece.top + ((info.bounds[i + 1] ?? info.texH) / info.texH) * piece.hpx;
        const sway =
          windy && info.strips > 1
            ? rig.wind *
              piece.wpx *
              0.14 *
              (info.weights[i] ?? 0) *
              Math.sin(t * 0.0024 + (info.phases[i] ?? 0) * 6.283 + i * 0.35)
            : 0;
        for (const kind of KINDS) {
          const image = piece.images[kind][i];
          image
            ?.setPosition(piece.left + sway, y0)
            .setDisplaySize(piece.wpx, y1 - y0 + (info.strips > 1 ? 0.75 : 0));
        }
      }
    }
    const count = Math.min(RAIN_POOL, Math.floor(this.features.rainParticles * rig.rain));
    const slant = rig.wind * 0.35;
    const period = height + 80;
    this.rain.forEach((streak, i) => {
      const visible = i < count;
      streak.setVisible(visible);
      if (!visible) return;
      const speed = 700 + 500 * hash01(i, 3);
      const y = ((hash01(i, 2) * period + (t * speed) / 1000) % period) - 40;
      const x =
        hash01(i, 1) * (width + 300) - 150 - (period * Math.tan(slant)) / 2 + y * Math.tan(slant);
      streak
        .setPosition(x, y)
        .setRotation(-slant)
        .setScale(1, (14 + 16 * hash01(i, 4)) / 28)
        .setAlpha(0.25 + 0.35 * hash01(i, 5))
        .setTint(0xcfd8ff);
    });
  }

  loadSnapshot(snapshot: SceneProjection): void {
    this.projection = snapshot;
    this.build();
  }

  applyPatch(patch: ScenePatch): void {
    if (!this.projection || patch.fromRevision !== this.projection.revision) return;
    this.projection = applyScenePatch(this.projection, patch);
    const signature = JSON.stringify(
      spritesOf(this.projection).map((s) => [s.objectId, s.assetId, s.x, s.y, s.z]),
    );
    if (signature !== this.signature) this.build();
    else this.refresh();
  }

  emitCue(_cue: SceneTransientCue): void {}

  setSelection(id?: WorldObjectId): void {
    this.selected = id;
    this.styleLayers();
  }

  focus(id?: WorldObjectId): void {
    this.focused = id;
    this.styleLayers();
  }

  setReducedMotion(enabled: boolean): void {
    this.reduced = enabled;
  }

  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.styleLayers();
  }

  setCamera(camera: CameraState): void {
    // Re-baking the warped ground and wall is costly, and the harness sets the same camera every frame.
    const key = `${camera.panX}/${camera.panY}/${camera.zoom}`;
    if (key === this.cameraKey) return;
    this.cameraKey = key;
    this.camera = camera;
    this.bakeEnvironment();
    this.layout();
  }

  renderFrame(timeMs: number): Promise<void> {
    const game = this.game;
    const gl = this.gl;
    if (!game || !gl) return Promise.reject(new Error("phaser: init() has not completed"));
    const t = this.reduced ? 0 : timeMs;
    this.animate(t);
    game.step(t, 1000 / 60);
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    return Promise.resolve();
  }

  capture(): string {
    if (!this.game) throw new Error("phaser: init() has not completed");
    return this.game.canvas.toDataURL("image/png");
  }

  describe(): CandidateDescription {
    const gl = this.gl;
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const read = (unmasked: number | undefined, fallback: number): string =>
      String(
        (gl && (unmasked !== undefined ? gl.getParameter(unmasked) : undefined)) ??
          gl?.getParameter(fallback) ??
          "unknown",
      );
    const features: Record<LookFeature, FeatureSupport> = {
      normalMap: "native",
      heightMap: "missing",
      emissiveMap: "approximated",
      roughnessWetness: "approximated",
      windMap: "approximated",
      pointLights: "native",
      puddleReflections: "custom-shader",
      fog: "custom-shader",
      rainParticles: "approximated",
      bloom: "native",
    };
    const notes: Record<LookFeature, string | undefined> = {
      normalMap: undefined,
      heightMap:
        "Phaser has no parallax or height input; its self-shadow reads albedo brightness, not the height map, so it is unused.",
      emissiveMap:
        "No emissive channel: the emissive map is an unlit additive layer drawn over the lit sprite.",
      roughnessWetness:
        "Wetness is a black darkening layer plus a lit additive sheen layer; the lighting is diffuse, so there is no true specular lobe.",
      windMap:
        "Sprites are cut into 8 horizontal strips offset in x by the wind map's row-averaged weight; no per-texel vertex sway.",
      pointLights: undefined,
      puddleReflections:
        "Custom GLSL on a full-canvas Shader object mirrors the sprite albedo about their bases inside the puddle ellipses; lit by distance to the two lights, not by normals.",
      fog: "Custom GLSL full-canvas overlay; depth is recovered from the screen row, so it is per row and not per object.",
      rainParticles:
        "A pool of streak images placed by a pure function of time, not Phaser's particle emitter, so frames are reproducible.",
      bloom: undefined,
    };
    return {
      candidate: "phaser",
      api: "webgl2",
      rendererString: read(info?.UNMASKED_RENDERER_WEBGL, gl?.RENDERER ?? 0),
      vendorString: read(info?.UNMASKED_VENDOR_WEBGL, gl?.VENDOR ?? 0),
      webgpuAdapter: null,
      // Texture uploads plus an estimate of the camera filter targets (scene, bright pass, blur).
      estimatedGpuBytes: this.textureBytes + this.options.width * this.options.height * 4 * 3,
      features,
      notes: LOOK_FEATURES.flatMap((feature) => {
        const note = notes[feature];
        return features[feature] !== "native" && note ? [`${feature}: ${note}`] : [];
      }),
    };
  }

  destroy(): void {
    this.handlers.clear();
    this.game?.destroy(true);
    this.game = undefined;
    this.scene = undefined;
    this.gl = undefined;
  }
}

registerCandidate("phaser", (options) => new PhaserBakeoff(options));
