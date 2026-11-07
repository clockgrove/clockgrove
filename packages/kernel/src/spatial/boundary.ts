import {
  type AnchorGraph,
  DomainValidationError,
  type MovementCommandType,
  type MovementInterruptPayload,
  type MovementRecord,
  type MovementReplanPayload,
  type MovementStartPayload,
  parseAnchorGraph,
  parseMovementPayload,
  parseMovementRecord,
  parseSpatialRegion,
  type SpatialRegion,
} from "@clockgrove/domain";
import { type Refusal, refusal } from "../execute/refusal.js";

export type BoundaryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Refusal }>;

const SAFE_PATH = /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+|\[\d+\])*$/u;

/** The canonical path of a thrown domain validation error; never its free-form message. */
function pathOf(error: unknown): string {
  if (error instanceof DomainValidationError && SAFE_PATH.test(error.path)) return error.path;
  return "input";
}

/**
 * Runs a throwing domain validator and returns its failure as a stable `invalid-input` refusal.
 * Total: nothing the validator throws (including hostile getters or proxies) escapes.
 */
export function guardDomain<T>(validate: () => T): BoundaryResult<T> {
  try {
    return Object.freeze({ ok: true, value: validate() });
  } catch (error) {
    let path = "input";
    try {
      path = pathOf(error);
    } catch {
      path = "input";
    }
    return Object.freeze({ ok: false, error: refusal("invalid-input", path) });
  }
}

export function parseSpatialRegionAtBoundary(value: unknown): BoundaryResult<SpatialRegion> {
  return guardDomain(() => parseSpatialRegion(value));
}

export function parseAnchorGraphAtBoundary(value: unknown): BoundaryResult<AnchorGraph> {
  return guardDomain(() => parseAnchorGraph(value));
}

export function parseMovementRecordAtBoundary(
  value: unknown,
  dimensions: 2 | 3,
): BoundaryResult<MovementRecord> {
  return guardDomain(() => parseMovementRecord(value, dimensions, "movement"));
}

export function parseMovementPayloadAtBoundary(
  type: MovementCommandType,
  value: unknown,
): BoundaryResult<MovementStartPayload | MovementInterruptPayload | MovementReplanPayload> {
  return guardDomain(() => parseMovementPayload(type, value));
}
