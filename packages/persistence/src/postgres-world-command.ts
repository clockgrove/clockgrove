import type {
  EncodedPartitionState,
  EncodedScheduleItem,
  EncodedWorldContinuation,
  JournalExecuteRequest,
  JournalExecuteResult,
  JournalPostCommitNotifier,
  LockedPartitionState,
  RuntimeMetrics,
  TimelineClockPolicy,
  WorldCommandAppend,
  WorldCommandJournal,
  WorldCommandStep,
  WorldPartitionScope,
} from "@clockgrove/application";
import {
  CanonicalNodeError,
  commandFamily,
  createTimelineClockPolicy,
  decodeCanonicalNode,
  decodeGenesisClockPolicy,
  decodePartitionState,
  decodeTimelineClockPolicy,
  decodeWorldContinuation,
  encodeCanonicalNode,
  JournalRevisionConflictError,
  JournalRouteNotFoundError,
  JournalTimeoutError,
  NO_METRICS,
  PartitionStateIntegrityError,
  recordMetric,
} from "@clockgrove/application";

import { ContractDecodeError } from "@clockgrove/contracts";

import type { JournalFailureStage } from "./postgres-journal.js";
import { decodeResult, encodeRequest, mapDatabaseError } from "./postgres-journal.js";
import { encodeSchedules, readContinuation, readPendingSchedules } from "./postgres-schedules.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { installAuthorization, withClientTransaction } from "./postgres-transaction.js";

/** Every fault point of a world command: the SQL stages, plus the gap after the kernel call. */
export type WorldCommandFailureStage = JournalFailureStage | "after-kernel";

/** Fault points `begin_command` knows; the others apply to `append_command` only. */
const BEGIN_STAGES: readonly WorldCommandFailureStage[] = [
  "after-receipt",
  "after-head-locks",
  "before-commit",
];

export interface PostgreSqlWorldCommandTestHooks {
  /** Test-only fault point. Every listed point is before COMMIT. */
  readonly failureStage?: WorldCommandFailureStage;
  /** Simulates transport loss after COMMIT; its error is deliberately observable. */
  readonly afterCommit?: () => Promise<void>;
}

/**
 * Bounds of one world-command transaction, set with `SET LOCAL` semantics so they end with it:
 * - `lockTimeoutMs` (`lock_timeout`): how long one lock wait (a receipt, head or state row held by
 *   another command) may last before the command fails with a retryable `JournalTimeoutError('lock')`;
 * - `statementTimeoutMs` (`statement_timeout`): how long one statement (`begin_command`, the reads,
 *   `append_command`) may run before it fails with `JournalTimeoutError('statement')`;
 * - `idleInTransactionTimeoutMs` (`idle_in_transaction_session_timeout`): how long the transaction may
 *   sit idle while the kernel runs between begin and append. Past it PostgreSQL ends the session
 *   (FATAL 25P03), the append fails with `JournalTimeoutError('idle')` and nothing commits, so one
 *   kernel call can never hold the partition locks longer. The client often sees only the closed
 *   socket, so a connection failure after a step that outlasted the bound maps to the same error.
 */
export interface PostgreSqlWorldCommandTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

/**
 * Defaults: a contended partition fails fast and retries (3 s) rather than queueing behind a long
 * chain; one statement may take 10 s; one kernel call may hold the locks 30 s. The kernel admits
 * calls of up to 4096 events (`DUE_WORK_ADVANCE_BUDGET` uses that maximum), about 1.2 ms per event
 * on an idle host, so the largest admitted call already needs about 5 s and more on a shared CPU.
 * 30 s matches the Workers default CPU limit of one invocation, which bounds a kernel call anyway.
 */
export const WORLD_COMMAND_TIMEOUTS: PostgreSqlWorldCommandTimeouts = Object.freeze({
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 30_000,
});

export class WorldCommandFaultInjectedError extends Error {
  constructor(readonly stage: WorldCommandFailureStage) {
    super(`world command fault injected at ${stage}`);
    this.name = "WorldCommandFaultInjectedError";
  }
}

type Row = Readonly<Record<string, unknown>>;

export function record(value: unknown, what: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`PostgreSQL returned a malformed ${what}`);
  }
  return value as Row;
}

export function text(source: Row, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new TypeError(`PostgreSQL returned a malformed ${key}`);
  return value;
}

/**
 * Decodes the locked aggregate `begin_command` returned, with its schedule rows and continuation, and
 * verifies them.
 */
