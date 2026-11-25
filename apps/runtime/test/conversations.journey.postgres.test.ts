import { readFile } from "node:fs/promises";
import {
  type BrowserScope,
  decodeConversationList,
  decodeConversationSession,
  decodeConversationTranscript,
  decodeSayReceipt,
  decodeTalkReceipt,
  type ObjectId,
  type WorldPersonaId,
} from "@clockgrove/contracts";
import type { WorldState } from "@clockgrove/domain";
import { expect, it } from "vitest";
import { CONVERSATION_ROUTES } from "../src/conversations.js";
import { sayAudience, scriptedSay } from "../src/interactions.js";
import { trustedTestContext } from "./trusted-context.js";
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
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
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
  "keeps two private Keeper sessions separate across browser restart and owner eviction",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = async (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const create = async (title: string) =>
        decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper", title }))
            .body,
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
      const first = await talk(rain.sessionId, "rain-1", "Stay dry under the porch, Keeper.");
      await talk(snacks.sessionId, "snacks-1", "The compost bin has apple cores.");
      const second = await talk(rain.sessionId, "rain-2", "The storm passes by evening.");
      expect([first.message.authorId, first.message.voiceMode]).toEqual(["persona-runtime", null]);
      expect([first.reply.authorId, first.reply.voiceMode, first.reply.text]).toEqual([
        "fixture.keeper",
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
      const retry = await talk(rain.sessionId, "rain-1", "Stay dry under the porch, Keeper.");
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
        actorId: "fixture.keeper",
        messageId: "say-1",
        text: "Speak up, Keeper!",
      });
      const spoken = decodeSayReceipt(say.body);
      expect([say.status, spoken.type, spoken.speech.text, spoken.attribution]).toEqual([
        200,
        "public_say",
        "Chitters aloud (scripted fixture line).",
        { principalId: "principal-runtime", personaId: "persona-runtime" },
      ]);
      // Say's spatial audience: observers in and near the space hear it, and no one else.
      // The whole space hears it (the runtime declares no sound range); another space's store does not.
      const heard = spoken.audience?.observers.map((o) => `${o.observerId}:${o.reason}`);
      expect(heard).toEqual([
        "fixture.cedar:space-contents",
        "fixture.cedar-hollow:space-contents",
        "fixture.companion:space-contents",
        "fixture.den:space-contents",
        "fixture.den-stash:space-contents",
        "fixture.dependent:space-contents",
        "fixture.fence-gate:space-contents",
        "fixture.herb:space-contents",
        "fixture.keeper:event-actor",
        "fixture.pantry-bin:space-contents",
        "fixture.porch:space-contents",
        "fixture.sky:space-contents",
        "fixture.snack-dish:space-contents",
        "fixture.trash-can:space-contents",
        "fixture.water-bowl:space-contents",
      ]);
      // The longest message id the request accepts (1,024 bytes) reaches the same audience.
      const longSay = await post("/v1/runtime/say", {
        actorId: "fixture.keeper",
        messageId: "s".repeat(1024),
        text: "Speak up, Keeper!",
      });
      expect([
        longSay.status,
        decodeSayReceipt(longSay.body).audience?.observers.map((o) => o.observerId),
      ]).toEqual([200, spoken.audience?.observers.map((o) => o.observerId)]);

      // Talk is never projected: the scene and the journal carry none of its words.
      const scene = await post("/v1/runtime/scene", {});
      expect(scene.status).toBe(200);
      const journal = await owner.sql(
        "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%porch, Keeper%' OR payload::text LIKE '%apple cores%'",
      );
      expect([JSON.stringify(scene.body).includes("porch, Keeper"), journal.trim()]).toEqual([
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
      // Two titles, six messages, three protected prompts and three normalized input envelopes.
      expect(atRest.trim()).toBe("14/14/0");

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
        [1, "caretaker", "Stay dry under the porch, Keeper."],
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

      // Each voice mode opens with its own disclosure on the session and the reply: cognitive, interpreted, canonical.
      const disclosures = [rain.disclosure];
      for (const [actorId, mode, disclosure] of [
        [
          "fixture.cedar",
          "interpreted",
          "Narrated interpretation of modeled state; the object is not sentient",
        ],
        ["fixture.fence-gate", "canonical", "Authorized explanation from world evidence"],
      ] as const) {
        const session = decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId, title: mode })).body,
        );
        expect([session.actorId, session.voiceMode, session.disclosure]).toEqual([
          actorId,
          mode,
          disclosure,
        ]);
        const said = await talk(session.sessionId, `${mode}-1`, "What can you tell me?");
        expect([said.reply.authorId, said.reply.voiceMode]).toEqual([actorId, mode]);
        disclosures.push(session.disclosure);
      }
      expect(new Set(disclosures).size).toBe(3);
      // An entity that declares no Conversation mode is not addressed.
      expect(
        await post("/v1/runtime/conversations/create", { actorId: "fixture.water-bowl" }),
      ).toEqual({ status: 409, body: { error: "talk_unavailable" } });

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

