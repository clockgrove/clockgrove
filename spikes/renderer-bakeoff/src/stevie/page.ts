// Issue 77's comparison page: Stevie three ways in the #67 lit yard slice (Three.js on WebGL2), at dusk in
// rain and at night. Each arm adds its characters to the same adapter through `ThreeExtras`, so every arm
// shares one light rig, one fog, one bloom and output pass and one camera. The page takes every shot
// (stills at five headings, a walk sequence, an idle sequence and a cohesion shot), times a few frames,
// and POSTs one JSON record to scripts/stevie.mjs, which writes the PNGs, hashes and report.
import * as THREE from "three";
import { createThreeAdapter, type ThreeExtras } from "../candidates/three.js";
import { webgl2Backend } from "../candidates/three-webgl2.js";
import type { BakeoffAdapter, CameraState } from "../contract.js";
import { isoProject, LIGHTING_STATES, SNAPSHOT, TO_NIGHT } from "../inputs/scene.js";
import {
  BAKE_CENTRE_Z,
  BAKE_METRES,
  type BakedAtlas,
  type BakeFrame,
  bakeSprites,
  cameraDirection,
} from "./bake.js";
import {
  type CharacterInstance,
  type CharacterSource,
  type GeneratedModel,
  generatedStevie,
  proceduralStevie,
  toonMaterial,
} from "./model.js";
import { CUT_HEIGHT, type CutSheet, cutSheet, SHEET, SHEET_FRAMES } from "./sheet.js";

// biome-ignore lint/suspicious/noExplicitAny: three ships no type declarations (see three-shim.d.ts)
type Any = any;

const params = new URLSearchParams(location.search);
const WIDTH = 960;
const HEIGHT = 540;
/** Close shots are cropped to this square around Stevie, so the record stays small. */
const CROP = 360;
/** Frames timed per arm and lighting state (recorded, never a performance number under SwiftShader). */
const TIMED_FRAMES = Number(params.get("timedFrames") ?? 10);
/** Scene animation time of every shot (rain, flicker); characters are posed explicitly per shot. */
const SCENE_TIME_MS = 1_250;
const CLOSE: CameraState = { panX: -0.1, panY: 0.1, zoom: 2.5 };
const WIDE: CameraState = { panX: 0.6, panY: 0.2, zoom: 1.6 };
/** Model height in metres, so a generated model lands at the stand-in's scale. */
const STEVIE_HEIGHT = 0.53;
/** Metres per sheet pixel for the 2D arm, chosen so its body matches the 3D arm's on screen. */
const SHEET_METRES_PER_PIXEL = 0.0042;
/** Pushes the 3D-sprite quad towards the camera so the ground does not clip its feet (assumption 9). */
const SPRITE_DEPTH_OFFSET = 0.35;

/** Character headings: radians about z from +x (east-north-east on screen). The camera never moves. */
export const HEADINGS = {
  "three-quarter": 0,
  right: Math.PI / 4,
  back: (3 * Math.PI) / 4,
  left: (-3 * Math.PI) / 4,
  front: -Math.PI / 4,
} as const;
type Heading = keyof typeof HEADINGS;
const STILL_TIME = 0.6;
const WALK_FRAMES = 8;
const IDLE_FRAMES = 4;

interface Figure {
  readonly heading: Heading;
  readonly clip: "idle" | "walk";
  /** 0..1 of the clip. */
  readonly phase: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly tint: readonly [number, number, number];
}
interface Shot {
  readonly name: string;
  readonly camera: CameraState;
  readonly figures: readonly Figure[];
}
const NO_TINT = [1, 1, 1] as const;
/** Juniper: a warmer, redder recolour of the same model or frames (pipeline doc: a placeholder variant). */
const JUNIPER_TINT = [1.25, 0.95, 0.75] as const;
const KIT_SCALE = 0.6;
const stevie = (heading: Heading, clip: "idle" | "walk", phase: number): Figure => ({
  heading,
  clip,
  phase,
  x: 0,
  y: 0,
  scale: 1,
  tint: NO_TINT,
});

