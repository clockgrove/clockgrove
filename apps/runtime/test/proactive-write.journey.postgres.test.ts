import { decodeConversationSession } from "@clockgrove/contracts";
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

const FILE = "apps/runtime/test/proactive-write.journey.postgres.test.ts";
it("keeps proactive activation pending through human approval and tool completion", async () => {
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
    await owner.sql(
      "UPDATE clockgrove.world_memberships SET grants=grants||ARRAY['runtime:mcp-install'] WHERE principal_id='principal-runtime'",
    );
    const post = (path: string, fields: object) =>
      owner.request(path, {
        version: 1,
        ...(path.startsWith("/v1/runtime/activations/")
          ? { scope: owner.scope, actorId: ACTOR }
          : owner.scope),
        ...(path.startsWith("/v1/runtime/effects/") ? { commandId: crypto.randomUUID() } : {}),
        ...fields,
      });
    const sessionId = decodeConversationSession(
      (await post("/v1/runtime/conversations/create", { actorId: ACTOR })).body,
    ).sessionId;
    expect(
      (
        await post("/v1/runtime/activations/configure", {
          configuration: {
            id: "write",
            sessionId,
            kind: "heartbeat",
            nextWakeAt: null,
            intervalMs: null,
            input: `fixture:research 1 ${CAPABILITY} ${JSON.stringify({ q: "archive" })}`,
            priority: 1,
            enabled: true,
            compiledRoutine: "escalate",
          },
          policy: { allowModel: true, modelBudget: 10 },
        })
      ).status,
    ).toBe(200);
    const wake = () =>
      post("/v1/runtime/activations/wake", {
        wake: {
          configurationId: "write",
          causalRoot: "write-root",
          reason: { kind: "heartbeat", heartbeatId: "write" },
          evidence: "fixture",
        },
      });
    const activation = await wake();
    expect(activation.status).toBe(200);
    expect(activation.body).toMatchObject({ status: "pending" });
    expect(
      await owner.sql(
        "SELECT status FROM clockgrove.actor_activations WHERE causal_root='write-root'",
      ),
    ).toBe("pending");
    expect(await owner.sql("SELECT phase FROM clockgrove.conversation_turn_fibers")).toBe(
      "approval_waiting",
    );
    const found = await post("/v1/runtime/effects/approvals", {});
    expect(found.status).toBe(200);
    const approvalId = (found.body as { approvals: { approval: { approvalId: string } }[] })
      .approvals[0]!.approval.approvalId;
    await owner.replace(true);
    expect(
      await owner.sql(
        "SELECT status FROM clockgrove.actor_activations WHERE causal_root='write-root'",
      ),
    ).toBe("pending");
    expect(
      (await post("/v1/runtime/effects/decide", { approvalId, decision: "approved" })).status,
    ).toBe(200);
    await expect
      .poll(async () => (await wake()).body, { timeout: 90000 })
      .toMatchObject({ status: "completed", outcome: "completed" });
    expect(await fetch(`${process.env.NATIVE_RESEARCH_ORIGIN}/count`).then((r) => r.text())).toBe(
      "1",
    );
    expect(await owner.sql("SELECT state FROM clockgrove.effect_approvals")).toBe("consumed");
    expect(await owner.sql("SELECT count(*) FROM clockgrove.effect_attempts")).toBe("1");
  });
}, 300000);
