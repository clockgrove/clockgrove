import {
  type AuthorizedPersistenceTransaction,
  type CommandLinkRows,
  continuationIdPrefix,
  type InspectedDispatch,
  type InspectedEventOrigin,
  type InspectedSchedule,
  type PersistenceTransactionPort,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import type {
  AuthorityDecision,
  AuthorityDecisionId,
  CommandId,
  CommandReceipt,
  EventId,
  SpaceId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";
import {
  decodeActorTargetBinding,
  decodeAuthorityDecision,
  decodeCommandReceipt,
  decodeOpaqueId,
} from "@clockgrove/contracts";

/** Adapter-local structural boundary; provider client types do not leak inward. */
export interface PostgreSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * Thrown when a transaction starts on a client that already has one in flight. One connection runs
 * one transaction: a second caller's statements and authorization settings would land inside the
 * first caller's transaction. Give each request its own client.
 */
export class ConcurrentClientTransactionError extends Error {
  override readonly name = "ConcurrentClientTransactionError";
  constructor() {
    super("PostgreSQL client already has a transaction in flight; use one client per request");
  }
}

const inFlight = new WeakSet<PostgreSqlClient>();

export interface ClientTransactionOptions {
  /** Installed as transaction-local settings right after BEGIN. */
  readonly authorization?: RuntimeAuthorizationContext;
  /** The opening statement, for an isolation level or access mode. */
  readonly begin?: string;
}

/**
 * Every adapter transaction goes through here. It refuses, before sending anything, to start while
 * the same client has a transaction open, and rolls back anything that does not commit.
 */
export async function withClientTransaction<T>(
  client: PostgreSqlClient,
  options: ClientTransactionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (inFlight.has(client)) throw new ConcurrentClientTransactionError();
  inFlight.add(client);
  let committed = false;
  try {
    await client.query(options.begin ?? "BEGIN");
    if (options.authorization !== undefined) {
      await installAuthorization(client, options.authorization);
    }
    const value = await operation();
    await client.query("COMMIT");
    committed = true;
    return value;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    inFlight.delete(client);
  }
}

export async function installAuthorization(
  client: PostgreSqlClient,
  authorization: RuntimeAuthorizationContext,
): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [authorization.tenantId]);
  await client.query("SELECT set_config('app.principal_id', $1, true)", [
    authorization.principalId,
  ]);
  await client.query("SELECT set_config('app.privacy_ceiling', $1, true)", [
    JSON.stringify(authorization.privacyCeiling),
  ]);
}

export class PostgreSqlPersistenceTransactionPort implements PersistenceTransactionPort {
  constructor(private readonly client: PostgreSqlClient) {}

  withAuthorization<TResult>(
    authorization: RuntimeAuthorizationContext,
    operation: (transaction: AuthorizedPersistenceTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return withClientTransaction(this.client, { authorization }, () =>
      operation(new PostgreSqlAuthorizedTransaction(this.client, authorization)),
    );
  }
}

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

class PostgreSqlAuthorizedTransaction implements AuthorizedPersistenceTransaction {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly authorization: RuntimeAuthorizationContext,
  ) {}

