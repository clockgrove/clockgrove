// Issue 77's 3D Stevie. Sources behind one interface:
// - the procedural stand-in, built here in code: a skinned raccoon of primitives, an 18-joint skeleton
//   and idle and walk clips. CI has no generated media, so CI renders it;
// - a generated model in the git-ignored media/ (scripts/generate.mjs), loaded with GLTFLoader and re-shaded
//   the same way. It either keeps its provider's rig and clips ("provider", Meshy) or gets the stand-in's
//   skeleton and clips fitted to it ("fit", fit.ts: the fal.ai route).
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { fitRig, type Joint, type V3 } from "./fit.js";

// biome-ignore lint/suspicious/noExplicitAny: three ships no type declarations (see three-shim.d.ts)
type Any = any;

/** One placed character: its root, the clips it can play and the materials a variant tints. */
export interface CharacterInstance {
  readonly root: Any;
  /** Shows `clip` at `time` seconds (looped); deterministic, never reads a clock. */
  pose(clip: "idle" | "walk", time: number): void;
  /** Multiplies every shaded material's colour (a variant's recolour); the outline keeps its colour. */
  tint(rgb: readonly [number, number, number]): void;
  readonly clipDurations: Readonly<Record<"idle" | "walk", number>>;
}
export interface ModelMetrics {
  readonly triangles: number;
  readonly vertices: number;
  readonly joints: number;
  readonly maxInfluencesPerVertex: number;
  readonly textures: readonly { name: string; width: number; height: number }[];
  readonly clips: readonly { name: string; seconds: number; tracks: number }[];
  readonly fur: string;
  readonly rigNotes: string;
}
export interface CharacterSource {
  readonly kind: "procedural-stand-in" | "generated-glb";
  readonly metrics: ModelMetrics;
  /** Milliseconds per preparation step, measured on this page (build, rig, clips, or load). */
  readonly stepMs: Readonly<Record<string, number>>;
  instantiate(): CharacterInstance;
}

/** Three-step toon ramp shared by every stylised material, so all characters share one light response. */
let ramp: Any = null;
function toonRamp(): Any {
  if (!ramp) {
    ramp = new THREE.DataTexture(
      new Uint8Array([70, 70, 70, 255, 165, 165, 165, 255, 255, 255, 255, 255]),
      3,
      1,
    );
    ramp.minFilter = THREE.NearestFilter;
    ramp.magFilter = THREE.NearestFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
}
/** Outline thickness in model metres along the skinned normal (the inverted hull). */
const OUTLINE = 0.009;
const OUTLINE_COLOUR = 0x1c1410;

/** The shared stylised material: toon ramp, scene lights and fog, an optional albedo map. */
export function toonMaterial(options: Record<string, unknown>): Any {
  return new THREE.MeshToonMaterial({ gradientMap: toonRamp(), fog: true, ...options });
}
/** The inverted-hull outline for a skinned mesh: back faces pushed out along the skinned normal. */
function outlineMaterial(): Any {
  const material = new THREE.MeshBasicMaterial({
    color: OUTLINE_COLOUR,
    side: THREE.BackSide,
    fog: true,
  });
  material.onBeforeCompile = (shader: Any) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <skinning_vertex>",
      `#include <skinning_vertex>\ntransformed += normalize( objectNormal ) * ${OUTLINE.toFixed(4)};`,
    );
  };
  return material;
}

