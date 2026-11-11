import { expect, it } from "vitest";
import { PostgreSqlEffects } from "../../../packages/persistence/src/postgres-effects.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("claims once, preserves encrypted replay and unknown cost, and reconciles crash boundaries without resend", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    const sql = (query: string) => psqlQuery(fixture.tools, fixture.environment, query);
    await sql(`INSERT INTO clockgrove.effect_intents
      (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd)
      SELECT 'tenant-j-a','world-j-a','timeline-j-a','space-j-a',id,id,'fixture-actor','principal-j-a',id,'fixture-read','grant-a','policy-a',repeat('a',64),250000
      FROM unnest(ARRAY['success','uncertain','crashed']) id;
      INSERT INTO clockgrove.artifact_data_keys(tenant_id,world_id,privacy_class,key_version,kek_id,wrapped_key)
      VALUES ('tenant-j-a','world-j-a','conversation',1,'fixture',decode(repeat('01',61),'hex'));
      INSERT INTO clockgrove.artifact_references(tenant_id,world_id,timeline_id,partition_id,space_id,artifact_id,content_hash,media_type,inline_content,byte_length,privacy_class,retention_class,encryption,data_key_version)
      VALUES ('tenant-j-a','world-j-a','timeline-j-a','partition-j-a','space-j-a','effect-result','sha256:'||encode(sha256(decode(repeat('01',32),'hex')),'hex'),'application/json',decode(repeat('01',32),'hex'),32,'conversation','durable','aes-256-gcm-v1',1);`);
    await sql(`INSERT INTO clockgrove.effect_intents
      (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd,disposition,outcome_code,ended_at)
      VALUES ('tenant-j-a','world-j-a','timeline-j-a','space-j-a','blocked','blocked','fixture-actor','principal-j-a','blocked','fixture-read','grant-a','policy-a',repeat('a',64),0,'blocked','policy_blocked',statement_timestamp());`);
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const ports = clients.map((client) => new PostgreSqlEffects(client));
    const port = ports[0]!;
    const scope = { tenantId: "tenant-j-a", worldId: "world-j-a", timelineId: "timeline-j-a" };
    const address = (effectId: string) => ({ ...scope, effectId });
    try {
      const blocked = await port.read(address("blocked"));
      expect(blocked).toMatchObject({
        disposition: "blocked",
        attemptId: null,
        outcomeCode: "policy_blocked",
      });
      expect(blocked?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
      expect(await port.claim(address("blocked"), "blocked-attempt")).toEqual({
        claimed: false,
        effect: blocked,
      });
      const claims = await Promise.all(
        ports.map((adapter) => adapter.claim(address("success"), "attempt-success")),
      );
      expect(claims.map((claim) => claim.claimed).sort()).toEqual([false, true]);
      expect(await port.claim(address("success"), "different-attempt")).toMatchObject({
        claimed: false,
        effect: { disposition: "started", attemptId: "attempt-success" },
      });
      expect(await port.reconcile(address("success"))).toMatchObject({
        disposition: "started",
        attemptDisposition: "started",
      });
      const success = {
        disposition: "succeeded" as const,
        outcomeCode: "ok",
        resultArtifactId: "effect-result",
        costMicrousd: 0,
      };
      expect(await port.accounting(scope)).toEqual({
        knownCostMicrousd: "0",
        unknownCostCount: "0",
      });
      await expect(
        port.complete(address("success"), "attempt-success", {
          ...success,
          resultArtifactId: "missing-artifact",
        }),
      ).rejects.toThrow("Effect persistence unavailable");
      expect(await port.read(address("success"))).toMatchObject({
        disposition: "started",
        attemptDisposition: "started",
        resultArtifactId: null,
      });
      const completed = await port.complete(address("success"), "attempt-success", success);
      expect(completed).toMatchObject({
        disposition: "succeeded",
        resultArtifactId: "effect-result",
        costMicrousd: 0,
      });
      expect(completed.endedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
      expect(await port.complete(address("success"), "attempt-success", success)).toEqual(
        completed,
      );
      expect(await ports[1]!.claim(address("success"), "replay")).toEqual({
        claimed: false,
        effect: completed,
      });
      expect(await ports[1]!.read(address("success"))).toEqual(completed);
      await expect(
        port.complete(address("success"), "attempt-success", { ...success, costMicrousd: 1 }),
      ).rejects.toThrow("Effect persistence unavailable");
      await expect(port.complete(address("success"), "wrong-attempt", success)).rejects.toThrow(
        "Effect persistence unavailable",
      );
      await port.claim(address("uncertain"), "attempt-uncertain");
      const uncertainty = {
        disposition: "uncertain" as const,
        outcomeCode: "connection_lost",
        resultArtifactId: null,
        costMicrousd: null,
      };
      expect(
        await port.complete(address("uncertain"), "attempt-uncertain", uncertainty),
      ).toMatchObject({ disposition: "uncertain", costMicrousd: null });
      await expect(
        port.complete(address("uncertain"), "attempt-uncertain", success),
      ).rejects.toThrow("Effect persistence unavailable");
      await port.claim(address("crashed"), "attempt-crashed");
      await sql(
        `UPDATE clockgrove.effect_attempts SET disposition='failed',outcome_code='tool_unavailable',cost_microusd=25,ended_at=statement_timestamp() WHERE effect_id='crashed';`,
      );
      expect(await port.read(address("crashed"))).toMatchObject({
        disposition: "started",
        attemptDisposition: "failed",
      });
      expect(await ports[1]!.reconcile(address("crashed"))).toMatchObject({
        disposition: "failed",
        outcomeCode: "tool_unavailable",
        costMicrousd: 25,
      });
      expect(
        (
          await sql(
            `SELECT count(*) FROM clockgrove.effect_intents i JOIN clockgrove.effect_attempts a USING(tenant_id,world_id,timeline_id,effect_id) WHERE i.effect_id='crashed' AND i.ended_at=a.ended_at;`,
          )
        ).trim(),
      ).toBe("1");
      expect(await port.accounting(scope)).toEqual({
        knownCostMicrousd: "25",
        unknownCostCount: "1",
      });
      for (const foreign of [
        { tenantId: "tenant-j-b" },
        { worldId: "world-j-b" },
        { timelineId: "timeline-j-b" },
      ]) {
        const hidden = { ...address("success"), ...foreign };
        expect(await port.read(hidden)).toBeNull();
        expect(await port.claim(hidden, "foreign")).toEqual({ claimed: false, effect: null });
        expect(await port.reconcile(hidden)).toBeNull();
        await expect(port.complete(hidden, "attempt-success", success)).rejects.toThrow(
          "Effect persistence unavailable",
        );
      }
      await expect(port.claim({ ...address("success"), tenantId: "" }, "invalid")).rejects.toThrow(
        "Invalid effect address",
      );
      await expect(
        port.complete(address("success"), "attempt-success", {
          ...success,
          costMicrousd: Number.NaN,
        }),
      ).rejects.toThrow("Invalid effect completion");
      expect((await sql("SELECT count(*) FROM clockgrove.effect_attempts;")).trim()).toBe("3");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