export function decodeLockedPartitionState(
  value: unknown,
  schedules: readonly EncodedScheduleItem[],
  continuation: EncodedWorldContinuation | undefined,
): LockedPartitionState {
  try {
    return decodeStoredPartitionState(value, schedules, continuation);
  } catch (error) {
    // A stored row that does not decode is durable corruption, never a client or server-code error.
    if (
      error instanceof TypeError ||
      error instanceof SyntaxError ||
      error instanceof RangeError ||
      error instanceof CanonicalNodeError
    )
      throw new PartitionStateIntegrityError("malformed-document");
    throw error;
  }
}

function decodeStoredPartitionState(
  value: unknown,
  schedules: readonly EncodedScheduleItem[],
  continuation: EncodedWorldContinuation | undefined,
): LockedPartitionState {
  const aggregate = record(value, "partition state");
  const documentVersion = aggregate.documentVersion;
  const document = aggregate.document;
  if (typeof documentVersion !== "number" || !Array.isArray(document)) {
    throw new TypeError("PostgreSQL returned a malformed partition state");
  }
  const stored: EncodedPartitionState = {
    revision: BigInt(text(aggregate, "revision")),
    simulationTime: BigInt(text(aggregate, "simulationTime")),
    documentVersion,
    document,
    documentHash: text(aggregate, "documentHash"),
    stateHash: text(aggregate, "stateHash"),
    schedules,
  };
  const { packContentHash, packId, packVersion } = aggregate;
  return {
    revision: stored.revision,
    coveredHeadSequence: BigInt(text(aggregate, "coveredHeadSequence")),
    packContentHash: typeof packContentHash === "string" ? packContentHash : undefined,
    ...(typeof packId === "string" && typeof packVersion === "string"
      ? { packId, packVersion }
      : {}),
    document: decodePartitionState(stored),
    schedules,
    ...(continuation === undefined
      ? {}
      : {
          continuation: {
            commandId: continuation.commandId,
            record: decodeWorldContinuation(continuation),
          },
        }),
  };
}

function encodeAppend(request: JournalExecuteRequest, append: WorldCommandAppend): string {
  const state = append.state;
  return encodeSchedules({
    commandId: request.command.commandId,
    outcome: append.outcome,
    events: append.events,
    dispatches: append.dispatches ?? [],
    stableResult: append.stableResult,
    projectionDelta: append.projectionDelta,
    ...(state === undefined
      ? {}
      : {
          state: {
            revision: state.revision,
            simulationTime: state.simulationTime,
            document: state.document,
            documentHash: state.documentHash,
            stateHash: state.stateHash,
            continuation: append.continuation ?? null,
          },
          schedules: append.schedules ?? { done: [], put: [] },
        }),
  });
}

/**
 * PostgreSQL adapter for world commands: one bounded transaction holding `clockgrove.begin_command`,
 * the reads of the locked schedule rows and continuation, the caller's synchronous step and
 * `clockgrove.append_command`. Nothing but that step runs while the receipt, head and state locks are
 * held.
 */
