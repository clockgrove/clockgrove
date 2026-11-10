import {
  type McpDiscoverySnapshot,
  type McpInstallationChange,
  mcpInstallationRequest,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  encodeRequest,
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

it("journals scoped operator MCP review, schema and protocol drift, and irreversible revocation", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    const sql = async (q: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, q)).trim();
    await sql(`INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
    VALUES('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','member-a','persona-a',ARRAY['owner'],ARRAY['runtime:world-operate'],'{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());`);
    const authorization: RuntimeAuthorizationContext = {
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
    const store = new PostgreSqlMcpInstallations(client);
    let n = 0;
    const change = (op: McpInstallationChange, auth = authorization, route = scope) =>
      store.change(auth, route, op, `mcp-${++n}`, "2026-11-09T00:00:00.000Z");
    const snapshot: McpDiscoverySnapshot = {
      protocolVersion: "2025-11-25",
      serverIdentity: { name: "fixture-server", version: "1" },
      protocolMetadata: { tools: {}, resources: {}, prompts: {} },
      candidates: ["one", "two", "resource", "prompt"].map((id, i) => ({
        id,
        kind: i < 2 ? "tool" : i === 2 ? "resource" : "prompt",
        schema: { type: "object", minimum: 0.5 },
        schemaHash: (i + 1).toString().repeat(64),
        metadata: { description: "untrusted instructions" },
        enabled: false,
        effectClass: "external-write",
      })),
    };
    const install = {
      action: "install",
      installationId: "installation",
      url: "https://fixture.invalid/mcp",
      snapshot,
    } as const;
    try {
      await change(install);
      await store.change(authorization, scope, install, "mcp-1", "2026-11-09T00:00:00.000Z");
      expect((await store.read(authorization, scope, "installation"))?.revision).toBe("1");
      await expect(
        store.change(
          authorization,
          scope,
          { ...install, url: "https://other.invalid/mcp" },
          "mcp-1",
          "2026-11-09T00:00:00.000Z",
        ),
      ).rejects.toMatchObject({ code: "CG001" });
      const hostile = JSON.parse(
        encodeRequest(
          mcpInstallationRequest(
            authorization,
            scope,
            { action: "disable", installationId: "installation" },
            "hostile",
            "2026-11-09T00:00:00.000Z",
            {
              membershipId: "member-a",
              personaId: "persona-a",
              roles: ["owner"],
              grants: ["runtime:world-operate", "runtime:mcp-install"],
              simulationTime: "0",
            },
          ),
        ),
      );
      for (const mutation of [
        { state: { document: [] } },
        { events: [{ ...hostile.events[0], payload: { installationId: "installation" } }] },
        {
          attribution: { ...hostile.attribution, effectiveActorId: "another-actor" },
          events: [
            {
              ...hostile.events[0],
              attribution: { ...hostile.events[0].attribution, effectiveActorId: "another-actor" },
            },
          ],
          authorityDecision: {
            ...hostile.authorityDecision,
            attribution: {
              ...hostile.authorityDecision.attribution,
              effectiveActorId: "another-actor",
            },
          },
        },
      ]) {
        const request = { ...hostile, ...mutation };
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            type: "McpInstallationChange",
            commandId: "hostile",
            target: request.target,
            expected: {},
            attribution: request.attribution,
            payload: request.events[0].payload,
          }),
        );
        await expect(
          withClientTransaction(client, { authorization }, () =>
            client.query("SELECT clockgrove.change_mcp_installation($1::bytea,$2::jsonb)", [
              bytes,
              JSON.stringify(request),
            ]),
          ),
        ).rejects.toMatchObject({ code: "22023" });
      }
      expect((await store.read(authorization, scope, "installation"))?.status).toBe("active");
      expect((await store.read(authorization, scope, "installation"))?.reviews).toEqual({});
      await expect(
        change({
          ...install,
          installationId: "untrusted-hints",
          snapshot: {
            ...snapshot,
            candidates: snapshot.candidates.map((candidate) => ({
              ...candidate,
              enabled: true,
              effectClass: "read",
            })),
          } as unknown as McpDiscoverySnapshot,
        }),
      ).rejects.toMatchObject({ code: "22023" });
      expect(await store.read(authorization, scope, "untrusted-hints")).toBeUndefined();
      const review = (id: string, hash: string) =>
        change({
          action: "review",
          installationId: "installation",
          candidateId: id,
          schemaHash: hash,
          protocolVersion: snapshot.protocolVersion,
          effectClass: "read",
          enabled: true,
        });
      await review("one", "1".repeat(64));
      await review("two", "2".repeat(64));
      expect((await store.read(authorization, scope, "installation"))?.reviews).toMatchObject({
        one: { enabled: true, effectClass: "read", reviewer: "principal-j-a" },
        two: { enabled: true },
      });
      await expect(review("resource", "3".repeat(64))).rejects.toMatchObject({ code: "22023" });
      const changed = {
        ...snapshot,
        candidates: snapshot.candidates.map((c) =>
          c.id === "one"
            ? {
                ...c,
                schema: { type: "object", properties: { newField: { type: "string" } } },
                schemaHash: "5".repeat(64),
              }
            : c,
        ),
      };
      await change({ action: "refresh", installationId: "installation", snapshot: changed });
      expect((await store.read(authorization, scope, "installation"))?.reviews).toEqual({
        two: {
          schemaHash: "2".repeat(64),
          protocolVersion: "2025-11-25",
          effectClass: "read",
          enabled: true,
          reviewer: "principal-j-a",
        },
      });
      expect((await store.read(authorization, scope, "installation"))?.drifted).toEqual(["one"]);
      await expect(review("one", "1".repeat(64))).rejects.toMatchObject({ code: "22023" });
      await review("one", "5".repeat(64));
      // Even forged unchanged hashes cannot preserve review after an actual schema change.
      await change({
        action: "refresh",
        installationId: "installation",
        snapshot: {
          ...changed,
          candidates: changed.candidates.map((c) =>
            c.id === "one"
              ? { ...c, schema: { type: "object", properties: { other: { type: "number" } } } }
              : c,
          ),
        },
      });
      expect((await store.read(authorization, scope, "installation"))?.reviews).not.toHaveProperty(
        "one",
      );
      await change({
        action: "refresh",
        installationId: "installation",
        snapshot: { ...snapshot, protocolVersion: "different" as "2025-11-25" },
      });
      expect((await store.read(authorization, scope, "installation"))?.reviews).toEqual({});
      const foreign = {
        ...authorization,
        tenantId: decodeOpaqueId("tenant-j-b", "TenantId"),
        principalId: decodeOpaqueId("principal-j-b", "PrincipalId"),
      };
      expect(await store.read(foreign, scope, "installation")).toBeUndefined();
      expect(
        await store.read(authorization, { ...scope, timelineId: "foreign" }, "installation"),
      ).toBeUndefined();
      await expect(
        change({ action: "revoke", installationId: "installation" }, foreign),
      ).rejects.toThrow("MCP installation authority required");
      await sql(
        "UPDATE clockgrove.world_memberships SET roles='{}' WHERE principal_id='principal-j-a'",
      );
      await expect(change({ action: "revoke", installationId: "installation" })).rejects.toThrow(
        "MCP installation authority required",
      );
      await sql(
        "UPDATE clockgrove.world_memberships SET grants=ARRAY['runtime:mcp-install'],roles=ARRAY['actor'] WHERE principal_id='principal-j-a'",
      );
      await expect(change({ action: "revoke", installationId: "installation" })).rejects.toThrow(
        "MCP installation authority required",
      );
      await sql(
        "UPDATE clockgrove.world_memberships SET roles='{}' WHERE principal_id='principal-j-a'",
      );
      await change({ action: "revoke", installationId: "installation" });
      expect((await store.read(authorization, scope, "installation"))?.status).toBe("revoked");
      await expect(
        change({ action: "refresh", installationId: "installation", snapshot }),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        await sql(
          "SELECT count(*) FROM clockgrove.events WHERE event_type='McpInstallationChanged'",
        ),
      ).toBe("8");
      expect(
        await sql(
          "SELECT count(*) FROM clockgrove.events WHERE event_type='McpInstallationChanged' AND attribution->>'principalId'='principal-j-a' AND attribution->>'personaId'='persona-a' AND privacy_class='operator_evidence'",
        ),
      ).toBe("8");
      expect(
        await sql(
          "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%untrusted instructions%'",
        ),
      ).toBe("4");
    } finally {
      await client.close();
    }
  });
}, 30_000);
