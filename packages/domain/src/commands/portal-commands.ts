import type { CommandEnvelope, ObjectId } from "@clockgrove/contracts";

import { exactRecord, positiveFixed, text, time } from "../spatial/parse.js";
import type { FixedPoint } from "../spatial.js";

/** `portal.open` and `portal.close`: change the state of the object carrying the Portal. */
export interface PortalTogglePayload {
  readonly schemaVersion: 1;
  readonly portalId: ObjectId;
}

/**
 * `portal.use`: an explicit pass-through. The actor, standing on an anchor the open portal
 * joins, moves through the portal to the anchor on its other side.
 */
export interface PortalUsePayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly portalId: ObjectId;
  readonly unitsPerSecond: FixedPoint;
  readonly observeUntil?: bigint;
}

export const PORTAL_COMMAND_TYPES = Object.freeze([
  "portal.close",
  "portal.open",
  "portal.use",
] as const);
export type PortalCommandType = (typeof PORTAL_COMMAND_TYPES)[number];
export type PortalPayloadFor<T extends PortalCommandType> = T extends "portal.use"
  ? PortalUsePayload
  : PortalTogglePayload;

export type PortalCommand = {
  [T in PortalCommandType]: CommandEnvelope<T, PortalPayloadFor<T>>;
}[PortalCommandType];

/** Registered portal commands, all at version 1. */
export const PORTAL_COMMAND_DEFINITIONS = Object.freeze(
  PORTAL_COMMAND_TYPES.map((type) => Object.freeze({ type, version: 1 as const })),
);

/** Validates an untrusted portal command payload; throws DomainValidationError. */
export function parsePortalPayload(
  type: PortalCommandType,
  value: unknown,
): PortalTogglePayload | PortalUsePayload {
  if (type !== "portal.use") {
    const body = exactRecord(value, "payload", ["schemaVersion", "portalId"]);
    return { schemaVersion: 1, portalId: text(body.portalId, "payload.portalId") as ObjectId };
  }
  const body = exactRecord(
    value,
    "payload",
    ["schemaVersion", "objectId", "portalId", "unitsPerSecond"],
    ["observeUntil"],
  );
  return {
    schemaVersion: 1,
    objectId: text(body.objectId, "payload.objectId") as ObjectId,
    portalId: text(body.portalId, "payload.portalId") as ObjectId,
    unitsPerSecond: positiveFixed(body.unitsPerSecond, "payload.unitsPerSecond"),
    ...(body.observeUntil === undefined
      ? {}
      : { observeUntil: time(body.observeUntil, "payload.observeUntil") }),
  };
}
