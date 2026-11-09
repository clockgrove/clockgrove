import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeConversationSession } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { advanceCommand, truthOf } from "../world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../world-owner/native-harness.js";

const FILE = "apps/runtime/test/decision-evidence/wake-triage.postgres.test.ts";
const ACTOR = "fixture.keeper";
const MEMBER = "local-reader-session";
const script = [
  {
    kind: "answer",
    answer: { type: "choice", label: "suppress", confidence: 0.9 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "suppress", confidence: 0.9 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "compiled_routine", confidence: 0.4 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "compiled_routine", confidence: 0.4 },
    costUsd: 0.0001,
  },
  {
    kind: "answer",
    answer: { type: "choice", label: "cant_tell", confidence: 0.9 },
    costUsd: 0.0001,
  },
  { kind: "http", status: 503 },
  ...["suppress", "compiled_routine", "full_turn", "suppress", "suppress", "cant_tell"].map(
    (label) => ({
      kind: "answer",
      answer: { type: "choice", label, confidence: 0.9 },
      costUsd: 0.0001,
    }),
  ),
];
it.skipIf(isNativeWorldOwnerChild())(
  "owns shadow triage PostgreSQL and native actor runtime",
  async () => {
    process.env.WAKE_TRIAGE_CONFIG = JSON.stringify({ dailyBudgetMicrousd: 6000 });
    process.env.NATIVE_WAKE_TRIAGE_SCRIPT = JSON.stringify(script);
    process.env.NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD = "80000";
    try {
      const prepare = async (fixture: Parameters<typeof truthOf>[0]) => {
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'), privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`,
        );
      };
      await runNativeWorldOwnerProcess(FILE, "fixture/reference", { timeoutMs: 180000, prepare });
      const checkout = await mkdtemp(path.join(tmpdir(), "wake-triage-checkout-"));
      try {
        await cp(path.resolve("worlds/fixture/reference"), path.join(checkout, "pack"), {
          recursive: true,
        });
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", timeout: 30000 });
        git("init", "--quiet");
        git("add", "pack");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "Pinned external test world",
        );
        const pinned = git("rev-parse", "HEAD").trim();
        await runNativeWorldOwnerProcess(FILE, path.join(checkout, "pack"), {
          timeoutMs: 180000,
          prepare,
        });
        expect(git("rev-parse", "HEAD").trim()).toBe(pinned);
        expect(git("status", "--porcelain")).toBe("");
      } finally {
        await rm(checkout, { recursive: true, force: true });
      }
    } finally {
      delete process.env.WAKE_TRIAGE_CONFIG;
      delete process.env.NATIVE_WAKE_TRIAGE_SCRIPT;
      delete process.env.NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD;
    }
  },
  480000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "records shadow labels, fallbacks, deterministic replies, recurrence and durable budget without changing full turns",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const created = await owner.request(
        "/v1/runtime/conversations/create",
        { version: 1, ...owner.scope, actorId: ACTOR },
        MEMBER,
      );
      expect(created.status).toBe(200);
      const sessionId = decodeConversationSession(created.body).sessionId;
      const physicalBefore = await owner.sql(
        "SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id",
      );
      for (let index = 0; index < 7; index++) {
        const talk = await owner.request(
          "/v1/runtime/talk",
          {
            version: 1,
            ...owner.scope,
            sessionId,
            messageId: `triage-${index}`,
            text: index === 0 ? "fixture:call mcp.fetch resource.offer" : "Hello",
          },
          MEMBER,
        );
        expect(talk.status).toBe(200);
      }
      const report = await owner.request(
        "/v1/runtime/activations/triage-report",
        { version: 1, scope: owner.scope, actorId: ACTOR },
        MEMBER,
      );
      expect(report.status).toBe(200);
      expect(
        await owner.sql("SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id"),
      ).toBe(physicalBefore);
      expect(report.body).toMatchObject({
        wakes: 7,
        lowConfidence: 2,
        abstentions: 1,
        failed: 1,
        overBudget: 1,
        missCount: 4,
        wouldBypass: 0,
        repliesToPeople: 7,
        triageCostMicrousd: 500,
      });
      const body = report.body as {
        observations: {
          decision: { status: string; signature: string };
          truth: { disposition: string; replyToPerson: boolean };
        }[];
        review: { misses: number }[];
      };
      expect(body.observations.map((row) => row.decision.status)).toEqual([
        "picked",
        "picked",
        "low-confidence",
        "low-confidence",
        "cant-tell",
        "failed",
        "over-budget",
      ]);
      expect(body.review).toHaveLength(2);
      expect(body.review.map((row) => row.misses).sort()).toEqual([2, 2]);
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.events WHERE event_type='WakeTriageRecorded'",
        ),
      ).toBe("7");
      expect(await owner.sql("SELECT sum(reserved_microusd) FROM clockgrove.wake_triage")).toBe(
        "6000",
      );
      await owner.replace(false);
      const again = await owner.request(
        "/v1/runtime/activations/triage-report",
        { version: 1, scope: owner.scope, actorId: ACTOR },
        MEMBER,
      );
      expect(again.body).toEqual(report.body);
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.events WHERE event_type='WakeTriageRecorded'",
        ),
      ).toBe("7");
      const companion = await owner.request(
        "/v1/runtime/conversations/create",
        { version: 1, ...owner.scope, actorId: "fixture.companion" },
        MEMBER,
      );
      expect(companion.status).toBe(200);
      expect(
        (
          await owner.request(
            "/v1/runtime/talk",
            {
              version: 1,
              ...owner.scope,
              sessionId: decodeConversationSession(companion.body).sessionId,
              messageId: "shared-budget",
              text: "Hello",
            },
            MEMBER,
          )
        ).status,
      ).toBe(200);
      expect(
        await owner.sql(
          "SELECT record->>'status' FROM clockgrove.wake_triage WHERE message_id='shared-budget'",
        ),
      ).toBe("over-budget");
      expect(
        (
          await owner.submit(
            advanceCommand(
              owner.world,
              "triage-next-day",
              owner.world.birth.state.simulationTime + 86400000n,
              null,
            ),
          )
        ).status,
      ).toBe(200);
      const post = (op: string, fields: object) =>
        owner.request(
          `/v1/runtime/activations/${op}`,
          { version: 1, scope: owner.scope, actorId: ACTOR, ...fields },
          MEMBER,
        );
      const reasons = [
        "heartbeat",
        "perception",
        "scheduled_intention",
        "subscription",
        "threshold",
        "tool_completed",
      ];
      const reasonFields = [
        "heartbeatId",
        "perceptionId",
        "scheduleId",
        "subscriptionId",
        "conditionId",
        "effectId",
      ];
      for (const [index, kind] of reasons.entries()) {
        expect(
          (
            await post("configure", {
              configuration: {
                id: kind,
                sessionId,
                kind,
                nextWakeAt: null,
                intervalMs: null,
                input: "Consider this wake",
                priority: 1,
                enabled: true,
                compiledRoutine: "escalate",
              },
              policy: { allowModel: true, modelBudget: 10 },
            })
          ).status,
        ).toBe(200);
        const reason = {
          kind,
          [reasonFields[index] as string]: kind,
          ...(kind === "subscription" ? { eventId: "event" } : {}),
        };
        expect(
          (
            await post("wake", {
              wake: {
                configurationId: kind,
                causalRoot: `root-${kind}`,
                reason,
                evidence: "wake evidence",
              },
            })
          ).status,
        ).toBe(200);
      }
      const skipped = async (id: string, compiledRoutine: string, allowModel: boolean) => {
        expect(
          (
            await post("configure", {
              configuration: {
                id,
                sessionId,
                kind: "heartbeat",
                nextWakeAt: null,
                intervalMs: null,
                input: "Consider this wake",
                priority: 1,
                enabled: true,
                compiledRoutine,
              },
              policy: { allowModel, modelBudget: 10 },
            })
          ).status,
        ).toBe(200);
        return post("wake", {
          wake: {
            configurationId: id,
            causalRoot: id,
            reason: { kind: "heartbeat", heartbeatId: id },
            evidence: "gate proof",
          },
        });
      };
      expect((await skipped("noop-proof", "noop", true)).body).toMatchObject({ status: "noop" });
      expect((await skipped("deferred-proof", "escalate", false)).body).toMatchObject({
        status: "deferred",
      });
      expect(await owner.sql("SELECT count(*) FROM clockgrove.wake_triage")).toBe("14");
      const proactive = await post("triage-report", {});
      expect(proactive.status).toBe(200);
      expect(proactive.body).toMatchObject({
        wakes: 14,
        proposedCommands: 1,
        repliesToPeople: 8,
        nothingMaterial: 6,
        wouldBypass: 4,
        grossSavedMicrousd: 320000,
        netSavedMicrousd: 318900,
      });
      expect(await owner.sql("SELECT count(DISTINCT day) FROM clockgrove.wake_triage")).toBe("2");
      const rows = (
        proactive.body as {
          observations: {
            decision: { reason: string; status: string };
            truth: { proposedCommand: boolean; replyToPerson: boolean };
          }[];
        }
      ).observations;
      expect(
        rows
          .filter((row) => row.decision.reason !== "direct_message")
          .map((row) => row.decision.reason)
          .sort(),
      ).toEqual([...reasons].sort());
      expect(rows.find((row) => row.decision.reason === "heartbeat")?.truth).toMatchObject({
        proposedCommand: false,
        replyToPerson: false,
      });
      expect(
        (
          await owner.submit(
            advanceCommand(
              owner.world,
              "triage-third-day",
              owner.world.birth.state.simulationTime + 172800000n,
              null,
            ),
          )
        ).status,
      ).toBe(200);
      const physicalBeforeErrors = await owner.sql(
        "SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id",
      );
      delete process.env.NATIVE_WAKE_TRIAGE_SCRIPT;
      await owner.replace(true);
      expect(
        (
          await owner.request(
            "/v1/runtime/talk",
            { version: 1, ...owner.scope, sessionId, messageId: "missing-key", text: "Hello" },
            MEMBER,
          )
        ).status,
      ).toBe(200);
      expect(
        await owner.sql(
          "SELECT record->>'suppressionCause' FROM clockgrove.wake_triage WHERE message_id='missing-key'",
        ),
      ).toBe("model-unavailable");
      delete process.env.WAKE_TRIAGE_CONFIG;
      await owner.replace(true);
      expect(
        (
          await owner.request(
            "/v1/runtime/talk",
            { version: 1, ...owner.scope, sessionId, messageId: "triage-off", text: "Hello" },
            MEMBER,
          )
        ).status,
      ).toBe(200);
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.wake_triage WHERE message_id='triage-off'",
        ),
      ).toBe("0");
      expect(
        await owner.sql("SELECT state_hash FROM clockgrove.partition_states ORDER BY partition_id"),
      ).toBe(physicalBeforeErrors);
    });
  },
  240000,
);
