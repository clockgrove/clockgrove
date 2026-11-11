import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type McpCredentialScope,
  McpCredentialVault,
  type McpNetworkPort,
  McpOAuthHttpNetwork,
  McpRefusal,
  type RuntimeAuthorizationContext,
  SafeMcpHttpClient,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { PostgreSqlMcpInstallations, PostgreSqlMcpSecretStorage } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import { McpCredentialInstallation } from "../../../packages/application/src/mcp-credential-installation.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

it("owns PostgreSQL credentials across authorized static and OAuth discovery, refresh failures and revocation", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    const sql = async (query: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, query)).trim();
    await sql(`INSERT INTO clockgrove.world_memberships(tenant_id,world_id,timeline_id,space_id,principal_id,membership_id,persona_id,roles,grants,privacy_ceiling,committed_at)
      VALUES('tenant-j-a','world-j-a','timeline-j-a','space-j-a','principal-j-a','member-a','persona-a',ARRAY['owner'],'{}','{"version":1,"allowedCategories":["operator_evidence"]}',statement_timestamp());`);
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
    const canary = "credential-canary-owned-provider";
    const headers: [string, string | undefined][] = [];
    const grants: string[] = [];
    let echo = false;
    let failToken = false;
    let failRevoke = false;
    let networkMode = "public";
    let resolutions = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const path = request.url ?? "";
      if (networkMode === "redirect") {
        response.writeHead(307, { Location: "https://other.example/mcp" });
        response.end();
        return;
      }
      headers.push([path, request.headers.authorization]);
      let result: unknown;
      if (path.startsWith("/.well-known/oauth-protected-resource/")) {
        result = {
          resource: `https://fixture.example/${path.split("/").at(-1)}`,
          authorization_servers: ["https://fixture.example/issuer"],
        };
      } else if (path === "/.well-known/oauth-authorization-server/issuer") {
        result = {
          issuer: "https://fixture.example/issuer",
          authorization_endpoint: "https://fixture.example/authorize",
          token_endpoint: "https://fixture.example/token",
          revocation_endpoint: "https://fixture.example/revoke",
          code_challenge_methods_supported: ["S256"],
        };
      } else if (path === "/token") {
        grants.push(new URLSearchParams(body).get("grant_type") ?? "");
        response.writeHead(failToken ? 500 : 200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            failToken
              ? { error: canary }
              : {
                  token_type: "Bearer",
                  access_token: canary,
                  refresh_token: canary,
                  expires_in: 3600,
                },
          ),
        );
        return;
      } else if (path === "/revoke") {
        response.writeHead(failRevoke ? 500 : 200, { "Content-Type": "application/json" });
        response.end(failRevoke ? JSON.stringify({ error: canary }) : "");
        return;
      } else {
        if (request.headers.authorization !== `Bearer ${canary}`) {
          response.writeHead(401);
          response.end();
          return;
        }
        const rpc = JSON.parse(body) as { id: number; method: string };
        if (rpc.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        const value =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                serverInfo: { name: echo ? canary : "fixture-server", version: "1" },
                capabilities: { tools: {} },
              }
            : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
        result = { jsonrpc: "2.0", id: rpc.id, result: value };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const network: McpNetworkPort = {
      resolve: async () => {
        resolutions++;
        return networkMode === "private"
          ? ["127.0.0.1"]
          : networkMode === "rebind" && resolutions > 1
            ? ["93.184.216.35"]
            : ["93.184.216.34"];
      },
      request: (url, init) => {
        if (networkMode === "unknown") throw new McpRefusal(canary);
        if (networkMode === "forged") {
          const error = new McpRefusal("unsafe_redirect");
          error.message = canary;
          error.cause = canary;
          throw error;
        }
        return fetch(`${origin}${new URL(url).pathname}`, init);
      },
    };
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    const client = connect(fixture.environment, "clockgrove", "clockgrove_runtime");
    const governance = new PostgreSqlMcpInstallations(client);
    const handles: McpCredentialInstallation[] = [];
    let providers = 0;
    const open = async (id: string) => {
      const handle = await McpCredentialInstallation.open(
        governance,
        network,
        authorization,
        scope,
        { installationId: id, url: `https://fixture.example/${id}` },
        async (credentialScope: McpCredentialScope) => {
          providers++;
          const secretClient = connect(fixture.environment, "clockgrove", "clockgrove_admin");
          await secretClient.query("SET ROLE clockgrove_mcp_secrets");
          const storage = await PostgreSqlMcpSecretStorage.open(secretClient, credentialScope);
          return {
            vault: new McpCredentialVault(
              storage,
              "credential-v1",
              new Map([["credential-v1", key]]),
              new McpOAuthHttpNetwork(new SafeMcpHttpClient(network)),
            ),
            close: () => storage.close(),
          };
        },
      );
      handles.push(handle);
      return handle;
    };
    const issuedAt = "2026-11-09T00:00:00.000Z";
    const oauthClient = (id: string) => ({
      clientId: "fixture-client",
      issuer: "https://fixture.example/issuer",
      resource: `https://fixture.example/${id}`,
      redirectUri: "https://operator.example/callback",
      scopes: ["lookup"],
    });
    try {
      await sql(
        "UPDATE clockgrove.world_memberships SET roles='{}',grants='{}' WHERE principal_id='principal-j-a'",
      );
      await expect(open("denied")).rejects.toMatchObject({
        code: "installation_authority_required",
      });
      expect([providers, headers.length]).toEqual([0, 0]);
      await sql(
        "UPDATE clockgrove.world_memberships SET roles=ARRAY['owner'] WHERE principal_id='principal-j-a'",
      );
      for (const [mode, message] of [
        ["private", "MCP refused: private_or_unresolved_target"],
        ["redirect", "MCP refused: unsafe_redirect"],
        ["rebind", "MCP refused: dns_changed"],
        ["unknown", "MCP credential unavailable"],
        ["forged", "MCP refused: unsafe_redirect"],
      ]) {
        const refused = await open(`refused-${mode}`);
        networkMode = mode!;
        resolutions = 0;
        const error = await refused
          .connectStatic(canary, `refused-${mode}`, issuedAt)
          .catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(message);
        expect((error as Error).cause).toBeUndefined();
        expect(await governance.read(authorization, scope, `refused-${mode}`)).toBeUndefined();
      }
      networkMode = "public";
      const failedRefresh = await open("network-refresh");
      await failedRefresh.connectStatic(canary, "network-refresh-install", issuedAt);
      networkMode = "redirect";
      await expect(
        failedRefresh.refresh("network-refused-refresh", issuedAt),
      ).rejects.toMatchObject({
        message: "MCP refused: unsafe_redirect",
        code: "unsafe_redirect",
      });
      expect((await governance.read(authorization, scope, "network-refresh"))?.status).toBe(
        "disabled",
      );
      networkMode = "public";
      const staticHandle = await open("static");
      await staticHandle.connectStatic(canary, "credential-static", issuedAt);
      expect((await governance.read(authorization, scope, "static"))?.owner_principal_id).toBe(
        "principal-j-a",
      );
      await staticHandle.refresh("credential-static-refresh", issuedAt);
      echo = true;
      const echoed = await open("echoed");
      await expect(echoed.connectStatic(canary, "credential-echoed", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      expect(await governance.read(authorization, scope, "echoed")).toBeUndefined();
      await expect(staticHandle.refresh("credential-echo-refresh", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      expect((await governance.read(authorization, scope, "static"))?.status).toBe("disabled");
      echo = false;
      const oauth = await open("oauth");
      const pending = await oauth.beginOAuth(oauthClient("oauth"));
      const navigation = new URL(pending.authorizationUrl);
      expect(navigation.origin + navigation.pathname).toBe("https://fixture.example/authorize");
      expect(navigation.searchParams.get("code_challenge_method")).toBe("S256");
      expect(Object.keys(pending)).toEqual(["authorizationUrl"]);
      await oauth.completeOAuth(
        {
          state: navigation.searchParams.get("state")!,
          iss: "https://fixture.example/issuer",
          code: "fixture-code",
        },
        "credential-oauth",
        issuedAt,
      );
      await oauth.refresh("credential-oauth-refresh", issuedAt);
      await governance.change(
        authorization,
        scope,
        { action: "disable", installationId: "oauth" },
        "credential-external-disable",
        issuedAt,
      );
      const revocationsBefore = headers.filter(([path]) => path === "/revoke").length;
      failRevoke = true;
      await expect(oauth.revoke("credential-oauth-revoke", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      expect((await governance.read(authorization, scope, "oauth"))?.status).toBe("revoked");
      expect(headers.filter(([path]) => path === "/revoke").length).toBe(revocationsBefore + 1);
      await expect(oauth.refresh("credential-closed", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      failRevoke = false;
      const alreadyRevoked = await open("already-revoked");
      await alreadyRevoked.connectStatic(canary, "credential-already-revoked", issuedAt);
      await governance.change(
        authorization,
        scope,
        { action: "revoke", installationId: "already-revoked" },
        "credential-external-revoke",
        issuedAt,
      );
      const eventsBeforeCleanup = await sql("SELECT count(*) FROM clockgrove.events");
      await alreadyRevoked.revoke("credential-cleanup-only", issuedAt);
      expect(await sql("SELECT count(*) FROM clockgrove.events")).toBe(eventsBeforeCleanup);
      await expect(alreadyRevoked.refresh("credential-cleanup-closed", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      const uncertain = await open("uncertain");
      const start = await uncertain.beginOAuth(oauthClient("uncertain"));
      await uncertain.completeOAuth(
        {
          state: new URL(start.authorizationUrl).searchParams.get("state")!,
          iss: "https://fixture.example/issuer",
          code: "fixture-code",
        },
        "credential-uncertain",
        issuedAt,
      );
      failToken = true;
      await expect(uncertain.refresh("credential-failed-refresh", issuedAt)).rejects.toThrow(
        "MCP credential unavailable",
      );
      expect((await governance.read(authorization, scope, "uncertain"))?.status).toBe("disabled");
      expect(grants).toEqual([
        "authorization_code",
        "refresh_token",
        "authorization_code",
        "refresh_token",
      ]);
      expect(
        headers
          .filter(
            ([path]) => path.startsWith("/.well-known") || path === "/token" || path === "/revoke",
          )
          .every(([, value]) => value === undefined),
      ).toBe(true);
      expect(
        await sql(`SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%${canary}%'`),
      ).toBe("0");
      expect(
        await sql(
          `SELECT count(*) FROM clockgrove.mcp_installations WHERE snapshot::text LIKE '%${canary}%'`,
        ),
      ).toBe("0");
      expect(
        await sql(
          `SELECT count(*) FROM clockgrove_mcp.credentials WHERE envelope::text LIKE '%${canary}%'`,
        ),
      ).toBe("0");
    } finally {
      for (const handle of handles) await handle.close();
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}, 30_000);
