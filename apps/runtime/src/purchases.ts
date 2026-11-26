import { decodeCanonicalNode, type WorldCommandResult } from "@clockgrove/application";
import {
  type CommandEnvelope,
  decodeOpaqueId,
  type PrincipalId,
  type PurchaseReceipt,
  type PurchaseRequest,
} from "@clockgrove/contracts";
import { purchaseCommandId } from "@clockgrove/domain";
import type { PreparedCommandFields, WorldCommandInput } from "./world-commands.js";

/**
 * The grant a purchase needs (`docs/protocols/usage.md`, "Purchase grants"). It puts material into
 * the world from outside it, so no other grant implies it. A world's owner holds it by default and
 * may delegate it, as `runtime:usage-webhook` and `runtime:mcp-install` (the owner's decision of
 * 2026-11-26); an actor or system identity never qualifies by ownership
 * (`PostgreSqlWorldAuthorizationReader`).
 */
export const PURCHASE_GRANT = "runtime:world-purchase";

/**
 * Whether the caller's identity may grant or refund a purchase at all: an actor or system identity
 * never may, even holding `runtime:world-purchase` explicitly, as `holdsUsageWebhookGrant`.
 */
export function mayHoldPurchaseGrant(
  context: Readonly<{ principalId: string; roles: readonly string[] }>,
): boolean {
  return (
    !context.roles.map(String).includes("actor") &&
    !String(context.principalId).startsWith("system:")
  );
}

/** The purchase commands, which only `POST /v1/runtime/purchases` builds. */
export const PURCHASE_COMMAND_TYPES: readonly string[] = ["purchase.grant", "purchase.refund"];

/** Whether a command ID is in a purchase's namespace, which only the purchase route may use. */
export function isPurchaseCommandId(commandId: string): boolean {
  return commandId.startsWith("purchase:") || commandId.startsWith("purchase-refund:");
}

function commandType(action: PurchaseRequest["action"]): "purchase.grant" | "purchase.refund" {
  return action === "grant" ? "purchase.grant" : "purchase.refund";
}

/** The journal command ID of a purchase's grant or refund: one per purchase id and timeline. */
export function purchaseRequestCommandId(
  action: PurchaseRequest["action"],
  purchaseId: string,
): string {
  return purchaseCommandId(commandType(action), purchaseId);
}

/**
 * The world command a purchase request asks for, built by the server like an Influence intent: the
 * caller (the developer's server) is the effective actor and chooses neither attribution, epochs
 * nor the expected revision, which is the space's when the command is first built.
 * A retry reuses the first attempt's server-chosen fields, so it rebuilds the same accepted bytes.
 */
export function purchaseCommand(
  request: PurchaseRequest,
  action: PurchaseRequest["action"],
  principalId: PrincipalId,
  {
    epochs,
    context: ids,
    issuedAt,
    expectedRevision,
  }: Required<Omit<PreparedCommandFields, "principalId">>,
): WorldCommandInput {
  const { tenantId, worldId, timelineId } = request.scope;
  const commandId = decodeOpaqueId(
    purchaseRequestCommandId(action, request.purchaseId),
    "CommandId",
  );
  const command = {
    schemaVersion: 1,
    commandId,
    type: commandType(action),
    target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
    expected: { partitionRevision: expectedRevision },
    issuedAt,
    context: { version: 1, ...ids },
    attribution: { effectiveActorId: principalId, causalRootActionId: `action-${commandId}` },
    payload: {
      schemaVersion: 1,
      purchaseId: request.purchaseId,
      principalId: request.principalId,
      objectId: request.objectId,
      kind: request.resourceKind,
      quantity: request.quantity,
    },
  } as unknown as CommandEnvelope<string, unknown>;
  return { scope: request.scope, epochs, command };
}

/** What the world decided about a purchase, from its command's own receipt. */
export function purchaseReceipt(
  request: PurchaseRequest,
  result: WorldCommandResult,
): PurchaseReceipt {
  const common = {
    purchaseId: request.purchaseId,
    action: request.action,
    commandId: result.commandId,
  };
  const value = result.value;
  if (value.status === "committed") {
    // The units the kernel event moved: a refund removes what is left, possibly fewer than granted.
    const recorded = result.events[0]?.payload as { kernelEvent?: unknown } | undefined;
    const kernel =
      recorded?.kernelEvent === undefined
        ? undefined
        : (decodeCanonicalNode(recorded.kernelEvent as never) as {
            payload?: { quantity?: unknown };
          });
    const moved = kernel?.payload?.quantity;
    return {
      ...common,
      status: "committed",
      revision: value.revision,
      quantity: typeof moved === "number" ? moved : 0,
    };
  }
  return {
    ...common,
    status: "rejected",
    reason:
      value.status === "denied"
        ? value.reasonCode
        : `${value.refusal.code} at ${value.refusal.path}`,
  };
}
