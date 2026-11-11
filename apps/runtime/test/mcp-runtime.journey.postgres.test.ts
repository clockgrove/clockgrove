import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpDiscoverySnapshot } from "@clockgrove/application";
import { expect, it } from "vitest";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local helper.
} from "../../../scripts/database/lib.mjs";
import { composeMcpOperator } from "../src/mcp-composition.js";
import type { DatabaseFixture } from "./world-fixture.js";

it("authenticates HTTP MCP install, OAuth callback, review, bind, refresh and revoke through PostgreSQL without exposing credentials", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = require.resolve("wrangler/package.json");
  const { Miniflare, convertV4MiniflareOptions, Log } = createRequire(wrangler)("miniflare");
  const scratch = await mkdtemp(path.join(tmpdir(), "mcp-native-"));
  const config = path.join(scratch, "wrangler.json");
  const output = path.join(scratch, "bundle");
  await writeFile(
    config,
    JSON.stringify({
      name: "mcp-native",
      main: path.join(import.meta.dirname, "mcp-runtime.worker.ts"),
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  const args = ["deploy", "--dry-run", "--config", config, "--outdir", output];
  execFileSync(process.execPath, [path.join(path.dirname(wrangler), "bin/wrangler.js"), ...args], {
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: "pipe",
  });
  try {
    await withDisposableDatabase(
      async (
        fixture: DatabaseFixture & {
          withLoopbackTransport<T>(operation: (port: number) => Promise<T>): Promise<T>;
        },
      ) => {
        await applyMigrations(fixture.tools, fixture.environment);
        await applySqlFile(
          fixture.tools,
          fixture.environment,
          "tests/database/journal-fixture.sql",
        );
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
        const unavailable = () => {
          throw new Error("hosted dependencies must stay closed");
        };
        expect(() =>
          composeMcpOperator({
            environment: "production",
            runtimeDatabaseUrl: "runtime",
            withClient: unavailable,
            openSecretClient: unavailable,
            secretDatabaseUrl: "secrets",
            credentialKeyring: { activeVersion: "v1", keys: new Map() },
            network: { resolve: unavailable, request: unavailable },
            oauthClient: unavailable,
            maxInstallations: 1,
            changed: async () => undefined,
          }),
        ).toThrow("MCP hosted activation pending issue 3");
        await sql(`INSERT INTO clockgrove_auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Owner','owner@example.test',true,now(),now());
      INSERT INTO clockgrove_auth.session (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ('session','session','owner',now()+interval '1 hour',now(),now());
      INSERT INTO clockgrove_management.principals VALUES ('principal-j-a',NULL);
      INSERT INTO clockgrove_management.identity_links VALUES ('local','owner','fixture-identity','principal-j-a',NULL);`);
        await fixture.withLoopbackTransport(async (port) => {
          const connection = (role: string) => {
            const url = new URL(`postgres://${role}@127.0.0.1:${port}/clockgrove`);
            if (fixture.environment.PGPASSWORD) url.password = fixture.environment.PGPASSWORD;
            return url.toString();
          };
          const secret = new URL(connection("clockgrove_admin"));
          secret.searchParams.set("options", "-c role=clockgrove_mcp_secrets");
          const logs: string[] = [];
          class CapturedLog extends Log {
            logWithLevel(_level: unknown, message: string) {
              logs.push(message);
            }
          }
          const authenticationKey = "fixture".repeat(8);
          const worker = new Miniflare(
            convertV4MiniflareOptions({
              name: "mcp-native",
              modules: true,
              modulesRoot: output,
              scriptPath: path.join(output, "mcp-runtime.worker.js"),
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              cf: false,
              log: new CapturedLog(),
              durableObjects: { MCP_OPERATOR_DO: { className: "McpOperatorDO", useSQLite: true } },
              hyperdrives: { HYPERDRIVE: connection("clockgrove_runtime") },
              bindings: {
                PROVIDER_ENVIRONMENT: "local",
                AUTH_DATABASE_URL: connection("clockgrove_auth_verifier"),
                MANAGEMENT_DATABASE_URL: connection("clockgrove_management_reader"),
                AUTH_ORIGIN: "https://operator.example",
                WORLD_AUTHORIZATION_DATABASE_URL: connection("clockgrove_world_reader"),
                BETTER_AUTH_SECRET: authenticationKey,
                SECRET_DATABASE_URL: secret.toString(),
                FIXTURE_ORIGIN: origin,
              },
            }),
          );
          const revision = async () =>
            Number(await sql("SELECT sum(revision) FROM clockgrove.mcp_installations"));
          let command = 0;
          const outputs: unknown[] = [];
          const post = async (action: string, fields: object = {}, authenticated = true) => {
            const response = await worker.dispatchFetch(
              `https://operator.example/v1/runtime/mcp/${action}`,
              {
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
              },
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
                  {
                    installationId: "denied",
                    url: "https://fixture.example/static",
                    token: canary,
                  },
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
            const navigation = new URL(
              (pending.body as { authorizationUrl: string }).authorizationUrl,
            );
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
            const revisionBeforeRevoke = await revision();
            try {
              expect((await post("revoke", { installationId: "oauth" })).status).toBe(503);
              expect(
                await sql(
                  "SELECT status FROM clockgrove.mcp_installations WHERE installation_id='oauth'",
                ),
              ).toBe("revoked");
              expect(await revision()).toBeGreaterThan(revisionBeforeRevoke);
            } finally {
              releaseDiscovery?.();
            }
            expect((await refreshing).status).toBe(503);
            expect(
              await sql(
                "SELECT status FROM clockgrove.mcp_installations WHERE installation_id='oauth'",
              ),
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
            await worker.dispatchFetch("https://operator.example/close");
            expect(
              await sql(
                "SELECT status FROM clockgrove.mcp_installations WHERE installation_id='static'",
              ),
            ).toBe("disabled");
            expect(await revision()).toBeGreaterThan(6);
            expect(logs.length).toBeGreaterThan(0);
            expect(JSON.stringify([outputs, logs])).not.toContain(canary);
            expect(
              await sql(
                `SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%${canary}%'`,
              ),
            ).toBe("0");
            expect(
              await sql(
                `SELECT count(*) FROM clockgrove_mcp.credentials WHERE envelope::text LIKE '%${canary}%'`,
              ),
            ).toBe("0");
          } finally {
            releaseDiscovery?.();
            await worker.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        });
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);
