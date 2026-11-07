import type { ActorProcessId, ObjectId, SpatialFrameId, SubjectId } from "@clockgrove/contracts";

import { DomainValidationError } from "./actor-process.js";

declare const fixedPointBrand: unique symbol;
export type FixedPoint = bigint & { readonly [fixedPointBrand]: true };
export type SpatialDimensions = 2 | 3;

export type FixedPointVector<D extends SpatialDimensions> = D extends 2
  ? readonly [FixedPoint, FixedPoint]
  : readonly [FixedPoint, FixedPoint, FixedPoint];

export type FixedPointMatrix<D extends SpatialDimensions> = D extends 2
  ? readonly [FixedPointVector<2>, FixedPointVector<2>]
  : readonly [FixedPointVector<3>, FixedPointVector<3>, FixedPointVector<3>];

export interface FixedPointUnit {
  readonly name: string;
  readonly fractionalDigits: number;
}

export interface AxisDefinition {
  readonly name: string;
  readonly positiveDirection: string;
}

export interface AxisConvention<D extends SpatialDimensions = SpatialDimensions> {
  readonly axes: D extends 2
    ? readonly [AxisDefinition, AxisDefinition]
    : readonly [AxisDefinition, AxisDefinition, AxisDefinition];
}

export interface FixedPointTransform<D extends SpatialDimensions = SpatialDimensions> {
  readonly version: number;
  readonly translation: FixedPointVector<D>;
  readonly basis: FixedPointMatrix<D>;
}

export interface GravityConvention<D extends SpatialDimensions = SpatialDimensions> {
  readonly kind: "constant-vector";
  readonly vector: FixedPointVector<D>;
}

/**
 * The first six fields preserve the canonical PRD interface. Origin and gravity are the explicit,
 * provider-neutral encodings required by the architecture plan; see docs/spatial.md.
 */
export interface SpatialFrame<D extends SpatialDimensions = SpatialDimensions> {
  readonly frameId: SpatialFrameId;
  readonly version: number;
  readonly dimensions: D;
  readonly unit: FixedPointUnit;
  readonly axes: AxisConvention<D>;
  readonly parentFrameId?: SpatialFrameId;
  readonly parentTransform?: FixedPointTransform<D>;
  readonly origin: FixedPointVector<D>;
  readonly gravity: GravityConvention<D>;
}

export interface SemanticPose<D extends SpatialDimensions = SpatialDimensions> {
  readonly frameId: SpatialFrameId;
  readonly frameVersion: number;
  readonly coordinates: FixedPointVector<D>;
}

export interface CanonicalSpatialIdentity {
  readonly objectId: ObjectId;
  readonly subjectId?: SubjectId;
  readonly actorProcessId?: ActorProcessId;
}

/** Rebuildable adapter/index hints. None is a canonical object, subject, or actor identity. */
export interface NonCanonicalSpatialReferences {
  readonly rendererNodeId?: string;
  readonly tileId?: string;
  readonly quadtreeCellId?: string;
  readonly navmeshPolygonId?: string;
  readonly providerPlacementId?: string;
  readonly runtimePlacementId?: string;
}

export interface SpatialBinding<D extends SpatialDimensions = SpatialDimensions> {
  readonly identity: CanonicalSpatialIdentity;
  readonly pose: SemanticPose<D>;
  readonly implementationReferences?: NonCanonicalSpatialReferences;
}

export function fixedPoint(value: bigint): FixedPoint {
  return value as FixedPoint;
}

export function validateSpatialFrame<D extends SpatialDimensions>(frame: SpatialFrame<D>): void {
  if (!Number.isSafeInteger(frame.version) || frame.version < 1) {
    throw new DomainValidationError("spatialFrame.version", "must be a positive safe integer");
  }
  if (frame.unit.name.length === 0) {
    throw new DomainValidationError("spatialFrame.unit.name", "must not be empty");
  }
  if (
    !Number.isSafeInteger(frame.unit.fractionalDigits) ||
    frame.unit.fractionalDigits < 0 ||
    frame.unit.fractionalDigits > 18
  ) {
    throw new DomainValidationError(
      "spatialFrame.unit.fractionalDigits",
      "must be an integer from zero through eighteen",
    );
  }

  assertLength(frame.origin, frame.dimensions, "spatialFrame.origin");
  assertLength(frame.gravity.vector, frame.dimensions, "spatialFrame.gravity.vector");
  assertLength(frame.axes.axes, frame.dimensions, "spatialFrame.axes.axes");
  const axisNames = new Set<string>();
  for (const [index, axis] of frame.axes.axes.entries()) {
    if (axis.name.length === 0 || axis.positiveDirection.length === 0) {
      throw new DomainValidationError(`spatialFrame.axes.axes[${index}]`, "must be declared");
    }
    if (axisNames.has(axis.name)) {
      throw new DomainValidationError(`spatialFrame.axes.axes[${index}].name`, "must be unique");
    }
    axisNames.add(axis.name);
  }

  if ((frame.parentFrameId === undefined) !== (frame.parentTransform === undefined)) {
    throw new DomainValidationError(
      "spatialFrame.parentTransform",
      "parent frame and transform must be declared together",
    );
  }
  if (frame.parentFrameId === frame.frameId) {
    throw new DomainValidationError("spatialFrame.parentFrameId", "a frame cannot parent itself");
  }
  if (frame.parentTransform !== undefined) {
    if (!Number.isSafeInteger(frame.parentTransform.version) || frame.parentTransform.version < 1) {
      throw new DomainValidationError(
        "spatialFrame.parentTransform.version",
        "must be a positive safe integer",
      );
    }
    assertLength(
      frame.parentTransform.translation,
      frame.dimensions,
      "spatialFrame.parentTransform.translation",
    );
    assertLength(
      frame.parentTransform.basis,
      frame.dimensions,
      "spatialFrame.parentTransform.basis",
    );
    for (const [index, row] of frame.parentTransform.basis.entries()) {
      assertLength(row, frame.dimensions, `spatialFrame.parentTransform.basis[${index}]`);
    }
  }
}

export function validateSpatialBinding<D extends SpatialDimensions>(
  frame: SpatialFrame<D>,
  binding: SpatialBinding<D>,
): void {
  validateSpatialFrame(frame);
  if (binding.pose.frameId !== frame.frameId || binding.pose.frameVersion !== frame.version) {
    throw new DomainValidationError("spatialBinding.pose", "does not reference the supplied frame");
  }
  assertLength(binding.pose.coordinates, frame.dimensions, "spatialBinding.pose.coordinates");
}

function assertLength(value: readonly unknown[], expected: number, path: string): void {
  if (value.length !== expected) {
    throw new DomainValidationError(path, `expected ${expected} dimensions`);
  }
}
