import type { ObjectId } from "@clockgrove/contracts";

/**
 * A purchase grant or its refund (issue 329): the developer's server reports a purchase its own
 * checkout completed, and the world journals it as an outside cause. A grant credits `quantity`
 * into the holder; a refund records what it removed, at most what was granted, possibly 0.
 */
export type PurchaseEventData = Readonly<{
  type: "resource.purchase-granted" | "resource.purchase-refunded";
  payload: Readonly<{
    purchaseId: string;
    principalId: string;
    objectId: ObjectId;
    kind: "food" | "water";
    quantity: number;
  }>;
}>;

/** The one journal command ID a purchase's grant or refund may have. */
export function purchaseCommandId(type: "purchase.grant" | "purchase.refund", purchaseId: string) {
  return `${type === "purchase.grant" ? "purchase" : "purchase-refund"}:${purchaseId}`;
}
