import type {
  DueSchedule,
  DueWorkReader,
  EncodedScheduleItem,
  EncodedWorldContinuation,
  PendingWorldWork,
  RuntimeAuthorizationContext,
  WorldPartitionScope,
} from "@clockgrove/application";
import { decodeWorldContinuation } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";

import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

type Row = Readonly<Record<string, unknown>>;

function record(value: unknown, what: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`PostgreSQL returned a malformed ${what}`);
  }
  return value as Row;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`PostgreSQL returned a malformed ${key}`);
  return value;
}

/**
 * The kernel's canonical queue order: due time, priority, then tie-break key in byte order
 * (`COLLATE "C"`, code-point order). The kernel orders keys by UTF-16 code unit; see 0008 for when
 * the two differ.
 */
// Qualify the stored numeric columns: SELECT's text aliases otherwise sort lexically.
export const DUE_ORDER = "schedule.due_at, schedule.priority, schedule.tie_break_key";

const SCHEDULE_COLUMNS = `schedule_id, idempotency_key, owner_partition_id, due_at::text AS due_at,
  priority::text AS priority, tie_break_key, kind, payload_version, catch_up_class, supersedes, item,
  item_hash`;

function scheduleRow(value: unknown): EncodedScheduleItem {
  const row = record(value, "schedule row");
  const item = row.item;
  const payloadVersion = row.payload_version;
  const supersedes = row.supersedes;
  if (!Array.isArray(item) || typeof payloadVersion !== "number") {
    throw new TypeError("PostgreSQL returned a malformed schedule row");
  }
  return {
    scheduleId: text(row, "schedule_id"),
    idempotencyKey: text(row, "idempotency_key"),
    ownerPartitionId: text(row, "owner_partition_id"),
    dueAt: BigInt(text(row, "due_at")),
    priority: Number(text(row, "priority")),
    tieBreakKey: text(row, "tie_break_key"),
    kind: text(row, "kind"),
    payloadVersion,
    catchUpClass: text(row, "catch_up_class"),
    ...(typeof supersedes === "string" ? { supersedes } : {}),
    item,
    itemHash: text(row, "item_hash"),
  };
}

interface PartitionKey {
  readonly tenantId: string;
  readonly timelineId: string;
  readonly partitionId: string;
}

/** The partition's pending schedule rows in queue order, inside the caller's authorized transaction. */
export async function readPendingSchedules(
  client: PostgreSqlClient,
  key: PartitionKey,
): Promise<readonly EncodedScheduleItem[]> {
  const result = await client.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM clockgrove.partition_schedules AS schedule
      WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3 AND status = 'pending'
      ORDER BY ${DUE_ORDER}`,
    [key.tenantId, key.timelineId, key.partitionId],
  );
  return result.rows.map(scheduleRow);
}

/** The partition's stored continuation, inside the caller's authorized transaction. */
export async function readContinuation(
  client: PostgreSqlClient,
  key: PartitionKey,
): Promise<EncodedWorldContinuation | undefined> {
  const result = await client.query(
    `SELECT continuation, continuation_hash, continuation_command_id
       FROM clockgrove.partition_states
      WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
    [key.tenantId, key.timelineId, key.partitionId],
  );
  return continuationOf(result.rows[0]);
}

function continuationOf(value: unknown): EncodedWorldContinuation | undefined {
  if (value === undefined) return undefined;
  const row = record(value, "partition state");
  if (row.continuation === null || row.continuation === undefined) return undefined;
  if (!Array.isArray(row.continuation))
    throw new TypeError("PostgreSQL returned a malformed continuation");
  return {
    commandId: decodeOpaqueId(text(row, "continuation_command_id"), "CommandId"),
    document: row.continuation,
    documentHash: text(row, "continuation_hash"),
  };
}

