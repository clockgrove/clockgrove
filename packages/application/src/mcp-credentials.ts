/**
 * Reads are linearizable. CAS is durable and atomic; it never clears a revocation fence and
 * refuses every fenced transition except `revoked`. An uncertain fence operation makes reads
 * unavailable until reconciled, even if the original write did not commit.
 */
export interface McpSecretStorage {
  read(reference: string): Promise<McpSealedCredential | undefined>;
  /** Irreversibly fence use and return the latest envelope atomically, without altering its AAD. */
  fence(reference: string): Promise<McpSealedCredential | undefined>;
  compareAndSwap(
    reference: string,
    previousRevision: number | null,
    value: McpSealedCredential,
  ): Promise<boolean>;
}
export interface McpCredentialScope {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly installationId: string;
  readonly ownerPrincipalId: string;
}
export interface McpSealedCredential {
  readonly revocationRequested?: boolean;
  readonly revision: number;
  readonly state: "pending" | "active" | "blocked" | "revoked";
  readonly keyVersion: string;
  readonly wrappedKey: readonly number[];
  readonly wrapIv: readonly number[];
  readonly iv: readonly number[];
  readonly ciphertext: readonly number[];
}
export class McpCredentialError extends Error {
  constructor() {
    super("MCP credential unavailable");
  }
}
/** Trusted outbound adapter validates HTTPS destinations/DNS/redirects before sending,
 * rejects non-success HTTP responses, bounds response bodies, and returns undefined for empty success. */
export interface McpOAuthNetwork {
  validate(url: string): Promise<void>;
  json(
    url: string,
    init?: { readonly method: "POST"; readonly body: URLSearchParams },
  ): Promise<unknown>;
}
/** Explicitly registered public clients only; no dynamic registration or client secrets. */
export interface McpOAuthClient {
  readonly clientId: string;
  readonly issuer: string;
  readonly resource: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
}
interface OAuthBinding extends McpOAuthClient {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}
type Secret =
  | { kind: "static"; token: string }
  | { kind: "pending"; binding: OAuthBinding; state: string; verifier: string; deadline: number }
  | {
      kind: "oauth";
      binding: OAuthBinding;
      token: string;
      refreshToken?: string;
      expiresAt: number;
    };
