// The shared Three.js candidate: lit quads in an orthographic 3D scene. The two entry files pass in
// their own THREE namespace (`three` or `three/webgpu`, never both in one bundle) and the few things
// that differ per backend: renderer creation and the bloom pipeline.
import type { SceneTransientCue, WorldObjectId } from "@clockgrove/contracts";
import { applyScenePatch } from "../../../../apps/web/src/world-scene-adapter.js";
import {
  type BakeoffAdapter,
  type CameraState,
  type CandidateDescription,
  type CandidateOptions,
  type FeatureSupport,
  LOOK_FEATURES,
  type LookFeature,
  QUALITY_TIERS,
  type QualityTier,
  type SceneIntent,
  TIER_FEATURES,
  type Unsubscribe,
} from "../contract.js";
import { type AssetId, materialSet } from "../inputs/materials.js";
import {
  CAMERA_ELEVATION_DEGREES,
  GROUND,
  type LightRig,
  lightRigOf,
  PIXELS_PER_METRE,
  type PointLightSpec,
  SCREENSHOT_CAMERA,
  spritesOf,
  WALL,
} from "../inputs/scene.js";

// biome-ignore lint/suspicious/noExplicitAny: three ships no type declarations (see three-shim.d.ts)
type Any = any;
type SceneProjection = Parameters<typeof applyScenePatch>[0];

/** A bloom pipeline that draws the scene to the canvas. */
export interface ThreePost {
  render(): void | Promise<void>;
  dispose(): void;
}
export interface ThreeBackend {
  readonly candidate: string;
  readonly THREE: Any;
  /** Resolves with an initialised renderer whose canvas is not yet in the page. */
  createRenderer(): Promise<Any>;
  createPost(
    renderer: Any,
    scene: Any,
    camera: Any,
    mode: "half" | "full",
    width: number,
    height: number,
  ): ThreePost;
}

type Kind = "albedo" | "normal" | "heightMap" | "emissive";
const SRGB_KINDS: ReadonlySet<Kind> = new Set<Kind>(["albedo", "emissive"]);
/** Three's lights are physical (candela, albedo/π): these bring them to the rig's 0..1 scale. */
const AMBIENT_SCALE = Math.PI;
const POINT_SCALE = 24;
const CAMERA_DISTANCE = 7;
const ELEVATION = (CAMERA_ELEVATION_DEGREES * Math.PI) / 180;
const WIND_SEGMENTS = 16;
const RAIN_TOP = 7;
const GROUND_DISPLACEMENT = 0.03;
/** Puddles sit above the highest displaced ground so they never z-fight with it. */
const PUDDLE_Z = 0.05;
const TINT_SELECTED: readonly number[] = [1.5, 1.5, 1.9];
const TINT_FOCUSED: readonly number[] = [1.25, 1.25, 1.25];

interface SpriteEntry {
  readonly objectId: string;
  readonly material: Any;
  readonly mirror: Any;
}
interface WindMesh {
  readonly geometry: Any;
  readonly base: Float32Array;
  readonly weight: Float32Array;
  readonly phase: Float32Array;
}
interface RainState {
  readonly geometry: Any;
  readonly seeds: Float32Array;
  readonly count: number;
}

/** Half-float colour + depth/stencil for the bloom path, by our own count (no driver query exists). */
function bloomBytes(mode: "off" | "half" | "full", width: number, height: number): number {
  if (mode === "off") return 0;
  const pixels = width * height;
  const scene = pixels * (8 + 4) * 2;
  const mips = (mode === "half" ? 0.25 : 1) * pixels * 8 * 2 * (4 / 3) * 2;
  return scene + mips;
}

