import { expect, it } from "vitest";
import { mcpCapabilityName } from "../../../packages/application/src/mcp-capability-registry.js";
import {
  approvedEffectHash,
  approvedEffectIdempotencyKey,
} from "../../../packages/persistence/src/postgres-approved-effects.js";
import { PostgreSqlEffectApprovals } from "../../../packages/persistence/src/postgres-effect-approvals.js";
import { PostgreSqlEffects } from "../../../packages/persistence/src/postgres-effects.js";
import {
  MCP_READ_TURN_DEFAULTS,
  PostgreSqlMcpReadAdmission,
} from "../../../packages/persistence/src/postgres-mcp-read-admission.js";
import {
  type McpWriteReservation,
  PostgreSqlMcpWriteAdmission,
} from "../../../packages/persistence/src/postgres-mcp-write-admission.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("admits exact approved writes once under current canonical authority and shared turn fences", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = (q: string) => psqlQuery(fixture.tools, fixture.environment, q);
    const capability = mcpCapabilityName("fixture", "lookup", "2025-11-25", "1".repeat(64));
    await sql(`UPDATE clockgrove.world_memberships SET grants=ARRAY['${capability}'],
      privacy_ceiling='{"version":1,"allowedCategories":["conversation","operator_evidence"]}' WHERE tenant_id='tenant-a';
      INSERT INTO clockgrove.artifact_data_keys(tenant_id,world_id,privacy_class,key_version,kek_id,wrapped_key)
        VALUES('tenant-a','world-a','conversation',1,'fixture',decode(repeat('01',61),'hex'));
      INSERT INTO clockgrove.artifact_references
        (tenant_id,world_id,timeline_id,partition_id,space_id,artifact_id,content_hash,media_type,inline_content,byte_length,privacy_class,retention_class,encryption,data_key_version)
        VALUES('tenant-a','world-a','timeline-a','partition-a','space-a','input','sha256:'||encode(sha256(decode(repeat('01',32),'hex')),'hex'),
          'application/json',decode(repeat('01',32),'hex'),32,'conversation','durable','aes-256-gcm-v1',1);
      BEGIN;
      INSERT INTO clockgrove.conversation_participants(tenant_id,session_id,principal_id,persona_id)
        VALUES('tenant-a','session','principal-a','persona-a');
      INSERT INTO clockgrove.conversation_sessions(tenant_id,session_id,world_id,timeline_id,partition_id,space_id,actor_id,voice_mode)
        VALUES('tenant-a','session','world-a','timeline-a','partition-a','space-a','actor','cognitive');
      INSERT INTO clockgrove.conversation_turn_fibers(tenant_id,session_id,message_id,world_id,timeline_id,actor_id,principal_id,persona_id,input_artifact_id)
        VALUES('tenant-a','session','message','world-a','timeline-a','actor','principal-a','persona-a','input');
      COMMIT;
      INSERT INTO clockgrove.mcp_installations
        (tenant_id,world_id,timeline_id,installation_id,space_id,owner_principal_id,url,status,snapshot,reviews)
        VALUES('tenant-a','world-a','timeline-a','fixture','space-a','principal-a','https://fixture.example/mcp','active',
        '{"protocolVersion":"2025-11-25","serverIdentity":{},"protocolMetadata":{},"candidates":[{"kind":"tool","id":"lookup","schemaHash":"${"1".repeat(64)}","schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false},"metadata":{},"enabled":false,"effectClass":"external-write"}]}',
        '{"lookup":{"schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","effectClass":"external-write","enabled":true}}');
      INSERT INTO clockgrove.mcp_bindings(tenant_id,world_id,timeline_id,installation_id,binding_id,space_id,binding)
        VALUES('tenant-a','world-a','timeline-a','fixture','binding','space-a',
        '{"bindingId":"binding","installationId":"fixture","candidateId":"lookup","schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","scopeType":"actor","scopeId":"actor","effect":"allow","enabled":true,"constraints":{"callsPerTurn":3,"effectClasses":["external-write"],"budgetMicrousd":250000}}');
      INSERT INTO clockgrove.events(event_id,tenant_id,world_id,timeline_id,partition_id,space_id,stream_id,stream_sequence,partition_sequence,event_type,schema_version,simulation_time,command_id,correlation_id,principal_id,privacy_class,payload_hash,attribution,policy_versions,payload,event_bytes)
        SELECT 'research-'||n,'tenant-a','world-a','timeline-a','partition-a','space-a','stream-a',n,n,'ResearchFixture',2,0,'command-a','correlation-a','principal-a','conversation','hash-'||n,'{}','{}','{}',convert_to('{"schemaVersion":2}','UTF8') FROM generate_series(3,25) n;`);
    const clients = [0, 1].map(() =>
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    );
    const ports = clients.map((client) => new PostgreSqlMcpWriteAdmission(client));
    const read = new PostgreSqlMcpReadAdmission(clients[0]!);
    const approvals = new PostgreSqlEffectApprovals(clients[0]!);
    const scope = { tenantId: "tenant-a", worldId: "world-a", timelineId: "timeline-a" };
    const create = async (
      n: number,
      approve = true,
      expirySeconds = 600,
    ): Promise<McpWriteReservation> => {
      const address = { ...scope, approvalId: `approval-${n}` };
      const intent = {
        ...scope,
        spaceId: "space-a",
        effectId: `write-${n}`,
        idempotencyKey: approvedEffectIdempotencyKey(address),
        actorId: "actor",
        principalId: "principal-a",
        runId: null,
        callId: `call-${n}`,
        capabilityId: capability,
        grantId: "binding",
        policyVersion: "research-v1",
        argumentsHash: "4305e395e2e4d5979593ebdb3dcb86542120dec6f976c58c09716eca218871f3",
        argumentsArtifactId: "input",
        reservedMicrousd: 80000,
      };
      const reservation = {
        ...intent,
        disposition: "pending" as const,
        dispatchId: `dispatch-${n}`,
        eventId: `research-${n + 2}`,
      };
      const approval = await approvals.request({
        ...address,
        spaceId: "space-a",
        effectId: intent.effectId,
        principalId: "principal-a",
        approverPrincipalId: "principal-a",
        argumentsHash: intent.argumentsHash,
        effectHash: approvedEffectHash(reservation),
        argumentsArtifactId: "input",
        expirySeconds,
      });
      if (approve) await approvals.decide(approval, "principal-a", "approved");
      return {
        intent,
        arguments: { q: "weather" },
        turnId: "message",
        sessionId: "session",
        installationId: "fixture",
        dispatchId: reservation.dispatchId,
        eventId: reservation.eventId,
        policy: { ...MCP_READ_TURN_DEFAULTS },
        approval,
      };
    };
    try {
      const pending = await create(1, false);
      expect((await ports[0]!.reserve(pending)).outcomeCode).toBe("approval_pending");
      expect((await approvals.read(pending.approval))?.state).toBe("pending");
      const exact = await create(2);
      const raced = await Promise.all(ports.map((port) => port.reserve(exact)));
      expect(raced[0]).toEqual(raced[1]);
      expect(raced[0]?.disposition).toBe("pending");
      expect((await approvals.read(exact.approval))?.state).toBe("consumed");
      expect(await ports[0]!.admit(exact.intent, exact.arguments)).toEqual({
        endpoint: "https://fixture.example/mcp",
        toolName: "lookup",
        arguments: { q: "weather" },
      });
      expect(await read.admit(exact.intent, exact.arguments)).toBeNull();
      await expect(read.reserve(exact)).rejects.toThrow("Invalid MCP admission kind");
      expect(await ports[0]!.admit(exact.intent, { q: "changed" })).toBeNull();
      await expect(ports[0]!.reserve({ ...exact, arguments: { q: "changed" } })).rejects.toThrow();
      expect(
        (
          await sql(
            `SELECT calls||','||reserved_microusd FROM clockgrove.mcp_read_turn_budgets WHERE timeline_id='timeline-a'`,
          )
        ).trim(),
      ).toBe("1,80000");
      expect(
        (
          await sql(
            `SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects'`,
          )
        ).trim(),
      ).toBe("1");
      await read.setSwitch({ scope: "global" }, true);
      expect(await ports[0]!.admit(exact.intent, exact.arguments)).toBeNull();
      const killed = await create(3);
      expect((await ports[0]!.reserve(killed)).outcomeCode).toBe("kill_switch");
      expect((await approvals.read(killed.approval))?.state).toBe("approved");
      await read.setSwitch({ scope: "global" }, false);
      await sql(
        `UPDATE clockgrove.world_memberships SET grants=ARRAY[]::text[] WHERE tenant_id='tenant-a'`,
      );
      expect(await ports[0]!.admit(exact.intent, exact.arguments)).toBeNull();
      const revoked = await create(4);
      expect((await ports[0]!.reserve(revoked)).outcomeCode).toBe("member_grant_required");
      await sql(
        `UPDATE clockgrove.world_memberships SET grants=ARRAY['${capability}'] WHERE tenant_id='tenant-a'`,
      );
      const changed = await create(5);
      expect(
        (await ports[0]!.reserve({ ...changed, arguments: { q: "changed" } })).outcomeCode,
      ).toBe("arguments_changed");
      expect((await approvals.read(changed.approval))?.state).toBe("approved");
      const denied = await create(9, false);
      await approvals.decide(denied.approval, "principal-a", "denied");
      expect((await ports[0]!.reserve(denied)).outcomeCode).toBe("approval_denied");
      const withdrawn = await create(10);
      await approvals.revoke(withdrawn.approval, "principal-a");
      expect((await ports[0]!.reserve(withdrawn)).outcomeCode).toBe("approval_revoked");
      const expired = await create(11, true, 1);
      await sql("SELECT pg_sleep(1.05)");
      expect((await ports[0]!.reserve(expired)).outcomeCode).toBe("approval_expired");
      await sql(`INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES('tenant-a','world-a','preview','branch');
        INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES('tenant-a','world-a','preview','preview','space-a');
        BEGIN;
        INSERT INTO clockgrove.conversation_participants(tenant_id,session_id,principal_id,persona_id) VALUES('tenant-a','preview','principal-a','persona-a');
        INSERT INTO clockgrove.conversation_sessions(tenant_id,session_id,world_id,timeline_id,partition_id,space_id,actor_id,voice_mode) VALUES('tenant-a','preview','world-a','preview','preview','space-a','actor','cognitive');
        INSERT INTO clockgrove.conversation_turn_fibers(tenant_id,session_id,message_id,world_id,timeline_id,actor_id,principal_id,persona_id,input_artifact_id) VALUES('tenant-a','preview','message','world-a','preview','actor','principal-a','persona-a','input'); COMMIT;`);
      const preview = await create(12);
      expect(
        await ports[0]!.reserve({
          ...preview,
          sessionId: "preview",
          intent: { ...preview.intent, timelineId: "preview", argumentsArtifactId: null },
        }),
      ).toMatchObject({ disposition: "blocked", outcomeCode: "preview_blocked" });
      expect((await approvals.read(preview.approval))?.state).toBe("approved");
      await sql(`INSERT INTO clockgrove.actor_activation_policies(tenant_id,world_id,timeline_id,space_id,actor_id,principal_id,allow_model,configurations)
        VALUES('tenant-a','world-a','timeline-a','space-a','actor','principal-a',true,'[{"id":"timer","enabled":true}]');
        INSERT INTO clockgrove.actor_activations(tenant_id,world_id,timeline_id,space_id,actor_id,causal_root,activation_id,principal_id,configuration_id,reason,evidence,session_id,message_id,input,has_reservation,status,outcome)
        VALUES('tenant-a','world-a','timeline-a','space-a','actor','timer','activation','principal-a','timer','{}','fixture','session','message','fixture',true,'pending','admitted');`);
      const proactive = await create(13);
      expect((await ports[0]!.reserve(proactive)).outcomeCode).toBe("write_activation_unavailable");
      await sql(
        "UPDATE clockgrove.actor_activations SET message_id='proactive' WHERE tenant_id='tenant-a'",
      );
      const second = await create(6);
      await sql(`UPDATE clockgrove.mcp_installations SET reviews=jsonb_set(reviews,'{lookup,effectClass}','"read"') WHERE tenant_id='tenant-a';
        UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,effectClasses}','["read"]') WHERE tenant_id='tenant-a';`);
      const { approval: _approval, ...readRequest } = second;
      expect((await read.reserve(readRequest)).disposition).toBe("pending");
      await sql(`UPDATE clockgrove.mcp_installations SET reviews=jsonb_set(reviews,'{lookup,effectClass}','"external-write"') WHERE tenant_id='tenant-a';
        UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{constraints,effectClasses}','["external-write"]') WHERE tenant_id='tenant-a';`);
      const exhausted = await create(7);
      expect((await ports[0]!.reserve(exhausted)).disposition).toBe("pending");
      const over = await create(8);
      expect((await ports[0]!.reserve(over)).outcomeCode).toBe("budget_exhausted");
      expect((await approvals.read(over.approval))?.state).toBe("approved");
      const effects = new PostgreSqlEffects(clients[0]!);
      await effects.claim(exact.intent, "attempt");
      const uncertain = await effects.complete(exact.intent, "attempt", {
        disposition: "uncertain",
        outcomeCode: "reply_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
      expect(await ports[1]!.reserve(exact)).toEqual(uncertain);
      expect(await ports[0]!.admit(exact.intent, exact.arguments)).toBeNull();
      const restarted = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        expect(await new PostgreSqlMcpWriteAdmission(restarted).reserve(exact)).toEqual(uncertain);
      } finally {
        await restarted.close();
      }
      expect(
        (
          await sql(
            `SELECT calls||','||reserved_microusd FROM clockgrove.mcp_read_turn_budgets WHERE timeline_id='timeline-a'`,
          )
        ).trim(),
      ).toBe("3,240000");
      expect(
        (
          await sql(
            `SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects'`,
          )
        ).trim(),
      ).toBe("3");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
