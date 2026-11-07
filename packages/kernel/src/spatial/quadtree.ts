import { shapeBounds } from "@clockgrove/domain";
import {
  classifyCell,
  compareIds,
  pointInBounds,
  SPATIAL_THRESHOLDS,
  type SpatialBinding,
  type SpatialBounds,
  type SpatialCellRef,
  type SpatialCellSummary,
  type SpatialIndexPort,
  type SpatialUpdate,
} from "./index-port.js";

export const QUADTREE_INDEX_KIND = "loose-quadtree";
export const QUADTREE_INDEX_VERSION = 1;
/** Fixed planar domain: [-2^47, 2^47) on each of the first two axes (the fixed-point range). */
const DOMAIN_MIN = -(1n << 47n);
const ROOT_SIZE = 1n << 48n;
const MAX_LEVEL = 32;

interface Cell {
  readonly level: number;
  readonly ix: bigint;
  readonly iy: bigint;
  readonly objects: Set<string>;
  mutations: number;
}

function morton(ix: bigint, iy: bigint, level: number): string {
  let code = 0n;
  for (let bit = 0; bit < level; bit += 1) {
    const shift = BigInt(bit);
    code |= ((ix >> shift) & 1n) << (2n * shift);
    code |= ((iy >> shift) & 1n) << (2n * shift + 1n);
  }
  return code.toString(16).padStart(mortonWidth(level), "0");
}

function mortonWidth(level: number): number {
  return Math.max(1, Math.ceil((2 * level) / 4));
}

function unmorton(code: string, level: number): readonly [bigint, bigint] | undefined {
  if (!/^[0-9a-f]+$/u.test(code) || code.length !== mortonWidth(level)) return undefined;
  const value = BigInt(`0x${code}`);
  if (value >= 1n << BigInt(2 * level)) return undefined;
  let ix = 0n;
  let iy = 0n;
  for (let bit = 0; bit < level; bit += 1) {
    const shift = BigInt(bit);
    ix |= ((value >> (2n * shift)) & 1n) << shift;
    iy |= ((value >> (2n * shift + 1n)) & 1n) << shift;
  }
  return [ix, iy];
}

const sizeAt = (level: number): bigint => ROOT_SIZE >> BigInt(level);
const keyOf = (level: number, ix: bigint, iy: bigint) => `${level}/${ix}/${iy}`;

function leafIndex(value: bigint): bigint {
  const cells = 1n << BigInt(MAX_LEVEL);
  const index = (value - DOMAIN_MIN) >> BigInt(48 - MAX_LEVEL);
  return index < 0n ? 0n : index >= cells ? cells - 1n : index;
}

/**
 * Pure loose quadtree over the first two axes of a fixed fixed-point domain (higher axes are
 * tested exactly on the bound poses). Every bound object is registered in each ancestor cell, so
 * a cell summary is a lookup; queries prune by loose cell bounds (a cell extended by half its
 * side on every side) and finish with an exact inclusive test. One instance serves one epoch.
 */