export const SHOTS: readonly Shot[] = [
  ...(Object.keys(HEADINGS) as Heading[]).map((h) => ({
    name: `still-${h}`,
    camera: CLOSE,
    figures: [stevie(h, "idle", STILL_TIME / 2.4)],
  })),
  ...Array.from({ length: WALK_FRAMES }, (_, i) => ({
    name: `walk-${i}`,
    camera: CLOSE,
    figures: [stevie("right", "walk", i / WALK_FRAMES)],
  })),
  ...Array.from({ length: IDLE_FRAMES }, (_, i) => ({
    name: `idle-${i}`,
    camera: CLOSE,
    figures: [stevie("three-quarter", "idle", i / IDLE_FRAMES)],
  })),
  {
    name: "cohesion",
    camera: WIDE,
    figures: [
      { ...stevie("three-quarter", "idle", STILL_TIME / 2.4), x: 0.35, y: 0 },
      { ...stevie("front", "idle", STILL_TIME / 2.4), x: 1.15, y: -0.25, tint: JUNIPER_TINT },
      { ...stevie("right", "idle", STILL_TIME / 2.4), x: 0.7, y: -0.65, scale: KIT_SCALE },
    ],
  },
];

/** One arm: its scene additions, what it needs prepared, and the notes the report prints. */
interface Arm {
  /** `3d`, `2d` and `3d-sprites` for the stand-in; `3d:<model>` and `3d-sprites:<model>` for a generated one. */
  readonly name: string;
  prepare(): Promise<void>;
  extras(): ThreeExtras;
  show(shot: Shot): void;
  readonly stepMs: Record<string, number>;
  readonly notes: string[];
}

const frameKey = (figure: Figure) => `${figure.clip}:${figure.heading}:${figure.phase.toFixed(4)}`;
const clipTime = (instance: CharacterInstance, figure: Figure) =>
  figure.phase * instance.clipDurations[figure.clip];

/** The arm-name suffix for a model: none for the stand-in (the arms CI checks), `:<name>` otherwise. */
const suffix = (model: string) => (model === "stand-in" ? "" : `:${model}`);

function arm3d(source: CharacterSource, model = "stand-in"): Arm {
  let shot: Shot | undefined;
  let placed: { instance: CharacterInstance; figure: Figure }[] = [];
  const apply = () => {
    for (const { instance, figure } of placed) {
      instance.root.position.set(figure.x, figure.y, 0);
      instance.root.rotation.z = HEADINGS[figure.heading];
      instance.root.scale.setScalar(figure.scale);
      instance.tint(figure.tint);
      instance.pose(figure.clip, clipTime(instance, figure));
    }
  };
  return {
    name: `3d${suffix(model)}`,
    stepMs: { ...source.stepMs },
    notes: [
      `model: ${model} (${source.kind})`,
      "shaded with MeshToonMaterial (3-step ramp) under the scene's own ambient, sky and point lights and fog; inverted-hull outline",
      "variants: Juniper is a material tint, the kit is the same skeleton scaled to 0.6; no new asset",
    ],
    async prepare() {},
    extras: () => ({
      omit: ["stevie"],
      build({ scene }) {
        const group = new THREE.Group();
        placed = (shot?.figures ?? []).map((figure) => {
          const instance = source.instantiate();
          group.add(instance.root);
          return { instance, figure };
        });
        apply();
        scene.add(group);
      },
      animate() {
        apply();
      },
    }),
    show(next) {
      shot = next;
    },
  };
}

/** A quad's material whose map and normal map show one atlas cell; each figure gets its own clones. */
function cellMaterial(
  base: Any,
  maps: { map: Any; normalMap: Any },
  columns: number,
  rows: number,
): { material: Any; select(column: number, rowFromBottom: number): void } {
  const map = maps.map.clone();
  const normalMap = maps.normalMap.clone();
  for (const t of [map, normalMap]) t.repeat.set(1 / columns, 1 / rows);
  base.map = map;
  base.normalMap = normalMap;
  return {
    material: base,
    select(column, row) {
      for (const t of [map, normalMap]) t.offset.set(column / columns, row / rows);
    },
  };
}

