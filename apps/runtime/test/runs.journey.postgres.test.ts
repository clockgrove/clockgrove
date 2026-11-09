import { createHash } from "node:crypto";
import { decodeConversationSession, decodeTalkReceipt, type RunWalk } from "@clockgrove/contracts";
import { canonicalBytes } from "@clockgrove/kernel";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/runs.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const INSPECTOR = "outsider-session-token";
const parsed = (text: string | null | undefined) =>
  text?.startsWith("{") === true ? JSON.parse(text) : (text ?? null);
const REPLY = (n: number) =>
  `Scripted fixture reply: you have said ${n} ${n === 1 ? "thing" : "things"} to me in this conversation.`;

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd",
  async () => {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
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
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      ).sessionId;
      const talk = async (messageId: string, text: string) =>
        decodeTalkReceipt(
          (await post("/v1/runtime/talk", { sessionId: session, messageId, text })).body,
        );
      await talk("m1", "Find the acorns.");
      await talk("m2", "Hide them by the fence.");

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
          "m1:completed:-:1:context_retrieval=succeeded/true,model_attempt=succeeded/true,commit=succeeded/true",
          "m2:completed:-:2:context_retrieval=succeeded/true,model_attempt=succeeded/true,commit=succeeded/true",
          "m3:completed:-:3:context_retrieval=succeeded/true,model_attempt=succeeded/true,commit=succeeded/true",
        ].join(" "),
      );

      // From the turn: every attempt at its input message (abandoned attempts are proved by
      // turn-fibers.journey), with the committed reply. Without the
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
          parsed(run.prompt?.text),
          run.steps.map((step) => [
            step.kind,
            step.status,
            step.model,
            step.outputMessageId,
            step.costMicrousd,
            parsed(step.input?.text),
            step.output?.text ?? null,
          ]),
        ]);
      expect(steps(turn)).toEqual([
        [
          "completed-run",
          "completed",
          3,
          true,
          null,
          [
            ["context_retrieval", "succeeded", null, null, null, null, null],
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
        "fixture.keeper",
        "principal-runtime",
        "persona-runtime",
        "m3",
        4,
        `${session}:prompt:${completed.runId}`,
      ]);

      // The talking member has no inspect grant yet.
      expect(await post("/v1/runtime/runs/inspect", { runId: completed.runId })).toEqual({
        status: 403,
        body: { error: "authorization_refused" },
      });

      // Back from the committed reply to the run that produced it. Conversation text is
      // participant-only: the outsider sees metadata even with the category, and the participant,
      // once an inspector, sees the exact protected input and output.
      await owner.sql(
        `UPDATE clockgrove.world_memberships SET privacy_ceiling =
           '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}';
         UPDATE clockgrove.world_memberships SET grants = array_append(grants, 'runtime:world-inspect')
          WHERE principal_id = 'principal-runtime'`,
      );
      const outsider = await inspect({ sessionId: session, messageId: "m3:reply" });
      expect(steps(outsider)).toEqual([
        [
          "completed-run",
          "completed",
          3,
          true,
          null,
          [
            ["context_retrieval", "succeeded", null, null, null, null, null],
            ["model_attempt", "succeeded", "scripted-fixture-v1", null, 0, null, null],
            ["commit", "succeeded", null, "m3:reply", null, null, null],
          ],
        ],
      ]);
      const answer = await post(
        "/v1/runtime/runs/inspect",
        { sessionId: session, messageId: "m3:reply" },
        MEMBER,
      );
      const back = answer.body as RunWalk;
      // The exact model input: the session's history and the input, every part labelled untrusted.
      const part = (source: string, version: number, text: string) => ({
        trust: "untrusted",
        source,
        version,
        text,
      });
      // The manifest hash, computed here from the contract in `docs/protocols/context-assembly.md`:
      // SHA-256 of the canonical session, input, revision, budget and entries (history newest first,
      // then the input), independent of the assembler.
      const said = [
        ["m1", "caretaker", "Find the acorns."],
        ["m1:reply", "actor", REPLY(1)],
        ["m2", "caretaker", "Hide them by the fence."],
        ["m2:reply", "actor", REPLY(2)],
        ["m3", "caretaker", "Count them tonight."],
      ] as const;
      const entry = ([id, role, text]: (typeof said)[number], index: number) => ({
        source: index === 4 ? "input" : "message",
        sourceId: id,
        version: index + 1,
        label: role,
        scope: "session",
        writeClass: null,
        sessionId: session,
        state: "active",
        sourceHash: createHash("sha256").update(text).digest("hex"),
        tokens: Math.ceil(Buffer.byteLength(text) / 4),
        decision: "included",
        rule: null,
        section: "untrusted",
        trust: "untrusted",
        promptOrder: index + 1,
      });
      const entries = said.map(entry);
      const manifestHash = createHash("sha256")
        .update(
          canonicalBytes({
            sessionId: session,
            inputMessageId: "m3",
            inputRevision: 4,
            tokenBudget: 4096,
            entries: [...entries.slice(0, 4).reverse(), entries[4]],
          }),
        )
        .digest("hex");
      const prompt = {
        model: "scripted-fixture-v1",
        sessionId: session,
        caretakerMessages: 3,
        promptVersion: "context-prompt-v1",
        manifestHash,
        protected: [],
        governed: [],
        untrusted: [
          part("caretaker", 1, "Find the acorns."),
          part("actor", 2, REPLY(1)),
          part("caretaker", 3, "Hide them by the fence."),
          part("actor", 4, REPLY(2)),
          part("caretaker", 5, "Count them tonight."),
        ],
      };
      expect(answer.status).toBe(200);
      expect(steps(back)).toEqual([
        [
          "completed-run",
          "completed",
          3,
          true,
          prompt,
          [
            ["context_retrieval", "succeeded", null, null, null, null, null],
            ["model_attempt", "succeeded", "scripted-fixture-v1", null, 0, prompt, REPLY(3)],
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
        ["completed-run", false, null, true, [null, null, null]],
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
      ]).toEqual([200, ["m1:completed", "m2:completed", "m3:completed", "m3:running"], false]);

      // An unknown entry is not found. Every access is audited.
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
        "allow:served,deny:runtime-grant-missing,allow:served,allow:served,allow:served,allow:served,allow:not-found",
      );
    });
  },
  180_000,
);