/** A deterministic hash of integer coordinates to 0..1 (same family as inputs/materials.ts). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_147_483_647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295;
}
/** Fur, texture-only: short light and dark strokes, 256×256, a brightness multiplier around 1. */
const FUR_SIZE = 256;
let fur: Any = null;
function furTexture(): Any {
  if (fur) return fur;
  const data = new Uint8Array(FUR_SIZE * FUR_SIZE * 4).fill(205);
  for (let i = 0; i < 2_400; i++) {
    const x0 = Math.floor(hash(i, 1, 7) * FUR_SIZE);
    const y0 = Math.floor(hash(i, 2, 7) * FUR_SIZE);
    const shade = hash(i, 3, 7) < 0.5 ? 150 : 250;
    const length = 4 + Math.floor(hash(i, 4, 7) * 7);
    for (let s = 0; s < length; s++) {
      const x = (x0 + Math.round(s * 0.35)) % FUR_SIZE;
      const y = (y0 + s) % FUR_SIZE;
      const at = (y * FUR_SIZE + x) * 4;
      data[at] = shade;
      data[at + 1] = shade;
      data[at + 2] = shade;
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  fur = new THREE.DataTexture(data, FUR_SIZE, FUR_SIZE);
  fur.wrapS = THREE.RepeatWrapping;
  fur.wrapT = THREE.RepeatWrapping;
  fur.repeat.set(3, 3);
  fur.colorSpace = THREE.SRGBColorSpace;
  fur.magFilter = THREE.LinearFilter;
  fur.minFilter = THREE.LinearMipmapLinearFilter;
  fur.generateMipmaps = true;
  fur.needsUpdate = true;
  return fur;
}

// ---- The procedural stand-in -------------------------------------------------------------------------

/** Joints in yard axes (x forward, y left, z up), metres, at rest; each with its parent and segment end. */
const JOINTS: readonly Joint[] = [
  { name: "root", parent: null, at: [0, 0, 0], end: [0, 0, 0.1] },
  { name: "hips", parent: "root", at: [-0.14, 0, 0.3], end: [0, 0, 0.32] },
  { name: "spine", parent: "hips", at: [0, 0, 0.32], end: [0.13, 0, 0.31] },
  { name: "chest", parent: "spine", at: [0.13, 0, 0.31], end: [0.2, 0, 0.35] },
  { name: "neck", parent: "chest", at: [0.2, 0, 0.35], end: [0.27, 0, 0.39] },
  { name: "head", parent: "neck", at: [0.27, 0, 0.39], end: [0.42, 0, 0.37] },
  { name: "tail1", parent: "hips", at: [-0.27, 0, 0.29], end: [-0.37, 0, 0.25] },
  { name: "tail2", parent: "tail1", at: [-0.37, 0, 0.25], end: [-0.46, 0, 0.21] },
  { name: "tail3", parent: "tail2", at: [-0.46, 0, 0.21], end: [-0.54, 0, 0.19] },
  { name: "tail4", parent: "tail3", at: [-0.54, 0, 0.19], end: [-0.62, 0, 0.19] },
  ...(["L", "R"] as const).flatMap((side) => {
    const y = side === "L" ? 0.09 : -0.09;
    return [
      {
        name: `frontUpper${side}`,
        parent: "chest",
        at: [0.15, y, 0.24] as V3,
        end: [0.15, y, 0.12] as V3,
      },
      {
        name: `frontLower${side}`,
        parent: `frontUpper${side}`,
        at: [0.15, y, 0.12] as V3,
        end: [0.17, y, 0.0] as V3,
      },
      {
        name: `backUpper${side}`,
        parent: "hips",
        at: [-0.15, y, 0.25] as V3,
        end: [-0.13, y, 0.12] as V3,
      },
      {
        name: `backLower${side}`,
        parent: `backUpper${side}`,
        at: [-0.13, y, 0.12] as V3,
        end: [-0.12, y, 0.0] as V3,
      },
    ];
  }),
];
const JOINT_INDEX = new Map(JOINTS.map((joint, index) => [joint.name, index]));

/** Colours sampled by eye from the identity sheet (sRGB). */
const COLOURS = {
  back: 0x6f6156,
  belly: 0xb9a48a,
  leg: 0x4a3a30,
  foot: 0x2a201b,
  face: 0xe6ddd0,
  mask: 0x1d1917,
  ear: 0x5d5047,
  nose: 0x161212,
  ringLight: 0xc8ae8c,
  ringDark: 0x3a2e27,
} as const;

interface Part {
  readonly geometry: Any;
  /** Joints that may weigh on this part's vertices (the two nearest segments win). */
  readonly joints: readonly string[];
  readonly colour: (x: number, y: number, z: number) => number;
}
const solid = (hex: number) => () => hex;
function ellipsoid(at: V3, r: V3, segments = 18): Any {
  const g = new THREE.SphereGeometry(1, segments, Math.round(segments * 0.75));
  g.scale(r[0], r[1], r[2]);
  g.translate(at[0], at[1], at[2]);
  return g;
}
/** A tapered cylinder from `a` to `b` (an upright leg or an ear). */
function limb(a: V3, b: V3, ra: number, rb: number, segments = 10): Any {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const length = start.distanceTo(end);
  const g = new THREE.CylinderGeometry(rb, ra, length, segments, 3);
  g.translate(0, length / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    end.clone().sub(start).normalize(),
  );
  g.applyQuaternion(q);
  g.translate(a[0], a[1], a[2]);
  return g;
}

function standInParts(): Part[] {
  const bodyColour = (_x: number, _y: number, z: number) =>
    z > 0.3 ? COLOURS.back : COLOURS.belly;
  const parts: Part[] = [
    {
      geometry: ellipsoid([-0.04, 0, 0.3], [0.25, 0.165, 0.16], 24),
      joints: ["hips", "spine", "chest"],
      colour: bodyColour,
    },
    {
      geometry: ellipsoid([-0.15, 0, 0.31], [0.15, 0.16, 0.16], 20),
      joints: ["hips", "spine"],
      colour: bodyColour,
    },
    {
      geometry: ellipsoid([0.31, 0, 0.4], [0.1, 0.105, 0.09], 20),
      joints: ["head"],
      colour: solid(COLOURS.face),
    },
    // The mask: a dark band across the eyes, then the eyes, the snout and the nose.
    {
      geometry: ellipsoid([0.355, 0, 0.405], [0.06, 0.098, 0.035], 16),
      joints: ["head"],
      colour: solid(COLOURS.mask),
    },
    {
      geometry: ellipsoid([0.405, 0.04, 0.415], [0.012, 0.014, 0.014], 8),
      joints: ["head"],
      colour: solid(COLOURS.nose),
    },
    {
      geometry: ellipsoid([0.405, -0.04, 0.415], [0.012, 0.014, 0.014], 8),
      joints: ["head"],
      colour: solid(COLOURS.nose),
    },
    {
      geometry: ellipsoid([0.41, 0, 0.375], [0.055, 0.04, 0.032], 12),
      joints: ["head"],
      colour: solid(COLOURS.face),
    },
    {
      geometry: ellipsoid([0.462, 0, 0.38], [0.014, 0.017, 0.012], 8),
      joints: ["head"],
      colour: solid(COLOURS.nose),
    },
    {
      geometry: limb([0.29, 0.06, 0.46], [0.28, 0.075, 0.53], 0.032, 0.008, 8),
      joints: ["head"],
      colour: solid(COLOURS.ear),
    },
    {
      geometry: limb([0.29, -0.06, 0.46], [0.28, -0.075, 0.53], 0.032, 0.008, 8),
      joints: ["head"],
      colour: solid(COLOURS.ear),
    },
  ];
  // The ringed tail: one ellipsoid per segment, alternating light and dark rings.
  const tail = JOINTS.filter((j) => j.name.startsWith("tail"));
  tail.forEach((joint, i) => {
    const mid: V3 = [(joint.at[0] + joint.end[0]) / 2, 0, (joint.at[2] + joint.end[2]) / 2];
    const radius = 0.075 - i * 0.008;
    const neighbours = [tail[i - 1]?.name, joint.name, tail[i + 1]?.name].filter(
      Boolean,
    ) as string[];
    parts.push({
      geometry: ellipsoid(mid, [0.06, radius, radius], 14),
      joints: neighbours,
      colour: solid(i % 2 ? COLOURS.ringDark : COLOURS.ringLight),
    });
  });
  for (const side of ["L", "R"]) {
    for (const leg of ["front", "back"]) {
      const upper = JOINTS[JOINT_INDEX.get(`${leg}Upper${side}`) ?? 0];
      const lower = JOINTS[JOINT_INDEX.get(`${leg}Lower${side}`) ?? 0];
      if (!upper || !lower) continue;
      const joints = [upper.name, lower.name];
      parts.push({
        geometry: limb(upper.at, lower.at, 0.05, 0.036),
        joints,
        colour: solid(COLOURS.leg),
      });
      parts.push({
        geometry: limb(lower.at, lower.end, 0.036, 0.026),
        joints: [lower.name],
        colour: solid(COLOURS.leg),
      });
      parts.push({
        geometry: ellipsoid([lower.end[0] + 0.02, lower.end[1], 0.014], [0.04, 0.028, 0.016], 10),
        joints: [lower.name],
        colour: solid(COLOURS.foot),
      });
    }
  }
  return parts;
}

/** Distance from p to the segment a–b. */
function segmentDistance(p: Any, a: V3, b: V3): number {
  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ap = new THREE.Vector3(p.x - a[0], p.y - a[1], p.z - a[2]);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return ap.sub(ab.multiplyScalar(t)).length();
}

/** Builds the merged, coloured, skinned geometry once; every instance shares it. */
function buildStandInGeometry(): Any {
  const pieces: Any[] = [];
  const colour = new THREE.Color();
  for (const part of standInParts()) {
    const g = part.geometry.index ? part.geometry : part.geometry;
    const position = g.attributes.position;
    const colours = new Float32Array(position.count * 3);
    const skinIndex = new Uint16Array(position.count * 4);
    const skinWeight = new Float32Array(position.count * 4);
    const p = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      colour.setHex(part.colour(p.x, p.y, p.z));
      colours.set([colour.r, colour.g, colour.b], i * 3);
      // Inverse-square distance to each allowed joint's segment; the two nearest share the vertex.
      const ranked = part.joints
        .map((name) => {
          const joint = JOINTS[JOINT_INDEX.get(name) ?? 0];
          const d = joint ? segmentDistance(p, joint.at, joint.end) : 1;
          return { index: JOINT_INDEX.get(name) ?? 0, w: 1 / (d * d + 1e-4) };
        })
        .sort((a, b) => b.w - a.w)
        .slice(0, 2);
      const total = ranked.reduce((sum, r) => sum + r.w, 0);
      ranked.forEach((r, k) => {
        skinIndex[i * 4 + k] = r.index;
        skinWeight[i * 4 + k] = r.w / total;
      });
    }
    g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    pieces.push(g);
  }
  const merged = mergeGeometries(pieces, false);
  for (const g of pieces) g.dispose();
  return merged;
}

const axisY = new THREE.Vector3(0, 1, 0);
const axisZ = new THREE.Vector3(0, 0, 1);
const axisX = new THREE.Vector3(1, 0, 0);
/** A looping quaternion track sampled at `keys` points of `seconds`, from an angle function of phase. */
function rotationTrack(
  bone: string,
  axis: Any,
  seconds: number,
  angle: (phase: number) => number,
  keys = 12,
): Any {
  const times: number[] = [];
  const values: number[] = [];
  const q = new THREE.Quaternion();
  for (let k = 0; k <= keys; k++) {
    const phase = k / keys;
    times.push(phase * seconds);
    q.setFromAxisAngle(axis, angle(phase));
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}
const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;
/** Idle: 2.4 s of breathing, a slow look round and a lazy tail. Walk: a 0.8 s diagonal-pair gait. */
export const IDLE_SECONDS = 2.4;
export const WALK_SECONDS = 0.8;
function standInClips(hipsAt: V3 = [-0.14, 0, 0.3]): { idle: Any; walk: Any } {
  const s = Math.sin;
  const idle = new THREE.AnimationClip("idle", IDLE_SECONDS, [
    rotationTrack("chest", axisY, IDLE_SECONDS, (p) => deg(2.5) * s(p * TAU)),
    rotationTrack("neck", axisZ, IDLE_SECONDS, (p) => deg(12) * s(p * TAU)),
    rotationTrack("head", axisY, IDLE_SECONDS, (p) => deg(-4) * s(p * TAU * 2)),
    ...["tail1", "tail2", "tail3", "tail4"].map((bone, i) =>
      rotationTrack(bone, axisZ, IDLE_SECONDS, (p) => deg(7) * s(p * TAU - i * 0.6)),
    ),
  ]);
  const gait = (offset: number, amplitude: number) => (p: number) =>
    deg(amplitude) * s((p + offset) * TAU);
  const knee = (offset: number) => (p: number) =>
    deg(-22) * Math.max(0, s((p + offset) * TAU + 1.2));
  const bob = new THREE.VectorKeyframeTrack(
    "hips.position",
    Array.from({ length: 9 }, (_, k) => (k / 8) * WALK_SECONDS),
    Array.from({ length: 9 }, (_, k) => [
      hipsAt[0],
      hipsAt[1],
      hipsAt[2] + 0.012 * Math.cos((k / 8) * TAU * 2),
    ]).flat(),
  );
  const walk = new THREE.AnimationClip("walk", WALK_SECONDS, [
    bob,
    // Diagonal pairs move together: front-left with back-right, front-right with back-left.
    rotationTrack("frontUpperL", axisY, WALK_SECONDS, gait(0, 28)),
    rotationTrack("backUpperR", axisY, WALK_SECONDS, gait(0, 28)),
    rotationTrack("frontUpperR", axisY, WALK_SECONDS, gait(0.5, 28)),
    rotationTrack("backUpperL", axisY, WALK_SECONDS, gait(0.5, 28)),
    rotationTrack("frontLowerL", axisY, WALK_SECONDS, knee(0)),
    rotationTrack("backLowerR", axisY, WALK_SECONDS, knee(0)),
    rotationTrack("frontLowerR", axisY, WALK_SECONDS, knee(0.5)),
    rotationTrack("backLowerL", axisY, WALK_SECONDS, knee(0.5)),
    rotationTrack("chest", axisX, WALK_SECONDS, (p) => deg(3) * s(p * TAU)),
    rotationTrack("head", axisY, WALK_SECONDS, (p) => deg(3) * s(p * TAU * 2)),
    ...["tail1", "tail2", "tail3", "tail4"].map((bone, i) =>
      rotationTrack(bone, axisZ, WALK_SECONDS, (p) => deg(10) * s(p * TAU - i * 0.8)),
    ),
  ]);
  return { idle, walk };
}

function buildBones(joints: readonly Joint[] = JOINTS): Any[] {
  const bones: Any[] = [];
  const index = new Map(joints.map((joint, i) => [joint.name, i]));
  for (const joint of joints) {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    const parent = joint.parent ? joints[index.get(joint.parent) ?? 0] : null;
    bone.position.set(
      joint.at[0] - (parent?.at[0] ?? 0),
      joint.at[1] - (parent?.at[1] ?? 0),
      joint.at[2] - (parent?.at[2] ?? 0),
    );
    if (joint.parent) bones[index.get(joint.parent) ?? 0].add(bone);
    bones.push(bone);
  }
  return bones;
}

/** Plays one clip at one time on a fresh mixer state: deterministic, no wall clock. */
function poser(root: Any, clips: { idle: Any; walk: Any }) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = { idle: mixer.clipAction(clips.idle), walk: mixer.clipAction(clips.walk) };
  return (clip: "idle" | "walk", time: number) => {
    for (const [name, action] of Object.entries(actions)) {
      if (name === clip) action.play();
      else action.stop();
    }
    mixer.setTime(time % clips[clip].duration);
  };
}

function timed<T>(steps: Record<string, number>, name: string, work: () => T): T {
  const start = performance.now();
  const result = work();
  steps[name] = Math.round((performance.now() - start) * 1_000) / 1_000;
  return result;
}

/** One skinned, outlined, posable instance of `geometry` on a fresh skeleton built from `joints`. */
function skinnedInstance(
  geometry: Any,
  material: Any,
  outline: Any,
  joints: readonly Joint[],
  clips: { idle: Any; walk: Any },
): CharacterInstance {
  const bones = buildBones(joints);
  const skeleton = new THREE.Skeleton(bones);
  const shaded = material.clone();
  const mesh = new THREE.SkinnedMesh(geometry, shaded);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(skeleton);
  const hull = new THREE.SkinnedMesh(geometry, outline);
  hull.bind(skeleton, mesh.bindMatrix);
  hull.userData.outline = true;
  mesh.add(hull);
  mesh.frustumCulled = false;
  hull.frustumCulled = false;
  const root = new THREE.Group();
  root.add(mesh);
  const pose = poser(root, clips);
  pose("idle", 0);
  return {
    root,
    pose,
    tint(rgb) {
      shaded.color.setRGB(rgb[0], rgb[1], rgb[2]);
    },
    clipDurations: { idle: clips.idle.duration, walk: clips.walk.duration },
  };
}

export function proceduralStevie(): CharacterSource {
  const stepMs: Record<string, number> = {};
  const geometry = timed(stepMs, "buildMeshAndSkinWeights", buildStandInGeometry);
  const clips = timed(stepMs, "buildClips", standInClips);
  const material = toonMaterial({ vertexColors: true, map: furTexture() });
  const outline = outlineMaterial();
  const vertices = geometry.attributes.position.count;
  const metrics: ModelMetrics = {
    triangles: (geometry.index?.count ?? vertices) / 3,
    vertices,
    joints: JOINTS.length,
    maxInfluencesPerVertex: 2,
    textures: [{ name: "fur strokes (procedural)", width: FUR_SIZE, height: FUR_SIZE }],
    clips: [clips.idle, clips.walk].map((c) => ({
      name: c.name,
      seconds: c.duration,
      tracks: c.tracks.length,
    })),
    fur: "texture only: a 256x256 procedural stroke map multiplied over vertex colours; no shells or cards",
    rigNotes:
      "18 joints placed by hand; weights from the two nearest bone segments within each body part (inverse-square); rigid head and feet; no corrective shapes",
  };
  return {
    kind: "procedural-stand-in",
    metrics,
    stepMs,
    instantiate: () => skinnedInstance(geometry, material, outline, JOINTS, clips),
  };
}

/** How a generated model is rigged: by its provider (with its clips), or by fitting the stand-in's rig. */
export interface GeneratedModel {
  /** The source's name in the report (for example `meshy` or `fal`). */
  readonly name: string;
  readonly url: string;
  readonly rig: "provider" | "fit";
  /** A second glTF whose first clip is the walk (Meshy ships each clip as its own file). */
  readonly walkUrl?: string;
}

/** glTF is y-up and faces +z; the yard is z-up with the character facing +x (y→z first, then −y→+x). */
const GLTF_TO_YARD = new THREE.Matrix4().makeRotationFromEuler(
  new THREE.Euler(Math.PI / 2, 0, Math.PI / 2, "ZYX"),
);

function meshMetrics(scene: Any) {
  let triangles = 0;
  let vertices = 0;
  let joints = 0;
  let influences = 0;
  const textures: { name: string; width: number; height: number }[] = [];
  scene.traverse((node: Any) => {
    if (!node.isMesh) return;
    const g = node.geometry;
    vertices += g.attributes.position.count;
    triangles += (g.index?.count ?? g.attributes.position.count) / 3;
    if (node.isSkinnedMesh) joints = Math.max(joints, node.skeleton.bones.length);
    influences = Math.max(influences, g.attributes.skinWeight ? 4 : 0);
    for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap"]) {
      const map = node.material?.[slot];
      if (map?.image)
        textures.push({
          name: `${slot}${map.name ? ` ${map.name}` : ""}`,
          width: map.image.width,
          height: map.image.height,
        });
    }
  });
  return { triangles, vertices, joints, influences, textures };
}

