import type {
  ClaimedDispatch,
  DispatchClaimRequest,
  DispatchSettlement,
  DispatchStore,
  RuntimeAuthorizationContext,
  RuntimeMetrics,
} from "@clockgrove/application";
import { NO_METRICS, recordMetric } from "@clockgrove/application";
import type { QueueChannel, QueueEnvelope, TenantId } from "@clockgrove/contracts";
import { decodeOpaqueId, decodePrivacyCategory, QUEUE_CHANNELS } from "@clockgrove/contracts";

import type { PostgreSqlClient } from "./postgres-transaction.js";
import { installAuthorization, withClientTransaction } from "./postgres-transaction.js";

import { record, text } from "./postgres-world-command.js";

/** The largest batch one claim may lease, and the longest lease or retry delay (one day). */
const MAX_CLAIM_LIMIT = 1_000;
const MAX_DELAY_MS = 86_400_000;
/** PostgreSQL `integer`. */
const MAX_ATTEMPT = 2_147_483_647;

export type WorldReactionConsumption = "consumed" | "duplicate" | "invalid";

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function decodeClaim(value: unknown): ClaimedDispatch {
  const row = record(value, "dispatch claim");
  const channel = text(row, "channel");
  if (!(QUEUE_CHANNELS as readonly string[]).includes(channel)) {
    throw new TypeError("PostgreSQL returned a malformed channel");
  }
  const attempt = row.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("PostgreSQL returned a malformed attempt");
  }
  return {
    tenantId: decodeOpaqueId(text(row, "tenant_id"), "TenantId"),
    worldId: decodeOpaqueId(text(row, "world_id"), "WorldId"),
    timelineId: decodeOpaqueId(text(row, "timeline_id"), "TimelineId"),
    dispatchId: text(row, "dispatch_id"),
    eventId: decodeOpaqueId(text(row, "event_id"), "EventId"),
    channel: channel as QueueChannel,
    attempt,
    privacyClass: decodePrivacyCategory(row.privacy_class),
    payload: row.payload,
    correlationId: decodeOpaqueId(text(row, "correlation_id"), "CorrelationId"),
  };
}

/**
 * Claims and settles dispatch rows through `clockgrove.claim_dispatches` and
 * `clockgrove.settle_dispatch` (migration 0009). Each call is its own short authorized transaction;
 * the functions see only the installed tenant's rows within the installed privacy ceiling.
 */
