import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type McpDiscoverySnapshot, type McpNetworkPort } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlWorldAuthorizationReader } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local helper.
} from "../../../scripts/database/lib.mjs";
import { composeMcpOperator } from "../src/mcp-composition.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { RuntimeWorker } from "../src/worker.js";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("authenticates HTTP MCP install, OAuth callback, review, bind, refresh and revoke through PostgreSQL without exposing credentials", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    const sql = async (q: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, q)).trim();
    await sql(`INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
      VALUES('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','member-a','persona-a',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());`);
    const canary = "runtime-secret-canary";
    let changedSchema = false;
    let releaseDiscovery: (() => void) | undefined;
    let discoveryStarted: (() => void) | undefined;
    let holdDiscovery: Promise<void> | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const path = request.url!;
      let result: unknown;
      if (path.startsWith("/.well-known/oauth-protected-resource/"))
        result = {
          resource: "https://fixture.example/oauth",
          authorization_servers: ["https://fixture.example/issuer"],
        };
      else if (path === "/.well-known/oauth-authorization-server/issuer")
        result = {
          issuer: "https://fixture.example/issuer",
          authorization_endpoint: "https://fixture.example/authorize",
          token_endpoint: "https://fixture.example/token",
          revocation_endpoint: "https://fixture.example/revoke",
          code_challenge_methods_supported: ["S256"],
        };
      else if (path === "/token")
        result = {
          token_type: "Bearer",
          access_token: canary,
          refresh_token: canary,
          expires_in: 3600,
        };
      else if (path === "/revoke") {
        response.writeHead(200);
        response.end();
        return;
      } else {
        if (path !== "/anonymous" && request.headers.authorization !== `Bearer ${canary}`) {
          response.writeHead(401);
          response.end();
          return;
        }
        const rpc = JSON.parse(body);
        if (path === "/oauth" && rpc.method === "initialize" && holdDiscovery) {
          discoveryStarted?.();
          await holdDiscovery;
        }
        if (rpc.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        result = {
          jsonrpc: "2.0",
          id: rpc.id,
          result:
            rpc.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  serverInfo: { name: "fixture", version: "1" },
                  capabilities: { tools: {} },
                }
              : {
                  tools: [
                    {
                      name: "lookup",
                      inputSchema: {
                        type: "object",
                        properties: changedSchema ? { query: { type: "string" } } : {},
                      },
                    },
                  ],
                },
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const network: McpNetworkPort = {
      resolve: async () => ["93.184.216.34"],
      request: (url, init) => fetch(`${origin}${new URL(url).pathname}`, init),
    };
    const withClient = async <T>(operation: (client: ReturnType<typeof connect>) => Promise<T>) => {
      const client = connect(fixture.environment, "clockgrove", "clockgrove_runtime");
      try {
        return await operation(client);
      } finally {
        await client.close();
      }
    };
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(4), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    expect(() =>
      composeMcpOperator({
        environment: "production",
        runtimeDatabaseUrl: "runtime",
        withClient,
        openSecretClient: () => {
          throw new Error("hosted provider must stay closed");
        },
        secretDatabaseUrl: "secrets",
        credentialKeyring: { activeVersion: "v1", keys: new Map([["v1", key]]) },
        network,
        oauthClient: () => {
          throw new Error("unused");
        },
        maxInstallations: 1,
        changed: async () => undefined,
      }),
    ).toThrow("MCP hosted activation pending issue 3");
    let revisions = 0;
    const operator = composeMcpOperator({
      environment: "local",
      runtimeDatabaseUrl: "runtime",
      secretDatabaseUrl: "secrets",
      credentialKeyring: { activeVersion: "v1", keys: new Map([["v1", key]]) },
      withClient,
      network,
      maxInstallations: 4,
      changed: async () => {
        revisions++;
      },
      oauthClient: (url) => ({
        clientId: "fixture",
        issuer: "https://fixture.example/issuer",
        resource: url,
        redirectUri: "https://operator.example/callback",
        scopes: ["lookup"],
      }),
      openSecretClient: () => {
        const secret = connect(fixture.environment, "clockgrove", "clockgrove_admin");
        const ready = secret.query("SET ROLE clockgrove_mcp_secrets");
        return {
          query: async (sql, values) => {
            await ready;
            return secret.query(sql, values);
          },
          close: () => secret.close(),
        };
      },
    });
    const auth = new TrustedRuntimeRequestAuthenticator({
      provider: {
        authenticate: async (token) => {
          if (token !== "session") throw new Error("invalid session");
          return {
            provider: "fixture",
            environment: "local",
            subject: "owner",
            externalIdentityId: decodeOpaqueId("fixture-identity", "ExternalIdentityId"),
          };
        },
      },
      mapping: { resolvePrincipal: async () => decodeOpaqueId("principal-j-a", "PrincipalId") },
      workspace: { resolveWorkspace: async () => undefined },
      world: {
        resolveWorld: async (principal, scope) => {
          const client = connect(fixture.environment, "clockgrove", "clockgrove_world_reader");
          try {
            return await new PostgreSqlWorldAuthorizationReader(client).resolveWorld(
              principal,
              scope,
            );
          } finally {
            await client.close();
          }
        },
      },
      codeVersion: "fixture",
      requestMetadata: () => ({
        requestId: crypto.randomUUID(),
        correlationId: decodeOpaqueId(crypto.randomUUID(), "CorrelationId"),
      }),
    });
    const logs: unknown[] = [];
    const worker = new RuntimeWorker(
      auth,
      {
        mcp: operator,
        getSpace: () => {
          throw new Error("unexpected owner");
        },
      },
      { log: (record) => logs.push(record) },
    );
    let command = 0;
    const outputs: unknown[] = [];
    const post = async (action: string, fields: object = {}, authenticated = true) => {
      const response = await worker.fetch(
        new Request(`https://operator.example/v1/runtime/mcp/${action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authenticated ? { authorization: "Bearer session" } : {}),
          },
          body: JSON.stringify({
            tenantId: "tenant-j-a",
            worldId: "world-j-a",
            timelineId: "timeline-j-a",
            spaceId: "space-j-a",
            commandId: `runtime-mcp-${++command}`,
            ...fields,
          }),
        }),
      );
      const body = await response.json();
      outputs.push(body);
      return { status: response.status, body };
    };
    try {
      expect(
        (
          await post(
            "connect-static",
            { installationId: "denied", url: "https://fixture.example/static", token: canary },
            false,
          )
        ).status,
      ).toBe(401);
      expect(
        await post("connect-static", {
          installationId: "static",
          url: "https://fixture.example/static",
          token: canary,
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      const listed = await post("list");
      expect(listed.status).toBe(200);
      const row = (listed.body as { installations: { snapshot: McpDiscoverySnapshot }[] })
        .installations[0]!;
      const candidate = row.snapshot.candidates[0]!;
      expect(
        await post("review", {
          installationId: "static",
          candidateId: candidate.id,
          schemaHash: candidate.schemaHash,
          protocolVersion: "2025-11-25",
          effectClass: "read",
          enabled: true,
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(
        (
          await post("bind", {
            installationId: "static",
            binding: {
              bindingId: "binding",
              installationId: "static",
              candidateId: candidate.id,
              schemaHash: candidate.schemaHash,
              protocolVersion: "2025-11-25",
              scopeType: "world",
              scopeId: "world-j-a",
              effect: "allow",
              enabled: true,
              constraints: { callsPerTurn: 1, effectClasses: ["read"] },
            },
          })
        ).status,
      ).toBe(200);
      changedSchema = true;
      expect((await post("refresh", { installationId: "static" })).status).toBe(200);
      expect(
        await sql(
          "SELECT reviews::text FROM clockgrove.mcp_installations WHERE installation_id='static'",
        ),
      ).toBe("{}");
      const pending = await post("oauth-begin", {
        installationId: "oauth",
        url: "https://fixture.example/oauth",
      });
      expect(pending.status).toBe(200);
      const navigation = new URL((pending.body as { authorizationUrl: string }).authorizationUrl);
      expect(navigation.searchParams.get("code_challenge_method")).toBe("S256");
      expect(
        (
          await post("oauth-callback", {
            installationId: "oauth",
            state: navigation.searchParams.get("state"),
            iss: "https://fixture.example/issuer",
            code: "authorization-code",
          })
        ).status,
      ).toBe(200);
      expect((await post("refresh", { installationId: "oauth" })).status).toBe(200);
      holdDiscovery = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const started = new Promise<void>((resolve) => {
        discoveryStarted = resolve;
      });
      const refreshing = post("refresh", { installationId: "oauth" });
      await started;
      const revisionBeforeRevoke = revisions;
      try {
        expect((await post("revoke", { installationId: "oauth" })).status).toBe(503);
        expect(
          await sql(
            "SELECT status FROM clockgrove.mcp_installations WHERE installation_id='oauth'",
          ),
        ).toBe("revoked");
        expect(revisions).toBeGreaterThan(revisionBeforeRevoke);
      } finally {
        releaseDiscovery?.();
      }
      expect((await refreshing).status).toBe(503);
      expect(
        await sql("SELECT status FROM clockgrove.mcp_installations WHERE installation_id='oauth'"),
      ).toBe("revoked");
      expect(
        (
          await post("connect", {
            installationId: "anonymous",
            url: "https://fixture.example/anonymous",
          })
        ).status,
      ).toBe(200);
      expect((await post("refresh", { installationId: "anonymous" })).status).toBe(200);
      await operator.close();
      expect(
        await sql("SELECT status FROM clockgrove.mcp_installations WHERE installation_id='static'"),
      ).toBe("disabled");
      expect(revisions).toBeGreaterThan(6);
      expect(JSON.stringify([outputs, logs])).not.toContain(canary);
      expect(
        await sql(`SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%${canary}%'`),
      ).toBe("0");
      expect(
        await sql(
          `SELECT count(*) FROM clockgrove_mcp.credentials WHERE envelope::text LIKE '%${canary}%'`,
        ),
      ).toBe("0");
    } finally {
      releaseDiscovery?.();
      await operator.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 30000);