/**
 * The stand-in's skeleton and clips fitted to a generated mesh's `geometry` (glTF axes): moved into yard axes,
 * centred, feet on the ground, scaled to `heightMetres`, then rigged by `fitRig`.
 */
export function fittedSource(
  geometry: Any,
  map: Any,
  heightMetres: number,
  stepMs: Record<string, number> = {},
  base: Pick<ModelMetrics, "triangles" | "vertices" | "textures" | "fur"> = {
    triangles: 0,
    vertices: 0,
    textures: [],
    fur: "",
  },
  start = performance.now(),
): CharacterSource {
  geometry.applyMatrix4(GLTF_TO_YARD);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const scale = heightMetres / Math.max(1e-6, box.max.z - box.min.z);
  geometry.translate(-(box.max.x + box.min.x) / 2, -(box.max.y + box.min.y) / 2, -box.min.z);
  geometry.scale(scale, scale, scale);
  stepMs.normalise = Math.round((performance.now() - start) * 1_000) / 1_000;
  const rig = timed(stepMs, "fitSkeletonAndWeights", () => fitRig(geometry, JOINTS));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(rig.skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(rig.skinWeight, 4));
  // hips.position keys are local to hips' parent (root), so the walk's bob starts from the parent-relative rest.
  const at = (name: string) => rig.joints.find((j) => j.name === name)?.at ?? [0, 0, 0];
  const [hips, rootAt] = [at("hips"), at("root")];
  const hipsLocal: V3 = [hips[0] - rootAt[0], hips[1] - rootAt[1], hips[2] - rootAt[2]];
  const clips = timed(stepMs, "buildClips", () => standInClips(hipsLocal));
  const material = toonMaterial({ map, color: 0xffffff });
  const outline = outlineMaterial();
  return {
    kind: "generated-glb",
    metrics: {
      ...base,
      joints: rig.joints.length,
      maxInfluencesPerVertex: 2,
      clips: [clips.idle, clips.walk].map((c) => ({
        name: c.name,
        seconds: c.duration,
        tracks: c.tracks.length,
      })),
      rigNotes: `the spike's own skeleton and clips fitted to the generated mesh (fit.ts): ${rig.notes}`,
    },
    stepMs,
    instantiate: () => skinnedInstance(geometry, material, outline, rig.joints, clips),
  };
}

