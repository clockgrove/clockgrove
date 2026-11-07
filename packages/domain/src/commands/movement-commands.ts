import type { CommandEnvelope } from "@clockgrove/contracts";

import {
  MOVEMENT_COMMAND_TYPES,
  type MovementCommandType,
  type MovementPayloadFor,
} from "../spatial/movement.js";

export {
  MOVEMENT_COMMAND_TYPES,
  type MovementCommandType,
  type MovementInterruptPayload,
  type MovementReplanPayload,
  type MovementStartPayload,
  parseMovementPayload,
} from "../spatial/movement.js";

export type MovementCommand = {
  [T in MovementCommandType]: CommandEnvelope<T, MovementPayloadFor<T>>;
}[MovementCommandType];

/** Registered movement commands, all at version 1. */
export const MOVEMENT_COMMAND_DEFINITIONS = Object.freeze(
  MOVEMENT_COMMAND_TYPES.map((type) => Object.freeze({ type, version: 1 as const })),
);
