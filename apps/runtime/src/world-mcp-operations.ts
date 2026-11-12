import { decodeRuntimeActionInput, decodeRuntimeStateInput } from "./inspector.js";
import {
  WORLD_MCP_READ_MAX_ARGUMENT_BYTES,
  type WorldMcpReadApplication,
} from "./world-mcp-reads.js";

export const WORLD_MCP_OPERATION_TOOLS = [
  "runtime_state",
  "runtime_action",
  "changeset_prepare",
  "changeset_apply",
] as const;
export type WorldMcpOperationTool = (typeof WORLD_MCP_OPERATION_TOOLS)[number];
export type WorldMcpOperationResult =
  | { readonly ok: true; readonly status: number; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code:
        | "invalid_tool_input"
        | "authentication_refused"
        | "authorization_refused"
        | "operation_rate_limited"
        | "operation_refused"
        | "operation_unavailable"
        | "changesets_unavailable_until_wave_7";
    };

/** Internal dispatch only; the application routes own membership, grants, audits and effects. */
export async function operateWorldMcpTool(
  application: WorldMcpReadApplication,
  invocation: unknown,
  credential: string,
): Promise<WorldMcpOperationResult> {
  let name: WorldMcpOperationTool;
  let body: string;
  try {
    if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation))
      throw new Error("invalid invocation");
    const input = invocation as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(",") !== "arguments,name" ||
      !WORLD_MCP_OPERATION_TOOLS.some((tool) => tool === input.name)
    )
      throw new Error("unknown tool");
    name = input.name as WorldMcpOperationTool;
    const decode = name === "runtime_action" ? decodeRuntimeActionInput : decodeRuntimeStateInput;
    decode(input.arguments);
    body = JSON.stringify(input.arguments);
    if (
      body === undefined ||
      new TextEncoder().encode(body).length > WORLD_MCP_READ_MAX_ARGUMENT_BYTES
    )
      throw new Error("arguments exceed limit");
    decode(JSON.parse(body));
  } catch {
    return { ok: false, status: 400, code: "invalid_tool_input" };
  }
  if (typeof credential !== "string" || !/^\S+$/u.test(credential))
    return { ok: false, status: 401, code: "authentication_refused" };
  if (name === "changeset_prepare" || name === "changeset_apply")
    return { ok: false, status: 409, code: "changesets_unavailable_until_wave_7" };
  try {
    const path = name === "runtime_state" ? "/v1/runtime/runtime-state" : "/v1/runtime/actions";
    const response = await application.fetch(
      new Request(`https://world-mcp.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body,
      }),
    );
    if (response.ok) return { ok: true, status: response.status, value: await response.json() };
    const status = response.status;
    const code =
      status === 401
        ? "authentication_refused"
        : status === 403
          ? "authorization_refused"
          : status === 429
            ? "operation_rate_limited"
            : status >= 500
              ? "operation_unavailable"
              : "operation_refused";
    return { ok: false, status, code };
  } catch {
    return { ok: false, status: 503, code: "operation_unavailable" };
  }
}
