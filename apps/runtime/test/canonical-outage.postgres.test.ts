import {
  type CausalCommandView,
  decodeCanonicalNode,
  type WorldCommandResult,
} from "@clockgrove/application";
import { type CommandEnvelope, decodeOpaqueId } from "@clockgrove/contracts";
import { withClientTransaction } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
import { stableWorkflowInstanceId } from "../src/routing.js";
import {
  advanceCommand,
  commandCounts,
  kernelModel,
  pureStep,
  stateHash,
} from "./world-fixture.js";
import {
  AutonomousScenarioDriver,
  autonomousQuiescent,
  configureAutonomousOwner,
  nativeAlarmStatus,
} from "./world-owner/autonomous-parity.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  type NativeWorldOwner,
  runNativeWorldOwnerProcess,
  waitForNativeWorkflow,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/canonical-outage.postgres.test.ts";
const RUNTIME = "FROM pg_stat_activity WHERE usename='clockgrove_runtime'";
/** Holds the canonical role's next journal write (a revision change) open for `seconds`, once. */
const hold = (name: string, seconds: number) =>
  `CREATE SEQUENCE public.${name}; GRANT USAGE ON SEQUENCE public.${name} TO clockgrove_runtime;
   CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
     IF NEW.revision <> OLD.revision THEN
       IF nextval('public.${name}') = 1 THEN PERFORM pg_sleep(${seconds}); END IF;
     END IF;
     RETURN NEW;
   END $$;
   CREATE TRIGGER ${name} BEFORE UPDATE ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION public.${name}()`;
/**
 * The outage: PostgreSQL refuses every new canonical-role connection (role connection limit 0,
 * SQLSTATE 53300) and terminates every open one, the held transaction included (57P01). The
 * authentication and authorization readers use their own roles, so requests still reach the owners.
 */
const OUTAGE = `ALTER ROLE clockgrove_runtime CONNECTION LIMIT 0; SELECT count(pg_terminate_backend(pid)) ${RUNTIME}`;
const RESTORE = "ALTER ROLE clockgrove_runtime CONNECTION LIMIT -1";
const FAILED = { status: 500, body: { error: "world_command_failed" } };
const OPEN = "SELECT count(*) FROM clockgrove.partition_states WHERE catch_up_run_id IS NOT NULL";
/** What the world committed: its state hash, semantic events, trusted receipts and dispatch intents. */
const SEMANTIC =
  "SELECT jsonb_build_object('hash',(SELECT state_hash FROM clockgrove.partition_states),'events',(SELECT jsonb_agg(jsonb_build_array(event_type,simulation_time,payload) ORDER BY partition_sequence) FROM clockgrove.events WHERE event_type NOT IN ('WorldClockPolicySet','WorldResumed')),'dispatches',(SELECT count(*) FROM clockgrove.event_dispatches)," +
  "'receipts',(SELECT jsonb_agg(jsonb_build_array(command_id,status,canonical_event_ids) ORDER BY command_id) FROM clockgrove.command_receipts WHERE command_id LIKE 'trusted:%'))::text";

/** Waits for the held write, takes PostgreSQL away, and returns the durable rows from before. */
async function outage(owner: NativeWorldOwner): Promise<string> {
  await waitForOwnerSql(
    owner.sql,
    `SELECT count(*) ${RUNTIME} AND wait_event='PgSleep'`,
    "1",
    1000,
  );
  const before = await owner.durable();
  await owner.sql(OUTAGE);
  return before;
}

/** A sleeping world woken at a later wall time, from PostgreSQL's provisioned state. */
async function wake(owner: NativeWorldOwner, wallTime: bigint, catchUp: boolean) {
  await owner.reset();
  await new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve()).start();
  return () => configureAutonomousOwner(owner, wallTime, 1, true, catchUp);
}

