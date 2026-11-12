import { Socket } from "node:net";
import { apiKey } from "@better-auth/api-key";
import {
  getOAuthProviderApi,
  type OAuthOptions,
  oauthProvider,
  type Scope,
} from "@better-auth/oauth-provider";
import {
  AuthenticationRefusedError,
  type AuthProviderPort,
  type VerifiedExternalIdentity,
} from "@clockgrove/application";
import type { ExternalIdentityId } from "@clockgrove/contracts";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { Kysely, PostgresDialect } from "kysely";
import { Client, Pool } from "pg";

/** Management supplies durable links; authentication never creates principals or grants. */
export interface ReferenceAuthenticationConfiguration {
  readonly baseURL: string;
  readonly environment: string;
  readonly connectionString: string;
  readonly resolveIdentity: (
    environment: string,
    subject: string,
  ) => Promise<ExternalIdentityId | undefined>;
}

export function referenceSessionOptions(authSecret: string, baseURL: string) {
  return {
    secret: authSecret,
    baseURL,
    plugins: [bearer()],
    session: { cookieCache: { enabled: false } },
    telemetry: { enabled: false },
    logger: { disabled: true },
  };
}

/** SDK session/user objects terminate here. Only a Management-owned opaque link leaves. */
export class BetterAuthProvider implements AuthProviderPort {
  constructor(
    private readonly auth: Pick<ReturnType<typeof betterAuth>, "api">,
    private readonly environment: string,
    private readonly resolveIdentity: ReferenceAuthenticationConfiguration["resolveIdentity"],
  ) {}

