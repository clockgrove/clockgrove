import { Socket } from "node:net";
import type { PostgreSqlClient } from "@clockgrove/persistence";
import { Client } from "pg";

/** One operation owns one connection, including all authorization and transaction SQL. */
export class HyperdrivePostgreSqlClient implements PostgreSqlClient {
  private readonly client: Client;
  private transactionOpen = false;
  private closed = false;
  private connection: Promise<Client> | undefined;
  private connectionFailed = false;
  /** The SQLSTATE of the fatal error that ended the session, when the server sent one. */
  private fatalCode: string | undefined;

  constructor(connectionString: string) {
    const url = new URL(connectionString);
    const socketPath = url.searchParams.get("host");
    // Only the local helper's NUL-prefixed full abstract address needs a stream.
    // Ordinary Hyperdrive URLs retain pg's default transport.
    if (socketPath?.startsWith("\0")) {
      url.searchParams.delete("host");
      this.client = new Client({
        connectionString: url.toString(),
        stream: () => {
          const socket = new Socket();
          const connect = socket.connect.bind(socket);
          socket.connect = () => connect(socketPath);
          return socket;
        },
      });
    } else {
      this.client = new Client({ connectionString });
    }
    // Keep ownership through end, including errors between awaited queries.
    this.client.on("error", (error: unknown) => {
      this.connectionFailed = true;
      this.fatalCode ??= sqlState(error);
    });
  }

  async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly unknown[] }> {
    if (this.closed) throw new Error("PostgreSQL operation client is closed");
    this.assertConnectionHealthy();
    try {
      this.connection ??= this.client.connect().catch((error: unknown) => {
        this.connectionFailed = true;
        // The server's own refusal keeps its SQLSTATE (53300 too many connections, 28000 login
        // refused); any other failure to connect is 08001, unable to establish a connection.
        this.fatalCode ??= sqlState(error) ?? UNABLE_TO_CONNECT;
        throw new Error("PostgreSQL connection failed");
      });
      await this.connection;
      this.assertConnectionHealthy();
      // pg preserves serialized JSON strings and binary views without another serializer.
      const result = await this.client.query(text, [...values]);
      if (text.trim() === "BEGIN") this.transactionOpen = true;
      if (/^(?:COMMIT|ROLLBACK)$/u.test(text.trim())) this.transactionOpen = false;
      this.assertConnectionHealthy();
      return { rows: result.rows };
    } catch (error) {
      const ending = sqlState(error);
      if (ending !== undefined && SESSION_ENDING.test(ending)) this.fatalCode ??= ending;
      this.assertConnectionHealthy();
      // Preserve SQLSTATE for journal conflict mapping without exposing driver details.
      const databaseError = error as { code?: unknown; detail?: unknown } | null;
      const code = sqlState(error);
      const failure = new Error("PostgreSQL query failed");
      if (code !== undefined) Object.assign(failure, { code });
      // Only these journal errors carry the numeric expected:actual contract.
      if (
        typeof code === "string" &&
        ["CG002", "CG003", "CG004"].includes(code) &&
        typeof databaseError?.detail === "string" &&
        /^\d+:\d+$/u.test(databaseError.detail)
      )
        Object.assign(failure, { detail: databaseError.detail });
      throw failure;
    }
  }

  /**
   * A failed connection stays failed. When the server ended the session with a fatal error (for
   * example FATAL 25P03, the idle-in-transaction timeout), its SQLSTATE is kept for error mapping.
   */
  private assertConnectionHealthy(): void {
    if (!this.connectionFailed) return;
    const failure = new Error("PostgreSQL connection failed");
    if (this.fatalCode !== undefined) Object.assign(failure, { code: this.fatalCode });
    throw failure;
  }

  /**
   * One round trip on the open connection before release. Ending can discard a termination the
   * operation has not read yet: the Workers socket's close drops unread data, and pg ignores EPIPE
   * on a Unix socket while ending. A termination fails this query on every transport; one
   * seen without the server's error is classified as a connection failure. The server's refusal of
   * the query on a live session (25P02 after an error left the transaction aborted) keeps its code.
   */
  async confirm(): Promise<void> {
    if (this.connection === undefined) return;
    try {
      await this.query("SELECT 1");
    } catch (error) {
      const { code } = error as { code?: unknown };
      if (!this.connectionFailed && typeof code === "string" && !SESSION_ENDING.test(code))
        throw error;
      this.connectionFailed = true;
      this.fatalCode ??= CONNECTION_FAILURE;
      this.assertConnectionHealthy();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection;
      if (this.transactionOpen) await this.client.query("ROLLBACK").catch(() => undefined);
    } finally {
      try {
        await this.client.end();
      } catch {
        this.connectionFailed = true;
      }
      this.assertConnectionHealthy();
    }
  }
}

/**
 * SQLSTATEs the server sends as it ends the session under a running query: the idle-in-transaction
 * timeout (25P03) and operator intervention (57P01 terminated, 57P02 crash, 57P03 cannot connect
 * now). The connection's own close can be seen first, so the code is kept from the query's error.
 */
const SESSION_ENDING = /^(?:25P03|57P0[1-3])$/u;
/** SQLSTATE 08001, sqlclient_unable_to_establish_sqlconnection: a connection that never opened. */
const UNABLE_TO_CONNECT = "08001";
/** SQLSTATE 08006, connection_failure: an open connection lost without the server's error. */
const CONNECTION_FAILURE = "08006";

/**
 * The SQLSTATE of an error the server sent. Only server errors carry a severity; a socket error such
 * as `EPIPE` (which the client can see before the server's FATAL message) has a code of the same shape
 * and is not a SQLSTATE.
 */
function sqlState(error: unknown): string | undefined {
  const { code, severity } = (error ?? {}) as { code?: unknown; severity?: unknown };
  return typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)
    ? code
    : undefined;
}

/**
 * Scope sockets to an invocation; no client or request authority survives in isolate state. With
 * `confirm`, a successful operation also confirms its session before release.
 */
export async function withHyperdrivePostgreSqlClient<T>(
  connectionString: string,
  operation: (client: PostgreSqlClient) => Promise<T>,
  options: { readonly confirm?: boolean } = {},
): Promise<T> {
  const client = new HyperdrivePostgreSqlClient(connectionString);
  let result: T;
  try {
    result = await operation(client);
    if (options.confirm) await client.confirm();
  } catch (error) {
    // The operation's failure is the cause; a close failure on the same broken session must not
    // replace it (an idle-timeout session would otherwise surface as a bare connection failure).
    await client.close().catch(() => undefined);
    throw error;
  }
  await client.close();
  return result;
}