const encoder = new TextEncoder();
function context(
  scope: McpCredentialScope,
  reference: string,
  revision: number,
  state: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      "mcp-credential-v1",
      scope.tenantId,
      scope.worldId,
      scope.timelineId,
      scope.installationId,
      scope.ownerPrincipalId,
      reference,
      revision,
      state,
    ]),
  );
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpCredentialError();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || /[\r\n]/u.test(value)) throw new McpCredentialError();
  return value;
}
function https(value: unknown): string {
  const result = text(value);
  const url = new URL(result);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new McpCredentialError();
  return result;
}
/** Dedicated credential keyring: never use ARTIFACT_KEYRING. No runtime routes are installed here. */
export class McpCredentialVault {
  constructor(
    private readonly storage: McpSecretStorage,
    private readonly activeVersion: string,
    private readonly keys: ReadonlyMap<string, Awaited<ReturnType<typeof crypto.subtle.importKey>>>,
    private readonly network?: McpOAuthNetwork,
    private readonly now: () => number = Date.now,
  ) {}
  private key(version: string): Awaited<ReturnType<typeof crypto.subtle.importKey>> {
    const key = this.keys.get(version);
    if (!key) throw new McpCredentialError();
    return key;
  }
  private async seal(
    scope: McpCredentialScope,
    reference: string,
    secret: Secret,
    revision: number,
    state: McpSealedCredential["state"],
  ): Promise<McpSealedCredential> {
    // AES-256 data key and standard 96-bit GCM IVs, independently randomized per envelope.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const bytes = encoder.encode(JSON.stringify(secret));
    try {
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapIv = crypto.getRandomValues(new Uint8Array(12));
      const additionalData = context(scope, reference, revision, state);
      return {
        revision,
        state,
        keyVersion: this.activeVersion,
        iv: [...iv],
        wrapIv: [...wrapIv],
        wrappedKey: [
          ...new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: wrapIv, additionalData },
              this.key(this.activeVersion),
              raw,
            ),
          ),
        ],
        ciphertext: [
          ...new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, bytes),
          ),
        ],
      };
    } finally {
      raw.fill(0);
      bytes.fill(0);
    }
  }
  private async open(
    scope: McpCredentialScope,
    reference: string,
    row: McpSealedCredential,
  ): Promise<Secret> {
    const additionalData = context(scope, reference, row.revision, row.state);
    const raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(row.wrapIv), additionalData },
        this.key(row.keyVersion),
        new Uint8Array(row.wrappedKey),
      ),
    );
    try {
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      const bytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(row.iv), additionalData },
          key,
          new Uint8Array(row.ciphertext),
        ),
      );
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as Secret;
      } finally {
        bytes.fill(0);
      }
    } finally {
      raw.fill(0);
    }
  }
  private async load(
    scope: McpCredentialScope,
    reference: string,
    state: McpSealedCredential["state"],
  ): Promise<{ row: McpSealedCredential; secret: Secret }> {
    const row = await this.storage.read(reference);
    if (!row || row.revocationRequested || row.state !== state) throw new McpCredentialError();
    return { row, secret: await this.open(scope, reference, row) };
  }
  private async replace(
    scope: McpCredentialScope,
    reference: string,
    row: McpSealedCredential,
    secret: Secret,
    state: McpSealedCredential["state"],
  ): Promise<McpSealedCredential> {
    const next = await this.seal(scope, reference, secret, row.revision + 1, state);
    if (!(await this.storage.compareAndSwap(reference, row.revision, next)))
      throw new McpCredentialError();
    return next;
  }
  private async create(
    scope: McpCredentialScope,
    secret: Secret,
    state: McpSealedCredential["state"],
  ): Promise<string> {
    const reference = crypto.randomUUID();
    if (
      !(await this.storage.compareAndSwap(
        reference,
        null,
        await this.seal(scope, reference, secret, 1, state),
      ))
    )
      throw new McpCredentialError();
    return reference;
  }
  async store(scope: McpCredentialScope, token: string): Promise<string> {
    try {
      return await this.create(scope, { kind: "static", token: text(token) }, "active");
    } catch {
      throw new McpCredentialError();
    }
  }
  /** Callback belongs to the trusted network adapter; never return its authorization argument. */
  async use<T>(
    scope: McpCredentialScope,
    reference: string,
    send: (authorization: string) => Promise<T>,
  ): Promise<T> {
    try {
      const { row, secret } = await this.load(scope, reference, "active");
      if (secret.kind === "pending" || (secret.kind === "oauth" && secret.expiresAt <= this.now()))
        throw new McpCredentialError();
      const current = await this.storage.read(reference);
      if (
        current?.revision !== row.revision ||
        current.revocationRequested ||
        current.state !== "active"
      )
        throw new McpCredentialError();
      return await send(`Bearer ${secret.token}`);
    } catch {
      throw new McpCredentialError();
    }
  }
  private async request(
    url: string,
    body?: URLSearchParams,
    allowEmpty = false,
  ): Promise<Record<string, unknown>> {
    if (!this.network) throw new McpCredentialError();
    const value = await this.network.json(https(url), body ? { method: "POST", body } : undefined);
    return allowEmpty && value === undefined ? {} : object(value);
  }
  async beginOAuth(
    scope: McpCredentialScope,
    client: McpOAuthClient,
  ): Promise<{ reference: string; authorizationUrl: string }> {
    try {
      https(client.resource);
      https(client.issuer);
      https(client.redirectUri);
      text(client.clientId);
      // RFC6749 scope-token ASCII grammar; engineering bounds avoid oversized navigation URLs.
      if (
        client.scopes &&
        (client.scopes.length > 64 ||
          client.scopes.some(
            (scope) => scope.length > 256 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope),
          ))
      )
        throw new McpCredentialError();
      const resourceUrl = new URL(client.resource);
      const metadata = await this.request(
        `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`,
      );
      if (
        metadata.resource !== client.resource ||
        !Array.isArray(metadata.authorization_servers) ||
        !metadata.authorization_servers.includes(client.issuer)
      )
        throw new McpCredentialError();
      const issuerUrl = new URL(client.issuer);
      const server = await this.request(
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`,
      );
      if (
        server.issuer !== client.issuer ||
        !Array.isArray(server.code_challenge_methods_supported) ||
        !server.code_challenge_methods_supported.includes("S256")
      )
        throw new McpCredentialError();
      for (const [field, required] of [
        ["token_endpoint_auth_methods_supported", "none"],
        ["response_types_supported", "code"],
        ["grant_types_supported", "authorization_code"],
      ] as const) {
        const advertised = server[field];
        if (
          advertised !== undefined &&
          (!Array.isArray(advertised) || !advertised.includes(required))
        )
          throw new McpCredentialError();
      }
      const binding: OAuthBinding = {
        ...client,
        authorizationEndpoint: https(server.authorization_endpoint),
        tokenEndpoint: https(server.token_endpoint),
        revocationEndpoint: https(server.revocation_endpoint),
      };
      if (!this.network) throw new McpCredentialError();
      await this.network.validate(binding.authorizationEndpoint);
      await this.network.validate(binding.tokenEndpoint);
      await this.network.validate(binding.revocationEndpoint);
      // Browser navigation cannot use the outbound adapter: restrict it to the registered issuer origin.
      if (new URL(binding.authorizationEndpoint).origin !== issuerUrl.origin)
        throw new McpCredentialError();
      // Engineering lifetime: ten minutes; 256-bit random state and RFC7636 verifier.
      const state = base64(crypto.getRandomValues(new Uint8Array(32)));
      const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
      const reference = await this.create(
        scope,
        { kind: "pending", binding, state, verifier, deadline: this.now() + 600_000 },
        "pending",
      );
      const url = new URL(binding.authorizationEndpoint);
      const challenge = base64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
      );
      for (const [name, value] of Object.entries({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        resource: client.resource,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }))
        url.searchParams.set(name, value);
      if (client.scopes?.length) url.searchParams.set("scope", client.scopes.join(" "));
      return { reference, authorizationUrl: url.toString() };
    } catch {
      throw new McpCredentialError();
    }
  }
  private tokens(
    response: Record<string, unknown>,
    binding: OAuthBinding,
    previousRefresh?: string,
  ): Secret {
    if (
      typeof response.token_type !== "string" ||
      response.token_type.toLowerCase() !== "bearer" ||
      typeof response.expires_in !== "number" ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0
    )
      throw new McpCredentialError();
    const refreshToken =
      response.refresh_token === undefined ? previousRefresh : text(response.refresh_token);
    return {
      kind: "oauth",
      binding,
      token: text(response.access_token),
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: this.now() + response.expires_in * 1000,
    };
  }
  async completeOAuth(
    scope: McpCredentialScope,
    reference: string,
    callback: { state: string; iss: string; code: string },
  ): Promise<void> {
    try {
      const { row, secret } = await this.load(scope, reference, "pending");
      if (
        secret.kind !== "pending" ||
        secret.deadline <= this.now() ||
        callback.state !== secret.state ||
        callback.iss !== secret.binding.issuer
      )
        throw new McpCredentialError();
      text(callback.code);
      const blocked = await this.replace(scope, reference, row, secret, "blocked");
      const response = await this.request(
        secret.binding.tokenEndpoint,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: secret.verifier,
          client_id: secret.binding.clientId,
          redirect_uri: secret.binding.redirectUri,
          resource: secret.binding.resource,
        }),
      );
      await this.replace(
        scope,
        reference,
        blocked,
        this.tokens(response, secret.binding),
        "active",
      );
    } catch {
      throw new McpCredentialError();
    }
  }
  async refresh(scope: McpCredentialScope, reference: string): Promise<void> {
    try {
      const { row, secret } = await this.load(scope, reference, "active");
      if (secret.kind !== "oauth" || !secret.refreshToken) throw new McpCredentialError();
      const blocked = await this.replace(scope, reference, row, secret, "blocked");
      const response = await this.request(
        secret.binding.tokenEndpoint,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: secret.refreshToken,
          client_id: secret.binding.clientId,
          resource: secret.binding.resource,
        }),
      );
      await this.replace(
        scope,
        reference,
        blocked,
        this.tokens(response, secret.binding, secret.refreshToken),
        "active",
      );
    } catch {
      throw new McpCredentialError();
    }
  }
  async revoke(scope: McpCredentialScope, reference: string): Promise<void> {
    try {
      const row = await this.storage.read(reference);
      if (!row || row.state === "revoked") throw new McpCredentialError();
      await this.open(scope, reference, row);
      const fenced = await this.storage.fence(reference);
      if (!fenced || !fenced.revocationRequested) throw new McpCredentialError();
      if (fenced.state === "revoked") return;
      const secret = await this.open(scope, reference, fenced);
      if (secret.kind === "oauth")
        await this.request(
          secret.binding.revocationEndpoint,
          new URLSearchParams({
            token: secret.refreshToken ?? secret.token,
            client_id: secret.binding.clientId,
          }),
          true,
        );
      if (
        !(await this.storage.compareAndSwap(reference, fenced.revision, {
          ...fenced,
          revision: fenced.revision + 1,
          state: "revoked",
          ciphertext: [],
          wrappedKey: [],
        }))
      )
        throw new McpCredentialError();
    } catch {
      throw new McpCredentialError();
    }
  }
}
