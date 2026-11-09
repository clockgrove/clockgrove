import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { advanceCommand, truthOf } from "../apps/runtime/test/world-fixture.ts";
import {
  inspectNativeWorldOwner,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../apps/runtime/test/world-owner/native-harness.ts";
import { decodeConversationSession } from "../packages/contracts/src/index.ts";

const FILE = "scripts/wake-triage-report.session.mjs";
const CONFIG = "scripts/wake-triage-report.vitest.config.ts";
const MEMBER = "local-reader-session";
const reasons = [
  { kind: "perception", perceptionId: "triage-perception" },
  { kind: "scheduled_intention", scheduleId: "triage-intention" },
  { kind: "subscription", subscriptionId: "triage-subscription", eventId: "triage-event" },
  { kind: "threshold", conditionId: "triage-threshold" },
  { kind: "heartbeat", heartbeatId: "triage-heartbeat" },
  { kind: "tool_completed", effectId: "triage-tool" },
];
const script = [
  {
    kind: "answer",
    answer: { type: "choice", label: "full_turn", confidence: 0.9 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "suppress", confidence: 0.9 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "compiled_routine", confidence: 0.9 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "suppress", confidence: 0.4 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "cant_tell", confidence: 0.9 },
    costUsd: 0.0001,
  },
  { kind: "http", status: 503 },
  {
    kind: "answer",
    answer: { type: "choice", label: "full_turn", confidence: 0.9 },
    costUsd: 0.0001,
  },
];
it("measures one simulated day through native actor turns", async () => {
  if (!isNativeWorldOwnerChild()) {
    if (process.env.CLOCKGROVE_WAKE_TRIAGE_LIVE !== "1")
      process.env.NATIVE_WAKE_TRIAGE_SCRIPT = JSON.stringify(script);
    await runNativeWorldOwnerProcess(
      FILE,
      process.env.CLOCKGROVE_WAKE_TRIAGE_PACK ?? "fixture/reference",
      {
        vitestConfig: CONFIG,
        timeoutMs: 540_000,
        inheritOutput: true,
        prepare: async (fixture) => {
          await truthOf(fixture)(
            `UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'), privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}' WHERE principal_id='principal-runtime'`,
          );
        },
      },
    );
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const actor = owner.world.birth.state.entities.find(
      (entity) => entity.spaceId === owner.scope.spaceId && entity.needs !== undefined,
    );
    if (!actor) throw new Error("The selected pack needs an actor with needs in its first space");
    const actorId = actor.objectId;
    const created = await owner.request(
      "/v1/runtime/conversations/create",
      { version: 1, ...owner.scope, actorId },
      MEMBER,
    );
    expect(created.status).toBe(200);
    const sessionId = decodeConversationSession(created.body).sessionId;
    const post = async (op, fields = {}) => {
      const response = await owner.request(
        `/v1/runtime/activations/${op}`,
        { version: 1, scope: owner.scope, actorId, ...fields },
        MEMBER,
      );
      expect(response.status).toBe(200);
      return response.body;
    };
    const initial = owner.world.birth.state.simulationTime;
    const dayLengthMs = owner.world.behavior.policy.environment?.dayLengthMs ?? 86_400_000n;
    const talk = await owner.request(
      "/v1/runtime/talk",
      {
        version: 1,
        ...owner.scope,
        sessionId,
        messageId: "triage-day-message",
        text: "Please tell me what needs attention in the current scene.",
      },
      MEMBER,
    );
    expect(talk.status).toBe(200);
    // Decision: 24 checkpoints spread the seven-wake probe over one pack day; each uses
    // the kernel's maximum 1,024 inputs and 4,096 events to bound dense external packs.
    for (let hour = 1; hour <= 24; hour++) {
      const target = initial + (dayLengthMs * BigInt(hour)) / 24n;
      const advanced = await owner.submit(
        advanceCommand(owner.world, `triage-day-${hour}`, target, null, {
          maxInputs: 1024,
          maxEvents: 4096,
        }),
      );
      expect(advanced.status).toBe(200);
      const inspection = await inspectNativeWorldOwner(owner);
      expect(inspection.partition.document.state.simulationTime).toBe(target);
      if (hour % 4 !== 0) continue;
      const reason = reasons[hour / 4 - 1];
      const id = `triage-${reason.kind}`;
      await post("configure", {
        configuration: {
          id,
          sessionId,
          kind: reason.kind,
          nextWakeAt: null,
          intervalMs: null,
          input: "Consider whether the current scene needs attention.",
          priority: 1,
          enabled: true,
          compiledRoutine: "escalate",
          ...(reason.kind === "subscription" ? { eventType: "triage.probe" } : {}),
        },
        policy: { allowModel: true, modelBudget: 7 },
      });
      await post("wake", {
        wake: {
          configurationId: id,
          causalRoot: `triage-day-${reason.kind}`,
          reason,
          evidence: `operator-day-probe:${hour}/24`,
        },
      });
    }
    const report = await post("triage-report");
    const mode =
      process.env.CLOCKGROVE_WAKE_TRIAGE_LIVE === "1"
        ? process.env.AI_GATEWAY_API_KEY
          ? "live"
          : "model-unavailable"
        : "scripted";
    const output = process.env.CLOCKGROVE_WAKE_TRIAGE_OUTPUT;
    if (!output) throw new Error("Report output path missing");
    await writeFile(
      output,
      `${JSON.stringify({ measurement: mode, workload: "seven wake probes over one simulated pack day", packId: owner.world.artifact.packId, packVersion: owner.world.artifact.version, simulationStart: initial.toString(), simulationEnd: (initial + dayLengthMs).toString(), report }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(`Wake-triage ${mode} report written to ${output}\n`);
  });
});
