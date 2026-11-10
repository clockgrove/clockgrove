import { resolve } from "node:path";
import {
  decodeConversationSession,
  decodeConversationTranscript,
  decodeTalkReceipt,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
// @ts-expect-error -- repository-local JavaScript helper has no declarations.
import { ownedSubprocess } from "../../../scripts/lib/subprocess.mjs";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/cli-conversations.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
it.skipIf(isNativeWorldOwnerChild())(
  "owns CLI PostgreSQL and actor runtime",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships
        SET grants = array_append(grants, 'runtime:world-observe'),
          privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
        INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
          SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
        INSERT INTO clockgrove.world_memberships (
          tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id,
          roles, grants, privacy_ceiling, committed_at
        ) SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
          'membership-outsider', 'persona-outsider', roles, grants, privacy_ceiling, now()
          FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`);
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "CLI preserves canonical actor, private Talk, public Say, retries and member isolation",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const url = await owner.origin();
      const cli = async (args: string[], token = MEMBER) =>
        ownedSubprocess(
          process.execPath,
          [
            resolve("scripts/runtime-chat.mjs"),
            ...args,
            "--url",
            url,
            "--tenant",
            owner.scope.tenantId,
            "--world",
            owner.scope.worldId,
            "--timeline",
            owner.scope.timelineId,
            "--space",
            owner.scope.spaceId,
          ],
          { env: { ...process.env, CLOCKGROVE_SESSION_TOKEN: token }, timeoutMs: 150_000 },
        );
      const successful = async (args: string[]) => {
        const result = await cli(args);
        expect([result.status, result.stderr]).toEqual([0, ""]);
        return JSON.parse(result.stdout);
      };
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, MEMBER);
      const browser = decodeConversationSession(
        (
          await post("/v1/runtime/conversations/create", {
            actorId: "fixture.keeper",
            title: "Browser thread",
          })
        ).body,
      );
      const session = decodeConversationSession(
        await successful(["create", "--actor", "fixture.keeper", "--title", "CLI thread"]),
      );
      expect([session.actorId, browser.actorId, session.participants]).toEqual([
        "fixture.keeper",
        "fixture.keeper",
        [{ principalId: "principal-runtime", personaId: "persona-runtime" }],
      ]);
      expect(session.sessionId).not.toBe(browser.sessionId);
      const args = [
        "talk",
        "--session",
        session.sessionId,
        "--message-id",
        "cli-private-1",
        "--text",
        "CLI private note",
      ];
      const receipt = decodeTalkReceipt(await successful(args));
      expect([
        receipt.type,
        receipt.message.text,
        receipt.reply.authorId,
        receipt.reply.text,
        receipt.turn.turn,
      ]).toEqual([
        "private_caretaker_talk",
        "CLI private note",
        "fixture.keeper",
        "Scripted fixture reply: you have said 1 thing to me in this conversation.",
        1,
      ]);
      expect(decodeTalkReceipt(await successful(args))).toEqual(receipt);
      const spoken = await successful([
        "say",
        "--actor",
        "fixture.keeper",
        "--message-id",
        "cli-say-1",
        "--text",
        "Public request",
      ]);
      expect([spoken.type, spoken.speech.text, spoken.attribution]).toEqual([
        "public_say",
        "Chitters aloud (scripted fixture line).",
        { principalId: "principal-runtime", personaId: "persona-runtime" },
      ]);
      const transcript = decodeConversationTranscript(
        await successful(["read", "--session", session.sessionId]),
      );
      expect([transcript.messages.map((m) => m.text), transcript.turns.length]).toEqual([
        [
          "CLI private note",
          "Scripted fixture reply: you have said 1 thing to me in this conversation.",
        ],
        1,
      ]);
      const browserTranscript = decodeConversationTranscript(
        (await post("/v1/runtime/conversations/read", { sessionId: browser.sessionId })).body,
      );
      expect([browserTranscript.messages, browserTranscript.turns]).toEqual([[], []]);
      const listed = await successful(["list", "--actor", "fixture.keeper"]);
      expect(listed.sessions.map((s: { title: string }) => s.title).sort()).toEqual([
        "Browser thread",
        "CLI thread",
      ]);
      for (const token of ["outsider-session-token", "unverified-identity"]) {
        const refused = await cli(["read", "--session", session.sessionId], token);
        expect([refused.status, refused.stdout, refused.stderr]).toEqual([
          1,
          "",
          "Runtime chat failed; check arguments, credentials and runtime availability.\n",
        ]);
      }
      expect(
        (
          await owner.sql(
            `SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%CLI private note%'`,
          )
        ).trim(),
      ).toBe("0");
    });
  },
  240_000,
);
