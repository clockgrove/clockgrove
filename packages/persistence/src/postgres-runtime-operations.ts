import {
  dispatchMessage,
  JournalRouteNotFoundError,
  RuntimeActionRateLimitedError,
  type RuntimeAuthorizationContext,
  type RuntimeAuthorizationScope,
  type TimelineClockPolicy,
} from "@clockgrove/application";
import {
  decodeOpaqueId,
  decodePrivacyCategory,
  type PartitionId,
  type QueueEnvelope,
  type SpaceId,
} from "@clockgrove/contracts";
import { DUE_ORDER } from "./postgres-schedules.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";
import { clockPolicyOf, record, text } from "./postgres-world-command.js";

/** A scope's canonical runtime facts as one read under the caller's authority saw them. */
export interface RuntimeStateRecord {
  readonly placement: {
    readonly partitionId: PartitionId;
    readonly spaceId: SpaceId;
    readonly routingEpoch: bigint;
    /** The partition's journal head. */
    readonly journalHead: bigint;
    /** The partition-state projection's kernel revision and the journal head it covers. */
    readonly projectionRevision: bigint;
    readonly coveredHeadSequence: bigint;
  };
  readonly clock: {
    readonly policy: TimelineClockPolicy;
    readonly simulationTime: bigint;
    readonly admittedHorizon: bigint;
    /** The fenced clock owner generation (the alarm generation of the owner that holds it). */
    readonly ownerGeneration: bigint;
    /** The earliest pending schedule deadline, in simulation milliseconds. */
    readonly nextDeadline: bigint | null;
    readonly continuationOpen: boolean;
  };
  /** The accepted catch-up operation and its cursor, when one is open. */
  readonly catchUp: {
    readonly applicationRunId: string;
    readonly step: bigint;
    readonly targetWallTime: bigint;
    readonly ownerGeneration: bigint;
    readonly policyVersion: bigint;
  } | null;
  readonly worldReactions: WorldReactionBacklog;
}

export type DispatchStatus = "pending" | "leased" | "delivered" | "failed";

/** One world-reactions message not yet consumed. Times are epoch milliseconds. */
export interface UnconsumedWorldReaction {
  readonly messageId: string;
  readonly status: DispatchStatus;
  readonly attempts: number;
  readonly lastErrorClass: "retryable" | "permanent" | null;
  readonly createdAt: number;
  /** The due time, or for a leased row its lease expiry. */
  readonly nextAttemptAt: number;
  readonly settledAt: number | null;
  /** Why its last delivery went to the physical DLQ, where the consumer could record it (0031). */
  readonly deadLetter: { readonly failureClass: string; readonly at: number } | null;
}

/**
 * The scope's unresolved world-reactions messages. `redacted` when the caller's ceiling hides
 * `public_scene`, the class every world-reactions dispatch carries: then nothing is counted or listed.
 */
export interface WorldReactionBacklog {
  readonly redacted: boolean;
  /** Null when redacted, so a hidden backlog never reads as an empty one. */
  readonly unconsumed: Readonly<Record<DispatchStatus, number>> | null;
  /** The oldest unconsumed messages, at most `UNCONSUMED_PAGE`. */
  readonly oldest: readonly UnconsumedWorldReaction[];
}

/**
 * Decision: 20 messages, a page an operator reads at once. The counts cover the rest; the oldest come
 * first because they are the ones dead-lettered or failed.
 */
export const UNCONSUMED_PAGE = 20;

const EPOCH_MS = (column: string) =>
  `floor(extract(epoch FROM ${column}) * 1000)::bigint::text AS ${column}`;

function epochMs(row: Readonly<Record<string, unknown>>, key: string): number | null {
  return row[key] === null ? null : Number(text(row, key));
}

/**
 * Read-only: one REPEATABLE READ transaction under the caller's own authority, so row-level security
 * and the privacy ceiling decide what it sees, and it writes nothing.
 */
export class PostgreSqlRuntimeStateReader {
  constructor(private readonly client: PostgreSqlClient) {}

