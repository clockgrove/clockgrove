import { McpReadFailure } from "@clockgrove/application";
import { expect, it } from "vitest";
import {
  type EffectReservation,
  PostgreSqlEffects,
} from "../../../packages/persistence/src/postgres-effects.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { externalEffectsConsumer } from "../src/external-effects.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("verifies canonical Queue identity, executes once, records uncertainty and replays without resend", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = (query: string) => psqlQuery(fixture.tools, fixture.environment, query);
    await sql(`INSERT INTO clockgrove.events
      (event_id,tenant_id,world_id,timeline_id,partition_id,space_id,stream_id,stream_sequence,
       partition_sequence,event_type,schema_version,simulation_time,command_id,correlation_id,
       principal_id,privacy_class,payload_hash,attribution,policy_versions,payload,event_bytes)
      SELECT 'research-'||n,'tenant-a','world-a','timeline-a','partition-a','space-a','stream-a',n,n,
        'ResearchFixture',2,0,'command-a','correlation-a','principal-a','conversation','hash-'||n,
        '{}','{}','{}',convert_to('{"schemaVersion":2}','UTF8') FROM generate_series(3,9) n;
      INSERT INTO clockgrove.artifact_data_keys(tenant_id,world_id,privacy_class,key_version,kek_id,wrapped_key)
      VALUES ('tenant-a','world-a','conversation',1,'fixture',decode(repeat('01',61),'hex'));
      INSERT INTO clockgrove.artifact_references(tenant_id,world_id,timeline_id,partition_id,space_id,
        artifact_id,content_hash,media_type,inline_content,byte_length,privacy_class,retention_class,encryption,data_key_version)
      VALUES ('tenant-a','world-a','timeline-a','partition-a','space-a','effect-result',
        'sha256:'||encode(sha256(decode(repeat('01',32),'hex')),'hex'),'application/json',
        decode(repeat('01',32),'hex'),32,'conversation','durable','aes-256-gcm-v1',1);`);
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const stores = clients.map((client) => new PostgreSqlEffects(client));
    const scope = { tenantId: "tenant-a", worldId: "world-a", timelineId: "timeline-a" };
    const names = [
      "success",
      "uncertain",
      "refused",
      "changed",
      "store-failure",
      "completion-failure",
      "completion-write",
    ];
    const reserve = (name: string, index: number): EffectReservation => ({
      ...scope,
      effectId: name,
      spaceId: "space-a",
      idempotencyKey: name,
      actorId: "actor",
      principalId: "principal-a",
      runId: null,
      callId: name,
      capabilityId: "fixture-read",
      grantId: "grant",
      policyVersion: "policy",
      // SHA-256 of literal UTF-8 {} (independent of the production argument encoder).
      argumentsHash:
        name === "success"
          ? "0527195ce977da1d77fa651c386812d6dca3d58d6363ab186b06573ed6441427"
          : "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      argumentsArtifactId: null,
      reservedMicrousd: 250000,
      disposition: "pending",
      dispatchId: `dispatch-${name}`,
      eventId: `research-${index + 3}`,
    });
    const envelope = (name: string) => ({
      schemaVersion: 2,
      messageId: `dispatch-${name}`,
      channel: "external-effects",
      ...scope,
      sourceEventId: `research-${names.indexOf(name) + 3}`,
      correlationId: "correlation-a",
      attemptHint: 1,
      payload: { effectId: name },
    });
    const evidence = {
      trust: "untrusted_evidence" as const,
      status: "ok" as const,
      content: [{ type: "text" as const, text: "fixture answer" }],
      sanitized: false,
      costMicrousd: null,
    };
    let attempt = 0;
    let calls = 0;
    let admissions = 0;
    let writes = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumers = stores.map((effects, index) =>
      externalEffectsConsumer({
        effects,
        attemptId: () => `attempt-${index}-${++attempt}`,
        admit: async (intent) => {
          admissions++;
          if (intent.effectId === "refused") return null;
          return {
            admittedReadOnly: true,
            endpoint: "https://fixture.example/mcp",
            toolName: intent.effectId,
            arguments:
              intent.effectId === "changed"
                ? { changed: true }
                : intent.effectId === "success"
                  ? { z: [1.5, { b: 2, a: "x" }], a: true }
                  : {},
          };
        },
        adapter: {
          execute: async (request) => {
            calls++;
            if (request.toolName === "success") {
              expect(request.arguments).toEqual({ z: [1.5, { b: 2, a: "x" }], a: true });
              entered();
              await waiting;
            }
            if (request.toolName === "uncertain")
              throw new McpReadFailure("private-canary", "uncertain");
            return evidence;
          },
        },
        persistResult: async (intent, result) => {
          writes++;
          expect(result).toEqual(evidence);
          if (intent.effectId === "store-failure")
            throw new McpReadFailure("private-canary", "not_sent");
          return "effect-result";
        },
      }),
    );
    const consume = (index: number, message: unknown) =>
      consumers[index]!.consume(message, (value) => value);
    try {
      for (const [index, name] of names.entries()) await stores[0]!.reserve(reserve(name, index));
      const good = envelope("success");
      const variants = [
        { ...good, tenantId: "tenant-b" },
        { ...good, worldId: "world-b" },
        { ...good, timelineId: "timeline-b" },
        { ...good, messageId: "unknown" },
        { ...good, sourceEventId: "event-a-public" },
        { ...good, correlationId: "forged" },
        { ...good, effectId: "changed" },
        { ...good, payload: { effectId: "success", endpoint: "https://evil.example" } },
      ];
      for (const forged of variants)
        await expect(consume(0, forged)).rejects.toThrow("inconsistent");
      expect([calls, admissions, writes]).toEqual([0, 0, 0]);
      const first = consume(0, good);
      await started;
      await expect(consume(1, { ...good, attemptHint: 99 })).rejects.toThrow(
        "External effect is in flight",
      );
      expect(calls).toBe(1);
      release();
      await first;
      await consume(1, good);
      expect([calls, admissions, writes]).toEqual([1, 1, 1]);
      expect(await stores[0]!.read({ ...scope, effectId: "success" })).toMatchObject({
        disposition: "succeeded",
        attemptId: "attempt-0-1",
        outcomeCode: "ok",
        resultArtifactId: "effect-result",
        costMicrousd: null,
      });
      for (const name of ["uncertain", "refused", "changed", "store-failure"]) {
        await consume(0, envelope(name));
        await consume(1, envelope(name));
      }
      expect([calls, admissions, writes]).toEqual([3, 5, 2]);
      expect(await stores[0]!.read({ ...scope, effectId: "uncertain" })).toMatchObject({
        disposition: "uncertain",
        outcomeCode: "tool_uncertain",
        resultArtifactId: null,
        costMicrousd: null,
      });
      expect(await stores[0]!.read({ ...scope, effectId: "refused" })).toMatchObject({
        disposition: "failed",
        outcomeCode: "admission_refused",
      });
      expect(await stores[0]!.read({ ...scope, effectId: "changed" })).toMatchObject({
        disposition: "failed",
        outcomeCode: "arguments_changed",
      });
      expect(await stores[0]!.read({ ...scope, effectId: "store-failure" })).toMatchObject({
        disposition: "uncertain",
        outcomeCode: "tool_uncertain",
        resultArtifactId: null,
      });
      expect(await stores[0]!.accounting(scope)).toEqual({
        knownCostMicrousd: "0",
        unknownCostCount: "5",
      });
      expect((await sql("SELECT count(*) FROM clockgrove.effect_attempts;")).trim()).toBe("5");
      const rows = await sql("SELECT row_to_json(a)::text FROM clockgrove.effect_attempts a;");
      expect(rows.includes("private-canary")).toBe(false);
      const completeFailure = externalEffectsConsumer({
        effects: {
          resolveDispatch: (message) => stores[0]!.resolveDispatch(message),
          claim: (address, id) => stores[0]!.claim(address, id),
          reconcile: (address) => stores[0]!.reconcile(address),
          complete: async () => {
            throw new Error("completion unavailable");
          },
        },
        attemptId: () => "completion-write-attempt",
        admit: async () => ({
          admittedReadOnly: true,
          endpoint: "https://fixture.example/mcp",
          toolName: "completion-write",
          arguments: {},
        }),
        adapter: {
          execute: async () => {
            calls++;
            return evidence;
          },
        },
        persistResult: async () => "effect-result",
      });
      await expect(
        completeFailure.consume(envelope("completion-write"), (value) => value),
      ).rejects.toThrow("completion unavailable");
      await expect(consume(1, envelope("completion-write"))).rejects.toThrow(
        "External effect is in flight",
      );
      expect(calls).toBe(4);
      await stores[0]!.complete(
        { ...scope, effectId: "completion-write" },
        "completion-write-attempt",
        {
          disposition: "uncertain",
          outcomeCode: "tool_uncertain",
          resultArtifactId: null,
          costMicrousd: null,
        },
      );
      await consume(1, envelope("completion-write"));
      expect(calls).toBe(4);
      // Terminal attempt committed before settlement is reconciled without invoking any port.
      await stores[0]!.claim({ ...scope, effectId: "completion-failure" }, "crashed");
      await sql(`UPDATE clockgrove.effect_attempts SET disposition='uncertain',outcome_code='tool_uncertain',
        ended_at=statement_timestamp() WHERE effect_id='completion-failure';`);
      await consume(1, envelope("completion-failure"));
      expect(await stores[0]!.read({ ...scope, effectId: "completion-failure" })).toMatchObject({
        disposition: "uncertain",
        attemptId: "crashed",
        outcomeCode: "tool_uncertain",
      });
      expect([calls, admissions, writes]).toEqual([4, 5, 2]);
    } finally {
      release();
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