export function createThreeAdapter(
  options: CandidateOptions,
  backend: ThreeBackend,
): BakeoffAdapter {
  const T = backend.THREE;
  const { width, height } = options;
  const intentHandlers = new Set<(intent: SceneIntent) => void>();

  let renderer: Any = null;
  let scene: Any = null;
  let camera: Any = null;
  let post: ThreePost | null = null;
  let postMode: "half" | "full" | null = null;
  let isWebGPU = false;
  let device: Any = null;
  let gl: Any = null;
  let rendererString = "unknown";
  let vendorString = "unknown";
  let adapterInfo: Record<string, string> | null = null;

  let projection: SceneProjection | null = null;
  let rig: LightRig | null = null;
  let tier: QualityTier = "high";
  let cameraState: CameraState = SCREENSHOT_CAMERA;
  let reduced = false;
  let selected: string | undefined;
  let focused: string | undefined;

  const textures = new Map<string, Any>();
  let roughTextures = new Map<string, Any>();
  const emissiveAssets = new Map<AssetId, boolean>();
  let pointLights: { light: Any; spec: PointLightSpec }[] = [];
  let sprites: SpriteEntry[] = [];
  let windMeshes: WindMesh[] = [];
  let rain: RainState | null = null;

  const colour = (rgb: readonly number[]) =>
    new T.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);

  /** Rows reversed, because a DataTexture's first row is the bottom (WebGPU ignores flipY on raw data). */
  function flipRows(src: Uint8ClampedArray, w: number, h: number): Uint8Array {
    const out = new Uint8Array(src.length);
    const stride = w * 4;
    for (let y = 0; y < h; y++)
      out.set(src.subarray(y * stride, (y + 1) * stride), (h - 1 - y) * stride);
    return out;
  }
  function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): Any {
    const texture = new T.DataTexture(data, w, h, T.RGBAFormat, T.UnsignedByteType);
    texture.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    texture.magFilter = T.LinearFilter;
    texture.minFilter = T.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
  function texture(assetId: AssetId, kind: Kind): Any {
    const key = `${assetId}:${kind}`;
    let cached = textures.get(key);
    if (!cached) {
      const set = materialSet(assetId);
      cached = dataTexture(
        flipRows(set[kind], set.width, set.height),
        set.width,
        set.height,
        SRGB_KINDS.has(kind),
      );
      textures.set(key, cached);
    }
    return cached;
  }
  /** Roughness in G (what three reads), pulled toward smooth by wetness; B (metalness) stays 0. */
  function roughnessTexture(assetId: AssetId, wetness: number): Any {
    const key = `${assetId}:${wetness.toFixed(3)}`;
    let cached = roughTextures.get(key);
    if (!cached) {
      const set = materialSet(assetId);
      const out = new Uint8ClampedArray(set.roughnessWetness.length);
      for (let i = 0; i < out.length; i += 4) {
        const rough = (set.roughnessWetness[i] ?? 255) / 255;
        const wet = ((set.roughnessWetness[i + 1] ?? 0) / 255) * wetness;
        out[i] = 255;
        out[i + 1] = rough * (1 - 0.8 * wet) * 255;
        out[i + 2] = 0;
        out[i + 3] = 255;
      }
      cached = dataTexture(flipRows(out, set.width, set.height), set.width, set.height, false);
      roughTextures.set(key, cached);
    }
    return cached;
  }
  function hasEmissive(assetId: AssetId): boolean {
    let found = emissiveAssets.get(assetId);
    if (found === undefined) {
      const data = materialSet(assetId).emissive;
      found = false;
      for (let i = 0; i < data.length && !found; i += 4)
        found = (data[i] ?? 0) + (data[i + 1] ?? 0) > 0;
      emissiveAssets.set(assetId, found);
    }
    return found;
  }

  function makeMaterial(
    assetId: AssetId,
    current: LightRig,
    extra: Record<string, unknown> = {},
  ): Any {
    const features = TIER_FEATURES[tier];
    const wetness = features.wetness ? current.wetness : 0;
    const material = new T.MeshStandardMaterial({
      map: texture(assetId, "albedo"),
      roughness: 1,
      metalness: 0,
      roughnessMap: roughnessTexture(assetId, wetness),
      alphaTest: 0.5,
      fog: features.fog,
      ...extra,
    });
    if (features.normalMaps) material.normalMap = texture(assetId, "normal");
    if (features.emissive && hasEmissive(assetId)) {
      material.emissive = new T.Color(1, 1, 1);
      material.emissiveMap = texture(assetId, "emissive");
      // Glass and window glow brighter once the night rule has lit them.
      material.emissiveIntensity = current.lights.length > 0 ? 1.6 : 0.2;
    }
    material.userData.base = 1 - 0.25 * wetness;
    return material;
  }
  function applyTint(entry: SpriteEntry): void {
    const tint =
      entry.objectId === selected
        ? TINT_SELECTED
        : entry.objectId === focused
          ? TINT_FOCUSED
          : [1, 1, 1];
    const base = entry.material.userData.base as number;
    entry.material.color.setRGB(
      base * (tint[0] ?? 1),
      base * (tint[1] ?? 1),
      base * (tint[2] ?? 1),
    );
  }

  function resetScene(): void {
    for (const child of [...scene.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
    scene.clear();
    for (const t of roughTextures.values()) t.dispose();
    roughTextures = new Map();
    pointLights = [];
    sprites = [];
    windMeshes = [];
    rain = null;
  }

  /** An upright quad's basis: local x is screen right, local y is world up, local z faces the camera. */
  function facing(): Any {
    const s = Math.SQRT1_2;
    const m = new T.Matrix4().makeBasis(
      new T.Vector3(s, s, 0),
      new T.Vector3(0, 0, 1),
      new T.Vector3(s, -s, 0),
    );
    return new T.Quaternion().setFromRotationMatrix(m);
  }

  function addSprite(
    placement: ReturnType<typeof spritesOf>[number],
    current: LightRig,
    facingQuat: Any,
  ): void {
    const features = TIER_FEATURES[tier];
    const set = materialSet(placement.assetId);
    let windy = false;
    for (let i = 0; i < set.wind.length && !windy; i += 4) windy = (set.wind[i] ?? 0) > 0;
    const segments = features.wind && windy ? WIND_SEGMENTS : 1;
    const geometry = new T.PlaneGeometry(placement.width, placement.height, segments, segments);
    geometry.translate(0, placement.height / 2, 0);
    if (segments > 1) {
      const position = geometry.attributes.position;
      const count = position.count;
      const weight = new Float32Array(count);
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const u = position.getX(i) / placement.width + 0.5;
        const v = 1 - position.getY(i) / placement.height;
        const px = Math.min(set.width - 1, Math.max(0, Math.round(u * (set.width - 1))));
        const py = Math.min(set.height - 1, Math.max(0, Math.round(v * (set.height - 1))));
        const at = (py * set.width + px) * 4;
        weight[i] = (set.wind[at] ?? 0) / 255;
        phase[i] = (set.wind[at + 1] ?? 0) / 255;
      }
      position.setUsage(T.DynamicDrawUsage);
      windMeshes.push({ geometry, base: Float32Array.from(position.array), weight, phase });
    }

    const material = makeMaterial(placement.assetId, current);
    const mesh = new T.Mesh(geometry, material);
    mesh.position.set(placement.x, placement.y, placement.z);
    mesh.quaternion.copy(facingQuat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    scene.add(mesh);

    // The reflection: the same quad mirrored about the ground, drawn only where a puddle wrote stencil.
    const mirrorMaterial = makeMaterial(placement.assetId, current, {
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: T.EqualStencilFunc,
      stencilRef: 1,
      stencilFail: T.KeepStencilOp,
      stencilZFail: T.KeepStencilOp,
      stencilZPass: T.KeepStencilOp,
    });
    mirrorMaterial.userData.base *= 0.45;
    mirrorMaterial.color.setScalar(mirrorMaterial.userData.base);
    let mirror: Any = null;
    if (features.reflections && current.puddles.length > 0) {
      mirror = new T.Mesh(geometry, mirrorMaterial);
      mirror.position.set(placement.x, placement.y, -placement.z);
      mirror.quaternion.copy(facingQuat);
      mirror.scale.set(1, -1, 1);
      mirror.renderOrder = 2;
      mirror.frustumCulled = false;
      scene.add(mirror);
    } else mirrorMaterial.dispose();
    const entry: SpriteEntry = { objectId: placement.objectId, material, mirror };
    sprites.push(entry);
    applyTint(entry);
  }

  function addEnvironment(current: LightRig): void {
    const features = TIER_FEATURES[tier];
    // The ground's height map is a real displacementMap on a subdivided plane; others use the normal map.
    const groundGeometry = new T.PlaneGeometry(GROUND.width, GROUND.depth, 128, 100);
    const ground = new T.Mesh(
      groundGeometry,
      makeMaterial(GROUND.assetId, current, {
        displacementMap: texture(GROUND.assetId, "heightMap"),
        displacementScale: GROUND_DISPLACEMENT,
        displacementBias: -GROUND_DISPLACEMENT / 2,
      }),
    );
    ground.position.set(GROUND.centreX, GROUND.centreY, 0);
    ground.frustumCulled = false;
    scene.add(ground);

    const wall = new T.Mesh(
      new T.PlaneGeometry(WALL.x1 - WALL.x0, WALL.height),
      makeMaterial(WALL.assetId, current),
    );
    wall.rotation.x = Math.PI / 2;
    wall.position.set((WALL.x0 + WALL.x1) / 2, WALL.y, WALL.height / 2);
    wall.frustumCulled = false;
    scene.add(wall);

    for (const puddle of current.puddles) {
      const material = new T.MeshStandardMaterial({
        color: new T.Color().setRGB(0.012, 0.016, 0.024),
        roughness: 0.05,
        metalness: 0.3,
        fog: features.fog,
      });
      if (features.reflections) {
        material.stencilWrite = true;
        material.stencilRef = 1;
        material.stencilFunc = T.AlwaysStencilFunc;
        material.stencilZPass = T.ReplaceStencilOp;
      }
      const mesh = new T.Mesh(new T.CircleGeometry(1, 48), material);
      mesh.scale.set(puddle.rx, puddle.ry, 1);
      mesh.position.set(puddle.x, puddle.y, PUDDLE_Z);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  function addLights(current: LightRig): void {
    scene.add(
      new T.AmbientLight(colour(current.ambient.color), current.ambient.intensity * AMBIENT_SCALE),
    );
    const sky = new T.DirectionalLight(
      colour(current.sky.color),
      current.sky.intensity * AMBIENT_SCALE,
    );
    const d = current.sky.direction;
    sky.position.set(-d[0] * 10, -d[1] * 10, -d[2] * 10);
    scene.add(sky);
    for (const spec of current.lights) {
      const light = new T.PointLight(
        colour(spec.color),
        spec.intensity * POINT_SCALE,
        spec.range,
        2,
      );
      // Pulled out of the surface it sits on (towards the camera, or off the wall) so 1/d² stays finite.
      if (spec.role === "lantern") light.position.set(spec.x + 0.35, spec.y - 0.35, spec.z);
      else light.position.set(spec.x, spec.y - 0.8, spec.z);
      scene.add(light);
      pointLights.push({ light, spec });
    }
  }

  function addRain(current: LightRig): void {
    const count = Math.floor(TIER_FEATURES[tier].rainParticles * current.rain);
    if (count === 0) return;
    const seeds = new Float32Array(count * 3);
    let state = 12_345;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    for (let i = 0; i < seeds.length; i++) seeds[i] = next();
    const geometry = new T.BufferGeometry();
    const positions = new T.BufferAttribute(new Float32Array(count * 6), 3);
    positions.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute("position", positions);
    const material = new T.LineBasicMaterial({
      color: new T.Color().setRGB(0.55, 0.65, 0.85),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      fog: false,
    });
    const lines = new T.LineSegments(geometry, material);
    lines.renderOrder = 5;
    lines.frustumCulled = false;
    scene.add(lines);
    rain = { geometry, seeds, count };
  }

  function build(): void {
    if (!renderer || !projection) return;
    resetScene();
    const current = lightRigOf(projection);
    rig = current;
    const features = TIER_FEATURES[tier];
    scene.fog = features.fog ? new T.FogExp2(colour(current.fog.color), current.fog.density) : null;
    renderer.setClearColor(colour(current.clearColor), 1);
    addLights(current);
    addEnvironment(current);
    const facingQuat = facing();
    for (const placement of spritesOf(projection)) addSprite(placement, current, facingQuat);
    addRain(current);
    syncPost();
  }

  function syncPost(): void {
    const mode = TIER_FEATURES[tier].bloom;
    const wanted = mode === "off" ? null : mode;
    if (wanted === postMode) return;
    post?.dispose();
    post = wanted ? backend.createPost(renderer, scene, camera, wanted, width, height) : null;
    postMode = wanted;
  }

  function updateCamera(): void {
    const scale = PIXELS_PER_METRE * cameraState.zoom;
    camera.left = -width / (2 * scale);
    camera.right = width / (2 * scale);
    camera.top = height / (2 * scale);
    camera.bottom = -height / (2 * scale);
    camera.near = 0.05;
    camera.far = 60;
    const dir = new T.Vector3(1, -1, Math.SQRT2 * Math.tan(ELEVATION)).normalize();
    camera.up.set(0, 0, 1);
    camera.position
      .set(cameraState.panX, cameraState.panY, 0)
      .addScaledVector(dir, CAMERA_DISTANCE);
    camera.lookAt(cameraState.panX, cameraState.panY, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /** Every moving part is a pure function of `t` (seconds of animation time). */
  function animate(t: number): void {
    const current = rig;
    if (!current) return;
    for (const { light, spec } of pointLights) {
      const flick = 1 + spec.flicker * (0.6 * Math.sin(t * 13) + 0.4 * Math.sin(t * 31 + 1.3));
      light.intensity = spec.intensity * POINT_SCALE * flick;
    }
    for (const mesh of windMeshes) {
      const position = mesh.geometry.attributes.position;
      const array = position.array as Float32Array;
      for (let i = 0; i < mesh.weight.length; i++) {
        const sway = Math.sin(
          t * 2.2 + (mesh.phase[i] ?? 0) * 6.283 + (mesh.base[i * 3 + 1] ?? 0) * 1.5,
        );
        array[i * 3] = (mesh.base[i * 3] ?? 0) + sway * 0.18 * (mesh.weight[i] ?? 0) * current.wind;
      }
      position.needsUpdate = true;
    }
    if (rain) {
      const slant = current.wind * 0.5;
      const length = 0.45;
      const norm = Math.hypot(slant, 1);
      const array = rain.geometry.attributes.position.array as Float32Array;
      const halfX = GROUND.width / 2 + 2;
      const halfY = GROUND.depth / 2 + 2;
      for (let i = 0; i < rain.count; i++) {
        const sx = rain.seeds[i * 3] ?? 0;
        const sy = rain.seeds[i * 3 + 1] ?? 0;
        const sz = rain.seeds[i * 3 + 2] ?? 0;
        const speed = 8 + sz * 3;
        const fall = (((sz * RAIN_TOP - t * speed) % RAIN_TOP) + RAIN_TOP) % RAIN_TOP;
        const x = (sx * 2 - 1) * halfX + slant * (RAIN_TOP - fall);
        const y = (sy * 2 - 1) * halfY;
        array.set([x, y, fall, x + (slant / norm) * length, y, fall + (1 / norm) * length], i * 6);
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }
  }

  async function finish(): Promise<void> {
    if (isWebGPU) {
      await device.queue.onSubmittedWorkDone();
    } else if (gl) {
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
  }

  function estimatedBytes(): number {
    let total = 0;
    for (const t of [...textures.values(), ...roughTextures.values()]) {
      total += t.image.width * t.image.height * 4;
    }
    total += width * height * 8; // canvas colour + depth/stencil
    return total + bloomBytes(TIER_FEATURES[tier].bloom, width, height);
  }

  function features(): Record<LookFeature, FeatureSupport> {
    return {
      normalMap: "native",
      heightMap: "approximated",
      emissiveMap: "native",
      roughnessWetness: "approximated",
      windMap: "approximated",
      pointLights: "native",
      puddleReflections: "approximated",
      fog: "native",
      rainParticles: "approximated",
      bloom: "native",
    };
  }
  const NOTES: Record<LookFeature, string> = {
    normalMap: "",
    heightMap:
      "Only the ground uses the height map, as a displacementMap on a 128x100 plane; sprites and wall rely on the normal map derived from it.",
    emissiveMap: "",
    roughnessWetness:
      "Wetness is baked into a derived roughness map (G) per lighting state plus a global albedo darkening; rebuilt when wetness changes.",
    windMap:
      "CPU vertex sway on a 16x16 plane weighted by the wind map's R; the vertex buffer is re-uploaded every frame.",
    pointLights: "",
    puddleReflections:
      "Mirrored copy of each sprite (scale -1 about the ground) drawn with a stencil test against the puddle ellipses; no real reflection or blur.",
    fog: "",
    rainParticles:
      "LineSegments rewritten on the CPU every frame (no GPU particle system); not lit, not fogged.",
    bloom: "",
  };

  const adapter: BakeoffAdapter = {
    async init() {
      renderer = await backend.createRenderer();
      renderer.setPixelRatio(1);
      renderer.setSize(width, height);
      options.host.appendChild(renderer.domElement);
      isWebGPU = renderer.backend?.isWebGPUBackend === true;
      scene = new T.Scene();
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.05, 60);
      if (isWebGPU) {
        device = renderer.backend.device;
        const info =
          device?.adapterInfo ?? (await (navigator as Any).gpu?.requestAdapter?.())?.info;
        adapterInfo = {
          vendor: String(info?.vendor ?? ""),
          architecture: String(info?.architecture ?? ""),
          device: String(info?.device ?? ""),
          description: String(info?.description ?? ""),
        };
        rendererString = adapterInfo.description || adapterInfo.architecture || "webgpu";
        vendorString = adapterInfo.vendor || "unknown";
      } else {
        gl =
          typeof renderer.getContext === "function" ? renderer.getContext() : renderer.backend?.gl;
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        rendererString = String(
          gl?.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "unknown",
        );
        vendorString = String(
          gl?.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? "unknown",
        );
      }
      updateCamera();
      build();
    },
    setQuality(next) {
      if (!QUALITY_TIERS.includes(next)) return;
      tier = next;
      build();
    },
    setCamera(next) {
      cameraState = next;
      if (camera) updateCamera();
    },
    async renderFrame(timeMs) {
      if (!renderer) throw new Error("init() has not completed");
      const t = reduced ? 0 : timeMs / 1000;
      updateCamera();
      animate(t);
      const pending = post ? post.render() : renderer.render(scene, camera);
      if (pending && typeof pending.then === "function") await pending;
      await finish();
    },
    capture() {
      // WebGPURenderer's canvas (on either backend) keeps no drawing buffer once the frame is
      // presented, so draw the same state again and read it back in the same task.
      if (backend.candidate !== "three-webgl2") {
        if (post) post.render();
        else renderer.render(scene, camera);
      }
      return renderer.domElement.toDataURL("image/png");
    },
    describe(): CandidateDescription {
      const support = features();
      const notes = LOOK_FEATURES.filter((f) => support[f] !== "native").map(
        (f) => `${f}: ${NOTES[f]}`,
      );
      return {
        candidate: backend.candidate,
        api: isWebGPU ? "webgpu" : "webgl2",
        rendererString,
        vendorString,
        webgpuAdapter: adapterInfo,
        estimatedGpuBytes: estimatedBytes(),
        features: support,
        notes,
      };
    },
    loadSnapshot(snapshot) {
      projection = snapshot;
      build();
    },
    applyPatch(patch) {
      if (!projection || patch.fromRevision !== projection.revision) return;
      projection = applyScenePatch(projection, patch);
      build();
    },
    emitCue(_cue: SceneTransientCue) {},
    setSelection(id?: WorldObjectId | undefined) {
      selected = id === undefined ? undefined : String(id);
      for (const entry of sprites) applyTint(entry);
    },
    focus(id?: WorldObjectId | undefined) {
      focused = id === undefined ? undefined : String(id);
      for (const entry of sprites) applyTint(entry);
    },
    setReducedMotion(enabled) {
      reduced = enabled;
    },
    onIntent(handler): Unsubscribe {
      intentHandlers.add(handler);
      return () => {
        intentHandlers.delete(handler);
      };
    },
    destroy() {
      if (scene) resetScene();
      for (const t of textures.values()) t.dispose();
      textures.clear();
      post?.dispose();
      post = null;
      postMode = null;
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = null;
      scene = null;
      intentHandlers.clear();
    },
  };
  return adapter;
}
