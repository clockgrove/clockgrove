import type { ConversationParticipant } from "@clockgrove/application";
import { decodeBrowserScope, decodeConversationSession } from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "../world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../world-owner/native-harness.js";

// Issue 350: a woken turn is material by what it produced, so `suppress` on a delivered reminder,
// a document write or a command is a miss, and only the quiet no-op agrees and saves.
const FILE = "apps/runtime/test/decision-evidence/wake-triage-material.postgres.test.ts";
const ACTOR = "fixture.keeper";
it("counts suppressing a delivered reminder, a document write or a command as a miss", async () => {
  if (!isNativeWorldOwnerChild()) {
    process.env.WAKE_TRIAGE_CONFIG = JSON.stringify({ dailyBudgetMicrousd: 6000 });
    process.env.NATIVE_WAKE_TRIAGE_SCRIPT = JSON.stringify(
      ["full_turn", "suppress", "suppress", "suppress", "suppress"].map((label) => ({
        kind: "answer",
        answer: { type: "choice", label, confidence: 0.9 },
        costUsd: 0.0001,
      })),
    );
    process.env.NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD = "80000";
    try {
      await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
        timeoutMs: 180000,
        prepare: async (fixture) => {
          await truthOf(fixture)(
            `UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'), privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`,
          );
        },
      });
    } finally {
      delete process.env.WAKE_TRIAGE_CONFIG;
      delete process.env.NATIVE_WAKE_TRIAGE_SCRIPT;
      delete process.env.NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD;
    }
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const post = async (path: string, fields: object) => {
      const r = await owner.request(path, { version: 1, ...fields });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Record<string, unknown>;
    };
    const activation = (op: string, fields: object) =>
      post(`/v1/runtime/activations/${op}`, { scope: owner.scope, actorId: ACTOR, ...fields });
    const session = decodeConversationSession(
      await post("/v1/runtime/conversations/create", {
        ...owner.scope,
        actorId: ACTOR,
        channel: "fake",
        threadId: "triage-material",
      }),
    );
    const participant: ConversationParticipant = {
      tenantId: session.scope.tenantId,
      ...session.participants[0]!,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    await owner.withSqlClient((c) =>
      new PostgreSqlGovernedDelivery(c).configureConsent(
        participant,
        { scope: decodeBrowserScope(owner.scope), actorId: ACTOR, sessionId: session.sessionId },
        { enabled: true, timezone: "UTC", quietHours: null, budgetLimit: 20 },
      ),
    );
    // A command is decided under the owner's trusted talk context, which a direct message sets.
    await post("/v1/runtime/talk", {
      ...owner.scope,
      sessionId: session.sessionId,
      messageId: "hello",
      text: "Hello",
    });
    const wakes = [
      ["reminder", "Remind me at six to feed the dogs", true],
      ["note", "fixture:propose working-context.md\nThe dogs are fed at six.", false],
      ["command", "fixture:offer fixture.water-bowl water", false],
      ["quiet", "Consider this wake", false],
    ] as const;
    for (const [id, input, delivered] of wakes) {
      await activation("configure", {
        configuration: {
          ...{ id, sessionId: session.sessionId, kind: "scheduled_intention", input },
          ...{ nextWakeAt: null, intervalMs: null, priority: 1, enabled: true },
          compiledRoutine: "escalate",
          ...(delivered ? { delivery: { urgency: "normal", quietHoursBehavior: "delay" } } : {}),
        },
        policy: { allowModel: true, modelBudget: 10 },
      });
      await activation("wake", {
        wake: {
          configurationId: id,
          causalRoot: `root-${id}`,
          reason: { kind: "scheduled_intention", scheduleId: id },
          evidence: "the hour came",
        },
      });
    }
    expect(
      await owner.sql(
        "SELECT string_agg(status, ',') FROM clockgrove.deliveries WHERE dedupe_key LIKE 'activation:%'",
      ),
    ).toBe("approved");
    const report = await activation("triage-report", {});
    const woken = (report.reasons as { reason: string }[]).find(
      (row) => row.reason === "scheduled_intention",
    );
    expect(woken).toMatchObject({
      wakes: 4,
      answered: 4,
      agreed: 1,
      missCount: 3,
      wouldBypass: 4,
      deliveredMessages: 1,
      documentChanges: 1,
      proposedCommands: 1,
      nothingMaterial: 1,
      grossSavedMicrousd: 80000,
      unknownSavings: 0,
    });
    expect(report).toMatchObject({ wakes: 5, missCount: 3, agreed: 2, grossSavedMicrousd: 80000 });
    const rows = report.observations as {
      decision: { choice: string; messageId: string };
      truth: Record<string, unknown>;
    }[];
    const byInput = Object.fromEntries(
      rows.map((row) => [row.decision.messageId, { choice: row.decision.choice, ...row.truth }]),
    );
    const ids = await owner.sql(
      "SELECT string_agg(configuration_id||'='||message_id, ',' ORDER BY configuration_id) FROM clockgrove.actor_activations",
    );
    const messageOf = Object.fromEntries(ids.split(",").map((pair) => pair.split("=")));
    const facts = (id: string) => {
      const { choice, deliveredMessage, documentChanged, proposedCommand, material } = byInput[
        messageOf[id] as string
      ] as Record<string, unknown>;
      return { choice, deliveredMessage, documentChanged, proposedCommand, material };
    };
    expect(facts("reminder")).toEqual({
      choice: "suppress",
      deliveredMessage: true,
      documentChanged: false,
      proposedCommand: false,
      material: true,
    });
    expect(facts("note")).toEqual({
      choice: "suppress",
      deliveredMessage: false,
      documentChanged: true,
      proposedCommand: false,
      material: true,
    });
    expect(facts("command")).toEqual({
      choice: "suppress",
      deliveredMessage: false,
      documentChanged: false,
      proposedCommand: true,
      material: true,
    });
    expect(facts("quiet")).toEqual({
      choice: "suppress",
      deliveredMessage: false,
      documentChanged: false,
      proposedCommand: false,
      material: false,
    });
    expect(
      (report.misses as { decision: { messageId: string } }[])
        .map((m) => m.decision.messageId)
        .sort(),
    ).toEqual([messageOf.reminder, messageOf.note, messageOf.command].sort());
  });
}, 240000);
