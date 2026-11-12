import { decodeCanonicalNode } from "@clockgrove/application";
import { decodeWorldCommandInput } from "./world-commands.js";
import {
  WORLD_MCP_READ_MAX_ARGUMENT_BYTES,
  type WorldMcpReadApplication,
} from "./world-mcp-reads.js";

export interface WorldMcpApplication extends WorldMcpReadApplication {
  /** Bound by the endpoint to this request's verified credential client, never MCP client metadata. */
  submitCommand?(request: Request): Promise<Response>;
}

export async function submitWorldMcpCommand(
  application: WorldMcpApplication,
  args: unknown,
  credential: string,
) {
  let body: string;
  try {
    decodeWorldCommandInput(args);
    body = JSON.stringify(args);
    if (new TextEncoder().encode(body).byteLength > WORLD_MCP_READ_MAX_ARGUMENT_BYTES)
      throw new Error("arguments exceed limit");
    decodeWorldCommandInput(JSON.parse(body));
  } catch {
    return { ok: false, status: 400, code: "invalid_tool_input" } as const;
  }
  if (typeof credential !== "string" || !/^\S+$/u.test(credential))
    return { ok: false, status: 401, code: "authentication_refused" } as const;
  if (!application.submitCommand)
    return { ok: false, status: 503, code: "command_unavailable" } as const;
  try {
    const response = await application.submitCommand(
      new Request("https://world-mcp.internal/v1/runtime/commands", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body,
      }),
    );
    if ([200, 403, 409].includes(response.status)) {
      const value: unknown = await response.json();
      try {
        const receipt = decodeCanonicalNode(value) as { commandId?: unknown; outcome?: unknown };
        if (
          typeof receipt.commandId === "string" &&
          ["committed", "rejected"].includes(String(receipt.outcome))
        )
          return { ok: true, status: response.status, value } as const;
      } catch {
        // Only ordinary canonical receipts cross this boundary; other errors use fixed categories.
      }
    }
    const status = response.status;
    return {
      ok: false,
      status,
      code:
        status === 401
          ? "authentication_refused"
          : status === 403
            ? "authorization_refused"
            : status === 429
              ? "command_rate_limited"
              : status >= 500
                ? "command_unavailable"
                : "command_refused",
    } as const;
  } catch {
    return { ok: false, status: 503, code: "command_unavailable" } as const;
  }
}
