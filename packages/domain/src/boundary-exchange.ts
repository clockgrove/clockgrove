import type { ObjectId } from "@clockgrove/contracts";
import { z } from "zod";
import { materialQuantitySchema } from "./components/catalog/index.js";
import { EnvironmentValidationError } from "./environment/environment.js";
import type { WorldBehaviorPolicy, WorldState } from "./world.js";

const name = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
// Decision: reuse the ecology list bound to keep declaration and command validation bounded.
const declaration = z.strictObject({
  id: name,
  name,
  kind: z.enum(["food", "water"]),
  supply: materialQuantitySchema,
  absorb: materialQuantitySchema,
  actorIds: z
    .array(name)
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length),
});
const balance = z.strictObject({
  boundaryId: name,
  supplyRemaining: materialQuantitySchema,
  absorbRemaining: materialQuantitySchema,
});
export type BoundaryExchange = z.infer<typeof declaration>;
export type BoundaryExchangeState = z.infer<typeof balance>;
export interface BoundaryExchangePayload {
  readonly schemaVersion: 1;
  readonly boundaryId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly direction: "import" | "export";
  readonly kind: "food" | "water";
  readonly quantity: number;
}
export type BoundaryExchangeEventData =
  | Readonly<{
      type: "boundary.departed" | "boundary.returned";
      payload: Readonly<{ boundaryId: string; actorId: ObjectId }>;
    }>
  | Readonly<{
      type: "resource.boundary-exchanged";
      payload: Readonly<{
        boundaryId: string;
        boundaryName: string;
        actorId: ObjectId;
        objectId: ObjectId;
        kind: "food" | "water";
        direction: "import" | "export";
        quantity: number;
      }>;
    }>;
function validate(schema: z.ZodType, value: unknown, path: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.map(String).join(".");
    throw new EnvironmentValidationError(at ? `${path}.${at}` : path, "invalid boundary exchange");
  }
}
const declarations = z
  .array(declaration)
  .max(64)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length);
const balances = z
  .array(balance)
  .max(64)
  .refine((entries) => new Set(entries.map((entry) => entry.boundaryId)).size === entries.length);
export function validateBoundaryExchanges(
  value: unknown,
): asserts value is readonly BoundaryExchange[] {
  validate(declarations, value, "policy.boundaryExchanges");
}
export function validateBoundaryExchangeState(
  value: unknown,
): asserts value is readonly BoundaryExchangeState[] {
  validate(balances, value, "state.boundaryExchanges");
}
export function initialBoundaryExchanges(
  entries: readonly BoundaryExchange[],
): readonly BoundaryExchangeState[] {
  return entries.map((entry) => ({
    boundaryId: entry.id,
    supplyRemaining: entry.supply,
    absorbRemaining: entry.absorb,
  }));
}
export function boundaryExchangeDisagreement(
  policy: WorldBehaviorPolicy,
  state: WorldState,
): string | undefined {
  const entries = policy.boundaryExchanges;
  if (entries === undefined)
    return state.boundaryExchanges === undefined ? undefined : "state.boundaryExchanges";
  if (state.boundaryExchanges?.length !== entries.length) return "state.boundaryExchanges";
  for (const [index, entry] of entries.entries()) {
    const cursor = state.boundaryExchanges[index]!;
    if (
      cursor.boundaryId !== entry.id ||
      cursor.supplyRemaining > entry.supply ||
      cursor.absorbRemaining > entry.absorb
    )
      return `state.boundaryExchanges[${index}]`;
    if (
      entry.actorIds.some(
        (id) =>
          !state.entities.some((entity) => entity.objectId === id && entity.needs !== undefined),
      )
    )
      return `policy.boundaryExchanges[${index}].actorIds`;
  }
  return undefined;
}
