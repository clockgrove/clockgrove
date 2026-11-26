import {
  decodeConversationSession,
  decodeTalkReceipt,
  decodeWorldStatus,
  type UsagePage,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-modes.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member plays; a second principal, the developer's server, holds the inspect grant and
      // operator evidence, and operates the world once the test grants it.
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
                    'membership-outsider', 'persona-outsider', ARRAY['member'],
                    array_append(array_remove(grants, 'runtime:world-operate'), 'runtime:world-inspect'),
                    '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "a world's mode, set by the developer's server, is shown and holds at command, Talk and model admission",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const setMode = (mode: string, reason: string | null) =>
        post("/v1/runtime/world-mode", { mode, reason }, OPERATOR);
      const status = async () =>
        decodeWorldStatus((await post("/v1/runtime/world-status", {})).body);
      const session = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      ).sessionId;
      const talk = (messageId: string) =>
        post("/v1/runtime/talk", { sessionId: session, messageId, text: "Hello." });
      let commands = 0;
      const command = async () => {
        commands += 1;
        const to = BigInt((await status()).clock.simulationTime) + 1_000n;
        return owner.submit(advanceCommand(owner.world, `mode-advance-${commands}`, to, null));
      };

      // Restricting the world is the operator's grant, as a budget is.
      expect((await setMode("restricted", "subscription_lapsed")).status).toBe(403);
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-operate')
          WHERE principal_id = 'principal-outsider'`,
      );
      expect((await status()).mode).toBeUndefined();

      // Restricted: the world shows it, play goes on, and no model is called.
      expect((await setMode("restricted", "subscription_lapsed")).body).toEqual({
        mode: "restricted",
        reason: "subscription_lapsed",
      });
      expect((await status()).mode).toEqual({ mode: "restricted", reason: "subscription_lapsed" });
      expect((await command()).status).toBe(200);
      const restricted = decodeTalkReceipt((await talk("m1")).body).reply;
      expect([restricted.serviceOutcome, restricted.text]).toEqual([
        "usage_refused",
        "Usage refused: world_mode_restricted. No model was called.",
      ]);
      expect(
        await owner.sql(
          `SELECT s.outcome_code || '|' || s.summary FROM clockgrove.run_steps s
             JOIN clockgrove.agent_runs r USING (tenant_id, run_id)
            WHERE r.input_message_id = 'm1' AND s.kind = 'model_attempt'`,
        ),
      ).toBe("usage_refused|Usage refused: world_mode_restricted");
      const events = (
        await post(
          "/v1/runtime/usage/query",
          { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" },
          OPERATOR,
        )
      ).body as UsagePage;
      expect(
        events.events
          .filter((event) => event.category === "model_call")
          .map((event) => [event.outcomeCode, event.quantities.calls]),
      ).toEqual([["usage_refused", 0]]);

      // Read-only: the world can be looked at, not acted in.
      expect((await setMode("read_only", "maintenance")).status).toBe(200);
      expect((await status()).mode).toEqual({ mode: "read_only", reason: "maintenance" });
      expect(await talk("m2")).toMatchObject({
        status: 409,
        body: { error: "world_mode_refused" },
      });
      expect(await command()).toMatchObject({
        status: 409,
        body: { error: "world_mode_refused", mode: "read_only", reason: "maintenance" },
      });

      // Paused: shown, and refused the same way.
      expect((await setMode("paused", null)).status).toBe(200);
      expect((await status()).mode).toEqual({ mode: "paused", reason: null });
      expect((await talk("m3")).status).toBe(409);
      expect((await command()).status).toBe(409);

      // Active again: nothing shown, and the model answers.
      expect((await setMode("active", null)).body).toEqual({ mode: "active", reason: null });
      expect((await status()).mode).toBeUndefined();
      expect((await command()).status).toBe(200);
      expect(decodeTalkReceipt((await talk("m4")).body).reply.serviceOutcome).toBeUndefined();
      expect(
        await owner.sql(
          `SELECT string_agg(entry_id, ',' ORDER BY accessed_at) FROM clockgrove.inspector_accesses
            WHERE subject = 'world-mode' AND decision = 'allow'`,
        ),
      ).toBe("restricted,read_only,paused,active");
    });
  },
  180_000,
);
