/** Outbound MCP policy; all errors are fixed codes, never remote text or request values. */
export class McpRefusal extends Error {
  constructor(readonly code: string) {
    super(`MCP refused: ${code}`);
    this.name = "McpRefusal";
  }
}

/** Rebuild only policy refusals; messages, causes and arbitrary codes may contain credentials. */
export function safeMcpNetworkRefusal(error: unknown): McpRefusal | undefined {
  if (
    error instanceof McpRefusal &&
    [
      "invalid_url",
      "https_required",
      "url_credentials_or_query_refused",
      "private_target",
      "private_or_unresolved_target",
      "dns_changed",
      "invalid_redirect",
      "unsafe_redirect",
      "redirect_limit",
      "network_timeout",
      "network_failed",
      "response_too_large",
      "invalid_utf8",
    ].includes(error.code)
  )
    return new McpRefusal(error.code);
  return undefined;
}

/**
 * The trusted adapter connects only to admittedAddresses, retaining HTTPS hostname verification.
 * It must honor manual redirects and the abort signal, without logging credentials or bodies.
 */
export interface McpNetworkPort {
  resolve(hostname: string): Promise<readonly string[]>;
  request(url: string, init: RequestInit, admittedAddresses: readonly string[]): Promise<Response>;
}

// Engineering bounds: cap installation fan-out, remote memory and stalled connections.
export const MCP_HTTP_LIMITS = { redirects: 3, bytes: 1_048_576, timeoutMs: 15_000 } as const;

export function remoteMcpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new McpRefusal("invalid_url");
  }
  if (url.protocol !== "https:") throw new McpRefusal("https_required");
  if (url.username || url.password || url.hash || url.search)
    throw new McpRefusal("url_credentials_or_query_refused");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal") ||
    (!hostname.includes(".") && !hostname.includes(":"))
  )
    throw new McpRefusal("private_target");
  if ((hostname.includes(":") || /^[\d.]+$/u.test(hostname)) && !isPublicMcpAddress(hostname))
    throw new McpRefusal("private_target");
  return url;
}

/** Conservative public-unicast allowlist, refusing special-purpose IPv4 and IPv6 ranges. */
export function isPublicMcpAddress(address: string): boolean {
  const v4 = address.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
    const [a = 0, b = 0, c = 0] = v4.map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!/^[a-f\d:]+$/iu.test(address) || address.includes(":::")) return false;
  if (!address.includes("::") && (address.startsWith(":") || address.endsWith(":"))) return false;
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) return false;
  const left = (parts[0] ?? "").split(":").filter(Boolean);
  const right = (parts[1] ?? "").split(":").filter(Boolean);
  if ([...left, ...right].some((part) => !/^[a-f\d]{1,4}$/u.test(part))) return false;
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) return false;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  // Only currently allocated global unicast 2000::/3; exclude documentation, Teredo, 6to4,
  // benchmarking and the entire IETF special-purpose 2001::/23 allocation.
  return (
    (words[0] ?? 0) >= 0x2000 &&
    (words[0] ?? 0) <= 0x3fff &&
    words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && ((words[1] ?? 0) <= 0x1ff || words[1] === 0xdb8)) &&
    !(words[0] === 0x3fff && (words[1] ?? 0) <= 0xfff)
  );
}

export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/** Manual redirects, DNS checks per hop, bounded body and one deadline for the whole request. */
export class SafeMcpHttpClient {
  constructor(private readonly network: McpNetworkPort) {}

  /** Preflight only; a later browser navigation still uses the browser's own network policy. */
  async validate(input: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.addresses(remoteMcpUrl(input)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new McpRefusal("network_timeout")),
            MCP_HTTP_LIMITS.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof McpRefusal) throw error;
      throw new McpRefusal("network_failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(
    input: string,
    init: Omit<RequestInit, "redirect" | "signal">,
  ): Promise<McpHttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_HTTP_LIMITS.timeoutMs);
    try {
      return await Promise.race([
        this.perform(input, init, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new McpRefusal("network_timeout")),
            { once: true },
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof McpRefusal) throw error;
      throw new McpRefusal("network_failed");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async addresses(url: URL): Promise<readonly string[]> {
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const addresses =
      hostname.includes(":") || /^[\d.]+$/u.test(hostname)
        ? [hostname]
        : await this.network.resolve(hostname);
    if (addresses.length === 0 || addresses.some((address) => !isPublicMcpAddress(address)))
      throw new McpRefusal("private_or_unresolved_target");
    return [...new Set(addresses)].sort();
  }

  private async perform(
    input: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<McpHttpResponse> {
    let url = remoteMcpUrl(input);
    const initialOrigin = url.origin;
    for (let hop = 0; hop <= MCP_HTTP_LIMITS.redirects; hop++) {
      if (signal.aborted) throw new McpRefusal("network_timeout");
      const addresses = await this.addresses(url);
      if (signal.aborted) throw new McpRefusal("network_timeout");
      const response = await this.network.request(
        url.href,
        { ...init, redirect: "manual", signal },
        addresses,
      );
      try {
        const after = await this.addresses(url);
        if (addresses.join(",") !== after.join(",")) throw new McpRefusal("dns_changed");
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new McpRefusal("invalid_redirect");
          const next = remoteMcpUrl(new URL(location, url).href);
          // No automatic credential forwarding, method changes or redirect to another origin.
          if (next.origin !== initialOrigin || ![307, 308].includes(response.status))
            throw new McpRefusal("unsafe_redirect");
          if (hop === MCP_HTTP_LIMITS.redirects) throw new McpRefusal("redirect_limit");
          url = next;
          continue;
        }
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MCP_HTTP_LIMITS.bytes))
          throw new McpRefusal("response_too_large");
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > MCP_HTTP_LIMITS.bytes) throw new McpRefusal("response_too_large");
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new McpRefusal("invalid_utf8");
        }
        return { status: response.status, headers: response.headers, body };
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }
    throw new McpRefusal("redirect_limit");
  }
}
