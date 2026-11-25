import type { ConversationParticipant } from "@clockgrove/application";
import { decodeBrowserScope, decodeConversationSession } from "@clockgrove/contracts";
import { PostgreSqlGovernedDelivery } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { truthOf } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/actor-mute.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const OPERATOR = "outsider-session-token";

// Issue 374 (G8): an operator's mute stops an actor's or one conversation's turns, deliveries and
// effects at once, with no model call; withdrawn consent stops a held delivery the same way.
it("mutes an actor or one conversation at once: no turn, delivery or model call starts", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks and receives deliveries; the operator governs Keeper and talks to no one.
      prepare: async (fixture) => {
        await truthOf(fixture)(`UPDATE clockgrove.world_memberships
            SET grants = array_append(grants, 'runtime:world-observe'),
                privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}';
          INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
            SELECT DISTINCT tenant_id, 'principal-outsider' FROM clockgrove.world_memberships;
          INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id,
              principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
            SELECT tenant_id, world_id, timeline_id, space_id, 'principal-outsider',
                   'membership-outsider', 'persona-outsider', roles,
                   grants || ARRAY['runtime:actor-govern'],
                   '{"version":1,"allowedCategories":["public_scene","private_cognition"]}', now()
              FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`);
      },
    });
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    const actorId = "fixture.keeper";
    const post = (path: string, fields: object, credential = MEMBER) =>
      owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
    const mute = (sessionId: string | null, muted: boolean, credential = OPERATOR) =>
      post("/v1/runtime/actor-mute", { actorId, sessionId, muted }, credential);
    const talk = async (sessionId: string, messageId: string) =>
      (await post("/v1/runtime/talk", { sessionId, messageId, text: "How many acorns?" })).status;
    const open = async (threadId: string) =>
      decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId, channel: "fake", threadId }))
          .body,
      );
    const runs = (sessionId: string) =>
      owner.sql(`SELECT count(*) FROM clockgrove.agent_runs WHERE session_id = '${sessionId}'`);
    const a = await open("thread-a");
    const b = (await open("thread-b")).sessionId;

    // Only an actor-govern operator mutes, and only a conversation of that actor.
    expect(await mute(a.sessionId, true, MEMBER)).toEqual({
      status: 403,
      body: { error: "authorization_refused" },
    });
    expect(await mute("absent-session", true)).toEqual({
      status: 404,
      body: { error: "conversation_not_found" },
    });
    // An actor with no conversation is no target, and an unmute of what was never muted writes
    // nothing: the table keeps at most one row per actor with a session and one per session.
    expect(
      await post(
        "/v1/runtime/actor-mute",
        { actorId: "fixture.nobody", sessionId: null, muted: true },
        OPERATOR,
      ),
    ).toEqual({ status: 404, body: { error: "conversation_not_found" } });
    expect((await mute(b, false)).body).toMatchObject({ sessionId: b, muted: false, version: 0 });
    expect(await owner.sql("SELECT count(*) FROM clockgrove.actor_mutes")).toBe("0");

    // The mute has its own budget: an operator who spent the inspector's 300 an hour (0028)
    // reading during an incident still mutes at once.
    await owner.sql(`INSERT INTO clockgrove.inspector_accesses (tenant_id, principal_id, world_id,
        timeline_id, space_id, decision, reason_code, subject)
      SELECT m.tenant_id, m.principal_id, m.world_id, m.timeline_id, m.space_id, 'allow', 'served',
             'runtime-state'
        FROM clockgrove.world_memberships m, generate_series(1, 300)
       WHERE m.principal_id = 'principal-outsider'`);
    const muted = await mute(a.sessionId, true);
    expect(muted.status).toBe(200);
    expect(muted.body).toMatchObject({
      actorId,
      sessionId: a.sessionId,
      muted: true,
      version: 1,
      changedBy: "principal-outsider",
    });

    // A muted conversation starts no turn and asks no model; another conversation is untouched.
    expect(await talk(a.sessionId, "a1")).toBe(409);
    expect(
      (await post("/v1/runtime/talk", { sessionId: a.sessionId, messageId: "a1", text: "x" })).body,
    ).toEqual({ error: "conversation_muted" });
    expect(await runs(a.sessionId)).toBe("0");
    expect(
      await owner.sql(
        `SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE session_id = '${a.sessionId}'`,
      ),
    ).toBe("0");
    expect(await talk(b, "b1")).toBe(200);
    expect((await mute(a.sessionId, false)).body).toMatchObject({ muted: false, version: 2 });
    expect(await talk(a.sessionId, "a1")).toBe(200);
    // Each change is kept with who made it, after the next change has replaced the current row.
    expect(
      await owner.sql(
        `SELECT string_agg(principal_id||':'||muted||':'||version, ',' ORDER BY change_id)
           FROM clockgrove.actor_mute_changes WHERE session_id = '${a.sessionId}'`,
      ),
    ).toBe("principal-outsider:true:1,principal-outsider:false:2");

    // A delivery held for quiet hours, then the whole actor is muted.
    const participant: ConversationParticipant = {
      tenantId: a.scope.tenantId,
      ...a.participants[0]!,
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    const target = { scope: decodeBrowserScope(owner.scope), actorId, sessionId: a.sessionId };
    const consent = (enabled: boolean) => {
      const now = new Date();
      const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
      // Decision: quiet for the next hour, longer than this journey, so a note is always held.
      return owner.withSqlClient((client) =>
        new PostgreSqlGovernedDelivery(client).configureConsent(participant, target, {
          enabled,
          timezone: "UTC",
          quietHours: { startMinute: minute, endMinute: (minute + 60) % 1440 },
          budgetLimit: 10,
        }),
      );
    };
    const activation = async (op: string, fields: object) => {
      const answer = await owner.request(`/v1/runtime/activations/${op}`, {
        version: 1,
        scope: owner.scope,
        actorId,
        ...fields,
      });
      expect(answer.status).toBe(200);
      return answer.body as { outcome?: string };
    };
    const wake = (causalRoot: string) =>
      activation("wake", {
        wake: {
          configurationId: "note",
          causalRoot,
          reason: { kind: "operator", commandId: causalRoot },
          evidence: "fixture",
        },
      });
    const resume = () =>
      owner.withSqlClient((client) =>
        new PostgreSqlGovernedDelivery(client).resumePending(
          { scope: target.scope, actorId, participant },
          null,
        ),
      );
    const deliveries = () =>
      owner.sql(
        "SELECT string_agg(status||':'||(receipt->>'reason'), ',' ORDER BY status||':'||(receipt->>'reason')) FROM clockgrove.deliveries WHERE receipt->'request'->'reason'->>'kind'='event'",
      );
    await consent(true);
    await activation("configure", {
      configuration: {
        id: "note",
        sessionId: a.sessionId,
        kind: "operator",
        nextWakeAt: null,
        intervalMs: null,
        input: "Send a quiet private note",
        priority: 1,
        enabled: true,
        compiledRoutine: "escalate",
        delivery: { urgency: "normal", quietHoursBehavior: "delay" },
      },
      policy: { allowModel: true, modelBudget: 10 },
    });
    await wake("held-note");
    expect(await deliveries()).toBe("delayed:quiet_hours");
    expect((await mute(null, true)).body).toMatchObject({ sessionId: null, muted: true });
    const before = await owner.sql("SELECT count(*) FROM clockgrove.agent_runs");
    // Muted: the held delivery is rejected when it is checked, a wake starts no turn, and neither
    // conversation talks; no run, so no model call, is added.
    await resume();
    expect(await deliveries()).toBe("rejected:actor_muted");
    expect(await wake("muted-note")).toMatchObject({ outcome: "conversation_muted" });
    expect(await talk(b, "b2")).toBe(409);
    expect(await owner.sql("SELECT count(*) FROM clockgrove.agent_runs")).toBe(before);
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.delivery_sink_receipts WHERE dedupe_key LIKE 'activation:%'",
      ),
    ).toBe("0");

    // Unmuted, a held delivery whose consent is then withdrawn is stopped the same way.
    await mute(null, false);
    await wake("consent-note");
    expect(await deliveries()).toBe("delayed:quiet_hours,rejected:actor_muted");
    await consent(false);
    await resume();
    expect(await deliveries()).toBe("rejected:actor_muted,rejected:consent_required");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.delivery_sink_receipts WHERE dedupe_key LIKE 'activation:%'",
      ),
    ).toBe("0");
  });
}, 300_000);
