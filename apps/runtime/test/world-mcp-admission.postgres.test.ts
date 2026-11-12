import { WorldMcpAdmission } from "@clockgrove/application";
import { PostgreSqlWorldMcpAdmission } from "@clockgrove/persistence";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { handleAdmittedWorldMcpRequest } from "../src/world-mcp-admission.js";
import { sessionStoreAuthentication } from "./living-hall-fixture.js";
import { withClient } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-admission.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns principal-wide MCP admission native proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture/reference"),
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "reserves durable principal-wide request/work budgets before stateless SDK dispatch",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const environment = owner.fixture.environment;
      const memberCredential = "local-reader-session";
      const authenticate = sessionStoreAuthentication(environment);
      let applicationCalls = 0;
      const application = {
        async fetch(request: Request) {
          applicationCalls += 1;
          const response = await owner.request(
            new URL(request.url).pathname,
            await request.json(),
            request.headers.get("authorization")!.slice(7),
          );
          return Response.json(response.body, { status: response.status });
        },
      };
      const exchange = (request: Request) =>
        handleAdmittedWorldMcpRequest(
          application,
          new WorldMcpAdmission({
            ...authenticate,
            store: {
              reserve: (principal, phase, work) =>
                withClient(environment, (client) =>
                  new PostgreSqlWorldMcpAdmission(client).reserve(principal, phase, work),
                ),
            },
          }),
          request,
        );
      const raw = (body: string, credential = memberCredential) =>
        exchange(
          new Request("https://world-mcp.internal/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2026-07-28",
              "mcp-method": "tools/list",
            },
            body,
          }),
        );
      const catalog = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "raw-fixture", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
      const counters = () =>
        owner.sql(
          "SELECT calls || '|' || work_units FROM clockgrove.world_mcp_budgets WHERE principal_id='principal-runtime'",
        );
      const reset = () =>
        owner.sql(
          "UPDATE clockgrove.world_mcp_budgets SET window_start=date_trunc('minute',clock_timestamp()) - interval '1 minute', calls=60, work_units=240 WHERE principal_id='principal-runtime'",
        );
      const pin = () =>
        owner.sql(
          "UPDATE clockgrove.world_mcp_budgets SET window_start=date_trunc('minute',clock_timestamp()) + interval '1 hour' WHERE principal_id='principal-runtime'",
        );
      await owner.sql(
        "INSERT INTO clockgrove.world_mcp_budgets VALUES ('principal-runtime', date_trunc('minute',clock_timestamp()) + interval '1 hour', 0, 0)",
      );
      await owner.sql(
        "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe'); INSERT INTO clockgrove_auth.session (id, token, \"userId\", \"expiresAt\", \"createdAt\", \"updatedAt\") VALUES ('second-session', 'second-credential', 'local-subject', now()+interval '1 hour', now(), now())",
      );
      const client = new Client(
        { name: "admission-fixture", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL("https://world-mcp.internal/mcp"), {
            authProvider: { token: async () => memberCredential },
            fetch: (url, init) => exchange(new Request(url, init)),
          }),
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("world_status");
        const result = await client.callTool({
          name: "world_directory",
          arguments: { version: 1 },
        });
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
          ok: true,
          value: { entries: [{ ...owner.scope }] },
        });
        expect(await counters()).toBe("3|6");
      } finally {
        await client.close();
      }
      await reset();
      expect((await raw(catalog, "second-credential")).status).toBe(200);
      expect(await counters()).toBe("1|2");
      await pin();
      await owner.sql(
        "UPDATE clockgrove.world_mcp_budgets SET calls=59, work_units=118 WHERE principal_id='principal-runtime'",
      );
      expect(
        (await Promise.all([raw(catalog), raw(catalog, "second-credential")]))
          .map((response) => response.status)
          .sort(),
      ).toEqual([200, 429]);
      expect(await counters()).toBe("60|120");
      expect((await raw(catalog, "outsider-session-token")).status).toBe(200);
      expect(await counters()).toBe("60|120");
      const beforeRefusal = applicationCalls;
      expect(
        (
          await raw(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "world_status",
                arguments: {
                  version: 1,
                  ...owner.scope,
                  tenantId: "other-tenant",
                  worldId: "other-world",
                  timelineId: "other-timeline",
                },
              },
            }),
          )
        ).status,
      ).toBe(429);
      expect(await (await raw(catalog)).json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "mcp_rate_limited" },
      });
      expect(applicationCalls).toBe(beforeRefusal);
      let pulls = 0;
      const exhaustedBody = new ReadableStream(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode(catalog));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      expect(
        (
          await exchange(
            new Request("https://world-mcp.internal/mcp", {
              method: "POST",
              headers: { authorization: `Bearer ${memberCredential}` },
              body: exhaustedBody,
              duplex: "half",
            } as RequestInit & { duplex: "half" }),
          )
        ).status,
      ).toBe(429);
      expect(pulls).toBe(0);
      expect(applicationCalls).toBe(beforeRefusal);
      await reset();
      // Byte-cost boundary includes the UTF-8 BOM, which TextDecoder omits from its text.
      expect((await raw(`\uFEFF${catalog}${" ".repeat(4096 - catalog.length)}`)).status).toBe(200);
      expect(await counters()).toBe("1|3");
      await pin();
      expect((await raw("x".repeat(128 * 1024 + 1))).status).toBe(413);
      expect(await counters()).toBe("2|36");
      expect((await raw("{not-json")).status).toBe(400);
      expect(await counters()).toBe("3|38");
      await owner.sql(
        "UPDATE clockgrove.world_mcp_budgets SET work_units=239 WHERE principal_id='principal-runtime'",
      );
      expect((await raw(catalog, "second-credential")).status).toBe(429);
      expect(await counters()).toBe("4|240");
      await reset();
      expect((await raw(catalog)).status).toBe(200);
      expect(await counters()).toBe("1|2");
      await pin();
      await owner.sql("DELETE FROM clockgrove_auth.session WHERE token='second-credential'");
      expect((await raw(catalog, "second-credential")).status).toBe(401);
      expect(await counters()).toBe("1|2");
      await expect(
        withClient(environment, (connection) =>
          connection.query("UPDATE clockgrove.world_mcp_budgets SET calls=0,work_units=0"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        withClient(environment, (connection) =>
          connection.query(
            "SELECT * FROM clockgrove.world_mcp_budgets WHERE principal_id='principal-outsider'",
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const beforeUnavailable = applicationCalls;
      await owner.sql(
        "REVOKE EXECUTE ON FUNCTION clockgrove.reserve_world_mcp_request(text, integer) FROM clockgrove_runtime",
      );
      expect(await (await raw(catalog)).json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "mcp_admission_unavailable" },
      });
      expect(await counters()).toBe("1|2");
      expect(applicationCalls).toBe(beforeUnavailable);
    });
  },
  180_000,
);
