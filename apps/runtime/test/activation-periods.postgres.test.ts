import type { ActivationAddress, ActivationConfiguration } from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { PostgreSqlActivations } from "@clockgrove/persistence";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { applyMigrations } from "../../../scripts/database/lib.mjs";
import { connect, holdCluster, truthOf } from "./world-fixture.js";

// Issue 358: wakes and model opportunities are limited per wall-clock period, not per lifetime.
const BASE = { tenantId: "tenant-p", principalId: "principal-p", worldId: "world-p" };
const ACTORS = ["beat", "hourly", "capped", "budgeted", "inspected", "reshaped"];
const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = 1_924_992_000_000; // 2031-01-01T00:00:00Z, an hour boundary
const at = (actorId: string) =>
  ({
    scope: { ...BASE, timelineId: "timeline-p", spaceId: "space-a" },
    actorId,
    participant: {
      tenantId: decodeOpaqueId(BASE.tenantId, "TenantId"),
      principalId: decodeOpaqueId(BASE.principalId, "PrincipalId"),
      personaId: "persona-p",
      privacyCeiling: decodePrivacyCeiling({
        version: 1,
        allowedCategories: ["public_scene", "conversation"],
      }),
    },
  }) as unknown as ActivationAddress;
const config = (actorId: string, intervalMs: number | null): ActivationConfiguration => ({
  id: `wake-${actorId}`,
  sessionId: `session-${actorId}`,
  kind: intervalMs === HOUR ? "scheduled_intention" : "heartbeat",
  nextWakeAt: START,
  intervalMs,
  input: "check in",
  priority: 1,
  enabled: true,
  compiledRoutine: "escalate",
});
const wake = (actorId: string, root: string) => ({
  configurationId: `wake-${actorId}`,
  causalRoot: root,
  reason:
    actorId === "hourly"
      ? { kind: "scheduled_intention" as const, scheduleId: `wake-${actorId}` }
      : { kind: "heartbeat" as const, heartbeatId: `wake-${actorId}` },
  evidence: "due",
});

let cluster: Awaited<ReturnType<typeof holdCluster>>;
let client: ReturnType<typeof connect>;
let activations: PostgreSqlActivations;
beforeAll(async () => {
  cluster = await holdCluster(async (fixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await truthOf(fixture)(`
      INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('tenant-p', 'tenant-p');
      INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-p', 'principal-p');
      INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('tenant-p', 'world-p', 'ready');
      INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('tenant-p', 'world-p', 'timeline-p');
      INSERT INTO clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id)
        VALUES ('tenant-p', 'world-p', 'timeline-p', 'partition-a', 'space-a');
      INSERT INTO clockgrove.streams (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
        VALUES ('tenant-p', 'world-p', 'timeline-p', 'partition-a', 'space-a', 'stream-a');
      INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id,
        membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
        VALUES ('tenant-p', 'world-p', 'timeline-p', 'space-a', 'principal-p', 'membership-p', 'persona-p',
        ARRAY['member'], ARRAY['runtime:world-command'],
        '{"version":1,"allowedCategories":["public_scene","conversation"]}', statement_timestamp());
      INSERT INTO clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id)
        SELECT 'tenant-p', 'session-' || a, 'principal-p', 'persona-p' FROM unnest(ARRAY['${ACTORS.join("','")}']) a;
      INSERT INTO clockgrove.conversation_sessions (tenant_id, session_id, world_id, timeline_id,
        partition_id, space_id, actor_id, voice_mode)
        SELECT 'tenant-p', 'session-' || a, 'world-p', 'timeline-p', 'partition-a', 'space-a', a, 'cognitive'
        FROM unnest(ARRAY['${ACTORS.join("','")}']) a`);
  });
  client = connect(cluster.fixture.environment);
  activations = new PostgreSqlActivations(client);
  vi.useFakeTimers({ toFake: ["Date"] });
}, 60_000);
afterAll(async () => {
  vi.useRealTimers();
  await client?.close();
  await cluster?.close();
});

it("keeps waking a heartbeat and an hourly intention across days, and never repeats a causal root", async () => {
  vi.setSystemTime(START);
  await activations.configure(at("beat"), config("beat", MINUTE), {
    allowModel: true,
    modelBudget: 60,
  });
  await activations.configure(at("hourly"), config("hourly", HOUR), {
    allowModel: true,
    modelBudget: 60,
  });
  const settled = async (actorId: string, root: string) => {
    const admitted = await activations.admit(at(actorId), wake(actorId, root));
    expect(admitted.status).toBe("pending");
    await activations.settle(at(actorId), admitted.activationId, "done");
  };
  for (let minute = 0; minute < 1500; minute++) {
    vi.setSystemTime(START + minute * MINUTE);
    await settled("beat", `schedule:wake-beat:${START + minute * MINUTE}`);
    if (minute % 60 === 0)
      await settled("hourly", `schedule:wake-hourly:${START + minute * MINUTE}`);
  }

  const sql = truthOf(cluster.fixture);
  expect(
    await sql(`SELECT string_agg(actor_id || '=' || receipt_count, ',' ORDER BY actor_id)
      FROM clockgrove.actor_activation_policies WHERE actor_id IN ('beat','hourly')`),
  ).toBe("beat=1500,hourly=25");

  const root = `schedule:wake-beat:${START}`;
  const recorded = await activations.admit(at("beat"), wake("beat", root));
  expect(recorded).toMatchObject({ causalRoot: root, status: "completed", outcome: "done" });
  expect(
    await sql(
      `SELECT receipt_count FROM clockgrove.actor_activation_policies WHERE actor_id='beat'`,
    ),
  ).toBe("1500");
});

