import type { SpatialFrameId } from "@clockgrove/contracts";

import type { FixedPoint } from "../spatial.js";
import { exactRecord, fail, oneOf, point, positiveFixed, text, time, version } from "./parse.js";

export type Vec2 = readonly [FixedPoint, FixedPoint];
export type Vec3 = readonly [FixedPoint, FixedPoint, FixedPoint];

/**
 * Region shapes. Every shape includes its boundary (edge or vertex points are inside).
 * Polygon vertices are ordered counter-clockwise (positive signed area) in the frame's axes.
 */
export type RegionShape =
  | Readonly<{ kind: "circle"; center: Vec2; radius: FixedPoint }>
  | Readonly<{ kind: "rectangle"; min: Vec2; max: Vec2 }>
  | Readonly<{ kind: "polygon"; vertices: readonly Vec2[] }>
  | Readonly<{ kind: "box"; min: Vec3; max: Vec3 }>;

export const REGION_SHAPE_KINDS = Object.freeze(["circle", "rectangle", "polygon", "box"] as const);
export const MAX_POLYGON_VERTICES = 64;

/**
 * The semantic parent of a place (graph 5 of the Wave 1 spatial model): a region named by id and
 * pinned version. `worldId` and `timelineId` are optional; when present they must name the
 * enclosing world and timeline, because a semantic hierarchy never crosses worlds or timelines.
 */
export interface SemanticParentRef {
  readonly regionId: string;
  readonly version: number;
  readonly worldId?: string;
  readonly timelineId?: string;
}

/** A dwell: staying inside the region this long fires one keyed remain-in-region schedule. */
export interface RegionDwell {
  readonly durationMs: bigint;
}

export interface SpatialRegion {
  readonly regionId: string;
  readonly version: number;
  readonly frameId: SpatialFrameId;
  readonly frameVersion: number;
  readonly shape: RegionShape;
  /** Absent for a root place; regions without it keep their canonical encoding. */
  readonly parent?: SemanticParentRef;
  /** Absent for a region without remain-in-region scheduling. */
  readonly dwell?: RegionDwell;
}

export function shapeDimensions(shape: RegionShape): 2 | 3 {
  return shape.kind === "box" ? 3 : 2;
}

type P2 = readonly [bigint, bigint];

function cross(ax: bigint, ay: bigint, bx: bigint, by: bigint): bigint {
  return ax * by - ay * bx;
}

/** Twice the signed area; positive for counter-clockwise vertex order. */
export function polygonSignedArea2(vertices: readonly P2[]): bigint {
  let total = 0n;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    total += cross(a[0], a[1], b[0], b[1]);
  }
  return total;
}

function sign(value: bigint): -1 | 0 | 1 {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

function onSegment(a: P2, b: P2, p: P2): boolean {
  return (
    cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]) === 0n &&
    p[0] >= (a[0] < b[0] ? a[0] : b[0]) &&
    p[0] <= (a[0] > b[0] ? a[0] : b[0]) &&
    p[1] >= (a[1] < b[1] ? a[1] : b[1]) &&
    p[1] <= (a[1] > b[1] ? a[1] : b[1])
  );
}

/** Closed-segment intersection (touching and collinear overlap count). */
function segmentsMeet(a: P2, b: P2, c: P2, d: P2): boolean {
  const o1 = sign(cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]));
  const o2 = sign(cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]));
  const o3 = sign(cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]));
  const o4 = sign(cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]));
  if (o1 !== o2 && o3 !== o4) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Throws a DomainValidationError unless the vertices form a simple counter-clockwise polygon. */
