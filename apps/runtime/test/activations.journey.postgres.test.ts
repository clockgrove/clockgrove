import { decodeConversationSession } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/activations.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const ACTOR = "fixture.keeper";

it.skipIf(isNativeWorldOwnerChild())(
  "owns proactive PostgreSQL and native runtime",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      prepare: async (fixture) => {
        const { truthOf } = await import("./world-fixture.js");
        await truthOf(fixture)(
          `UPDATE clockgrove.world_memberships
            SET grants = array_append(grants, 'runtime:world-observe'),
                privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "coalesces causal and heartbeat wakes, suppresses no-ops, defers budgets and recovers an alarm turn",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = async (op: string, fields: object = {}) => {
        const response = await owner.request(
          `/v1/runtime/activations/${op}`,
          {
            version: 1,
            scope: owner.scope,
            actorId: ACTOR,
            ...fields,
          },
          MEMBER,
        );
        expect(response.status).toBe(200);
        return response.body as Record<string, unknown>;
      };
      const agent = async (fields: object) => {
        const response = await owner.request(
          "/actor-agent",
          { version: 1, scope: owner.scope, actorId: ACTOR, ...fields },
          MEMBER,
        );
        expect(response.status).toBe(200);
        return response.body;
      };
      const created = await owner.request(
        "/v1/runtime/conversations/create",
        {
          version: 1,
          ...owner.scope,
          actorId: ACTOR,
        },
        MEMBER,
      );
      expect(created.status).toBe(200);
      const sessionId = decodeConversationSession(created.body).sessionId;
      const configure = (
        id: string,
        kind: string,
        fields: object = {},
        modelBudget = 10,
        allowModel = true,
      ) =>
        post("configure", {
          configuration: {
            id,
            sessionId,
            kind,
            nextWakeAt: null,
            intervalMs: null,
            input: "Consider the changed world",
            priority: 1,
            enabled: true,
            compiledRoutine: "escalate",
            ...fields,
          },
          policy: { allowModel, modelBudget },
        });
      const wake = (configurationId: string, causalRoot: string, reason: object) =>
        post("wake", {
          wake: { configurationId, causalRoot, reason, evidence: `evidence:${causalRoot}` },
        });
      const counts = () =>
        owner.sql(
          `SELECT (SELECT count(*) FROM clockgrove.actor_activations)
          || '/' || (SELECT count(*) FROM clockgrove.conversation_turn_fibers)
          || '/' || (SELECT count(*) FROM clockgrove.conversation_messages)`,
        );
      const denied = await owner.request(
        "/v1/runtime/activations/configure",
        {
          version: 1,
          scope: owner.scope,
          actorId: ACTOR,
          configuration: {
            id: "outsider",
            sessionId,
            kind: "heartbeat",
            nextWakeAt: null,
            intervalMs: null,
            input: "unauthorized",
            priority: 1,
            enabled: true,
            compiledRoutine: "escalate",
          },
          policy: { allowModel: true, modelBudget: 10 },
        },
        "outsider-session-token",
      );
      expect(denied.status).toBe(403);
      expect(await counts()).toBe("0/0/0");
      await configure("rain", "subscription", { eventType: "rain.started" });
      await configure("perceived-rain", "perception");
      const [rain, perceived] = await Promise.all([
        wake("rain", "rain-root", {
          kind: "subscription",
          subscriptionId: "rain",
          eventId: "rain-event",
        }),
        wake("perceived-rain", "rain-root", {
          kind: "perception",
          perceptionId: "rain-perception",
        }),
      ]);
      expect(rain.activationId).toBe(perceived.activationId);
      expect(rain.causalRoot).toBe("rain-root");
      expect(await counts()).toBe("1/1/2");
      expect(await agent({ op: "model-calls" })).toBe(1);
      expect(
        await owner.sql(
          `SELECT principal_id || '/' || causal_root || '/' || evidence
           FROM clockgrove.actor_activations`,
        ),
      ).toBe("principal-runtime/rain-root/evidence:rain-root");

      await configure("pulse", "heartbeat");
      await agent({ op: "fault", phase: "hold:context_ready" });
      const firstPulse = wake("pulse", "pulse-root", { kind: "heartbeat", heartbeatId: "pulse" });
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE phase = 'context_ready'`,
          ),
        )
        .toBe("1");
      const secondPulse = wake("pulse", "another-pulse-root", {
        kind: "heartbeat",
        heartbeatId: "pulse",
      });
      const duplicatePulse = wake("pulse", "pulse-root", {
        kind: "heartbeat",
        heartbeatId: "pulse",
      });
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.actor_activations WHERE configuration_id = 'pulse'`,
          ),
        )
        .toBe("2");
      await agent({ op: "fault", phase: null });
      await agent({ op: "release" });
      const [pulse, concurrent, repeated] = await Promise.all([
        firstPulse,
        secondPulse,
        duplicatePulse,
      ]);
      expect([concurrent.activationId, repeated.activationId]).toEqual([
        pulse.activationId,
        pulse.activationId,
      ]);
      expect(await counts()).toBe("3/2/4");
      expect(await agent({ op: "model-calls" })).toBe(2);
      expect(
        await owner.sql(
          `SELECT reason::text FROM clockgrove.actor_activations WHERE causal_root = 'pulse-root'`,
        ),
      ).toBe('{"kind": "heartbeat", "heartbeatId": "pulse"}');

      await configure("idle", "heartbeat", { input: "", compiledRoutine: "noop" });
      const idle = await wake("idle", "idle-root", { kind: "heartbeat", heartbeatId: "idle" });
      expect(idle).toMatchObject({
        status: "noop",
        outcome: "compiled_noop",
        causalRoot: "idle-root",
      });
      const idleAgain = await wake("idle", "idle-root", { kind: "heartbeat", heartbeatId: "idle" });
      expect(idleAgain.activationId).toBe(idle.activationId);
      expect(await counts()).toBe("4/2/4");
      expect(await agent({ op: "model-calls" })).toBe(2);

      await configure("policy", "threshold", {}, 10, false);
      expect(
        await wake("policy", "policy-root", { kind: "threshold", conditionId: "policy" }),
      ).toMatchObject({ status: "deferred", outcome: "policy_denied" });
      expect(await counts()).toBe("5/2/4");
      expect(await agent({ op: "model-calls" })).toBe(2);

      await configure("policy", "threshold", { enabled: false }, 10, false);

      const due = Date.now() + 60_000;
      await configure("blocked", "scheduled_intention", { nextWakeAt: due }, 2);
      const blocked = await wake("blocked", "budget-root", {
        kind: "scheduled_intention",
        scheduleId: "blocked",
      });
      expect(blocked).toMatchObject({ status: "deferred", outcome: "budget_exhausted" });
      expect(await counts()).toBe("6/2/4");
      expect(await agent({ op: "model-calls" })).toBe(2);
      const inspection = await post("inspect");
      expect(inspection.modelCallsReserved).toBe(2);
      expect(inspection.nextWakeAt).toBe(due);
      expect(inspection.activations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            causalRoot: "budget-root",
            status: "deferred",
            outcome: "budget_exhausted",
          }),
        ]),
      );

      // A callback that read its inspection before the daily configuration committed must not
      // cancel the daily wake (issue 80): its last arming is held across that commit. Armings
      // queue behind the held one, so neither configuration is awaited until the release.
      await agent({ op: "fault", phase: "hold:activation-planning" });
      const unblocked = configure("blocked", "scheduled_intention", { enabled: false }, 10);
      await expect.poll(() => agent({ op: "held" })).toBe(true);
      await agent({ op: "fault", phase: "proposal_validating" });
      const dailyDue = Date.now() + 1_000;
      const daily = configure("daily", "scheduled_intention", {
        nextWakeAt: dailyDue,
        intervalMs: 86_400_000,
        input: "Check the daily intention",
      });
      await expect
        .poll(() =>
          owner.sql(`SELECT count(*) FROM clockgrove.actor_activation_policies,
            jsonb_array_elements(configurations) c WHERE c->>'id' = 'daily'`),
        )
        .toBe("1");
      await agent({ op: "release" });
      await Promise.all([unblocked, daily]);
      await owner.sql(`INSERT INTO clockgrove.tenant_principals (tenant_id,principal_id)
        SELECT tenant_id,'principal-outsider' FROM clockgrove.tenant_principals WHERE principal_id='principal-runtime';
        INSERT INTO clockgrove.world_memberships
        (tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
        SELECT tenant_id,world_id,timeline_id,space_id,'principal-outsider','observer-membership',
          'observer-persona',roles,ARRAY['runtime:world-observe'],privacy_ceiling,committed_at
        FROM clockgrove.world_memberships WHERE principal_id='principal-runtime'`);
      const observer = await owner.request(
        "/v1/runtime/activations/inspect",
        { version: 1, scope: owner.scope, actorId: ACTOR },
        "outsider-session-token",
      );
      expect(observer.status).toBe(200);
      expect(observer.body).toMatchObject({
        configurations: [],
        activations: [],
        nextWakeAt: null,
      });
      // Only SQL observes the autonomous alarm: no client call drains or recovers due work. The
      // fault ends the incarnation at `proposal_validating`; the successor alarm the owner persisted
      // before the turn recovers it, and that alarm (floored to a whole second by the SDK) can fire
      // within milliseconds of the crash, so the crash is read from the durable runs, not the phase.
      // The poll's 30 s ends before a quiet poll one minute out, so the wake keeps its due time.
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.actor_activations
          WHERE configuration_id = 'daily' AND status = 'completed'`,
          ),
        )
        .toBe("1");
      expect(await counts()).toBe("7/3/6");
      expect(await agent({ op: "model-calls" })).toBe(3);
      expect(
        await owner.sql(
          `SELECT f.phase || '/' || f.attempt || '/' || (a.reason->>'kind')
           FROM clockgrove.actor_activations a
           JOIN clockgrove.conversation_turn_fibers f
             ON f.tenant_id = a.tenant_id AND f.session_id = a.session_id AND f.message_id = a.message_id
          WHERE a.configuration_id = 'daily'`,
        ),
      ).toBe("completed/2/scheduled_intention");
      // The first attempt answered and was lost before commit; the second committed that answer.
      expect(
        await owner.sql(
          `SELECT string_agg(r.status || '/' || coalesce(r.outcome_code, '-') || '/' || s.kinds, ' '
             ORDER BY r.started_at)
           FROM clockgrove.actor_activations a
           JOIN clockgrove.agent_runs r
             ON r.tenant_id = a.tenant_id AND r.session_id = a.session_id
            AND r.input_message_id = a.message_id
           CROSS JOIN LATERAL (SELECT string_agg(kind, ',' ORDER BY step) AS kinds
             FROM clockgrove.run_steps WHERE tenant_id = r.tenant_id AND run_id = r.run_id) s
          WHERE a.configuration_id = 'daily'`,
        ),
      ).toBe(
        "abandoned/owner_lost/context_retrieval,model_attempt completed/-/context_retrieval,model_attempt,commit",
      );
      const scheduled = await post("inspect");
      expect(scheduled.configurations).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "daily", intervalMs: 86_400_000 })]),
      );
      expect(scheduled.nextWakeAt).toBe(dailyDue + 86_400_000);
      await configure("journal", "subscription", {
        eventType: "ClockPolicyChanged",
        compiledRoutine: "noop",
      });
      // The event commits after the subscription's first check: its commit hint wakes the actor.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(
        (
          await owner.submit({
            ...advanceCommand(owner.world, "subscription-change", 0n, null),
            type: "PauseWorld",
            payload: { schemaVersion: 1 },
          })
        ).status,
      ).toBe(200);
      await expect
        .poll(() =>
          owner.sql(
            `SELECT reason::text || '/' || evidence || '/' || status
           FROM clockgrove.actor_activations WHERE configuration_id = 'journal'`,
          ),
        )
        .toBe(
          '{"kind": "subscription", "eventId": "subscription-change:event:0", "subscriptionId": "journal"}/journal:subscription-change:event:0/noop',
        );
      expect(await counts()).toBe("8/3/6");
      expect(await agent({ op: "model-calls" })).toBe(3);

      await configure("recheck", "heartbeat", {}, 3);
      const recheckReason = { kind: "heartbeat", heartbeatId: "recheck" };
      expect(await wake("recheck", "recheck-root", recheckReason)).toMatchObject({
        status: "deferred",
        outcome: "budget_exhausted",
      });
      await configure("recheck", "heartbeat", {}, 3, false);
      expect(await wake("recheck", "recheck-root", recheckReason)).toMatchObject({
        status: "deferred",
        outcome: "policy_denied",
      });
      await configure("recheck", "heartbeat", { compiledRoutine: "noop" });
      expect(await wake("recheck", "recheck-root", recheckReason)).toMatchObject({
        status: "noop",
        outcome: "compiled_noop",
      });
      expect((await post("inspect")).configurations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "recheck", enabled: false, nextWakeAt: null }),
        ]),
      );

      await configure("gate", "scheduled_intention");
      await agent({ op: "fault", phase: "hold:context_ready" });
      const gated = wake("gate", "gate-root", { kind: "scheduled_intention", scheduleId: "gate" });
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE phase='context_ready'`,
          ),
        )
        .toBe("1");
      await configure("gate", "scheduled_intention", {
        compiledRoutine: "noop",
        nextWakeAt: Date.now() + 60_000,
      });
      await agent({ op: "fault", phase: null });
      await agent({ op: "release" });
      await gated;
      expect(
        await owner.sql(
          `SELECT status || '/' || outcome FROM clockgrove.actor_activations WHERE causal_root='gate-root'`,
        ),
      ).toBe("noop/compiled_noop");
      expect((await post("inspect")).configurations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "gate", enabled: false, nextWakeAt: null }),
        ]),
      );
      expect(await agent({ op: "model-calls" })).toBe(3);
    });
  },
  240_000,
);
