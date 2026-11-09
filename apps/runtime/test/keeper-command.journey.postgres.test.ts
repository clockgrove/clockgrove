import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/keeper-command.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const KEEPER = "fixture.keeper";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
              SET grants = ARRAY(SELECT DISTINCT unnest(grants ||
                    ARRAY['runtime:world-observe', 'runtime:world-command'])),
                  persona_id = 'persona-caretaker',
                  privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "commits Keeper's granted proposal through the ordinary Journal and refuses every ungranted one",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, MEMBER);
      const sessionId = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: KEEPER })).body,
      ).sessionId;
      const say = async (messageId: string, text: string) => {
        const answered = await post("/v1/runtime/talk", { sessionId, messageId, text });
        expect(answered.status).toBe(200);
        return decodeTalkReceipt(answered.body);
      };
      const rows = (query: string) => owner.sql(query);

      // A granted proposal commits as an ordinary command: Keeper the executing actor, the member
      // the initiator, and the turn's run records the step.
      const offered = await say("m1", "fixture:offer fixture.water-bowl water");
      expect(offered.command).toMatchObject({
        capability: "world.command",
        status: "committed",
        code: null,
      });
      const commandId = offered.command?.commandId;
      expect(
        await rows(
          `SELECT status || ' ' || (attribution->>'effectiveActorId') || ' ' ||
                  (attribution->>'personaId') || ' ' || (attribution->>'causalRootActionId')
             FROM clockgrove.command_receipts WHERE command_id = '${commandId}'`,
        ),
      ).toBe(`committed ${KEEPER} persona-caretaker action-${commandId}`);
      expect(
        await rows(
          `SELECT s.status || ' ' || s.tool || ' ' || s.command_id
             FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r ON r.run_id = s.run_id
            WHERE r.session_id = '${sessionId}' AND s.kind = 'world_command_proposal'`,
        ),
      ).toBe(`succeeded world.command ${commandId}`);

      // The validator's refusal is a receipt too; the proposal text cannot bypass it.
      const wrongKind = await say("m2", "fixture:offer fixture.water-bowl gold");
      expect(wrongKind.command?.status).toBe("refused");
      expect(wrongKind.command?.commandId).not.toBeNull();

      // A proposal beyond the grant, as retrieved text could ask for, never reaches the world.
      const receipts = await rows("SELECT count(*) FROM clockgrove.command_receipts");
      const widened = await say("m3", "fixture:call world.command resource.retire");
      const unknown = await say("m4", "fixture:call mcp.fetch resource.offer");
      expect([widened.command, unknown.command]).toMatchObject([
        { status: "refused", code: "command_type_not_granted", commandId: null },
        { status: "refused", code: "unknown_capability", commandId: null },
      ]);
      expect(await rows("SELECT count(*) FROM clockgrove.command_receipts")).toBe(receipts);

      // Every run, refused proposals included, is initiated by the Caretaker and executed by Keeper.
      expect(
        await rows(
          `SELECT string_agg(DISTINCT persona_id || ' ' || actor_id, ',') FROM clockgrove.agent_runs WHERE session_id = '${sessionId}'`,
        ),
      ).toBe(`persona-caretaker ${KEEPER}`);
    });
  },
  240_000,
);
