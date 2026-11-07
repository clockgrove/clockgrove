import {
  decodeClockCommand,
  InMemoryRuntimeMetrics,
  JournalRevisionConflictError,
} from "@clockgrove/application";
import { decodeCommandEnvelope, decodeOpaqueId } from "@clockgrove/contracts";
import { constructTrustedExecutionContext } from "@clockgrove/contracts/trusted";
import { afterEach, expect, it, vi } from "vitest";
import { type DurableObjectState, SpaceDO } from "../src/cloudflare-adapters.js";
import type { RuntimeEnvironment } from "../src/cloudflare-entry.js";
import { stableRuntimeRouteName } from "../src/routing.js";
import type { PostgreSqlCommandOwner, WorldCommandInput } from "../src/world-commands.js";
import { trustedTestContext } from "./trusted-context.js";

const clock = vi.hoisted(() => ({
  plan: vi.fn<PostgreSqlCommandOwner["clockAlarmPlan"]>(),
  advance: vi.fn<PostgreSqlCommandOwner["advanceClock"]>(),
  submit: vi.fn<PostgreSqlCommandOwner["submit"]>(),
  claim: vi.fn<PostgreSqlCommandOwner["claimClockOwner"]>(),
  observe: vi.fn<PostgreSqlCommandOwner["clockOwnerGeneration"]>(),
  resume: vi.fn<PostgreSqlCommandOwner["resume"]>(),
}));
vi.mock("../src/cloudflare-entry.js", () => ({
  withCommandOwner: async (
    _connection: string,
    operation: (owner: {
      clockAlarmPlan: typeof clock.plan;
      advanceClock: typeof clock.advance;
      submit: typeof clock.submit;
      claimClockOwner: typeof clock.claim;
      clockOwnerGeneration: typeof clock.observe;
      resume: typeof clock.resume;
    }) => Promise<unknown>,
  ) =>
    operation({
      clockAlarmPlan: clock.plan,
      advanceClock: clock.advance,
      submit: clock.submit,
      claimClockOwner: clock.claim,
      clockOwnerGeneration: clock.observe,
      resume: clock.resume,
    }),
  composeRuntime: vi.fn(),
  runtimeLogger: () => ({ log: vi.fn() }),
  worldReactionNotifier: vi.fn(),
}));
const scope = {
  tenantId: decodeOpaqueId("alarm-tenant", "TenantId"),
  worldId: decodeOpaqueId("alarm-world", "WorldId"),
  timelineId: decodeOpaqueId("alarm-timeline", "TimelineId"),
  spaceId: decodeOpaqueId("alarm-space", "SpaceId"),
};
const context = constructTrustedExecutionContext({
  ...trustedTestContext(),
  ...scope,
  worldMembershipId: decodeOpaqueId("alarm-membership", "WorldMembershipId"),
  grants: ["runtime:world-command", "runtime:world-clock"].map((grant) =>
    decodeOpaqueId(grant, "GrantRef"),
  ),
});
const namespace = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => {
    throw new Error("unused namespace");
  },
};
const queue = { send: async () => undefined };
const workflow = { create: async () => undefined };
const lifecycleWorkflow = {
  ...workflow,
  createBatch: async () => [],
  get: async () => ({
    status: async () => ({ status: "complete" }),
    terminate: async () => undefined,
    restart: async () => undefined,
  }),
};
const environment: RuntimeEnvironment = {
  WORLD_DO: namespace,
  SPACE_DO: namespace,
  ACTOR_AGENT_DO: namespace,
  WORLD_REACTIONS_QUEUE: queue,
  COGNITIVE_INDEXING_QUEUE: queue,
  EXTERNAL_EFFECTS_QUEUE: queue,
  WORLD_PROVISIONING_WORKFLOW: lifecycleWorkflow,
  WORLD_READINESS_WORKFLOW: lifecycleWorkflow,
  WORLD_PACK_UPGRADE_WORKFLOW: workflow,
  INGESTION_WORKFLOW: workflow,
  CONSOLIDATION_WORKFLOW: workflow,
  AUTHORING_WORKFLOW: workflow,
  AGENT_JOB_WORKFLOW: workflow,
  TRANSFER_RECOVERY_WORKFLOW: workflow,
  WORLD_REACTIONS_QUEUE_NAME: "reactions",
  COGNITIVE_INDEXING_QUEUE_NAME: "indexing",
  EXTERNAL_EFFECTS_QUEUE_NAME: "effects",
};
async function alarmFixture(
  activation?: Readonly<{ id: string; policyVersion: bigint; ownerGeneration: bigint }>,
) {
  const name = await stableRuntimeRouteName("space", Object.values(scope));
  const stateStorage: DurableObjectState["storage"] = {
    get: async <T>(_key: string): Promise<T | undefined> => undefined,
    put: async <T>(_key: string, _value: T): Promise<void> => undefined,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transaction: async (operation) => operation(stateStorage),
  };
  const storage = {
    get: vi.spyOn(stateStorage, "get"),
    put: vi.spyOn(stateStorage, "put"),
    getAlarm: vi.spyOn(stateStorage, "getAlarm"),
    setAlarm: vi.spyOn(stateStorage, "setAlarm"),
    deleteAlarm: vi.spyOn(stateStorage, "deleteAlarm"),
  };
  vi.spyOn(crypto, "randomUUID").mockReturnValue("123e4567-e89b-42d3-a456-426614174000");
  // The scope and the interrupted activation occupy separate durable storage keys.
  storage.get.mockImplementation(async (key) =>
    key === "clock-alarm-generation"
      ? 1n
      : key === "clock-alarm-scope"
        ? scope
        : key === "clock-alarm-activation"
          ? activation
          : undefined,
  );
  clock.claim.mockResolvedValue(1n);
  clock.observe.mockResolvedValue(0n);
  clock.plan.mockResolvedValue({ policyVersion: 7n, nextAlarmAt: 12345 });
  clock.advance.mockResolvedValue({ status: "advanced", commands: [] });
  const state: DurableObjectState = {
    id: namespace.idFromName(name),
    storage: stateStorage,
    blockConcurrencyWhile: (operation) => operation(),
    waitUntil: vi.fn(),
    abort: vi.fn(),
  };
  return { owner: new SpaceDO(state, environment), storage, state };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("limits each activation to four attempts and admits horizon once under its captured policy", async () => {
  const { owner, storage } = await alarmFixture();
  await owner.alarm();
  expect(clock.advance.mock.calls.map((call) => call[2])).toEqual([
    {
      activationId: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: true,
    },
    {
      activationId: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
    {
      activationId: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
    {
      activationId: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
  ]);
  expect(storage.put.mock.calls[2]).toEqual([
    "clock-alarm-activation",
    {
      id: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
    },
  ]);
  expect(storage.setAlarm.mock.calls.at(-1)).toEqual([12345]);
  expect(storage.put.mock.calls.slice(-2)).toEqual([
    ["clock-alarm-activation", null],
    ["clock-alarm-at", { at: 12345, label: "planned" }],
  ]);
});
it("starts no next attempt at the 250 ms activation cutoff", async () => {
  const { owner } = await alarmFixture();
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(249).mockReturnValue(250);
  await owner.alarm();
  expect(clock.advance.mock.calls.map((call) => call[2]?.admit)).toEqual([true]);
});
it("removes the alarm without attempts when the durable plan is paused or exhausted", async () => {
  const { owner, storage } = await alarmFixture();
  clock.plan.mockResolvedValue({ policyVersion: 8n, nextAlarmAt: null });
  await owner.alarm();
  expect(clock.advance.mock.calls).toEqual([]);
  expect(storage.deleteAlarm.mock.calls).toEqual([[]]);
  expect(storage.setAlarm.mock.calls).toHaveLength(1);
});
it("retains recovery alarm and activation identity when processing fails", async () => {
  const { owner, storage } = await alarmFixture();
  const failure = new Error("database unavailable");
  clock.advance.mockRejectedValueOnce(failure);
  await expect(owner.alarm()).rejects.toBe(failure);
  expect(storage.setAlarm.mock.calls).toHaveLength(1);
  expect(storage.deleteAlarm.mock.calls).toEqual([]);
  expect(storage.put.mock.calls.map((call) => call[0])).toEqual([
    "clock-alarm-scope",
    "clock-alarm-at",
    "clock-alarm-activation",
  ]);
});
it("reuses an interrupted activation id instead of admitting that horizon twice", async () => {
  const { owner } = await alarmFixture({
    id: "interrupted-activation",
    policyVersion: 7n,
    ownerGeneration: 1n,
  });
  await owner.alarm();
  expect(clock.advance.mock.calls.map((call) => call[2])).toEqual([
    { activationId: "interrupted-activation", policyVersion: 7n, ownerGeneration: 1n, admit: true },
    {
      activationId: "interrupted-activation",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
    {
      activationId: "interrupted-activation",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
    {
      activationId: "interrupted-activation",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: false,
    },
  ]);
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});
it("supersedes the interrupted activation when its policy version changes", async () => {
  const { owner } = await alarmFixture({
    id: "obsolete-activation",
    policyVersion: 6n,
    ownerGeneration: 1n,
  });
  await owner.alarm();
  expect(clock.advance.mock.calls.map((call) => call[2]?.policyVersion)).toEqual([7n, 7n, 7n, 7n]);
  expect(clock.advance.mock.calls.map((call) => call[2]?.activationId)).toEqual([
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000",
  ]);
});
it("serializes duplicate delivery so older cleanup cannot overwrite the next activation", async () => {
  const { owner, storage } = await alarmFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  clock.advance.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { status: "advanced", commands: [] };
  });
  const first = owner.alarm();
  const second = owner.alarm();
  await entered.promise;
  expect(clock.plan.mock.calls).toHaveLength(1);
  expect(storage.setAlarm.mock.calls).toHaveLength(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(clock.advance.mock.calls.map((call) => call[2]?.admit)).toEqual([
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  expect(storage.setAlarm.mock.calls.filter((call) => call[0] === 12345)).toEqual([
    [12345],
    [12345],
  ]);
});
it.each(["PauseWorld", "ResumeWorld", "SetClockPolicy"] as const)(
  "finishes delayed old cleanup before %s supersedes its alarm intent",
  async (type) => {
    const { owner, storage } = await alarmFixture();
    const payload =
      type === "SetClockPolicy"
        ? {
            schemaVersion: 1,
            simulationMillisecondsPerWallMillisecond: 1,
            catchUpCapMs: 1n,
          }
        : { schemaVersion: 1 };
    const target = {
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      kind: "world",
      id: scope.worldId,
    } as const;
    const input: WorldCommandInput = {
      scope,
      epochs: { routingEpoch: 1n, authorityEpoch: 1n },
      clockCommand: decodeClockCommand(type, payload),
      command: decodeCommandEnvelope(
        {
          schemaVersion: 1,
          commandId: `alarm-${type}`,
          type,
          target: { version: 1, ...target },
          expected: {},
          issuedAt: "2026-10-01T00:00:00.000Z",
          context: {
            version: 1,
            correlationId: "alarm-control-correlation",
            requestId: "alarm-control-request",
          },
          attribution: {
            effectiveActorId: "alarm-test",
            causalRootActionId: "alarm-control-action",
          },
          payload,
        },
        target,
        (value) => value,
      ),
    };
    const order: string[] = [];
    const cleanupEntered = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    clock.plan
      .mockImplementationOnce(async () => {
        order.push("plan:7");
        return { policyVersion: 7n, nextAlarmAt: 12345 };
      })
      .mockImplementationOnce(async () => {
        order.push("old-cleanup:started");
        cleanupEntered.resolve();
        await finishCleanup.promise;
        order.push("old-cleanup:finished");
        return { policyVersion: 7n, nextAlarmAt: 12345 };
      })
      .mockImplementationOnce(async () => {
        order.push("plan:8");
        return { policyVersion: 8n, nextAlarmAt: type === "PauseWorld" ? null : 23456 };
      });
    clock.advance.mockImplementationOnce(async (_scope, _time, activation) => {
      order.push(`advance:${activation?.policyVersion}`);
      return { status: "idle", commands: [] };
    });
    clock.submit.mockImplementationOnce(async (submitted) => {
      order.push(`submit:${submitted.command.type}`);
      return {
        commandId: submitted.command.commandId,
        outcome: "committed",
        events: [],
        value: {
          status: "committed",
          revision: "0",
          simulationTime: "0",
          complete: true,
          eventCount: 0,
          stateHash: "unchanged-by-control",
        },
      };
    });
    const obsoleteAlarm = owner.alarm();
    await cleanupEntered.promise;
    const control = owner.submitWorldCommand(input, context);
    await Promise.resolve();
    expect(clock.submit.mock.calls).toEqual([]);
    expect(order).toEqual(["plan:7", "advance:7", "old-cleanup:started"]);
    finishCleanup.resolve();
    await Promise.all([obsoleteAlarm, control]);
    expect(order).toEqual([
      "plan:7",
      "advance:7",
      "old-cleanup:started",
      "old-cleanup:finished",
      `submit:${type}`,
      "plan:8",
    ]);
    expect(clock.advance.mock.calls.map((call) => call[2]?.policyVersion)).toEqual([7n]);
    expect(clock.submit.mock.calls.map((call) => call[3])).toEqual([1n]);
    expect(clock.submit.mock.calls.map((call) => call[0].clockCommand)).toEqual([
      decodeClockCommand(type, payload),
    ]);
    if (type === "PauseWorld") {
      expect(storage.deleteAlarm.mock.calls).toEqual([[]]);
      expect(storage.deleteAlarm.mock.invocationCallOrder[0]).toBeGreaterThan(
        storage.setAlarm.mock.invocationCallOrder.at(-1) ?? 0,
      );
    } else {
      expect(storage.deleteAlarm.mock.calls).toEqual([]);
      expect(storage.setAlarm.mock.calls.at(-1)).toEqual([23456]);
    }
  },
);
it("stops after a refused command instead of repeating the rejected target in the activation", async () => {
  const { owner } = await alarmFixture();
  clock.advance.mockResolvedValueOnce({ status: "refused", commands: [] });
  await owner.alarm();
  expect(clock.advance.mock.calls.map((call) => call[2])).toEqual([
    {
      activationId: "123e4567-e89b-42d3-a456-426614174000",
      policyVersion: 7n,
      ownerGeneration: 1n,
      admit: true,
    },
  ]);
});
it("counts mailbox waiting against the activation cutoff before attempting work", async () => {
  const { owner, storage } = await alarmFixture();
  const planningEntered = Promise.withResolvers<void>();
  const releasePlanning = Promise.withResolvers<void>();
  clock.plan.mockImplementationOnce(async () => {
    planningEntered.resolve();
    await releasePlanning.promise;
    return { policyVersion: 7n, nextAlarmAt: 12345 };
  });
  const waitingControl = owner.reconcileAlarm(scope);
  await planningEntered.promise;
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(250);
  const queuedAlarm = owner.alarm();
  releasePlanning.resolve();
  await Promise.all([waitingControl, queuedAlarm]);
  expect(clock.advance.mock.calls).toEqual([]);
  expect(storage.setAlarm.mock.calls.at(-1)).toEqual([12345]);
});
it("measures an alarm queued behind a running entry against its own mark", async () => {
  const { storage, state } = await alarmFixture();
  const recorded = new InMemoryRuntimeMetrics();
  const owner = new (class extends SpaceDO {
    protected override get metrics() {
      return recorded;
    }
  })(state, environment);
  let mark: unknown;
  storage.get.mockImplementation(async (key) =>
    key === "clock-alarm-at"
      ? mark
      : key === "clock-alarm-generation"
        ? 1n
        : key === "clock-alarm-scope"
          ? scope
          : undefined,
  );
  storage.put.mockImplementation(async (key, value) => {
    if (key === "clock-alarm-at") mark = value;
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const planningEntered = Promise.withResolvers<void>();
  const releasePlanning = Promise.withResolvers<void>();
  clock.plan.mockImplementationOnce(async () => {
    planningEntered.resolve();
    await releasePlanning.promise;
    return { policyVersion: 7n, nextAlarmAt: 61_000 };
  });
  // The control outlasts its 1 s recovery alarm, which is delivered on time, then sets the next.
  const control = owner.reconcileAlarm(scope);
  await planningEntered.promise;
  now.mockReturnValue(1_000);
  const delivered = owner.alarm();
  releasePlanning.resolve();
  await Promise.all([control, delivered]);
  expect(
    recorded.points.flatMap((point) =>
      point.name === "alarm_lateness_ms" ? [[point.label, point.value]] : [],
    ),
  ).toEqual([["recovery", 0]]);
});
it.each(["activation", "cleanup"] as const)(
  "fences delayed old %s; the superseded instance stays fenced and never overwrites the newer alarm",
  async (phase) => {
    const { owner, storage, state } = await alarmFixture();
    let currentGeneration = 1n;
    storage.get.mockImplementation(async (key) =>
      key === "clock-alarm-generation"
        ? currentGeneration
        : key === "clock-alarm-scope"
          ? scope
          : undefined,
    );
    storage.put.mockImplementation(async (key, value) => {
      if (key === "clock-alarm-generation" && typeof value === "bigint") currentGeneration = value;
    });
    clock.claim.mockResolvedValueOnce(1n).mockResolvedValueOnce(2n);
    const cleanupEntered = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    if (phase === "cleanup")
      clock.plan.mockResolvedValueOnce({ policyVersion: 7n, nextAlarmAt: 12345 });
    clock.plan
      .mockImplementationOnce(async () => {
        cleanupEntered.resolve();
        await finishCleanup.promise;
        return { policyVersion: 7n, nextAlarmAt: 12345 };
      })
      .mockResolvedValueOnce({ policyVersion: 7n, nextAlarmAt: 23456 });
    clock.advance.mockResolvedValueOnce({ status: "idle", commands: [] });
    const obsoleteAlarm = owner.alarm();
    await cleanupEntered.promise;
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("123e4567-e89b-42d3-a456-426614174001");
    const replacement = new SpaceDO(state, environment);
    await replacement.reconcileAlarm(scope);
    finishCleanup.resolve();
    await expect(obsoleteAlarm).rejects.toEqual(
      new JournalRevisionConflictError("owner-generation", 1n, 2n),
    );
    expect(currentGeneration).toBe(2n);
    expect(clock.claim.mock.calls).toEqual([
      [scope, "cloudflare:123e4567-e89b-42d3-a456-426614174000", 0n],
      [scope, "cloudflare:123e4567-e89b-42d3-a456-426614174001", 0n],
    ]);
    expect(clock.plan.mock.calls.map((call) => call[2])).toEqual(
      phase === "activation" ? [1n, 2n] : [1n, 1n, 2n],
    );
    expect(clock.advance.mock.calls.map((call) => call[2]?.ownerGeneration)).toEqual(
      phase === "activation" ? [] : [1n],
    );
    expect(storage.put.mock.calls.filter((call) => call[0] === "clock-alarm-activation")).toEqual(
      phase === "activation"
        ? []
        : [
            [
              "clock-alarm-activation",
              {
                id: "123e4567-e89b-42d3-a456-426614174000",
                policyVersion: 7n,
                ownerGeneration: 1n,
              },
            ],
            ["clock-alarm-activation", null],
          ],
    );
    expect(storage.setAlarm.mock.calls.at(-1)).toEqual([23456]);
    expect(storage.deleteAlarm.mock.calls).toEqual([]);
    // The replacement supersedes this owner: it never re-claims or touches the newer alarm.
    await expect(owner.reconcileAlarm(scope)).rejects.toEqual(
      new JournalRevisionConflictError("owner-generation", 1n, 2n),
    );
    expect(clock.claim.mock.calls).toHaveLength(2);
    expect(currentGeneration).toBe(2n);
    expect(storage.setAlarm.mock.calls.at(-1)).toEqual([23456]);
    // After the refusal settles, the superseded incarnation resets so a fresh one can claim.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.abort).toHaveBeenCalledWith("clock owner superseded by a newer generation");
  },
);
it("fences the native trusted continuation RPC with the cached owner generation", async () => {
  const { owner } = await alarmFixture();
  clock.resume.mockResolvedValueOnce(undefined);
  await owner.resumeWorldCommand(scope, context);
  await owner.resumeWorldCommand(scope, context);
  expect(clock.claim.mock.calls).toEqual([
    [scope, "cloudflare:123e4567-e89b-42d3-a456-426614174000", 0n],
  ]);
  expect(clock.resume.mock.calls).toEqual([
    [scope, context, 1n],
    [scope, context, 1n],
  ]);
  expect(clock.plan.mock.calls.map((call) => call[2])).toEqual([1n, 1n]);
});
