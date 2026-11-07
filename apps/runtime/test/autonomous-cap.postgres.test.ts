import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { advanceCommand, kernelModel, pureStep, stateHash } from "./world-fixture.js";
import {
  AutonomousScenarioDriver,
  autonomousQuiescent,
  configureAutonomousOwner,
  nativeAlarmStatus,
} from "./world-owner/autonomous-parity.js";
import {
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/autonomous-cap.postgres.test.ts";

describe("native one millisecond admission cap", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the bounded native process and disposable PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "retains unused admission and finishes an immutable continuation after cap reduction and runtime loss",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        await owner.reset();
        await new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve()).start();
        await configureAutonomousOwner(owner, 1_000_000_001n, 1, false);
        expect(
          (
            await owner.submit({
              ...advanceCommand(owner.world, "native-unused-cap", 0n, null),
              type: "SetClockPolicy",
              payload: {
                schemaVersion: 1,
                simulationMillisecondsPerWallMillisecond: 1,
                catchUpCapMs: 1n,
              },
            })
          ).status,
        ).toBe(200);
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
        expect((await nativeAlarmStatus(owner)).worldAlarm).toBeNull();
        expect(
          await owner.sql(
            "SELECT simulation_time::text || '|' || clock_admitted_horizon::text || '|' || (SELECT sum(admitted)::text FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
          ),
        ).toBe("100000|100001|1");
        await owner.replace(true);
        await configureAutonomousOwner(owner, 1_000_000_001n, 1, false);
        expect((await nativeAlarmStatus(owner)).alarm).toBeNull();
        expect((await nativeAlarmStatus(owner)).worldAlarm).toBeNull();
        expect(
          await owner.sql(
            "SELECT simulation_time::text || '|' || clock_admitted_horizon::text || '|' || (SELECT sum(admitted)::text FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
          ),
        ).toBe("100000|100001|1");
        await owner.reset();
        await new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve()).start();
        const accepted = advanceCommand(owner.world, "native-cap-origin", 1_200_000n, null, {
          maxInputs: 1,
          maxEvents: 256,
        });
        expect((await owner.submit(accepted)).status).toBe(200);
        const pending = (await inspectNativeWorldOwner(owner)).partition;
        const open = pending.continuation;
        if (open === undefined) throw new Error("expected an accepted public continuation");
        const origin = open.record.originCommand;
        const model = kernelModel(owner.world);
        // The deadline due at birth time ran first: client commands run after catch-up.
        pureStep(owner.world, model, advanceCommand(owner.world, "catch-up", 100_000n, null));
        let step = pureStep(owner.world, model, origin);
        expect(step.complete).toBe(false);
        expect(pending.document).toEqual({
          state: model.state,
          schedules: model.schedules,
          randomState: model.random,
        });
        expect(open.record.continuation).toEqual(step.continuation);
        expect(open.record.originCommand).toEqual({
          ...accepted,
          attribution: {
            ...accepted.attribution,
            principalId: "principal-runtime",
            worldMembershipId: "membership-runtime",
            personaId: "persona-runtime",
          },
        });
        expect(origin.payload).toEqual({
          schemaVersion: 1,
          targetTime: 1_200_000n,
          maxInputs: 1,
          maxEvents: 256,
        });

        await configureAutonomousOwner(owner, 1_000_000_001n, 1, false);
        expect(
          (
            await owner.submit({
              ...advanceCommand(owner.world, "native-cap-reduce", 0n, null),
              type: "SetClockPolicy",
              payload: {
                schemaVersion: 1,
                simulationMillisecondsPerWallMillisecond: 1,
                catchUpCapMs: 1n,
              },
            })
          ).status,
        ).toBe(200);
        const reduced = (await inspectNativeWorldOwner(owner)).partition;
        expect(reduced.clockPolicy?.catchUpCapMs).toBe(1n);
        expect(reduced.continuation).toEqual(open);
        expect(reduced.document).toEqual(pending.document);

        await configureAutonomousOwner(owner, 1_000_000_002n, 1, false);
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
        step = pureStep(owner.world, model, origin, origin, open.record.continuation);
        const interrupted = (await inspectNativeWorldOwner(owner)).partition;
        expect(interrupted.document).toEqual({
          state: model.state,
          schedules: model.schedules,
          randomState: model.random,
        });
        expect(interrupted.continuation?.record.originCommand).toEqual(origin);
        expect(interrupted.continuation?.record.continuation).toEqual(step.continuation);
        expect(model.state.simulationTime).toBe(220_000n);
        expect(
          await owner.sql(
            "SELECT clock_admitted_horizon::text || '|' || (SELECT sum(admitted)::text FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
          ),
        ).toBe("160101|1");

        await owner.replace(true);
        await configureAutonomousOwner(owner, 1_000_000_002n, 1, false);
        const recovered = (await inspectNativeWorldOwner(owner)).partition;
        expect(recovered.document).toEqual(interrupted.document);
        expect(recovered.continuation).toEqual(interrupted.continuation);
        expect(
          await owner.sql(
            "SELECT clock_admitted_horizon::text || '|' || (SELECT sum(admitted)::text FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
          ),
        ).toBe("160101|1");
        let chunks = 0;
        while (!step.complete && chunks < 32) {
          if (step.continuation === undefined)
            throw new Error("incomplete pure continuation lost its cursor");
          step = pureStep(owner.world, model, origin, origin, step.continuation);
          chunks += 1;
        }
        expect(step.complete).toBe(true);
        expect(model.state.simulationTime).toBe(1_200_000n);
        const committed = async () =>
          Number(
            await owner.sql(
              "SELECT count(*)::text FROM clockgrove.command_receipts WHERE status='committed'",
            ),
          );
        const before = await committed();
        await configureAutonomousOwner(owner, 1_000_000_002n, 1, true);
        // An alarm that spends its start budget (`startWithinMs`, counted from delivery) before its
        // first attempt commits nothing and asks for another: a slow start, or the 1 s recovery alarm
        // firing behind a reconciliation that outlasts it. So deliveries may exceed the chunks;
        // every delivery completes and each chunk commits once. The closing delivery is counted before
        // it commits, so once the journal is quiescent equal counts mean it has finished.
        const settled = async () => {
          if (!(await autonomousQuiescent(owner, model.state.simulationTime))) return false;
          const { deliveries, completed } = await nativeAlarmStatus(owner);
          return deliveries === completed;
        };
        for (let attempt = 0; attempt < 1000 && !(await settled()); attempt++) await delay(10);
        expect(await settled()).toBe(true);
        expect(await committed()).toBe(before + chunks);
        const finished = (await inspectNativeWorldOwner(owner)).partition;
        expect(finished.continuation).toBeUndefined();
        expect(finished.document).toEqual({
          state: model.state,
          schedules: model.schedules,
          randomState: model.random,
        });
        expect(finished.document.state.simulationTime).toBe(1_200_000n);
        expect(await owner.sql("SELECT state_hash FROM clockgrove.partition_states")).toBe(
          await stateHash(model.state),
        );
        // Covered receipts retire: later activations admitted nothing ahead of committed time.
        expect(
          await owner.sql(
            "SELECT (clock_admitted_horizon <= simulation_time)::text || '|' || (SELECT sum(admitted)::text FROM clockgrove.clock_admissions) FROM clockgrove.partition_states",
          ),
        ).toBe("true|0");
      });
    },
    180_000,
  );
});