/** Rows reversed (a DataTexture's first row is the bottom). */
function bottomUp(src: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++)
    out.set(src.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
  return out;
}
function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): Any {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
/** An upright quad facing the camera's azimuth, as #67 drew its sprites (three.ts `facing`). */
function uprightFacing(): Any {
  const s = Math.SQRT1_2;
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(s, s, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(s, -s, 0),
  );
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** The sheet frame a 2D figure shows; the sheet has no back or straight-front view (assumption 5). */
function sheetFrame(figure: Figure): number {
  const pick = (frames: readonly number[]) =>
    frames[Math.floor(figure.phase * frames.length) % frames.length] ?? frames[0] ?? 0;
  if (figure.heading === "right")
    return figure.clip === "walk" ? pick(SHEET_FRAMES.walkRight) : SHEET_FRAMES.walkRight[0];
  if (figure.heading === "left" || figure.heading === "back")
    return figure.clip === "walk" ? pick(SHEET_FRAMES.walkLeft) : SHEET_FRAMES.walkLeft[0];
  return pick(SHEET_FRAMES.idle);
}

function arm2d(sheetUrl: string): Arm & { cut(): CutSheet | null } {
  let cut: CutSheet | null = null;
  let maps: { map: Any; normalMap: Any } | null = null;
  let shot: Shot | undefined;
  const stepMs: Record<string, number> = {};
  return {
    name: "2d",
    cut: () => cut,
    stepMs,
    notes: [
      `frames: plain crop of the identity sheet's ${SHEET.cellWidth}x${SHEET.cellHeight} grid (Assetforge sheet import not available in the sandbox)`,
      "maps: alpha keyed from the cell corner colour; normal from Sobel of (0.75 blurred alpha dome + 0.25 luminance); 1-px dark edge",
      "lit with MeshStandardMaterial as #67's sprites; the painting's own baked rim light (orange fringe) and shading remain under the scene light",
      "headings: the sheet has three-quarter front-right, side right and side left; 'back' and 'front' show the nearest frame",
      "variants: Juniper is a material tint, the kit is the quad scaled to 0.6",
    ],
    async prepare() {
      cut = await cutSheet(sheetUrl);
      Object.assign(stepMs, cut.stepMs);
      maps = {
        map: dataTexture(bottomUp(cut.albedo, cut.width, cut.height), cut.width, cut.height, true),
        normalMap: dataTexture(
          bottomUp(cut.normal, cut.width, cut.height),
          cut.width,
          cut.height,
          false,
        ),
      };
    },
    extras: () => ({
      omit: ["stevie"],
      build({ scene }) {
        if (!cut || !maps) return;
        const group = new THREE.Group();
        const facing = uprightFacing();
        const w = SHEET.cellWidth * SHEET_METRES_PER_PIXEL;
        const h = CUT_HEIGHT * SHEET_METRES_PER_PIXEL;
        for (const figure of shot?.figures ?? []) {
          const geometry = new THREE.PlaneGeometry(w * figure.scale, h * figure.scale);
          geometry.translate(0, (h * figure.scale) / 2, 0);
          const base = new THREE.MeshStandardMaterial({
            roughness: 1,
            metalness: 0,
            alphaTest: 0.5,
            fog: true,
          });
          const { material, select } = cellMaterial(base, maps, cut.columns, cut.rows);
          const { column, row } = cut.cell(sheetFrame(figure));
          select(column, cut.rows - 1 - row);
          material.color.setRGB(...figure.tint);
          const quad = new THREE.Mesh(geometry, material);
          quad.position.set(figure.x, figure.y, 0);
          quad.quaternion.copy(facing);
          quad.renderOrder = 3;
          quad.frustumCulled = false;
          group.add(quad);
        }
        scene.add(group);
      },
      animate() {},
    }),
    show(next) {
      shot = next;
    },
  };
}

function armSprites(source: CharacterSource, model = "stand-in"): Arm {
  let atlas: BakedAtlas | null = null;
  let shot: Shot | undefined;
  const stepMs: Record<string, number> = {};
  const frames: BakeFrame[] = [];
  const seen = new Set<string>();
  const durations = source.instantiate().clipDurations;
  for (const s of SHOTS)
    for (const figure of s.figures) {
      const key = frameKey(figure);
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({
        key,
        heading: HEADINGS[figure.heading],
        clip: figure.clip,
        time: figure.phase * durations[figure.clip],
      });
    }
  const arm: Arm & { atlas(): BakedAtlas | null } = {
    name: `3d-sprites${suffix(model)}`,
    stepMs,
    notes: [
      `the 3D arm's model (${model}, ${source.kind}) and clips rendered offline from the scene camera's direction: ${frames.length} frames, albedo + view-space normal + depth from the geometry`,
      "placed as camera-facing quads with MeshToonMaterial (same ramp as the 3D arm) and the exact normal map, lit by the scene's lights",
      `the depth map is produced but not used for per-pixel occlusion in the spike; the quad sits ${SPRITE_DEPTH_OFFSET} m towards the camera (assumption 9)`,
      "variants: Juniper is a material tint, the kit is the quad scaled to 0.6; a new heading or clip is a re-bake",
    ],
    async prepare() {},
    atlas: () => atlas,
    extras: () => ({
      omit: ["stevie"],
      build({ scene, renderer }) {
        if (!atlas) {
          atlas = bakeSprites(renderer, source, frames);
          Object.assign(stepMs, atlas.stepMs);
        }
        const group = new THREE.Group();
        const dir = cameraDirection();
        for (const figure of shot?.figures ?? []) {
          const size = BAKE_METRES * figure.scale;
          const geometry = new THREE.PlaneGeometry(size, size);
          const base = toonMaterial({ alphaTest: 0.5 });
          const { material, select } = cellMaterial(
            base,
            { map: atlas.albedo, normalMap: atlas.normal },
            atlas.columns,
            atlas.rows,
          );
          const { column, row } = atlas.cell(frameKey(figure));
          select(column, row);
          material.color.setRGB(...figure.tint);
          const quad = new THREE.Mesh(geometry, material);
          quad.position
            .set(figure.x, figure.y, BAKE_CENTRE_Z * figure.scale)
            .addScaledVector(dir, SPRITE_DEPTH_OFFSET);
          quad.up.set(0, 0, 1);
          quad.lookAt(quad.position.clone().add(dir));
          quad.renderOrder = 3;
          quad.frustumCulled = false;
          group.add(quad);
        }
        scene.add(group);
      },
      animate() {},
    }),
    show(next) {
      shot = next;
    },
  };
  return arm;
}

/** The crop around Stevie's middle for a close shot, read from the drawn (preserved) canvas. */
function crop(canvas: HTMLCanvasElement, camera: CameraState): string {
  const at = isoProject(0, 0, 0.25, camera, WIDTH, HEIGHT);
  const out = document.createElement("canvas");
  out.width = CROP;
  out.height = CROP;
  out
    .getContext("2d")
    ?.drawImage(canvas, at.sx - CROP / 2, at.sy - CROP / 2, CROP, CROP, 0, 0, CROP, CROP);
  return out.toDataURL("image/png");
}

function stats(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (v: number) => Math.round(v * 1_000) / 1_000;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

function cutSheetPngs(cut: CutSheet | null): Record<string, string> {
  if (!cut) return {};
  const out: Record<string, string> = {};
  for (const [name, data] of [
    ["sheet-albedo", cut.albedo],
    ["sheet-normal", cut.normal],
  ] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = cut.width;
    canvas.height = cut.height;
    const context = canvas.getContext("2d");
    if (!context) continue;
    const image = context.createImageData(cut.width, cut.height);
    image.data.set(data);
    context.putImageData(image, 0, 0);
    out[name] = canvas.toDataURL("image/png");
  }
  return out;
}

async function runArm(arm: Arm, host: HTMLElement) {
  const shots: Record<string, string> = {};
  const frameMs: Record<string, ReturnType<typeof stats>> = {};
  let description: ReturnType<BakeoffAdapter["describe"]> | null = null;
  let error: string | null = null;
  let adapter: BakeoffAdapter | null = null;
  try {
    let start = performance.now();
    await arm.prepare();
    arm.stepMs.prepareTotal = Math.round(performance.now() - start);
    arm.show(SHOTS[0] as Shot);
    adapter = createThreeAdapter(
      { host, width: WIDTH, height: HEIGHT },
      webgl2Backend,
      arm.extras(),
    );
    await adapter.init();
    adapter.setQuality("high");
    adapter.loadSnapshot(SNAPSHOT);
    for (const state of LIGHTING_STATES) {
      if (state === "night") adapter.applyPatch(TO_NIGHT);
      for (const shot of SHOTS) {
        arm.show(shot);
        adapter.setCamera(shot.camera);
        // Rebuilds the scene with this shot's figures (the extras' build), as a patch would.
        adapter.setQuality("high");
        await adapter.renderFrame(SCENE_TIME_MS);
        const canvas = host.querySelector("canvas") as HTMLCanvasElement;
        shots[`${state}/${shot.name}`] =
          shot.camera === CLOSE ? crop(canvas, shot.camera) : adapter.capture();
      }
      const samples: number[] = [];
      for (let i = 0; i < TIMED_FRAMES; i++) {
        start = performance.now();
        await adapter.renderFrame(SCENE_TIME_MS + i * 16);
        samples.push(performance.now() - start);
      }
      frameMs[state] = stats(samples);
    }
    description = adapter.describe();
  } catch (caught) {
    error =
      caught instanceof Error
        ? `${caught.message}\n${caught.stack ?? ""}`.slice(0, 2_000)
        : String(caught);
  } finally {
    adapter?.destroy();
  }
  return {
    arm: arm.name,
    error,
    notes: arm.notes,
    stepMs: arm.stepMs,
    frameMs,
    description,
    shots,
  };
}

async function main(): Promise<void> {
  const status = document.getElementById("status");
  const host = document.getElementById("stage") as HTMLElement;
  const record: Record<string, unknown> = {
    schema: "clockgrove.stevie-3d/1",
    device: { userAgent: navigator.userAgent },
    shots: SHOTS.map((s) => s.name),
    states: [...LIGHTING_STATES],
  };
  try {
    // The stand-in always renders (it is what CI checks); generated models come from media/ via `models`.
    const source = proceduralStevie();
    record.model = { kind: source.kind, metrics: source.metrics, stepMs: source.stepMs };
    const two = arm2d("sheet.png");
    const arms: Arm[] = [arm3d(source), two, armSprites(source)];
    const models: Record<string, unknown>[] = [
      { name: "stand-in", kind: source.kind, metrics: source.metrics, stepMs: source.stepMs },
    ];
    const wanted = JSON.parse(params.get("models") ?? "[]") as GeneratedModel[];
    for (const model of wanted) {
      if (status) status.textContent = `loading ${model.name}`;
      try {
        const generated = await generatedStevie(model, STEVIE_HEIGHT);
        if (!generated) throw new Error(`${model.url} is missing`);
        models.push({
          name: model.name,
          kind: generated.kind,
          rig: model.rig,
          metrics: generated.metrics,
          stepMs: generated.stepMs,
        });
        arms.push(arm3d(generated, model.name), armSprites(generated, model.name));
      } catch (caught) {
        models.push({
          name: model.name,
          rig: model.rig,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
    record.models = models;
    const results = [];
    for (const arm of arms) {
      if (status) status.textContent = `rendering ${arm.name}`;
      results.push(await runArm(arm, host));
    }
    record.arms = results;
    // Atlases: `sprites-<map>` for the stand-in (what CI checks), `sprites-<model>-<map>` for the others.
    const atlases: Record<string, string> = {};
    for (const arm of arms) {
      if (!arm.name.startsWith("3d-sprites")) continue;
      const atlas = (arm as Arm & { atlas(): BakedAtlas | null }).atlas();
      const model = arm.name.slice("3d-sprites".length).replace(":", "-");
      for (const [k, v] of Object.entries(atlas?.pngs() ?? {})) atlases[`sprites${model}-${k}`] = v;
    }
    record.atlases = { ...atlases, ...cutSheetPngs(two.cut()) };
  } catch (caught) {
    record.fatal = caught instanceof Error ? caught.message : String(caught);
  }
  const json = JSON.stringify(record);
  const report = params.get("report");
  if (report) await fetch(report, { method: "POST", body: json });
  document.body.dataset.state = "done";
  if (status) status.textContent = "done";
}

void main();