it("refuses the wake past a period's limit as such, and admits again when the period renews", async () => {
  const policy = { allowModel: true, modelBudget: 10, wakeLimit: 3, budgetPeriodMs: HOUR };
  const base = START + 100 * HOUR + 10 * MINUTE;
  vi.setSystemTime(base);
  await activations.configure(at("capped"), config("capped", MINUTE), policy);
  for (const n of [1, 2, 3]) {
    const admitted = await activations.admit(at("capped"), wake("capped", `root-${n}`));
    await activations.settle(at("capped"), admitted.activationId, "done");
  }
  await expect(activations.admit(at("capped"), wake("capped", "root-4"))).rejects.toThrow(
    "activation wake limit reached",
  );
  const endsAt = START + 101 * HOUR;
  expect((await activations.inspect(at("capped"))).period).toEqual({
    periodMs: HOUR,
    wakeLimit: 3,
    wakes: 3,
    endsAt,
  });
  vi.setSystemTime(endsAt + 1);
  expect(await activations.admit(at("capped"), wake("capped", "root-4"))).toMatchObject({
    status: "pending",
  });
  expect((await activations.inspect(at("capped"))).period).toMatchObject({
    wakes: 1,
    endsAt: endsAt + HOUR,
  });
});

it("defers a wake past the period's model budget and renews it in the next period", async () => {
  vi.setSystemTime(START + 200 * HOUR);
  await activations.configure(at("budgeted"), config("budgeted", MINUTE), {
    allowModel: true,
    modelBudget: 2,
  });
  for (const n of [1, 2]) {
    const admitted = await activations.admit(at("budgeted"), wake("budgeted", `root-${n}`));
    expect(admitted.status).toBe("pending");
    await activations.settle(at("budgeted"), admitted.activationId, "done");
  }
  expect(await activations.admit(at("budgeted"), wake("budgeted", "root-3"))).toMatchObject({
    status: "deferred",
    outcome: "budget_exhausted",
  });
  vi.setSystemTime(START + 201 * HOUR);
  expect(await activations.admit(at("budgeted"), wake("budgeted", "root-3"))).toMatchObject({
    status: "pending",
    outcome: "admitted",
  });
  expect((await activations.inspect(at("budgeted"))).modelCallsReserved).toBe(0);
});

it("still inspects, and so retries, a budget-exhausted wake behind many wakes that cannot be retried", async () => {
  vi.setSystemTime(START + 300 * HOUR);
  const off = { ...config("inspected", MINUTE), id: "wake-off", enabled: false };
  await activations.configure(at("inspected"), off, {
    allowModel: true,
    modelBudget: 0,
    wakeLimit: 100,
  });
  await activations.configure(at("inspected"), config("inspected", MINUTE), {
    allowModel: true,
    modelBudget: 0,
  });
  for (let n = 0; n < 70; n++)
    expect(
      await activations.admit(at("inspected"), {
        ...wake("inspected", `denied-${n}`),
        configurationId: "wake-off",
      }),
    ).toMatchObject({ status: "deferred", outcome: "policy_denied" });
  expect(await activations.admit(at("inspected"), wake("inspected", "exhausted"))).toMatchObject({
    status: "deferred",
    outcome: "budget_exhausted",
  });
  const listed = (await activations.inspect(at("inspected"))).activations;
  expect(listed.filter((r) => r.outcome === "policy_denied")).toHaveLength(64);
  expect(listed.filter((r) => r.outcome === "budget_exhausted").map((r) => r.causalRoot)).toEqual([
    "exhausted",
  ]);
});

it("charges no ended period's wakes to the window a new period length starts", async () => {
  const policy = { allowModel: true, modelBudget: 10, wakeLimit: 3, budgetPeriodMs: HOUR };
  vi.setSystemTime(START + 400 * HOUR + 50 * MINUTE);
  await activations.configure(at("reshaped"), config("reshaped", MINUTE), policy);
  for (const n of [1, 2, 3]) {
    const admitted = await activations.admit(at("reshaped"), wake("reshaped", `root-${n}`));
    await activations.settle(at("reshaped"), admitted.activationId, "done");
  }
  await expect(activations.admit(at("reshaped"), wake("reshaped", "root-4"))).rejects.toThrow(
    "activation wake limit reached",
  );
  // Three hours after that period ended, the operator moves to a daily period.
  vi.setSystemTime(START + 403 * HOUR);
  await activations.configure(at("reshaped"), config("reshaped", MINUTE), {
    ...policy,
    budgetPeriodMs: 24 * HOUR,
  });
  expect(await activations.admit(at("reshaped"), wake("reshaped", "root-4"))).toMatchObject({
    status: "pending",
  });
  expect((await activations.inspect(at("reshaped"))).period).toEqual({
    periodMs: 24 * HOUR,
    wakeLimit: 3,
    wakes: 1,
    endsAt: START + 408 * HOUR,
  });
});
