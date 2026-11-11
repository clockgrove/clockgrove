import {
  decodeEntitySelectionRequest,
  decodeObservationRequest,
  decodeRunInspectRequest,
  decodeRunSearchRequest,
  decodeWorldDirectoryRequest,
} from "@clockgrove/contracts";
import { decodeCausalChainInput } from "./inspector.js";

// Engineering decision for metadata reads: bound serialized arguments at 64 KiB in addition to
// each application's strict decoder. This is not an MCP protocol limit.
export const WORLD_MCP_READ_MAX_ARGUMENT_BYTES = 64 * 1024;

export const WORLD_MCP_READ_TOOLS = [
  "world_directory",
  "world_status",
  "entity_inspect",
  "command_receipt",
  "run_receipt",
  "run_search",
] as const;
export type WorldMcpReadTool = (typeof WORLD_MCP_READ_TOOLS)[number];

/** Trusted in-process RuntimeWorker dispatch; never a caller-selected network client. */
export interface WorldMcpReadApplication {
  fetch(request: Request): Promise<Response>;
}

export type WorldMcpReadResult =
  | { readonly ok: true; readonly status: number; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code:
        | "invalid_tool_input"
        | "authentication_refused"
        | "authorization_refused"
        | "read_rate_limited"
        | "read_refused"
        | "read_unavailable";
    };

const reads: Readonly<
  Record<WorldMcpReadTool, { readonly path: string; readonly decode: (value: unknown) => unknown }>
> = {
  world_directory: {
    path: "/v1/runtime/world-directory",
    decode: decodeWorldDirectoryRequest,
  },
  world_status: { path: "/v1/runtime/world-status", decode: decodeObservationRequest },
  entity_inspect: { path: "/v1/runtime/entity", decode: decodeEntitySelectionRequest },
  command_receipt: {
    path: "/v1/runtime/causal-chain",
    decode(value) {
      const entry = decodeCausalChainInput(value);
      if (!("commandId" in entry)) throw new Error("command entry required");
      return entry;
    },
  },
  run_receipt: { path: "/v1/runtime/runs/inspect", decode: decodeRunInspectRequest },
  run_search: { path: "/v1/runtime/runs/search", decode: decodeRunSearchRequest },
};

/** An internal tool adapter, with fresh credentials on every call and no retained connection state. */
export async function readWorldMcpTool(
  application: WorldMcpReadApplication,
  invocation: unknown,
  credential: string,
): Promise<WorldMcpReadResult> {
  let path: string;
  let body: string;
  try {
    if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation))
      throw new Error("tool invocation required");
    const input = invocation as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(",") !== "arguments,name" ||
      typeof input.name !== "string" ||
      !WORLD_MCP_READ_TOOLS.some((name) => name === input.name)
    )
      throw new Error("unknown tool or invocation fields");
    const read = reads[input.name as WorldMcpReadTool];
    read.decode(input.arguments);
    body = JSON.stringify(input.arguments);
    if (
      body === undefined ||
      new TextEncoder().encode(body).length > WORLD_MCP_READ_MAX_ARGUMENT_BYTES
    )
      throw new Error("arguments exceed limit");
    // Validate the bytes that are actually dispatched, without forwarding non-JSON caller values.
    read.decode(JSON.parse(body));
    path = read.path;
  } catch {
    return { ok: false, status: 400, code: "invalid_tool_input" };
  }
  if (typeof credential !== "string" || !/^\S+$/u.test(credential))
    return { ok: false, status: 401, code: "authentication_refused" };
  try {
    const response = await application.fetch(
      new Request(`https://world-mcp.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body,
      }),
    );
    if (response.ok) return { ok: true, status: response.status, value: await response.json() };
    // Response text and exceptions can contain private context; only fixed categories cross MCP.
    const status = response.status;
    const code =
      status === 401
        ? "authentication_refused"
        : status === 403
          ? "authorization_refused"
          : status === 429
            ? "read_rate_limited"
            : status >= 500
              ? "read_unavailable"
              : "read_refused";
    return { ok: false, status, code };
  } catch {
    return { ok: false, status: 503, code: "read_unavailable" };
  }
}
