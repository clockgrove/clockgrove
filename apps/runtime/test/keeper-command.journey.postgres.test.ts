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
  "refuses Keeper's unbacked offer through the ordinary Journal and every ungranted proposal",
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

      // A granted offer still needs a physical donor; its ordinary refusal is journaled,
      // with Keeper the executing actor and the member the initiator.
      const offered = await say("m1", "fixture:offer fixture.water-bowl water");
      expect(offered.command).toMatchObject({
        capability: "world.command",
        status: "refused",
        code: "precondition_failed",
      });
      const commandId = offered.command?.commandId;
      expect(
        await rows(
          `SELECT status || ' ' || (attribution->>'effectiveActorId') || ' ' ||
                  (attribution->>'personaId') || ' ' || (attribution->>'causalRootActionId')
             FROM clockgrove.command_receipts WHERE command_id = '${commandId}'`,
        ),
      ).toBe(`rejected ${KEEPER} persona-caretaker action-${commandId}`);
      expect(
        await rows(
          `SELECT s.status || ' ' || s.tool || ' ' || s.command_id
             FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r ON r.run_id = s.run_id
            WHERE r.session_id = '${sessionId}' AND s.kind = 'world_command_proposal'`,
        ),
      ).toBe(`failed world.command ${commandId}`);

      expect(
        await rows(`SELECT count(*) FROM clockgrove.events WHERE command_id = '${commandId}'`),
      ).toBe("0");

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

      // An offer cancelled while held before validation never reaches the world once released.
      const keeper = (fields: object) =>
        owner.request("/actor-agent", { scope: owner.scope, actorId: KEEPER, ...fields }, MEMBER);
      await keeper({ op: "fault", phase: "hold:proposal_validating" });
      const held = post("/v1/runtime/talk", {
        sessionId,
        messageId: "m5",
        text: "fixture:offer fixture.water-bowl water",
      });
      await expect
        .poll(
          async () => (await post("/v1/runtime/turns/status", { sessionId, messageId: "m5" })).body,
        )
        .toMatchObject({ phase: "proposal_validating" });
      await post("/v1/runtime/turns/cancel", { sessionId, messageId: "m5" });
      await keeper({ op: "fault", phase: null });
      await keeper({ op: "release" });
      expect(await held).toEqual({ status: 409, body: { error: "turn_cancelled" } });
      expect(
        await rows(`SELECT count(*) FROM clockgrove.command_receipts WHERE command_id LIKE '%:m5'`),
      ).toBe("0");

      // One journey, three authorities: an influence, Keeper's physical offer and an operator action each keep their own receipt.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET grants = grants ||
           ARRAY['runtime:world-inspect', 'runtime:world-operate']`,
      );
      const influenced = await post("/v1/runtime/influence", {
        intentId: "journey-offer",
        objectId: "fixture.snack-dish",
        resourceKind: "food",
        expectedRevision: "0",
      });
      const influenceId = (influenced.body as { commandId: string }).commandId;
      const operated = await owner.request(
        "/v1/runtime/actions",
        {
          schemaVersion: 1,
          ...owner.scope,
          action: "replay-message",
          messageId: "no-such-message",
        },
        MEMBER,
      );
      expect([influenced.status, operated.status]).toEqual([409, 404]);
      const ids = [influenceId, commandId as string, "no-such-message"];
      expect(new Set(ids).size).toBe(3);
      expect(influenceId).toMatch(/^influence:principal-runtime:/);
      const count = (table: string, column: string, id: string) =>
        rows(`SELECT count(*) FROM clockgrove.${table} WHERE ${column} = '${id}'`);
      const kinds = async (id: string) =>
        [
          await count("command_receipts", "command_id", id),
          await count("events", "command_id", id),
          await count("run_steps", "command_id", id),
          await count("runtime_operator_actions", "message_id", id),
        ].join(",");
      expect(await kinds(influenceId)).toBe("1,0,0,0");
      expect(await kinds(commandId as string)).toBe("1,0,1,0");
      expect(await kinds("no-such-message")).toBe("0,0,0,1");
      expect(
        await rows(
          `SELECT status || ' ' || (attribution->>'personaId') || ' ' ||
                  coalesce(attribution->>'effectiveActorId', 'none')
             FROM clockgrove.command_receipts WHERE command_id = '${influenceId}'`,
        ),
      ).toBe("rejected persona-caretaker principal-runtime");
      expect(
        await rows(
          `SELECT principal_id || ' ' || action || ' ' || decision || ' ' || reason_code
             FROM clockgrove.runtime_operator_actions`,
        ),
      ).toBe("principal-runtime replay-message allow not-found");
    });
  },
  240_000,
);