/** Inserts the birth queue as pending rows of the world's first partition state (inside WorldReady). */
export async function insertBirthSchedules(
  client: PostgreSqlClient,
  scope: PartitionKey & { readonly worldId: string; readonly spaceId: string },
  commandId: string,
  schedules: readonly EncodedScheduleItem[],
): Promise<void> {
  if (schedules.length === 0) return;
  await client.query(
    `INSERT INTO clockgrove.partition_schedules (
       tenant_id, world_id, timeline_id, partition_id, space_id, schedule_id, idempotency_key,
       owner_partition_id, due_at, priority, tie_break_key, kind, payload_version, catch_up_class,
       supersedes, item, item_hash, status, scheduled_by_command_id
     )
     SELECT $1, $2, $3, $4, $5, put.item->>'scheduleId', put.item->>'idempotencyKey',
       put.item->>'ownerPartitionId', (put.item->>'dueAt')::bigint, (put.item->>'priority')::bigint,
       put.item->>'tieBreakKey', put.item->>'kind', (put.item->>'payloadVersion')::integer,
       put.item->>'catchUpClass', put.item->>'supersedes', put.item->'item', put.item->>'itemHash',
       'pending', $6
       FROM jsonb_array_elements($7::jsonb) AS put(item)`,
    [
      scope.tenantId,
      scope.worldId,
      scope.timelineId,
      scope.partitionId,
      scope.spaceId,
      commandId,
      encodeSchedules(schedules),
    ],
  );
}

export function encodeSchedules(schedules: unknown): string {
  return JSON.stringify(schedules, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * Reads due work from the schedule rows through the due index: the next deadline of a partition and
 * the occurrences due through a time, in the kernel queue's order. Each read is its own short
 * authorized transaction and takes no lock; a command re-checks everything under its locks.
 */
export class PostgreSqlDueWorkReader implements DueWorkReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async pendingWork(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
  ): Promise<PendingWorldWork | undefined> {
    return this.read(authorization, async () => {
      const result = await this.client.query(
        `SELECT state.revision::text AS revision, state.simulation_time::text AS simulation_time,
                state.continuation, state.continuation_hash, state.continuation_command_id,
                least(state.next_process_due_at, (SELECT schedule.due_at FROM clockgrove.partition_schedules AS schedule
                  WHERE schedule.tenant_id = state.tenant_id
                    AND schedule.timeline_id = state.timeline_id
                    AND schedule.partition_id = state.partition_id
                    AND schedule.status = 'pending'
                  ORDER BY ${DUE_ORDER} LIMIT 1))::text AS next_due_at
           FROM clockgrove.partition_states AS state
          WHERE state.tenant_id = $1 AND state.world_id = $2 AND state.timeline_id = $3
            AND state.partition_id = $4`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.partitionId],
      );
      const value = result.rows[0];
      if (value === undefined) return undefined;
      const row = record(value, "pending work");
      const nextDueAt = row.next_due_at;
      const stored = continuationOf(row);
      return {
        revision: BigInt(text(row, "revision")),
        simulationTime: BigInt(text(row, "simulation_time")),
        nextDueAt: typeof nextDueAt === "string" ? BigInt(nextDueAt) : null,
        ...(stored === undefined
          ? {}
          : {
              continuation: {
                commandId: stored.commandId,
                record: decodeWorldContinuation(stored),
              },
            }),
      };
    });
  }

  async dueSchedules(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
    through: bigint,
  ): Promise<readonly DueSchedule[]> {
    return this.read(authorization, async () => {
      const result = await this.client.query(
        `SELECT schedule.schedule_id, schedule.idempotency_key, schedule.due_at::text AS due_at
           FROM clockgrove.partition_schedules AS schedule
          WHERE schedule.tenant_id = $1 AND schedule.world_id = $2 AND schedule.timeline_id = $3
            AND schedule.partition_id = $4 AND schedule.status = 'pending'
            AND schedule.due_at <= $5::bigint
          ORDER BY ${DUE_ORDER}`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.partitionId, through.toString()],
      );
      return result.rows.map((value) => {
        const row = record(value, "due schedule");
        return {
          scheduleId: text(row, "schedule_id"),
          idempotencyKey: text(row, "idempotency_key"),
          dueAt: BigInt(text(row, "due_at")),
        };
      });
    });
  }

  private async read<T>(
    authorization: RuntimeAuthorizationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withClientTransaction(this.client, { authorization }, operation);
  }
}
