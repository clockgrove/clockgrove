import { decodeCanonicalNode } from "@clockgrove/application";
import { decodeConversationSession, type RunWalk } from "@clockgrove/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { handleWorldMcpRequest, WORLD_MCP_MAX_REQUEST_BYTES } from "../src/world-mcp-server.js";
import {
  canonicalResponse,
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/world-mcp-server.postgres.test.ts";
it.skipIf(isNativeWorldOwnerChild())(
  "owns stateless MCP client/native runtime proof",
  async () => runNativeWorldOwnerProcess(FILE, "fixture/reference"),
  240_000,
);
it.skipIf(!isNativeWorldOwnerChild())(
  "authenticates each stateless MCP exchange and enforces native read/inspector authority",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const application = {
        async fetch(request: Request) {
          const response = await owner.request(
            new URL(request.url).pathname,
            await request.json(),
            request.headers.get("authorization")!.slice(7),
          );
          return Response.json(response.body, { status: response.status });
        },
      };
      let credential = "local-reader-session";
      const responses: Response[] = [];
      const transport = new StreamableHTTPClientTransport(
        new URL("https://world-mcp.internal/mcp"),
        {
          authProvider: { token: async () => credential },
          fetch: async (url, init) => {
            const response = await handleWorldMcpRequest(application, new Request(url, init));
            responses.push(response.clone());
            return response;
          },
        },
      );
      const client = new Client(
        { name: "fixture-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as { type: string; text: string }[];
        return JSON.parse(content[0]!.text);
      };
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual([
          "world_directory",
          "world_status",
          "entity_inspect",
          "command_receipt",
          "run_receipt",
          "run_search",
          "runtime_state",
          "runtime_action",
          "changeset_prepare",
          "changeset_apply",
          "command_submit",
        ]);
        expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(
          true,
        );
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-observe')",
        );
        const scope = { version: 1, ...owner.scope };
        expect(await call("world_directory", { version: 1 })).toMatchObject({
          ok: true,
          value: { version: 1, entries: [{ ...owner.scope }] },
        });
        expect(await call("world_status", scope)).toMatchObject({
          ok: true,
          value: { ...scope, revision: "0", privacyClass: "public_scene" },
        });
        expect(
          await call("entity_inspect", { ...scope, objectId: "fixture.keeper" }),
        ).toMatchObject({ ok: true, value: { entity: { objectId: "fixture.keeper" } } });
        const commandId = await owner.sql(
          "SELECT command_id FROM clockgrove.events WHERE event_type='WorldReady'",
        );
        expect(
          await call("command_receipt", { schemaVersion: 1, ...owner.scope, commandId }),
        ).toEqual({ ok: false, status: 403, code: "authorization_refused" });
        await owner.sql(
          "UPDATE clockgrove.world_memberships SET grants=array_append(grants,'runtime:world-inspect')",
        );
        const receipt = await call("command_receipt", {
          schemaVersion: 1,
          ...owner.scope,
          commandId,
        });
        expect(receipt.status).toBe(200);
        expect(decodeCanonicalNode(canonicalResponse(receipt.value))).toMatchObject({
          receipt: { commandId, status: "committed" },
        });
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation","operator_evidence"]}'`,
        );
        const session = decodeConversationSession(
          (
            await owner.request("/v1/runtime/conversations/create", {
              ...scope,
              actorId: "fixture.keeper",
            })
          ).body,
        ).sessionId;
        expect(
          (
            await owner.request("/v1/runtime/talk", {
              ...scope,
              sessionId: session,
              messageId: "mcp-server-fixture",
              text: "private-mcp-server-canary",
            })
          ).status,
        ).toBe(200);
        await owner.sql(
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","operator_evidence"]}'`,
        );
        const runId = await owner.sql(
          "SELECT run_id FROM clockgrove.agent_runs WHERE input_message_id='mcp-server-fixture'",
        );
        const run = await call("run_receipt", { ...scope, runId });
        expect(run.status).toBe(200);
        expect(
          (run.value as RunWalk).runs.map((item) => [item.runId, item.status, item.prompt?.text]),
        ).toEqual([[runId, "completed", null]]);
        expect(JSON.stringify(run)).not.toContain("private-mcp-server-canary");
        expect(await call("run_search", scope)).toEqual({
          ok: true,
          status: 200,
          value: { runs: expect.arrayContaining([expect.objectContaining({ runId })]) },
        });
        credential = "outsider-session-token";
        expect(await call("world_directory", { version: 1 })).toEqual({
          ok: true,
          status: 200,
          value: { version: 1, entries: [] },
        });
        expect(await call("world_status", scope)).toEqual({
          ok: false,
          status: 403,
          code: "authorization_refused",
        });
        credential = "local-reader-session";
        const invalid = await client.callTool({
          name: "world_status",
          arguments: { ...scope, privateCanary: "never-return-this" },
        });
        expect(JSON.stringify(invalid)).not.toContain("never-return-this");
        expect(invalid).toEqual({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, status: 400, code: "invalid_tool_input" }),
            },
          ],
        });
        const tooLarge = await handleWorldMcpRequest(
          application,
          new Request("https://world-mcp.internal/mcp", {
            method: "POST",
            headers: { authorization: `Bearer ${credential}` },
            body: "x".repeat(WORLD_MCP_MAX_REQUEST_BYTES + 1),
          }),
        );
        expect(tooLarge.status).toBe(413);
        expect(await tooLarge.json()).toEqual({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "invalid_request_body" },
        });
        expect(responses.every((response) => response.headers.get("mcp-session-id") === null)).toBe(
          true,
        );
        await owner.sql("DELETE FROM clockgrove_auth.session WHERE token='local-reader-session'");
        await expect(client.listTools()).rejects.toThrow();
        expect(responses.at(-1)!.status).toBe(401);
      } finally {
        await client.close();
      }
    });
  },
  180_000,
);
