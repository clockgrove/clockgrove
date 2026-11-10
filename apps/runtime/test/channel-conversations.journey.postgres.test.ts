import {
  decodeBrowserScope,
  decodeConversationSession,
  decodeConversationTranscript,
  decodeOpaqueId,
  decodeTalkReceipt,
} from "@clockgrove/contracts";
import { PostgreSqlArtifactStore, WebCryptoKeyring } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { FakeConversationAdapter } from "../src/channel-adapters.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/channel-conversations.journey.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns channel PostgreSQL and actor runtime",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships SET
        grants=array_append(grants,'runtime:world-observe'),
        privacy_ceiling='{"version":1,"allowedCategories":["public_scene","conversation"]}';
        INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id)
          SELECT DISTINCT tenant_id,'principal-outsider' FROM clockgrove.world_memberships;
        INSERT INTO clockgrove.world_memberships
          (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
          SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','membership-outsider','persona-outsider',roles,grants,privacy_ceiling,now()
          FROM clockgrove.world_memberships WHERE principal_id='principal-runtime'`);
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "normalizes verified channel threads, preserves actions and collapses exact retries",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, token = "local-reader-session") =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, token);
      const fake = new FakeConversationAdapter(async (path, body) => {
        const result = await owner.request(path, body);
        expect(result.status).toBe(200);
        return result.body;
      }, decodeBrowserScope(owner.scope));
      const browser = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      );
      const concurrent = await Promise.all([
        fake.create("fixture.keeper", "same-thread"),
        fake.create("fixture.keeper", "same-thread"),
      ]);
      const session = decodeConversationSession(concurrent[0]);
      expect(concurrent.map((v) => decodeConversationSession(v).sessionId)).toEqual([
        session.sessionId,
        session.sessionId,
      ]);
      const cli = decodeConversationSession(
        (
          await post("/v1/runtime/conversations/create", {
            actorId: "fixture.keeper",
            channel: "cli",
            threadId: "same-thread",
          })
        ).body,
      );
      expect([
        browser.channel,
        session.channel,
        cli.channel,
        session.threadId,
        session.actorId,
        cli.actorId,
      ]).toEqual(["browser", "fake", "cli", "same-thread", "fixture.keeper", "fixture.keeper"]);
      expect(new Set([browser.sessionId, session.sessionId, cli.sessionId]).size).toBe(3);
      const receipt = decodeTalkReceipt(
        await fake.talk(session.sessionId, "fake-1", "private fake note", {
          sourceIdentityAssertion: { kind: "authenticated_session", subject: "identity-runtime" },
        }),
      );
      expect([receipt.type, receipt.reply.authorId, receipt.reply.text, receipt.turn.turn]).toEqual(
        [
          "private_caretaker_talk",
          "fixture.keeper",
          "Scripted fixture reply: you have said 1 thing to me in this conversation.",
          1,
        ],
      );
      expect(
        decodeTalkReceipt(await fake.talk(session.sessionId, "fake-1", "private fake note")),
      ).toEqual(receipt);
      const keyring = await WebCryptoKeyring.fromJson(
        JSON.stringify({
          version: 1,
          current: "native-kek-1",
          keys: { "native-kek-1": Buffer.alloc(32, 7).toString("base64url") },
        }),
      );
      const envelope = await owner.withSqlClient(async (client) => {
        const result = await client.query(
          `SELECT partition_id FROM clockgrove.conversation_sessions WHERE session_id=$1`,
          [session.sessionId],
        );
        const artifact = await new PostgreSqlArtifactStore(client, { keyring }).get(
          {
            tenantId: session.scope.tenantId,
            principalId: session.participants[0]!.principalId,
            privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
          },
          {
            ...session.scope,
            partitionId: String((result.rows[0] as { partition_id: string }).partition_id) as never,
            artifactId: decodeOpaqueId(`${session.sessionId}:inbound:fake-1`, "ArtifactId"),
          },
        );
        return JSON.parse(new TextDecoder().decode(artifact.bytes));
      });
      expect(envelope).toEqual({
        version: 1,
        sourceIdentityAssertion: { kind: "authenticated_session", subject: "identity-runtime" },
        resolvedPrincipal: "principal-runtime",
        scope: session.scope,
        actorId: "fixture.keeper",
        participants: [{ principalId: "principal-runtime", personaId: "persona-runtime" }],
        channel: "fake",
        threadId: "same-thread",
        action: "talk",
        privacyPolicy: "conversation",
        contentParts: [{ type: "text", artifactId: `${session.sessionId}:message:fake-1` }],
        mediaReferences: [],
        replyMetadata: null,
        authorityMode: "member",
        idempotencyKey: "fake-1",
      });
      expect(
        await post("/v1/runtime/talk", {
          sessionId: session.sessionId,
          messageId: "fake-1",
          text: "private fake note",
          ingress: { replyMetadata: { messageId: "fake-1:reply" } },
        }),
      ).toEqual({ status: 409, body: { error: "message_id_reused" } });
      expect(
        await post("/v1/runtime/talk", {
          sessionId: session.sessionId,
          messageId: "forged",
          text: "secret",
          ingress: {
            sourceIdentityAssertion: {
              kind: "authenticated_session",
              subject: "identity-outsider",
            },
          },
        }),
      ).toEqual({ status: 403, body: { error: "channel_identity_unverified" } });
      expect(
        (
          await post("/v1/runtime/talk", {
            sessionId: session.sessionId,
            messageId: "media",
            text: "secret",
            ingress: { mediaReferences: ["unverified-media"] },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            "/v1/runtime/conversations/read",
            { sessionId: session.sessionId },
            "outsider-session-token",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await post(
            "/v1/runtime/talk",
            { sessionId: session.sessionId, messageId: "unverified", text: "secret" },
            "unverified-identity",
          )
        ).status,
      ).toBe(401);
      const said = (await fake.say(
        "fixture.keeper",
        "same-thread",
        "fake-say",
        "public request",
      )) as { type: string };
      expect(said.type).toBe("public_say");
      expect(
        (
          await post("/v1/runtime/say", {
            actorId: "fixture.keeper",
            messageId: "forged-say",
            text: "request",
            channel: "fake",
            ingress: {
              sourceIdentityAssertion: {
                kind: "authenticated_session",
                subject: "identity-outsider",
              },
            },
          })
        ).status,
      ).toBe(403);
      const transcript = decodeConversationTranscript(
        (await post("/v1/runtime/conversations/read", { sessionId: session.sessionId })).body,
      );
      expect([transcript.messages.map((m) => m.text), transcript.turns.length]).toEqual([
        [
          "private fake note",
          "Scripted fixture reply: you have said 1 thing to me in this conversation.",
        ],
        1,
      ]);
      const empty = decodeConversationTranscript(
        (await post("/v1/runtime/conversations/read", { sessionId: browser.sessionId })).body,
      );
      expect([empty.messages, empty.turns]).toEqual([[], []]);
      expect((await owner.sql(`SELECT count(*) FROM clockgrove.channel_bindings`)).trim()).toBe(
        "3",
      );
      expect(
        (
          await owner.sql(
            `SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE inbound_artifact_id IS NOT NULL`,
          )
        ).trim(),
      ).toBe("1");
    });
  },
  240_000,
);
