import type { ObjectId } from "@clockgrove/contracts";
import type { SemanticPose, SpatialRegion } from "@clockgrove/domain";

/** Inclusive axis-aligned bounds in frame fixed-point units, one entry per axis. */
export interface SpatialBounds {
  readonly min: readonly bigint[];
  readonly max: readonly bigint[];
}

/** An object's pose binding. Indexes hold only bindings; they never own canonical identity. */
export interface SpatialBinding {
  readonly objectId: ObjectId;
  readonly pose: SemanticPose;
}

export type SpatialUpdate = Readonly<{ op: "insert" | "remove"; binding: SpatialBinding }>;

/**
 * Epoch-scoped cell reference. It is an adapter detail: it never appears in canonical state,
 * events, commands or object identity, and a reference from another epoch is always rejected.
 */
export interface SpatialCellRef {
  readonly indexKind: string;
  readonly indexVersion: number;
  readonly indexEpoch: number;
  readonly level: number;
  readonly mortonCode: string;
}

export type SpatialClassification = "hot" | "warm" | "dormant";

/** Versioned thresholds that turn a cell's summary inputs into a classification. */
export const SPATIAL_THRESHOLDS = Object.freeze({
  version: 1,
  /** Largest object count a summary reports; inserts beyond it are refused. */
  countBound: 1024,
  hotObjectCount: 8,
  warmObjectCount: 2,
  hotMutationCount: 16,
  warmMutationCount: 4,
} as const);

export interface SpatialCellSummary {
  readonly cellRef: SpatialCellRef;
  readonly bounds: SpatialBounds;
  /** Objects currently bound inside the cell. */
  readonly count: number;
  readonly countBound: number;
  readonly inputs: Readonly<{ objectCount: number; mutationCount: number }>;
  readonly thresholdsVersion: number;
  readonly classification: SpatialClassification;
}

declare const spatialIndexBrand: unique symbol;

/**
 * Opaque, rebuildable spatial index with exactly three operations. An index is created for one
 * epoch (a new epoch is a fresh, empty index) and every operation rejects another epoch with a
 * `RangeError`. All id lists are ascending and unique; bounds are inclusive.
 */
export interface SpatialIndexPort {
  readonly [spatialIndexBrand]?: never;
  /** Inserts or removes one binding; returns the ids whose binding changed (sorted). */
  readonly update: (epoch: number, update: SpatialUpdate) => readonly string[];
  /** Candidate object ids whose bound pose lies within the region's inclusive bounds. */
  readonly query: (epoch: number, region: SpatialRegion) => readonly string[];
  /** Summary of one cell identified by an epoch-scoped reference. */
  readonly summarize: (epoch: number, cellRef: SpatialCellRef) => SpatialCellSummary;
}

/** Creates a fresh, empty index bound to one epoch. */
export type SpatialIndexFactory = (epoch: number) => SpatialIndexPort;

export const SPATIAL_INDEX_OPERATIONS = Object.freeze(["query", "summarize", "update"] as const);

export function boundsIntersect(left: SpatialBounds, right: SpatialBounds): boolean {
  for (let axis = 0; axis < left.min.length; axis += 1)
    if (left.max[axis]! < right.min[axis]! || right.max[axis]! < left.min[axis]!) return false;
  return true;
}

export function pointInBounds(point: readonly bigint[], bounds: SpatialBounds): boolean {
  for (let axis = 0; axis < point.length; axis += 1)
    if (point[axis]! < bounds.min[axis]! || point[axis]! > bounds.max[axis]!) return false;
  return true;
}

export function classifyCell(objectCount: number, mutationCount: number): SpatialClassification {
  const t = SPATIAL_THRESHOLDS;
  if (objectCount >= t.hotObjectCount || mutationCount >= t.hotMutationCount) return "hot";
  if (objectCount >= t.warmObjectCount || mutationCount >= t.warmMutationCount) return "warm";
  return "dormant";
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