let ktx2: Any = null;
/**
 * The owner's ship form (issue 77): KTX2 textures (KHR_texture_basisu) and EXT_meshopt_compression. The basis
 * transcoder is copied beside the page by scripts/build.mjs; support is detected once on a throwaway renderer.
 */
function shipLoader(): Any {
  if (!ktx2) {
    const probe = new THREE.WebGLRenderer();
    ktx2 = new KTX2Loader().setTranscoderPath("./").detectSupport(probe);
    probe.dispose();
  }
  return new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

/** A one-key clip holding every bone at its rest transform. */
function restClip(scene: Any): Any {
  const tracks: Any[] = [];
  scene.traverse((node: Any) => {
    if (!node.isBone) return;
    tracks.push(
      new THREE.VectorKeyframeTrack(`${node.name}.position`, [0], node.position.toArray()),
      new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, [0], node.quaternion.toArray()),
    );
  });
  return new THREE.AnimationClip("rest pose", 0.001, tracks);
}

/** An idle clip shorter than this (Meshy's one-frame `clip0`) is a held pose, not an idle. */
const HELD_POSE_SECONDS = 0.05;
/**
 * A moving idle for a provider rig that ships none (Tripo) or only a held pose (Meshy): the spike keyframes slow
 * breathing on the provider's own spine and chest bones, a nod on the neck or head, and a tail sway, each a small
 * rotation about the bone's local axes on top of its rest rotation. Bones are found by name; the clip is the
 * spike's, not the provider's, and the report labels it so.
 */
