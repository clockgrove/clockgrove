// Issue 77: fits the spike's own quadruped skeleton to a generated, unrigged mesh (the owner's decision for
// the fal.ai route: "fit the spike's own procedural skeleton, idle and walk to the generated mesh"). The mesh
// arrives in yard axes (x forward, y left, z up), feet on z = 0. The fit:
// - maps the stand-in's spine, neck and head joints onto the mesh's bounding box, axis by axis;
// - places each leg over the centroid of its quadrant of the mesh's lowest vertices (the paws);
// - runs the tail through the centroids of four slices behind the hips, so it follows the tail's curve;
// - weights every vertex to its two nearest bone segments (inverse-square), with a leg allowed only on its own
//   side and fading above its hip, and the tail allowed only behind the hips.
// It is a heuristic with no retopology and no weight painting: the report shows its artefacts.
import * as THREE from "three";

// biome-ignore lint/suspicious/noExplicitAny: three ships no type declarations (see three-shim.d.ts)
type Any = any;
export type V3 = readonly [number, number, number];
export interface Joint {
  readonly name: string;
  readonly parent: string | null;
  readonly at: V3;
  readonly end: V3;
}
export interface FittedRig {
  readonly joints: readonly Joint[];
  readonly skinIndex: Uint16Array;
  readonly skinWeight: Float32Array;
  readonly notes: string;
}

/** Paws are the vertices within this fraction of the height above the ground. */
const PAW_BAND = 0.06;
/** The stand-in's extent along x (tail tip to nose) and its half-width, for mapping its joints. */
const STAND_IN_X: readonly [number, number] = [-0.62, 0.476];
const STAND_IN_HALF_WIDTH = 0.165;
/** A leg's weight fades over this many metres above its upper joint (decision: body fat hides the hip). */
const LEG_FADE_M = 0.04;

function segmentDistance(p: Any, a: V3, b: V3): number {
  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ap = new THREE.Vector3(p.x - a[0], p.y - a[1], p.z - a[2]);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return ap.sub(ab.multiplyScalar(t)).length();
}

/** Fits `template` (the stand-in's joints) to `geometry` (yard axes, feet at z = 0). */
export function fitRig(geometry: Any, template: readonly Joint[]): FittedRig {
  const position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const p = new THREE.Vector3();
  const height = box.max.z - box.min.z;
  const sx = (box.max.x - box.min.x) / (STAND_IN_X[1] - STAND_IN_X[0]);
  const sy = (box.max.y - box.min.y) / (2 * STAND_IN_HALF_WIDTH);
  const sz = height / 0.53;
  const midY = (box.max.y + box.min.y) / 2;
  const map = (v: V3): V3 => [
    box.min.x + (v[0] - STAND_IN_X[0]) * sx,
    midY + v[1] * sy,
    box.min.z + v[2] * sz,
  ];
  const joints = new Map<string, { name: string; parent: string | null; at: V3; end: V3 }>();
  for (const j of template) joints.set(j.name, { ...j, at: map(j.at), end: map(j.end) });

  // Paws: the lowest band, ahead of the tail's root, split into four quadrants about their own centroid.
  const tailRootX = joints.get("tail1")?.at[0] ?? box.min.x;
  const paws: Any[] = [];
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    if (p.z < box.min.z + PAW_BAND * height && p.x > tailRootX) paws.push(p.clone());
  }
  const centre = paws
    .reduce((s, v) => s.add(v), new THREE.Vector3())
    .multiplyScalar(1 / Math.max(1, paws.length));
  const legNotes: string[] = [];
  for (const leg of ["front", "back"])
    for (const side of ["L", "R"]) {
      const quadrant = paws.filter(
        (v) =>
          (leg === "front" ? v.x >= centre.x : v.x < centre.x) &&
          (side === "L" ? v.y >= centre.y : v.y < centre.y),
      );
      const upper = joints.get(`${leg}Upper${side}`);
      const lower = joints.get(`${leg}Lower${side}`);
      if (!upper || !lower) continue;
      if (quadrant.length === 0) {
        legNotes.push(`${leg} ${side}: no paw found, kept the mapped stand-in leg`);
        continue;
      }
      const c = quadrant
        .reduce((s, v) => s.add(v), new THREE.Vector3())
        .multiplyScalar(1 / quadrant.length);
      upper.at = [c.x, c.y, upper.at[2]];
      upper.end = [c.x, c.y, lower.at[2]];
      lower.at = upper.end;
      lower.end = [c.x, c.y, box.min.z];
    }

  // Tail: centroids of four equal x-slices from the tail's root to the rearmost vertex.
  const tail = ["tail1", "tail2", "tail3", "tail4"];
  const sums = tail.map(() => ({ v: new THREE.Vector3(), n: 0 }));
  const span = tailRootX - box.min.x;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    if (p.x >= tailRootX) continue;
    const k = Math.min(3, Math.floor(((tailRootX - p.x) / Math.max(1e-6, span)) * 4));
    sums[k]?.v.add(p);
    if (sums[k]) sums[k].n += 1;
  }
  const hips = joints.get("hips");
  let previous: V3 = joints.get("tail1")?.at ?? hips?.at ?? [0, 0, 0];
  tail.forEach((name, k) => {
    const joint = joints.get(name);
    const sum = sums[k];
    if (!joint || !sum || sum.n === 0) return;
    const c = sum.v.multiplyScalar(1 / sum.n);
    joint.at = previous;
    joint.end = [c.x, c.y, c.z];
    previous = joint.end;
  });

  // Head: its segment ends at the most forward vertex (the nose).
  let nose = box.max.x;
  let noseAt: V3 = [box.max.x, midY, 0];
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    if (p.x >= nose) {
      nose = p.x;
      noseAt = [p.x, p.y, p.z];
    }
  }
  const head = joints.get("head");
  if (head) head.end = noseAt;

  const fitted = template.map((j) => joints.get(j.name) ?? j);
  const index = new Map(fitted.map((j, i) => [j.name, i]));
  const skinIndex = new Uint16Array(position.count * 4);
  const skinWeight = new Float32Array(position.count * 4);
  const candidates = fitted.filter((j) => j.name !== "root");
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    const ranked: { index: number; w: number }[] = [];
    for (const j of candidates) {
      let d = segmentDistance(p, j.at, j.end);
      const isLeg = /Upper|Lower/u.test(j.name);
      if (isLeg) {
        if (Math.sign(p.y - centre.y) !== Math.sign(j.at[1] - centre.y)) continue;
        const top = Math.max(j.at[2], j.end[2]);
        if (p.z > top) d += ((p.z - top) / LEG_FADE_M) * 0.02;
      }
      if (j.name.startsWith("tail") && p.x > tailRootX + 0.02) continue;
      ranked.push({ index: index.get(j.name) ?? 0, w: 1 / (d * d + 1e-4) });
    }
    ranked.sort((a, b) => b.w - a.w);
    const top2 = ranked.slice(0, 2);
    const total = top2.reduce((s, r) => s + r.w, 0) || 1;
    top2.forEach((r, k) => {
      skinIndex[i * 4 + k] = r.index;
      skinWeight[i * 4 + k] = r.w / total;
    });
  }
  return {
    joints: fitted,
    skinIndex,
    skinWeight,
    notes: [
      `${fitted.length} joints fitted to the mesh (spine and head mapped from the stand-in by bounding box; legs over ${paws.length} paw vertices; tail through 4 slice centroids)`,
      "weights: two nearest bone segments, inverse-square; legs only on their own side and fading above the hip; no weight painting",
      ...legNotes,
    ].join("; "),
  };
}