export function validatePolygonVertices(vertices: readonly P2[], path: string): void {
  if (vertices.length < 3) fail(path, "a polygon needs at least 3 distinct vertices");
  const seen = new Set<string>();
  for (const vertex of vertices) seen.add(`${vertex[0]},${vertex[1]}`);
  if (seen.size < 3) fail(path, "a polygon needs at least 3 distinct vertices");
  if (seen.size !== vertices.length) fail(path, "polygon vertices must be distinct");
  const area = polygonSignedArea2(vertices);
  const count = vertices.length;
  for (let first = 0; first < count; first += 1) {
    const a = vertices[first]!;
    const b = vertices[(first + 1) % count]!;
    for (let second = first + 1; second < count; second += 1) {
      const c = vertices[second]!;
      const d = vertices[(second + 1) % count]!;
      const adjacent = second === first + 1 || (first === 0 && second === count - 1);
      if (adjacent) {
        // Adjacent edges share exactly one vertex; any other contact is a fold-back overlap.
        const foldedBack =
          second === first + 1
            ? onSegment(c, d, a) || onSegment(a, b, d)
            : onSegment(c, d, b) || onSegment(a, b, c);
        if (foldedBack) fail(path, "polygon must not self-intersect");
      } else if (segmentsMeet(a, b, c, d)) {
        fail(path, "polygon must not self-intersect");
      }
    }
  }
  if (area === 0n) fail(path, "polygon must not have zero area");
  if (area < 0n) fail(path, "polygon vertices must be counter-clockwise");
}

/** Structural and geometric validation of untrusted input; throws DomainValidationError. */
export function parseSpatialRegion(value: unknown, path = "region"): SpatialRegion {
  const record = exactRecord(
    value,
    path,
    ["regionId", "version", "frameId", "frameVersion", "shape"],
    ["parent", "dwell"],
  );
  const regionId = text(record.regionId, `${path}.regionId`);
  const regionVersion = version(record.version, `${path}.version`);
  const frameId = text(record.frameId, `${path}.frameId`) as SpatialFrameId;
  const frameVersion = version(record.frameVersion, `${path}.frameVersion`);
  const shapeValue = exactRecord(
    record.shape,
    `${path}.shape`,
    ["kind"],
    ["center", "radius", "min", "max", "vertices"],
  );
  const kind = oneOf(shapeValue.kind, `${path}.shape.kind`, REGION_SHAPE_KINDS);
  const at = `${path}.shape`;
  let shape: RegionShape;
  switch (kind) {
    case "circle": {
      const body = exactRecord(shapeValue, at, ["kind", "center", "radius"]);
      shape = {
        kind,
        center: point(body.center, `${at}.center`, 2) as unknown as Vec2,
        radius: positiveFixed(body.radius, `${at}.radius`),
      };
      break;
    }
    case "rectangle":
    case "box": {
      const body = exactRecord(shapeValue, at, ["kind", "min", "max"]);
      const dimensions = kind === "box" ? 3 : 2;
      const min = point(body.min, `${at}.min`, dimensions);
      const max = point(body.max, `${at}.max`, dimensions);
      for (let axis = 0; axis < dimensions; axis += 1)
        if (min[axis]! >= max[axis]!)
          fail(at, "must have positive extent on every axis (no zero-area regions)");
      shape = { kind, min, max } as unknown as RegionShape;
      break;
    }
    case "polygon": {
      const body = exactRecord(shapeValue, at, ["kind", "vertices"]);
      if (!Array.isArray(body.vertices)) return fail(`${at}.vertices`, "must be an array");
      if (body.vertices.length > MAX_POLYGON_VERTICES)
        return fail(`${at}.vertices`, `must contain at most ${MAX_POLYGON_VERTICES} vertices`);
      const vertices = (body.vertices as unknown[]).map(
        (vertex, index) => point(vertex, `${at}.vertices[${index}]`, 2) as unknown as Vec2,
      );
      validatePolygonVertices(vertices, `${at}.vertices`);
      shape = { kind, vertices };
      break;
    }
  }
  let parent: SemanticParentRef | undefined;
  if (record.parent !== undefined) {
    const at = `${path}.parent`;
    const ref = exactRecord(record.parent, at, ["regionId", "version"], ["worldId", "timelineId"]);
    parent = Object.freeze({
      regionId: text(ref.regionId, `${at}.regionId`),
      version: version(ref.version, `${at}.version`),
      ...(ref.worldId === undefined ? {} : { worldId: text(ref.worldId, `${at}.worldId`) }),
      ...(ref.timelineId === undefined
        ? {}
        : { timelineId: text(ref.timelineId, `${at}.timelineId`) }),
    });
  }
  let dwell: RegionDwell | undefined;
  if (record.dwell !== undefined) {
    const at = `${path}.dwell`;
    const durationMs = time(
      exactRecord(record.dwell, at, ["durationMs"]).durationMs,
      `${at}.durationMs`,
    );
    if (durationMs === 0n) fail(`${at}.durationMs`, "must be positive");
    dwell = Object.freeze({ durationMs });
  }
  return Object.freeze({
    regionId,
    version: regionVersion,
    frameId,
    frameVersion,
    shape,
    ...(parent === undefined ? {} : { parent }),
    ...(dwell === undefined ? {} : { dwell }),
  });
}

