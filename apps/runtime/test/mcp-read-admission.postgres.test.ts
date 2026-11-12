import { expect, it } from "vitest";
import { mcpCapabilityName } from "../../../packages/application/src/mcp-capability-registry.js";
import { PostgreSqlEffects } from "../../../packages/persistence/src/postgres-effects.js";
import {
  MCP_READ_TURN_DEFAULTS,
  type McpReadReservation,
  PostgreSqlMcpReadAdmission,
} from "../../../packages/persistence/src/postgres-mcp-read-admission.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("reserves canonical read admission once, bounds concurrent turns and rechecks grants and emergency fences", async () => {
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
        '{"lookup":{"schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","effectClass":"read","enabled":true}}');
      INSERT INTO clockgrove.mcp_bindings(tenant_id,world_id,timeline_id,installation_id,binding_id,space_id,binding)
        VALUES('tenant-a','world-a','timeline-a','fixture','binding','space-a',
        '{"bindingId":"binding","installationId":"fixture","candidateId":"lookup","schemaHash":"${"1".repeat(64)}","protocolVersion":"2025-11-25","scopeType":"actor","scopeId":"actor","effect":"allow","enabled":true,"constraints":{"callsPerTurn":3,"effectClasses":["read"],"budgetMicrousd":250000}}');
      INSERT INTO clockgrove.events(event_id,tenant_id,world_id,timeline_id,partition_id,space_id,stream_id,stream_sequence,partition_sequence,event_type,schema_version,simulation_time,command_id,correlation_id,principal_id,privacy_class,payload_hash,attribution,policy_versions,payload,event_bytes)
        SELECT 'research-'||n,'tenant-a','world-a','timeline-a','partition-a','space-a','stream-a',n,n,'ResearchFixture',2,0,'command-a','correlation-a','principal-a','conversation','hash-'||n,'{}','{}','{}',convert_to('{"schemaVersion":2}','UTF8') FROM generate_series(3,25) n;`);
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const ports = clients.map((c) => new PostgreSqlMcpReadAdmission(c));
    const port = ports[0]!;
    const request = (n: number): McpReadReservation => ({
      intent: {
        tenantId: "tenant-a",
        worldId: "world-a",
        timelineId: "timeline-a",
        spaceId: "space-a",
        effectId: `read-${n}`,
        idempotencyKey: `read-${n}`,
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
      },
      turnId: "message",
      sessionId: "session",
      installationId: "fixture",
      arguments: { q: "weather" },
      dispatchId: `dispatch-${n}`,
      eventId: `research-${n + 2}`,
      policy: { ...MCP_READ_TURN_DEFAULTS },
    });
    try {
      // Expected digest computed independently with PostgreSQL, not the hashing helper under test.
      expect(
        (await sql(`SELECT encode(sha256(convert_to('{"q":"weather"}','UTF8')),'hex')`)).trim(),
      ).toBe(request(1).intent.argumentsHash);
      const same = await Promise.all(ports.map((p) => p.reserve(request(1))));
      expect(same[0]).toEqual(same[1]);
      expect(same[0]?.disposition).toBe("pending");
      expect(await port.admit(request(1).intent, { q: "weather" })).toEqual({
        admittedReadOnly: true,
        endpoint: "https://fixture.example/mcp",
        toolName: "lookup",
        arguments: { q: "weather" },
      });
      expect(
        await port.admit({ ...request(1).intent, principalId: "principal-b" }, { q: "weather" }),
      ).toBeNull();
      expect(await port.admit(request(1).intent, { q: "changed" })).toBeNull();
      const original =
        await sql(`SELECT row_to_json(a)::text FROM clockgrove.mcp_read_admissions a WHERE effect_id='read-1';
        SELECT row_to_json(i)::text FROM clockgrove.effect_intents i WHERE effect_id='read-1';
        SELECT row_to_json(b)::text FROM clockgrove.mcp_read_turn_budgets b;
        SELECT count(*) FROM clockgrove.event_dispatches`);
      for (let retry = 0; retry < 2; retry++) {
        await expect(port.reserve({ ...request(1), arguments: { q: "changed" } })).rejects.toThrow(
          "MCP read admission unavailable",
        );
      }
      expect(
        await sql(`SELECT row_to_json(a)::text FROM clockgrove.mcp_read_admissions a WHERE effect_id='read-1';
        SELECT row_to_json(i)::text FROM clockgrove.effect_intents i WHERE effect_id='read-1';
        SELECT row_to_json(b)::text FROM clockgrove.mcp_read_turn_budgets b;
        SELECT count(*) FROM clockgrove.event_dispatches`),
      ).toBe(original);
      expect(
        (
          await sql(`SELECT count(*)||','||min(outcome_code)||','||bool_and(presented_arguments_hash=encode(sha256(convert_to('{"q":"changed"}','UTF8')),'hex'))
        FROM clockgrove.mcp_read_retry_refusals WHERE effect_id='read-1'`)
        ).trim(),
      ).toBe("1,arguments_changed,true");
      await expect(port.reserve({ ...request(1), eventId: "different" })).rejects.toThrow(
        "MCP read admission unavailable",
      );
      expect(
        (
          await sql(
            `SELECT count(*) FROM clockgrove.mcp_read_retry_refusals WHERE effect_id='read-1' AND outcome_code='retry_conflict'`,
          )
        ).trim(),
      ).toBe("1");
      expect(
        (
          await sql(`SELECT string_agg(column_name,',' ORDER BY ordinal_position) FROM information_schema.columns
        WHERE table_schema='clockgrove' AND table_name='mcp_read_retry_refusals'`)
        ).trim(),
      ).toBe(
        "tenant_id,world_id,timeline_id,effect_id,retry_hash,presented_arguments_hash,outcome_code",
      );
      await expect(
        port.reserve({
          ...request(2),
          policy: { ...MCP_READ_TURN_DEFAULTS, maxCostMicrousd: 1000000 },
        }),
      ).rejects.toThrow("MCP read admission unavailable");
      await expect(port.reserve({ ...request(2), turnId: "fabricated" })).rejects.toThrow(
        "MCP read admission unavailable",
      );
      const race = await Promise.all(ports.map((p, index) => p.reserve(request(index + 2))));
      expect(race.map((r) => r.disposition)).toEqual(["pending", "pending"]);
      expect(await port.reserve(request(4))).toMatchObject({
        disposition: "refused",
        outcomeCode: "budget_exhausted",
      });
      expect(
        (
          await sql(
            "SELECT calls||','||reserved_microusd||','||reserved_time_ms||','||reserved_output_bytes FROM clockgrove.mcp_read_turn_budgets",
          )
        ).trim(),
      ).toBe("3,240000,135000,196608");
      expect((await sql("SELECT count(*) FROM clockgrove.event_dispatches")).trim()).toBe("3");
      expect(await port.reserve(request(1))).toEqual(same[0]);
      let switchCall = 13;
      for (const target of [
        { scope: "global" } as const,
        { scope: "world", tenantId: "tenant-a", worldId: "world-a" } as const,
        {
          scope: "installation",
          tenantId: "tenant-a",
          worldId: "world-a",
          timelineId: "timeline-a",
          installationId: "fixture",
        } as const,
      ]) {
        await port.setSwitch(target, true);
        expect(await port.admit(request(1).intent, { q: "weather" })).toBeNull();
        expect(await port.reserve(request(switchCall++))).toMatchObject({
          disposition: "refused",
          outcomeCode: "kill_switch",
        });
        await port.setSwitch(target, false);
      }
      await sql(
        "UPDATE clockgrove.world_memberships SET grants=ARRAY[]::text[] WHERE tenant_id='tenant-a'",
      );
      expect(await port.admit(request(1).intent, { q: "weather" })).toBeNull();
      expect(await port.reserve(request(6))).toMatchObject({
        disposition: "refused",
        outcomeCode: "member_grant_required",
      });
      await sql(`UPDATE clockgrove.world_memberships SET grants=ARRAY['${capability}'] WHERE tenant_id='tenant-a';
        UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{enabled}','false') WHERE tenant_id='tenant-a'`);
      expect(await port.admit(request(1).intent, { q: "weather" })).toBeNull();
      await sql(
        "UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{enabled}','true') WHERE tenant_id='tenant-a'",
      );
      await sql(
        "UPDATE clockgrove.mcp_installations SET drifted=ARRAY['lookup'] WHERE tenant_id='tenant-a'",
      );
      expect(await port.admit(request(2).intent, { q: "weather" })).toBeNull();
      await sql(
        "UPDATE clockgrove.mcp_installations SET drifted=ARRAY[]::text[] WHERE tenant_id='tenant-a'; UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{effect}','\"deny\"') WHERE tenant_id='tenant-a'",
      );
      expect(await port.admit(request(2).intent, { q: "weather" })).toBeNull();
      await sql(
        "UPDATE clockgrove.mcp_bindings SET binding=jsonb_set(binding,'{effect}','\"allow\"') WHERE tenant_id='tenant-a'",
      );
      await new PostgreSqlEffects(clients[0]!).claim(request(1).intent, "in-flight");
      await port.setSwitch({ scope: "global" }, true);
      await new PostgreSqlEffects(clients[0]!).complete(request(1).intent, "in-flight", {
        disposition: "uncertain",
        outcomeCode: "transport_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
      expect(await new PostgreSqlEffects(clients[0]!).accounting(request(1).intent)).toEqual({
        knownCostMicrousd: "0",
        unknownCostCount: "1",
      });
      expect(await port.reserve(request(1))).toMatchObject({
        disposition: "uncertain",
        outcomeCode: "transport_lost",
      });
      const runtime = connect(fixture.environment);
      try {
        await expect(
          new PostgreSqlMcpReadAdmission(runtime).setSwitch({ scope: "global" }, false),
        ).rejects.toThrow("MCP read admission unavailable");
        for (const table of [
          "mcp_read_switches",
          "mcp_read_turn_budgets",
          "mcp_read_admissions",
          "mcp_read_retry_refusals",
        ]) {
          expect(
            (
              await runtime.query(
                "SELECT has_table_privilege('clockgrove_runtime',$1,'SELECT') AS held",
                [`clockgrove.${table}`],
              )
            ).rows,
          ).toEqual([{ held: false }]);
          await expect(runtime.query(`SELECT * FROM clockgrove.${table}`)).rejects.toThrow(
            "PostgreSQL query failed",
          );
        }
      } finally {
        await runtime.close();
      }
      expect((await sql("SELECT count(*) FROM clockgrove.mcp_read_admissions")).trim()).toBe("8");
      await port.setSwitch({ scope: "global" }, false);
      await sql(`BEGIN;
        INSERT INTO clockgrove.conversation_participants(tenant_id,session_id,principal_id,persona_id)
          SELECT 'tenant-a',id,'principal-a','persona-a' FROM unnest(ARRAY['time','output','cost','proactive','invalid','recovery']) id;
        INSERT INTO clockgrove.conversation_sessions(tenant_id,session_id,world_id,timeline_id,partition_id,space_id,actor_id,voice_mode)
          SELECT 'tenant-a',id,'world-a','timeline-a','partition-a','space-a','actor','cognitive' FROM unnest(ARRAY['time','output','cost','proactive','invalid','recovery']) id;
        INSERT INTO clockgrove.conversation_turn_fibers(tenant_id,session_id,message_id,world_id,timeline_id,actor_id,principal_id,persona_id,input_artifact_id)
          SELECT 'tenant-a',id,'message','world-a','timeline-a','actor','principal-a','persona-a','input' FROM unnest(ARRAY['time','output','cost','proactive','invalid','recovery']) id;
        COMMIT;`);
      for (const [index, sessionId, policy] of [
        [7, "time", { ...MCP_READ_TURN_DEFAULTS, maxTimeMs: 44999 }],
        [8, "output", { ...MCP_READ_TURN_DEFAULTS, maxOutputBytes: 65535 }],
        [9, "cost", { ...MCP_READ_TURN_DEFAULTS, maxCostMicrousd: 79999 }],
      ] as const) {
        expect(await port.reserve({ ...request(index), sessionId, policy })).toMatchObject({
          disposition: "refused",
          outcomeCode: "budget_exhausted",
        });
      }
      expect(
        await port.reserve({ ...request(16), sessionId: "invalid", arguments: {} }),
      ).toMatchObject({ disposition: "refused", outcomeCode: "invalid_input" });
      const changedArguments = {
        ...request(17),
        sessionId: "invalid",
        arguments: { q: "changed" },
      };
      const refusal = await port.reserve(changedArguments);
      expect(refusal).toMatchObject({ disposition: "refused", outcomeCode: "arguments_changed" });
      expect(await port.reserve(changedArguments)).toEqual(refusal);
      await expect(
        port.reserve({ ...changedArguments, arguments: { q: "different" } }),
      ).rejects.toThrow("MCP read admission unavailable");
      expect(
        (
          await sql(
            "SELECT calls||','||reserved_microusd FROM clockgrove.mcp_read_turn_budgets WHERE session_id='invalid'",
          )
        ).trim(),
      ).toBe("0,0");
      expect(
        await port.reserve({ ...request(16), sessionId: "invalid", arguments: {} }),
      ).toMatchObject({ disposition: "refused", outcomeCode: "invalid_input" });
      await expect(
        port.reserve({ ...request(20), sessionId: "invalid", eventId: "missing" }),
      ).rejects.toThrow("MCP read admission unavailable");
      expect(
        (
          await sql(
            "SELECT calls||','||reserved_microusd||','||reserved_time_ms||','||reserved_output_bytes FROM clockgrove.mcp_read_turn_budgets WHERE session_id='invalid'",
          )
        ).trim(),
      ).toBe("0,0,0,0");
      expect(
        (
          await sql(
            "SELECT (SELECT count(*) FROM clockgrove.effect_intents)||','||(SELECT count(*) FROM clockgrove.event_dispatches)||','||(SELECT count(*) FROM clockgrove.mcp_read_admissions)",
          )
        ).trim(),
      ).toBe("13,3,13");
      expect(
        await port.reserve({
          ...request(21),
          sessionId: "invalid",
          intent: { ...request(21).intent, argumentsArtifactId: null },
        }),
      ).toMatchObject({ disposition: "refused", outcomeCode: "arguments_artifact_required" });
      expect(
        (
          await sql(
            "SELECT calls||','||reserved_microusd||','||reserved_time_ms||','||reserved_output_bytes FROM clockgrove.mcp_read_turn_budgets WHERE session_id='invalid'",
          )
        ).trim(),
      ).toBe("0,0,0,0");
      await sql(`INSERT INTO clockgrove.agent_runs(tenant_id,run_id,world_id,timeline_id,partition_id,space_id,session_id,actor_id,principal_id,persona_id,activation,input_message_id,root_run_id,model,prompt_version,input_revision,summary)
        SELECT 'tenant-a',id,'world-a','timeline-a','partition-a','space-a','recovery','actor','principal-a','persona-a','conversation_message','message',id,'scripted','fixture',0,'fixture' FROM unnest(ARRAY['old-run','new-run']) id;
        UPDATE clockgrove.conversation_turn_fibers SET run_id='old-run',phase='model_running',attempt=1,lease_epoch=1 WHERE session_id='recovery';`);
      const recovery = {
        ...request(18),
        sessionId: "recovery",
        intent: { ...request(18).intent, runId: "old-run" },
      };
      expect(await port.reserve(recovery)).toMatchObject({ disposition: "pending" });
      await sql(
        "UPDATE clockgrove.conversation_turn_fibers SET run_id='new-run',attempt=2,lease_epoch=2 WHERE session_id='recovery'",
      );
      expect(await port.admit(recovery.intent, { q: "weather" })).toMatchObject({
        toolName: "lookup",
      });
      await expect(
        port.reserve({
          ...request(19),
          sessionId: "recovery",
          intent: { ...request(19).intent, runId: "old-run" },
        }),
      ).rejects.toThrow("MCP read admission unavailable");
      await expect(port.reserve({ ...request(10), sessionId: null })).rejects.toThrow(
        "MCP read admission unavailable",
      );
      await sql(`UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-command'],roles=ARRAY['owner'] WHERE tenant_id='tenant-a';
        INSERT INTO clockgrove.actor_activation_policies(tenant_id,world_id,timeline_id,space_id,actor_id,principal_id,allow_model,configurations)
          VALUES('tenant-a','world-a','timeline-a','space-a','actor','principal-a',true,'[{"id":"timer","enabled":true}]');
        INSERT INTO clockgrove.actor_activations(tenant_id,world_id,timeline_id,space_id,actor_id,causal_root,activation_id,principal_id,configuration_id,reason,evidence,session_id,message_id,input,has_reservation,status,outcome)
          VALUES('tenant-a','world-a','timeline-a','space-a','actor','timer','activation','principal-a','timer','{}','fixture','proactive','message','fixture',true,'pending','admitted');`);
      const proactive = { ...request(11), sessionId: "proactive" };
      expect(await port.reserve(proactive)).toMatchObject({ disposition: "pending" });
      expect(await port.admit(proactive.intent, { q: "weather" })).toMatchObject({
        toolName: "lookup",
      });
      await sql(
        "UPDATE clockgrove.actor_activation_policies SET allow_model=false WHERE tenant_id='tenant-a'",
      );
      expect(await port.admit(proactive.intent, { q: "weather" })).toBeNull();
      await sql(`INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES('tenant-a','world-a','preview','branch');
        INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES('tenant-a','world-a','preview','preview','space-a');
        BEGIN;
        INSERT INTO clockgrove.conversation_participants(tenant_id,session_id,principal_id,persona_id) VALUES('tenant-a','preview','principal-a','persona-a');
        INSERT INTO clockgrove.conversation_sessions(tenant_id,session_id,world_id,timeline_id,partition_id,space_id,actor_id,voice_mode) VALUES('tenant-a','preview','world-a','preview','preview','space-a','actor','cognitive');
        INSERT INTO clockgrove.conversation_turn_fibers(tenant_id,session_id,message_id,world_id,timeline_id,actor_id,principal_id,persona_id,input_artifact_id) VALUES('tenant-a','preview','message','world-a','preview','actor','principal-a','persona-a','input'); COMMIT;`);
      const preview = {
        ...request(12),
        sessionId: "preview",
        intent: { ...request(12).intent, timelineId: "preview", argumentsArtifactId: null },
      };
      expect(await port.reserve(preview)).toMatchObject({
        disposition: "blocked",
        outcomeCode: "preview_blocked",
      });
      expect((await sql("SELECT count(*) FROM clockgrove.event_dispatches")).trim()).toBe("5");
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});
