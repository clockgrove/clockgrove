import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { ACTOR, CAPABILITY, seedResearch, withResearchFixture } from "./research-node-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/research.journey.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns the deterministic read fixture, PostgreSQL, Queue and workerd",
  async () => {
    await withResearchFixture(() =>
      runNativeWorldOwnerProcess(FILE, "fixture/reference", {
        queues: true,
        timeoutMs: 240000,
        inheritOutput: true,
      }),
    );
  },
  300000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "resumes research at both tool boundaries, replays recorded answers and visibly bounds the loop",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (path: string, fields: object) =>
        owner.request(path, { version: 1, ...owner.scope, ...fields });
      await seedResearch(owner);
      const agent = async (phase: string | null) => {
        const response = await fetch(new URL("/actor-agent", await owner.origin()), {
          method: "POST",
          headers: {
            authorization: `Bearer ${["local", "reader", "session"].join("-")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            version: 1,
            ...owner.scope,
            scope: owner.scope,
            actorId: ACTOR,
            op: "fault",
            phase,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
      };
      const open = async () =>
        decodeConversationSession(
          (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
        ).sessionId;
      const talk = (
        sessionId: string,
        n = 1,
        capability = CAPABILITY,
        input: object = { q: "archive" },
      ) =>
        post("/v1/runtime/talk", {
          sessionId,
          messageId: "research",
          text: `fixture:research ${n} ${capability} ${JSON.stringify(input)}`,
        });
      const wait = async (
        sessionId: string,
        capability = CAPABILITY,
        input: object = { q: "archive" },
      ) => {
        await expect
          .poll(
            async () =>
              (await post("/v1/runtime/turns/status", { sessionId, messageId: "research" })).body,
            { timeout: 60000 },
          )
          .toMatchObject({ phase: "completed" });
        return decodeTalkReceipt((await talk(sessionId, 1, capability, input)).body);
      };
      const malformed = await open();
      const malformedReceipt = decodeTalkReceipt(
        (
          await post("/v1/runtime/talk", {
            sessionId: malformed,
            messageId: "malformed",
            text: "fixture:model-malformed",
          })
        ).body,
      );
      expect(malformedReceipt.reply.serviceOutcome).toBe("model_unavailable");
      expect(malformedReceipt.reply.text).toBe(
        "Model unavailable. The model returned an invalid tool proposal.",
      );
      expect(
        await owner.sql(
          `SELECT count(*) FROM clockgrove.effect_intents WHERE run_id IN(SELECT run_id FROM clockgrove.agent_runs WHERE session_id='${malformed}')`,
        ),
      ).toBe("0");
      const baseline = await open();
      await talk(baseline);
      await wait(baseline);
      for (const phase of ["tool_waiting", "tool_completed"]) {
        const sessionId = await open();
        await agent(phase);
        const interrupted = await talk(sessionId);
        expect(interrupted.status).toBe(503);
        if (phase === "tool_completed")
          await expect
            .poll(
              () =>
                owner.sql(
                  `SELECT phase FROM clockgrove.conversation_turn_fibers WHERE session_id='${sessionId}'`,
                ),
              { timeout: 60000 },
            )
            .toBe("tool_completed");
        await agent(null);
        const receipt = await wait(sessionId);
        expect(receipt.reply.text).toContain(
          "Fixture research succeeded: The fixture archive code is ORCHID-42.",
        );
        expect(receipt.reply.text).toMatch(/\[tool:tool:[a-f0-9]{64}\]/u);
        expect(receipt.reply.text).not.toContain("Unexecuted proposal");
        expect(receipt.reply.text).not.toContain("[tool:invented]");
        expect(receipt.reply.text).toContain("[unverified tool citation]");
        const before = await owner.sql("SELECT count(*) FROM clockgrove.effect_attempts");
        expect((await talk(sessionId)).body).toEqual(receipt);
        expect(await owner.sql("SELECT count(*) FROM clockgrove.effect_attempts")).toBe(before);
        expect(
          await owner.sql(
            `SELECT (SELECT count(*) FROM clockgrove.conversation_messages WHERE session_id='${sessionId}')||'/'||(SELECT count(*) FROM clockgrove.effect_intents WHERE run_id IN (SELECT run_id FROM clockgrove.agent_runs WHERE session_id='${sessionId}'))`,
          ),
        ).toBe("2/1");
      }
      await agent(null);
      const multiple = await open();
      await talk(multiple, 2);
      await expect
        .poll(
          async () =>
            (await post("/v1/runtime/turns/status", { sessionId: multiple, messageId: "research" }))
              .body,
          { timeout: 60000 },
        )
        .toMatchObject({ phase: "completed" });
      expect(
        await owner.sql(
          `SELECT (SELECT count(*) FROM clockgrove.effect_intents WHERE run_id IN(SELECT run_id FROM clockgrove.agent_runs WHERE session_id='${multiple}'))||'/'||research_model_steps FROM clockgrove.conversation_turn_fibers WHERE session_id='${multiple}'`,
        ),
      ).toBe("2/3");
      const bounded = await open();
      await talk(bounded, 4);
      await expect
        .poll(
          async () =>
            (await post("/v1/runtime/turns/status", { sessionId: bounded, messageId: "research" }))
              .body,
          { timeout: 60000 },
        )
        .toMatchObject({ phase: "completed", outcomeCode: "tool_calls_exhausted" });
      const boundedReceipt = decodeTalkReceipt((await talk(bounded, 4)).body);
      expect(boundedReceipt.reply.text).toMatch(
        /^Research stopped: tool_calls_exhausted\. No further action was taken\.\n\nResearch evidence: (?:\[tool:tool:[a-f0-9]{64}\] ?){3}$/u,
      );
      // Both internal reads use the same production authority reader, Queue and effect/result path.
      const publicCommand = await owner.sql(
        `SELECT e.command_id FROM clockgrove.events e JOIN clockgrove.command_receipts r USING(tenant_id,command_id) WHERE e.space_id='${owner.scope.spaceId}' AND e.privacy_class='public_scene' AND r.status='committed' ORDER BY e.partition_sequence LIMIT 1`,
      );
      expect(publicCommand).not.toBe("");
      for (const [capability, input] of [
        ["inspect", {}],
        ["why", { commandId: publicCommand }],
      ] as const) {
        const internal = await open();
        await talk(internal, 1, capability, input);
        const receipt = await wait(internal, capability, input);
        expect(receipt.reply.text).toContain("Fixture research succeeded:");
        expect(receipt.reply.text).toContain(
          capability === "inspect" ? "Scene revision" : publicCommand,
        );
        expect(
          await owner.sql(
            `SELECT i.disposition||'/'||i.reserved_microusd FROM clockgrove.effect_intents i JOIN clockgrove.agent_runs r USING(tenant_id,run_id) WHERE r.session_id='${internal}'`,
          ),
        ).toBe("succeeded/0");
      }
      const modelDown = await open();
      const unavailable = decodeTalkReceipt(
        (
          await post("/v1/runtime/talk", {
            sessionId: modelDown,
            messageId: "offline",
            text: "fixture:model-down",
          })
        ).body,
      );
      expect(unavailable.reply.text).toBe("Model unavailable. I could not finish this turn.");
      expect(
        await owner.sql(
          `SELECT status||'/'||outcome_code FROM clockgrove.agent_runs WHERE session_id='${modelDown}'`,
        ),
      ).toBe("failed/model_unavailable");
      expect((await post("/v1/runtime/world-status", {})).status).toBe(200);
      const toolDown = await open();
      await talk(toolDown, 1, CAPABILITY, { q: "down" });
      const failed = await wait(toolDown, CAPABILITY, { q: "down" });
      expect(failed.reply.text).toContain("Fixture research uncertain: tool_uncertain");
      expect(failed.reply.text).toContain("Research evidence: [tool:tool:");
      expect((await post("/v1/runtime/world-status", {})).status).toBe(200);
      // Lose the actual runtime while tools/call is in flight. Reconciliation may record an
      // uncertainty; it must never manufacture success or resend the started attempt.
      const inflight = await open();
      const beforeFlight = Number(
        await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((response) =>
          response.text(),
        ),
      );
      await talk(inflight, 1, CAPABILITY, { q: "hold" });
      await expect
        .poll(() =>
          owner.sql(
            `SELECT count(*) FROM clockgrove.effect_attempts a JOIN clockgrove.effect_intents i USING(tenant_id,world_id,timeline_id,effect_id) JOIN clockgrove.agent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.run_id WHERE r.session_id='${inflight}' AND a.disposition='started'`,
          ),
        )
        .toBe("1");
      // The durable claim precedes transport setup; kill only after the fixture received tools/call.
      await expect
        .poll(
          async () =>
            Number(
              await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((response) =>
                response.text(),
              ),
            ),
          { timeout: 60000 },
        )
        .toBe(beforeFlight + 1);
      await owner.replace(true);
      await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/release`);
      await expect
        .poll(
          async () => {
            await owner.request("/research/sweep", {});
            return owner.sql(
              `SELECT i.disposition FROM clockgrove.effect_intents i JOIN clockgrove.agent_runs r USING(tenant_id,run_id) WHERE r.session_id='${inflight}'`,
            );
          },
          { timeout: 90000, interval: 1000 },
        )
        .toBe("uncertain");
      const reconciled = await wait(inflight, CAPABILITY, { q: "hold" });
      expect(reconciled.reply.text).toContain("Fixture research uncertain: tool_uncertain");
      expect(
        Number(
          await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((response) =>
            response.text(),
          ),
        ),
      ).toBe(beforeFlight + 1);
      expect(
        await owner.sql(
          `SELECT (SELECT count(*) FROM clockgrove.conversation_messages WHERE session_id='${inflight}')||'/'||(SELECT count(*) FROM clockgrove.effect_attempts a JOIN clockgrove.effect_intents i USING(tenant_id,world_id,timeline_id,effect_id) JOIN clockgrove.agent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.run_id WHERE r.session_id='${inflight}')`,
        ),
      ).toBe("2/1");
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.effect_intents WHERE capability_id='forbidden.write'",
        ),
      ).toBe("0");
      expect(
        await owner.sql(
          "SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects' AND status='delivered'",
        ),
      ).toBe("12");
    });
  },
  240000,
);
