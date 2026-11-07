import type {
  DueWorkPorts,
  DueWorkReader,
  JournalExecuteRequest,
  WorldCommandRequest,
  WorldKernel,
} from "@clockgrove/application";
import {
  advanceDueWork,
  continuationCommand,
  continueWorldCommand,
  DUE_WORK_ADVANCE_BUDGET,
  dueWorkAdvanceCommand,
  executeWorldCommand,
  InMemoryRuntimeMetrics,
  JournalEventIdCollisionError,
  JournalTimeoutError,
  PartitionStateIntegrityError,
  TrustedCommandIdRefusedError,
  WorldContinuationPendingError,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  createScheduleQueue,
  executeWorldKernel,
  type ScheduleQueue,
  type WorldScheduledPayload,
} from "@clockgrove/kernel";
import {
  installAuthorization,
  type PostgreSqlClient,
  PostgreSqlDueWorkReader,
  PostgreSqlJournal,
  PostgreSqlWorldCommandJournal,
  type PostgreSqlWorldCommandTestHooks,
  type PostgreSqlWorldCommandTimeouts,
  WORLD_COMMAND_TIMEOUTS,
} from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import {
  LocalRuntimeOwnerBindings,
  PostgreSqlCanonicalRuntimeStateSource,
  RuntimeWorker,
} from "../src/index.js";
import { authenticationFixture, authenticationRequest } from "./auth-fixture.js";
import {
  advanceCommand,
  commandCounts,
  commandRequest,
  connect,
  countingKernel,
  type DatabaseFixture,
  kernelModel,
  provisionTestWorld,
  pureStep,
  stateHash,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

const PRINCIPAL = "principal-due-work";
const MAX_TIME = (1n << 62n) - 1n;

describe("durable schedules and due-work advancement", () => {
  it("writes schedules with their events, advances exactly the due work, chunks continuations and bounds the transaction", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      await applyMigrations(fixture.tools, fixture.environment);
      const truth = truthOf(fixture);
      const world = await testWorld();
      const provisioned = await provisionTestWorld(fixture, world, PRINCIPAL);
      const { authorization, partition } = provisioned;
      const { tenantId, timelineId } = world.birth.world;
      const scope = { ...partition.target, partitionId: partition.route.partitionId };
      const ports = (
        client: PostgreSqlClient,
        options: {
          hooks?: PostgreSqlWorldCommandTestHooks;
          timeouts?: PostgreSqlWorldCommandTimeouts;
          kernel?: WorldKernel;
          metrics?: InMemoryRuntimeMetrics;
        } = {},
      ): DueWorkPorts => ({
        journal: new PostgreSqlWorldCommandJournal(
          client,
          undefined,
          options.hooks,
          options.timeouts,
          undefined,
          undefined,
          undefined,
          options.metrics,
        ),
        behavior: provisioned.behavior,
        dueWork: new PostgreSqlDueWorkReader(client),
        kernel: options.kernel ?? executeWorldKernel,
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      });
      const model = kernelModel(world);
      const clientAdvance = (
        key: string,
        targetTime: bigint,
        budget: Readonly<{ maxInputs: number; maxEvents: number }> = DUE_WORK_ADVANCE_BUDGET,
      ) => advanceCommand(world, key, targetTime, null, budget);
      const request = (command: Parameters<typeof commandRequest>[1]) =>
        commandRequest(provisioned, command);
      const counts = (commandId: string) => commandCounts(truth, commandId);
      const storedHash = () =>
        truth(`SELECT state_hash FROM clockgrove.partition_states WHERE tenant_id = '${tenantId}'`);
      /** An exact retry straight to the Journal: a decided command never runs the kernel. */
      const exactRetry = (client: PostgreSqlClient, decided: WorldCommandRequest) =>
        new PostgreSqlWorldCommandJournal(client).executeWorldCommand(
          {
            ...decided,
            events: [],
            dispatches: [],
            stableResult: null,
            projectionDelta: null,
          } as JournalExecuteRequest,
          () => {
            throw new Error("a decided command never runs the kernel");
          },
        );
      /**
       * For the commands matching `pattern` that wrote events: `commands|commands with their one
       * world-reactions dispatch (deterministic ID, first event, kernel privacy)|all their dispatches`.
       */
      const dispatchCounts = (pattern: string) =>
        truth(
          `SELECT count(*) || '|' || count(dispatch.dispatch_id) || '|' ||
                  (SELECT count(*) FROM clockgrove.event_dispatches AS any_dispatch
                     JOIN clockgrove.events AS anchor USING (tenant_id, event_id)
                    WHERE anchor.command_id LIKE '${pattern}')
             FROM (SELECT DISTINCT tenant_id, command_id FROM clockgrove.events WHERE command_id LIKE '${pattern}') AS command
             LEFT JOIN clockgrove.event_dispatches AS dispatch
               ON dispatch.tenant_id = command.tenant_id
              AND dispatch.dispatch_id = command.command_id || ':dispatch:world-reactions'
              AND dispatch.event_id = command.command_id || ':event:0'
              AND dispatch.channel = 'world-reactions' AND dispatch.privacy_class = 'public_scene'`,
        );
      /** The pending rows in the due query's order, as `id@dueAt`. */
      const pendingRows = async () =>
        (
          await withClient(fixture.environment, (client) =>
            new PostgreSqlDueWorkReader(client).dueSchedules(authorization, scope, MAX_TIME),
          )
        ).map((entry) => `${entry.scheduleId}@${entry.dueAt}`);
      const kernelQueue = () => model.schedules.map((item) => `${item.id}@${item.dueAt}`);
      /** Revision, state hash, continuation and a digest of every schedule row. */
      const snapshot = () =>
        truth(
          `SELECT state.revision || '|' || state.state_hash || '|' || coalesce(state.continuation_command_id, '-') || '|' ||
                  (SELECT md5(string_agg(schedule.schedule_id || schedule.idempotency_key || schedule.status,
                          ',' ORDER BY schedule.schedule_id, schedule.idempotency_key))
                     FROM clockgrove.partition_schedules AS schedule WHERE schedule.tenant_id = state.tenant_id)
             FROM clockgrove.partition_states AS state WHERE state.tenant_id = '${tenantId}'`,
        );

      // The birth queue is durable, and the due query's order (the due index) equals the kernel
      // queue's. The raccoons world's queue has several items due at one time, so the order is
      // decided by priority and tie-break key.
      expect(await pendingRows()).toEqual(kernelQueue());
      const raccoons = await provisionTestWorld(fixture, await testWorld("raccoons"), PRINCIPAL);
      const raccoonQueue = createScheduleQueue(
        raccoons.world.birth.schedules as ScheduleQueue<WorldScheduledPayload>,
      );
      expect(new Set(raccoonQueue.map((item) => item.dueAt)).size).toBeLessThan(
        raccoonQueue.length,
      );
      const raccoonDue = await withClient(fixture.environment, (client) =>
        new PostgreSqlDueWorkReader(client).dueSchedules(
          raccoons.authorization,
          { ...raccoons.partition.target, partitionId: raccoons.partition.route.partitionId },
          MAX_TIME,
        ),
      );
      expect(raccoonDue.map((entry) => entry.scheduleId)).toEqual(
        raccoonQueue.map((item) => item.id),
      );
      const birthPending = await withClient(fixture.environment, (client) =>
        new PostgreSqlDueWorkReader(client).pendingWork(authorization, scope),
      );
      expect(birthPending).toMatchObject({
        revision: model.state.revision,
        nextDueAt: model.schedules[0]!.dueAt,
      });
      expect(birthPending?.continuation).toBeUndefined();

      await withClient(fixture.environment, async (client) => {
        // A fault after the schedule writes leaves no partial state; the retry commits events,
        // schedule mutations and state together.
        const consuming = clientAdvance("command-consume", model.schedules[0]!.dueAt);
        const beforeFault = await snapshot();
        await expect(
          executeWorldCommand(
            request(consuming),
            ports(client, { hooks: { failureStage: "after-schedules" } }),
          ),
        ).rejects.toMatchObject({ code: "P0001" });
        expect(await snapshot()).toBe(beforeFault);
        expect(await counts("command-consume")).toBe("0|0|0");
        expect((await executeWorldCommand(request(consuming), ports(client))).value).toMatchObject({
          status: "committed",
          complete: true,
        });
        expect(await storedHash()).toBe(await stateHash(pureStep(world, model, consuming).state));
        expect(await pendingRows()).toEqual(kernelQueue());
        expect(
          Number(
            await truth(
              `SELECT count(*) FROM clockgrove.partition_schedules WHERE completed_by_command_id = 'command-consume'`,
            ),
          ),
        ).toBeGreaterThan(0);

        // Squatting: a tenant member cannot take the predictable trusted ID of the next due-work
        // advance, neither through the world-command path nor through the runtime no-op.
        const pending = await new PostgreSqlDueWorkReader(client).pendingWork(authorization, scope);
        const through = pending!.nextDueAt!;
        const advance = dueWorkAdvanceCommand(
          partition,
          pending!.revision,
          through,
          DUE_WORK_ADVANCE_BUDGET,
        );
        expect(advance.commandId).toBe(
          `trusted:advance:${timelineId}:${scope.partitionId}:${pending!.revision}:${through}`,
        );
        await expect(executeWorldCommand(request(advance), ports(client))).rejects.toBeInstanceOf(
          TrustedCommandIdRefusedError,
        );
        const worker = new RuntimeWorker(
          authenticationFixture().authenticator,
          new LocalRuntimeOwnerBindings(
            new PostgreSqlCanonicalRuntimeStateSource(client),
            new PostgreSqlJournal(client),
          ),
        );
        // The request is in the authenticated principal's own scope, so authorization passes and the
        // gateway's decode refusal of the trusted namespace answers (400), before anything is recorded.
        for (const overrides of [
          { commandId: advance.commandId },
          { commandId: "command-squat", eventId: `${advance.commandId}:event:0` },
        ]) {
          const response = await worker.fetch(authenticationRequest(overrides));
          expect([response.status, await response.json()]).toEqual([
            400,
            { error: "invalid_noop_command" },
          ]);
        }
        expect(await counts(advance.commandId)).toBe("0|0|0");
        expect(await counts("command-squat")).toBe("0|0|0");

        // advanceDueWork advances exactly the due work: the occurrences due through `through` are
        // consumed by the trusted advance, the rest stay pending, and state equals the pure kernel.
        const due = await new PostgreSqlDueWorkReader(client).dueSchedules(
          authorization,
          scope,
          through,
        );
        expect(due.length).toBeGreaterThan(0);
        const notDue = (await pendingRows()).slice(due.length);
        const counter = countingKernel();
        // The first read trails the partition by one revision, as when another writer commits in
        // between: the journal refuses that advance, and advanceDueWork re-reads and retries.
        const reader = new PostgreSqlDueWorkReader(client);
        let behind = 1n;
        const trailing: DueWorkReader = {
          pendingWork: async (principal, at) => {
            const read = (await reader.pendingWork(principal, at))!;
            const revision = read.revision - behind;
            behind = 0n;
            return { ...read, revision };
          },
          dueSchedules: (principal, at, until) => reader.dueSchedules(principal, at, until),
        };
        const metrics = new InMemoryRuntimeMetrics();
        const advanced = await advanceDueWork(
          { ...partition, through },
          { ...ports(client, { kernel: counter.kernel, metrics }), dueWork: trailing },
        );
        expect(advanced).toMatchObject({
          status: "advanced",
          commands: [{ commandId: advance.commandId }],
        });
        // One autonomous conflict, one retry, and the committed advance's writes, counted in the
        // database: its events, its one state row and world-reactions dispatch, its schedule rows.
        const [, , events] = (await counts(advance.commandId)).split("|");
        const schedules = await truth(`SELECT count(*) FROM clockgrove.partition_schedules
          WHERE '${advance.commandId}' IN (scheduled_by_command_id, completed_by_command_id)`);
        expect(metrics.points.map(({ name, label, value }) => [name, label, value])).toEqual([
          ["autonomous_conflicts", "partition", 1],
          ["transaction_retries", "revision_conflict", 1],
          ["journal_latency_ms", "autonomous", expect.any(Number)],
          ["lock_wait_ms", "autonomous", expect.any(Number)],
          ["command_events_written", "autonomous", Number(events)],
          ["command_projection_rows_written", "autonomous", 1],
          ["command_schedules_written", "autonomous", Number(schedules)],
          ["command_dispatches_written", "autonomous", 1],
        ]);
        expect(await storedHash()).toBe(await stateHash(pureStep(world, model, advance).state));
        expect(model.state.simulationTime).toBe(through);
        expect(await pendingRows()).toEqual(kernelQueue());
        expect(
          await truth(
            `SELECT string_agg(DISTINCT status || '|' || completed_by_command_id, ',') FROM clockgrove.partition_schedules
              WHERE (schedule_id, idempotency_key) IN (${due.map((entry) => `('${entry.scheduleId}', '${entry.idempotencyKey}')`).join(", ")})`,
          ),
        ).toBe(`done|${advance.commandId}`);
        const stillPending = new Set(await pendingRows());
        expect(notDue.every((entry) => stillPending.has(entry))).toBe(true);

        // Its retry is idempotent: nothing is due any more, and the trusted advance's exact retry
        // returns the stored outcome without running the kernel or writing a second dispatch.
        const calls = counter.calls();
        const advancedCounts = await counts(advance.commandId);
        expect(
          await advanceDueWork(
            { ...partition, through },
            ports(client, { kernel: counter.kernel }),
          ),
        ).toEqual({
          status: "idle",
          commands: [],
        });
        expect((await exactRetry(client, request(advance))).value).toEqual(
          advanced.commands[0]!.value,
        );
        expect(counter.calls()).toBe(calls);
        expect(await counts(advance.commandId)).toBe(advancedCounts);
        expect(await dispatchCounts(advance.commandId)).toBe("1|1|1");

        // Response loss after COMMIT: the whole use case is retried and appends nothing twice.
        const lossThrough = model.schedules[0]!.dueAt;
        const lossCommand = dueWorkAdvanceCommand(
          partition,
          model.state.revision,
          lossThrough,
          DUE_WORK_ADVANCE_BUDGET,
        );
        const afterCommit = async () => Promise.reject(new Error("response lost"));
        await expect(
          advanceDueWork(
            { ...partition, through: lossThrough },
            ports(client, { hooks: { afterCommit } }),
          ),
        ).rejects.toThrow("response lost");
        pureStep(world, model, lossCommand);
        const afterLoss = await snapshot();
        expect(
          await advanceDueWork({ ...partition, through: lossThrough }, ports(client)),
        ).toMatchObject({ status: "idle" });
        expect(await snapshot()).toBe(afterLoss);
        expect(await counts(lossCommand.commandId)).toMatch(/^1\|1\|\d+$/u);
        expect(await storedHash()).toBe(await stateHash(model.state));

        // Continuations: a kernel call that reaches its budget persists its continuation; each chunk
        // is its own transaction under a trusted ID, and the chain equals the pure chained calls.
        const far = model.state.simulationTime + 600_000n;
        const long = clientAdvance("command-long", far, {
          maxInputs: 1,
          maxEvents: DUE_WORK_ADVANCE_BUDGET.maxEvents,
        });
        expect((await executeWorldCommand(request(long), ports(client))).value).toMatchObject({
          status: "committed",
          complete: false,
        });
        let result = pureStep(world, model, long);
        const chunkId = (chunk: number) => `trusted:continue:command-long:${chunk}`;
        const continuation = () =>
          truth(
            `SELECT coalesce(continuation_command_id, '-') FROM clockgrove.partition_states WHERE tenant_id = '${tenantId}'`,
          );
        expect(await continuation()).toBe(chunkId(1));

        // While the chain is open the partition accepts only its next chunk; nothing else is written.
        const blocked = clientAdvance("command-blocked", far);
        await expect(executeWorldCommand(request(blocked), ports(client))).rejects.toBeInstanceOf(
          WorldContinuationPendingError,
        );
        expect(await counts("command-blocked")).toBe("0|0|0");
        await expect(
          executeWorldCommand(
            request({ ...blocked, commandId: decodeOpaqueId(chunkId(1), "CommandId") }),
            ports(client),
          ),
        ).rejects.toBeInstanceOf(TrustedCommandIdRefusedError);

        // A fault inside a chunk leaves the previous chunk committed and the continuation unchanged.
        const beforeChunk = await snapshot();
        await expect(
          continueWorldCommand(
            partition,
            ports(client, { hooks: { failureStage: "after-state" } }),
          ),
        ).rejects.toMatchObject({
          code: "P0001",
        });
        expect(await snapshot()).toBe(beforeChunk);
        expect(await counts(chunkId(1))).toBe("0|0|0");

        let chunk = 1;
        let chunksWithEvents = 0;
        while (!result.complete) {
          const open = await new PostgreSqlDueWorkReader(client).pendingWork(authorization, scope);
          expect(open?.continuation?.commandId).toBe(chunkId(chunk));
          const chunkCounter = countingKernel();
          const ran = await continueWorldCommand(
            partition,
            ports(client, { kernel: chunkCounter.kernel }),
          );
          expect([ran?.commandId, chunkCounter.calls()]).toEqual([chunkId(chunk), 1]);
          const next = continuationCommand(
            open!.continuation!.commandId,
            open!.continuation!.record,
          );
          result = pureStep(world, model, next, long, result.continuation);
          if (result.events.length > 0) chunksWithEvents += 1;
          expect(ran?.value).toMatchObject({ status: "committed", complete: result.complete });
          expect(await storedHash()).toBe(await stateHash(result.state));
          // A chunk's retry is idempotent: its exact bytes return the stored outcome, no kernel call.
          expect((await exactRetry(client, request(next))).value).toEqual(ran?.value);
          chunk += 1;
          expect(chunk).toBeLessThan(64);
        }
        expect(chunk).toBeGreaterThan(2);
        expect(await continuation()).toBe("-");
        expect(await pendingRows()).toEqual(kernelQueue());
        // Each chunk committed in its own transaction, with its own receipt, decision and events.
        expect(
          await truth(
            `SELECT count(*) || '|' || count(DISTINCT xmin::text) || '|' || count(DISTINCT authority_decision_id)
               FROM clockgrove.command_receipts WHERE command_id LIKE 'trusted:continue:command-long:%'`,
          ),
        ).toBe(`${chunk - 1}|${chunk - 1}|${chunk - 1}`);
        expect(
          await truth(
            `SELECT count(*) FROM clockgrove.events WHERE command_id LIKE 'trusted:continue:command-long:%'
                AND event_id NOT LIKE command_id || ':event:%'`,
          ),
        ).toBe("0");
        // Each chunk with events wrote its own world-reactions dispatch, and the origin call its one.
        expect(chunksWithEvents).toBeGreaterThan(1);
        expect(await dispatchCounts("trusted:continue:command-long:%")).toBe(
          `${chunksWithEvents}|${chunksWithEvents}|${chunksWithEvents}`,
        );
        expect(await dispatchCounts("command-long")).toBe("1|1|1");
      });

      // lock_timeout is effective: a command waiting on a partition lock held by another transaction
      // fails with a stable, retryable error instead of waiting, and writes nothing.
      await withClient(fixture.environment, async (holder) => {
        await holder.query("BEGIN");
        await installAuthorization(holder, authorization);
        await holder.query(
          `SELECT 1 FROM clockgrove.partition_states WHERE tenant_id = $1 AND partition_id = $2 FOR UPDATE`,
          [tenantId, scope.partitionId],
        );
        const started = Date.now();
        const failure = await withClient(fixture.environment, (client) =>
          executeWorldCommand(
            request(clientAdvance("command-waiting", model.state.simulationTime + 1_000n)),
            ports(client, { timeouts: { ...WORLD_COMMAND_TIMEOUTS, lockTimeoutMs: 200 } }),
          ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(JournalTimeoutError);
        expect(failure).toMatchObject({ kind: "lock" });
        expect(Date.now() - started).toBeLessThan(2_000);
        await holder.query("ROLLBACK");
        expect(await counts("command-waiting")).toBe("0|0|0");
      });

      // One kernel call is bounded: a call that sits longer than the idle-in-transaction timeout
      // loses its session (FATAL 25P03, a retryable idle timeout) and nothing commits; the retry commits.
      const slow = clientAdvance("command-slow", model.state.simulationTime + 1_000n);
      const slowKernel: WorldKernel = (input) => {
        const until = Date.now() + 600;
        while (Date.now() < until) {
          // Busy wait: the kernel call is synchronous, so the transaction sits idle meanwhile.
        }
        return executeWorldKernel(input);
      };
      // The session is gone, so closing its client fails too; the command's own error is the one to check.
      const lost = connect(fixture.environment);
      const idle = await executeWorldCommand(
        request(slow),
        ports(lost, {
          kernel: slowKernel,
          timeouts: { ...WORLD_COMMAND_TIMEOUTS, idleInTransactionTimeoutMs: 150 },
        }),
      ).catch((error: unknown) => error);
      await lost.close().catch(() => undefined);
      expect(idle).toBeInstanceOf(JournalTimeoutError);
      expect(idle).toMatchObject({ kind: "idle" });
      expect(await counts("command-slow")).toBe("0|0|0");
      await withClient(fixture.environment, (client) =>
        executeWorldCommand(request(slow), ports(client)),
      );
      expect(await storedHash()).toBe(await stateHash(pureStep(world, model, slow).state));

      // An event ID that already exists is a stable collision error, and nothing is written.
      await truth(
        `INSERT INTO clockgrove.events (
           event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
           stream_sequence, partition_sequence, journal_position, event_type, schema_version,
           simulation_time, recorded_at, command_id, correlation_id, causation_id, principal_id,
           actor_id, privacy_class, payload_hash, attribution, actor_address, policy_versions,
           payload, event_bytes
         ) OVERRIDING SYSTEM VALUE
         SELECT 'command-collide:event:0', tenant_id, world_id, timeline_id, partition_id, space_id,
                stream_id, stream_sequence + 100000, partition_sequence + 100000,
                journal_position + 100000, event_type, schema_version, simulation_time, recorded_at,
                'command-squatter', correlation_id, causation_id, principal_id, actor_id, privacy_class,
                payload_hash, attribution, actor_address, policy_versions, payload, event_bytes
           FROM clockgrove.events WHERE tenant_id = '${tenantId}' ORDER BY journal_position DESC LIMIT 1`,
      );
      const collide = clientAdvance("command-collide", model.state.simulationTime + 120_000n);
      await expect(
        withClient(fixture.environment, (client) =>
          executeWorldCommand(request(collide), ports(client)),
        ),
      ).rejects.toBeInstanceOf(JournalEventIdCollisionError);
      expect(await counts("command-collide")).toBe("0|0|0");

      // Negative control: a dropped schedule row is reported, and a command on it writes nothing.
      await truth(
        `UPDATE clockgrove.partition_schedules SET status = 'done', completed_by_command_id = 'tampered'
          WHERE (schedule_id, idempotency_key) = (
            SELECT schedule_id, idempotency_key FROM clockgrove.partition_schedules
             WHERE tenant_id = '${tenantId}' AND status = 'pending' ORDER BY due_at DESC LIMIT 1)`,
      );
      const onDropped = clientAdvance("command-on-dropped", model.state.simulationTime + 1_000n);
      await expect(
        withClient(fixture.environment, (client) =>
          executeWorldCommand(request(onDropped), ports(client)),
        ),
      ).rejects.toBeInstanceOf(PartitionStateIntegrityError);
      expect(await counts("command-on-dropped")).toBe("0|0|0");
    });
  }, 120_000);
});
