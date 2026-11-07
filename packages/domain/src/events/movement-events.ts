import type { ObjectId } from "@clockgrove/contracts";
import type { MovementRecord } from "../spatial/movement.js";
import type { FixedPoint } from "../spatial.js";

/** Semantic movement events. Every event's `simulationTime` is the exact time it describes. */
export type MovementEventData =
  | Readonly<{
      type: "movement.started";
      payload: Readonly<{ objectId: ObjectId; movement: MovementRecord }>;
    }>
  | Readonly<{
      type: "movement.region-entered" | "movement.region-exited";
      payload: Readonly<{
        objectId: ObjectId;
        movementId: string;
        regionId: string;
        regionVersion: number;
      }>;
    }>
  | Readonly<{
      /**
       * The object stayed inside a region with a dwell for its whole duration after entering it at
       * `enteredAt`: the keyed remain-in-region schedule came due (simulation time = enteredAt + dwell).
       */
      type: "movement.region-remained";
      payload: Readonly<{
        objectId: ObjectId;
        regionId: string;
        regionVersion: number;
        enteredAt: bigint;
      }>;
    }>
  | Readonly<{
      /** The mover reached the far endpoint of an open portal on its route. */
      type: "movement.portal-crossed";
      payload: Readonly<{ objectId: ObjectId; movementId: string; portalId: ObjectId }>;
    }>
  | Readonly<{
      type: "movement.interrupted";
      payload: Readonly<{
        objectId: ObjectId;
        movementId: string;
        position: readonly FixedPoint[];
      }>;
    }>
  | Readonly<{
      type: "movement.replanned";
      payload: Readonly<{
        objectId: ObjectId;
        priorMovementId: string;
        position: readonly FixedPoint[];
        movement: MovementRecord;
      }>;
    }>
  | Readonly<{
      type: "movement.completed";
      payload: Readonly<{ objectId: ObjectId; movementId: string }>;
    }>;

export const MOVEMENT_EVENT_TYPES = Object.freeze([
  "movement.started",
  "movement.region-entered",
  "movement.region-exited",
  "movement.region-remained",
  "movement.portal-crossed",
  "movement.interrupted",
  "movement.replanned",
  "movement.completed",
] as const);
