import { type ConversationParticipant, mcpReadArgumentsHash } from "@clockgrove/application";
import { decodeBrowserScope, decodeOpaqueId } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  type PostgreSqlClient,
  PostgreSqlConversationStore,
  PostgreSqlEffectApprovals,
  PostgreSqlEffects,
  WebCryptoKeyring,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { composeEffectControls } from "../src/effect-controls.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("reauthorizes human exact previews and decisions and operator uncertainty resolution through PostgreSQL", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    const sql = (q: string) => psqlQuery(fixture.tools, fixture.environment, q);
    const scope = decodeBrowserScope({
      tenantId: "tenant-a",
      worldId: "world-a",
      timelineId: "timeline-a",
      spaceId: "space-a",
    });
    const person: ConversationParticipant = {
      tenantId: scope.tenantId,
      principalId: decodeOpaqueId("principal-a", "PrincipalId"),
      personaId: decodeOpaqueId("persona-a", "WorldPersonaId"),
      privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
    };
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
    const artifacts = (client: PostgreSqlClient) =>
      new PostgreSqlArtifactStore(client, { keyring });
    await sql(
      `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["conversation"]}' WHERE tenant_id='tenant-a'`,
    );
    const session = await withClient((client) =>
      new PostgreSqlConversationStore(client, artifacts(client), () => "controls-session").open(
        person,
        { scope, actorId: decodeOpaqueId("actor", "ObjectId"), voiceMode: "cognitive" },
      ),
    );
    const args = { message: "exact fixture request" };
    await withClient(async (client) => {
      await artifacts(client).put(person, {
        ...scope,
        partitionId: decodeOpaqueId("partition-a", "PartitionId"),
        artifactId: decodeOpaqueId("controls-args", "ArtifactId"),
        bytes: new TextEncoder().encode(JSON.stringify(args)),
        mediaType: "application/json",
        privacyClass: "conversation",
        retentionClass: "durable",
      });
      const approvals = new PostgreSqlEffectApprovals(client);
      for (const id of ["approve", "deny", "revoke", "mismatch"])
        await approvals.request({
          ...scope,
          approvalId: id,
          effectId: id,
          principalId: person.principalId,
          approverPrincipalId: person.principalId,
          argumentsHash: id === "mismatch" ? "a".repeat(64) : mcpReadArgumentsHash(args),
          effectHash: "b".repeat(64),
          argumentsArtifactId: "controls-args",
        });
    });
    let onAuthenticate: (() => void) | undefined;
    let signedIn = true;
    let granted = true;
    let operatorRoute = false;
    const controls = composeEffectControls({
      authenticate: async () => {
        onAuthenticate?.();
        return signedIn ? person : null;
      },
      withClient,
      artifacts,
      // Internal admission port stands in for final runtime protected-call composition.
      admitCall: async (_client, auth, binding) => {
        expect(auth.principalId).toBe("principal-a");
        expect(binding.effectHash).toBe("b".repeat(64));
        return granted
          ? operatorRoute
            ? { operator: true }
            : { sessionId: session.sessionId }
          : null;
      },
    });
    const target = (approvalId: string) => ({ scope, approvalId });
    expect((await controls.approval(target("approve"))).arguments).toEqual(args);
    const mutableTarget = target("approve");
    onAuthenticate = () => {
      mutableTarget.scope = { ...scope, tenantId: decodeOpaqueId("tenant-b", "TenantId") };
    };
    expect((await controls.approval(mutableTarget)).arguments).toEqual(args);
    onAuthenticate = undefined;
    await expect(controls.approval(target("mismatch"))).rejects.toThrow();
    await expect(controls.decide(target("mismatch"), "approved")).rejects.toThrow();
    expect((await controls.decide(target("mismatch"), "denied")).state).toBe("denied");
    signedIn = false;
    await expect(controls.decide(target("approve"), "approved")).rejects.toThrow();
    signedIn = true;
    granted = false;
    await expect(controls.decide(target("approve"), "approved")).rejects.toThrow();
    granted = true;
    for (const field of ["tenantId", "worldId", "timelineId", "spaceId"] as const)
      await expect(
        controls.approval({
          approvalId: "approve",
          scope: { ...scope, [field]: decodeOpaqueId("foreign", "TenantId") },
        }),
      ).rejects.toThrow();
    const approved = await controls.decide(target("approve"), "approved");
    expect(approved).toMatchObject({ state: "approved", decidedBy: "principal-a" });
    expect(await controls.decide(target("approve"), "approved")).toEqual(approved);
    expect((await controls.decide(target("deny"), "denied")).state).toBe("denied");
    expect((await controls.revoke(target("revoke"))).state).toBe("revoked");
    await sql(
      "UPDATE clockgrove.world_memberships SET revoked_at=clock_timestamp() WHERE tenant_id='tenant-a'",
    );
    await expect(controls.decide(target("approve"), "approved")).rejects.toThrow();
    await sql("UPDATE clockgrove.world_memberships SET revoked_at=NULL WHERE tenant_id='tenant-a'");
    operatorRoute = true;
    await expect(controls.approval(target("approve"))).rejects.toThrow();
    await expect(controls.uncertain(scope)).rejects.toThrow();
    await sql(
      "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-operate'] WHERE tenant_id='tenant-a'",
    );
    expect((await controls.approval(target("approve"))).arguments).toEqual(args);
    await withClient(async (client) => {
      const effects = new PostgreSqlEffects(client);
      const address = { ...scope, effectId: "uncertain" };
      await client.query(
        `INSERT INTO clockgrove.effect_intents (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd) VALUES ('tenant-a','world-a','timeline-a','space-a','uncertain','uncertain','actor','principal-a','uncertain-call','fixture-write','grant','policy',repeat('a',64),0)`,
      );
      await effects.claim(address, "uncertain-attempt");
      await effects.complete(address, "uncertain-attempt", {
        disposition: "uncertain",
        outcomeCode: "reply_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
    });
    expect(await controls.uncertain(scope)).toEqual([
      expect.objectContaining({
        effectId: "uncertain",
        callId: "uncertain-call",
        principalId: "principal-a",
        attemptId: "uncertain-attempt",
        outcomeCode: "reply_lost",
      }),
    ]);
    await expect(
      controls.resolve(
        {
          scope: { ...scope, spaceId: decodeOpaqueId("foreign", "SpaceId") },
          effectId: "uncertain",
        },
        "uncertain-attempt",
        "done",
      ),
    ).rejects.toThrow();
    const resolved = await controls.resolve(
      { scope, effectId: "uncertain" },
      "uncertain-attempt",
      "done",
    );
    expect(resolved).toMatchObject({ disposition: "done", resolvedBy: "principal-a" });
    expect(
      await controls.resolve({ scope, effectId: "uncertain" }, "uncertain-attempt", "done"),
    ).toEqual(resolved);
    expect(await controls.uncertain(scope)).toEqual([]);
    const mutableScope = { ...scope };
    onAuthenticate = () => {
      mutableScope.tenantId = decodeOpaqueId("tenant-b", "TenantId");
    };
    expect(await controls.uncertain(mutableScope)).toEqual([]);
    onAuthenticate = undefined;
    expect(
      (
        await sql("SELECT disposition FROM clockgrove.effect_intents WHERE effect_id='uncertain'")
      ).trim(),
    ).toBe("uncertain");
    expect(
      (
        await sql(
          "SELECT count(*) FROM clockgrove.event_dispatches WHERE channel='external-effects'",
        )
      ).trim(),
    ).toBe("0");
    await sql(
      "UPDATE clockgrove.world_memberships SET grants=ARRAY[]::text[] WHERE tenant_id='tenant-a'",
    );
    await expect(
      controls.resolve({ scope, effectId: "uncertain" }, "uncertain-attempt", "done"),
    ).rejects.toThrow();
  });
});
