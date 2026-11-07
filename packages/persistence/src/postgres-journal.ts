import type {
  Journal,
  JournalEventReader,
  JournalExecuteRequest,
  JournalExecuteResult,
  JournalOutcomeReader,
  JournalPostCommitNotifier,
  JournalReplayScope,
  JournalRevisionConflictKind,
  RuntimeAuthorizationContext,
  RuntimeFailureClass,
  StoredJournalOutcome,
} from "@clockgrove/application";
import {
  JournalAuthorityDecisionMismatchError,
  JournalEventIdCollisionError,
  JournalPreviewEffectRefusedError,
  JournalRevisionConflictError,
  JournalRouteNotFoundError,
  JournalTimeoutError,
  PartitionStateIntegrityError,
} from "@clockgrove/application";
import type { CommandId } from "@clockgrove/contracts";
import {
  CommandIdempotencyInvariantError,
  decodeActorTargetBinding,
  decodeEventEnvelope,
} from "@clockgrove/contracts";

import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

export type JournalFailureStage =
  | "after-receipt"
  | "after-head-locks"
  | "after-events"
  | "after-dispatches"
  | "after-schedules"
  | "after-state"
  | "before-commit";

export interface PostgreSqlJournalTestHooks {
  /** Test-only server-side fault point. Every listed point is before COMMIT. */
  readonly failureStage?: JournalFailureStage;
  /** Simulates transport loss after COMMIT; its error is deliberately observable. */
  readonly afterCommit?: () => Promise<void>;
}

interface PostgreSqlErrorLike {
  readonly code?: unknown;
  readonly detail?: unknown;
}

export class PostgreSqlJournal implements Journal, JournalOutcomeReader {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly notifier?: JournalPostCommitNotifier,
    private readonly testHooks: PostgreSqlJournalTestHooks = {},
  ) {}

  async execute<TResult>(
    request: JournalExecuteRequest<string, unknown, TResult>,
  ): Promise<JournalExecuteResult<TResult>> {
    let result: JournalExecuteResult<TResult>;
    try {
      result = await withClientTransaction(
        this.client,
        { authorization: request.authorization },
        () => executeJournalStatement<TResult>(this.client, request, this.testHooks.failureStage),
      );
    } catch (error) {
      throw mapDatabaseError(error, request);
    }
    await this.testHooks.afterCommit?.();
    if (this.notifier !== undefined) {
      try {
        await this.notifier.notify(result);
      } catch {
        // Dispatch intent is already canonical; reconciliation owns recovery.
      }
    }
    return result;
  }

  async storedOutcome<TResult>(
    authorization: RuntimeAuthorizationContext,
    commandId: CommandId,
    commandBytes: Uint8Array,
  ): Promise<StoredJournalOutcome<TResult> | undefined> {
    const query = await withClientTransaction(this.client, { authorization }, () =>
      this.client.query(
        `SELECT status, result
           FROM clockgrove.command_receipts
          WHERE tenant_id = $1 AND command_id = $2
            AND command_bytes = $3::bytea
            AND status IN ('committed', 'rejected')`,
        [authorization.tenantId, commandId, commandBytes],
      ),
    );
    const row = query.rows[0];
    if (row === undefined) return undefined;
    const { status } = row as { readonly status?: unknown };
    if (status !== "committed" && status !== "rejected") {
      throw new TypeError("PostgreSQL returned a malformed receipt status");
    }
    return { status, result: decodeResult<TResult>(row) };
  }

  /** The exact accepted bytes of a command ID's receipt in any status, for a server-built retry. */
  async storedCommandBytes(
    authorization: RuntimeAuthorizationContext,
    commandId: CommandId,
  ): Promise<Uint8Array | undefined> {
    const query = await withClientTransaction(this.client, { authorization }, () =>
      this.client.query(
        `SELECT command_bytes
           FROM clockgrove.command_receipts
          WHERE tenant_id = $1 AND command_id = $2`,
        [authorization.tenantId, commandId],
      ),
    );
    const bytes = (query.rows[0] as { readonly command_bytes?: unknown } | undefined)
      ?.command_bytes;
    if (bytes === undefined) return undefined;
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("PostgreSQL returned malformed command bytes");
    return new Uint8Array(bytes);
  }
}

