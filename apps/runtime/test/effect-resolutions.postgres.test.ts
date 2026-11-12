import { expect, it } from "vitest";
import { PostgreSqlEffectResolutions } from "../../../packages/persistence/src/postgres-effect-resolutions.js";
import { PostgreSqlEffects } from "../../../packages/persistence/src/postgres-effects.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("records one immutable attributed uncertainty resolution without rewriting or resending the effect", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/effect-resolutions.sql");
    const sql = (query: string) => psqlQuery(fixture.tools, fixture.environment, query);
    await sql(`INSERT INTO clockgrove.tenant_principals(tenant_id,principal_id) VALUES ('tenant-j-a','operator');
      INSERT INTO clockgrove.effect_intents
      (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd)
      SELECT 'tenant-j-a','world-j-a','timeline-j-a','space-j-a',id,id,'fixture-actor','principal-j-a',id,'fixture-write','grant','policy',repeat('a',64),0
      FROM unnest(ARRAY['done','failed','started','pending','known-failure']) id;`);
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const ports = clients.map((client) => new PostgreSqlEffectResolutions(client));
    const port = ports[0]!;
    const effects = new PostgreSqlEffects(clients[0]!);
    const scope = { tenantId: "tenant-j-a", worldId: "world-j-a", timelineId: "timeline-j-a" };
    const address = (effectId: string) => ({ ...scope, effectId });
    const request = {
      ...address("done"),
      attemptId: "attempt-done",
      resolvedBy: "operator",
      disposition: "done" as const,
    };
    try {
      for (const id of ["done", "failed", "started", "known-failure"]) {
        await effects.claim(address(id), `attempt-${id}`);
        if (id !== "started")
          await effects.complete(address(id), `attempt-${id}`, {
            disposition: id === "known-failure" ? "failed" : "uncertain",
            outcomeCode: id === "known-failure" ? "refused" : "reply_lost",
            resultArtifactId: null,
            costMicrousd: null,
          });
      }
      const before = await effects.read(address("done"));
      expect(before).toMatchObject({
        disposition: "uncertain",
        attemptId: "attempt-done",
        attemptDisposition: "uncertain",
        outcomeCode: "reply_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
      await expect(port.resolve({ ...request, resolvedBy: "unknown" })).rejects.toThrow(
        "Effect resolution persistence unavailable",
      );
      expect(await port.read(request)).toBeNull();
      const records = await Promise.all(ports.map((adapter) => adapter.resolve(request)));
      expect(records[0]).toEqual(records[1]);
      const record = records[0]!;
      expect(record).toMatchObject({ ...request, spaceId: "space-j-a" });
      expect(record.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
      expect(await effects.read(address("done"))).toEqual(before);
      expect(await effects.claim(address("done"), "retry")).toEqual({
        claimed: false,
        effect: before,
      });
      expect(await port.read(address("done"))).toEqual(record);
      expect(
        await port.resolve({
          ...address("failed"),
          attemptId: "attempt-failed",
          resolvedBy: "operator",
          disposition: "failed",
        }),
      ).toMatchObject({ disposition: "failed", resolvedBy: "operator" });
      for (const changed of [
        { disposition: "failed" as const },
        { resolvedBy: "principal-j-a" },
        { attemptId: "attempt-failed" },
        { resolvedBy: "unknown" },
      ]) {
        await expect(port.resolve({ ...request, ...changed })).rejects.toThrow(
          "Effect resolution persistence unavailable",
        );
      }
      for (const id of ["started", "pending", "known-failure", "missing"]) {
        await expect(
          port.resolve({ ...request, ...address(id), attemptId: `attempt-${id}` }),
        ).rejects.toThrow("Effect resolution persistence unavailable");
        expect(await port.read(address(id))).toBeNull();
      }
      for (const changed of [
        { tenantId: "tenant-j-b" },
        { worldId: "world-j-b" },
        { timelineId: "timeline-j-b" },
      ]) {
        expect(await port.read({ ...request, ...changed })).toBeNull();
        await expect(port.resolve({ ...request, ...changed })).rejects.toThrow(
          "Effect resolution persistence unavailable",
        );
      }
      const restarted = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        const recovered = new PostgreSqlEffectResolutions(restarted);
        expect(await recovered.resolve(request)).toEqual(record);
        expect(await recovered.read(request)).toEqual(record);
      } finally {
        await restarted.close();
      }
      expect((await sql("SELECT count(*) FROM clockgrove.effect_resolutions;")).trim()).toBe("2");
      expect(
        (
          await sql(
            "SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects';",
          )
        ).trim(),
      ).toBe("0");
      expect(await effects.read(address("done"))).toEqual(before);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
