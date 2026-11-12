import { createHash } from "node:crypto";
import { createServer as httpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { McpRuntimeOperator } from "../../apps/runtime/src/mcp.ts";
import { RuntimeWorker } from "../../apps/runtime/src/worker.ts";
import { livingHallAuthentication } from "../../apps/runtime/test/living-hall-fixture.ts";
import {
  connect,
  provisionTestWorld,
  truthOf,
  withClient,
} from "../../apps/runtime/test/world-fixture.ts";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "../../apps/runtime/test/world-owner/native-harness.ts";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import {
  McpCredentialVault,
  McpOAuthHttpNetwork,
  SafeMcpHttpClient,
} from "../../packages/application/src/index.ts";
import { PostgreSqlMcpSecretStorage } from "../../packages/persistence/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "tests/e2e/mcp-installation.journey.browser.test.mjs";
process.env.CLOCKGROVE_WORLD_SHELL = path.join(root, "worlds/fixture/reference/shell.json");

it("connects, inspects, reviews, binds, detects drift and revokes through the operator screen", async () => {
  if (!isNativeWorldOwnerChild()) {
    await runNativeWorldOwnerProcess(FILE, "fixture/reference", {
      vitestConfig: "tests/ci/vitest.browser.config.ts",
      timeoutMs: 180_000,
      inheritOutput: true,
    });
    return;
  }
  await withNativeWorldOwner(
    async (native) => {
      const provisioned = await provisionTestWorld(
        native.fixture,
        native.world,
        "principal-runtime",
      );
      const auth = livingHallAuthentication(provisioned);
      auth.grant("runtime:mcp-install");
      const scope = auth.scope;
      await truthOf(native.fixture)(
        "UPDATE clockgrove.world_memberships SET roles=ARRAY['owner'],grants=ARRAY['runtime:world-observe','runtime:mcp-install'] WHERE principal_id='principal-runtime'",
      );
      const canary = "mcp-browser-credential-canary";
      const malicious = "<img src=x onerror=globalThis.remoteExecuted=true>";
      let drift = false;
      let callbackUrl;
      const remote = httpServer(async (request, response) => {
        const target = new URL(request.url, "https://fixture.example");
        if (target.pathname === "/authorize") {
          const callback = new URL(callbackUrl);
          callback.protocol = "https:";
          callback.host = "operator.example";
          callback.searchParams.set("state", target.searchParams.get("state"));
          callback.searchParams.set("iss", "https://fixture.example/issuer");
          callback.searchParams.set("code", "fixture-code");
          response.writeHead(302, { location: callback.href });
          response.end();
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        let result;
        if (target.pathname.startsWith("/.well-known/oauth-protected-resource"))
          result = {
            resource: "https://fixture.example/oauth",
            authorization_servers: ["https://fixture.example/issuer"],
          };
        else if (target.pathname === "/.well-known/oauth-authorization-server/issuer")
          result = {
            issuer: "https://fixture.example/issuer",
            authorization_endpoint: "https://fixture.example/authorize",
            token_endpoint: "https://fixture.example/token",
            revocation_endpoint: "https://fixture.example/revoke",
            code_challenge_methods_supported: ["S256"],
          };
        else if (target.pathname === "/token")
          result = {
            token_type: "Bearer",
            access_token: canary,
            refresh_token: canary,
            expires_in: 3600,
          };
        else {
          if (
            target.pathname !== "/anonymous" &&
            request.headers.authorization !== `Bearer ${canary}`
          ) {
            response.writeHead(401);
            response.end();
            return;
          }
          const rpc = JSON.parse(body);
          if (rpc.method === "notifications/initialized") {
            response.writeHead(202);
            response.end();
            return;
          }
          const value =
            rpc.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  serverInfo: {
                    name: target.pathname === "/echo" ? canary : "browser-fixture",
                    version: "1",
                  },
                  capabilities: { tools: {}, resources: {}, prompts: {} },
                }
              : rpc.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "lookup",
                        description: malicious,
                        inputSchema: {
                          type: "object",
                          properties: {
                            query: { type: "string", ...(drift ? { maxLength: 5 } : {}) },
                          },
                        },
                      },
                      { name: "report", inputSchema: { type: "object" } },
                    ],
                  }
                : rpc.method === "resources/list"
                  ? { resources: [{ uri: "https://fixture.example/data", name: "data" }] }
                  : rpc.method === "resources/templates/list"
                    ? { resourceTemplates: [] }
                    : { prompts: [{ name: "untrusted-prompt", description: malicious }] };
          result = { jsonrpc: "2.0", id: rpc.id, result: value };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
      await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
      const remoteOrigin = `http://127.0.0.1:${remote.address().port}`;
      const network = {
        resolve: async () => ["93.184.216.34"],
        request: (url, init) =>
          fetch(`${remoteOrigin}${new URL(url).pathname}${new URL(url).search}`, init),
      };
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(8),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      const operator = new McpRuntimeOperator({
        withClient: (operation) => withClient(native.fixture.environment, operation),
        network,
        openProvider: async (credentialScope) => {
          const client = connect(native.fixture.environment, "clockgrove", "clockgrove_admin");
          await client.query("SET ROLE clockgrove_mcp_secrets");
          const storage = await PostgreSqlMcpSecretStorage.open(client, credentialScope);
          return {
            vault: new McpCredentialVault(
              storage,
              "browser-v1",
              new Map([["browser-v1", key]]),
              new McpOAuthHttpNetwork(new SafeMcpHttpClient(network)),
            ),
            close: () => storage.close(),
          };
        },
        oauthClient: () => ({
          clientId: "fixture-client",
          issuer: "https://fixture.example/issuer",
          resource: "https://fixture.example/oauth",
          redirectUri: `https://operator.example${new URL(callbackUrl).pathname}`,
          scopes: ["lookup"],
        }),
        // Explicit fixture capacity: static and OAuth each retain a dedicated provider.
        maxInstallations: 2,
        changed: async () => {},
      });
      const logs = [];
      const worker = new RuntimeWorker(
        auth.sessionStoreAuthenticator(native.fixture.environment),
        { mcp: operator },
        { log: (record) => logs.push(record) },
      );
      const server = await createServer({
        root: path.join(root, "apps/web"),
        configFile: path.join(root, "apps/web/vite.config.ts"),
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/v1/projection": { target: await native.origin(), ws: true },
            "/v1/runtime": await native.origin(),
          },
        },
        plugins: [
          {
            name: "real-mcp-runtime",
            configureServer(vite) {
              vite.middlewares.use("/api/auth", async (request, response, next) => {
                try {
                  let body = "";
                  for await (const chunk of request) body += chunk;
                  const result = await native.fetch(
                    new Request(`https://auth.example.test/api/auth${request.url}`, {
                      method: request.method,
                      headers: { ...request.headers, origin: "https://auth.example.test" },
                      ...(["GET", "HEAD"].includes(request.method) ? {} : { body }),
                    }),
                  );
                  let text = await result.text();
                  if (result.headers.get("content-type")?.includes("application/json") && text) {
                    const value = JSON.parse(text);
                    if (typeof value.url === "string") {
                      const target = new URL(value.url, "https://auth.example.test");
                      if (target.origin === "https://auth.example.test") {
                        value.url = `http://127.0.0.1:${server.httpServer.address().port}${target.pathname}${target.search}`;
                        text = JSON.stringify(value);
                      }
                    }
                  }
                  const headers = Object.fromEntries(result.headers);
                  delete headers["content-length"];
                  response.writeHead(result.status, headers);
                  response.end(text);
                } catch (error) {
                  next(error);
                }
              });
              vite.middlewares.use("/v1/runtime/mcp", async (request, response, next) => {
                try {
                  let body = "";
                  for await (const chunk of request) body += chunk;
                  const result = await worker.fetch(
                    new Request(`http://local.test/v1/runtime/mcp${request.url}`, {
                      method: "POST",
                      headers: request.headers,
                      body,
                    }),
                  );
                  response.writeHead(result.status, Object.fromEntries(result.headers));
                  response.end(await result.text());
                } catch (error) {
                  next(error);
                }
              });
            },
          },
        ],
      });
      let browser;
      try {
        await server.listen();
        const route = `/worlds/${[scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId].map(encodeURIComponent).join("/")}`;
        callbackUrl = `http://127.0.0.1:${server.httpServer.address().port}${route}`;
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        // The fixture authorization server is actual HTTP; only its public DNS name maps locally.
        await page.route("https://fixture.example/authorize**", async (request) => {
          const response = await request.fetch({
            url: `${remoteOrigin}${new URL(request.request().url()).pathname}${new URL(request.request().url()).search}`,
            maxRedirects: 0,
          });
          const callback = new URL(response.headers().location);
          await request.fulfill({
            response,
            headers: { ...response.headers(), location: `${callbackUrl}${callback.search}` },
          });
        });
        const signIn = async () => {
          await page.getByLabel("Local session credential").fill("local-reader-session");
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
        };
        await page.goto(callbackUrl);
        await signIn();
        await page.getByRole("button", { name: "Capabilities", exact: true }).click();
        const screen = page.getByRole("region", { name: "Capabilities", exact: true });
        await screen
          .getByLabel("Server URL", { exact: true })
          .fill("https://fixture.example/static");
        await screen.getByLabel("Server credential").fill(canary);
        await screen.getByRole("button", { name: "Connect server", exact: true }).click();
        const installation = screen.getByRole("article").filter({
          has: page.getByRole("heading", { name: "https://fixture.example/static", exact: true }),
        });
        await expect
          .poll(async () => ({
            rows: await screen.getByRole("article").count(),
            error: await screen.getByRole("alert").allTextContents(),
          }))
          .toEqual({ rows: 1, error: [] });
        await installation.getByText("browser-fixture", { exact: false }).waitFor();
        expect(await screen.getByLabel("Server credential").inputValue()).toBe("");
        expect(
          await installation.getByText("Protocol: 2025-11-25", { exact: true }).textContent(),
        ).toBe("Protocol: 2025-11-25");
        expect(await installation.getByRole("region").count()).toBe(4);
        expect(await page.evaluate(() => globalThis.remoteExecuted)).toBeUndefined();
        const lookup = installation.getByRole("region", { name: "Candidate lookup", exact: true });
        const report = installation.getByRole("region", { name: "Candidate report", exact: true });
        expect(
          await lookup
            .getByText("Kind: tool. Class: external-write. Disabled", { exact: true })
            .count(),
        ).toBe(1);
        expect(
          await lookup
            .getByText(
              "Schema hash: f6849946e5ba81f5a219ad270400337527a9adf60d8ec0877e4ff6d6eacefbd5",
              { exact: true },
            )
            .count(),
        ).toBe(1);
        expect(
          await installation
            .getByText("Resources and prompts remain disabled.", { exact: true })
            .count(),
        ).toBe(2);
        expect(await installation.locator("img").count()).toBe(0);

        for (const tool of [lookup, report]) {
          await tool.getByLabel("Effect class").selectOption("read");
          await tool.getByRole("button", { name: "Review and enable tool" }).click();
          await tool.getByRole("button", { name: "Disable tool" }).waitFor();
        }
        await lookup.getByLabel("Actor ID").fill("actor-browser");
        await lookup.getByLabel("Allowed input fields (comma separated)").fill("query");
        await lookup.getByRole("button", { name: "Bind actor", exact: true }).click();
        await screen
          .getByRole("status")
          .getByText("Canonical capability state updated.", { exact: true })
          .waitFor();
        const bindingRevoked = page.waitForResponse((response) =>
          response.url().endsWith("/mcp/bind"),
        );
        await installation.getByRole("button", { name: "Revoke binding", exact: true }).click();
        expect(await (await bindingRevoked).json()).toEqual({ ok: true });
        await installation.getByText(/Binding disabled/u).waitFor();
        drift = true;
        await installation.getByRole("button", { name: "Refresh discovery" }).click();
        await lookup
          .getByText("Schema or protocol drift: review this version again.", { exact: true })
          .waitFor();
        expect(await lookup.getByRole("button", { name: "Review and enable tool" }).count()).toBe(
          1,
        );
        expect(await report.getByRole("button", { name: "Disable tool" }).count()).toBe(1);
        await installation.getByRole("button", { name: "Revoke installation" }).click();
        await installation.getByText(/Status: revoked/u).waitFor();
        await screen.getByLabel("Server URL", { exact: true }).fill("https://fixture.example/echo");
        await screen.getByLabel("Server credential").fill(canary);
        await screen.getByRole("button", { name: "Connect server", exact: true }).click();
        await screen.getByRole("alert").waitFor();
        expect(await screen.getByRole("alert").textContent()).not.toContain(canary);
        await screen.getByLabel("Authentication", { exact: true }).selectOption("anonymous");
        await screen
          .getByLabel("Server URL", { exact: true })
          .fill("https://fixture.example/anonymous");
        await screen.getByRole("button", { name: "Connect server", exact: true }).click();
        await screen
          .getByRole("heading", { name: "https://fixture.example/anonymous", exact: true })
          .waitFor();
        await screen.getByLabel("Authentication", { exact: true }).selectOption("oauth");
        await screen
          .getByLabel("Server URL", { exact: true })
          .fill("https://fixture.example/oauth");
        await screen.getByRole("button", { name: "Connect with OAuth" }).click();
        await page.waitForURL(/code=fixture-code/u);
        await signIn();
        await page
          .getByRole("heading", { name: "https://fixture.example/oauth", exact: true })
          .waitFor();
        expect(new URL(page.url()).search).toBe("");
        expect(await page.locator("body").textContent()).not.toContain(canary);
        expect(JSON.stringify(logs)).not.toContain(canary);
        const journal = await truthOf(native.fixture)(
          "SELECT payload::text FROM clockgrove.events WHERE event_type IN ('McpInstallationChanged','McpBindingChanged')",
        );
        expect(journal).not.toContain(canary);
        expect(journal).toContain("actor-browser");
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/mcp/tokens`);
        await page
          .getByLabel("Member session credential", { exact: true })
          .fill("local-reader-session");
        await page.getByRole("button", { name: "Show my tokens", exact: true }).click();
        await page.getByLabel("Token name", { exact: true }).fill("Browser MCP client");
        await page.getByRole("button", { name: "Create token", exact: true }).click();
        const issued = page.getByLabel("New API token", { exact: true });
        await issued.waitFor();
        const memberToken = await issued.textContent();
        expect(memberToken.startsWith("cg_member_")).toBe(true);
        expect(await truthOf(native.fixture)("SELECT count(*) FROM clockgrove_auth.apikey")).toBe(
          "1",
        );
        expect(await truthOf(native.fixture)("SELECT key FROM clockgrove_auth.apikey")).not.toBe(
          memberToken,
        );
        expect(
          await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
        ).not.toContain(memberToken);
        await page.getByRole("button", { name: "Hide token", exact: true }).click();
        expect(await issued.count()).toBe(0);
        await page.getByRole("button", { name: "Revoke Browser MCP client", exact: true }).click();
        await expect
          .poll(() => truthOf(native.fixture)("SELECT count(*) FROM clockgrove_auth.apikey"))
          .toBe("0");
        expect(await page.locator("body").textContent()).not.toContain(memberToken);
        const authOrigin = "https://auth.example.test";
        const registered = await native.fetch(
          new Request(`${authOrigin}/api/auth/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Browser OAuth client",
              redirect_uris: ["https://browser-client.test/callback"],
            }),
          }),
        );
        expect(registered.status).toBe(201);
        const { client_id: clientId } = await registered.json();
        const verifier = "browser-fixture-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
        const authorization = new URLSearchParams({
          client_id: clientId,
          redirect_uri: "https://browser-client.test/callback",
          response_type: "code",
          scope: "clockgrove:mcp",
          state: "browser-state",
          resource: `${authOrigin}/mcp`,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        });
        const login = await native.fetch(
          new Request(`${authOrigin}/api/auth/oauth2/authorize?${authorization}`, {
            headers: { accept: "application/json" },
          }),
        );
        expect(login.status).toBe(200);
        const loginURL = new URL((await login.json()).url, authOrigin);
        expect(loginURL.pathname).toBe("/sign-in");
        const webOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
        await page.goto(`${webOrigin}${loginURL.pathname}${loginURL.search}`);
        await page
          .getByLabel("Member session credential", { exact: true })
          .fill("local-reader-session");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("heading", { name: "Allow an MCP client", exact: true }).waitFor();
        expect(await page.getByRole("region", { name: "MCP consent" }).textContent()).toContain(
          clientId,
        );
        await page.route("https://browser-client.test/callback**", (route) =>
          route.fulfill({ contentType: "text/html", body: "Consent callback received" }),
        );
        await page.getByRole("button", { name: "Allow", exact: true }).click();
        await page.waitForURL("https://browser-client.test/callback**");
        expect(new URL(page.url()).searchParams.get("state")).toBe("browser-state");
        expect(new URL(page.url()).searchParams.has("code")).toBe(true);
        await page.goto(`${webOrigin}/mcp/tokens`);
        await page
          .getByLabel("Member session credential", { exact: true })
          .fill("local-reader-session");
        await page.getByRole("button", { name: "Show my tokens", exact: true }).click();
        await page.getByRole("button", { name: "Revoke client access", exact: true }).click();
        await expect
          .poll(() =>
            truthOf(native.fixture)('SELECT count(*) FROM clockgrove_auth."oauthConsent"'),
          )
          .toBe("0");
        expect(await page.getByRole("alert").count()).toBe(0);
      } finally {
        await browser?.close();
        await server.close();
        await operator.close();
        await new Promise((resolve) => remote.close(resolve));
      }
    },
    { mcp: true },
  );
}, 210_000);