  async authenticate(credential: string): Promise<VerifiedExternalIdentity> {
    try {
      if (!/^\S+$/u.test(credential)) throw new Error("invalid credential");
      const result = await this.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${credential}` }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (result === null || result.session.expiresAt.getTime() <= Date.now())
        throw new Error("invalid session");
      const externalIdentityId = await this.resolveIdentity(this.environment, result.user.id);
      if (externalIdentityId === undefined) throw new Error("unmapped identity");
      return Object.freeze({ externalIdentityId });
    } catch {
      // Do not expose SDK failures, tokens, subjects or storage connection details.
      throw new AuthenticationRefusedError("authentication refused");
    }
  }
}

export const refusingAuthenticationProvider: AuthProviderPort = {
  async authenticate() {
    throw new AuthenticationRefusedError("authentication configuration unavailable");
  },
};

/** Configuration is validated before allocating a driver; sockets belong to one request. */
export function composeReferenceAuthentication(
  authSecret: string | undefined,
  config: ReferenceAuthenticationConfiguration | undefined,
): AuthProviderPort {
  try {
    if (
      authSecret === undefined ||
      authSecret.length < 32 ||
      authSecret.trim() !== authSecret ||
      config === undefined
    )
      return refusingAuthenticationProvider;
    const origin = new URL(config.baseURL);
    const database = new URL(config.connectionString);
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      config.environment.trim() === "" ||
      config.environment.trim() !== config.environment ||
      typeof config.resolveIdentity !== "function"
    )
      return refusingAuthenticationProvider;
    return {
      async authenticate(credential) {
        try {
          let connectionFailed = false;
          const observeConnectionFailure = () => {
            connectionFailed = true;
          };
          // Install before connect, and retain while borrowed, idle and closing.
          class RequestClient extends Client {
            constructor(...args: ConstructorParameters<typeof Client>) {
              super(...args);
              this.on("error", observeConnectionFailure);
            }
          }
          const storage = new URL(config.connectionString);
          const socketPath = storage.searchParams.get("host");
          if (socketPath?.startsWith("\0")) storage.searchParams.delete("host");
          storage.searchParams.set("options", "-c search_path=clockgrove_auth");
          const pool = new Pool({
            connectionString: storage.toString(),
            options: "-c search_path=clockgrove_auth",
            ...(socketPath?.startsWith("\0")
              ? {
                  stream: () => {
                    const socket = new Socket();
                    const connect = socket.connect.bind(socket);
                    socket.connect = () => connect(socketPath);
                    return socket;
                  },
                }
              : {}),
            max: 1,
            // The connection stays owned until cleanup, so the confirmation below reaches it. pg-pool's
            // default 10 s eviction would end it, dropping an unread termination, if resolveIdentity
            // ran longer; the committed test's gap is too short to exercise that.
            idleTimeoutMillis: 0,
            Client: RequestClient,
          });
          pool.on("error", observeConnectionFailure);
          const closedConnections: Promise<void>[] = [];
          pool.on("connect", (client) => {
            closedConnections.push(new Promise<void>((resolve) => client.once("end", resolve)));
          });
          let identity: VerifiedExternalIdentity;
          try {
            const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
            try {
              const auth = betterAuth({
                ...referenceSessionOptions(authSecret, config.baseURL),
                database: { db, type: "postgres" },
              });
              identity = await new BetterAuthProvider(
                auth,
                config.environment,
                config.resolveIdentity,
              ).authenticate(credential);
              // Ending can discard a termination the request has not read yet: the Workers socket's
              // close drops unread data, and pg ignores EPIPE on a Unix socket. A round trip on the
              // owned connection reads it first on every transport.
              await pool.query("SELECT 1");
            } finally {
              await db.destroy();
            }
          } finally {
            // Kysely may not have initialized its lazy driver when setup fails.
            try {
              if (!pool.ending) await pool.end();
            } finally {
              // Pool.end removes idle clients before their sockets finish closing.
              await Promise.all(closedConnections);
            }
          }
          if (connectionFailed) throw new AuthenticationRefusedError("authentication refused");
          return identity;
        } catch {
          throw new AuthenticationRefusedError("authentication refused");
        }
      },
    };
  } catch {
    return refusingAuthenticationProvider;
  }
}

export interface WorldMcpAuthenticationConfiguration extends ReferenceAuthenticationConfiguration {
  /** Exact protected-resource URL; never supplied by a tool call. */
  readonly resourceURL: string;
}

export interface WorldMcpAuthentication {
  readonly provider: AuthProviderPort;
  /** Fresh storage verification; client provenance never comes from MCP initialize metadata. */
  authenticate(
    credential: string,
  ): Promise<VerifiedExternalIdentity & { readonly clientId: string }>;
  /** Internal auth route adapter. Public routing and its web UI are composed separately. */
  handle(request: Request): Promise<Response>;
}

const MCP_SCOPE = "clockgrove:mcp";
const MEMBER_TOKEN_PREFIX = "cg_member_";
const OAUTH_TOKEN_PREFIX = "cg_oauth_";
// Engineering bounds: one-hour OAuth access, thirty-day member keys, and small auth forms.
const MCP_ACCESS_SECONDS = 60 * 60;
const MCP_MEMBER_SECONDS = 30 * 24 * MCP_ACCESS_SECONDS;
const MCP_AUTH_BYTES = 16 * 1024;

function worldMcpAuthOptions(secret: string, config: WorldMcpAuthenticationConfiguration) {
  const oauth: OAuthOptions<Scope[]> = {
    loginPage: "/sign-in",
    consentPage: "/mcp/consent",
    scopes: [MCP_SCOPE],
    resources: [
      { identifier: config.resourceURL, name: "Clockgrove MCP", allowedScopes: [MCP_SCOPE] },
    ],
    grantTypes: ["authorization_code"],
    allowDynamicClientRegistration: true,
    clientRegistrationDefaultApplicationType: "infer",
    clientRegistrationDefaultResources: [config.resourceURL],
    allowUnauthenticatedClientRegistration: true,
    disableJwtPlugin: true,
    accessTokenExpiresIn: MCP_ACCESS_SECONDS,
    prefix: { opaqueAccessToken: OAUTH_TOKEN_PREFIX },
    clientPrivileges: async ({ user }) =>
      user !== undefined &&
      (await config.resolveIdentity(config.environment, user.id)) !== undefined,
  };
  return {
    ...referenceSessionOptions(secret, config.baseURL),
    session: { cookieCache: { enabled: false }, disableSessionRefresh: true },
    plugins: [
      bearer(),
      oauthProvider(oauth),
      apiKey({
        defaultPrefix: MEMBER_TOKEN_PREFIX,
        enableSessionForAPIKeys: false,
        enableMetadata: false,
        keyExpiration: { defaultExpiresIn: MCP_MEMBER_SECONDS, disableCustomExpiresTime: true },
        // Principal-wide runtime admission remains authoritative; this plugin must not mint sessions.
        rateLimit: { enabled: false },
      }),
      {
        id: "clockgrove-mcp-verification",
        endpoints: {
          worldMcpIdentity: createAuthEndpoint(
            "/internal/mcp-identity",
            { method: "GET" },
            async (ctx) => {
              const token =
                /^Bearer (\S+)$/u.exec(ctx.headers?.get("authorization") ?? "")?.[1] ?? "";
              const claims = await getOAuthProviderApi(ctx, oauth).requireActiveAccessToken(token);
              const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
              if (
                !audiences?.includes(config.resourceURL) ||
                typeof claims.scope !== "string" ||
                !claims.scope.split(" ").includes(MCP_SCOPE) ||
                typeof claims.sub !== "string" ||
                typeof claims.azp !== "string" ||
                claims.cnf !== undefined
              )
                throw new AuthenticationRefusedError("authentication refused");
              return { subject: claims.sub, clientId: claims.azp };
            },
          ),
        },
      },
    ],
  };
}

/** Each operation owns fresh provider storage; the existing read-only verifier stays unchanged. */
export function composeWorldMcpAuthentication(
  secret: string,
  config: WorldMcpAuthenticationConfiguration,
): WorldMcpAuthentication {
  const url = (value: string) => {
    try {
      return new URL(value);
    } catch {
      throw new AuthenticationRefusedError("authentication configuration unavailable");
    }
  };
  const origin = url(config.baseURL);
  const resource = url(config.resourceURL);
  const storage = url(config.connectionString);
  if (
    secret.length < 32 ||
    secret.trim() !== secret ||
    origin.protocol !== "https:" ||
    origin.origin !== config.baseURL.replace(/\/$/u, "") ||
    resource.origin !== origin.origin ||
    resource.username !== "" ||
    resource.password !== "" ||
    resource.search !== "" ||
    resource.hash !== "" ||
    !["postgres:", "postgresql:"].includes(storage.protocol) ||
    decodeURIComponent(storage.username) !== "clockgrove_mcp_auth_writer" ||
    !config.environment.trim() ||
    config.environment.trim() !== config.environment
  )
    throw new AuthenticationRefusedError("authentication configuration unavailable");

  const options = worldMcpAuthOptions(secret, config);
  const createAuth = (db: Kysely<unknown>) =>
    betterAuth({ ...options, database: { db, type: "postgres" } });
  type Auth = ReturnType<typeof createAuth>;
  async function withAuth<T>(run: (auth: Auth) => Promise<T>): Promise<T> {
    const database = new URL(config.connectionString);
    const socketPath = database.searchParams.get("host");
    if (socketPath?.startsWith("\0")) database.searchParams.delete("host");
    let failed = false;
    class RequestClient extends Client {
      constructor(...args: ConstructorParameters<typeof Client>) {
        super(...args);
        this.on("error", () => {
          failed = true;
        });
      }
    }
    const pool = new Pool({
      connectionString: database.toString(),
      options: "-c search_path=clockgrove_auth",
      max: 1,
      idleTimeoutMillis: 0,
      Client: RequestClient,
      ...(socketPath?.startsWith("\0")
        ? {
            stream: () => {
              const socket = new Socket();
              const connect = socket.connect.bind(socket);
              socket.connect = () => connect(socketPath);
              return socket;
            },
          }
        : {}),
    });
    pool.on("error", () => {
      failed = true;
    });
    const closing: Promise<void>[] = [];
    pool.on("connect", (client) => {
      closing.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    let result: T;
    try {
      const auth = createAuth(db);
      result = await run(auth);
      await pool.query("SELECT 1");
    } finally {
      try {
        await db.destroy();
      } finally {
        if (!pool.ending) await pool.end();
        await Promise.all(closing);
      }
    }
    if (failed) throw new AuthenticationRefusedError("authentication refused");
    return result;
  }
  async function identity(subject: string): Promise<VerifiedExternalIdentity> {
    const externalIdentityId = await config.resolveIdentity(config.environment, subject);
    if (externalIdentityId === undefined)
      throw new AuthenticationRefusedError("authentication refused");
    return Object.freeze({ externalIdentityId });
  }
  async function authenticate(credential: string) {
    try {
      if (credential.length > MCP_AUTH_BYTES || !/^\S+$/u.test(credential))
        throw new AuthenticationRefusedError("authentication refused");
      return await withAuth(async (auth) => {
        if (credential.startsWith(MEMBER_TOKEN_PREFIX)) {
          const result = await auth.api.verifyApiKey({ body: { key: credential } });
          if (!result.valid || result.key === null)
            throw new AuthenticationRefusedError("authentication refused");
          return Object.freeze({
            ...(await identity(result.key.referenceId)),
            clientId: `member-key:${result.key.id}`,
          });
        }
        if (!credential.startsWith(OAUTH_TOKEN_PREFIX))
          throw new AuthenticationRefusedError("authentication refused");
        const result = await auth.api.worldMcpIdentity({
          headers: new Headers({ authorization: `Bearer ${credential}` }),
        });
        return Object.freeze({
          ...(await identity(result.subject)),
          clientId: `oauth:${result.clientId}`,
        });
      });
    } catch {
      throw new AuthenticationRefusedError("authentication refused");
    }
  }
  return {
    authenticate,
    provider: {
      async authenticate(credential) {
        const verified = await authenticate(credential);
        return Object.freeze({ externalIdentityId: verified.externalIdentityId });
      },
    },
    async handle(request) {
      try {
        const url = new URL(request.url);
        if (
          request.method === "GET" &&
          [
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-authorization-server/api/auth",
          ].includes(url.pathname)
        ) {
          url.pathname = "/api/auth/.well-known/oauth-authorization-server";
          request = new Request(url, request);
        }
        const route = `${request.method} ${url.pathname}`;
        const memberRoutes = new Set([
          "POST /api/auth/oauth2/consent",
          "POST /api/auth/api-key/create",
          "GET /api/auth/api-key/list",
          "POST /api/auth/api-key/delete",
          "GET /api/auth/oauth2/get-consents",
          "POST /api/auth/oauth2/delete-consent",
          "GET /api/auth/oauth2/get-clients",
          "POST /api/auth/oauth2/delete-client",
        ]);
        const otherRoutes = new Set([
          "POST /api/auth/oauth2/register",
          "GET /api/auth/oauth2/authorize",
          "POST /api/auth/oauth2/token",
          "POST /api/auth/oauth2/revoke",
          "GET /api/auth/.well-known/oauth-authorization-server",
        ]);
        if (url.origin !== origin.origin || (!memberRoutes.has(route) && !otherRoutes.has(route)))
          return Response.json({ error: "invalid_request" }, { status: 404 });
        if (new TextEncoder().encode(url.search).byteLength > MCP_AUTH_BYTES)
          return Response.json({ error: "invalid_request" }, { status: 413 });
        if (
          memberRoutes.has(route) ||
          url.pathname === "/api/auth/oauth2/authorize" ||
          url.pathname === "/api/auth/oauth2/register"
        ) {
          const credential =
            /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
          // Cookie sessions may also authorize the web consent/token management flow.
          await withAuth(async (auth) => {
            const session = await auth.api.getSession({
              headers: request.headers,
              query: { disableCookieCache: true, disableRefresh: true },
            });
            if (session === null) {
              if (memberRoutes.has(route))
                throw new AuthenticationRefusedError("authentication refused");
              return;
            }
            if (session.session.expiresAt.getTime() <= Date.now())
              throw new AuthenticationRefusedError("authentication refused");
            await identity(session.user.id);
          });
          if (credential.length > MCP_AUTH_BYTES)
            throw new AuthenticationRefusedError("authentication refused");
        }
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > MCP_AUTH_BYTES) {
                await reader.cancel();
                return Response.json({ error: "invalid_request" }, { status: 413 });
              }
              chunks.push(next.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        let body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (
          url.pathname === "/api/auth/api-key/create" ||
          url.pathname === "/api/auth/api-key/delete" ||
          url.pathname === "/api/auth/oauth2/delete-consent" ||
          url.pathname === "/api/auth/oauth2/delete-client"
        ) {
          const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
          const field = url.pathname.endsWith("/create")
            ? "name"
            : url.pathname.endsWith("delete-consent")
              ? "id"
              : url.pathname.endsWith("delete-client")
                ? "client_id"
                : "keyId";
          if (
            input === null ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => key !== field) ||
            !(field in input) ||
            typeof (input as Record<string, unknown>)[field] !== "string" ||
            ((input as Record<string, string>)[field]?.length ?? 0) > 128
          )
            return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        if (url.pathname === "/api/auth/oauth2/register") {
          const input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          ) as Record<string, unknown>;
          const fields = new Set([
            "client_name",
            "redirect_uris",
            "token_endpoint_auth_method",
            "grant_types",
            "response_types",
            "scope",
            "application_type",
          ]);
          if (
            input === null ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !fields.has(key)) ||
            (input.token_endpoint_auth_method !== undefined &&
              input.token_endpoint_auth_method !== "none") ||
            (input.scope !== undefined && input.scope !== MCP_SCOPE) ||
            (input.grant_types !== undefined &&
              JSON.stringify(input.grant_types) !== '["authorization_code"]') ||
            (input.response_types !== undefined &&
              JSON.stringify(input.response_types) !== '["code"]') ||
            (input.client_name !== undefined &&
              (typeof input.client_name !== "string" || input.client_name.length > 128)) ||
            !Array.isArray(input.redirect_uris) ||
            input.redirect_uris.length < 1 ||
            input.redirect_uris.length > 8 ||
            !input.redirect_uris.every((uri) => {
              if (typeof uri !== "string" || uri.length > 2048) return false;
              try {
                const redirect = new URL(uri);
                return (
                  redirect.username === "" &&
                  redirect.password === "" &&
                  redirect.hash === "" &&
                  (redirect.protocol === "https:" ||
                    (redirect.protocol === "http:" &&
                      ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))
                );
              } catch {
                return false;
              }
            })
          )
            return Response.json({ error: "invalid_request" }, { status: 400 });
          body = new TextEncoder().encode(
            JSON.stringify({
              ...input,
              token_endpoint_auth_method: "none",
              scope: MCP_SCOPE,
              grant_types: ["authorization_code"],
              response_types: ["code"],
            }),
          );
        }
        const response = await withAuth((auth) =>
          auth.handler(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              ...(request.method === "GET" ? {} : { body }),
            }),
          ),
        );
        const redirect = response.headers.get("location");
        if (
          redirect !== null &&
          response.status >= 300 &&
          response.status < 400 &&
          request.headers.get("accept")?.includes("application/json")
        ) {
          return Response.json({ url: redirect }, { headers: { "cache-control": "no-store" } });
        }
        if (response.status >= 400) {
          const known = new Set([
            "invalid_request",
            "invalid_client",
            "invalid_grant",
            "invalid_scope",
            "unauthorized_client",
            "unsupported_grant_type",
            "access_denied",
          ]);
          const error = (await response.json().catch(() => ({}))) as { error?: string };
          return Response.json(
            { error: known.has(error.error ?? "") ? error.error : "invalid_request" },
            { status: response.status },
          );
        }
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return Response.json({ error: "access_denied" }, { status: 401 });
      }
    },
  };
}
