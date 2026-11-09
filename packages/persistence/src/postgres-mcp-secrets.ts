import {
  McpCredentialError,
  type McpCredentialScope,
  type McpSealedCredential,
  type McpSecretStorage,
} from "@clockgrove/application";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface McpSecretPostgreSqlClient extends PostgreSqlClient {
  /** Owns one pinned, non-reconnecting PostgreSQL session, exclusively for this provider. */
  close(): Promise<void>;
}

const ownedClients = new WeakSet<PostgreSqlClient>();

type Row = { envelope: McpSealedCredential; revocation_requested: boolean };

/** A separately privileged secret-provider connection, never an ordinary runtime connection. */
export class PostgreSqlMcpSecretStorage implements McpSecretStorage {
  private readonly scope: McpCredentialScope;
  private failed = false;
  private backendPid = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly lockIdentity: string;

  private constructor(
    private readonly client: McpSecretPostgreSqlClient,
    scope: McpCredentialScope,
  ) {
    this.scope = { ...scope };
    this.lockIdentity = JSON.stringify([
      scope.tenantId,
      scope.worldId,
      scope.timelineId,
      scope.installationId,
      scope.ownerPrincipalId,
    ]);
  }

  /** Taking over a scope fences every previous reference, even after an uncertain failed write. */
  static async open(
    client: McpSecretPostgreSqlClient,
    scope: McpCredentialScope,
  ): Promise<PostgreSqlMcpSecretStorage> {
    if (ownedClients.has(client)) throw new McpCredentialError();
    ownedClients.add(client);
    const provider = new PostgreSqlMcpSecretStorage(client, scope);
    try {
      const result = await client.query(
        `SELECT pg_backend_pid() AS pid,
                pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
        [provider.lockIdentity],
      );
      const row = result.rows[0] as { pid: number; acquired: boolean };
      if (row.acquired !== true) throw new McpCredentialError();
      provider.backendPid = row.pid;
      await provider.transaction(async () => {
        await client.query(`UPDATE clockgrove_mcp.credentials SET revocation_requested = true
          WHERE state <> 'revoked'`);
      });
      return provider;
    } catch {
      await provider.close();
      throw new McpCredentialError();
    }
  }

  async close(): Promise<void> {
    this.failed = true;
    await this.client.close().catch(() => undefined);
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.runTransaction(operation));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.failed) throw new McpCredentialError();
    try {
      return await withClientTransaction(this.client, {}, async () => {
        const checked = await this.client.query(
          `SELECT pg_backend_pid() AS pid, EXISTS (
             SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
               AND pid = pg_backend_pid() AND objsubid = 1
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
               AND objid::bigint = (hashtextextended($1, 0) & 4294967295)
           ) AS held`,
          [this.lockIdentity],
        );
        const session = checked.rows[0] as { pid: number; held: boolean };
        if (session.pid !== this.backendPid || session.held !== true)
          throw new McpCredentialError();
        const scope = this.scope;
        await this.client.query(
          `SELECT set_config('mcp.tenant_id', $1, true),
                  set_config('mcp.world_id', $2, true),
                  set_config('mcp.timeline_id', $3, true),
                  set_config('mcp.installation_id', $4, true),
                  set_config('mcp.owner_principal_id', $5, true)`,
          [
            scope.tenantId,
            scope.worldId,
            scope.timelineId,
            scope.installationId,
            scope.ownerPrincipalId,
          ],
        );
        return await operation();
      });
    } catch {
      await this.close();
      throw new McpCredentialError();
    }
  }

  private decode(rows: readonly unknown[]): McpSealedCredential | undefined {
    const row = rows[0] as Row | undefined;
    return row === undefined
      ? undefined
      : { ...row.envelope, revocationRequested: row.revocation_requested };
  }

  async read(reference: string): Promise<McpSealedCredential | undefined> {
    return this.transaction(async () => {
      const result = await this.client.query(
        `SELECT envelope, revocation_requested FROM clockgrove_mcp.credentials WHERE reference = $1`,
        [reference],
      );
      return this.decode(result.rows);
    });
  }

  async fence(reference: string): Promise<McpSealedCredential | undefined> {
    const result = await this.transaction(async () => {
      const result = await this.client.query(
        `UPDATE clockgrove_mcp.credentials SET revocation_requested = true
          WHERE reference = $1 AND state <> 'revoked'
          RETURNING envelope, revocation_requested`,
        [reference],
      );
      if (result.rows.length !== 0) return this.decode(result.rows);
      const current = await this.client.query(
        `SELECT envelope, revocation_requested FROM clockgrove_mcp.credentials WHERE reference = $1`,
        [reference],
      );
      return this.decode(current.rows);
    });
    return result;
  }

  async compareAndSwap(
    reference: string,
    previousRevision: number | null,
    value: McpSealedCredential,
  ): Promise<boolean> {
    const envelope = {
      revision: value.revision,
      state: value.state,
      keyVersion: value.keyVersion,
      wrappedKey: value.wrappedKey,
      wrapIv: value.wrapIv,
      iv: value.iv,
      ciphertext: value.ciphertext,
    };
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision !== (previousRevision ?? 0) + 1 ||
      (value.state === "revoked" && previousRevision === null)
    )
      throw new McpCredentialError();
    return this.transaction(async () => {
      const result =
        previousRevision === null
          ? await this.client.query(
              `INSERT INTO clockgrove_mcp.credentials
                (reference, tenant_id, world_id, timeline_id, installation_id, owner_principal_id,
                 revision, state, envelope)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
               ON CONFLICT (reference) DO NOTHING RETURNING reference`,
              [
                reference,
                this.scope.tenantId,
                this.scope.worldId,
                this.scope.timelineId,
                this.scope.installationId,
                this.scope.ownerPrincipalId,
                value.revision,
                value.state,
                JSON.stringify(envelope),
              ],
            )
          : await this.client.query(
              `UPDATE clockgrove_mcp.credentials
                  SET revision = $3, state = $4, envelope = $5::jsonb
                WHERE reference = $1 AND revision = $2 AND state <> 'revoked'
                  AND (NOT revocation_requested OR $4 = 'revoked')
                  AND ($4 <> 'revoked' OR revocation_requested)
                RETURNING reference`,
              [reference, previousRevision, value.revision, value.state, JSON.stringify(envelope)],
            );
      return result.rows.length === 1;
    });
  }
}
