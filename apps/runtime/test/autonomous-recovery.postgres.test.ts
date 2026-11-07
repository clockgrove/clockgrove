import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  AutonomousScenarioDriver,
  autonomousQuiescent,
  configureAutonomousOwner,
  nativeAlarmStatus,
} from "./world-owner/autonomous-parity.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/autonomous-recovery.postgres.test.ts";

describe("native committed alarm recovery", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns disposable PostgreSQL and the bounded native process",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );
  it.skipIf(!isNativeWorldOwnerChild())(
    "advances after Resume without a client session or subsequent HTTP requests",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        await configureAutonomousOwner(owner, undefined, 1, true);
        for (const [type, payload] of [
          [
            "SetClockPolicy",
            {
              schemaVersion: 1,
              simulationMillisecondsPerWallMillisecond: 1_000_000,
              catchUpCapMs: 1_000_000n,
            },
          ],
          ["ResumeWorld", { schemaVersion: 1 }],
        ] as const) {
          const response = await owner.submit({
            ...advanceCommand(owner.world, `headless-${type}`, 0n, null),
            type,
            payload,
          });
          expect(response.status).toBe(200);
        }
        await owner.sql("UPDATE clockgrove_auth.session SET \"expiresAt\"='1970-01-01'");
        const next =
          BigInt(await owner.sql("SELECT simulation_time::text FROM clockgrove.partition_states")) +
          owner.world.behavior.policy.decisionIntervalMs;
        await waitForOwnerSql(
          owner.sql,
          `SELECT CASE WHEN simulation_time >= ${next} THEN 'advanced' ELSE 'waiting' END FROM clockgrove.partition_states`,
          "advanced",
        );
        expect(
          await owner.sql(
            'SELECT count(*)::text FROM clockgrove_auth.session WHERE "expiresAt" > now()',
          ),
        ).toBe("0");
      });
    },
    180_000,
  );
  it.skipIf(!isNativeWorldOwnerChild())(
    "retains physical commits and admissions across interruption before reconciliation",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        const driver = new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve());
        await driver.start();
        const initial = await owner.sql("SELECT revision::text FROM clockgrove.partition_states");
        const initialCommands = BigInt(
          await owner.sql(
            "SELECT count(*)::text FROM clockgrove.command_receipts WHERE status='committed'",
          ),
        );
        const through = owner.world.birth.state.simulationTime + 60_000n;
        await configureAutonomousOwner(owner, 1_000_060_000n, 1, false);
        expect((await owner.request("/autonomous/interrupt", { scope: owner.scope })).status).toBe(
          200,
        );
        for (
          let attempt = 0;
          attempt < 1000 && (await nativeAlarmStatus(owner)).interruptions !== 1;
          attempt++
        )
          await delay(10);
        expect((await nativeAlarmStatus(owner)).interruptions).toBe(1);
        expect(
          await owner.sql("SELECT simulation_time::text FROM clockgrove.partition_states"),
        ).toBe("100000");
        expect(
          await owner.sql(
            "SELECT count(*)::text FROM clockgrove.command_receipts WHERE status='committed'",
          ),
        ).toBe((initialCommands + 1n).toString());
        expect(initial).toBe("0");
        const committed = await owner.sql(
          "SELECT jsonb_build_object('hash',state_hash,'revision',revision,'horizon',clock_admitted_horizon)::text FROM clockgrove.partition_states",
        );
        const admission = await owner.sql(
          "SELECT sum(admitted)::text FROM clockgrove.clock_admissions",
        );
        expect(admission).toBe("60000");
        await owner.replace(false);
        expect(
          await owner.sql(
            "SELECT jsonb_build_object('hash',state_hash,'revision',revision,'horizon',clock_admitted_horizon)::text FROM clockgrove.partition_states",
          ),
        ).toBe(committed);
        await configureAutonomousOwner(owner, 1_000_060_000n, 1, true);
        for (
          let attempt = 0;
          attempt < 1000 && !(await autonomousQuiescent(owner, through));
          attempt++
        )
          await delay(10);
        expect(await autonomousQuiescent(owner, through)).toBe(true);
        expect(
          await owner.sql(
            "SELECT COALESCE(continuation_command_id,'none') FROM clockgrove.partition_states",
          ),
        ).toBe("none");
        // Covered receipts retire; the durable horizon proves recovery admitted nothing more.
        expect(
          await owner.sql("SELECT clock_admitted_horizon::text FROM clockgrove.partition_states"),
        ).toBe(through.toString());
        const recovered = await owner.sql("SELECT state_hash FROM clockgrove.partition_states");
        await owner.reset();
        const uninterrupted = new AutonomousScenarioDriver(
          owner,
          "frequent-alarms",
          Promise.resolve(),
        );
        await uninterrupted.start();
        await configureAutonomousOwner(owner, 1_000_060_000n, 1, true);
        for (
          let attempt = 0;
          attempt < 1000 && !(await autonomousQuiescent(owner, through));
          attempt++
        )
          await delay(10);
        expect(await autonomousQuiescent(owner, through)).toBe(true);
        expect(await owner.sql("SELECT state_hash FROM clockgrove.partition_states")).toBe(
          recovered,
        );
      });
    },
    180_000,
  );
});
