import { mcpReadArgumentsHash } from "@clockgrove/application";
import {
  type EffectApprovalAddress,
  type EffectApprovalBinding,
  PostgreSqlEffectApprovals,
  type RecordedEffectApproval,
} from "./postgres-effect-approvals.js";
import {
  type EffectReservation,
  PostgreSqlEffects,
  type RecordedEffect,
} from "./postgres-effects.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export type ApprovedEffectReservation = Extract<EffectReservation, { disposition: "pending" }>;
export interface ApprovedEffectRequest {
  readonly reservation: ApprovedEffectReservation;
  /** Already normalized by trusted capability admission. */
  readonly arguments: unknown;
  readonly approval: EffectApprovalBinding;
}

/** The ledger key durably associates this dispatch with one approval identity. */
export function approvedEffectIdempotencyKey(address: EffectApprovalAddress): string {
  return mcpReadArgumentsHash({
    version: 1,
    kind: "effect_approval",
    tenantId: address.tenantId,
    worldId: address.worldId,
    timelineId: address.timelineId,
    approvalId: address.approvalId,
  });
}

/** Versioned digest of the complete dispatch identity, excluding approval lifecycle metadata. */
export function approvedEffectHash(request: ApprovedEffectReservation): string {
  return mcpReadArgumentsHash({
    version: 1,
    tenantId: request.tenantId,
    worldId: request.worldId,
    timelineId: request.timelineId,
    spaceId: request.spaceId,
    effectId: request.effectId,
    idempotencyKey: request.idempotencyKey,
    actorId: request.actorId,
    principalId: request.principalId,
    runId: request.runId,
    callId: request.callId,
    capabilityId: request.capabilityId,
    grantId: request.grantId,
    policyVersion: request.policyVersion,
    argumentsHash: request.argumentsHash,
    argumentsArtifactId: request.argumentsArtifactId,
    reservedMicrousd: request.reservedMicrousd,
    disposition: request.disposition,
    dispatchId: request.dispatchId,
    eventId: request.eventId,
  });
}

function matches(record: RecordedEffectApproval, binding: EffectApprovalBinding): boolean {
  return (
    record.tenantId === binding.tenantId &&
    record.worldId === binding.worldId &&
    record.timelineId === binding.timelineId &&
    record.approvalId === binding.approvalId &&
    record.spaceId === binding.spaceId &&
    record.effectId === binding.effectId &&
    record.principalId === binding.principalId &&
    record.approverPrincipalId === binding.approverPrincipalId &&
    record.argumentsHash === binding.argumentsHash &&
    record.effectHash === binding.effectHash &&
    record.argumentsArtifactId === binding.argumentsArtifactId &&
    record.expirySeconds === (binding.expirySeconds ?? 600) &&
    record.expiresAt === binding.expiresAt
  );
}

/** Internal persistence composition, not admission: the caller must authenticate the person,
 * authorize current grants, enforce budgets and normalize arguments before entering this port.
 * No model or remote adapter receives this client. */
export class PostgreSqlApprovedEffects {
  constructor(private readonly client: PostgreSqlClient) {}

  async reserve(request: ApprovedEffectRequest): Promise<RecordedEffect> {
    try {
      request = structuredClone(request);
      return await withClientTransaction(this.client, {}, () => this.reserveInTransaction(request));
    } catch {
      throw new Error("Approved effect persistence unavailable");
    }
  }

  /** Caller owns the transaction, including rollback on failure and canonical admission checks. */
  async reserveInTransaction(request: ApprovedEffectRequest): Promise<RecordedEffect> {
    const { reservation: effect, approval, arguments: input } = structuredClone(request);
    if (
      effect.disposition !== "pending" ||
      effect.idempotencyKey !== approvedEffectIdempotencyKey(approval) ||
      effect.argumentsHash !== mcpReadArgumentsHash(input) ||
      approval.effectHash !== approvedEffectHash(effect) ||
      approval.argumentsHash !== effect.argumentsHash ||
      approval.tenantId !== effect.tenantId ||
      approval.worldId !== effect.worldId ||
      approval.timelineId !== effect.timelineId ||
      approval.spaceId !== effect.spaceId ||
      approval.effectId !== effect.effectId ||
      approval.principalId !== effect.principalId ||
      approval.argumentsArtifactId !== effect.argumentsArtifactId
    )
      throw new Error("Approved effect binding conflicts");
    // An absent effect row cannot be locked. A scoped advisory lock also serializes first writers.
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([
        "approved-effect",
        effect.tenantId,
        effect.worldId,
        effect.timelineId,
        effect.effectId,
      ]),
    ]);
    const timeline = await this.client.query(
      "SELECT kind FROM clockgrove.timelines WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3",
      [effect.tenantId, effect.worldId, effect.timelineId],
    );
    if ((timeline.rows[0] as { kind: string } | undefined)?.kind !== "live")
      throw new Error("Approved effect requires live timeline");
    const effects = new PostgreSqlEffects(this.client);
    const existing = await effects.readInTransaction(effect);
    const result = await new PostgreSqlEffectApprovals(this.client).consumeInTransaction(approval);
    if (
      !result.approval ||
      !matches(result.approval, approval) ||
      (existing ? result.consumed || result.approval.state !== "consumed" : !result.consumed)
    )
      throw new Error("Approved effect approval unavailable");
    // reserveInTransaction validates the existing intent and outbox identity even on recovery.
    return effects.reserveInTransaction(effect);
  }
}
