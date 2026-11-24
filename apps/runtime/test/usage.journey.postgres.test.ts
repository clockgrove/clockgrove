import { decodeConversationSession, type UsagePage } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/usage.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const INSPECTOR = "outsider-session-token";
const WINDOW = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      // The member talks; a second principal reads usage with the inspect grant and operator evidence.
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
                    'membership-outsider', 'persona-outsider', roles,
                    array_append(grants, 'runtime:world-inspect'),
                    '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}', now()
               FROM clockgrove.world_memberships WHERE principal_id = 'principal-runtime'`,
        );
      },
    });
  },
  240_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "turns every ended model step into one usage event a developer queries by player and window",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const usage = async (fields: object, credential = INSPECTOR) => {
        const answer = await post("/v1/runtime/usage/query", { ...WINDOW, ...fields }, credential);
        return { status: answer.status, page: answer.body as UsagePage };
      };
      const session = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      ).sessionId;
      for (const [messageId, text] of [
        ["m1", "Find the acorns."],
        ["m2", "Hide them by the fence."],
      ])
        await post("/v1/runtime/talk", { sessionId: session, messageId, text });

      // A model step that ended without a call record: its quantities are unknown, not zero.
      await owner.sql(
        `INSERT INTO clockgrove.agent_runs (tenant_id, run_id, world_id, timeline_id, partition_id,
           space_id, session_id, actor_id, principal_id, persona_id, activation, input_message_id,
           root_run_id, model, prompt_version, input_revision, summary)
         SELECT tenant_id, 'run-unreported', world_id, timeline_id, partition_id, space_id,
                session_id, actor_id, principal_id, persona_id, activation, 'm3', 'run-unreported',
                model, prompt_version, input_revision, 'Unreported attempt'
           FROM clockgrove.agent_runs WHERE session_id = '${session}' LIMIT 1;
         INSERT INTO clockgrove.run_steps (tenant_id, run_id, session_id, step, kind, model, summary)
           SELECT tenant_id, run_id, session_id, 1, 'model_attempt', model, 'Model attempt'
             FROM clockgrove.agent_runs WHERE run_id = 'run-unreported';
         UPDATE clockgrove.run_steps SET status = 'failed', outcome_code = 'model_unavailable',
                ended_at = now() WHERE run_id = 'run-unreported';`,
      );

      const all = await usage({ principalId: "principal-runtime" });
      const runs = new Map(
        (
          await owner.sql(
            `SELECT string_agg(run_id || '=' || input_message_id, ',') FROM clockgrove.agent_runs
              WHERE session_id = '${session}'`,
          )
        )
          .trim()
          .split(",")
          .map((pair) => pair.split("=") as [string, string]),
      );
      // A delivery's ID is a digest of its key; its shape is what is stable to assert.
      const id = (eventId: string) =>
        /^delivery:[0-9a-f]{64}$/u.test(eventId) ? "delivery" : eventId;
      const run = (message: string) => [...runs].find(([, input]) => input === message)?.[0];
      const step = (message: string, n: number) => `run_step:${run(message)}:${n}`;
      expect(all.status, JSON.stringify(all.page)).toBe(200);
      expect(
        all.page.events.map((event) => [
          id(event.eventId),
          event.category,
          event.source,
          event.resource,
          event.status,
          event.outcomeCode,
          event.principalId,
          event.personaId,
          event.actorId,
          event.sessionId,
          event.runId,
          event.rootRunId,
          event.quantities,
          event.worldTime !== null,
        ]),
      ).toEqual([
        ...["m1", "m2"].flatMap((message) => [
          [
            step(message, 2),
            "model_call",
            "run_step",
            "scripted-fixture-v1",
            "succeeded",
            null,
            "principal-runtime",
            "persona-runtime",
            "fixture.keeper",
            session,
            // A Talk run is its own causal root.
            run(message),
            run(message),
            {
              calls: 1,
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
            },
            true,
          ],
          // The reply's governed delivery, which the fake sink received.
          [
            "delivery",
            "delivery",
            "delivery_receipt",
            "fake",
            "delivered",
            null,
            "principal-runtime",
            null,
            "fixture.keeper",
            session,
            // The response's run: the run that committed the reply to the message.
            run(message),
            run(message),
            { deliveries: 1 },
            true,
          ],
        ]),
        [
          "run_step:run-unreported:1",
          "model_call",
          "run_step",
          "scripted-fixture-v1",
          "failed",
          "model_unavailable",
          "principal-runtime",
          "persona-runtime",
          "fixture.keeper",
          session,
          "run-unreported",
          "run-unreported",
          {
            calls: null,
            cacheWriteInputTokens: null,
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cachedInputTokens: null,
          },
          true,
        ],
      ]);
      expect(all.page.next).toBeNull();
      const ids = all.page.events.map((event) => event.eventId);
      expect(new Set(ids).size).toBe(5);
      // No money in the record.
      expect(JSON.stringify(all.page)).not.toMatch(/cost|usd|price|amount|currency/i);

      // Paging and reading twice return the same stable events; no read adds or repeats one.
      const first = await usage({ limit: 1 });
      const rest = await usage({ after: first.page.next });
      expect([
        first.page.events.map((event) => event.eventId),
        first.page.next === first.page.events[0]?.sequence,
        [...first.page.events, ...rest.page.events].map((event) => event.eventId),
        (await usage({})).page.events.map((event) => event.eventId),
      ]).toEqual([[step("m1", 2)], true, ids, ids]);

      // The feed: no window, after a sequence, in sequence order.
      const feed = await post("/v1/runtime/usage/query", { after: first.page.next }, INSPECTOR);
      expect((feed.body as UsagePage).events.map((event) => event.eventId)).toEqual(ids.slice(1));

      // Another player and a window before the talk see none of it.
      expect([
        (await usage({ principalId: "principal-outsider" })).page.events,
        (await usage({ from: "2000-01-01T00:00:00Z", to: "2001-01-01T00:00:00Z" })).page.events,
      ]).toEqual([[], []]);

      // The member without the inspect grant is refused; every read is audited.
      expect((await usage({}, MEMBER)).status).toBe(403);
      expect(
        (
          await owner.sql(
            `SELECT string_agg(decision || ':' || reason_code, ',' ORDER BY accessed_at, decision)
               FROM clockgrove.inspector_accesses WHERE subject = 'usage-events'`,
          )
        ).trim(),
      ).toBe(
        "allow:served,allow:served,allow:served,allow:served,allow:served,allow:served,allow:served,deny:runtime-grant-missing",
      );
      // The runtime role writes no usage itself.
      expect(
        (
          await owner.sql(
            `SELECT has_table_privilege('clockgrove_runtime', 'clockgrove.usage_events', 'INSERT')`,
          )
        ).trim(),
      ).toBe("f");
    });
  },
  180_000,
);
