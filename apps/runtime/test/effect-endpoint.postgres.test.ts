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
import { handleEffectEndpoint } from "../src/effect-endpoint.js";
import type { RuntimeAuthenticationDependencies } from "../src/trusted-composition.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("authenticates human HTTP controls and records exact decisions and operator resolutions in PostgreSQL", async () => {
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
    const withClient = async <T>(operation: (client: ReturnType<typeof connect>) => Promise<T>) => {
      const client = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        return await operation(client);
      } finally {
        await client.close();
      }
    };
    const keyring = await WebCryptoKeyring.fromJson(
      JSON.stringify({
        version: 1,
        current: "test",
        keys: { test: Buffer.alloc(32, 7).toString("base64url") },
      }),
    );
    const artifacts = (client: PostgreSqlClient) =>
      new PostgreSqlArtifactStore(client, { keyring });
    await sql(
      `UPDATE clockgrove.world_memberships SET privacy_ceiling='{"version":1,"allowedCategories":["conversation"]}' WHERE tenant_id='tenant-a'`,
    );
    const session = await withClient((client) =>
      new PostgreSqlConversationStore(client, artifacts(client), () => "http-session").open(
        person,
        { scope, actorId: decodeOpaqueId("actor", "ObjectId"), voiceMode: "cognitive" },
      ),
    );
    const otherSession = await withClient((client) =>
      new PostgreSqlConversationStore(client, artifacts(client), () => "other-http-session").open(
        person,
        { scope, actorId: decodeOpaqueId("other-actor", "ObjectId"), voiceMode: "cognitive" },
      ),
    );
    await withClient(async (client) => {
      await artifacts(client).put(person, {
        ...scope,
        partitionId: decodeOpaqueId("partition-a", "PartitionId"),
        artifactId: decodeOpaqueId("http-args", "ArtifactId"),
        bytes: new TextEncoder().encode('{"message":"exact"}'),
        mediaType: "application/json",
        privacyClass: "conversation",
        retentionClass: "durable",
      });
      await new PostgreSqlEffectApprovals(client).request({
        ...scope,
        approvalId: "http-approval",
        effectId: "http-effect",
        principalId: person.principalId,
        approverPrincipalId: person.principalId,
        argumentsHash: mcpReadArgumentsHash({ message: "exact" }),
        effectHash: "b".repeat(64),
        argumentsArtifactId: "http-args",
      });
      await client.query(
        `INSERT INTO clockgrove.effect_intents (tenant_id,world_id,timeline_id,space_id,effect_id,idempotency_key,actor_id,principal_id,call_id,capability_id,grant_id,policy_version,arguments_hash,reserved_microusd) VALUES ('tenant-a','world-a','timeline-a','space-a','uncertain','uncertain','actor','principal-a','call','fixture-write','grant','policy',repeat('a',64),0)`,
      );
      const effects = new PostgreSqlEffects(client);
      await effects.claim({ ...scope, effectId: "uncertain" }, "attempt");
      await effects.complete({ ...scope, effectId: "uncertain" }, "attempt", {
        disposition: "uncertain",
        outcomeCode: "reply_lost",
        resultArtifactId: null,
        costMicrousd: null,
      });
    });
    await sql(`INSERT INTO clockgrove.events
      (event_id,tenant_id,world_id,timeline_id,partition_id,space_id,stream_id,stream_sequence,
       partition_sequence,event_type,schema_version,simulation_time,command_id,correlation_id,
       principal_id,privacy_class,payload_hash,attribution,policy_versions,payload,event_bytes)
      VALUES ('trusted:research:uncertain:event','tenant-a','world-a','timeline-a','partition-a',
        'space-a','stream-a',3,3,'ResearchFixture',2,0,'command-a','correlation-a','principal-a',
        'conversation','hash-uncertain','{}','{}','{"sessionId":"http-session"}',
        convert_to('{"schemaVersion":2}','UTF8'))`);
    // The identity provider and exact-call port are fixtures; canonical controls/artifacts are real.
    const authentication: RuntimeAuthenticationDependencies = {
      provider: {
        authenticate: async (credential) => {
          if (credential !== "human") throw new Error();
          return { externalIdentityId: decodeOpaqueId("external-a", "ExternalIdentityId") };
        },
      },
      mapping: { resolvePrincipal: async () => person.principalId },
      workspace: { resolveWorkspace: async () => undefined },
      world: {
        resolveWorld: async (_principal, target) => ({
          ...target,
          principalId: person.principalId,
          membershipId: decodeOpaqueId("membership-a", "WorldMembershipId"),
          personaId: person.personaId,
          roles: [],
          grants: [
            decodeOpaqueId("runtime:world-observe", "GrantRef"),
            decodeOpaqueId("runtime:world-operate", "GrantRef"),
          ],
          privacyCeiling: person.privacyCeiling,
        }),
      },
      codeVersion: "test",
      requestMetadata: () => ({
        requestId: "http",
        correlationId: decodeOpaqueId("http", "CorrelationId"),
      }),
    };
    const ports = {
      authentication,
      configuration: { withClient, artifacts },
      research: {
        admitApproval: async () => ({ sessionId: session.sessionId }),
        approvalTarget: async () => null,
        retry: async () => {
          throw new Error();
        },
      },
      wake: async () => {},
    };
    const call = (action: string, body: object = {}, credential = "human") =>
      handleEffectEndpoint(
        new Request(`https://local.test/v1/runtime/effects/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({ ...scope, commandId: "http", ...body }),
        }),
        ports,
      );
    expect(
      (await call("decide", { approvalId: "http-approval", decision: "approved" }, "model-output"))
        .status,
    ).toBe(403);
    expect(
      (await call("approval", { approvalId: "http-approval", tenantId: "tenant-b" })).status,
    ).toBe(403);
    expect(
      (
        await handleEffectEndpoint(
          new Request("https://local.test/v1/runtime/effects/decide", {
            method: "POST",
            headers: {
              origin: "https://foreign.example",
              authorization: "Bearer human",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...scope,
              commandId: "foreign-origin",
              approvalId: "http-approval",
              decision: "approved",
            }),
          }),
          ports,
        )
      ).status,
    ).toBe(403);

    expect(await (await call("approval", { approvalId: "http-approval" })).json()).toMatchObject({
      arguments: { message: "exact" },
      approval: { state: "pending" },
    });
    const approved = await (
      await call("decide", {
        approvalId: "http-approval",
        decision: "approved",
        principalId: "forged",
      })
    ).json();
    expect(approved).toMatchObject({ state: "approved", decidedBy: "principal-a" });
    expect(
      await (await call("decide", { approvalId: "http-approval", decision: "approved" })).json(),
    ).toEqual(approved);
    // Canonical uncertainty is visible without any answer-model continuation or operator grant.
    expect(await (await call("uncertain", { sessionId: session.sessionId })).json()).toEqual({
      uncertain: [
        {
          effectId: "uncertain",
          callId: "call",
          principalId: "principal-a",
          attemptId: "attempt",
          outcomeCode: "reply_lost",
          completedAt: expect.any(String),
          retryAllowed: false,
        },
      ],
    });
    expect(await (await call("uncertain", { sessionId: otherSession.sessionId })).json()).toEqual({
      uncertain: [],
    });
    expect(
      (await call("uncertain", { sessionId: session.sessionId, tenantId: "tenant-b" })).status,
    ).toBe(403);
    expect((await call("uncertain")).status).toBe(403);
    expect((await call("uncertain", { sessionId: "another-session" })).status).toBe(403);
    expect(
      (await call("uncertain", { sessionId: session.sessionId, spaceId: "other-space" })).status,
    ).toBe(403);
    await sql(
      "UPDATE clockgrove.world_memberships SET grants=ARRAY['read'] WHERE tenant_id='tenant-a'",
    );
    expect((await call("uncertain", { sessionId: session.sessionId })).status).toBe(403);
    expect(
      (await call("resolve", { effectId: "uncertain", attemptId: "attempt", disposition: "done" }))
        .status,
    ).toBe(403);
    await sql(
      "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:world-operate'] WHERE tenant_id='tenant-a'",
    );
    expect(
      await (
        await call("resolve", {
          effectId: "uncertain",
          attemptId: "attempt",
          disposition: "done",
          resolvedBy: "model",
        })
      ).json(),
    ).toMatchObject({ resolvedBy: "principal-a", disposition: "done" });
    expect((await sql("SELECT count(*) FROM clockgrove.effect_resolutions")).trim()).toBe("1");
  });
});