export class PostgreSqlJournalEventReader implements JournalEventReader {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly authorization: import("@clockgrove/application").RuntimeAuthorizationContext,
  ) {}

  async *readEventBytes(scope: JournalReplayScope): AsyncIterable<Uint8Array> {
    const result = await withClientTransaction(
      this.client,
      { authorization: this.authorization },
      () =>
        this.client.query(
          `SELECT event_bytes
             FROM clockgrove.events
            WHERE tenant_id = $1 AND timeline_id = $2
            ORDER BY journal_position`,
          [scope.tenantId, scope.timelineId],
        ),
    );
    for (const value of result.rows) {
      if (typeof value !== "object" || value === null || !("event_bytes" in value)) {
        throw new TypeError("PostgreSQL returned malformed event bytes");
      }
      const bytes = (value as { readonly event_bytes: unknown }).event_bytes;
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("PostgreSQL returned malformed event bytes");
      }
      yield bytes;
    }
  }
}

/** Runs `clockgrove.execute_journal` inside the caller's open, authorized transaction. */
export async function executeJournalStatement<TResult>(
  client: PostgreSqlClient,
  request: JournalExecuteRequest<string, unknown, TResult>,
  failureStage?: JournalFailureStage,
): Promise<JournalExecuteResult<TResult>> {
  const query = await client.query(
    `SELECT clockgrove.execute_journal($1::bytea, $2::jsonb, $3::text) AS result`,
    [request.commandBytes, encodeRequest(request), failureStage ?? null],
  );
  return decodeResult<TResult>(query.rows[0]);
}

/** The JSON request `clockgrove.execute_journal` and `clockgrove.begin_command` read. */
export function encodeRequest<TResult>(
  request: JournalExecuteRequest<string, unknown, TResult>,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify(
    {
      ...extra,
      commandId: request.command.commandId,
      target: request.command.target,
      expected: request.command.expected,
      attribution: request.command.attribution,
      correlationId: request.command.context.correlationId,
      ...(request.command.attribution.immediateCauseId === undefined
        ? {}
        : { causationId: request.command.attribution.immediateCauseId }),
      authorityDecision: request.authorityDecision,
      route: request.route,
      events: request.events,
      dispatches: request.dispatches,
      stableResult: request.stableResult,
      projectionDelta: request.projectionDelta,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

/** Decodes a stored or returned journal result held in the row's `result` column. */
export function decodeResult<TResult>(rowValue: unknown): JournalExecuteResult<TResult> {
  if (typeof rowValue !== "object" || rowValue === null || !("result" in rowValue)) {
    throw new TypeError("PostgreSQL returned a malformed journal result row");
  }
  const raw = (rowValue as { readonly result: unknown }).result;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("PostgreSQL returned a malformed journal result");
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.events) || !("value" in value) || !("projectionDelta" in value)) {
    throw new TypeError("PostgreSQL returned a malformed journal result");
  }
  if ("outcome" in value && value.outcome !== "rejected") {
    throw new TypeError("PostgreSQL returned a malformed journal result");
  }
  return {
    ...(value.outcome === "rejected" ? { outcome: "rejected" as const } : {}),
    value: value.value as TResult,
    projectionDelta: value.projectionDelta,
    events: value.events.map((event, index) => {
      const actorBinding = actorBindingFromEvent(event);
      return decodeEventEnvelope(
        event,
        (payload) => payload,
        actorBinding === undefined ? {} : { actorBinding },
        `journalResult.events[${index}]`,
      );
    }),
  };
}

function actorBindingFromEvent(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.actor !== "object" || event.actor === null || Array.isArray(event.actor)) {
    return undefined;
  }
  const actor = event.actor as Record<string, unknown>;
  return decodeActorTargetBinding({
    tenantId: actor.tenantId,
    worldId: actor.worldId,
    timelineId: actor.timelineId,
    kind: actor.kind,
    id: actor.id,
  });
}

