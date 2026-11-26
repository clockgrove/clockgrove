import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeOpaqueId, type ObjectId, type PrincipalId } from "./ids.js";
import {
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

// Purchase grants: see docs/protocols/usage.md, "Purchase grants". The developer's server reports
// a purchase its own checkout completed; the engine grants it once, journaled as an outside cause.
// No price, currency, balance or payment account is part of either shape.

/** A purchase id: the developer's own checkout or receipt identifier. */
export const PURCHASE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** The most units one purchase grants. */
export const MAX_PURCHASE_QUANTITY = 1_000_000;

export type PurchaseAction = "grant" | "refund";

/**
 * Grant `quantity` of `resourceKind` into the holder `objectId` for the player `principalId`, or
 * refund that grant. A refund repeats the grant's fields.
 */
export interface PurchaseRequest {
  readonly scope: BrowserScope;
  readonly action: PurchaseAction;
  readonly purchaseId: string;
  readonly principalId: PrincipalId;
  readonly objectId: ObjectId;
  readonly resourceKind: "food" | "water";
  readonly quantity: number;
}

function purchaseId(value: unknown, path: string): string {
  const id = string(value, path);
  if (!PURCHASE_ID_PATTERN.test(id))
    throw new ContractDecodeError(path, "1 to 128 of A-Z, a-z, 0-9, '.', '_', ':' or '-'");
  return id;
}

function quantity(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PURCHASE_QUANTITY
  )
    throw new ContractDecodeError(path, `an integer from 1 to ${MAX_PURCHASE_QUANTITY}`);
  return value;
}

export function decodePurchaseRequest(value: unknown): PurchaseRequest {
  const path = "purchase";
  const v = record(value, path);
  exactKeys(
    v,
    [
      "version",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "action",
      "purchaseId",
      "principalId",
      "objectId",
      "resourceKind",
      "quantity",
    ],
    [],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return Object.freeze({
    scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }),
    action: literal(v.action, ["grant", "refund"], `${path}.action`),
    purchaseId: purchaseId(v.purchaseId, `${path}.purchaseId`),
    principalId: decodeOpaqueId(v.principalId, "PrincipalId", `${path}.principalId`),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    resourceKind: literal(v.resourceKind, ["food", "water"], `${path}.resourceKind`),
    quantity: quantity(v.quantity, `${path}.quantity`),
  });
}

/**
 * What the world decided: committed, with the units it moved (a refund removes what is left of the
 * grant, so it may be fewer than granted), or rejected by the world with the kernel's reason.
 */
export type PurchaseReceipt = {
  readonly purchaseId: string;
  readonly action: PurchaseAction;
  readonly commandId: string;
} & (
  | { readonly status: "committed"; readonly revision: string; readonly quantity: number }
  | { readonly status: "rejected"; readonly reason: string }
);

export function decodePurchaseReceipt(value: unknown): PurchaseReceipt {
  const path = "purchaseReceipt";
  const v = record(value, path);
  const status = literal(v.status, ["committed", "rejected"], `${path}.status`);
  const common = {
    purchaseId: purchaseId(v.purchaseId, `${path}.purchaseId`),
    action: literal(v.action, ["grant", "refund"], `${path}.action`),
    commandId: string(v.commandId, `${path}.commandId`),
  };
  const keys = ["purchaseId", "action", "commandId", "status"];
  if (status === "rejected") {
    exactKeys(v, [...keys, "reason"], [], path);
    return Object.freeze({ ...common, status, reason: string(v.reason, `${path}.reason`) });
  }
  exactKeys(v, [...keys, "revision", "quantity"], [], path);
  return Object.freeze({
    ...common,
    status,
    revision: string(v.revision, `${path}.revision`),
    quantity: nonNegativeInteger(v.quantity, `${path}.quantity`),
  });
}
