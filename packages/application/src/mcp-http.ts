import type { CapabilityValue } from "./capabilities.js";
import { McpRefusal, SafeMcpHttpClient } from "./mcp-network.js";

/** Explicit legacy protocol pin, not negotiation to a server-selected protocol version. */
export const MCP_DISCOVERY_PROTOCOL = "2025-11-25";
// Engineering bounds: one discovery cannot create unbounded candidates, nesting or pages.
const DISCOVERY_LIMITS = {
  candidates: 256,
  pages: 16,
  depth: 16,
  nodes: 16_384,
  text: 16_384,
} as const;

type JsonObject = { readonly [key: string]: CapabilityValue };
export interface McpDiscoveredCandidate {
  readonly id: string;
  readonly kind: "tool" | "resource" | "prompt";
  readonly schema: JsonObject;
  readonly schemaHash: string;
  readonly metadata: JsonObject;
  readonly enabled: false;
  readonly effectClass: "external-write";
}
export interface McpDiscoverySnapshot {
  readonly protocolVersion: typeof MCP_DISCOVERY_PROTOCOL;
  readonly serverIdentity: JsonObject;
  readonly protocolMetadata: JsonObject;
  readonly candidates: readonly McpDiscoveredCandidate[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new McpRefusal("invalid_discovery");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > DISCOVERY_LIMITS.text)
    throw new McpRefusal("invalid_discovery");
  return value;
}
function jsonValue(input: unknown): CapabilityValue {
  let nodes = 0;
  const visit = (value: unknown, depth: number): CapabilityValue => {
    if (++nodes > DISCOVERY_LIMITS.nodes || depth > DISCOVERY_LIMITS.depth)
      throw new McpRefusal("discovery_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= DISCOVERY_LIMITS.text) return value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    if (typeof value === "object" && value !== null) {
      const result = Object.create(null) as Record<string, CapabilityValue>;
      for (const [key, entry] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new McpRefusal("malicious_schema");
        result[key] = visit(entry, depth + 1);
      }
      return result;
    }
    throw new McpRefusal("invalid_discovery");
  };
  return visit(input, 0);
}
function jsonObject(input: unknown): JsonObject {
  object(input);
  return jsonValue(input) as JsonObject;
}

/** A bounded JSON Schema subset without remote references, executable keywords or regex engines. */
function schema(input: unknown): JsonObject {
  const value = jsonObject(input);
  const forbidden = new Set([
    "$ref",
    "$dynamicRef",
    "$recursiveRef",
    "$id",
    "pattern",
    "patternProperties",
    "contentSchema",
  ]);
  const check = (node: CapabilityValue): void => {
    if (Array.isArray(node)) {
      for (const child of node) check(child);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (forbidden.has(key)) throw new McpRefusal("malicious_schema");
        check(child);
      }
    }
  };
  check(value);
  const visit = (entry: JsonObject): void => {
    for (const [key, child] of Object.entries(entry)) {
      if (key === "properties" || key === "$defs" || key === "definitions") {
        for (const nested of Object.values(object(child))) visit(jsonObject(nested));
      } else if (
        [
          "items",
          "additionalProperties",
          "not",
          "if",
          "then",
          "else",
          "contains",
          "propertyNames",
        ].includes(key)
      ) {
        if (typeof child !== "boolean") visit(jsonObject(child));
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(child)) throw new McpRefusal("malicious_schema");
        for (const nested of child) visit(jsonObject(nested));
      }
    }
    if (
      entry.type !== undefined &&
      !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
        String(entry.type),
      )
    )
      throw new McpRefusal("malicious_schema");
  };
  visit(value);
  if (value.type !== "object") throw new McpRefusal("malicious_schema");
  return value;
}

