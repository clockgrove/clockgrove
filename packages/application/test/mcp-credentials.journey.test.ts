import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  McpCredentialVault,
  type McpSealedCredential,
  type McpSecretStorage,
} from "../src/mcp-credentials.js";
import { SafeMcpHttpClient } from "../src/mcp-network.js";
import { McpOAuthHttpNetwork } from "../src/mcp-oauth-http.js";

it("foundation-only encrypted storage completes OAuth through a local HTTP issuer and blocks uncertain refresh", async () => {
  const requests: Record<string, string>[] = [];
  let uncertain = false;
  let releaseRefresh: (() => void) | undefined;
  let startedRefresh: (() => void) | undefined;
  let refreshGate: Promise<void> | undefined;
  const issuer = "https://issuer.example";
  const resource = "https://mcp.example/tools";
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/.well-known/oauth-protected-resource/tools")
      res.end(JSON.stringify({ resource, authorization_servers: [issuer] }));
    else if (req.url === "/.well-known/oauth-authorization-server")
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          revocation_endpoint: `${issuer}/revoke`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        }),
      );
    else {
      const params = Object.fromEntries(new URLSearchParams(body));
      requests.push(params);
      if (params.grant_type === "refresh_token" && refreshGate) {
        startedRefresh?.();
        await refreshGate;
      }
      if (uncertain) {
        req.socket.destroy();
        return;
      }
      if (req.url === "/revoke") {
        res.end();
        return;
      }
      res.end(
        JSON.stringify({
          token_type: "bearer",
          access_token: params.grant_type === "refresh_token" ? "rotated-canary" : "access-canary",
          refresh_token:
            params.grant_type === "refresh_token" ? "refresh-rotated-canary" : "refresh-canary",
          expires_in: 3600,
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  // Fake-only secret storage; production integration must supply durable CAS and fencing.
  const rows = new Map<string, McpSealedCredential>();
  let beforeFence: (() => Promise<void>) | undefined;
  const storage: McpSecretStorage = {
    async read(ref) {
      return rows.get(ref);
    },
    async fence(ref) {
      await beforeFence?.();
      const row = rows.get(ref);
      if (!row) return undefined;
      const fenced = { ...row, revocationRequested: true };
      rows.set(ref, fenced);
      return fenced;
    },
    async compareAndSwap(ref, revision, value) {
      const current = rows.get(ref);
      if (
        (current?.revision ?? null) !== revision ||
        (current?.revocationRequested && value.state !== "revoked")
      )
        return false;
      rows.set(ref, {
        ...value,
        ...(current?.revocationRequested ? { revocationRequested: true } : {}),
      });
      return true;
    },
  };
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const network = new McpOAuthHttpNetwork(
    new SafeMcpHttpClient({
      async resolve() {
        return ["93.184.216.34"];
      },
      request(url, init, admitted) {
        expect(admitted).toEqual(["93.184.216.34"]);
        // Test-only routing to the local HTTP issuer; production has no loopback switch.
        return fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init);
      },
    }),
  );
  const vault = new McpCredentialVault(
    storage,
    "credential-v1",
    new Map([["credential-v1", key]]),
    network,
  );
  const competitor = new McpCredentialVault(
    storage,
    "credential-v1",
    new Map([["credential-v1", key]]),
    network,
  );
  const scope = {
    tenantId: "tenant",
    worldId: "world",
    timelineId: "timeline",
    installationId: "installation",
    ownerPrincipalId: "owner",
  };
  const begin = () =>
    vault.beginOAuth(scope, {
      issuer,
      resource,
      clientId: "registered-client",
      scopes: ["tools:read", "tools:execute"],
      redirectUri: "https://app.example/callback",
    });
  try {
    const pending = await begin();
    const auth = new URL(pending.authorizationUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toBe("tools:read tools:execute");
    const callback = { state: auth.searchParams.get("state")!, iss: issuer, code: "code-canary" };
    await expect(
      vault.completeOAuth(scope, pending.reference, { ...callback, iss: "https://wrong.example" }),
    ).rejects.toThrow("MCP credential unavailable");
    expect(requests).toEqual([]);
    await vault.completeOAuth(scope, pending.reference, callback);
    expect(requests[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "code-canary",
      client_id: "registered-client",
      redirect_uri: "https://app.example/callback",
      resource,
    });
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requests[0]!.code_verifier)),
    ).toString("base64url");
    expect(challenge).toBe(auth.searchParams.get("code_challenge"));
    await expect(vault.completeOAuth(scope, pending.reference, callback)).rejects.toThrow(
      "MCP credential unavailable",
    );
    await vault.use(scope, pending.reference, async (authorization) => {
      expect(authorization).toBe("Bearer access-canary");
    });
    await expect(
      vault.use({ ...scope, ownerPrincipalId: "other" }, pending.reference, async () => undefined),
    ).rejects.toThrow("MCP credential unavailable");
    await vault.refresh(scope, pending.reference);
    await vault.use(scope, pending.reference, async (authorization) => {
      expect(authorization).toBe("Bearer rotated-canary");
    });
    await vault.revoke(scope, pending.reference);
    expect(requests[2]).toEqual({
      token: "refresh-rotated-canary",
      client_id: "registered-client",
    });
    expect(rows.get(pending.reference)?.state).toBe("revoked");
    const next = await begin();
    await vault.completeOAuth(scope, next.reference, {
      ...callback,
      state: new URL(next.authorizationUrl).searchParams.get("state")!,
    });
    uncertain = true;
    await expect(vault.refresh(scope, next.reference)).rejects.toThrow(
      "MCP credential unavailable",
    );
    expect(rows.get(next.reference)?.state).toBe("blocked");
    await expect(vault.use(scope, next.reference, async () => undefined)).rejects.toThrow(
      "MCP credential unavailable",
    );
    await expect(vault.revoke(scope, next.reference)).rejects.toThrow("MCP credential unavailable");
    expect(rows.get(next.reference)?.state).toBe("blocked");
    await expect(vault.use(scope, next.reference, async () => undefined)).rejects.toThrow(
      "MCP credential unavailable",
    );
    uncertain = false;
    await vault.revoke(scope, next.reference);
    const raced = await begin();
    await vault.completeOAuth(scope, raced.reference, {
      ...callback,
      state: new URL(raced.authorizationUrl).searchParams.get("state")!,
    });
    refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      startedRefresh = resolve;
    });
    // Attach the rejection assertion before releasing the fixture response.
    const refreshing = expect(vault.refresh(scope, raced.reference)).rejects.toThrow(
      "MCP credential unavailable",
    );
    await refreshStarted;
    await vault.revoke(scope, raced.reference);
    releaseRefresh!();
    await refreshing;
    expect(rows.get(raced.reference)?.state).toBe("revoked");
    await expect(vault.use(scope, raced.reference, async () => undefined)).rejects.toThrow(
      "MCP credential unavailable",
    );
    refreshGate = undefined;
    const stale = await begin();
    await vault.completeOAuth(scope, stale.reference, {
      ...callback,
      state: new URL(stale.authorizationUrl).searchParams.get("state")!,
    });
    let releaseFence!: () => void;
    let fenceStarted!: () => void;
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const fenceEntered = new Promise<void>((resolve) => {
      fenceStarted = resolve;
    });
    beforeFence = async () => {
      fenceStarted();
      await fenceGate;
    };
    const revoking = vault.revoke(scope, stale.reference);
    await fenceEntered;
    await competitor.refresh(scope, stale.reference);
    releaseFence();
    await revoking;
    beforeFence = undefined;
    expect(rows.get(stale.reference)?.revocationRequested).toBe(true);
    await expect(competitor.use(scope, stale.reference, async () => undefined)).rejects.toThrow(
      "MCP credential unavailable",
    );
    const staticRef = await vault.store(scope, "static-canary");
    await vault.use(scope, staticRef, async (authorization) => {
      expect(authorization).toBe("Bearer static-canary");
    });
    const row = rows.get(staticRef)!;
    rows.set(staticRef, { ...row, ciphertext: [0, ...row.ciphertext.slice(1)] });
    await expect(vault.use(scope, staticRef, async () => undefined)).rejects.toThrow(
      "MCP credential unavailable",
    );
    expect(JSON.stringify([...rows.values()])).not.toContain("canary");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
