import type { WorldCommandRequest, WorldKernel } from "@clockgrove/application";
import {
  decodeCanonicalNode,
  executeWorldCommand,
  InMemoryRuntimeMetrics,
  JournalRevisionConflictError,
  PartitionStateIntegrityError,
} from "@clockgrove/application";
import { CommandIdempotencyInvariantError } from "@clockgrove/contracts";
import { canonicalBytes, executeWorldKernel } from "@clockgrove/kernel";
import {
  type PostgreSqlClient,
  PostgreSqlWorldCommandJournal,
  type PostgreSqlWorldCommandTestHooks,
  type WorldCommandFailureStage,
  WorldCommandFaultInjectedError,
} from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import {
  advanceCommand,
  commandCounts,
  commandRequest,
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

// The crash-window matrix of a world command (Wave 2 plan §14): every stage of the journal transaction.
const FAULT_STAGES: readonly WorldCommandFailureStage[] = [
  "after-receipt",
  "after-head-locks",
  "after-kernel",
  "after-events",
  "after-dispatches",
  "after-schedules",
  "after-state",
  "before-commit",
];

describe("world commands through the kernel inside the canonical journal transaction", () => {
  it("runs one pure kernel call per command, serializes, retries exactly and leaves nothing on faults", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      await applyMigrations(fixture.tools, fixture.environment);
      const truth = truthOf(fixture);
      const world = await testWorld();
      const provisioned = await provisionTestWorld(fixture, world, "principal-world-commands");
      const partitionId = provisioned.partition.route.partitionId;
      const model = kernelModel(world);
      const metrics = new InMemoryRuntimeMetrics();
      const advance = (key: string, by: bigint, expected: bigint | null = model.state.revision) =>
        advanceCommand(world, `command-${key}`, model.state.simulationTime + by, expected);
      const run = (
        client: PostgreSqlClient,
        request: WorldCommandRequest,
        kernel: WorldKernel = executeWorldKernel,
        hooks?: PostgreSqlWorldCommandTestHooks,
      ) =>
        executeWorldCommand(request, {
          journal: new PostgreSqlWorldCommandJournal(
            client,
            undefined,
            hooks,
            undefined,
            undefined,
            undefined,
            undefined,
            metrics,
          ),
          behavior: provisioned.behavior,
          kernel,
        });
      const request = (
        command: Parameters<typeof commandRequest>[1],
        options?: Parameters<typeof commandRequest>[2],
      ) => commandRequest(provisioned, command, options);
      // The state row, its head and a digest of every schedule row (pending and done).
      const stateRow = () =>
        truth(
          `SELECT state.revision || '|' || state.covered_head_sequence || '|' || state.state_hash || '|' ||
                  head.head_sequence || '|' ||
                  (SELECT md5(coalesce(string_agg(schedule.schedule_id || schedule.idempotency_key ||
                          schedule.status || schedule.item_hash, ',' ORDER BY schedule.schedule_id,
                          schedule.idempotency_key), ''))
                     FROM clockgrove.partition_schedules AS schedule
                    WHERE schedule.tenant_id = state.tenant_id AND schedule.partition_id = state.partition_id)
             FROM clockgrove.partition_states AS state
             JOIN clockgrove.timeline_partitions AS head USING (tenant_id, timeline_id, partition_id)
            WHERE state.partition_id = '${partitionId}'`,
        );
      /** Every dispatch anchored on the command's events or carrying its ID prefix; empty when none. */
      const dispatches = (commandId: string) =>
        truth(
          `SELECT coalesce(string_agg(dispatch.dispatch_id || '|' || dispatch.event_id || '|' || dispatch.channel || '|' ||
                  dispatch.status || '|' || dispatch.privacy_class || '|' || (dispatch.payload->>'eventCount'),
                  ',' ORDER BY dispatch.dispatch_id), '')
             FROM clockgrove.event_dispatches AS dispatch
             JOIN clockgrove.events AS event USING (tenant_id, event_id)
            WHERE event.command_id = '${commandId}' OR dispatch.dispatch_id LIKE '${commandId}:%'`,
        );
      /** The one world-reactions dispatch of a committed command with `eventCount` events. */
      const oneDispatch = (commandId: string, eventCount: number) =>
        `${commandId}:dispatch:world-reactions|${commandId}:event:0|world-reactions|pending|public_scene|${eventCount}`;

      // Birth-to-live handoff: WorldReady writes the initial partition state, covering its head.
      const [birthRevision, birthCovered, birthStateHash, birthHead] = (await stateRow()).split(
        "|",
      );
      expect([birthRevision, birthStateHash]).toEqual([
        world.birth.state.revision.toString(),
        await stateHash(world.birth.state),
      ]);
      expect(birthCovered).toBe(birthHead);

      await withClient(fixture.environment, async (client) => {
        // One command through the Journal equals one pure kernel call: events, state hash, one dispatch.
        const first = advance("first", 120_000n);
        const counter = countingKernel();
        const committed = await run(client, request(first), counter.kernel);
        // The commit exports journal latency, lock wait and its write counts for its tenant, world and
        // command family.
        expect(
          metrics.points.map(({ name, tenantId, worldId, label }) => [
            name,
            tenantId,
            worldId,
            label,
          ]),
        ).toEqual(
          [
            "journal_latency_ms",
            "lock_wait_ms",
            "command_events_written",
            "command_projection_rows_written",
            "command_schedules_written",
            "command_dispatches_written",
          ].map((name) => [name, world.birth.world.tenantId, world.birth.world.worldId, "world"]),
        );
        expect(metrics.points.every(({ value }) => Number.isFinite(value) && value >= 0)).toBe(
          true,
        );
        const expected = pureStep(world, model, first);
        expect(counter.calls()).toBe(1);
        expect(expected.events.length).toBeGreaterThan(0);
        expect(
          committed.events.map((event) =>
            canonicalBytes(
              decodeCanonicalNode((event.payload as { kernelEvent: unknown }).kernelEvent),
            ),
          ),
        ).toEqual(expected.events.map((event) => canonicalBytes(event)));
        expect(committed.events.every((event) => event.privacyClass === "public_scene")).toBe(true);
        const [revision, covered, storedHash, head] = (await stateRow()).split("|");
        expect([revision, storedHash, covered]).toEqual([
          expected.state.revision.toString(),
          await stateHash(expected.state),
          head,
        ]);
        expect(committed.value).toMatchObject({
          status: "committed",
          revision,
          stateHash: storedHash,
        });
        expect(await dispatches("command-first")).toBe(
          oneDispatch("command-first", expected.events.length),
        );

        // An exact retry returns the stored outcome without the kernel; different bytes fail closed (CG001).
        expect(await run(client, request(first), counter.kernel)).toEqual(committed);
        await expect(
          run(
            client,
            request(first, { bytes: new TextEncoder().encode("different") }),
            counter.kernel,
          ),
        ).rejects.toBeInstanceOf(CommandIdempotencyInvariantError);
        expect(counter.calls()).toBe(1);
        expect(await commandCounts(truth, "command-first")).toBe(`1|1|${expected.events.length}`);
        expect(await dispatches("command-first")).toBe(
          oneDispatch("command-first", expected.events.length),
        );

        // A stale revision is a retryable conflict with no receipt and no kernel call.
        const stale = advance("stale", 1_000n, BigInt(birthRevision!));
        const conflict = await run(client, request(stale), counter.kernel).catch(
          (error: unknown) => error,
        );
        expect(conflict).toBeInstanceOf(JournalRevisionConflictError);
        expect(conflict).toMatchObject({ kind: "partition", actual: model.state.revision });
        expect(await commandCounts(truth, "command-stale")).toBe("0|0|0");
        expect(counter.calls()).toBe(1);

        // A domain refusal commits a rejected receipt under the allow decision; a deny decision commits
        // its rejected receipt without running the kernel. Neither changes state or dispatches.
        const before = await stateRow();
        const refused = await run(
          client,
          request(advanceCommand(world, "command-refused", 0n, model.state.revision)),
          counter.kernel,
        );
        expect(refused).toMatchObject({ outcome: "rejected", value: { status: "refused" } });
        expect(
          await truth(
            `SELECT status FROM clockgrove.command_receipts WHERE command_id = 'command-refused'`,
          ),
        ).toBe("rejected");
        expect(
          await truth(
            `SELECT outcome FROM clockgrove.authority_decisions WHERE command_id = 'command-refused'`,
          ),
        ).toBe("allow");
        const denied = await run(
          client,
          request(advance("denied", 1_000n), { deny: "world-participation-absent" }),
          counter.kernel,
        );
        expect(denied).toMatchObject({ outcome: "rejected", value: { status: "denied" } });
        expect(counter.calls()).toBe(2);
        expect(await commandCounts(truth, "command-refused")).toBe("1|1|0");
        expect((await dispatches("command-refused")) + (await dispatches("command-denied"))).toBe(
          "",
        );
        expect(await stateRow()).toBe(before);

        // Every crash window leaves nothing persisted, and the retry then commits normally.
        for (const stage of FAULT_STAGES) {
          const faulted = advance(`fault-${stage}`, 60_000n);
          const snapshot = await stateRow();
          const failure = await run(client, request(faulted), executeWorldKernel, {
            failureStage: stage,
          }).catch((error: unknown) => error);
          if (stage === "after-kernel")
            expect(failure).toBeInstanceOf(WorldCommandFaultInjectedError);
          else expect(failure).toMatchObject({ code: "P0001" });
          expect(await commandCounts(truth, `command-fault-${stage}`)).toBe("0|0|0");
          expect(await dispatches(`command-fault-${stage}`)).toBe("");
          expect(await stateRow()).toBe(snapshot);
          const recovered = await run(client, request(faulted));
          const result = pureStep(world, model, faulted);
          expect(recovered.value).toMatchObject({
            status: "committed",
            revision: result.state.revision.toString(),
          });
          expect(await dispatches(`command-fault-${stage}`)).toBe(
            oneDispatch(`command-fault-${stage}`, result.events.length),
          );
        }

        // Response loss after COMMIT: the retry returns the stored outcome and runs no kernel.
        const lost = advance("lost-response", 60_000n);
        const afterCommit = async () => Promise.reject(new Error("response lost"));
        await expect(run(client, request(lost), counter.kernel, { afterCommit })).rejects.toThrow(
          "response lost",
        );
        const calls = counter.calls();
        const afterLoss = await run(client, request(lost), counter.kernel);
        expect(counter.calls()).toBe(calls);
        expect(afterLoss.value).toMatchObject({
          revision: pureStep(world, model, lost).state.revision.toString(),
        });
        expect(await commandCounts(truth, "command-lost-response")).toMatch(/^1\|1\|[1-9]\d*$/u);
      });

      // Concurrent commands on one partition serialize: both commit, the second on the first's
      // result. Two contenders at the same expected revision yield one commit and one conflict.
      const startRevision = model.state.revision;
      const racing = (...commands: ReturnType<typeof advance>[]) =>
        Promise.allSettled(
          commands.map((command) =>
            withClient(fixture.environment, (client) => run(client, request(command))),
          ),
        );
      const both = await racing(advance("left", 60_000n, null), advance("right", 60_000n, null));
      expect(both.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const chain = await truth(
        `SELECT string_agg((result->'projectionDelta'->>'fromRevision') || '>' || (result->'projectionDelta'->>'toRevision'), ','
                ORDER BY (result->'projectionDelta'->>'fromRevision')::bigint)
           FROM clockgrove.command_receipts WHERE command_id IN ('command-left', 'command-right')`,
      );
      const [firstFrom, firstTo, secondFrom, secondTo] = chain.split(/[,>]/u);
      expect([firstFrom, secondFrom]).toEqual([startRevision.toString(), firstTo]);
      const raced = await truth(
        `SELECT revision FROM clockgrove.partition_states WHERE partition_id = '${partitionId}'`,
      );
      expect(raced).toBe(secondTo);
      expect(
        await truth(
          `SELECT count(*) = max(partition_sequence) AND count(DISTINCT partition_sequence) = count(*)
             FROM clockgrove.events WHERE partition_id = '${partitionId}'`,
        ),
      ).toBe("t");
      const contenders = await racing(
        advance("race-a", 240_000n, BigInt(raced)),
        advance("race-b", 300_000n, BigInt(raced)),
      );
      expect(contenders.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(contenders.find((result) => result.status === "rejected")).toMatchObject({
        reason: expect.any(JournalRevisionConflictError),
      });
      expect([
        await commandCounts(truth, "command-race-a"),
        await commandCounts(truth, "command-race-b"),
      ]).toContain("0|0|0");

      // Negative control: one changed byte in the stored document is reported, and a command on it
      // writes nothing.
      const { worldId } = world.birth.world;
      await truth(
        `UPDATE clockgrove.partition_states SET document = replace(document::text, '"${worldId}"', '"${worldId}x"')::jsonb
          WHERE partition_id = '${partitionId}'`,
      );
      await expect(
        withClient(fixture.environment, (client) =>
          run(client, request(advance("on-corrupt", 600_000n, null))),
        ),
      ).rejects.toBeInstanceOf(PartitionStateIntegrityError);
      expect(await commandCounts(truth, "command-on-corrupt")).toBe("0|0|0");
    });
  }, 120_000);
});
