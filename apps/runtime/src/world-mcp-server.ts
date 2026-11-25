import { MAX_RUN_SEARCH_PAGE, RUN_STATUSES } from "@clockgrove/contracts";
import { fromJsonSchema, type JsonSchemaType, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { submitWorldMcpCommand, type WorldMcpApplication } from "./world-mcp-commands.js";
import {
  operateWorldMcpTool,
  WORLD_MCP_OPERATION_TOOLS,
  type WorldMcpOperationTool,
} from "./world-mcp-operations.js";
import {
  readWorldMcpTool,
  WORLD_MCP_READ_TOOLS,
  type WorldMcpReadTool,
  worldDebuggerLink,
} from "./world-mcp-reads.js";

// Engineering decision: 64 KiB application arguments plus room for the protocol envelope.
export const WORLD_MCP_MAX_REQUEST_BYTES = 128 * 1024;
const id = { type: "string", minLength: 1 } as const;
const scope = { tenantId: id, worldId: id, timelineId: id, spaceId: id };
const version = { type: "integer", const: 1 } as const;
function envelope(
  properties: Record<string, JsonSchemaType>,
  required = Object.keys(properties),
): JsonSchemaType {
  return { type: "object", properties, required, additionalProperties: false };
}
const scoped = { version, ...scope };
const entries = ["runId", "commandId", "sessionId", "turn", "messageId"];
const schemas: Record<WorldMcpReadTool, JsonSchemaType> = {
  world_directory: envelope({ version }),
  world_status: envelope(scoped),
  entity_inspect: envelope(
    {
      ...scoped,
      objectId: id,
      cursor: envelope({
        observedRevision: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        beforeSequence: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      }),
    },
    [...Object.keys(scoped), "objectId"],
  ),
  command_receipt: envelope({ schemaVersion: version, ...scope, commandId: id }),
  run_receipt: {
    ...envelope(
      {
        ...scoped,
        runId: id,
        commandId: id,
        sessionId: id,
        turn: { type: "integer", minimum: 1, maximum: 500 },
        messageId: id,
      },
      Object.keys(scoped),
    ),
    oneOf: [["runId"], ["commandId"], ["sessionId", "turn"], ["sessionId", "messageId"]].map(
      (required) => ({
        required,
        not: {
          anyOf: entries
            .filter((key) => !required.includes(key))
            .map((key) => ({ required: [key] })),
        },
      }),
    ),
  },
  run_search: envelope(
    {
      ...scoped,
      actorId: id,
      sessionId: id,
      status: { type: "string", enum: [...RUN_STATUSES] },
      limit: { type: "integer", minimum: 1, maximum: MAX_RUN_SEARCH_PAGE },
    },
    Object.keys(scoped),
  ),
  world_journal: envelope(
    {
      schemaVersion: version,
      ...scope,
      beforeSequence: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
      replayTo: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
    },
    ["schemaVersion", ...Object.keys(scope)],
  ),
  event_why: {
    ...envelope(
      {
        ...scoped,
        eventId: id,
        commandId: id,
        scheduleId: id,
        idempotencyKey: id,
        includeResourceCauses: { type: "boolean", const: true },
      },
      Object.keys(scoped),
    ),
    oneOf: [["eventId"], ["commandId"], ["scheduleId", "idempotencyKey"]].map((required) => ({
      required,
      not: {
        anyOf: ["eventId", "commandId", "scheduleId", "idempotencyKey"]
          .filter((key) => !required.includes(key))
          .map((key) => ({ required: [key] })),
      },
    })),
  },
};
const readDescriptions: Partial<Record<WorldMcpReadTool, string>> = {
  world_journal:
    "Read a page of the world journal under the existing inspector authority (runtime:world-inspect).",
  event_why:
    "Explain why a recorded event, command or schedule happened, from public decision evidence only.",
};
const commandSchema = envelope({
  schemaVersion: version,
  ...scope,
  routingEpoch: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  authorityEpoch: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  command: { type: "array" },
});
const operationScope = { schemaVersion: version, ...scope };
const operationSchemas: Record<WorldMcpOperationTool, JsonSchemaType> = {
  runtime_state: envelope(operationScope),
  runtime_action: envelope({
    ...operationScope,
    action: { type: "string", enum: ["repair-publication", "replay-message"] },
    messageId: id,
  }),
  changeset_prepare: envelope(operationScope),
  changeset_apply: envelope(operationScope),
};
function refusal(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status });
}
export async function boundedWorldMcpBody(
  request: Request,
): Promise<{ readonly text: string; readonly byteLength: number }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", byteLength: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > WORLD_MCP_MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: size };
}
/** Internal transport only: public credential and principal-budget composition must precede routing. */
export async function handleWorldMcpRequest(
  application: WorldMcpApplication,
  request: Request,
): Promise<Response> {
  const credential = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const authentication = await readWorldMcpTool(
    application,
    { name: "world_directory", arguments: { version: 1 } },
    credential,
  );
  if (!authentication.ok) return refusal(authentication.status, authentication.code);
  if (request.method !== "POST") return refusal(405, "method_refused");
  let body: string;
  try {
    body = (await boundedWorldMcpBody(request)).text;
  } catch {
    return refusal(413, "invalid_request_body");
  }
  try {
    const input: unknown = JSON.parse(body);
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return refusal(400, "invalid_request_body");
    // No retained subscriptions, streams, conversation, or session operations.
    if (
      !("method" in input) ||
      ![
        "initialize",
        "notifications/initialized",
        "server/discover",
        "tools/list",
        "tools/call",
        "ping",
      ].includes(String(input.method))
    )
      return refusal(400, "method_refused");
    let applicationErrorText: string | undefined;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "clockgrove-world", version: "1.0.0" },
          {
            instructions:
              "Successful world reads carry `debugger`, a path into the world debugger on the origin serving this MCP endpoint. The debugger is owner-only and opens after signing in.",
          },
        );
        for (const name of WORLD_MCP_READ_TOOLS) {
          server.registerTool(
            name,
            {
              inputSchema: fromJsonSchema(schemas[name]),
              annotations: { readOnlyHint: true },
              ...(readDescriptions[name] && { description: readDescriptions[name] }),
            },
            async (args) => {
              const result = await readWorldMcpTool(
                application,
                { name, arguments: args },
                credential,
              );
              const link = result.ok ? worldDebuggerLink(name, args) : undefined;
              const text = JSON.stringify(
                link === undefined ? result : { ...result, debugger: link },
              );
              if (!result.ok) applicationErrorText = text;
              return { content: [{ type: "text", text }], ...(!result.ok && { isError: true }) };
            },
          );
        }
        for (const name of WORLD_MCP_OPERATION_TOOLS) {
          server.registerTool(
            name,
            {
              inputSchema: fromJsonSchema(operationSchemas[name]),
              annotations: { readOnlyHint: name !== "runtime_action" },
              ...((name === "changeset_prepare" || name === "changeset_apply") && {
                description:
                  "Placeholder: unavailable until Wave 7; always refuses without mutation.",
              }),
            },
            async (args) => {
              const result = await operateWorldMcpTool(
                application,
                { name, arguments: args },
                credential,
              );
              const text = JSON.stringify(result);
              if (!result.ok) applicationErrorText = text;
              return { content: [{ type: "text", text }], ...(!result.ok && { isError: true }) };
            },
          );
        }
        server.registerTool(
          "command_submit",
          {
            inputSchema: fromJsonSchema(commandSchema),
            annotations: { readOnlyHint: false },
            description:
              "Submit an ordinary typed world command under current member authority; returns the web command receipt.",
          },
          async (args) => {
            const result = await submitWorldMcpCommand(application, args, credential);
            const text = JSON.stringify(result);
            if (!result.ok) applicationErrorText = text;
            return { content: [{ type: "text", text }], ...(!result.ok && { isError: true }) };
          },
        );
        return server;
      },
      {
        route: new URL(request.url).pathname,
        corsOptions: false,
        // Owner decision (#327, 2026-11-25): 2025-era clients connect through the SDK's
        // stateless legacy lane, which retains no session; authentication, grants and
        // tool envelopes are the same on both protocols.
        legacy: "stateless",
        responseMode: "json",
        maxRequestBodySize: WORLD_MCP_MAX_REQUEST_BYTES,
      },
    );
    const response = await handler.fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body,
        signal: request.signal,
      }),
    );
    if (!response.body) return response;
    const headers = new Headers(response.headers);
    let result: Record<string, unknown>;
    if (headers.get("content-type")?.includes("text/event-stream")) {
      // The legacy lane answers one finite event stream; return its single message as JSON.
      const data = (await response.text())
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (data.length !== 1) return refusal(400, "mcp_request_refused");
      result = JSON.parse(data[0]!) as Record<string, unknown>;
      headers.set("content-type", "application/json");
    } else result = (await response.json()) as Record<string, unknown>;
    if ("error" in result) {
      const error = result.error as { code?: unknown } | null;
      result.error = {
        code: typeof error?.code === "number" ? error.code : -32603,
        message: "mcp_request_refused",
      };
    }
    const toolResult = result.result as { isError?: boolean; content?: unknown } | undefined;
    if (
      toolResult?.isError &&
      JSON.stringify(toolResult.content) !==
        JSON.stringify([{ type: "text", text: applicationErrorText }])
    ) {
      result.result = {
        resultType: "complete",
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, status: 400, code: "invalid_tool_input" }),
          },
        ],
      };
    }
    return Response.json(result, { status: response.status, headers });
  } catch {
    return refusal(400, "mcp_request_refused");
  }
}
