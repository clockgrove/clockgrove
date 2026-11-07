import type { ObjectId } from "@clockgrove/contracts";

/** A portal's open or closed state changed; `portalId` is the object carrying the Portal component. */
export type PortalEventData = Readonly<{
  type: "portal.opened" | "portal.closed";
  payload: Readonly<{ portalId: ObjectId }>;
}>;

export const PORTAL_EVENT_TYPES = Object.freeze(["portal.opened", "portal.closed"] as const);