export class PostgreSqlWorldCommandJournal implements WorldCommandJournal {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly notifier?: JournalPostCommitNotifier,
    private readonly testHooks: PostgreSqlWorldCommandTestHooks = {},
    private readonly timeouts: PostgreSqlWorldCommandTimeouts = WORLD_COMMAND_TIMEOUTS,
    private readonly fence?: Readonly<{ routingEpoch: bigint; authorityEpoch: bigint }>,
    private readonly clockPolicyVersion?: bigint,
    private readonly ownerGeneration?: bigint,
    private readonly metrics: RuntimeMetrics = NO_METRICS,
  ) {}

  async executeWorldCommand(
    request: JournalExecuteRequest,
    step: WorldCommandStep,
  ): Promise<JournalExecuteResult> {
    const stage = this.testHooks.failureStage;
    const appendStage = stage === undefined || stage === "after-kernel" ? null : stage;
    const beginStage =
      appendStage !== null && BEGIN_STAGES.includes(appendStage) ? appendStage : null;
    // Set when the kernel step outlasted the idle-in-transaction bound: PostgreSQL has then ended the
    // session, and the client may see only the broken socket, not the server's FATAL 25P03.
    let idleExceeded = false;
    let result: JournalExecuteResult;
    // Workers clocks advance only across I/O; every interval here spans database round trips.
    const started = Date.now();
    let lockWaitMs: number | undefined;
    // What the step handed to `append_command`; unset when the command was already decided.
    let written: WorldCommandAppend | undefined;
    const family = commandFamily(request.command);
    try {
      result = await withClientTransaction(this.client, {}, async () => {
        await this.client.query(
          `SELECT set_config('lock_timeout', $1, true),
                  set_config('statement_timeout', $2, true),
                  set_config('idle_in_transaction_session_timeout', $3, true)`,
          [
            `${this.timeouts.lockTimeoutMs}ms`,
            `${this.timeouts.statementTimeoutMs}ms`,
            `${this.timeouts.idleInTransactionTimeoutMs}ms`,
          ],
        );
        await installAuthorization(this.client, request.authorization);
        // begin_command takes the receipt, head and state row locks; its round trip is the wait.
        const lockStarted = Date.now();
        const begun = await this.client.query(
          `SELECT clockgrove.begin_command($1::bytea, $2::jsonb, $3::text) AS begun`,
          [request.commandBytes, encodeRequest(request, { aggregate: true }), beginStage],
        );
        lockWaitMs = Date.now() - lockStarted;
        const opened = record(record(begun.rows[0], "begin row").begun, "begin result");
        if (opened.status === "decided") return decodeResult(opened);
        if (opened.status !== "begun") {
          throw new TypeError("PostgreSQL returned a malformed begin status");
        }
        const route = request.route;
        if (route === undefined) throw new TypeError("a world command always has a route");
        if (this.fence !== undefined) {
          // begin_command already owns this partition's row lock. Read its current placement,
          // rather than trusting the earlier owner hydration, before the physical step runs.
          const heads = await this.client.query(
            `SELECT routing_epoch::text AS routing_epoch FROM clockgrove.timeline_partitions
              WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3
                AND partition_id = $4 AND space_id = $5`,
            [
              request.authorization.tenantId,
              request.command.target.worldId,
              request.command.target.timelineId,
              route.partitionId,
              route.spaceId,
            ],
          );
          if (heads.rows.length !== 1) throw new JournalRouteNotFoundError(route.partitionId);
          const epoch = BigInt(text(record(heads.rows[0], "partition head"), "routing_epoch"));
          for (const supplied of [this.fence.routingEpoch, this.fence.authorityEpoch]) {
            if (supplied !== epoch)
              throw new JournalRevisionConflictError("routing-epoch", supplied, epoch);
          }
        }
        const ready = await this.client.query(
          `SELECT world.world_id FROM clockgrove.worlds AS world
            JOIN clockgrove.timelines AS timeline USING (tenant_id, world_id)
            WHERE world.tenant_id = $1 AND world.world_id = $2 AND timeline.timeline_id = $3
              AND world.lifecycle_status = 'ready' AND timeline.state = 'active'
            FOR SHARE OF world, timeline`,
          [
            request.authorization.tenantId,
            request.command.target.worldId,
            request.command.target.timelineId,
          ],
        );
        if (ready.rows.length !== 1) throw new JournalRouteNotFoundError(route.partitionId);
        // The state row is locked, and only a holder of that lock writes these rows.
        const key = {
          tenantId: request.authorization.tenantId,
          timelineId: request.command.target.timelineId,
          partitionId: route.partitionId,
        };
        const schedules = await readPendingSchedules(this.client, key);
        const continuation = await readContinuation(this.client, key);
        const clockPolicy = await readTimelineClockPolicy(this.client, key);
        if (
          this.clockPolicyVersion !== undefined &&
          this.clockPolicyVersion !== clockPolicy.version
        ) {
          throw new JournalRevisionConflictError(
            "clock-policy",
            this.clockPolicyVersion,
            clockPolicy.version,
          );
        }
        if (this.ownerGeneration !== undefined) {
          const owners = await this.client.query(
            `SELECT clock_owner_generation::text AS generation FROM clockgrove.partition_states
              WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
            [key.tenantId, key.timelineId, key.partitionId],
          );
          if (owners.rows.length !== 1) throw new JournalRouteNotFoundError(key.partitionId);
          const generation = BigInt(text(record(owners.rows[0], "owner generation"), "generation"));
          if (generation !== this.ownerGeneration) {
            throw new JournalRevisionConflictError(
              "owner-generation",
              this.ownerGeneration,
              generation,
            );
          }
        }
        const locked = decodeLockedPartitionState(opened.aggregate, schedules, continuation);
        const stepStarted = Date.now();
        const append = step({ ...locked, clockPolicy });
        idleExceeded = Date.now() - stepStarted >= this.timeouts.idleInTransactionTimeoutMs;
        if (stage === "after-kernel") throw new WorldCommandFaultInjectedError(stage);
        const appended = await this.client.query(
          `SELECT clockgrove.append_command($1::jsonb, $2::text) AS result`,
          [encodeAppend(request, append), appendStage],
        );
        written = append;
        if (append.clockPolicy !== undefined) {
          await this.client.query(
            `UPDATE clockgrove.partition_states SET clock_policy = $4::jsonb
              WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
            [
              key.tenantId,
              key.timelineId,
              key.partitionId,
              JSON.stringify(encodeCanonicalNode(append.clockPolicy)),
            ],
          );
        }
        return decodeResult(appended.rows[0]);
      });
    } catch (error) {
      const mapped = mapDatabaseError(error, request);
      // An alarm, catch-up or due-work command answers no request, so no `*_answered` record carries
      // its conflict; a client command's conflict is in its `world_command_answered` record.
      if (mapped instanceof JournalRevisionConflictError && family === "autonomous")
        recordMetric(this.metrics, {
          name: "autonomous_conflicts",
          tenantId: request.authorization.tenantId,
          worldId: request.command.target.worldId,
          label: mapped.kind,
          value: 1,
        });
      if (mapped === error && idleExceeded) throw new JournalTimeoutError("idle");
      throw mapped;
    }
    const point = {
      tenantId: request.authorization.tenantId,
      worldId: request.command.target.worldId,
      label: family,
    };
    recordMetric(this.metrics, {
      ...point,
      name: "journal_latency_ms",
      value: Date.now() - started,
    });
    if (lockWaitMs !== undefined)
      recordMetric(this.metrics, { ...point, name: "lock_wait_ms", value: lockWaitMs });
    if (written !== undefined) {
      // Rows `append_command` wrote, from the append in memory: the state document is the one
      // projection row (plan §7.1 amendment, issue 649), and schedules count completed plus new rows.
      const { done, put } = written.schedules ?? { done: [], put: [] };
      const value = written.events.length;
      const inputs = written.inputs === undefined ? {} : { count: written.inputs };
      recordMetric(this.metrics, { ...point, name: "command_events_written", value, ...inputs });
      recordMetric(this.metrics, {
        ...point,
        name: "command_projection_rows_written",
        value: written.state === undefined ? 0 : 1,
      });
      recordMetric(this.metrics, {
        ...point,
        name: "command_schedules_written",
        value: done.length + put.length,
      });
      recordMetric(this.metrics, {
        ...point,
        name: "command_dispatches_written",
        value: written.dispatches?.length ?? 0,
      });
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
}

/** Reads the committed policy under the caller's authorized transaction and existing state lock. */
export async function readTimelineClockPolicy(
  client: PostgreSqlClient,
  key: Pick<WorldPartitionScope, "tenantId" | "timelineId" | "partitionId">,
): Promise<TimelineClockPolicy> {
  const result = await client.query(
    `SELECT state.clock_policy, birth.clock_policy AS genesis_clock_policy,
            state.simulation_time::text AS simulation_time,
            (SELECT event.payload FROM clockgrove.events AS event
              WHERE event.tenant_id = state.tenant_id AND event.timeline_id = state.timeline_id
                AND event.partition_id = state.partition_id AND event.event_type = 'ClockPolicyChanged'
              ORDER BY event.partition_sequence DESC LIMIT 1) AS journal_clock_event
       FROM clockgrove.partition_states AS state
       JOIN clockgrove_birth.world_birth_states AS birth USING (tenant_id, world_id, timeline_id)
      WHERE state.tenant_id = $1 AND state.timeline_id = $2 AND state.partition_id = $3`,
    [key.tenantId, key.timelineId, key.partitionId],
  );
  if (result.rows.length !== 1) throw new JournalRouteNotFoundError(key.partitionId);
  return clockPolicyOf(record(result.rows[0], "clock policy"));
}

/**
 * The policy of a row with `clock_policy`, `genesis_clock_policy` and `simulation_time`. With
 * `journal_clock_event` (the latest ClockPolicyChanged payload) the journal is canonical and the
 * stored column must equal it. Without it the stored column is trusted, and null means genesis: the
 * journal writes the column in the transaction that appends the change. Read-only planning uses that
 * form; admission and every command transaction verify against the journal under the lock.
 */
export function clockPolicyOf(row: Readonly<Record<string, unknown>>): TimelineClockPolicy {
  try {
    const stored =
      row.clock_policy === null
        ? undefined
        : decodeTimelineClockPolicy(decodeCanonicalNode(row.clock_policy));
    const genesis = () =>
      createTimelineClockPolicy(
        decodeGenesisClockPolicy(decodeCanonicalNode(row.genesis_clock_policy)),
        BigInt(text(row, "simulation_time")),
        0n,
      );
    if (!("journal_clock_event" in row)) return stored ?? genesis();
    const canonical =
      row.journal_clock_event === null
        ? genesis()
        : decodeTimelineClockPolicy(
            decodeCanonicalNode(record(row.journal_clock_event, "clock event").clockPolicy),
          );
    if (
      stored !== undefined &&
      JSON.stringify(encodeCanonicalNode(stored)) !== JSON.stringify(encodeCanonicalNode(canonical))
    ) {
      throw new PartitionStateIntegrityError("malformed-document");
    }
    return canonical;
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      error instanceof CanonicalNodeError ||
      error instanceof ContractDecodeError
    ) {
      throw new PartitionStateIntegrityError("malformed-document");
    }
    throw error;
  }
}
