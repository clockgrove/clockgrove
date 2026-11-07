import type { CommandEnvelope } from "@clockgrove/contracts";
import { z } from "zod";
import {
  containmentSchema,
  materialQuantitySchema,
  resourceSchema,
  spatialTransformSchema,
} from "../components/catalog/index.js";

const objectId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const positive = materialQuantitySchema.refine((value) => value > 0);
const version = z.literal(1);
/** Fixtures cannot introduce needs, schedules, arbitrary scope or location mutations. */
export const fixtureObjectSchema = z
  .strictObject({
    objectId,
    archetypeId: objectId,
    spatial: spatialTransformSchema,
    containment: containmentSchema.optional(),
    resource: resourceSchema.optional(),
  })
  .readonly();
export const CONTAINMENT_PAYLOAD_SCHEMAS = Object.freeze({
  "object.create": z
    .strictObject({ schemaVersion: version, object: fixtureObjectSchema })
    .readonly(),
  "object.retire": z
    .strictObject({ schemaVersion: version, objectId, disposition: z.literal("discard") })
    .readonly(),
  "containment.put": z
    .strictObject({ schemaVersion: version, objectId, containerId: objectId })
    .readonly(),
  "containment.remove": z
    .strictObject({ schemaVersion: version, objectId, containerId: objectId })
    .readonly(),
  "containment.transfer": z
    .strictObject({
      schemaVersion: version,
      objectId,
      fromContainerId: objectId,
      toContainerId: objectId,
    })
    .readonly(),
  "resource.offer": z
    .strictObject({
      schemaVersion: version,
      objectId,
      kind: z.enum(["food", "water"]),
      quantity: positive,
    })
    .readonly(),
  "resource.consume": z
    .strictObject({
      schemaVersion: version,
      objectId,
      kind: z.enum(["food", "water"]),
      quantity: positive,
    })
    .readonly(),
  "resource.transfer": z
    .strictObject({
      schemaVersion: version,
      fromObjectId: objectId,
      toObjectId: objectId,
      kind: z.enum(["food", "water"]),
      quantity: positive,
    })
    .readonly(),
});
export type ContainmentCommandType = keyof typeof CONTAINMENT_PAYLOAD_SCHEMAS;
export type ContainmentPayload<T extends ContainmentCommandType = ContainmentCommandType> = z.infer<
  (typeof CONTAINMENT_PAYLOAD_SCHEMAS)[T]
>;
export type ContainmentCommand = {
  [T in ContainmentCommandType]: CommandEnvelope<T, ContainmentPayload<T>>;
}[ContainmentCommandType];
export const CONTAINMENT_COMMAND_TYPES = Object.freeze(
  Object.keys(CONTAINMENT_PAYLOAD_SCHEMAS) as ContainmentCommandType[],
);
