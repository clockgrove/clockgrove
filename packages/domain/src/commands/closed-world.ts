import type { ContainmentCommandType } from "./containment-commands.js";

type Refusal = (payload: unknown) => string | undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * Every containment command and whether it can make food or water appear. `null` conserves
 * quantity (moves, consumes, retires, or exchanges through a modelled boundary); a function
 * returns the payload path that creates quantity from nothing. Listing every command forces a
 * decision when the catalog grows.
 */
const CREATES_RESOURCE: Readonly<Record<ContainmentCommandType, Refusal | null>> = {
  "boundary.exchange": null,
  "object.create": (payload) => {
    const quantity = record(record(record(payload)?.object)?.resource)?.quantity;
    return quantity === undefined || quantity === 0
      ? undefined
      : "payload.object.resource.quantity";
  },
  "object.retire": null,
  "containment.put": null,
  "containment.remove": null,
  "containment.transfer": null,
  "resource.offer": () => "payload.quantity",
  "resource.consume": null,
  "resource.transfer": null,
};

/**
 * The closed-world rule: food and water enter a world only through a modelled cause (a
 * boundary exchange, or initial inventory in actor components), never by a command that
 * creates quantity. Returns the payload path of the offending quantity, else undefined.
 */
export function closedWorldRefusal(command: {
  type: string;
  payload: unknown;
}): string | undefined {
  if (!Object.hasOwn(CREATES_RESOURCE, command.type)) return undefined;
  return CREATES_RESOURCE[command.type as ContainmentCommandType]?.(command.payload);
}