  async getCommandReceipt(commandId: CommandId): Promise<CommandReceipt | undefined> {
    const result = await this.client.query(
      `SELECT provenance, tenant_id, command_id, request_hash, status, target_address,
              attribution, action_id, correlation_id, causation_id, expected,
              authority_decision_id, canonical_event_ids, result,
              to_char(created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS created_at,
              to_char(committed_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS committed_at,
              to_char(failed_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS failed_at
         FROM clockgrove.command_receipts
        WHERE tenant_id = $1 AND command_id = $2`,
      [this.authorization.tenantId, commandId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeReceiptRow(row);
  }

  async getAuthorityDecision(
    authorityDecisionId: AuthorityDecisionId,
  ): Promise<AuthorityDecision | undefined> {
    const result = await this.client.query(
      `SELECT authority_decision_id, outcome, tenant_id, world_id, timeline_id, command_id,
              action_id, attribution, inputs, reason_code,
              to_char(decided_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS decided_at
         FROM clockgrove.authority_decisions
        WHERE tenant_id = $1 AND authority_decision_id = $2`,
      [this.authorization.tenantId, authorityDecisionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeDecisionRow(row);
  }

  /**
   * Each query names the installed tenant so it uses its tenant-leading index; RLS still filters
   * tenant and privacy class. Schedules are a primary-key prefix scan of one timeline, and chunk
   * children a scan of the tenant's receipts; neither has an index (no Wave 2 reader measures one).
   */
  async getCommandLinks(commandId: CommandId, timelineId: TimelineId): Promise<CommandLinkRows> {
    const tenantId = this.authorization.tenantId;
    const routed = await this.client.query(
      `SELECT routed_space_id FROM clockgrove.command_receipts WHERE tenant_id = $1 AND command_id = $2`,
      [tenantId, commandId],
    );
    const routedSpace = routed.rows[0] && columns(routed.rows[0], "routed space").routed_space_id;
    const spans = await this.client.query(
      `SELECT timeline_id, partition_id, space_id, min(partition_sequence)::text AS first,
              max(partition_sequence)::text AS last
         FROM clockgrove.events WHERE tenant_id = $1 AND command_id = $2
        GROUP BY timeline_id, partition_id, space_id`,
      [tenantId, commandId],
    );
    if (spans.rows.length > 1) throw new TypeError("a command's events span one partition");
    const span = spans.rows[0] === undefined ? undefined : columns(spans.rows[0], "event span");
    const schedules = await this.client.query(
      `SELECT schedule_id, idempotency_key, kind, due_at::text AS due_at, status,
              scheduled_by_command_id, completed_by_command_id
         FROM clockgrove.partition_schedules
        WHERE tenant_id = $1 AND timeline_id = $2
          AND $3 IN (scheduled_by_command_id, completed_by_command_id)
        ORDER BY due_at, schedule_id, idempotency_key`,
      [tenantId, timelineId, commandId],
    );
    const dispatches = await this.client.query(
      `SELECT dispatch.dispatch_id, dispatch.event_id, dispatch.channel, dispatch.status,
              dispatch.attempts, dispatch.last_error_class,
              to_char(dispatch.settled_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS settled_at
         FROM clockgrove.events AS event
         JOIN clockgrove.event_dispatches AS dispatch USING (tenant_id, event_id)
        WHERE event.tenant_id = $1 AND event.command_id = $2
        ORDER BY event.partition_sequence, dispatch.channel`,
      [tenantId, commandId],
    );
    // Chunk IDs are trusted (clients cannot use the namespace) and numbered from 1 without gaps, so
    // the walk is one primary-key lookup per chunk.
    const chunks = await this.client.query(
      `WITH RECURSIVE chunk (n, command_id) AS (
         SELECT 1, receipt.command_id FROM clockgrove.command_receipts AS receipt
          WHERE receipt.tenant_id = $1 AND receipt.command_id = $2 || '1'
         UNION ALL
         SELECT chunk.n + 1, receipt.command_id
           FROM chunk JOIN clockgrove.command_receipts AS receipt
             ON receipt.tenant_id = $1 AND receipt.command_id = $2 || (chunk.n + 1)::text
       )
       SELECT command_id FROM chunk ORDER BY n`,
      [tenantId, continuationIdPrefix(commandId)],
    );
    return {
      ...(typeof routedSpace === "string"
        ? { routedSpaceId: decodeOpaqueId(routedSpace, "SpaceId") }
        : {}),
      ...(span === undefined
        ? {}
        : {
            eventSpan: {
              timelineId: decodeOpaqueId(span.timeline_id, "TimelineId"),
              partitionId: decodeOpaqueId(span.partition_id, "PartitionId"),
              spaceId: decodeOpaqueId(span.space_id, "SpaceId"),
              from: BigInt(String(span.first)),
              to: BigInt(String(span.last)),
            },
          }),
      schedules: schedules.rows.map(decodeScheduleLinkRow),
      dispatches: dispatches.rows.map(decodeDispatchLinkRow),
      chunkChildren: chunks.rows.map((row) =>
        decodeOpaqueId(columns(row, "chunk").command_id, "CommandId"),
      ),
    };
  }

  /** One lookup on the events' `(tenant_id, event_id)` key; RLS filters the privacy class. */
  async getEventCommand(eventId: EventId): Promise<InspectedEventOrigin | undefined> {
    const result = await this.client.query(
      `SELECT command_id, world_id, timeline_id, space_id FROM clockgrove.events
        WHERE tenant_id = $1 AND event_id = $2`,
      [this.authorization.tenantId, eventId],
    );
    const row = result.rows[0] === undefined ? undefined : columns(result.rows[0], "event origin");
    return row === undefined
      ? undefined
      : {
          commandId: decodeOpaqueId(row.command_id, "CommandId"),
          worldId: decodeOpaqueId(row.world_id, "WorldId"),
          timelineId: decodeOpaqueId(row.timeline_id, "TimelineId"),
          spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
        };
  }

  /** A primary-key prefix scan of one timeline, as `getCommandLinks`' schedule read. */
  async getSchedule(
    scope: {
      readonly worldId: WorldId;
      readonly timelineId: TimelineId;
      readonly spaceId: SpaceId;
    },
    scheduleId: string,
    idempotencyKey: string,
  ): Promise<InspectedSchedule | undefined> {
    const result = await this.client.query(
      `SELECT schedule_id, idempotency_key, kind, due_at::text AS due_at, status,
              scheduled_by_command_id, completed_by_command_id
         FROM clockgrove.partition_schedules
        WHERE tenant_id = $1 AND timeline_id = $2 AND world_id = $3 AND space_id = $4
          AND schedule_id = $5 AND idempotency_key = $6`,
      [
        this.authorization.tenantId,
        scope.timelineId,
        scope.worldId,
        scope.spaceId,
        scheduleId,
        idempotencyKey,
      ],
    );
    if (result.rows.length > 1) throw new TypeError("a schedule row is unique in its space");
    return result.rows[0] === undefined ? undefined : decodeScheduleLinkRow(result.rows[0]);
  }
}

function decodeScheduleLinkRow(value: unknown): InspectedSchedule {
  const row = columns(value, "schedule link");
  const status = row.status;
  if (status !== "pending" && status !== "done") {
    throw new TypeError("PostgreSQL returned a malformed schedule status");
  }
  return {
    scheduleId: String(row.schedule_id),
    idempotencyKey: String(row.idempotency_key),
    kind: String(row.kind),
    dueAt: BigInt(String(row.due_at)),
    status,
    scheduledBy: decodeOpaqueId(row.scheduled_by_command_id, "CommandId"),
    ...(row.completed_by_command_id === null
      ? {}
      : { completedBy: decodeOpaqueId(row.completed_by_command_id, "CommandId") }),
  };
}

function decodeDispatchLinkRow(value: unknown): InspectedDispatch {
  const row = columns(value, "dispatch link");
  if (typeof row.attempts !== "number") {
    throw new TypeError("PostgreSQL returned a malformed dispatch attempt count");
  }
  return {
    dispatchId: String(row.dispatch_id),
    eventId: decodeOpaqueId(row.event_id, "EventId"),
    channel: String(row.channel),
    status: String(row.status),
    attempts: row.attempts,
    ...(row.last_error_class === null ? {} : { lastErrorClass: String(row.last_error_class) }),
    ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) }),
  };
}

function columns(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`PostgreSQL returned a malformed ${what}`);
  }
  return value as Record<string, unknown>;
}

