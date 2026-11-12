import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  ACTOR,
  CAPABILITY,
  seedWriteResearch,
  withResearchFixture,
} from "./research-node-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/approved-write.journey.postgres.test.ts";
it("recovers approved writes at the wait, interrupted transport and reply boundaries without resending", async () => {
  if (!isNativeWorldOwnerChild()) {
    await withResearchFixture(() =>
      runNativeWorldOwnerProcess(FILE, "fixture/reference", {
        queues: true,
        timeoutMs: 240000,
        inheritOutput: true,
      }),
    );
    return;
  }
  await withNativeWorldOwner(async (owner) => {
    await seedWriteResearch(owner);
    const post = (path: string, fields: object) =>
      owner.request(path, {
        version: 1,
        ...owner.scope,
        ...(path.startsWith("/v1/runtime/effects/") ? { commandId: crypto.randomUUID() } : {}),
        ...fields,
      });
    const count = async () =>
      Number(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text()));
    const fault = async (phase: string | null) => {
      const result = await post("/actor-agent", {
        scope: owner.scope,
        actorId: ACTOR,
        op: "fault",
        phase,
      });
      expect(result.status).toBe(200);
    };
    const open = async () =>
      decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
      ).sessionId;
    const talk = (sessionId: string, q: string) =>
      post("/v1/runtime/talk", {
        sessionId,
        messageId: "write",
        text: `fixture:research 1 ${CAPABILITY} ${JSON.stringify({ q })}`,
      });
    const status = async (sessionId: string) =>
      (await post("/v1/runtime/turns/status", { sessionId, messageId: "write" })).body;
    const approval = async (sessionId: string) => {
      await expect.poll(() => status(sessionId)).toMatchObject({ phase: "approval_waiting" });
      const found = await post("/v1/runtime/effects/approvals", { sessionId });
      expect(found.status).toBe(200);
      const entries = (found.body as { approvals: { approval: { approvalId: string } }[] })
        .approvals;
      expect(entries.length).toBe(1);
      return entries[0]!.approval.approvalId;
    };
    const decide = (approvalId: string) =>
      post("/v1/runtime/effects/decide", { approvalId, decision: "approved" });
    const finish = async (sessionId: string, q: string) => {
      await expect
        .poll(() => status(sessionId), { timeout: 90000 })
        .toMatchObject({ phase: "completed" });
      return decodeTalkReceipt((await talk(sessionId, q)).body);
    };
    const waiting = await open();
    await talk(waiting, "archive");
    const id = await approval(waiting);
    expect(await count()).toBe(0);
    const preview = await post("/v1/runtime/effects/approval", { approvalId: id });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ arguments: { q: "archive" } });
    await owner.replace(true);
    const clicks = await Promise.all([decide(id), decide(id)]);
    expect(clicks.map((r) => r.status)).toEqual([200, 200]);
    const receipt = await finish(waiting, "archive");
    expect(receipt.reply.text).toContain("Fixture research succeeded:");
    expect(receipt.reply.text).toContain("[tool:tool:");
    expect(await count()).toBe(1);
    expect((await talk(waiting, "archive")).body).toEqual(receipt);
    expect(await count()).toBe(1);

    await owner.sql(
      `UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,idempotency}','"provider"') WHERE binding_id='binding'`,
    );
    const down = await open();
    await talk(down, "down");
    const downApproval = await approval(down);
    expect((await decide(downApproval)).status).toBe(200);
    expect((await finish(down, "down")).reply.text).toContain(
      "Fixture research uncertain: tool_uncertain",
    );
    expect(await count()).toBe(2);
    const retried = await post("/v1/runtime/effects/retry", {
      effectId: downApproval.slice(0, -":approval".length),
    });
    expect(retried.status).toBe(200);
    const retry = retried.body as { approvalId: string; sessionId: string; messageId: string };
    expect(await count()).toBe(2);
    expect((await decide(retry.approvalId)).status).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await post("/v1/runtime/turns/status", {
              sessionId: retry.sessionId,
              messageId: retry.messageId,
            })
          ).body,
        { timeout: 60000 },
      )
      .toMatchObject({ phase: "completed" });
    expect(await count()).toBe(2);

    const reply = await open();
    await talk(reply, "archive");
    const replyApproval = await approval(reply);
    await fault("tool_completed");
    expect((await decide(replyApproval)).status).toBe(200);
    await expect
      .poll(
        () =>
          owner.sql(
            `SELECT phase FROM clockgrove.conversation_turn_fibers WHERE session_id='${reply}'`,
          ),
        { timeout: 60000 },
      )
      .toBe("tool_completed");
    await owner.replace(true);
    await fault(null);
    expect((await finish(reply, "archive")).reply.text).toContain("Fixture research succeeded:");
    expect(await count()).toBe(3);
    expect(await owner.sql("SELECT count(*) FROM clockgrove.effect_attempts")).toBe("4");
    expect(
      await owner.sql("SELECT count(*) FROM clockgrove.effect_approvals WHERE state='consumed'"),
    ).toBe("4");
    expect(
      await owner.sql(
        "SELECT count(*) FROM clockgrove.effect_intents WHERE capability_id='forbidden.write'",
      ),
    ).toBe("0");
  });
}, 300000);