export class PostgreSqlDispatchStore implements DispatchStore {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly metrics: RuntimeMetrics = NO_METRICS,
  ) {}

  /** Background authority is derived from due canonical dispatches, never a tenant member. */
  async listDueWorldReactionAuthorizations(
    tenantId?: TenantId,
  ): Promise<readonly RuntimeAuthorizationContext[]> {
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT tenant_id, principal_id FROM clockgrove.due_world_reaction_principals($1, $2)`,
        [tenantId ?? null, MAX_CLAIM_LIMIT],
      );
      return result.rows.map((value) => {
        const row = record(value, "dispatch authority");
        return {
          tenantId: decodeOpaqueId(row.tenant_id, "TenantId"),
          principalId: decodeOpaqueId(row.principal_id, "PrincipalId"),
          privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
        };
      });
    });
  }

  /** Verify and durably disposition one committed command batch; transport attempts are ignored. */
  async consumeWorldReaction(message: QueueEnvelope<unknown>): Promise<WorldReactionConsumption> {
    return withClientTransaction(this.client, {}, async () => {
      const resolved = await this.client.query(
        `SELECT clockgrove.world_reaction_principal($1, $2) AS principal_id`,
        [message.tenantId, message.messageId],
      );
      const principal = record(resolved.rows[0], "dispatch authority").principal_id;
      if (principal === null) return "invalid";
      await installAuthorization(this.client, {
        tenantId: message.tenantId,
        principalId: decodeOpaqueId(principal, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
      });
      const result = await this.client.query(
        `SELECT clockgrove.consume_world_reaction($1::jsonb) AS disposition`,
        [JSON.stringify(message)],
      );
      const disposition = record(result.rows[0], "consumption disposition").disposition;
      if (disposition !== "consumed" && disposition !== "duplicate" && disposition !== "invalid") {
        throw new TypeError("PostgreSQL returned an invalid consumption disposition");
      }
      return disposition;
    });
  }

  /**
   * Records why a message's last delivery attempt failed on its source dispatch, through
   * `record_world_reaction_dead_letter` (0031). False when its identity names no world-reactions
   * dispatch. Diagnostic only: publication and consumption stay as they are.
   */
  async recordWorldReactionDeadLetter(
    tenantId: string,
    messageId: string,
    failureClass: "malformed" | "inconsistent" | "transient" | "internal",
  ): Promise<boolean> {
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT clockgrove.record_world_reaction_dead_letter($1, $2, $3) AS marked`,
        [tenantId, messageId, failureClass],
      );
      return record(result.rows[0], "dead letter").marked === true;
    });
  }

  async claim(request: DispatchClaimRequest): Promise<readonly ClaimedDispatch[]> {
    const limit = boundedInteger(request.limit, 1, MAX_CLAIM_LIMIT, "limit");
    const leaseMs = boundedInteger(request.leaseMs, 0, MAX_DELAY_MS, "leaseMs");
    if (request.leaseOwner === "") throw new RangeError("leaseOwner must not be empty");
    const { claims, worlds } = await this.transaction(request.authorization, async () => {
      const result = await this.client.query(
        `SELECT tenant_id, world_id, timeline_id, dispatch_id, event_id, channel, attempt,
                privacy_class, payload, correlation_id, backlog_age_ms::text
           FROM clockgrove.claim_dispatches($1::text, $2::integer, $3::text, $4::integer)`,
        [request.channel, limit, request.leaseOwner, leaseMs],
      );
      const claims = result.rows.map(decodeClaim);
      // Per world, the oldest claimed dispatch's age since it was enqueued is its backlog age.
      const worlds = new Map<string, { age: number; count: number }>();
      claims.forEach(({ worldId }, index) => {
        const age = Number(text(record(result.rows[index], "dispatch claim"), "backlog_age_ms"));
        const seen = worlds.get(worldId);
        worlds.set(worldId, { age: Math.max(age, seen?.age ?? 0), count: (seen?.count ?? 0) + 1 });
      });
      return { claims, worlds };
    });
    // Recorded only after the claim committed.
    for (const [worldId, { age, count }] of worlds)
      recordMetric(this.metrics, {
        name: "dispatch_backlog_age_ms",
        tenantId: request.authorization.tenantId,
        worldId,
        label: request.channel,
        value: age,
        count,
      });
    return claims;
  }

  async settle(
    authorization: RuntimeAuthorizationContext,
    settlement: DispatchSettlement,
  ): Promise<boolean> {
    const retryAfterMs =
      settlement.outcome === "retry"
        ? boundedInteger(settlement.retryAfterMs, 0, MAX_DELAY_MS, "retryAfterMs")
        : null;
    const attempt = boundedInteger(settlement.attempt, 1, MAX_ATTEMPT, "attempt");
    const errorClass = settlement.outcome === "delivered" ? null : settlement.errorClass;
    return this.transaction(authorization, async () => {
      const result = await this.client.query(
        `SELECT clockgrove.settle_dispatch($1::text, $2::integer, $3::text, $4::text, $5::integer)
                AS settled`,
        [settlement.dispatchId, attempt, settlement.outcome, errorClass, retryAfterMs],
      );
      return record(result.rows[0], "dispatch settlement").settled === true;
    });
  }

  private async transaction<T>(
    authorization: RuntimeAuthorizationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withClientTransaction(this.client, { authorization }, operation);
  }
}
