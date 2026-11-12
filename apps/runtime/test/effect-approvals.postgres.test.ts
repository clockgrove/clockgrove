import { expect, it } from "vitest";
import { PostgreSqlEffectApprovals } from "../../../packages/persistence/src/postgres-effect-approvals.js";
import { withClientTransaction } from "../../../packages/persistence/src/postgres-transaction.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("binds durable approvals exactly, preserves human attribution, expires after lock waits and consumes once", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/effect-approvals.sql");
    await psqlQuery(
      fixture.tools,
      fixture.environment,
      `INSERT INTO clockgrove.tenant_principals(tenant_id,principal_id) VALUES ('tenant-j-a','approver');`,
    );
    const clients = [
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    ];
    const ports = clients.map((client) => new PostgreSqlEffectApprovals(client));
    const port = ports[0]!;
    const request = {
      tenantId: "tenant-j-a",
      worldId: "world-j-a",
      timelineId: "timeline-j-a",
      spaceId: "space-j-a",
      approvalId: "approve",
      effectId: "effect",
      principalId: "principal-j-a",
      approverPrincipalId: "approver",
      argumentsHash: "a".repeat(64),
      effectHash: "b".repeat(64),
      argumentsArtifactId: null,
    };
    try {
      const pending = await port.request(request);
      expect(pending).toMatchObject({
        ...request,
        state: "pending",
        decision: null,
        expirySeconds: 600,
      });
      expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBe(600000);
      expect(await ports[1]!.request({ ...request })).toEqual(pending);
      for (const changed of [
        { argumentsHash: "c".repeat(64) },
        { effectHash: "c".repeat(64) },
        { principalId: "approver" },
        { approverPrincipalId: "principal-j-a" },
        { effectId: "other" },
        { expirySeconds: 601 },
      ]) {
        await expect(port.request({ ...request, ...changed })).rejects.toThrow(
          "Approval persistence unavailable",
        );
      }
      await expect(port.decide(request, "principal-j-a", "approved")).rejects.toThrow(
        "Approval persistence unavailable",
      );
      expect(await port.consume({ ...request, expiresAt: pending.expiresAt })).toEqual({
        consumed: false,
        approval: pending,
      });
      const decisions = await Promise.all(
        ports.map((adapter) => adapter.decide(request, "approver", "approved")),
      );
      expect(decisions[0]).toEqual(decisions[1]);
      const approved = decisions[0]!;
      expect(approved).toMatchObject({
        state: "approved",
        decision: "approved",
        decidedBy: "approver",
        revokedBy: null,
        consumedBy: null,
      });
      await expect(port.decide(request, "approver", "denied")).rejects.toThrow(
        "Approval persistence unavailable",
      );
      for (const changed of [
        { argumentsHash: "c".repeat(64) },
        { effectHash: "c".repeat(64) },
        { principalId: "approver" },
        { approverPrincipalId: "principal-j-a" },
        { expiresAt: pending.createdAt },
        { spaceId: "foreign" },
        { effectId: "other" },
        { expirySeconds: 601 },
      ]) {
        expect(
          await port.consume({ ...request, expiresAt: pending.expiresAt, ...changed }),
        ).toEqual({ consumed: false, approval: approved });
      }
      for (const changed of [
        { tenantId: "tenant-j-b" },
        { worldId: "world-j-b" },
        { timelineId: "timeline-j-b" },
      ]) {
        expect(await port.read({ ...request, ...changed })).toBeNull();
        expect(
          await port.consume({ ...request, expiresAt: pending.expiresAt, ...changed }),
        ).toEqual({ consumed: false, approval: null });
      }
      await expect(
        withClientTransaction(clients[0]!, {}, async () => {
          expect(
            (await port.consumeInTransaction({ ...request, expiresAt: pending.expiresAt }))
              .consumed,
          ).toBe(true);
          throw new Error("dispatch rollback");
        }),
      ).rejects.toThrow("dispatch rollback");
      expect((await port.read(request))?.state).toBe("approved");
      const consumed = await Promise.all(
        ports.map((adapter) => adapter.consume({ ...request, expiresAt: pending.expiresAt })),
      );
      expect(consumed.map((value) => value.consumed).sort()).toEqual([false, true]);
      const record = (await port.read(request))!;
      expect(record).toMatchObject({
        state: "consumed",
        decision: "approved",
        decidedBy: "approver",
        decidedAt: approved.decidedAt,
        consumedBy: "principal-j-a",
      });
      await clients[1]!.close();
      const restarted = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        const recovered = new PostgreSqlEffectApprovals(restarted);
        expect(await recovered.read(request)).toEqual(record);
        expect(await recovered.consume({ ...request, expiresAt: pending.expiresAt })).toEqual({
          consumed: false,
          approval: record,
        });
      } finally {
        await restarted.close();
      }
      expect(await port.decide(request, "approver", "approved")).toEqual(record);
      await expect(port.revoke(request, "approver")).rejects.toThrow(
        "Approval persistence unavailable",
      );
      const deniedRequest = { ...request, approvalId: "denied" };
      await port.request(deniedRequest);
      const denied = await port.decide(deniedRequest, "approver", "denied");
      expect(await port.consume({ ...deniedRequest, expiresAt: denied.expiresAt })).toEqual({
        consumed: false,
        approval: denied,
      });
      await expect(port.decide(deniedRequest, "approver", "approved")).rejects.toThrow(
        "Approval persistence unavailable",
      );
      const revokedRequest = { ...request, approvalId: "revoked" };
      await port.request(revokedRequest);
      const before = await port.decide(revokedRequest, "approver", "approved");
      const revoked = await port.revoke(revokedRequest, "approver");
      expect(revoked).toMatchObject({
        state: "revoked",
        decision: "approved",
        decidedBy: "approver",
        decidedAt: before.decidedAt,
        revokedBy: "approver",
      });
      expect(await port.revoke(revokedRequest, "approver")).toEqual(revoked);
      expect(await port.consume({ ...revokedRequest, expiresAt: revoked.expiresAt })).toEqual({
        consumed: false,
        approval: revoked,
      });
      const expiring = { ...request, approvalId: "expired", expirySeconds: 1 };
      await port.request(expiring);
      const expiringApproved = await port.decide(expiring, "approver", "approved");
      await clients[0]!.query("BEGIN");
      await clients[0]!.query(
        "SELECT 1 FROM clockgrove.effect_approvals WHERE approval_id='expired' FOR UPDATE",
      );
      const waiting = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        const afterWait = new PostgreSqlEffectApprovals(waiting).consume({
          ...expiring,
          expiresAt: expiringApproved.expiresAt,
        });
        await clients[0]!.query("SELECT pg_sleep(1.1)");
        await clients[0]!.query("COMMIT");
        expect(await afterWait).toMatchObject({
          consumed: false,
          approval: {
            state: "expired",
            decision: "approved",
            decidedAt: expiringApproved.decidedAt,
          },
        });
      } finally {
        await waiting.close();
      }
      expect((await port.request(expiring)).state).toBe("expired");
      const preview = { ...request, approvalId: "preview", timelineId: "approval-preview" };
      // The SQL attack fixture rolls its preview scope back; create a fresh branch for this proof.
      await psqlQuery(
        fixture.tools,
        fixture.environment,
        `INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES ('tenant-j-a','world-j-a','approval-preview','branch'); INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES ('tenant-j-a','world-j-a','approval-preview','preview','space-j-a');`,
      );
      await psqlQuery(
        fixture.tools,
        fixture.environment,
        `
        INSERT INTO clockgrove.artifact_data_keys(tenant_id,world_id,privacy_class,key_version,kek_id,wrapped_key)
        VALUES ('tenant-j-a','world-j-a','conversation',1,'fixture',decode(repeat('01',61),'hex'));
        INSERT INTO clockgrove.artifact_references(tenant_id,world_id,timeline_id,partition_id,space_id,artifact_id,content_hash,media_type,inline_content,byte_length,privacy_class,retention_class,encryption,data_key_version)
        SELECT 'tenant-j-a','world-j-a',timeline_id,partition_id,'space-j-a',artifact_id,
          'sha256:'||encode(sha256(decode(repeat('01',32),'hex')),'hex'),'application/json',decode(repeat('01',32),'hex'),32,'conversation','durable','aes-256-gcm-v1',1
        FROM (VALUES ('timeline-j-a','partition-j-a','valid-artifact'),('approval-preview','preview','foreign-artifact')) v(timeline_id,partition_id,artifact_id);`,
      );
      const withArtifact = {
        ...request,
        approvalId: "encrypted",
        argumentsArtifactId: "valid-artifact",
      };
      expect(await port.request(withArtifact)).toMatchObject({
        argumentsArtifactId: "valid-artifact",
        state: "pending",
      });
      await expect(
        port.request({
          ...request,
          approvalId: "foreign-artifact",
          argumentsArtifactId: "foreign-artifact",
        }),
      ).rejects.toThrow("Approval persistence unavailable");
      await port.request(preview);
      await expect(port.decide(preview, "approver", "approved")).rejects.toThrow(
        "Approval persistence unavailable",
      );
      await expect(
        port.request({ ...request, approvalId: "artifact", argumentsArtifactId: "missing" }),
      ).rejects.toThrow("Approval persistence unavailable");
      expect(
        (
          await psqlQuery(
            fixture.tools,
            fixture.environment,
            "SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects';",
          )
        ).trim(),
      ).toBe("0");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
