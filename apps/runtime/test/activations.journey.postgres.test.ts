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
const ACTOR = "grove.stevie";

it.skipIf(isNativeWorldOwnerChild())(
  "owns proactive PostgreSQL and native runtime",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "raccoons", {
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
        const response = await fetch(new URL("/actor-agent", await owner.origin()), {
          method: "POST",
          headers: { authorization: `Bearer ${MEMBER}` },
          body: JSON.stringify({ version: 1, scope: owner.scope, actorId: ACTOR, ...fields }),
        });
        expect(response.status).toBe(200);
        return response.json();
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

      await configure("blocked", "scheduled_intention", { enabled: false }, 10);
      await agent({ op: "fault", phase: "proposal_validating" });
      const dailyDue = Date.now() + 1_000;
      await configure("daily", "scheduled_intention", {
        nextWakeAt: dailyDue,
        intervalMs: 86_400_000,
        input: "Check the daily intention",
      });
      // Only SQL observes the autonomous alarm: no client call drains or recovers due work.
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.conversation_turn_fibers WHERE phase = 'proposal_validating'`,
          ),
        )
        .toBe("1");
      await owner.replace();
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
      const scheduled = await post("inspect");
      expect(scheduled.configurations).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "daily", intervalMs: 86_400_000 })]),
      );
      expect(scheduled.nextWakeAt).toBe(dailyDue + 86_400_000);
      await configure("journal", "subscription", {
        eventType: "ClockPolicyChanged",
        compiledRoutine: "noop",
      });
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
    });
  },
  240_000,
);