export function mapDatabaseError(error: unknown, request: JournalExecuteRequest): unknown {
  const databaseError = error as PostgreSqlErrorLike;
  const detail = typeof databaseError.detail === "string" ? databaseError.detail : "";
  switch (databaseError.code) {
    case "CG001":
      return new CommandIdempotencyInvariantError(request.command.commandId);
    case "CG002":
      return conflict("stream", detail);
    case "CG003":
      return conflict("partition", detail);
    case "CG004":
      return conflict("routing-epoch", detail);
    case "CG005":
      return new JournalRouteNotFoundError(
        request.route === undefined
          ? `${request.command.target.worldId}/${request.command.target.timelineId}`
          : `${request.command.target.timelineId}/${request.route.partitionId}/${request.route.streamId}`,
      );
    case "CG007":
      return new JournalAuthorityDecisionMismatchError(
        request.authorityDecision.authorityDecisionId,
      );
    // An existing or repeated event ID (CG010), or 23505: `append_command` checks event IDs before
    // it inserts, so a unique violation means another transaction committed the same event ID in
    // between. 23505 is not specific to events: the decision row (its ID derives from the command ID)
    // and the schedule rows (their pending-ID and due-order unique indexes) are uniquely keyed too.
    // They cannot race a different command (the receipt and partition locks serialize them), so a
    // 23505 there is a defect; it also fails closed here, with nothing written.
    case "CG010":
    case "23505":
      return new JournalEventIdCollisionError(request.command.commandId);
    case "CG011":
      return new PartitionStateIntegrityError("schedule-mismatch");
    case "CG012":
      return new JournalPreviewEffectRefusedError(request.command.commandId);
    case "55P03":
      return new JournalTimeoutError("lock");
    case "57014":
      return new JournalTimeoutError("statement");
    case "25P03":
      return new JournalTimeoutError("idle");
    default:
      return error;
  }
}

/**
 * A journal transaction failure's class for logs: from the typed errors `mapDatabaseError` returns,
 * else from the driver's structured SQLSTATE or socket code, never its text. Undefined when the
 * error carries neither. A stale routing or authority epoch is an epoch conflict; every other
 * revision fence (stream, partition, clock policy, owner generation) is a revision conflict.
 */
export function databaseFailureClass(error: unknown): RuntimeFailureClass | undefined {
  if (error instanceof JournalRevisionConflictError)
    return error.kind === "routing-epoch" ? "epoch_conflict" : "revision_conflict";
  if (error instanceof JournalTimeoutError) return `${error.kind}_timeout`;
  if (error instanceof CommandIdempotencyInvariantError) return "idempotency_conflict";
  if (error instanceof PartitionStateIntegrityError) return "integrity";
  const code =
    typeof error === "object" && error !== null ? (error as PostgreSqlErrorLike).code : undefined;
  if (typeof code !== "string") return undefined;
  if (code === "55P03") return "lock_timeout";
  if (code === "57014") return "statement_timeout";
  if (code === "25P03") return "idle_timeout";
  // Class 40, transaction rollback: serialization failure and deadlock; nothing was committed.
  if (code.startsWith("40")) return "serialization_failure";
  // Classes 08 (connection), 53 (insufficient resources), 57 (operator intervention) and sockets.
  if (
    /^(08|53|57)/u.test(code) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(code)
  )
    return "database_unavailable";
  return "internal";
}

function conflict(kind: JournalRevisionConflictKind, detail: string): JournalRevisionConflictError {
  const [expected = "0", actual = "0"] = detail.split(":");
  if (kind === "routing-epoch") {
    return new JournalRevisionConflictError(kind, Number(expected), Number(actual));
  }
  return new JournalRevisionConflictError(kind, BigInt(expected), BigInt(actual));
}
