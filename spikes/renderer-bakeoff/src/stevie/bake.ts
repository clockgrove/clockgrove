// Issue 77's third arm, "3D rendered to sprites": the 3D arm's own model and clips rendered offline, from
// the scene camera's direction, to sprite frames with exact albedo, normal and depth from the geometry.
import * as THREE from "three";
import { CAMERA_ELEVATION_DEGREES } from "../inputs/scene.js";
import type { CharacterSource } from "./model.js";

// biome-ignore lint/suspicious/noExplicitAny: three ships no type declarations (see three-shim.d.ts)
type Any = any;

/** One baked frame: the model at a heading (radians about z), playing `clip` at `time` seconds. */
export interface BakeFrame {
  readonly key: string;
  readonly heading: number;
  readonly clip: "idle" | "walk";
  readonly time: number;
}
/**
 * A cell is 192 px for 0.9 m (213 px a metre, about 2.2× the yard's 96 px a metre at zoom 1), so close
 * stills stay sharp; the frame is centred BAKE_CENTRE_Z above the feet.
 */
export const BAKE_CELL = 192;
export const BAKE_METRES = 0.9;
export const BAKE_CENTRE_Z = 0.3;
const COLUMNS = 8;

export interface BakedAtlas {
  readonly albedo: Any;
  readonly normal: Any;
  readonly depth: Any;
  /** Atlas columns and rows, and a frame's (column, row) from the bottom left (GL texture order). */
  readonly columns: number;
  readonly rows: number;
  cell(key: string): { column: number; row: number };
  /** PNG data URLs of the three atlases, top row first, for the report. */
  pngs(): Record<"albedo" | "normal" | "depth", string>;
  readonly stepMs: Readonly<Record<string, number>>;
  readonly width: number;
  readonly height: number;
}

/** The scene camera's view direction (from the target towards the camera), as three.ts sets it. */
export function cameraDirection(): Any {
  const e = (CAMERA_ELEVATION_DEGREES * Math.PI) / 180;
  return new THREE.Vector3(1, -1, Math.SQRT2 * Math.tan(e)).normalize();
}

function texture(data: Uint8Array, w: number, h: number): Any {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The albedo render target holds linear values; the report's PNG gets them sRGB-encoded. */
function toSrgb(v: number): number {
  const c = v / 255;
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}

function png(data: Uint8Array, w: number, h: number, opaque: boolean, linear = false): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const row = data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4);
    image.data.set(row, y * w * 4);
  }
  if (opaque) for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  if (linear)
    for (let i = 0; i < image.data.length; i++)
      if (i % 4 !== 3) image.data[i] = toSrgb(image.data[i] ?? 0);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export function bakeSprites(
  renderer: Any,
  source: CharacterSource,
  frames: readonly BakeFrame[],
): BakedAtlas {
  const stepMs: Record<string, number> = {};
  const start = performance.now();
  const rows = Math.ceil(frames.length / COLUMNS);
  const width = COLUMNS * BAKE_CELL;
  const height = rows * BAKE_CELL;
  const atlases = {
    albedo: new Uint8Array(width * height * 4),
    normal: new Uint8Array(width * height * 4),
    depth: new Uint8Array(width * height * 4),
  };
  const cells = new Map<string, { column: number; row: number }>();

  const scene = new THREE.Scene();
  const instance = source.instantiate();
  scene.add(instance.root);
  const half = BAKE_METRES / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.05, 20);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, BAKE_CENTRE_Z).addScaledVector(cameraDirection(), 7);
  camera.lookAt(0, 0, BAKE_CENTRE_Z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  // Per pass, each mesh's material: unlit albedo (with its outline), view-space normals, depth.
  const shaded: Any[] = [];
  const outlines: Any[] = [];
  instance.root.traverse((node: Any) => {
    if (!node.isMesh) return;
    (node.userData.outline ? outlines : shaded).push(node);
  });
  const passes = {
    albedo: shaded.map(
      (m) =>
        new THREE.MeshBasicMaterial({
          map: m.material.map ?? null,
          vertexColors: m.material.vertexColors,
          color: m.material.color,
        }),
    ),
    normal: shaded.map(() => new THREE.MeshNormalMaterial()),
    depth: shaded.map(() => new THREE.MeshDepthMaterial()),
  };
  const originals = shaded.map((m) => m.material);
  const target = new THREE.WebGLRenderTarget(BAKE_CELL, BAKE_CELL, { depthBuffer: true });
  const previousTarget = renderer.getRenderTarget();
  const previousClear = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const pixels = new Uint8Array(BAKE_CELL * BAKE_CELL * 4);
  const clears = { albedo: [0, 0, 0], normal: [0.5, 0.5, 1], depth: [0, 0, 0] } as const;

  frames.forEach((frame, i) => {
    const column = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    cells.set(frame.key, { column, row });
    instance.root.rotation.z = frame.heading;
    instance.pose(frame.clip, frame.time);
    instance.root.updateMatrixWorld(true);
    for (const pass of ["albedo", "normal", "depth"] as const) {
      shaded.forEach((m, k) => {
        m.material = passes[pass][k];
      });
      for (const o of outlines) o.visible = pass === "albedo";
      renderer.setRenderTarget(target);
      // Only the albedo pass's alpha is read; the others clear opaque, because a premultiplied clear at
      // alpha 0 would write black instead of the flat normal (0.5, 0.5, 1).
      renderer.setClearColor(new THREE.Color().setRGB(...clears[pass]), pass === "albedo" ? 0 : 1);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, BAKE_CELL, BAKE_CELL, pixels);
      const atlas = atlases[pass];
      for (let y = 0; y < BAKE_CELL; y++)
        atlas.set(
          pixels.subarray(y * BAKE_CELL * 4, (y + 1) * BAKE_CELL * 4),
          ((row * BAKE_CELL + y) * width + column * BAKE_CELL) * 4,
        );
    }
  });
  shaded.forEach((m, k) => {
    m.material = originals[k];
  });
  for (const o of outlines) o.visible = true;
  renderer.setRenderTarget(previousTarget);
  renderer.setClearColor(previousClear, previousAlpha);
  target.dispose();
  for (const list of Object.values(passes)) for (const m of list) m.dispose();
  stepMs.bake = Math.round((performance.now() - start) * 1_000) / 1_000;

  return {
    albedo: texture(atlases.albedo, width, height),
    normal: texture(atlases.normal, width, height),
    depth: texture(atlases.depth, width, height),
    columns: COLUMNS,
    rows,
    width,
    height,
    cell: (key) => cells.get(key) ?? { column: 0, row: 0 },
    pngs: () => ({
      albedo: png(atlases.albedo, width, height, false, true),
      normal: png(atlases.normal, width, height, true),
      depth: png(atlases.depth, width, height, true),
    }),
    stepMs,
  };
}
