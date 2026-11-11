import { readFile } from "node:fs/promises";
import {
  type McpBinding,
  type McpDiscoverySnapshot,
  type McpRegistryContext,
  type McpRegistryInstallation,
  type RuntimeAuthorizationContext,
  resolveMcpCapabilityRegistry,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  PostgreSqlMcpBindings,
  PostgreSqlMcpInstallations,
  withClientTransaction,
} from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("journals exact-pin scoped MCP policy and rejects self-grants, stale pins and cross-scope access", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/seed.sql");
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/hostile-fixture.sql");
    await psqlQuery(
      fixture.tools,
      { ...fixture.environment, PGUSER: "clockgrove_runtime" },
      await readFile(new URL("../../../tests/database/authorization.sql", import.meta.url), "utf8"),
      { viaStdin: true },
    );
    const sql = async (q: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, q)).trim();
    await sql(`INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
      VALUES('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','member-a','persona-a',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());`);
    const auth: RuntimeAuthorizationContext = {
      tenantId: decodeOpaqueId("tenant-j-a", "TenantId"),
      principalId: decodeOpaqueId("principal-j-a", "PrincipalId"),
      privacyCeiling: decodePrivacyCeiling({
        version: 1,
        allowedCategories: ["operator_evidence"],
      }),
    };
    const scope = {
      worldId: "world-j-a",
      timelineId: "timeline-j-a",
      spaceId: "space-j-a",
      partitionId: "partition-j-a",
      streamId: "stream-j-a",
    };
    const client = connect(fixture.environment, "clockgrove", "clockgrove_runtime");
    const installations = new PostgreSqlMcpInstallations(client);
    const bindings = new PostgreSqlMcpBindings(client);
    const context = {
      tenantId: auth.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      actorId: "fixture-actor",
      sessionId: "fixture-session",
      runtimeGrants: [],
    };
    let now = Date.parse("2026-11-10T00:00:00.000Z");
    const resolve = async (
      actorId = context.actorId,
      overrides: Partial<McpRegistryContext> = {},
    ) => {
      const row = await installations.read(auth, scope, "installation");
      const scoped = await bindings.list(auth, scope, "installation");
      const installation = {
        ...row,
        installationId: "installation",
        tenantId: auth.tenantId,
        worldId: scope.worldId,
        timelineId: scope.timelineId,
      } as unknown as McpRegistryInstallation;
      return resolveMcpCapabilityRegistry(
        [installation],
        scoped,
        { ...context, actorId, ...overrides },
        () => now,
      );
    };
    const remoteName = `mcp:installation:lookup:2025-11-25:${"1".repeat(64)}`;
    const usage = {
      destination: "https://destination.example/",
      estimatedCostMicrousd: 20,
      spentMicrousd: 10,
    };
    const issued = "2026-11-09T00:00:00.000Z";
    let n = 0;
    const bind = (binding: McpBinding, authorization = auth, route = scope) =>
      bindings.change(authorization, route, binding, `binding-${++n}`, issued);
    const snapshot: McpDiscoverySnapshot = {
      protocolVersion: "2025-11-25",
      serverIdentity: { name: "fixture-server", version: "1" },
      protocolMetadata: { tools: {} },
      candidates: [
        {
          kind: "tool",
          id: "lookup",
          schemaHash: "1".repeat(64),
          schema: { type: "object", properties: { query: { type: "string" } } },
          metadata: { readOnlyHint: true },
          enabled: false,
          effectClass: "external-write",
        },
      ],
    };
    const policy: McpBinding = {
      bindingId: "actor-policy",
      installationId: "installation",
      candidateId: "lookup",
      schemaHash: "1".repeat(64),
      protocolVersion: "2025-11-25",
      scopeType: "actor",
      scopeId: "fixture-actor",
      effect: "allow",
      enabled: true,
      constraints: {
        inputFields: ["query"],
        destinations: ["https://destination.example/"],
        callsPerTurn: 2,
        effectClasses: ["read"],
        budgetMicrousd: 50,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    };
    try {
      await installations.change(
        auth,
        scope,
        {
          action: "install",
          installationId: "installation",
          url: "https://fixture.invalid/mcp",
          snapshot,
        },
        "binding-install",
        issued,
      );
      expect((await resolve()).grants.available()).toEqual([]);
      await expect(bind(policy)).rejects.toMatchObject({ code: "22023" });
      await installations.change(
        auth,
        scope,
        {
          action: "review",
          installationId: "installation",
          candidateId: "lookup",
          schemaHash: "1".repeat(64),
          protocolVersion: "2025-11-25",
          effectClass: "read",
          enabled: true,
        },
        "binding-review",
        issued,
      );
      const mutablePolicy = { ...policy, constraints: { ...policy.constraints } };
      const mutableAuth = {
        ...auth,
        privacyCeiling: {
          ...auth.privacyCeiling,
          allowedCategories: [...auth.privacyCeiling.allowedCategories],
        },
      };
      const mutableScope = { ...scope };
      const pendingBinding = bindings.change(
        mutableAuth,
        mutableScope,
        mutablePolicy,
        "binding-first",
        issued,
      );
      mutablePolicy.constraints.callsPerTurn = 99;
      mutableAuth.tenantId = decodeOpaqueId("tenant-j-b", "TenantId");
      mutableAuth.privacyCeiling.allowedCategories.length = 0;
      mutableScope.worldId = "foreign-world";
      const receipt = await pendingBinding;
      expect(await bindings.change(auth, scope, policy, "binding-first", issued)).toEqual(receipt);
      expect(await bindings.list(auth, scope, "installation")).toEqual([
        {
          ...policy,
          tenantId: auth.tenantId,
          worldId: scope.worldId,
          timelineId: scope.timelineId,
        },
      ]);
      expect((await installations.read(auth, scope, "installation"))?.revision).toBe("3");
      const admitted = await resolve();
      expect(admitted.registry.names()).toEqual(["inspect", remoteName, "why", "world.command"]);
      expect(admitted.grants.available()).toEqual([remoteName]);
      expect(admitted.registry.get(remoteName)?.effect).toBe("read");
      expect(
        admitted.grants.authorize(
          { capability: remoteName, input: { query: "value" } },
          new Map(),
          usage,
        ).accepted,
      ).toBe(true);
      expect(
        admitted.grants.authorize(
          { capability: remoteName, input: { query: 3 } },
          new Map(),
          usage,
        ),
      ).toEqual({ accepted: false, code: "invalid_input" });
      expect(
        admitted.grants.authorize(
          { capability: remoteName, input: { query: "value", extra: true } },
          new Map(),
          usage,
        ),
      ).toEqual({ accepted: false, code: "constraint_refused" });
      expect(
        admitted.grants.authorize(
          { capability: remoteName, input: {} },
          new Map([[remoteName, 2]]),
          usage,
        ),
      ).toEqual({ accepted: false, code: "budget_exhausted" });
      expect(
        admitted.grants.authorize({ capability: remoteName, input: {} }, new Map(), {
          ...usage,
          destination: "https://other.example/",
        }),
      ).toEqual({ accepted: false, code: "constraint_refused" });
      expect(
        admitted.grants.authorize({ capability: remoteName, input: {} }, new Map(), {
          ...usage,
          estimatedCostMicrousd: 41,
        }),
      ).toEqual({ accepted: false, code: "constraint_refused" });
      expect((await resolve("other-actor")).grants.available()).toEqual([]);
      expect(
        (await resolve(context.actorId, { tenantId: "foreign-tenant" })).grants.available(),
      ).toEqual([]);
      const overlay = await resolve(context.actorId, {
        sessionApproval: { ...policy.constraints, inputFields: [] },
      });
      expect(
        overlay.grants.authorize(
          { capability: remoteName, input: { query: "value" } },
          new Map(),
          usage,
        ),
      ).toEqual({ accepted: false, code: "constraint_refused" });
      expect(
        (
          await resolve(context.actorId, {
            sessionApproval: { ...policy.constraints, effectClasses: ["external-write"] },
          })
        ).grants.available(),
      ).toEqual([]);
      now = Date.parse("2027-01-01T00:00:00.000Z");
      expect(admitted.grants.available()).toEqual([]);
      expect(
        admitted.grants.authorize({ capability: remoteName, input: {} }, new Map(), usage),
      ).toEqual({ accepted: false, code: "revoked" });
      now = Date.parse("2026-11-10T00:00:00.000Z");
      await expect(
        bindings.change(
          auth,
          scope,
          { ...policy, constraints: { ...policy.constraints, callsPerTurn: 3 } },
          "binding-first",
          issued,
        ),
      ).rejects.toMatchObject({ code: "CG001" });
      for (const invalid of [
        { ...policy, schemaHash: "2".repeat(64) },
        { ...policy, protocolVersion: "different" },
        { ...policy, scopeType: "world", scopeId: "foreign-world" },
        { ...policy, scopeType: "timeline", scopeId: "foreign-timeline" },
        { ...policy, scopeType: "tenant", scopeId: "foreign-tenant" },
        { ...policy, scopeType: "session", scopeId: "foreign-session" },
        { ...policy, constraints: { ...policy.constraints, callsPerTurn: 0.5 } },
        { ...policy, constraints: { ...policy.constraints, effectClasses: ["external-write"] } },
        { ...policy, constraints: { ...policy.constraints, expiresAt: "infinity" } },
        {
          ...policy,
          constraints: { ...policy.constraints, destinations: ["https://user:token@example.com/"] },
        },
        { ...policy, constraints: { ...policy.constraints, unknown: "not-journal-data" } },
      ])
        await expect(bind(invalid as McpBinding)).rejects.toMatchObject({ code: "22023" });
      const foreign = {
        ...auth,
        tenantId: decodeOpaqueId("tenant-j-b", "TenantId"),
        principalId: decodeOpaqueId("principal-j-b", "PrincipalId"),
      };
      expect(await bindings.list(foreign, scope, "installation")).toEqual([]);
      expect(
        await bindings.list(auth, { ...scope, timelineId: "foreign" }, "installation"),
      ).toEqual([]);
      expect(await bindings.list(auth, { ...scope, worldId: "foreign" }, "installation")).toEqual(
        [],
      );
      await expect(bind(policy, foreign)).rejects.toThrow("MCP installation authority required");
      await sql(
        "UPDATE clockgrove.world_memberships SET roles=ARRAY['actor'],grants=ARRAY['runtime:mcp-install'] WHERE principal_id='principal-j-a'",
      );
      await expect(bind(policy)).rejects.toThrow("MCP installation authority required");
      expect(await bindings.list(auth, scope, "installation")).toEqual([]);
      await sql(
        "UPDATE clockgrove.world_memberships SET roles='{}',grants=ARRAY['runtime:world-operate'] WHERE principal_id='principal-j-a'",
      );
      await expect(bind(policy)).rejects.toThrow("MCP installation authority required");
      await sql(
        "UPDATE clockgrove.world_memberships SET roles=ARRAY['owner'] WHERE principal_id='principal-j-a'",
      );
      for (const mutation of [
        "UPDATE clockgrove.mcp_bindings SET binding='{}'",
        "DELETE FROM clockgrove.mcp_bindings",
        "TRUNCATE clockgrove.mcp_bindings",
      ])
        await expect(
          withClientTransaction(client, { authorization: auth }, () => client.query(mutation)),
        ).rejects.toMatchObject({ code: "42501" });
      await bind({
        ...policy,
        bindingId: "world-deny",
        scopeType: "world",
        scopeId: scope.worldId,
        effect: "deny",
      });
      expect(
        (await bindings.list(auth, scope, "installation")).map((b) => [b.bindingId, b.effect]),
      ).toEqual([
        ["actor-policy", "allow"],
        ["world-deny", "deny"],
      ]);
      expect((await resolve()).grants.available()).toEqual([]);
      await bind({ ...policy, enabled: false });
      expect((await resolve()).grants.available()).toEqual([]);
      expect((await bindings.list(auth, scope, "installation"))[0]?.enabled).toBe(false);
      await installations.change(
        auth,
        scope,
        { action: "revoke", installationId: "installation" },
        "binding-revoke",
        issued,
      );
      expect((await resolve()).grants.available()).toEqual([]);
      await expect(bind(policy)).rejects.toMatchObject({ code: "22023" });
      await bind({ ...policy, enabled: false });
      expect(
        await sql(
          "SELECT count(*) FROM clockgrove.events WHERE event_type='McpBindingChanged' AND attribution->>'principalId'='principal-j-a' AND attribution->>'personaId'='persona-a' AND privacy_class='operator_evidence'",
        ),
      ).toBe("4");
      expect(await sql("SELECT count(*) FROM clockgrove.mcp_bindings")).toBe("2");
    } finally {
      await client.close();
    }
  });
}, 30_000);
