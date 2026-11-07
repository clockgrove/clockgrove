import type { SimTimeMs } from "@clockgrove/contracts";
import {
  expectedCrossings,
  type MovementRecord,
  movementCompletionTime,
  type SpatialRegion,
} from "@clockgrove/domain";
import type { ContinuousSystem } from "../../scheduler/catch-up.js";

export const MOVEMENT_SYSTEM_VERSION = 1;
export const MOVEMENT_THRESHOLD = "movement";

export function movementSystemKind(objectId: string): string {
  return `movement:${objectId}`;
}

/**
 * The continuous system of one actor's active routine movement. It carries no numeric state: its
 * thresholds are the movement's region crossings and completion, derived from the immutable
 * record with the domain's `expectedCrossings` and `movementCompletionTime`.
 */
export function createMovementSystem(
  objectId: string,
  movement: MovementRecord,
  regions: readonly SpatialRegion[],
): ContinuousSystem {
  const times = [
    ...new Set([
      ...expectedCrossings(movement, regions).map((crossing) => crossing.time),
      movementCompletionTime(movement.segment),
    ]),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const system: ContinuousSystem = {
    kind: movementSystemKind(objectId),
    version: MOVEMENT_SYSTEM_VERSION,
    integrate: (state) => state,
    nextThreshold: (_state, at) => {
      const time = times.find((candidate) => candidate > at);
      return time === undefined
        ? null
        : Object.freeze({ name: MOVEMENT_THRESHOLD, time: time as SimTimeMs });
    },
  };
  return Object.freeze(system);
}
