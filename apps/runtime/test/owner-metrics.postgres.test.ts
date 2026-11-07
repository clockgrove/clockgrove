import type { RuntimeMetricPoint } from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  AutonomousScenarioDriver,
  configureAutonomousOwner,
} from "./world-owner/autonomous-parity.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/owner-metrics.postgres.test.ts";
const any = expect.any(Number);
/**
 * One world command's journal points, as `postgres-world-command.ts` records them; a kernel call's
 * events point counts the inputs it dispatched.
 */
const journal = (
  family: string,
  events: number,
  schedules: number,
  dispatches: number,
  ...inputs: number[]
) => [
  ["journal_latency_ms", family, any],
  ["lock_wait_ms", family, any],
  ["command_events_written", family, events, ...inputs],
  ["command_projection_rows_written", family, 1],
  ["command_schedules_written", family, schedules],
  ["command_dispatches_written", family, dispatches],
];
/** The points of one settled mailbox entry: wait, service and its resource counters. */
const settled = (
  kind: string,
  commands: number,
  advances: number,
  events: number,
  sql: number[],
) => [
  ["mailbox_wait_ms", kind, any],
  ["mailbox_service_ms", kind, any],
  ["activation_commands", kind, commands, advances],
  ["activation_journal_ms", kind, any, events],
  ["activation_db_transactions", kind, ...sql],
];

describe("native physical-owner runtime metrics (Wave 3 §20)", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns a finite native runtime and disposable PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "records queued commands, a late alarm continued by catch-up, one catch-up step and a rehydration",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const drain = async () =>
          (
            (await owner.request("/owner-metrics", { scope: owner.scope }))
              .body as RuntimeMetricPoint[]
          ).map(({ name, label, value, count }) =>
            count === undefined ? [name, label, value] : [name, label, value, count],
          );
        // Empty local storage; two clock commands; then the world, 1,100,000 ms behind, gets a late
        // alarm whose one-command batch hands the rest to catch-up. Its first step is held settled.
        await new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve()).start();
        await owner.request("/catch-up/configure", { scope: owner.scope, fault: "hold-result" });
        await configureAutonomousOwner(owner, 1_001_100_000n, 1, true, true);
        await waitForOwnerSql(
          owner.sql,
          "SELECT count(*) FROM clockgrove.partition_states WHERE catch_up_run_id IS NOT NULL",
          "1",
          1000,
        );
        await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true);
        await expect
          .poll(
            async () => (await owner.request("/catch-up/status", { scope: owner.scope })).body,
            {
              timeout: 30_000,
            },
          )
          .toMatchObject({ held: true });
        // Events per command in commit order, from PostgreSQL: policy, resume, alarm, catch-up step.
        const [policy, resume, alarm, step] = (
          await owner.sql(`SELECT string_agg(n::text, ',' ORDER BY first) FROM (SELECT count(*) n,
            min(journal_position) first FROM clockgrove.events
            WHERE command_id NOT LIKE 'trusted:world-provisioning:%' GROUP BY command_id) s`)
        )
          .split(",")
          .map(Number);
        // Transactions and statements are literal: the claim adds 4 and 19 to the first entry.
        const points = await drain();
        expect(points).toEqual([
          ["owner_initializations", "rehydrated", 1],
          ...journal("clock", policy!, 0, 0),
          ...settled("command", 1, 0, policy!, [7, 47]),
          ...journal("clock", resume!, 0, 0),
          ...settled("command", 1, 0, resume!, [3, 28]),
          ...settled("reconcile-alarm", 0, 0, 0, [1, 7]),
          ["alarm_lateness_ms", "planned", any],
          ["projection_lag_ms", "partition-state", 1_100_000, 1_100_000],
          // Each advance completes one decision schedule and puts its next: one input dispatched.
          ...journal("autonomous", alarm!, 2, 1, 1),
          ["alarm_batch_ms", "catch-up", any, 1],
          ...settled("alarm", 1, 1, alarm!, [12, 89]),
          ["projection_lag_ms", "partition-state", 1_040_000, 1_040_000],
          ...journal("autonomous", step!, 2, 1, 1),
          ["catch_up_step_ms", "continue", any, 1],
          ...settled("catch-up", 1, 1, step!, [11, 76]),
        ]);
        // Delivered after the wall time its plan mapped it to.
        expect(points.find(([name]) => name === "alarm_lateness_ms")?.[2]).toBeGreaterThanOrEqual(
          0,
        );

        // Local storage lost: a no-op initializes the new incarnation twice and a command claims the
        // clock owner, yet the incarnation records one rehydration.
        await owner.replace(true);
        await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true);
        const head = await owner.sql(
          `SELECT head_sequence FROM clockgrove.timeline_partitions WHERE space_id = '${owner.scope.spaceId}'`,
        );
        const noOp = await owner.request("/v1/runtime/no-op", {
          ...owner.scope,
          commandId: "metrics-noop",
          actionId: "metrics-noop",
          eventId: "metrics-noop",
          authorityDecisionId: "metrics-noop",
          routingEpoch: "1",
          authorityEpoch: "1",
          expectedProjectionRevision: head,
          issuedAt: "2026-10-01T00:00:00.000Z",
        });
        expect(noOp).toMatchObject({ status: 200, body: { disposition: "rehydrated" } });
        const pause = advanceCommand(owner.world, "metrics-pause", 0n, null);
        expect(
          (await owner.submit({ ...pause, type: "PauseWorld", payload: { schemaVersion: 1 } }))
            .status,
        ).toBe(200);
        expect(await drain()).toEqual([
          ["owner_initializations", "rehydrated", 1],
          ...journal("clock", 1, 0, 0),
          ...settled("command", 1, 0, 1, [7, 47]),
        ]);
      });
    },
    120_000,
  );
});