export function createQuadtreeSpatialIndex(epoch: number): SpatialIndexPort {
  const bindings = new Map<string, SpatialBinding>();
  const cells = new Map<string, Cell>();

  const guard = (value: number): void => {
    if (value !== epoch) throw new RangeError("stale epoch");
  };

  const touch = (binding: SpatialBinding, add: boolean): void => {
    const ix = leafIndex(binding.pose.coordinates[0]!);
    const iy = leafIndex(binding.pose.coordinates[1]!);
    for (let level = 0; level <= MAX_LEVEL; level += 1) {
      const shift = BigInt(MAX_LEVEL - level);
      const cx = ix >> shift;
      const cy = iy >> shift;
      const key = keyOf(level, cx, cy);
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { level, ix: cx, iy: cy, objects: new Set(), mutations: 0 };
        cells.set(key, cell);
      }
      if (add) cell.objects.add(binding.objectId);
      else cell.objects.delete(binding.objectId);
      cell.mutations += 1;
    }
  };

  const update = (at: number, change: SpatialUpdate): readonly string[] => {
    guard(at);
    const { binding } = change;
    if (binding.pose.coordinates.length < 2) throw new RangeError("a pose needs two planar axes");
    const existing = bindings.get(binding.objectId);
    if (change.op === "remove") {
      if (existing === undefined) return [];
      touch(existing, false);
      bindings.delete(binding.objectId);
      return [binding.objectId];
    }
    if (
      existing !== undefined &&
      existing.pose.coordinates.length === binding.pose.coordinates.length &&
      existing.pose.coordinates.every((value, axis) => value === binding.pose.coordinates[axis])
    )
      return [];
    if (existing === undefined && bindings.size >= SPATIAL_THRESHOLDS.countBound)
      throw new RangeError("index count bound reached");
    if (existing !== undefined) touch(existing, false);
    touch(binding, true);
    bindings.set(binding.objectId, binding);
    return [binding.objectId];
  };

  const query = (
    at: number,
    region: Parameters<SpatialIndexPort["query"]>[1],
  ): readonly string[] => {
    guard(at);
    const [min, max] = shapeBounds(region.shape);
    const bounds: SpatialBounds = { min, max };
    const found: string[] = [];
    const visit = (level: number, ix: bigint, iy: bigint): void => {
      const cell = cells.get(keyOf(level, ix, iy));
      if (cell === undefined || cell.objects.size === 0) return;
      const size = sizeAt(level);
      const half = size / 2n;
      const lowX = DOMAIN_MIN + ix * size - half;
      const lowY = DOMAIN_MIN + iy * size - half;
      if (
        bounds.max[0]! < lowX ||
        bounds.min[0]! > lowX + size + 2n * half - 1n ||
        bounds.max[1]! < lowY ||
        bounds.min[1]! > lowY + size + 2n * half - 1n
      )
        return;
      if (level === MAX_LEVEL) {
        for (const id of cell.objects)
          if (pointInBounds(bindings.get(id)!.pose.coordinates, bounds)) found.push(id);
        return;
      }
      for (let dy = 0n; dy < 2n; dy += 1n)
        for (let dx = 0n; dx < 2n; dx += 1n) visit(level + 1, ix * 2n + dx, iy * 2n + dy);
    };
    visit(0, 0n, 0n);
    return found.sort(compareIds);
  };

  const summarize = (at: number, ref: SpatialCellRef): SpatialCellSummary => {
    guard(at);
    if (
      ref === null ||
      typeof ref !== "object" ||
      ref.indexKind !== QUADTREE_INDEX_KIND ||
      ref.indexVersion !== QUADTREE_INDEX_VERSION ||
      ref.indexEpoch !== epoch ||
      !Number.isInteger(ref.level) ||
      ref.level < 0 ||
      ref.level > MAX_LEVEL
    )
      throw new RangeError("cell reference does not belong to this index epoch");
    const decoded =
      typeof ref.mortonCode === "string" ? unmorton(ref.mortonCode, ref.level) : undefined;
    if (decoded === undefined) throw new RangeError("invalid cell reference");
    const [ix, iy] = decoded;
    const cell = cells.get(keyOf(ref.level, ix, iy));
    const size = sizeAt(ref.level);
    const minX = DOMAIN_MIN + ix * size;
    const minY = DOMAIN_MIN + iy * size;
    const objectCount = cell?.objects.size ?? 0;
    const mutationCount = cell?.mutations ?? 0;
    return Object.freeze({
      cellRef: Object.freeze({ ...ref }),
      bounds: Object.freeze({ min: [minX, minY], max: [minX + size - 1n, minY + size - 1n] }),
      count: objectCount,
      countBound: SPATIAL_THRESHOLDS.countBound,
      inputs: Object.freeze({ objectCount, mutationCount }),
      thresholdsVersion: SPATIAL_THRESHOLDS.version,
      classification: classifyCell(objectCount, mutationCount),
    });
  };

  return Object.freeze({ update, query, summarize });
}

/** The reference of the cell at `level` containing planar coordinates `x`, `y`. */
export function quadtreeCellRef(
  epoch: number,
  level: number,
  x: bigint,
  y: bigint,
): SpatialCellRef {
  const shift = BigInt(MAX_LEVEL - level);
  return Object.freeze({
    indexKind: QUADTREE_INDEX_KIND,
    indexVersion: QUADTREE_INDEX_VERSION,
    indexEpoch: epoch,
    level,
    mortonCode: morton(leafIndex(x) >> shift, leafIndex(y) >> shift, level),
  });
}
