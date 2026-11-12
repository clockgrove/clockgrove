import type { ConversationParticipant, TurnFiber } from "@clockgrove/application";
import { decodeBrowserScope, decodeOpaqueId } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlConversationStore,
  WebCryptoKeyring,
  withClientTransaction,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line.
// @ts-expect-error -- repository-local JavaScript helpers have no declaration file.
import { applyMigrations, applySqlFile, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
import { type TurnFiberHost, TurnFibers, type TurnResearchHost } from "../src/actor-agent.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("recovers a durable approval wait without cognition or dispatch and refuses terminal human decisions", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const client = connect(fixture.environment);
    const keyring = await WebCryptoKeyring.fromJson(
      JSON.stringify({
        version: 1,
        current: "fixture",
        keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
      }),
    );
    const store = new PostgreSqlConversationStore(
      client,
      new PostgreSqlArtifactStore(client, { keyring }),
      () => "approval-session",
    );
    const scope = decodeBrowserScope({
      tenantId: "tenant-a",
      worldId: "world-a",
      timelineId: "timeline-a",
      spaceId: "space-a",
    });
    const participant: ConversationParticipant = {
      tenantId: scope.tenantId,
      principalId: decodeOpaqueId("principal-a", "PrincipalId"),
      personaId: decodeOpaqueId("persona-a", "WorldPersonaId"),
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
    let modelCalls = 0;
    let dispatches = 0;
    let approval: "waiting" | "approved" | "denied" | "expired" | "revoked" = "waiting";
    // Scripted approval/dispatch ports prove the real actor checkpoint, not human auth or transport.
    const research: TurnResearchHost = {
      policy: {
        maxCalls: 3,
        maxModelSteps: 4,
        maxCostMicrousd: 250000,
        modelStepReserveMicrousd: 50000,
      },
      approvalState: async () => approval,
      executeTool: async (_participant, _fiber, _proposal, call) => {
        dispatches++;
        return {
          ...call,
          status: "succeeded",
          code: "ok",
          text: "Fixture accepted",
          costMicrousd: 0,
        };
      },
    };
    const host = (holder: string, withApproval = true): TurnFiberHost => ({
      holder,
      actorId: "actor",
      stores: async (operation) => operation(store),
      respond: async () => {
        modelCalls++;
        return { text: "Recorded result" };
      },
      research: withApproval
        ? research
        : { policy: research.policy, executeTool: research.executeTool },
      capabilityRevision: () => 1,
      checkpointed: async () => {},
      durable: async (_fiber, _participant, run) => run(),
    });
    const request = { scope, sessionId: "approval-session", messageId: "approved" };
    const current = async (messageId: string) =>
      (await store.openTurns(participant, scope, "actor")).find((f) => f.messageId === messageId)!;
    async function prepare(messageId: string): Promise<TurnFiber> {
      const accepted = await store.acceptTurn(participant, {
        ...request,
        messageId,
        text: "Propose fixture write",
      });
      let f = (await store.claimTurn(participant, accepted.fiber!, "prepare", 1))!;
      f = (await store.assembleTurn(participant, f))!;
      f = (await store.advanceTurn(participant, f, "model_running"))!;
      f = (await store.answerTurn(participant, f, {
        text: "Requesting approval",
        command: { capability: "fixture.write", input: { value: 23 } },
      }))!;
      return (await store.waitForTool(participant, f, {
        callId: `${messageId}:call`,
        effectId: `${messageId}:effect`,
        capability: "fixture.write",
      }))!;
    }
    try {
      await store.open(participant, {
        scope,
        actorId: decodeOpaqueId("actor", "ObjectId"),
        voiceMode: "cognitive",
      });
      const original = await prepare("approved");
      await new TurnFibers(host("owner-a")).activate(participant, original);
      let waiting = await current("approved");
      expect((await store.turnStatus(participant, request)).phase).toBe("approval_waiting");
      expect((await store.turnStatus(participant, request)).toolCallId).toBe("approved:call");
      const staleWaiting = waiting;
      const proposal = waiting.proposalArtifactId;
      for (const change of [
        "phase='model_running'",
        "phase='committing'",
        "proposal_artifact_id=NULL",
      ]) {
        await expect(
          withClientTransaction(client, { authorization: participant }, () =>
            client.query(
              `UPDATE clockgrove.conversation_turn_fibers SET ${change} WHERE tenant_id='tenant-a' AND session_id='approval-session' AND message_id='approved'`,
            ),
          ),
        ).rejects.toThrow();
      }
      const outsider = {
        ...participant,
        tenantId: decodeOpaqueId("tenant-b", "TenantId"),
        principalId: decodeOpaqueId("principal-b", "PrincipalId"),
      };
      await expect(store.turnStatus(outsider, request)).rejects.toThrow("conversation_not_found");
      await new TurnFibers(host("owner-b")).activate(participant, waiting);
      waiting = await current("approved");
      expect([waiting.phase, waiting.proposalArtifactId, modelCalls, dispatches]).toEqual([
        "approval_waiting",
        proposal,
        0,
        0,
      ]);
      await new TurnFibers(host("missing-hook", false)).activate(participant, waiting);
      waiting = await current("approved");
      expect([waiting.phase, modelCalls, dispatches]).toEqual(["approval_waiting", 0, 0]);
      expect(await store.resumeAfterApproval(participant, staleWaiting)).toBeUndefined();
      const call = (await store.researchState(participant, waiting)).calls[0]!;
      await expect(
        store.completeTool(participant, waiting, { ...call, status: "succeeded" }),
      ).rejects.toThrow("Approval required");
      approval = "approved";
      // Eviction after the approved resume checkpoint must retain the protected-call fence.
      waiting = (await store.resumeAfterApproval(participant, waiting))!;
      expect((await store.researchState(participant, waiting)).calls[0]?.approvalRequired).toBe(
        true,
      );
      await new TurnFibers(host("missing-hook-after-resume", false)).activate(participant, waiting);
      waiting = await current("approved");
      expect([waiting.phase, modelCalls, dispatches]).toEqual(["tool_waiting", 0, 0]);
      const owner = new TurnFibers(host("owner-c"));
      const results = await Promise.all([
        owner.activate(participant, waiting),
        owner.activate(participant, waiting),
      ]);
      expect(results.map((r) => r.receipt?.reply.text)).toEqual([
        "Recorded result\n\nResearch evidence: [tool:approved:call]",
        "Recorded result\n\nResearch evidence: [tool:approved:call]",
      ]);
      expect([modelCalls, dispatches]).toEqual([1, 1]);
      expect((await store.turnStatus(participant, request)).phase).toBe("completed");
      await new TurnFibers(host("owner-d")).activate(participant, original);
      expect([modelCalls, dispatches]).toEqual([1, 1]);
      for (const decision of ["denied", "expired", "revoked"] as const) {
        approval = "waiting";
        await new TurnFibers(host(`waiting-${decision}`)).activate(
          participant,
          await prepare(decision),
        );
        approval = decision;
        const f = await current(decision);
        await new TurnFibers(host(`decision-${decision}`)).activate(participant, f);
        const recorded = await store.researchState(participant, f);
        expect([
          recorded.calls[0]?.status,
          recorded.calls[0]?.code,
          recorded.calls[0]?.text,
        ]).toEqual(["refused", `approval_${decision}`, `Tool refused: approval_${decision}`]);
      }
      approval = "waiting";
      await new TurnFibers(host("cancel-owner")).activate(participant, await prepare("cancelled"));
      expect(
        (await store.cancelTurn(participant, { ...request, messageId: "cancelled" })).phase,
      ).toBe("cancelled");
      expect(dispatches).toBe(1);
      expect(
        (
          await psqlQuery(
            fixture.tools,
            fixture.environment,
            "SELECT count(*) FROM clockgrove.run_steps WHERE kind='approval' AND summary='Awaiting human approval'",
          )
        ).trim(),
      ).toBe("5");
    } finally {
      await client.close();
    }
  });
});
