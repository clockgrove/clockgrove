import {
  type AdmittedMcpExecution,
  type ConversationParticipant,
  type McpReadEvidence,
  McpReadFailure,
} from "@clockgrove/application";
import { decodeBrowserScope, decodeOpaqueId, type QueueEnvelope } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlConversationStore,
  PostgreSqlEffectApprovals,
  WebCryptoKeyring,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line.
// @ts-expect-error -- repository-local JavaScript helpers have no declaration file.
import { applyMigrations, applySqlFile, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
import { TurnFibers } from "../src/actor-agent.js";
import { composeResearch, type ResearchConfiguration } from "../src/research.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("composes exact human approvals with real actor waits, single dispatch, revocation and operator safe retries", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const capability = `mcp:fixture:lookup:2025-11-25:${"1".repeat(64)}`;
    const sql = (q: string) => psqlQuery(fixture.tools, fixture.environment, q);
    await sql(`UPDATE clockgrove.world_memberships SET grants=ARRAY['${capability}','runtime:world-operate','runtime:world-observe'],privacy_ceiling='{"version":1,"allowedCategories":["conversation","private_cognition","operator_evidence"]}' WHERE tenant_id='tenant-a';
      INSERT INTO clockgrove.mcp_installations(tenant_id,world_id,timeline_id,installation_id,space_id,owner_principal_id,url,status,snapshot,reviews)
      VALUES('tenant-a','world-a','timeline-a','fixture','space-a','principal-a','https://fixture.example/mcp','active',
      '{"protocolVersion":"2025-11-25","serverIdentity":{},"protocolMetadata":{},"candidates":[{"kind":"tool","id":"lookup","schemaHash":"${"1".repeat(64)}","schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false},"metadata":{},"enabled":false,"effectClass":"external-write"}]}',
      '{"lookup":{"schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","effectClass":"external-write","enabled":true}}');
      INSERT INTO clockgrove.mcp_bindings(tenant_id,world_id,timeline_id,installation_id,binding_id,space_id,binding)
      VALUES('tenant-a','world-a','timeline-a','fixture','binding','space-a',
      '{"bindingId":"binding","installationId":"fixture","candidateId":"lookup","schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","scopeType":"actor","scopeId":"actor","effect":"allow","enabled":true,"constraints":{"callsPerTurn":3,"effectClasses":["external-write"],"budgetMicrousd":250000,"idempotency":"provider"}}');`);
    const keyring = await WebCryptoKeyring.fromJson(
      JSON.stringify({
        version: 1,
        current: "fixture",
        keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
      }),
    );
    const withClient = async <T>(operation: (client: ReturnType<typeof connect>) => Promise<T>) => {
      const client = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        return await operation(client);
      } finally {
        await client.close();
      }
    };
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
      privacyCeiling: {
        version: 1,
        allowedCategories: ["conversation", "private_cognition", "operator_evidence"],
      },
    };
    const artifacts = (client: import("@clockgrove/persistence").PostgreSqlClient) =>
      new PostgreSqlArtifactStore(client, { keyring });
    const queued: QueueEnvelope<unknown>[] = [];
    let sends = 0;
    let fail = false;
    const providerKeys: (string | undefined)[] = [];
    const execute = async (request: AdmittedMcpExecution): Promise<McpReadEvidence> => {
      sends++;
      providerKeys.push((request as { idempotencyKey?: string }).idempotencyKey);
      if (fail) throw new McpReadFailure("execution_failed", "uncertain");
      return {
        trust: "untrusted_evidence",
        status: "ok",
        content: [{ type: "text", text: "written" }],
        sanitized: false,
        costMicrousd: null,
      };
    };
    const configuration: ResearchConfiguration = {
      environment: "local",
      withClient,
      artifacts,
      network: {
        resolve: async () => ["93.184.216.34"],
        request: async () => {
          throw new Error("not used");
        },
      },
      publish: async (message) => {
        queued.push(message);
      },
      wake: async () => {},
      adapter: { execute, executeWrite: execute },
    };
    let research = composeResearch(configuration);
    const stores = async <T>(operation: (store: PostgreSqlConversationStore) => Promise<T>) =>
      withClient((client) =>
        operation(new PostgreSqlConversationStore(client, artifacts(client), () => "session")),
      );
    await stores((store) =>
      store.open(participant, {
        scope,
        actorId: decodeOpaqueId("actor", "ObjectId"),
        voiceMode: "cognitive",
      }),
    );
    async function prepare(messageId: string) {
      return stores(async (store) => {
        const accepted = await store.acceptTurn(participant, {
          scope,
          sessionId: "session",
          messageId,
          text: "write fixture",
        });
        let f = (await store.claimTurn(participant, accepted.fiber!, "fixture", 1))!;
        f = (await store.assembleTurn(participant, f))!;
        f = (await store.advanceTurn(participant, f, "model_running"))!;
        f = (await store.answerTurn(participant, f, {
          text: "Proposed",
          command: { capability, input: { q: messageId } },
        }))!;
        return (await store.waitForTool(participant, f, {
          callId: messageId,
          effectId: messageId,
          capability,
        }))!;
      });
    }
    const owner = () =>
      new TurnFibers({
        holder: crypto.randomUUID(),
        actorId: "actor",
        stores,
        respond: async () => ({ text: "Recorded" }),
        research: { ...research, waitForToolStart: async () => false },
        capabilityRevision: () => 1,
        checkpointed: async () => {},
        durable: async (_f, _p, run) => run(),
      });
    const current = async (messageId: string) =>
      (await stores((store) => store.openTurns(participant, scope, "actor"))).find(
        (f) => f.messageId === messageId,
      )!;
    const first = await prepare("first");
    await owner().activate(participant, first);
    expect((await current("first")).phase).toBe("approval_waiting");
    expect([sends, queued.length]).toEqual([0, 0]);
    await owner().activate(participant, await current("first"));
    const address = { ...scope, approvalId: "first:approval" };
    await withClient(async (client) => {
      const approvals = new PostgreSqlEffectApprovals(client);
      const proposal = (await approvals.read(address))!;
      expect(proposal.state).toBe("pending");
      await approvals.decide(proposal, participant.principalId, "approved");
      await approvals.decide(proposal, participant.principalId, "approved");
    });
    await owner().activate(participant, await current("first"));
    expect(queued.length).toBe(1);
    await research.consumer.consume(queued[0]!, (v) => v);
    await research.consumer.consume(queued[0]!, (v) => v);
    const completed = await owner().activate(participant, await current("first"));
    expect(completed.receipt?.reply.text).toBe("Recorded\n\nResearch evidence: [tool:first]");
    expect(sends).toBe(1);
    fail = true;
    await owner().activate(participant, await prepare("uncertain"));
    const decide = async (approvalId: string) =>
      withClient(async (client) => {
        const approvals = new PostgreSqlEffectApprovals(client);
        await approvals.decide(
          (await approvals.read({ ...scope, approvalId }))!,
          participant.principalId,
          "approved",
        );
      });
    await decide("uncertain:approval");
    await owner().activate(participant, await current("uncertain"));
    await research.consumer.consume(queued[1]!, (v) => v);
    await owner().activate(participant, await current("uncertain"));
    expect(
      (
        await sql("SELECT disposition FROM clockgrove.effect_intents WHERE effect_id='uncertain'")
      ).trim(),
    ).toBe("uncertain");
    const retry = await research.retry(scope, "uncertain", participant);
    const retried = await current(retry.messageId);
    expect(retried.phase).toBe("approval_waiting");
    expect([sends, queued.length]).toEqual([2, 2]);
    fail = false;
    await decide(retry.approvalId);
    await owner().activate(participant, retried);
    await research.consumer.consume(queued[2]!, (v) => v);
    await owner().activate(participant, await current(retry.messageId));
    expect([sends, providerKeys[1], providerKeys[2]]).toEqual([
      3,
      providerKeys[1],
      providerKeys[1],
    ]);
    expect(providerKeys[1]).toMatch(/^[a-f0-9]{64}$/);
    const sessionsBefore = await sql("SELECT count(*) FROM clockgrove.conversation_sessions");
    await sql(
      `UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,idempotency}','"application"') WHERE binding_id='binding'`,
    );
    await expect(research.retry(scope, "uncertain", participant)).rejects.toThrow(
      "Effect retry unavailable",
    );
    expect(await sql("SELECT count(*) FROM clockgrove.conversation_sessions")).toBe(sessionsBefore);
    await sql(
      `UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,idempotency}','"provider"') WHERE binding_id='binding'`,
    );
    await sql(`UPDATE clockgrove.mcp_installations SET reviews=jsonb_set(reviews,'{lookup,effectClass}','"network"') WHERE installation_id='fixture';
      UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(jsonb_set(binding,'{constraints,effectClasses}','["network"]'),'{constraints,approvalRequired}','false') WHERE binding_id='binding';`);
    await owner().activate(participant, await prepare("network"));
    expect((await current("network")).phase).toBe("tool_waiting");
    expect(
      (
        await sql("SELECT count(*) FROM clockgrove.effect_approvals WHERE effect_id='network'")
      ).trim(),
    ).toBe("0");
    await research.consumer.consume(queued[3]!, (v) => v);
    await owner().activate(participant, await current("network"));
    expect(sends).toBe(4);
    await sql(`UPDATE clockgrove.mcp_installations SET reviews=jsonb_set(reviews,'{lookup,effectClass}','"external-write"') WHERE installation_id='fixture';
      UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,effectClasses}','["external-write"]') WHERE binding_id='binding';`);
    const proactive = await prepare("proactive");
    await sql(`UPDATE clockgrove.world_memberships SET roles=ARRAY['owner'],grants=grants||ARRAY['runtime:world-command','runtime:mcp-install'] WHERE tenant_id='tenant-a';
      INSERT INTO clockgrove.actor_activation_policies(tenant_id,world_id,timeline_id,space_id,actor_id,principal_id,allow_model,configurations)
      VALUES('tenant-a','world-a','timeline-a','space-a','actor','principal-a',true,'[{"id":"timer","enabled":true}]');
      INSERT INTO clockgrove.actor_activations(tenant_id,world_id,timeline_id,space_id,actor_id,causal_root,activation_id,principal_id,configuration_id,reason,evidence,session_id,message_id,input,has_reservation,status,outcome)
      VALUES('tenant-a','world-a','timeline-a','space-a','actor','timer','activation','principal-a','timer','{}','fixture','session','proactive','fixture',true,'pending','admitted');`);
    await owner().activate(participant, proactive);
    await withClient(async (client) => {
      const approval = (await new PostgreSqlEffectApprovals(client).read({
        ...scope,
        approvalId: "proactive:approval",
      }))!;
      expect(await research.admitApproval(client, participant, approval)).toEqual({
        operator: true,
      });
    });
    await decide("proactive:approval");
    await owner().activate(participant, await current("proactive"));
    await research.consumer.consume(queued[4]!, (value) => value);
    await owner().activate(participant, await current("proactive"));
    expect(sends).toBe(5);
    await owner().activate(participant, await prepare("revoked"));
    await sql(
      `UPDATE clockgrove.world_memberships SET grants=array_remove(grants,'${capability}') WHERE tenant_id='tenant-a'`,
    );
    await owner().activate(participant, await current("revoked"));
    const ended = await stores((store) =>
      store.turnStatus(participant, { scope, sessionId: "session", messageId: "revoked" }),
    );
    expect(ended.phase).toBe("completed");
    await sql(
      `UPDATE clockgrove.world_memberships SET grants=array_append(grants,'${capability}') WHERE tenant_id='tenant-a'`,
    );
    research = composeResearch({ ...configuration, approvalExpirySeconds: 1 });
    await owner().activate(participant, await prepare("expired"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await owner().activate(participant, await current("expired"));
    expect(
      (
        await withClient((client) =>
          new PostgreSqlEffectApprovals(client).read({ ...scope, approvalId: "expired:approval" }),
        )
      )?.state,
    ).toBe("expired");
    const expired = await stores((store) =>
      store.turnStatus(participant, { scope, sessionId: "session", messageId: "expired" }),
    );
    expect([expired.phase, sends]).toEqual(["completed", 5]);

    expect(
      await sql(
        "SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects'",
      ),
    ).toBe("5\n");
  });
});