/** Maps a stored receipt row to the CommandReceipt v1 shape and decodes it. */
export function decodeReceiptRow(value: unknown): CommandReceipt {
  const row = columns(value, "command receipt");
  const target = columns(row.target_address, "command receipt target");
  const status = row.status;
  const decided = status === "committed" || status === "rejected";
  const present = (key: string, item: unknown) =>
    item === null || item === undefined ? {} : { [key]: item };
  return decodeCommandReceipt(
    {
      version: 1,
      provenance: row.provenance,
      tenantId: row.tenant_id,
      commandId: row.command_id,
      requestHash: row.request_hash,
      status,
      target,
      ...present("attribution", row.attribution),
      ...present("actionId", row.action_id),
      correlationId: row.correlation_id,
      ...present("causationId", row.causation_id),
      expected: row.expected,
      ...present("authorityDecisionId", row.authority_decision_id),
      committedEventIds: row.canonical_event_ids,
      ...(decided ? { result: row.result } : {}),
      createdAt: row.created_at,
      ...present("committedAt", row.committed_at),
      ...present("failedAt", row.failed_at),
    },
    decodeActorTargetBinding({
      tenantId: target.tenantId,
      worldId: target.worldId,
      timelineId: target.timelineId,
      kind: target.kind,
      id: target.id,
    }),
  );
}

/** Maps a stored decision row to the AuthorityDecision v1 shape and decodes it. */
export function decodeDecisionRow(value: unknown): AuthorityDecision {
  const row = columns(value, "authority decision");
  return decodeAuthorityDecision({
    version: 1,
    authorityDecisionId: row.authority_decision_id,
    outcome: row.outcome,
    tenantId: row.tenant_id,
    worldId: row.world_id,
    timelineId: row.timeline_id,
    commandId: row.command_id,
    actionId: row.action_id,
    attribution: row.attribution,
    inputs: row.inputs,
    ...(row.reason_code === null || row.reason_code === undefined
      ? {}
      : { reasonCode: row.reason_code }),
    decidedAt: row.decided_at,
  });
}
