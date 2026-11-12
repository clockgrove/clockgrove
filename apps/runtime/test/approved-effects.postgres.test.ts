import { expect, it } from "vitest";
import {
  type ApprovedEffectRequest,
  approvedEffectHash,
  approvedEffectIdempotencyKey,
  PostgreSqlApprovedEffects,
} from "../../../packages/persistence/src/postgres-approved-effects.js";
import { PostgreSqlEffectApprovals } from "../../../packages/persistence/src/postgres-effect-approvals.js";
import { PostgreSqlEffects } from "../../../packages/persistence/src/postgres-effects.js";
import { withClientTransaction } from "../../../packages/persistence/src/postgres-transaction.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("atomically binds one approval to one exact outbox effect and recovers without redispatch", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = (query: string) => psqlQuery(fixture.tools, fixture.environment, query);
    const clients = [0, 1].map(() =>
      connect(fixture.environment, "clockgrove", "clockgrove_admin"),
    );
    const ports = clients.map((client) => new PostgreSqlApprovedEffects(client));
    const approvals = new PostgreSqlEffectApprovals(clients[0]!);
    const scope = { tenantId: "tenant-a", worldId: "world-a", timelineId: "timeline-a" };
    const create = async (
      id: string,
      expirySeconds = 600,
      eventId = "event-a-private",
    ): Promise<ApprovedEffectRequest> => {
      const address = { ...scope, approvalId: id };
      const reservation = {
        ...scope,
        spaceId: "space-a",
        effectId: id,
        idempotencyKey: approvedEffectIdempotencyKey(address),
        actorId: "actor",
        principalId: "principal-a",
        runId: null,
        callId: id,
        capabilityId: "fixture-write",
        grantId: "grant",
        policyVersion: "policy",
        argumentsHash: (
          await sql(`SELECT encode(sha256(convert_to('{"q":"write"}','UTF8')),'hex')`)
        ).trim(),
        argumentsArtifactId: null,
        reservedMicrousd: 100,
        disposition: "pending" as const,
        eventId,
        dispatchId: `dispatch-${id}`,
      };
      const pending = await approvals.request({
        ...address,
        spaceId: reservation.spaceId,
        effectId: id,
        principalId: "principal-a",
        approverPrincipalId: "principal-a",
        argumentsHash: reservation.argumentsHash,
        effectHash: approvedEffectHash(reservation),
        argumentsArtifactId: null,
        expirySeconds,
      });
      return { reservation, arguments: { q: "write" }, approval: { ...pending } };
    };
    const counts = async () =>
      (
        await sql(`SELECT (SELECT count(*) FROM clockgrove.effect_intents)||','||
      (SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects')`)
      ).trim();
    const rejected = (request: ApprovedEffectRequest) =>
      expect(ports[0]!.reserve(request)).rejects.toThrow("Approved effect persistence unavailable");
    try {
      const request = await create("approved");
      await rejected(request);
      expect(await counts()).toBe("0,0");
      expect((await approvals.read(request.approval))?.state).toBe("pending");
      await approvals.decide(request.approval, "principal-a", "approved");
      const keyJson =
        '{"approvalId":"approved","kind":"effect_approval","tenantId":"tenant-a","timelineId":"timeline-a","version":1,"worldId":"world-a"}';
      expect(request.reservation.idempotencyKey).toBe(
        (await sql(`SELECT encode(sha256(convert_to('${keyJson}','UTF8')),'hex')`)).trim(),
      );
      const effectJson = JSON.stringify(
        Object.fromEntries(
          Object.entries({ version: 1, ...request.reservation }).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      );
      expect(request.approval.effectHash).toBe(
        (await sql(`SELECT encode(sha256(convert_to('${effectJson}','UTF8')),'hex')`)).trim(),
      );
      await rejected({ ...request, arguments: { q: "changed" } });
      await rejected({
        ...request,
        reservation: { ...request.reservation, principalId: "principal-b" },
      });
      await rejected({
        ...request,
        reservation: { ...request.reservation, dispatchId: "changed" },
      });
      await rejected({ ...request, approval: { ...request.approval, expiresAt: "invalid" } });
      await expect(
        withClientTransaction(clients[0]!, {}, async () => {
          await ports[0]!.reserveInTransaction(request);
          throw new Error("caller admission rollback");
        }),
      ).rejects.toThrow("caller admission rollback");
      expect(await counts()).toBe("0,0");
      expect((await approvals.read(request.approval))?.state).toBe("approved");
      const invalid = await create("bad-outbox", 600, "missing-event");
      // A matching approval cannot make an invalid outbox commit; consumption must roll back.
      await approvals.decide(invalid.approval, "principal-a", "approved");
      await rejected(invalid);
      expect((await approvals.read(invalid.approval))?.state).toBe("approved");
      expect(await counts()).toBe("0,0");
      const raced = await Promise.all(ports.map((port) => port.reserve(request)));
      expect(raced[0]).toEqual(raced[1]);
      expect(raced[0]?.disposition).toBe("pending");
      expect(await counts()).toBe("1,1");
      const effects = new PostgreSqlEffects(clients[0]!);
      await effects.claim(request.reservation, "attempt");
      const uncertain = await effects.complete(request.reservation, "attempt", {
        disposition: "uncertain",
        outcomeCode: "reply_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
      expect(await ports[1]!.reserve(request)).toEqual(uncertain);
      const duplicate = await approvals.request({ ...request.approval, approvalId: "unrelated" });
      await approvals.decide(duplicate, "principal-a", "approved");
      await rejected({ ...request, approval: duplicate });
      expect((await approvals.read(duplicate))?.state).toBe("approved");
      await approvals.consume({ ...duplicate });
      await rejected({ ...request, approval: duplicate });
      const restarted = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        expect(await new PostgreSqlApprovedEffects(restarted).reserve(request)).toEqual(uncertain);
      } finally {
        await restarted.close();
      }
      expect(await counts()).toBe("1,1");
      for (const state of ["denied", "revoked", "expired"] as const) {
        const held = await create(state, state === "expired" ? 1 : 600);
        await approvals.decide(
          held.approval,
          "principal-a",
          state === "denied" ? "denied" : "approved",
        );
        if (state === "revoked") await approvals.revoke(held.approval, "principal-a");
        if (state === "expired") await sql("SELECT pg_sleep(1.1)");
        await rejected(held);
        expect(await counts()).toBe("1,1");
      }
      await sql(`INSERT INTO clockgrove.timelines(tenant_id,world_id,timeline_id,kind) VALUES ('tenant-a','world-a','preview','branch');
        INSERT INTO clockgrove.timeline_partitions(tenant_id,world_id,timeline_id,partition_id,space_id) VALUES ('tenant-a','world-a','preview','preview','space-a')`);
      const previewAddress = { ...request.approval, timelineId: "preview" };
      const previewReservation = {
        ...request.reservation,
        timelineId: "preview",
        idempotencyKey: approvedEffectIdempotencyKey(previewAddress),
      };
      const preview = await approvals.request({
        ...previewAddress,
        effectHash: approvedEffectHash(previewReservation),
      });
      await rejected({ ...request, reservation: previewReservation, approval: preview });
      expect((await approvals.read(preview))?.state).toBe("pending");
      expect(await counts()).toBe("1,1");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