function breathingIdle(scene: Any): Any {
  const tracks: Any[] = [];
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const rule = (name: string): [Any, number, number] | null => {
    if (/tail/iu.test(name)) return [axisY, 7, 1];
    if (/spine|chest/iu.test(name)) return [axisX, 2, 1];
    if (/neck|head/iu.test(name)) return [axisX, 3, 2];
    return null;
  };
  let tail = 0;
  scene.traverse((node: Any) => {
    if (!node.isBone) return;
    const found = rule(node.name);
    if (!found) return;
    const [axis, degrees, cycles] = found;
    const lag = /tail/iu.test(node.name) ? tail++ * 0.6 : 0;
    const times: number[] = [];
    const values: number[] = [];
    for (let k = 0; k <= 12; k++) {
      times.push((k / 12) * IDLE_SECONDS);
      turn.setFromAxisAngle(axis, deg(degrees) * Math.sin((k / 12) * TAU * cycles - lag));
      q.copy(node.quaternion).multiply(turn);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
  });
  if (!tracks.length) return restClip(scene);
  return new THREE.AnimationClip("spike breathing on the provider's bones", IDLE_SECONDS, tracks);
}

/**
 * A generated model (glTF binary), re-shaded with the shared toon ramp and the same inverted-hull outline, at
 * the stand-in's height. With `rig: "provider"` it keeps the provider's skeleton and clips, matched by name
 * (/idle/i, else the rigged file's own clip; /walk/i, else `walkUrl`'s first clip). With `rig: "fit"` its
 * first mesh is moved into yard axes and given the stand-in's skeleton and clips by `fitRig`. Resolves null
 * when the file is absent.
 */
export async function generatedStevie(
  model: GeneratedModel,
  heightMetres: number,
): Promise<CharacterSource | null> {
  const stepMs: Record<string, number> = {};
  const head = await fetch(model.url, { method: "HEAD" }).catch(() => null);
  if (!head?.ok) return null;
  let start = performance.now();
  const loader = shipLoader();
  const gltf = await loader.loadAsync(model.url);
  const walkGltf = model.walkUrl ? await loader.loadAsync(model.walkUrl) : null;
  stepMs.load = Math.round((performance.now() - start) * 1_000) / 1_000;
  const counted = meshMetrics(gltf.scene);
  const base = {
    triangles: counted.triangles,
    vertices: counted.vertices,
    textures: counted.textures,
    fur: "texture only: the generator's baked colour map; no shells or cards",
  };
  if (model.rig === "fit") {
    start = performance.now();
    let mesh: Any = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((node: Any) => {
      if (node.isMesh && !mesh) mesh = node;
    });
    if (!mesh) throw new Error(`${model.url} has no mesh`);
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    return fittedSource(geometry, mesh.material?.map ?? null, heightMetres, stepMs, base, start);
  }
  const find = (clips: Any[], pattern: RegExp) =>
    clips.find((a: Any) => pattern.test(a.name)) ?? null;
  const walk = find(gltf.animations, /walk/iu) ?? walkGltf?.animations[0] ?? null;
  // Without a moving idle (Tripo's quadruped presets have none; Meshy's clip0 is one frame) the spike keyframes
  // breathing on the provider's bones (breathingIdle), so the idle can be judged; the clip name says whose it is.
  const provided = find(gltf.animations, /idle/iu) ?? gltf.animations.find((a: Any) => a !== walk);
  const idle =
    provided && provided.duration > HELD_POSE_SECONDS ? provided : breathingIdle(gltf.scene);
  if (!idle || !walk) throw new Error(`${model.url} has no idle or walk clip`);
  // Normalise height so the generated model and the stand-in share one scale (cohesion criterion 5).
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const scale = heightMetres / Math.max(1e-6, box.max.y - box.min.y);
  gltf.scene.traverse((node: Any) => {
    if (node.isMesh)
      node.material = toonMaterial({ map: node.material?.map ?? null, color: 0xffffff });
  });
  const clips = [idle, walk];
  return {
    kind: "generated-glb",
    metrics: {
      ...base,
      joints: counted.joints,
      maxInfluencesPerVertex: counted.influences,
      clips: clips.map((c: Any, i) => ({
        name: `${i ? "walk" : "idle"}: ${c.name}`,
        seconds: c.duration,
        tracks: c.tracks.length,
      })),
      rigNotes: `the provider's auto-rig, ${counted.joints} joints: ${(gltf.scene.getObjectByProperty("isSkinnedMesh", true)?.skeleton.bones ?? []).map((b: Any) => b.name).join(" ")}`,
    },
    stepMs,
    instantiate() {
      const model3d = cloneSkinned(gltf.scene);
      model3d.rotation.set(Math.PI / 2, 0, Math.PI / 2, "ZYX");
      model3d.scale.setScalar(scale);
      const tinted: Any[] = [];
      const meshes: Any[] = [];
      model3d.traverse((node: Any) => {
        if (node.isMesh) meshes.push(node);
      });
      for (const node of meshes) {
        node.frustumCulled = false;
        node.material = node.material.clone();
        tinted.push(node.material);
        if (node.isSkinnedMesh) {
          const hull = new THREE.SkinnedMesh(node.geometry, outlineMaterial());
          hull.bind(node.skeleton, node.bindMatrix);
          hull.frustumCulled = false;
          hull.userData.outline = true;
          node.add(hull);
        }
      }
      const root = new THREE.Group();
      root.add(model3d);
      const pose = poser(root, { idle, walk });
      pose("idle", 0);
      return {
        root,
        pose,
        tint(rgb) {
          for (const m of tinted) m.color.setRGB(rgb[0], rgb[1], rgb[2]);
        },
        clipDurations: { idle: idle.duration, walk: walk.duration },
      };
    },
  };
}