describe("canonical-database outage (Wave 3 §17)", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the native process and disposable PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "fails a world command with a stable code before and after its journal commit, refuses inspection unaudited, and recovers by its alarm",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, sql } = owner;
        const model = kernelModel(world);
        const expected = async (command: CommandEnvelope<string, unknown>) => {
          const pure = pureStep(world, model, command);
          return {
            counts: `1|1|${pure.events.length}`,
            value: {
              status: "committed",
              revision: model.state.revision.toString(),
              simulationTime: model.state.simulationTime.toString(),
              complete: pure.complete,
              eventCount: pure.events.length,
              stateHash: await stateHash(model.state),
            },
          };
        };
        const value = (response: { readonly body: unknown }) =>
          (decodeCanonicalNode(canonicalResponse(response.body)) as WorldCommandResult).value;
        // The owner set its recovery alarm before journal work. That alarm fails during the outage
        // and, once PostgreSQL returns, completes and reconciles with no client request.
        const alarms = async () => {
          const { alarm, deliveries, completed } = await nativeAlarmStatus(owner);
          return { set: alarm !== null, failed: deliveries > completed, completed };
        };
        const recoverByAlarm = async () => {
          await expect.poll(alarms, { timeout: 30_000 }).toMatchObject({ failed: true });
          const { completed } = await alarms();
          await sql(RESTORE);
          await expect
            .poll(alarms, { timeout: 30_000 })
            .toMatchObject({ set: false, completed: completed + 1 });
        };
        await sql(
          "UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-inspect')",
        );

        // Before commit: the held journal transaction is terminated and the exact retry is refused.
        const before = advanceCommand(world, "outage-before", 120_000n, null);
        await sql(hold("outage_before", 8));
        const pending = owner.submit(before);
        const unchanged = await outage(owner);
        expect(await pending).toEqual(FAILED);
        expect(await owner.submit(before)).toEqual(FAILED);
        expect(await owner.durable()).toBe(unchanged);
        expect(await commandCounts(sql, before.commandId)).toBe("0|0|0");
        await recoverByAlarm();
        const first = await expected(before);
        const retried = await owner.submit(before);
        expect({ status: retried.status, value: value(retried) }).toEqual({
          status: 200,
          value: first.value,
        });
        expect(await commandCounts(sql, before.commandId)).toBe(first.counts);

        // After commit, before the response: the owner's next read waits behind a lock until the
        // outage ends its connection. The command committed once; its client gets the same code.
        const after = advanceCommand(world, "outage-after", 180_000n, null);
        const second = await expected(after);
        await sql(hold("outage_after", 2));
        const response = owner.submit(after);
        await waitForOwnerSql(sql, `SELECT count(*) ${RUNTIME} AND wait_event='PgSleep'`, "1");
        await owner.withSqlClient((client) =>
          withClientTransaction(client, {}, async () => {
            const locked = client.query(
              "LOCK TABLE clockgrove.partition_states IN ACCESS EXCLUSIVE MODE",
            );
            await waitForOwnerSql(
              sql,
              `SELECT count(*) ${RUNTIME} AND wait_event_type='Lock'`,
              "1",
              1000,
            );
            expect(await commandCounts(sql, after.commandId)).toBe(second.counts);
            await sql(OUTAGE);
            await locked;
          }),
        );
        expect(await response).toEqual(FAILED);
        const committed = await owner.durable();
        expect(await owner.submit(after)).toEqual(FAILED);
        // Inspection while PostgreSQL is away: no view, no audit row (runtime.md, causal-chain inspector).
        const chain = () =>
          owner.request("/v1/runtime/causal-chain", {
            schemaVersion: 1,
            ...owner.scope,
            commandId: after.commandId,
          });
        const audit =
          "SELECT count(*) || '|' || coalesce(string_agg(decision || ':' || reason_code, ','), '') FROM clockgrove.inspector_accesses";
        expect(await chain()).toEqual({ status: 503, body: { error: "inspector_unavailable" } });
        expect(await sql(audit)).toBe("0|");
        expect(await owner.durable()).toBe(committed);
        await recoverByAlarm();
        const stored = await owner.submit(after);
        expect({ status: stored.status, value: value(stored) }).toEqual({
          status: 200,
          value: second.value,
        });
        expect(await owner.durable()).toBe(committed);
        expect(await commandCounts(sql, after.commandId)).toBe(second.counts);
        const served = await chain();
        expect(served.status).toBe(200);
        expect(
          (decodeCanonicalNode(canonicalResponse(served.body)) as CausalCommandView).receipt,
        ).toMatchObject({ commandId: after.commandId, status: "committed" });
        expect(await sql(audit)).toBe("1|allow:served");
        expect(await sql("SELECT state_hash FROM clockgrove.partition_states")).toBe(
          await stateHash(model.state),
        );
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "resumes alarm activations from the alarm after PostgreSQL fails one mid-transaction and refuses its retries, ending on the uninterrupted state",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const through = owner.world.birth.state.simulationTime + 60_000n;
        const run = async (inject: boolean) => {
          const start = await wake(owner, 1_000_060_000n, false);
          if (inject) await owner.sql(hold("outage_alarm", 8));
          await start();
          if (inject) {
            const unchanged = await outage(owner);
            const { deliveries, completed } = await nativeAlarmStatus(owner);
            await expect
              .poll(async () => (await nativeAlarmStatus(owner)).deliveries, { timeout: 30_000 })
              .toBeGreaterThan(deliveries + 1);
            expect((await nativeAlarmStatus(owner)).completed).toBe(completed);
            expect(await owner.durable()).toBe(unchanged);
            await owner.sql(RESTORE);
          }
          await expect
            .poll(() => autonomousQuiescent(owner, through), { timeout: 60_000 })
            .toBe(true);
          return owner.sql(SEMANTIC);
        };
        const interrupted = await run(true);
        expect(interrupted).toBe(await run(false));
      });
    },
    180_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "resumes a catch-up Workflow step by scheduled reconciliation after PostgreSQL fails it mid-transaction and refuses its retries, ending on the uninterrupted state",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const status = async () =>
          (await owner.request("/catch-up/status", { scope: owner.scope })).body;
        const run = async (inject: boolean) => {
          const start = await wake(owner, 1_001_100_000n, true);
          const fault = inject ? "hold-result" : "none";
          await owner.request("/catch-up/configure", { scope: owner.scope, fault });
          // As the native catch-up journey: one alarm attempt leaves due work for the Workflow.
          await start();
          await waitForOwnerSql(owner.sql, OPEN, "1", 1000);
          await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true);
          const runId = await owner.sql("SELECT catch_up_run_id FROM clockgrove.partition_states");
          const instanceId = await stableWorkflowInstanceId(
            "WorldCatchUpWorkflow",
            decodeOpaqueId(runId, "RunId"),
          );
          if (inject) {
            // The first step has committed; the next one is held, then fails with the outage.
            await expect.poll(status, { timeout: 30_000 }).toMatchObject({ held: true });
            await owner.sql(hold("outage_catch_up", 8));
            await owner.request("/catch-up/release", { scope: owner.scope });
            const unchanged = await outage(owner);
            // Every native retry (no delay in this fixture) is refused, so the Workflow errors.
            await waitForNativeWorkflow(owner, instanceId, "errored", "catch-up");
            expect(await owner.durable()).toBe(unchanged);
            expect(await owner.sql(OPEN)).toBe("1");
            await owner.sql(RESTORE);
            await owner.reconcileDispatches();
          }
          await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
          await waitForOwnerSql(owner.sql, OPEN, "0", 1000);
          return owner.sql(SEMANTIC);
        };
        const interrupted = await run(true);
        expect(interrupted).toBe(await run(false));
      });
    },
    180_000,
  );
});
