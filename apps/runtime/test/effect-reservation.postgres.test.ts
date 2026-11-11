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
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("atomically persists exact admitted intent/outbox pairs and refuses conflicting retries without resend", async () => {
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
        '{}','{}','{}',convert_to('{"schemaVersion":2}','UTF8') FROM generate_series(3,5) n;
      INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind)
        VALUES ('tenant-a','world-a','preview','branch');
      INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id)
        VALUES ('tenant-a','world-a','preview','preview','space-a');`);
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const ports = clients.map((client) => new PostgreSqlEffects(client));
    const port = ports[0]!;
    const request: EffectReservation = {
      tenantId: "tenant-a",
      worldId: "world-a",
      timelineId: "timeline-a",
      spaceId: "space-a",
      effectId: "research",
      idempotencyKey: "key-research",
      actorId: "actor",
      principalId: "principal-a",
      runId: null,
      callId: "call-research",
      capabilityId: "fixture-read",
      grantId: "grant",
      policyVersion: "policy",
      argumentsHash: "a".repeat(64),
      argumentsArtifactId: null,
      reservedMicrousd: 250000,
      disposition: "pending",
      eventId: "event-a-private",
      dispatchId: "dispatch-research",
    };
    const rejected = (input: EffectReservation) =>
      expect(port.reserve(input)).rejects.toThrow("Effect persistence unavailable");
    const counts = async () =>
      (
        await sql(
          "SELECT (SELECT count(*) FROM clockgrove.effect_intents)||','||(SELECT count(*) FROM clockgrove.event_dispatches);",
        )
      ).trim();
    try {
      const results = await Promise.all(ports.map((p) => p.reserve(request)));
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toEqual({
        disposition: "pending",
        attemptId: null,
        attemptDisposition: null,
        outcomeCode: null,
        resultArtifactId: null,
        costMicrousd: null,
        endedAt: null,
      });
      expect(await counts()).toBe("1,1");
      expect(
        (
          await sql(
            "SELECT channel||','||privacy_class||','||partition_id||','||payload::text FROM clockgrove.event_dispatches;",
          )
        ).trim(),
      ).toBe('external-effects,conversation,partition-a,{"effectId": "research"}');
      await rejected({ ...request, argumentsHash: "b".repeat(64) });
      await rejected({ ...request, principalId: "principal-b" });
      await rejected({ ...request, dispatchId: "changed" });
      await rejected({ ...request, eventId: "research-3" });
      await rejected({
        ...request,
        effectId: "new",
        callId: "new",
        idempotencyKey: "new",
        eventId: "event-a-public",
      });
      await rejected({
        ...request,
        effectId: "new",
        callId: "new",
        idempotencyKey: "new",
        eventId: "event-b-public",
      });
      await rejected({
        ...request,
        effectId: "collision",
        callId: "collision",
        idempotencyKey: "collision",
        eventId: "research-3",
      });
      await rejected({
        ...request,
        effectId: "same-event",
        callId: "same-event",
        idempotencyKey: "same-event",
        dispatchId: "new",
      });
      expect(await counts()).toBe("1,1");
      const race = {
        ...request,
        effectId: "race",
        callId: "race",
        idempotencyKey: "race",
        dispatchId: "race",
        eventId: "research-3",
      };
      const raced = await Promise.allSettled([
        ports[0]!.reserve(race),
        ports[1]!.reserve({ ...race, argumentsHash: "c".repeat(64) }),
      ]);
      expect(raced.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await counts()).toBe("2,2");
      await port.claim(request, "attempt");
      await port.complete(request, "attempt", {
        disposition: "failed",
        outcomeCode: "tool_unavailable",
        resultArtifactId: null,
        costMicrousd: null,
      });
      const replay = await port.reserve(request);
      expect(replay).toMatchObject({
        disposition: "failed",
        attemptId: "attempt",
        outcomeCode: "tool_unavailable",
        costMicrousd: null,
      });
      expect(await port.accounting(request)).toEqual({
        knownCostMicrousd: "0",
        unknownCostCount: "1",
      });
      expect(await counts()).toBe("2,2");
      // A missing outbox on a preexisting intent is corruption, never permission to resend.
      await sql(`INSERT INTO clockgrove.effect_intents
        (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd)
        VALUES ('tenant-a','world-a','timeline-a','space-a','orphan','orphan','actor','principal-a','orphan','fixture-read','grant','policy',repeat('a',64),250000);`);
      await rejected({
        ...request,
        effectId: "orphan",
        idempotencyKey: "orphan",
        callId: "orphan",
        dispatchId: "orphan",
        eventId: "research-4",
      });
      expect(await counts()).toBe("3,2");
      await port.claim({ ...request, effectId: "orphan" }, "orphan-attempt");
      await port.complete({ ...request, effectId: "orphan" }, "orphan-attempt", {
        disposition: "uncertain",
        outcomeCode: "connection_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
      await rejected({
        ...request,
        effectId: "orphan",
        idempotencyKey: "orphan",
        callId: "orphan",
        dispatchId: "orphan",
        eventId: "research-4",
      });
      expect(await counts()).toBe("3,2");

      const preview = {
        ...request,
        timelineId: "preview",
        effectId: "preview",
        idempotencyKey: "preview",
        callId: "preview",
      };
      await rejected(preview);
      expect(
        await port.reserve({ ...preview, disposition: "blocked", outcomeCode: "preview_blocked" }),
      ).toMatchObject({ disposition: "blocked", outcomeCode: "preview_blocked", attemptId: null });
      expect(
        await port.reserve({ ...preview, disposition: "blocked", outcomeCode: "preview_blocked" }),
      ).toMatchObject({ disposition: "blocked" });
      await rejected({ ...preview, disposition: "blocked", outcomeCode: "changed_reason" });
      const refusal = {
        ...request,
        effectId: "refused",
        callId: "refused",
        idempotencyKey: "refused",
        disposition: "refused" as const,
        outcomeCode: "grant_revoked",
      };
      await port.reserve(refusal);
      await rejected({
        ...request,
        effectId: "refused",
        callId: "refused",
        idempotencyKey: "refused",
        dispatchId: "refused",
        eventId: "research-4",
      });
      expect(await counts()).toBe("5,2");
      await expect(port.reserve({ ...request, reservedMicrousd: NaN })).rejects.toThrow(
        "Invalid effect reservation",
      );
      expect((await sql("SELECT count(*) FROM clockgrove.effect_attempts;")).trim()).toBe("2");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
