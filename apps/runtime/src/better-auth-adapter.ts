import { Socket } from "node:net";
import {
  AuthenticationRefusedError,
  type AuthProviderPort,
  type VerifiedExternalIdentity,
} from "@clockgrove/application";
import type { ExternalIdentityId } from "@clockgrove/contracts";
import { betterAuth } from "better-auth";
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
