import type { ObjectId } from "@clockgrove/contracts";
import type { ResourceState } from "../components/catalog/index.js";
import type { WorldEntity } from "../world.js";

export type ContainmentEventData =
  | Readonly<{
      type: "object.created";
      payload: Readonly<{ object: WorldEntity; quantityAdded: number }>;
    }>
  | Readonly<{
      type: "object.retired";
      payload: Readonly<{
        objectId: ObjectId;
        disposition: "discard";
        kind: ResourceState["kind"] | null;
        quantityRemoved: number;
      }>;
    }>
  | Readonly<{
      type: "containment.put" | "containment.removed";
      payload: Readonly<{ objectId: ObjectId; containerId: ObjectId }>;
    }>
  | Readonly<{
      type: "containment.transferred";
      payload: Readonly<{ objectId: ObjectId; fromContainerId: ObjectId; toContainerId: ObjectId }>;
    }>
  | Readonly<{
      type: "resource.offered" | "resource.consumed";
      payload: Readonly<{ objectId: ObjectId; kind: ResourceState["kind"]; quantity: number }>;
    }>
  | Readonly<{
      type: "resource.transferred";
      payload: Readonly<{
        fromObjectId: ObjectId;
        toObjectId: ObjectId;
        kind: ResourceState["kind"];
        quantity: number;
      }>;
    }>;
export const CONTAINMENT_EVENT_TYPES = Object.freeze([
  "object.created",
  "object.retired",
  "containment.put",
  "containment.removed",
  "containment.transferred",
  "resource.offered",
  "resource.consumed",
  "resource.transferred",
] as const);
