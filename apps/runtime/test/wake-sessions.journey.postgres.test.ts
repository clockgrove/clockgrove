import { decodeConversationList, decodeConversationSession } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/wake-sessions.journey.postgres.test.ts";
// A scaled day: a day of 60-second heartbeats writes 2,880 messages, almost three times the
// 1,000-message limit. A scripted wake turn takes about 0.7 s natively, so the runtime's session
// limit setting is lowered to 8 and 12 heartbeats write the same three limits' worth.
const LIMIT = 8;
const HEARTBEATS = 12;
it("a day of heartbeats rotates wake sessions and leaves the person free to talk", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        await truthOf(
          fixture,
        )(`UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'),
        privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}'`);
      },
    });
    return;
  }
  process.env.CONVERSATION_MESSAGE_LIMIT = String(LIMIT);
  await withNativeWorldOwner(async (owner) => {
    const actorId = "fixture.keeper";
    const post = async (path: string, fields: object) => {
      const r = await owner.request(path, {
        version: 1,
        ...(path.startsWith("/v1/runtime/conversations/") ? owner.scope : {}),
        ...fields,
      });
      expect(r.status).toBe(200);
      return r.body as Record<string, unknown>;
    };
    const activation = (op: string, fields: object) =>
      post(`/v1/runtime/activations/${op}`, { scope: owner.scope, actorId, ...fields });
    const sessionId = decodeConversationSession(
      await post("/v1/runtime/conversations/create", { actorId }),
    ).sessionId;
    await activation("configure", {
      configuration: {
        id: "pulse",
        sessionId,
        kind: "heartbeat",
        nextWakeAt: null,
        intervalMs: null,
        input: "Heartbeat",
        priority: 1,
        enabled: true,
        compiledRoutine: "escalate",
      },
      policy: { allowModel: true, modelBudget: 1000 },
    });
    const sessions = new Set<string>();
    for (let i = 0; i < HEARTBEATS; i++) {
      const woken = await activation("wake", {
        wake: {
          configurationId: "pulse",
          causalRoot: `heartbeat-${i}`,
          reason: { kind: "heartbeat", heartbeatId: `heartbeat-${i}` },
          evidence: "minute tick",
        },
      });
      expect(woken.status).toBe("completed");
      sessions.add(String(woken.sessionId));
    }
    // The person's session holds none of the wakes; three full wake sessions hold all of them.
    const counts = () =>
      owner.sql(
        `SELECT string_agg(coalesce(wake_generation, 0) || '/' || message_count, ' '
           ORDER BY coalesce(wake_generation, 0))
         FROM clockgrove.conversation_sessions WHERE '${sessionId}' IN (session_id, wake_of)`,
      );
    expect(await counts()).toBe("0/0 1/8 2/8 3/8");
    expect(sessions.size).toBe(3);
    expect(sessions.has(sessionId)).toBe(false);
    const talked = await post("/v1/runtime/talk", {
      ...owner.scope,
      sessionId,
      messageId: "after-a-day",
      text: "Are you there?",
    });
    expect(JSON.stringify(talked)).toContain("Scripted fixture reply");
    expect(await counts()).toBe("0/2 1/8 2/8 3/8");
    // The list shows the person's session and the newest wake session only.
    const listed = decodeConversationList(
      await post("/v1/runtime/conversations/list", { actorId }),
    );
    expect(listed.sessions.map((s) => s.sessionId).sort()).toEqual(
      [
        sessionId,
        await owner.sql(
          `SELECT session_id FROM clockgrove.conversation_sessions WHERE wake_generation=3`,
        ),
      ].sort(),
    );
  });
}, 240_000);
