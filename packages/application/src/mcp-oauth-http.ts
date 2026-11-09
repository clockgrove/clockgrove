import { McpCredentialError, type McpOAuthNetwork } from "./mcp-credentials.js";
import type { SafeMcpHttpClient } from "./mcp-network.js";

/** OAuth uses the same address admission, redirect policy and response limits as MCP discovery. */
export class McpOAuthHttpNetwork implements McpOAuthNetwork {
  constructor(private readonly http: SafeMcpHttpClient) {}

  async validate(url: string): Promise<void> {
    try {
      await this.http.validate(url);
    } catch {
      throw new McpCredentialError();
    }
  }

  async json(
    url: string,
    init?: { readonly method: "POST"; readonly body: URLSearchParams },
  ): Promise<unknown> {
    try {
      const response = await this.http.request(url, {
        method: init?.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(init ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(init ? { body: init.body } : {}),
      });
      if (response.status !== 200) throw new McpCredentialError();
      if (response.body === "") return undefined;
      if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json")
        throw new McpCredentialError();
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new McpCredentialError();
    }
  }
}
