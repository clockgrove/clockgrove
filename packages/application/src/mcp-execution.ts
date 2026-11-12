import type { CapabilityValue } from "./capabilities.js";
import type { McpCredentialScope, McpCredentialVault } from "./mcp-credentials.js";
import { MCP_DISCOVERY_PROTOCOL } from "./mcp-http.js";
import { McpRefusal, SafeMcpHttpClient, safeMcpNetworkRefusal } from "./mcp-network.js";

// Engineering bounds for one research result; the HTTP layer separately caps wire bytes/time.
export const MCP_READ_LIMITS = {
  argumentBytes: 65_536,
  outputBytes: 65_536,
  blocks: 32,
  depth: 16,
  nodes: 16_384,
} as const;
export interface AdmittedMcpRead {
  readonly admittedReadOnly: true;
  readonly endpoint: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, CapabilityValue>>;
  readonly credential?: { readonly scope: McpCredentialScope; readonly reference: string };
}
export interface McpReadEvidence {
  readonly trust: "untrusted_evidence";
  readonly status: "ok" | "tool_error";
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly sanitized: boolean;
  readonly costMicrousd: null;
}
export type McpReadFailureDisposition = "not_sent" | "uncertain" | "result_refused";
export class McpReadFailure extends Error {
  constructor(
    readonly code: string,
    readonly disposition: McpReadFailureDisposition,
  ) {
    super(`MCP read refused: ${code}`);
    this.name = "McpReadFailure";
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new McpRefusal("invalid_result");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, token?: string): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > MCP_READ_LIMITS.nodes || depth > MCP_READ_LIMITS.depth)
      throw new McpRefusal("content_limit");
    if (typeof node === "string") {
      if (token && node.includes(token)) throw new McpRefusal("credential_echo_refused");
    } else if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new McpRefusal("invalid_result");
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new McpRefusal("invalid_result");
        if (token && key.includes(token)) throw new McpRefusal("credential_echo_refused");
        visit(child, depth + 1);
      }
    } else if (node !== null && typeof node !== "boolean") throw new McpRefusal("invalid_result");
  };
  visit(value, 0);
}
function rpcResult(
  body: string,
  contentType: string,
  id: number,
  token?: string,
): Record<string, unknown> {
  if (token && body.includes(token)) throw new McpRefusal("credential_echo_refused");
  let messages: unknown[];
  try {
    if (contentType === "application/json") messages = [JSON.parse(body)];
    else if (contentType === "text/event-stream") {
      messages = body
        .replace(/\r\n/gu, "\n")
        .split("\n\n")
        .flatMap((event) => {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          return data ? [JSON.parse(data) as unknown] : [];
        });
    } else throw new McpRefusal("unsupported_content_type");
  } catch (error) {
    if (error instanceof McpRefusal) throw error;
    throw new McpRefusal("invalid_json");
  }
  bounded(messages, token);
  const matches = messages.filter((message) => object(message).id === id);
  if (matches.length !== 1) throw new McpRefusal("invalid_rpc_response");
  const message = object(matches[0]);
  if (message.jsonrpc !== "2.0" || message.error !== undefined || message.result === undefined)
    throw new McpRefusal("invalid_rpc_response");
  return object(message.result);
}
function evidence(result: Record<string, unknown>, outputBytes: number): McpReadEvidence {
  if (
    !Array.isArray(result.content) ||
    result.content.length > MCP_READ_LIMITS.blocks ||
    (result.isError !== undefined && typeof result.isError !== "boolean") ||
    Object.keys(result).some((key) => !["content", "isError", "_meta"].includes(key))
  )
    throw new McpRefusal("unsupported_result");
  let bytes = 0;
  let sanitized = false;
  const content = result.content.map((value) => {
    const block = object(value);
    if (
      block.type !== "text" ||
      typeof block.text !== "string" ||
      Object.keys(block).some((key) => !["type", "text", "annotations", "_meta"].includes(key))
    )
      throw new McpRefusal("unsupported_result");

    const text = [...block.text]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (code < 32 && ![9, 10, 13].includes(code)) ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
          ? "�"
          : character;
      })
      .join("");
    bytes += Math.max(
      new TextEncoder().encode(block.text).length,
      new TextEncoder().encode(text).length,
    );
    if (bytes > outputBytes) throw new McpRefusal("output_limit");
    sanitized ||= text !== block.text;
    return { type: "text" as const, text };
  });
  return {
    trust: "untrusted_evidence",
    status: result.isError ? "tool_error" : "ok",
    content,
    sanitized,
    costMicrousd: null,
  };
}

/** Validates a recorded or internal result before it can enter another model step. */
export function sanitizeMcpReadEvidence(value: unknown): McpReadEvidence {
  const held = object(value);
  if (
    held.trust !== "untrusted_evidence" ||
    !["ok", "tool_error"].includes(String(held.status)) ||
    typeof held.sanitized !== "boolean" ||
    held.costMicrousd !== null ||
    Object.keys(held).some(
      (key) => !["trust", "status", "content", "sanitized", "costMicrousd"].includes(key),
    )
  )
    throw new McpReadFailure("invalid_result", "result_refused");
  bounded(held);
  const result = evidence(
    { content: held.content, isError: held.status === "tool_error" },
    MCP_READ_LIMITS.outputBytes,
  );
  return { ...result, sanitized: result.sanitized || held.sanitized };
}