/** Validates a typed region; equivalent to parsing its canonical value. */
export function validateSpatialRegion(region: SpatialRegion): void {
  parseSpatialRegion(region);
}

/**
 * Inclusive containment of a point whose coordinates are scaled by `scale` (a positive bigint),
 * i.e. the point (x / scale, y / scale, ...). Boundary points are inside.
 */
export function shapeContainsScaled(
  shape: RegionShape,
  coordinates: readonly bigint[],
  scale: bigint,
): boolean {
  switch (shape.kind) {
    case "circle": {
      const dx = coordinates[0]! - shape.center[0] * scale;
      const dy = coordinates[1]! - shape.center[1] * scale;
      const radius = shape.radius * scale;
      return dx * dx + dy * dy <= radius * radius;
    }
    case "rectangle":
    case "box":
      return shape.min.every(
        (low, axis) =>
          coordinates[axis]! >= low * scale && coordinates[axis]! <= shape.max[axis]! * scale,
      );
    case "polygon": {
      const px = coordinates[0]!;
      const py = coordinates[1]!;
      let inside = false;
      const count = shape.vertices.length;
      for (let index = 0; index < count; index += 1) {
        const a = shape.vertices[index]!;
        const b = shape.vertices[(index + 1) % count]!;
        const ax = a[0] * scale;
        const ay = a[1] * scale;
        const bx = b[0] * scale;
        const by = b[1] * scale;
        if (onSegment([ax, ay], [bx, by], [px, py])) return true;
        if (ay > py !== by > py) {
          // The ray to +x crosses this edge when px lies left of the edge at height py.
          const lhs = (px - ax) * (by - ay);
          const rhs = (bx - ax) * (py - ay);
          if (by > ay ? lhs < rhs : lhs > rhs) inside = !inside;
        }
      }
      return inside;
    }
  }
}

export function shapeContains(shape: RegionShape, coordinates: readonly bigint[]): boolean {
  return shapeContainsScaled(shape, coordinates, 1n);
}

export function regionContains(region: SpatialRegion, coordinates: readonly bigint[]): boolean {
  return shapeContains(region.shape, coordinates);
}

/** Axis-aligned bounds of a shape: [min, max] per axis. */
export function shapeBounds(shape: RegionShape): readonly [readonly bigint[], readonly bigint[]] {
  switch (shape.kind) {
    case "circle":
      return [
        [shape.center[0] - shape.radius, shape.center[1] - shape.radius],
        [shape.center[0] + shape.radius, shape.center[1] + shape.radius],
      ];
    case "rectangle":
    case "box":
      return [shape.min, shape.max];
    case "polygon": {
      const xs = shape.vertices.map((vertex) => vertex[0]);
      const ys = shape.vertices.map((vertex) => vertex[1]);
      const lowest = (values: readonly bigint[]) => values.reduce((a, b) => (b < a ? b : a));
      const highest = (values: readonly bigint[]) => values.reduce((a, b) => (b > a ? b : a));
      return [
        [lowest(xs), lowest(ys)],
        [highest(xs), highest(ys)],
      ];
    }
  }
}