function canonical(value: CapabilityValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function hash(value: CapabilityValue): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rpcBody(body: string, contentType: string, id: number): Record<string, unknown> {
  let value: unknown;
  try {
    if (contentType.split(";", 1)[0]?.trim() === "application/json") value = JSON.parse(body);
    else if (contentType.split(";", 1)[0]?.trim() === "text/event-stream") {
      const messages = body
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
      value = messages.find((message) => object(message).id === id);
      // Server requests, notifications and instructions never execute or acquire policy authority.
    } else throw new McpRefusal("unsupported_content_type");
  } catch (error) {
    if (error instanceof McpRefusal) throw error;
    throw new McpRefusal("invalid_json");
  }
  const message = object(value);
  if (
    message.jsonrpc !== "2.0" ||
    message.id !== id ||
    message.error !== undefined ||
    message.result === undefined
  )
    throw new McpRefusal("invalid_rpc_response");
  return object(message.result);
}

/** Discovery only. This class cannot invoke tools, read resources or install policy. */
export class RemoteHttpMcpDiscovery {
  constructor(private readonly http: SafeMcpHttpClient) {}

  async discover(endpoint: string, authorization?: string): Promise<McpDiscoverySnapshot> {
    try {
      return await this.connection(endpoint, authorization);
    } catch (error) {
      if (error instanceof McpRefusal) throw error;
      throw new McpRefusal("discovery_failed");
    }
  }

  private async connection(
    endpoint: string,
    authorization?: string,
  ): Promise<McpDiscoverySnapshot> {
    let nextId = 0;
    let session: string | undefined;
    const headers = (): Headers => {
      const result = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      });
      if (authorization) result.set("Authorization", authorization);
      if (session) result.set("Mcp-Session-Id", session);
      if (nextId > 1) result.set("MCP-Protocol-Version", MCP_DISCOVERY_PROTOCOL);
      return result;
    };
    const rpc = async (method: string, params: JsonObject): Promise<Record<string, unknown>> => {
      const id = ++nextId;
      const response = await this.http.request(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (response.status !== 200) throw new McpRefusal("discovery_http_failed");
      if (authorization && response.body.includes(authorization.replace(/^Bearer\s+/iu, "")))
        throw new McpRefusal("credential_echo_refused");
      const returnedSession = response.headers.get("Mcp-Session-Id");
      if (returnedSession !== null) {
        if (
          !/^[\x21-\x7e]{1,256}$/u.test(returnedSession) ||
          (session !== undefined && session !== returnedSession)
        )
          throw new McpRefusal("invalid_session");
        session = returnedSession;
      }
      const result = jsonObject(
        rpcBody(response.body, response.headers.get("Content-Type") ?? "", id),
      );
      if (authorization) {
        const token = authorization.replace(/^Bearer\s+/iu, "");
        const pending: CapabilityValue[] = [result];
        while (pending.length) {
          const node = pending.pop();
          if (typeof node === "string" && node.includes(token))
            throw new McpRefusal("credential_echo_refused");
          if (node !== null && typeof node === "object") {
            for (const [key, child] of Object.entries(node)) {
              if (key.includes(token)) throw new McpRefusal("credential_echo_refused");
              pending.push(child);
            }
          }
        }
      }
      return result;
    };
    const initialized = await rpc("initialize", {
      protocolVersion: MCP_DISCOVERY_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "clockgrove", version: "1" },
    });
    if (initialized.protocolVersion !== MCP_DISCOVERY_PROTOCOL)
      throw new McpRefusal("protocol_version_refused");
    const identity = jsonObject(initialized.serverInfo);
    text(identity.name);
    text(identity.version);
    const capabilities = jsonObject(initialized.capabilities);
    const notification = await this.http.request(endpoint, {
      method: "POST",
      headers: new Headers([...headers(), ["MCP-Protocol-Version", MCP_DISCOVERY_PROTOCOL]]),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    if (notification.status !== 202 && notification.status !== 204)
      throw new McpRefusal("initialization_failed");
    const candidates: McpDiscoveredCandidate[] = [];
    const unique = new Set<string>();
    for (const [kind, method, field, capability] of [
      ["tool", "tools/list", "tools", "tools"],
      ["resource", "resources/list", "resources", "resources"],
      ["resource", "resources/templates/list", "resourceTemplates", "resources"],
      ["prompt", "prompts/list", "prompts", "prompts"],
    ] as const) {
      if (capabilities[capability] === undefined) continue;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < DISCOVERY_LIMITS.pages; page++) {
        const listed = await rpc(method, cursor === undefined ? {} : { cursor });
        const entries = listed[field];
        if (!Array.isArray(entries)) throw new McpRefusal("invalid_discovery");
        for (const entry of entries) {
          if (candidates.length >= DISCOVERY_LIMITS.candidates)
            throw new McpRefusal("discovery_limit");
          const metadata = jsonObject(entry);
          const id = text(
            kind === "resource"
              ? field === "resourceTemplates"
                ? metadata.uriTemplate
                : metadata.uri
              : metadata.name,
          );
          if (unique.has(`${kind}:${id}`)) throw new McpRefusal("duplicate_candidate");
          unique.add(`${kind}:${id}`);
          const inputSchema = kind === "tool" ? schema(metadata.inputSchema) : metadata;
          if (kind === "tool" && metadata.outputSchema !== undefined) schema(metadata.outputSchema);
          const pinned =
            kind === "tool"
              ? {
                  inputSchema,
                  ...(metadata.outputSchema === undefined
                    ? {}
                    : { outputSchema: metadata.outputSchema }),
                }
              : inputSchema;
          candidates.push({
            id,
            kind,
            schema: inputSchema,
            schemaHash: await hash(pinned),
            metadata,
            enabled: false,
            effectClass: "external-write",
          });
        }
        if (listed.nextCursor === undefined) break;
        cursor = text(listed.nextCursor);
        if (cursors.has(cursor) || page === DISCOVERY_LIMITS.pages - 1)
          throw new McpRefusal("discovery_limit");
        cursors.add(cursor);
      }
    }
    return {
      protocolVersion: MCP_DISCOVERY_PROTOCOL,
      serverIdentity: identity,
      protocolMetadata: capabilities,
      candidates,
    };
  }
}
