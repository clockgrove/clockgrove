import {
  decodeCatchUpWorkflowEnvelope,
  encodeProvisioningSource,
  type LifecycleWorkflowEnvelope,
} from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import { stableWorkflowInstanceId } from "../src/routing.js";
import { advanceCommand, provisioningRequest, testWorld } from "./world-fixture.js";
import {
  AutonomousScenarioDriver,
  configureAutonomousOwner,
} from "./world-owner/autonomous-parity.js";
import {
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  type NativeWorldOwner,
  runNativeWorldOwnerProcess,
  waitForNativeWorkflow,
  waitForOwnerSql,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/durable-catch-up.postgres.test.ts";
const OPEN = "SELECT count(*) FROM clockgrove.partition_states WHERE catch_up_run_id IS NOT NULL";
const FINISHED =
  "SELECT clock_admitted_horizon::text || '|' || COALESCE(continuation_command_id,'none') || '|' || (catch_up_run_id IS NULL AND catch_up_owner_generation IS NULL AND catch_up_policy_version IS NULL AND catch_up_wall_time IS NULL AND catch_up_step IS NULL AND catch_up_reconcile_attempted_at IS NULL)::text FROM clockgrove.partition_states";

async function startNativeCatchUp(owner: NativeWorldOwner, fault: string, cap?: bigint) {
  await owner.reset();
  await new AutonomousScenarioDriver(owner, "frequent-alarms", Promise.resolve()).start();
  if (cap !== undefined)
    expect(
      (
        await owner.submit({
          ...advanceCommand(owner.world, "catch-up-cap", 0n, null),
          type: "SetClockPolicy",
          payload: {
            schemaVersion: 1,
            simulationMillisecondsPerWallMillisecond: 1,
            catchUpCapMs: cap,
          },
        })
      ).status,
    ).toBe(200);
  expect((await owner.request("/catch-up/configure", { scope: owner.scope, fault })).status).toBe(
    200,
  );
  // The same 1,200,000 target as the existing native cap/continuation journey; one alarm attempt
  // guarantees remaining due work crosses the escalation boundary. Without the start budget that
  // attempt and its cap admission always run, as does each catch-up step's one attempt: on a loaded
  // host an alarm reaching its first attempt after `startWithinMs` escalates having admitted nothing.
  await configureAutonomousOwner(owner, 1_001_100_000n, 1, true, true, false);
  await waitForOwnerSql(owner.sql, OPEN, "1", 1000);
  await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
  const envelope = decodeCatchUpWorkflowEnvelope(
    JSON.parse(
      await owner.sql(
        "SELECT jsonb_build_object('version',1,'tenantId',tenant_id,'worldId',world_id,'timelineId',timeline_id,'spaceId',space_id,'applicationRunId',catch_up_run_id)::text FROM clockgrove.partition_states",
      ),
    ),
  );
  const instanceId = await stableWorkflowInstanceId(
    "WorldCatchUpWorkflow",
    envelope.applicationRunId,
  );
  return { envelope, instanceId };
}

describe("native durable sleeping-world catch-up", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns finite native Workflows and disposable PostgreSQL",
    async () => {
      await runNativeWorldOwnerProcess(FILE);
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "redelivers canonical commits and reconstructs progress after compatible replacement and local history loss",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { envelope, instanceId } = await startNativeCatchUp(owner, "after-commit-once");
        await waitForOwnerSql(owner.sql, OPEN, "0", 1000);
        await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
        expect(
          (await owner.request("/catch-up/status", { scope: owner.scope })).body,
        ).toMatchObject({ interruptions: 1, held: false });
        expect(await owner.sql(FINISHED)).toBe("1200000|none|true");
        expect(
          await owner.sql(
            "SELECT string_agg(DISTINCT attribution->>'effectiveActorId', ',') FROM clockgrove.events WHERE command_id LIKE 'trusted:advance:%'",
          ),
        ).toBe("clockgrove:due-work");
        expect(
          await owner.sql(
            "SELECT string_agg(DISTINCT inputs->>'principalId', ',') FROM clockgrove.authority_decisions WHERE command_id LIKE 'trusted:advance:%'",
          ),
        ).toBe(`system:world:${owner.scope.worldId}`);
        expect(
          await owner.sql(
            "SELECT string_agg(DISTINCT partition_id, ',') FROM clockgrove.events WHERE command_id LIKE 'trusted:advance:%'",
          ),
        ).toBe(`${owner.world.birth.world.partitionId}:${owner.scope.spaceId}`);
        const committed = await owner.durable();
        expect(
          await owner.request("/provisioning/raw", {
            id: "catch-up-redelivery",
            workflow: "catch-up",
            params: envelope,
          }),
        ).toEqual({ status: 200, body: { id: "catch-up-redelivery" } });
        await waitForNativeWorkflow(owner, "catch-up-redelivery", "complete", "catch-up");
        expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
        for (const loseLocal of [false, true]) {
          await owner.replace(loseLocal);
          await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
          await owner.reconcileDispatches();
          expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
          expect(await owner.sql(FINISHED)).toBe("1200000|none|true");
        }
        const recovered = (await inspectNativeWorldOwner(owner)).partition.document;
        const semanticEvents = await owner.sql(
          "SELECT jsonb_agg(jsonb_build_array(event_type,simulation_time,payload) ORDER BY partition_sequence)::text FROM clockgrove.events WHERE event_type NOT IN ('WorldClockPolicySet','WorldResumed')",
        );
        const continuous = await startNativeCatchUp(owner, "outage");
        await waitForNativeWorkflow(owner, continuous.instanceId, "errored", "catch-up");
        await owner.replace(true);
        await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
        await owner.reconcileDispatches();
        await waitForOwnerSql(owner.sql, OPEN, "0", 1000);
        expect((await inspectNativeWorldOwner(owner)).partition.document).toEqual(recovered);
        expect(
          await owner.sql(
            "SELECT jsonb_agg(jsonb_build_array(event_type,simulation_time,payload) ORDER BY partition_sequence)::text FROM clockgrove.events WHERE event_type NOT IN ('WorldClockPolicySet','WorldResumed')",
          ),
        ).toBe(semanticEvents);
        expect(await owner.sql(FINISHED)).toBe("1200000|none|true");
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "retries a physical commit before its cursor commit without readmitting the cap or permitting a competing explicit advance",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        // The existing recovery journey's 60,000ms admission, now smaller than the sleeping backlog.
        const { instanceId } = await startNativeCatchUp(owner, "outage", 60_000n);
        await waitForNativeWorkflow(owner, instanceId, "errored", "catch-up");
        expect(
          await owner.sql("SELECT clock_admitted_horizon::text FROM clockgrove.partition_states"),
        ).toBe("160000");
        await owner.sql(`CREATE SEQUENCE public.catch_up_cursor_failure;
          GRANT USAGE ON SEQUENCE public.catch_up_cursor_failure TO clockgrove_runtime;
          CREATE FUNCTION public.fail_catch_up_cursor_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.catch_up_step > OLD.catch_up_step AND nextval('public.catch_up_cursor_failure') = 1 THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='native commit cursor interruption'; END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER native_catch_up_cursor_failure BEFORE UPDATE OF catch_up_step ON clockgrove.partition_states FOR EACH ROW EXECUTE FUNCTION public.fail_catch_up_cursor_once()`);
        await owner.request("/catch-up/configure", { scope: owner.scope, fault: "hold-failure" });
        await owner.reconcileDispatches();
        await expect
          .poll(
            async () => (await owner.request("/catch-up/status", { scope: owner.scope })).body,
            { timeout: 30_000 },
          )
          .toMatchObject({ held: true, interruptions: 1 });
        expect(
          await owner.sql(
            "SELECT catch_up_step::text || '|' || clock_admitted_horizon::text FROM clockgrove.partition_states",
          ),
        ).toBe("0|220000");
        const committed = await owner.durable();
        expect((await owner.request("/advance-clock", owner.scope)).status).toBe(200);
        expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
        await owner.request("/catch-up/release", { scope: owner.scope });
        await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
        expect(await owner.sql(FINISHED)).toBe("1180000|none|true");
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "recovers an actually exhausted native Workflow by scheduled reconciliation alone after PostgreSQL returns",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { envelope, instanceId } = await startNativeCatchUp(owner, "hold-result");
        await expect
          .poll(
            async () => (await owner.request("/catch-up/status", { scope: owner.scope })).body,
            { timeout: 30_000 },
          )
          .toMatchObject({ held: true });
        await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
        const accepted = await owner.sql(
          "SELECT catch_up_run_id || '|' || catch_up_wall_time::text FROM clockgrove.partition_states",
        );
        await owner.sql("ALTER ROLE clockgrove_runtime NOLOGIN");
        try {
          await owner.request("/catch-up/release", { scope: owner.scope });
          await waitForNativeWorkflow(owner, instanceId, "errored", "catch-up");
          // One successful step, then six failed attempts under the existing five-retry policy.
          expect((await owner.request("/catch-up/status", { scope: owner.scope })).body).toEqual({
            calls: 7,
            interruptions: 0,
            held: false,
          });
          expect(await owner.sql(OPEN)).toBe("1");
          expect(
            await owner.sql(
              "SELECT catch_up_run_id || '|' || catch_up_wall_time::text FROM clockgrove.partition_states",
            ),
          ).toBe(accepted);
        } finally {
          await owner.sql("ALTER ROLE clockgrove_runtime LOGIN");
        }
        await owner.reconcileDispatches();
        await waitForOwnerSql(owner.sql, OPEN, "0", 1000);
        await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
        expect(await owner.sql(FINISHED)).toBe("1200000|none|true");
        const committed = await owner.durable();
        expect(await owner.request("/catch-up/deliver", { scope: owner.scope, envelope })).toEqual({
          status: 200,
          body: { disposition: "superseded" },
        });
        expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "isolates a failed catch-up candidate from exhausted provisioning recovery and the next scheduled catch-up retry",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { envelope, instanceId } = await startNativeCatchUp(owner, "outage");
        await waitForNativeWorkflow(owner, instanceId, "errored", "catch-up");
        const birth = await testWorld("lamp-yard");
        await owner.sql(`INSERT INTO clockgrove.tenants (tenant_id,display_name) VALUES ('${birth.birth.world.tenantId}','mixed recovery') ON CONFLICT DO NOTHING;
          INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id) VALUES ('${birth.birth.world.tenantId}','principal-runtime') ON CONFLICT DO NOTHING`);
        const launched = await owner.request("/provisioning/launch", {
          request: encodeProvisioningSource(
            provisioningRequest(
              birth,
              "principal-runtime",
              "native-exhausted:projection-verified:before-commit",
            ),
          ),
          applicationRunId: "mixed-recovery-birth",
        });
        expect(launched.status).toBe(200);
        const launch = launched.body as {
          readonly envelope: LifecycleWorkflowEnvelope;
          readonly instanceId: string;
          readonly readinessInstanceId: string;
        };
        await waitForNativeWorkflow(owner, launch.instanceId, "errored");
        await owner.replace(false, true);
        expect(
          await owner.request("/catch-up/reconciliation-failure", {
            applicationRunId: envelope.applicationRunId,
          }),
        ).toEqual({ status: 200, body: { applicationRunId: envelope.applicationRunId } });
        expect(await owner.reconcileDispatches(), JSON.stringify(owner.logs())).toEqual({
          outcome: "exception",
          noRetry: false,
        });
        const first = (await owner.request("/catch-up/reconciliation-status", {})).body;
        expect(first).toMatchObject({
          catchUpAttempts: [
            { applicationRunId: envelope.applicationRunId, outcome: "provider-outage" },
          ],
        });
        await waitForNativeWorkflow(owner, launch.instanceId, "complete");
        await waitForNativeWorkflow(owner, launch.readinessInstanceId, "complete", "readiness");
        expect(
          await owner.sql(
            `SELECT count(*) FROM clockgrove.worlds WHERE tenant_id='${birth.birth.world.tenantId}' AND world_id='${birth.birth.world.worldId}' AND lifecycle_status='ready'`,
          ),
        ).toBe("1");
        expect(await owner.sql(OPEN)).toBe("1");
        expect(await owner.request("/catch-up/reconciliation-failure", {})).toEqual({
          status: 200,
          body: { applicationRunId: null },
        });
        expect(await owner.reconcileDispatches(), JSON.stringify(owner.logs())).toEqual({
          outcome: "exception",
          noRetry: false,
        });
        expect((await owner.request("/catch-up/reconciliation-status", {})).body).toMatchObject({
          catchUpAttempts: [{ applicationRunId: envelope.applicationRunId, outcome: "created" }],
        });
        await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
        expect(await owner.sql(OPEN)).toBe("0");
        expect(
          await owner.sql(
            `SELECT count(*) FROM clockgrove.events WHERE tenant_id='${birth.birth.world.tenantId}' AND event_type='WorldReady'`,
          ),
        ).toBe("1");
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "replaces an owner while its old native step holds a result or failure and resumes the same accepted operation",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        for (const fault of ["hold-result", "hold-error"] as const) {
          const { envelope, instanceId } = await startNativeCatchUp(owner, fault);
          await expect
            .poll(
              async () => (await owner.request("/catch-up/status", { scope: owner.scope })).body,
              { timeout: 30_000 },
            )
            .toMatchObject({ held: true });
          const generation = BigInt(
            await owner.sql("SELECT clock_owner_generation::text FROM clockgrove.partition_states"),
          );
          const committed = (await inspectNativeWorldOwner(owner)).partition.document;
          await owner.replace(fault === "hold-error");
          await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
          expect((await inspectNativeWorldOwner(owner)).partition.document).toEqual(committed);
          expect(await owner.sql("SELECT catch_up_run_id FROM clockgrove.partition_states")).toBe(
            envelope.applicationRunId,
          );
          await owner.reconcileDispatches();
          await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
          expect(
            await owner.sql("SELECT clock_owner_generation::text FROM clockgrove.partition_states"),
          ).toBe((generation + 1n).toString());
          expect(await owner.sql(FINISHED)).toBe("1200000|none|true");
          const replacementIntent = await owner.sql(
            "SELECT jsonb_build_array(clock_owner_generation,clock_admitted_horizon,catch_up_run_id)::text FROM clockgrove.partition_states",
          );
          await owner.reconcileDispatches();
          expect(
            await owner.sql(
              "SELECT jsonb_build_array(clock_owner_generation,clock_admitted_horizon,catch_up_run_id)::text FROM clockgrove.partition_states",
            ),
          ).toBe(replacementIntent);
        }
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "fences late results and failures after pause and policy supersession without losing admission",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        for (const transition of ["pause", "policy"] as const) {
          for (const fault of ["hold-result", "hold-error"] as const) {
            const { instanceId } = await startNativeCatchUp(owner, fault);
            await expect
              .poll(
                async () => (await owner.request("/catch-up/status", { scope: owner.scope })).body,
                { timeout: 30_000 },
              )
              .toMatchObject({ held: true });
            await configureAutonomousOwner(owner, 1_001_100_000n, 1, false, true, false);
            const type = transition === "pause" ? "PauseWorld" : "SetClockPolicy";
            const payload =
              transition === "pause"
                ? { schemaVersion: 1 }
                : {
                    schemaVersion: 1,
                    simulationMillisecondsPerWallMillisecond: 1,
                    catchUpCapMs: 1n,
                  };
            expect(
              (
                await owner.submit({
                  ...advanceCommand(owner.world, `late-${transition}-${fault}`, 0n, null),
                  type,
                  payload,
                })
              ).status,
            ).toBe(200);
            const intent = await owner.sql(
              "SELECT jsonb_build_array(clock_policy,clock_owner_generation,clock_admitted_horizon)::text FROM clockgrove.partition_states",
            );
            const canonical = await owner.durable();
            await owner.request("/catch-up/release", { scope: owner.scope });
            await waitForNativeWorkflow(owner, instanceId, "complete", "catch-up");
            expect(
              await owner.sql(
                "SELECT jsonb_build_array(clock_policy,clock_owner_generation,clock_admitted_horizon)::text FROM clockgrove.partition_states",
              ),
            ).toBe(intent);
            expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(canonical));
            expect(await owner.sql(OPEN)).toBe("0");
            expect(
              await owner.sql(
                "SELECT clock_admitted_horizon::text FROM clockgrove.partition_states",
              ),
            ).toBe("1200000");
            const inspection = (await inspectNativeWorldOwner(owner)).partition;
            expect(inspection.clockPolicy?.running).toBe(transition !== "pause");
            if (transition === "policy") expect(inspection.clockPolicy?.catchUpCapMs).toBe(1n);
          }
        }
      });
    },
    120_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "refuses caller authority and continuation payloads and fences stale scope and policy without changing newer intent",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { envelope, instanceId } = await startNativeCatchUp(owner, "outage");
        await waitForNativeWorkflow(owner, instanceId, "errored", "catch-up");
        const committed = await owner.durable();
        for (const [field, value] of [
          ["authority", { principalId: "principal-runtime" }],
          ["continuation", {}],
          ["version", 2],
        ] as const) {
          const id = `catch-up-refuse-${field}`;
          expect(
            await owner.request("/provisioning/raw", {
              id,
              workflow: "catch-up",
              params: { ...envelope, [field]: value },
            }),
          ).toEqual({ status: 200, body: { id } });
          await waitForNativeWorkflow(owner, id, "errored", "catch-up");
          expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
        }
        await owner.request("/catch-up/configure", { scope: owner.scope, fault: "none" });
        for (const field of [
          "tenantId",
          "worldId",
          "timelineId",
          "spaceId",
          "applicationRunId",
        ] as const) {
          const id = `catch-up-scope-${field}`;
          expect(
            await owner.request("/provisioning/raw", {
              id,
              workflow: "catch-up",
              params: { ...envelope, [field]: `foreign-${field}` },
            }),
          ).toEqual({ status: 200, body: { id } });
          await waitForNativeWorkflow(owner, id, "complete", "catch-up");
          expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(committed));
        }
        expect(
          (
            await owner.submit({
              ...advanceCommand(owner.world, "catch-up-pause", 0n, null),
              type: "PauseWorld",
              payload: { schemaVersion: 1 },
            })
          ).status,
        ).toBe(200);
        const paused = await owner.durable();
        await owner.reconcileDispatches();
        expect(JSON.parse(await owner.durable())).toEqual(JSON.parse(paused));
        expect((await inspectNativeWorldOwner(owner)).partition.clockPolicy?.running).toBe(false);
        expect(
          await owner.sql("SELECT clock_admitted_horizon::text FROM clockgrove.partition_states"),
        ).toBe("1200000");
      });
    },
    120_000,
  );
});
