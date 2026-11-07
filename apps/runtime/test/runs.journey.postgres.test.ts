import { decodeConversationSession, decodeTalkReceipt, type RunWalk } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/runs.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const INSPECTOR = "outsider-session-token";
const REPLY = (n: number) =>
  `Scripted fixture reply: you have said ${n} ${n === 1 ? "thing" : "things"} to me in this conversation.`;

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "raccoons", {
      // The member talks; a second principal inspects with operator evidence but no conversation.
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
  "gives every Talk attempt one durable disposition an inspector walks from turn to consequence and back",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object, credential = MEMBER) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields }, credential);
      const inspect = async (entry: object) => {
        const answer = await post("/v1/runtime/runs/inspect", entry, INSPECTOR);
        expect(answer.status).toBe(200);
        return answer.body as RunWalk;
      };
      const session = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "grove.stevie" })).body,
      ).sessionId;
      const talk = async (messageId: string, text: string) =>
        decodeTalkReceipt(
          (await post("/v1/runtime/talk", { sessionId: session, messageId, text })).body,
        );
      await talk("m1", "Find the acorns.");
      await talk("m2", "Hide them by the fence.");

      // Two attempts whose requests died: one at m3, just now, and one two minutes ago.
      const dead = (runId: string, messageId: string, age: string) =>
        `INSERT INTO clockgrove.agent_runs (tenant_id, run_id, world_id, timeline_id, partition_id,
           space_id, session_id, actor_id, principal_id, persona_id, activation, input_message_id,
           root_run_id, model, prompt_version, input_revision, summary, started_at)
         SELECT tenant_id, '${runId}', world_id, timeline_id, partition_id, space_id, session_id,
                actor_id, 'principal-runtime', 'persona-runtime', 'conversation_message',
                '${messageId}', '${runId}', 'scripted-fixture-v1', 'scripted-prompt-v1', 4,
                'Scripted reply to Caretaker message 3', now() - interval '${age}'
           FROM clockgrove.conversation_sessions WHERE session_id = '${session}';
         INSERT INTO clockgrove.run_steps (tenant_id, run_id, session_id, step, kind, model, summary)
           SELECT tenant_id, '${runId}', '${session}', 1, 'model_attempt', 'scripted-fixture-v1',
                  'Scripted model attempt'
             FROM clockgrove.conversation_sessions WHERE session_id = '${session}';`;
      await owner.sql(
        dead("run-died-at-m3", "m3", "1 second") + dead("run-lost", "m9", "2 minutes"),
      );
      const third = await talk("m3", "Count them tonight.");
      expect(third.reply.text).toBe(REPLY(3));

      // Every attempt reached exactly one terminal disposition, its steps with it.
      expect(
        (
          await owner.sql(
            `SELECT string_agg(run.input_message_id || ':' || run.status || ':' ||
                      coalesce(run.outcome_code, '-') || ':' || coalesce(run.turn::text, '-') || ':' ||
                      (SELECT string_agg(step.kind || '=' || step.status || '/' ||
                                         (step.ended_at IS NOT NULL)::text, ',' ORDER BY step.step)
                         FROM clockgrove.run_steps AS step
                        WHERE step.tenant_id = run.tenant_id AND step.run_id = run.run_id),
                      ' ' ORDER BY run.input_message_id, run.status)
               FROM clockgrove.agent_runs AS run WHERE run.session_id = '${session}'`,
          )
        ).trim(),
      ).toBe(
        [
          "m1:completed:-:1:model_attempt=succeeded/true,commit=succeeded/true",
          "m2:completed:-:2:model_attempt=succeeded/true,commit=succeeded/true",
          "m3:completed:-:3:model_attempt=succeeded/true,commit=succeeded/true",
          "m3:superseded:retried:-:model_attempt=superseded/true",
          "m9:abandoned:stale:-:model_attempt=abandoned/true",
        ].join(" "),
      );

      // From the turn: both attempts at its input message, with the committed reply. Without the
      // `conversation` category the inspector sees only metadata: no payload text.
      const turn = await inspect({ sessionId: session, turn: 3 });
      const completed = turn.runs.find((run) => run.status === "completed");
      if (completed === undefined) throw new Error("turn 3 has no completed run");
      const steps = (walk: RunWalk) =>
        walk.runs.map((run) => [
          run.runId === completed.runId ? "completed-run" : run.runId,
          run.status,
          run.turn,
          run.rootRunId === run.runId,
          run.prompt?.text ?? null,
          run.steps.map((step) => [
            step.kind,
            step.status,
            step.model,
            step.outputMessageId,
            step.costMicrousd,
            step.input?.text ?? null,
            step.output?.text ?? null,
          ]),
        ]);
      expect(steps(turn)).toEqual([
        [
          "run-died-at-m3",
          "superseded",
          null,
          true,
          null,
          [["model_attempt", "superseded", "scripted-fixture-v1", null, null, null, null]],
        ],
        [
          "completed-run",
          "completed",
          3,
          true,
          null,
          [
            ["model_attempt", "succeeded", "scripted-fixture-v1", null, 0, null, null],
            ["commit", "succeeded", null, "m3:reply", null, null, null],
          ],
        ],
      ]);
      expect([
        completed.actorId,
        completed.principalId,
        completed.personaId,
        completed.inputMessageId,
        completed.inputRevision,
        completed.prompt?.artifactId,
      ]).toEqual([
        "grove.stevie",
        "principal-runtime",
        "persona-runtime",
        "m3",
        4,
        `${session}:prompt:${completed.runId}`,
      ]);

      // Back from the committed reply to the run that produced it; with the category, the exact
      // protected input and output.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
           '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'
          WHERE principal_id = 'principal-outsider'`,
      );
      const back = await inspect({ sessionId: session, messageId: "m3:reply" });
      expect(steps(back)).toEqual([
        [
          "completed-run",
          "completed",
          3,
          true,
          JSON.stringify({
            model: "scripted-fixture-v1",
            promptVersion: "scripted-prompt-v1",
            sessionId: session,
            caretakerMessages: 3,
            input: "Count them tonight.",
          }),
          [
            [
              "model_attempt",
              "succeeded",
              "scripted-fixture-v1",
              null,
              0,
              JSON.stringify({
                model: "scripted-fixture-v1",
                promptVersion: "scripted-prompt-v1",
                sessionId: session,
                caretakerMessages: 3,
                input: "Count them tonight.",
              }),
              REPLY(3),
            ],
            ["commit", "succeeded", null, "m3:reply", null, null, null],
          ],
        ],
      ]);

      // A child run proposing a world command links to its parent step and causal root; the walk
      // from the command reaches the whole tree.
      const commandId = (
        await owner.sql(
          "SELECT command_id FROM clockgrove.command_receipts ORDER BY command_id LIMIT 1",
        )
      ).trim();
      await owner.sql(
        `INSERT INTO clockgrove.agent_runs (tenant_id, run_id, world_id, timeline_id, partition_id,
           space_id, session_id, actor_id, principal_id, persona_id, activation, input_message_id,
           parent_run_id, parent_step, root_run_id, model, prompt_version, input_revision, summary)
         SELECT tenant_id, 'run-child', world_id, timeline_id, partition_id, space_id, session_id,
                actor_id, principal_id, persona_id, activation, input_message_id, run_id, 1, run_id,
                model, prompt_version, input_revision, 'Proposes a command'
           FROM clockgrove.agent_runs WHERE run_id = '${completed.runId}';
         INSERT INTO clockgrove.run_steps (tenant_id, run_id, session_id, step, kind, status,
           command_id, summary)
           SELECT tenant_id, 'run-child', session_id, 1, 'world_command_proposal', 'succeeded',
                  '${commandId}', 'Proposed a command'
             FROM clockgrove.agent_runs WHERE run_id = '${completed.runId}';`,
      );
      const tree = await inspect({ commandId });
      expect(
        tree.runs.map((run) => [
          run.runId === completed.runId ? "completed-run" : run.runId,
          run.parentRunId === completed.runId,
          run.parentStep,
          run.rootRunId === completed.runId,
          run.steps.map((step) => step.commandId),
        ]),
      ).toEqual([
        ["completed-run", false, null, true, [null, null]],
        ["run-child", true, 1, true, [commandId]],
      ]);

      // Metadata search lists every attempt and never a payload, even for this ceiling.
      const search = await post("/v1/runtime/runs/search", { sessionId: session }, INSPECTOR);
      const found = (search.body as { runs: { status: string; inputMessageId: string }[] }).runs;
      expect([
        search.status,
        found.map((run) => `${run.inputMessageId}:${run.status}`).sort(),
        JSON.stringify(search.body).includes("acorns") ||
          JSON.stringify(search.body).includes("artifactId"),
      ]).toEqual([
        200,
        [
          "m1:completed",
          "m2:completed",
          "m3:completed",
          "m3:running",
          "m3:superseded",
          "m9:abandoned",
        ],
        false,
      ]);

      // The talking member has no inspect grant; an unknown entry is not found. Each is audited.
      expect(await post("/v1/runtime/runs/inspect", { runId: completed.runId })).toEqual({
        status: 403,
        body: { error: "authorization_refused" },
      });
      expect(await post("/v1/runtime/runs/inspect", { runId: "run-unknown" }, INSPECTOR)).toEqual({
        status: 404,
        body: { error: "run_not_found" },
      });
      expect(
        (
          await owner.sql(
            `SELECT string_agg(decision || ':' || reason_code, ',' ORDER BY accessed_at, decision)
               FROM clockgrove.inspector_accesses WHERE subject = 'agent-runs'`,
          )
        ).trim(),
      ).toBe(
        "allow:served,allow:served,allow:served,allow:served,deny:runtime-grant-missing,allow:not-found",
      );
    });
  },
  180_000,
);
