import { readFile } from "node:fs/promises";
import {
  decodeConversationList,
  decodeConversationSession,
  decodeConversationTranscript,
  decodeSayReceipt,
  decodeTalkReceipt,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { CONVERSATION_ROUTES } from "../src/conversations.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/conversations.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OTHER_MEMBER = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "raccoons", {
      // Both members observe the world with the conversation category and their own persona.
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = array_append(grants, 'runtime:world-observe'),
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
           INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
             SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
           INSERT INTO clockgrove.world_memberships (
             tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
             roles, grants, privacy_ceiling, committed_at
           ) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
                    'membership-outsider', 'persona-outsider', roles, grants, privacy_ceiling, now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "keeps two private Stevie sessions separate across browser restart and owner eviction",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = async (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const create = async (title: string) =>
        decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: "grove.stevie", title })).body,
        );
      const talk = async (sessionId: string, messageId: string, text: string) => {
        const answer = await post("/v1/runtime/talk", { sessionId, messageId, text });
        expect(answer.status).toBe(200);
        return decodeTalkReceipt(answer.body);
      };
      const transcript = async (sessionId: string, credential = MEMBER) =>
        decodeConversationTranscript(
          (await post("/v1/runtime/conversations/read", { sessionId }, credential)).body,
        );
      const lines = async (sessionId: string) =>
        (await transcript(sessionId)).messages.map((m) => [m.sequence, m.role, m.text]);

      // Two conversations on different topics, each opened with its voice-mode disclosure.
      const rain = await create("Rain plans");
      const snacks = await create("Snack plans");
      expect([rain.voiceMode, rain.disclosure, rain.privacyClass, rain.state]).toEqual([
        "cognitive",
        "Actor's subjective communication",
        "conversation",
        "active",
      ]);
      expect(rain.participants).toEqual([
        { principalId: "principal-runtime", personaId: "persona-runtime" },
      ]);
      const first = await talk(rain.sessionId, "rain-1", "Stay dry under the porch, Stevie.");
      await talk(snacks.sessionId, "snacks-1", "The compost bin has apple cores.");
      const second = await talk(rain.sessionId, "rain-2", "The storm passes by evening.");
      expect([first.message.authorId, first.message.voiceMode]).toEqual(["persona-runtime", null]);
      expect([first.reply.authorId, first.reply.voiceMode, first.reply.text]).toEqual([
        "grove.stevie",
        "cognitive",
        "Scripted fixture reply: you have said 1 thing to me in this conversation.",
      ]);
      expect([second.turn.turn, second.turn.inputSequence, second.turn.outputSequence]).toEqual([
        2, 3, 4,
      ]);
      expect(second.reply.text).toBe(
        "Scripted fixture reply: you have said 2 things to me in this conversation.",
      );
      // An exact retry answers the stored message, reply and turn; other words are refused.
      const retry = await talk(rain.sessionId, "rain-1", "Stay dry under the porch, Stevie.");
      expect([retry.message, retry.reply, retry.turn]).toEqual([
        first.message,
        first.reply,
        first.turn,
      ]);
      expect(
        await post("/v1/runtime/talk", {
          sessionId: rain.sessionId,
          messageId: "rain-1",
          text: "Something else.",
        }),
      ).toEqual({ status: 409, body: { error: "message_id_reused" } });
      // The answer to "rain-1" is stored as "rain-1:reply", so a client may not take that ID.
      const replyId = { sessionId: rain.sessionId, messageId: "rain-1:reply", text: "Hello." };
      expect((await post("/v1/runtime/talk", replyId)).status).toBe(400);

      // Public Say is a distinct command with its own receipt; it never enters a session.
      const say = await post("/v1/runtime/say", {
        actorId: "grove.stevie",
        messageId: "say-1",
        text: "Speak up, Stevie!",
      });
      const spoken = decodeSayReceipt(say.body);
      expect([say.status, spoken.type, spoken.speech.text, spoken.attribution]).toEqual([
        200,
        "public_say",
        "Chitters aloud (scripted fixture line).",
        { principalId: "principal-runtime", personaId: "persona-runtime" },
      ]);

      // Talk is never projected: the scene and the journal carry none of its words.
      const scene = await post("/v1/runtime/scene", {});
      expect(scene.status).toBe(200);
      const journal = await owner.sql(
        "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%porch, Stevie%' OR payload::text LIKE '%apple cores%'",
      );
      expect([JSON.stringify(scene.body).includes("porch, Stevie"), journal.trim()]).toEqual([
        false,
        "0",
      ]);
      // At rest, conversation text exists only as AES-256-GCM ciphertext.
      const atRest = await owner.sql(
        `SELECT count(*) FILTER (WHERE encryption = 'aes-256-gcm-v1' AND get_byte(inline_content, 0) = 1)
                || '/' || count(*)
                || '/' || count(*) FILTER (WHERE position(convert_to('apple cores', 'UTF8') IN inline_content) > 0)
           FROM clockgrove.artifact_references WHERE privacy_class = 'conversation'`,
      );
      // Two titles and six messages (three turns).
      expect(atRest.trim()).toBe("8/8/0");

      // A second member of the same world sees neither conversation.
      expect(
        decodeConversationList(
          (await post("/v1/runtime/conversations/list", {}, OTHER_MEMBER)).body,
        ),
      ).toEqual({ sessions: [] });
      for (const sessionId of [rain.sessionId, snacks.sessionId]) {
        expect(await post("/v1/runtime/conversations/read", { sessionId }, OTHER_MEMBER)).toEqual({
          status: 404,
          body: { error: "conversation_not_found" },
        });
        expect(
          await post("/v1/runtime/talk", { sessionId, messageId: "x", text: "hi" }, OTHER_MEMBER),
        ).toEqual({ status: 404, body: { error: "conversation_not_found" } });
      }

      // The browser closes, the owner is evicted with its local storage, and a fresh client with
      // nothing but its credential finds both histories intact and separate.
      await owner.replace(true);
      const listed = decodeConversationList(
        (await post("/v1/runtime/conversations/list", {})).body,
      );
      expect(listed.sessions.map((s) => [s.title, s.messageCount]).sort()).toEqual([
        ["Rain plans", 4],
        ["Snack plans", 2],
      ]);
      expect(await lines(rain.sessionId)).toEqual([
        [1, "caretaker", "Stay dry under the porch, Stevie."],
        [2, "actor", "Scripted fixture reply: you have said 1 thing to me in this conversation."],
        [3, "caretaker", "The storm passes by evening."],
        [4, "actor", "Scripted fixture reply: you have said 2 things to me in this conversation."],
      ]);
      expect(await lines(snacks.sessionId)).toEqual([
        [1, "caretaker", "The compost bin has apple cores."],
        [2, "actor", "Scripted fixture reply: you have said 1 thing to me in this conversation."],
      ]);
      const page = await transcript(rain.sessionId);
      expect([page.turns.length, page.nextAfterSequence]).toEqual([2, null]);

      // Title, archive and delete under retention.
      const retitled = decodeConversationSession(
        (
          await post("/v1/runtime/conversations/title", {
            sessionId: snacks.sessionId,
            title: "Compost",
          })
        ).body,
      );
      expect(retitled.title).toBe("Compost");
      const archive = (archived: boolean) =>
        post("/v1/runtime/conversations/archive", { sessionId: snacks.sessionId, archived });
      expect(decodeConversationSession((await archive(true)).body).state).toBe("archived");
      expect(
        await post("/v1/runtime/talk", {
          sessionId: snacks.sessionId,
          messageId: "s2",
          text: "hi",
        }),
      ).toEqual({ status: 409, body: { error: "conversation_not_active" } });
      expect(decodeConversationSession((await archive(false)).body).state).toBe("active");
      expect(
        await post("/v1/runtime/conversations/delete", { sessionId: snacks.sessionId }),
      ).toEqual({ status: 200, body: { deleted: true } });
      expect(
        decodeConversationList(
          (await post("/v1/runtime/conversations/list", {})).body,
        ).sessions.map((s) => s.sessionId),
      ).toEqual([rain.sessionId]);
      expect(await post("/v1/runtime/conversations/read", { sessionId: snacks.sessionId })).toEqual(
        { status: 404, body: { error: "conversation_not_found" } },
      );

      // The OpenAPI document describes exactly the routes the runtime serves.
      const openapi = JSON.parse(
        await readFile(
          new URL("../../../docs/protocols/conversations.openapi.json", import.meta.url),
          "utf8",
        ),
      ) as { paths: Record<string, unknown> };
      expect(Object.keys(openapi.paths).sort()).toEqual(
        [...CONVERSATION_ROUTES, "/v1/runtime/say"].sort(),
      );
    });
  },
  180_000,
);