  read(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<RuntimeStateRecord> {
    return withClientTransaction(
      this.client,
      { authorization, begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" },
      async () => {
        const ids = [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId];
        const result = await this.client.query(
          `SELECT head.partition_id, head.space_id, head.routing_epoch::text AS routing_epoch,
                  head.head_sequence::text AS head_sequence, state.revision::text AS revision,
                  state.covered_head_sequence::text AS covered_head_sequence,
                  state.simulation_time::text AS simulation_time,
                  greatest(state.clock_admitted_horizon, state.simulation_time)::text AS horizon,
                  state.clock_owner_generation::text AS owner_generation,
                  state.continuation_command_id IS NOT NULL AS continuation,
                  state.catch_up_run_id, state.catch_up_step::text AS catch_up_step,
                  state.catch_up_wall_time::text AS catch_up_wall_time,
                  state.catch_up_owner_generation::text AS catch_up_owner_generation,
                  state.catch_up_policy_version::text AS catch_up_policy_version,
                  state.clock_policy, birth.clock_policy AS genesis_clock_policy,
                  least(state.next_process_due_at, (SELECT schedule.due_at FROM clockgrove.partition_schedules AS schedule
                    WHERE schedule.tenant_id = state.tenant_id
                      AND schedule.timeline_id = state.timeline_id
                      AND schedule.partition_id = state.partition_id
                      AND schedule.status = 'pending'
                    ORDER BY ${DUE_ORDER} LIMIT 1))::text AS next_due_at
             FROM clockgrove.timeline_partitions AS head
             JOIN clockgrove.partition_states AS state
               USING (tenant_id, world_id, timeline_id, partition_id, space_id)
             JOIN clockgrove_birth.world_birth_states AS birth USING (tenant_id, world_id, timeline_id)
            WHERE head.tenant_id = $1 AND head.world_id = $2 AND head.timeline_id = $3
              AND head.space_id = $4`,
          ids,
        );
        if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
        const row = record(result.rows[0], "runtime state");
        const nextDue = row.next_due_at;
        return {
          placement: {
            partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
            spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
            routingEpoch: BigInt(text(row, "routing_epoch")),
            journalHead: BigInt(text(row, "head_sequence")),
            projectionRevision: BigInt(text(row, "revision")),
            coveredHeadSequence: BigInt(text(row, "covered_head_sequence")),
          },
          clock: {
            policy: clockPolicyOf(row),
            simulationTime: BigInt(text(row, "simulation_time")),
            admittedHorizon: BigInt(text(row, "horizon")),
            ownerGeneration: BigInt(text(row, "owner_generation")),
            nextDeadline: typeof nextDue === "string" ? BigInt(nextDue) : null,
            continuationOpen: row.continuation === true,
          },
          catchUp:
            row.catch_up_run_id === null
              ? null
              : {
                  applicationRunId: text(row, "catch_up_run_id"),
                  step: BigInt(text(row, "catch_up_step")),
                  targetWallTime: BigInt(text(row, "catch_up_wall_time")),
                  ownerGeneration: BigInt(text(row, "catch_up_owner_generation")),
                  policyVersion: BigInt(text(row, "catch_up_policy_version")),
                },
          worldReactions: await this.worldReactions(authorization, ids),
        };
      },
    );
  }

  /** Reads only the unconsumed rows, through the partial index of 0031. */
  private async worldReactions(
    authorization: RuntimeAuthorizationContext,
    ids: readonly string[],
  ): Promise<WorldReactionBacklog> {
    if (!authorization.privacyCeiling.allowedCategories.includes("public_scene"))
      return { redacted: true, unconsumed: null, oldest: [] };
    const unconsumed = { pending: 0, leased: 0, delivered: 0, failed: 0 };
    const scope = `tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
       AND channel = 'world-reactions' AND consumed_at IS NULL`;
    const counts = await this.client.query(
      `SELECT status, count(*)::text AS count FROM clockgrove.event_dispatches
        WHERE ${scope} GROUP BY status`,
      [...ids],
    );
    for (const value of counts.rows) {
      const row = record(value, "dispatch count");
      unconsumed[text(row, "status") as DispatchStatus] = Number(text(row, "count"));
    }
    const oldest = await this.client.query(
      `SELECT dispatch_id, status, attempts, last_error_class, dead_letter_class,
              ${EPOCH_MS("created_at")}, ${EPOCH_MS("next_attempt_at")}, ${EPOCH_MS("settled_at")},
              ${EPOCH_MS("dead_lettered_at")}
         FROM clockgrove.event_dispatches WHERE ${scope}
        ORDER BY created_at, dispatch_id LIMIT ${UNCONSUMED_PAGE}`,
      [...ids],
    );
    return {
      redacted: false,
      unconsumed,
      oldest: oldest.rows.map((value) => {
        const row = record(value, "unconsumed dispatch");
        const deadLetteredAt = epochMs(row, "dead_lettered_at");
        return {
          messageId: text(row, "dispatch_id"),
          status: text(row, "status") as DispatchStatus,
          attempts: Number(row.attempts),
          lastErrorClass: row.last_error_class as UnconsumedWorldReaction["lastErrorClass"],
          createdAt: Number(text(row, "created_at")),
          nextAttemptAt: Number(text(row, "next_attempt_at")),
          settledAt: epochMs(row, "settled_at"),
          deadLetter:
            deadLetteredAt === null
              ? null
              : { failureClass: text(row, "dead_letter_class"), at: deadLetteredAt },
        };
      }),
    };
  }
}

export type RuntimeOperatorAction = "repair-publication" | "replay-message";

/** What an authorized action did; `failed` is a server failure, recorded after the rollback. */
export type RuntimeOperatorActionOutcome =
  | "repaired"
  | "replayed"
  | "not-found"
  | "not-failed"
  | "not-published"
  | "failed";

export type RuntimeOperatorActionDenial =
  | "world-participation-absent"
  | "runtime-grant-missing"
  | "authority-mismatch";

export interface RuntimeOperatorActionTarget {
  readonly scope: RuntimeAuthorizationScope;
  readonly action: RuntimeOperatorAction;
  /** The world-reactions message's semantic ID: its dispatch ID. */
  readonly messageId: string;
}

/**
 * The two operator actions on world-reactions messages (0031). Each runs in one transaction under
 * the caller's authority and appends its audit row to `runtime_operator_actions` in that same
 * transaction, so no action changes anything without its row. Repair changes only the dispatch row's
 * status and lease fields; replay only sends the message again. Both enforce the per-principal limit
 * with `RuntimeActionRateLimitedError`.
 */
export class PostgreSqlRuntimeOperatorActions {
  constructor(private readonly client: PostgreSqlClient) {}

  /** Refuses a tenant member over the limit before anything is read or changed. */
  async admit(authorization: RuntimeAuthorizationContext): Promise<void> {
    const admitted = await withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.runtime_operator_action_admitted() AS admitted",
      );
      return (result.rows[0] as { admitted?: unknown } | undefined)?.admitted;
    });
    if (admitted !== true) throw new RuntimeActionRateLimitedError();
  }

  /** Returns a `failed` publication in the scope to `pending` (repair_world_reaction_publication). */
  repair(
    authorization: RuntimeAuthorizationContext,
    target: RuntimeOperatorActionTarget,
  ): Promise<RuntimeOperatorActionOutcome> {
    return this.audited(authorization, target, async () => {
      const { worldId, timelineId, spaceId } = target.scope;
      const result = await this.client.query(
        "SELECT clockgrove.repair_world_reaction_publication($1, $2, $3, $4) AS outcome",
        [worldId, timelineId, spaceId, target.messageId],
      );
      return text(record(result.rows[0], "repair"), "outcome") as RuntimeOperatorActionOutcome;
    });
  }

  /**
   * Sends a published message in the scope through its source Queue again: the canonical envelope
   * its publisher sent, under its original message ID, rebuilt from the dispatch row and its source
   * event, never from caller bytes. The audit row is written first, so the rate limit refuses before
   * anything is sent; a failed send rolls it back and is recorded as `failed`.
   */
  replay(
    authorization: RuntimeAuthorizationContext,
    target: RuntimeOperatorActionTarget,
    send: (message: QueueEnvelope<unknown>) => Promise<void>,
  ): Promise<RuntimeOperatorActionOutcome> {
    return this.audited(authorization, target, async (recordOutcome) => {
      const { tenantId, worldId, timelineId, spaceId } = target.scope;
      const result = await this.client.query(
        `SELECT dispatch.event_id, dispatch.attempts, dispatch.privacy_class, dispatch.payload,
                dispatch.status = 'delivered' OR dispatch.consumed_at IS NOT NULL AS published,
                event.correlation_id
           FROM clockgrove.event_dispatches AS dispatch
           JOIN clockgrove.events AS event
             ON event.tenant_id = dispatch.tenant_id AND event.event_id = dispatch.event_id
          WHERE dispatch.tenant_id = $1 AND dispatch.dispatch_id = $2
            AND dispatch.channel = 'world-reactions' AND dispatch.world_id = $3
            AND dispatch.timeline_id = $4 AND dispatch.space_id = $5`,
        [tenantId, target.messageId, worldId, timelineId, spaceId],
      );
      const row = result.rows[0] === undefined ? undefined : record(result.rows[0], "replay");
      const outcome =
        row === undefined ? "not-found" : row.published === true ? "replayed" : "not-published";
      await recordOutcome(outcome);
      if (row !== undefined && outcome === "replayed")
        await send(
          dispatchMessage({
            tenantId,
            worldId,
            timelineId,
            dispatchId: target.messageId,
            eventId: decodeOpaqueId(row.event_id, "EventId"),
            channel: "world-reactions",
            attempt: Number(row.attempts),
            privacyClass: decodePrivacyCategory(row.privacy_class),
            payload: row.payload,
            correlationId: decodeOpaqueId(row.correlation_id, "CorrelationId"),
          }),
        );
      return outcome;
    });
  }

  /** Records a refused action under the requested tenant, as the inspector records a denial. */
  deny(
    authorization: RuntimeAuthorizationContext,
    target: RuntimeOperatorActionTarget,
    reason: RuntimeOperatorActionDenial,
  ): Promise<void> {
    return this.rateLimited(() =>
      withClientTransaction(this.client, { authorization }, () =>
        this.record(target, "deny", reason),
      ),
    );
  }

  /**
   * One transaction: `operation` decides and records its outcome (repair inside its function, replay
   * through `recordOutcome`). A failure rolls it back and is recorded as `failed` on its own.
   */
  private async audited(
    authorization: RuntimeAuthorizationContext,
    target: RuntimeOperatorActionTarget,
    operation: (
      recordOutcome: (outcome: RuntimeOperatorActionOutcome) => Promise<void>,
    ) => Promise<RuntimeOperatorActionOutcome>,
  ): Promise<RuntimeOperatorActionOutcome> {
    try {
      return await this.rateLimited(() =>
        withClientTransaction(this.client, { authorization }, () =>
          operation((outcome) => this.record(target, "allow", outcome)),
        ),
      );
    } catch (error) {
      // Nothing changed: the transaction rolled back. The failure is still audited when PostgreSQL
      // allows; the original error is what the caller sees either way.
      if (!(error instanceof RuntimeActionRateLimitedError))
        await withClientTransaction(this.client, { authorization }, () =>
          this.record(target, "allow", "failed"),
        ).catch(() => undefined);
      throw error;
    }
  }

  private async record(
    target: RuntimeOperatorActionTarget,
    decision: "allow" | "deny",
    reason: RuntimeOperatorActionOutcome | RuntimeOperatorActionDenial,
  ): Promise<void> {
    const { worldId, timelineId, spaceId } = target.scope;
    await this.client.query(
      "SELECT clockgrove.record_runtime_operator_action($1, $2, $3, $4, $5, $6, $7)",
      [worldId, timelineId, spaceId, target.action, target.messageId, decision, reason],
    );
  }

  private async rateLimited<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if ((error as { code?: unknown }).code === "CG013") throw new RuntimeActionRateLimitedError();
      throw error;
    }
  }
}