it.skipIf(isNativeWorldOwnerChild())(
  "fails a Say's audience closed to no observers, in a receipt its own decoder accepts",
  () => {
    // A speaker the canonical state does not hold: the resolver is never asked.
    const state = { revision: 7n, entities: [] } as unknown as WorldState;
    const audience = sayAudience(state, "space-1", "actor-gone", "say-1");
    expect(audience).toEqual({ resolverVersion: "clockgrove-audience-resolver@2", observers: [] });
    const context = trustedTestContext();
    const receipt = scriptedSay(
      {
        scope: {
          tenantId: context.tenantId,
          worldId: context.worldId,
          timelineId: context.timelineId,
          spaceId: context.spaceId,
        } as BrowserScope,
        messageId: "say-1",
        actorId: "actor-gone" as ObjectId,
        text: "hello",
      },
      { ...context, personaId: "persona-runtime" as WorldPersonaId },
      "2026-11-18T00:00:00.000Z",
      undefined,
      audience,
    );
    expect(decodeSayReceipt(JSON.parse(JSON.stringify(receipt))).audience).toEqual(audience);
  },
);

it.skipIf(isNativeWorldOwnerChild())(
  "names only the caller's space in a Say's audience, and only the speaker's frame",
  () => {
    const pose = (frameId: string, x: bigint, y: bigint) => ({
      frameId,
      frameVersion: 1,
      coordinates: [x, y],
    });
    const entity = (objectId: string, spaceId: string, at: ReturnType<typeof pose>) => ({
      objectId,
      spaceId,
      pose: at,
    });
    const state = {
      revision: 3n,
      entities: [
        entity("speaker", "space-a", pose("ground", 0n, 0n)),
        entity("peer", "space-a", pose("ground", 5_000n, 0n)),
        entity("aloft", "space-a", pose("loft", 0n, 0n)),
        entity("neighbour", "space-b", pose("ground", 10n, 10n)),
      ],
      spatialRegions: [
        {
          regionId: "porch",
          version: 1,
          frameId: "ground",
          frameVersion: 1,
          shape: { kind: "rectangle", min: [-100n, -100n], max: [100n, 100n] },
        },
      ],
    } as unknown as WorldState;
    const heard = (scopeSpaceId: string) =>
      sayAudience(state, scopeSpaceId, "speaker", "say-1").observers.map(
        (o) => `${o.observerId}:${o.reason}`,
      );
    // Another space's entity standing in the speaker's place is never named to this caller; an
    // entity of the speaker's space in another frame is out of range.
    expect(heard("space-a")).toEqual(["peer:space-contents", "speaker:event-actor"]);
    // A speaker outside the caller's space names no one.
    expect(heard("space-b")).toEqual([]);
  },
);