/** Internal transport only. Trusted admission, reservation, ledger and replay gates precede this adapter. */
export class RemoteHttpMcpReadAdapter {
  constructor(
    private readonly http: SafeMcpHttpClient,
    private readonly vault?: Pick<McpCredentialVault, "use">,
    private readonly outputBytes: number = MCP_READ_LIMITS.outputBytes,
  ) {}

  async execute(request: AdmittedMcpRead): Promise<McpReadEvidence> {
    let endpoint: string;
    let toolName: string;
    let credential: AdmittedMcpRead["credential"];
    let argumentsValue: Record<string, unknown>;
    try {
      endpoint = request.endpoint;
      toolName = request.toolName;
      credential = request.credential
        ? { scope: { ...request.credential.scope }, reference: request.credential.reference }
        : undefined;
      // Engineering tool-name bound, matching the ledger's reference-field scale.
      if (
        request.admittedReadOnly !== true ||
        typeof toolName !== "string" ||
        !toolName ||
        toolName.length > 1024 ||
        !Number.isSafeInteger(this.outputBytes) ||
        this.outputBytes < 1 ||
        this.outputBytes > MCP_READ_LIMITS.outputBytes
      )
        throw new Error();
      object(request.arguments);
      bounded(request.arguments);
      const encoded = JSON.stringify(request.arguments);
      if (new TextEncoder().encode(encoded).length > MCP_READ_LIMITS.argumentBytes)
        throw new Error();
      argumentsValue = object(JSON.parse(encoded));
      bounded(argumentsValue);
    } catch {
      throw new McpReadFailure("invalid_arguments", "not_sent");
    }
    // Capture an outcome inside use(): the vault intentionally replaces callback exception text.
    let lastStage: McpReadFailureDisposition = "not_sent";
    const send = async (authorization?: string): Promise<McpReadEvidence | McpReadFailure> => {
      let stage: McpReadFailureDisposition = "not_sent";
      try {
        let session: string | undefined;
        const transmittedAuthorization = new Headers(
          authorization ? { Authorization: authorization } : {},
        ).get("Authorization");
        const token = transmittedAuthorization?.replace(/^Bearer\s+/iu, "");
        const headers = (): Headers =>
          new Headers({
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_DISCOVERY_PROTOCOL,
            ...(authorization ? { Authorization: authorization } : {}),
            ...(session ? { "Mcp-Session-Id": session } : {}),
          });
        const rpc = async (
          id: number,
          method: string,
          params: object,
        ): Promise<Record<string, unknown>> => {
          const response = await this.http.request(
            endpoint,
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            },
            method === "tools/call" ? "refuse" : "follow",
          );
          if (method === "tools/call") stage = "result_refused";
          lastStage = stage;
          if (response.status !== 200) throw new McpRefusal("http_failed");
          const returned = response.headers.get("Mcp-Session-Id");
          if (returned !== null) {
            if (
              (token && returned.includes(token)) ||
              !/^[\x21-\x7e]{1,256}$/u.test(returned) ||
              (session !== undefined && session !== returned)
            )
              throw new McpRefusal("invalid_session");
            session = returned;
          }
          return rpcResult(
            response.body,
            response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "",
            id,
            token,
          );
        };
        const initialized = await rpc(1, "initialize", {
          protocolVersion: MCP_DISCOVERY_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "clockgrove", version: "1" },
        });
        if (
          initialized.protocolVersion !== MCP_DISCOVERY_PROTOCOL ||
          object(initialized.capabilities).tools === undefined
        )
          throw new McpRefusal("protocol_version_refused");
        const notified = await this.http.request(endpoint, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        if (![202, 204].includes(notified.status)) throw new McpRefusal("initialization_failed");
        stage = "uncertain";
        lastStage = stage;
        return evidence(
          await rpc(2, "tools/call", { name: toolName, arguments: argumentsValue }),
          this.outputBytes,
        );
      } catch (error) {
        const safe = safeMcpNetworkRefusal(error);
        const code =
          safe?.code ??
          (error instanceof McpRefusal &&
          [
            "invalid_result",
            "content_limit",
            "credential_echo_refused",
            "unsupported_content_type",
            "invalid_json",
            "invalid_rpc_response",
            "unsupported_result",
            "output_limit",
            "http_failed",
            "invalid_session",
            "protocol_version_refused",
            "initialization_failed",
          ].includes(error.code)
            ? error.code
            : "execution_failed");
        return new McpReadFailure(code, stage);
      }
    };
    let result: McpReadEvidence | McpReadFailure;
    try {
      if (credential) {
        if (!this.vault) throw new Error();
        result = await this.vault.use(credential.scope, credential.reference, send);
      } else result = await send();
    } catch {
      throw new McpReadFailure("credential_unavailable", lastStage);
    }
    if (result instanceof McpReadFailure) throw result;
    return result;
  }
}
