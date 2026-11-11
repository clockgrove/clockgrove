import {
  type McpBinding,
  McpCredentialInstallation,
  type McpCredentialScope,
  McpCredentialVault,
  type McpInstallationGovernancePort,
  type McpInstallationReviewChange,
  type McpInstallationScope,
  McpInstallationService,
  type McpNetworkPort,
  type McpOAuthClient,
  McpOAuthHttpNetwork,
  type McpOwnedCredentialProvider,
  McpRefusal,
  type RuntimeAuthorizationContext,
  SafeMcpHttpClient,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type McpSecretPostgreSqlClient,
  type PostgreSqlClient,
  PostgreSqlMcpBindings,
  PostgreSqlMcpInstallations,
  PostgreSqlMcpSecretStorage,
  withClientTransaction,
} from "@clockgrove/persistence";

export const MCP_INSTALL_GRANT = "runtime:mcp-install";
export const MCP_ROUTES = [
  "list",
  "connect",
  "connect-static",
  "oauth-begin",
  "oauth-callback",
  "review",
  "bind",
  "refresh",
  "revoke",
] as const;
export type McpRuntimeAction = (typeof MCP_ROUTES)[number];

/** Trusted composition only. Never accept these ports or OAuth registration from HTTP inputs. */
export interface McpRuntimeConfiguration {
  readonly withClient: <T>(operation: (client: PostgreSqlClient) => Promise<T>) => Promise<T>;
  readonly network: McpNetworkPort;
  readonly openProvider: (scope: McpCredentialScope) => Promise<McpOwnedCredentialProvider>;
  readonly oauthClient: (url: string) => McpOAuthClient;
  /** Explicit operator capacity: each retained handle owns a pinned secret-provider session. */
  readonly maxInstallations: number;
  readonly changed: (
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
  ) => Promise<void>;
}

export interface McpRuntimePort {
  execute(
    action: McpRuntimeAction,
    input: Record<string, unknown>,
    context: TrustedExecutionContext,
  ): Promise<unknown>;
}

/** The caller supplies a dedicated non-reconnecting session under clockgrove_mcp_secrets. */
export async function openPostgreSqlMcpProvider(
  client: McpSecretPostgreSqlClient,
  scope: McpCredentialScope,
  keyring: {
    readonly activeVersion: string;
    readonly keys: ReadonlyMap<string, Awaited<ReturnType<typeof crypto.subtle.importKey>>>;
  },
  network: McpNetworkPort,
): Promise<McpOwnedCredentialProvider> {
  const storage = await PostgreSqlMcpSecretStorage.open(client, scope);
  return {
    vault: new McpCredentialVault(
      storage,
      keyring.activeVersion,
      keyring.keys,
      new McpOAuthHttpNetwork(new SafeMcpHttpClient(network)),
    ),
    close: () => storage.close(),
  };
}

function text(value: unknown): string {
  // Decision: bound each operator text field to the discovery string ceiling (16 KiB) so queued
  // inputs cannot retain unbounded credential or metadata strings while this owner is busy.
  if (typeof value !== "string" || !value || value.length > 16384 || /[\r\n]/u.test(value))
    throw new McpRefusal("installation_change_failed");
  return value;
}

/**
 * Local trusted owner, retained across requests and OAuth callbacks. Restart loses handles and
 * requires reconnect: the PostgreSQL provider fences old credentials when its successor opens.
 * No secret or opaque credential reference is returned to the browser.
 */
export class McpRuntimeOperator implements McpRuntimePort {
  private readonly handles = new Map<string, McpCredentialInstallation>();
  private readonly owned = new Map<
    string,
    {
      authorization: RuntimeAuthorizationContext;
      scope: McpInstallationScope;
      installationId: string;
    }
  >();
  private readonly anonymous = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly configuration: McpRuntimeConfiguration) {
    if (!Number.isSafeInteger(configuration.maxInstallations) || configuration.maxInstallations < 1)
      throw new Error("MCP operator capacity required");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    let unavailable = false;
    for (const [key, handle] of this.handles) {
      const owner = this.owned.get(key);
      try {
        if (owner)
          await this.configuration.withClient(async (client) => {
            const governance = new PostgreSqlMcpInstallations(client);
            const row = await governance.read(
              owner.authorization,
              owner.scope,
              owner.installationId,
            );
            if (row?.status === "active")
              await governance.change(
                owner.authorization,
                owner.scope,
                { action: "disable", installationId: owner.installationId },
                crypto.randomUUID(),
                new Date().toISOString(),
              );
            await this.configuration.changed(owner.authorization, owner.scope);
          });
      } catch {
        unavailable = true;
      } finally {
        await handle.close();
      }
    }
    this.handles.clear();
    this.owned.clear();
    this.anonymous.clear();
    if (unavailable) throw new Error("MCP shutdown unavailable");
  }

  execute(
    action: McpRuntimeAction,
    input: Record<string, unknown>,
    context: TrustedExecutionContext,
  ): Promise<unknown> {
    // Serialize installation lifecycles. Revocation owns a fresh ordinary client and commits its
    // terminal canonical fence immediately, without waiting for an in-flight remote request.
    const captured = structuredClone(input);
    if (action === "revoke") return this.run(action, captured, context);
    const result = this.tail.then(() => this.run(action, captured, context));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async run(
    action: McpRuntimeAction,
    input: Record<string, unknown>,
    context: TrustedExecutionContext,
  ): Promise<unknown> {
    if (this.closed) throw new McpRefusal("installation_unavailable");
    const authorization: RuntimeAuthorizationContext = {
      tenantId: context.tenantId,
      principalId: context.principalId,
      privacyCeiling: context.privacyCeiling,
    };
    return this.configuration.withClient(async (client) => {
      const governance = new PostgreSqlMcpInstallations(client);
      // Derive Journal routing from canonical storage, never browser-selected partition/stream IDs.
      const scope = await withClientTransaction(client, { authorization }, async () => {
        const result = await client.query(
          "SELECT partition_id,stream_id FROM clockgrove.streams WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND space_id=$4 ORDER BY stream_id LIMIT 1",
          [context.tenantId, context.worldId, context.timelineId, context.spaceId],
        );
        const row = result.rows[0] as { partition_id: string; stream_id: string } | undefined;
        if (!row) throw new McpRefusal("installation_unavailable");
        return {
          worldId: decodeOpaqueId(context.worldId, "WorldId"),
          timelineId: decodeOpaqueId(context.timelineId, "TimelineId"),
          spaceId: decodeOpaqueId(context.spaceId, "SpaceId"),
          partitionId: row.partition_id,
          streamId: row.stream_id,
        };
      });
      if (!(await governance.authorize(authorization, scope)))
        throw new McpRefusal("installation_authority_required");
      if (action === "list") {
        const installations = await withClientTransaction(client, { authorization }, async () => {
          const result = await client.query(
            "SELECT installation_id,space_id,owner_principal_id,url,status,snapshot,reviews,drifted,revision::text AS revision FROM clockgrove.mcp_installations WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND space_id=$4 ORDER BY installation_id",
            [context.tenantId, context.worldId, context.timelineId, context.spaceId],
          );
          return result.rows;
        });
        const views = [];
        for (const value of installations) {
          const row = value as Record<string, unknown>;
          const bindings = await new PostgreSqlMcpBindings(client).list(
            authorization,
            scope,
            String(row.installation_id),
          );
          views.push({ ...row, bindings });
        }
        return { installations: views };
      }
      const installationId = text(input.installationId);
      const commandId = decodeOpaqueId(input.commandId, "CommandId");
      // Use server time for canonical attribution. Browser timestamps have no authority.
      const issuedAt = new Date().toISOString();
      const key = JSON.stringify([
        context.tenantId,
        context.worldId,
        context.timelineId,
        context.spaceId,
        context.principalId,
        installationId,
      ]);
      const existing = this.handles.get(key);
      if (action === "connect") {
        if (this.handles.size + this.anonymous.size >= this.configuration.maxInstallations)
          throw new McpRefusal("installation_unavailable");
        await new McpInstallationService(governance, this.configuration.network).install(
          authorization,
          scope,
          { installationId, url: text(input.url) },
          commandId,
          issuedAt,
        );
        await this.configuration.changed(authorization, scope);
        this.anonymous.add(key);
        return { ok: true };
      }
      if (action === "connect-static" || action === "oauth-begin") {
        if (
          existing ||
          this.handles.size + this.anonymous.size >= this.configuration.maxInstallations
        )
          throw new McpRefusal("installation_unavailable");
        // Handles outlive this request's ordinary client. Each retained governance call owns a
        // fresh client; only the separately privileged credential session remains pinned.
        const ownedGovernance: McpInstallationGovernancePort = {
          authorize: (auth, target) =>
            this.configuration.withClient((next) =>
              new PostgreSqlMcpInstallations(next).authorize(auth, target),
            ),
          read: (auth, target, id) =>
            this.configuration.withClient((next) =>
              new PostgreSqlMcpInstallations(next).read(auth, target, id),
            ),
          change: (auth, target, change, command, at) =>
            this.configuration.withClient((next) => {
              // A revoked or failed pending owner cannot install after its remote discovery ends.
              if (change.action === "install" && this.handles.get(key) !== handle)
                throw new McpRefusal("installation_unavailable");
              return new PostgreSqlMcpInstallations(next).change(auth, target, change, command, at);
            }),
        };
        const handle = await McpCredentialInstallation.open(
          ownedGovernance,
          this.configuration.network,
          authorization,
          scope,
          { installationId, url: text(input.url) },
          this.configuration.openProvider,
        );
        this.handles.set(key, handle);
        this.owned.set(key, { authorization, scope, installationId });
        try {
          if (action === "oauth-begin")
            return await handle.beginOAuth(this.configuration.oauthClient(text(input.url)));
          await handle.connectStatic(text(input.token), commandId, issuedAt);
          await this.configuration.changed(authorization, scope);
          return { ok: true };
        } catch (error) {
          await handle.close();
          this.handles.delete(key);
          this.owned.delete(key);
          throw error;
        }
      }
      try {
        if (action === "oauth-callback") {
          if (!existing) throw new McpRefusal("installation_unavailable");
          await existing.completeOAuth(
            { state: text(input.state), iss: text(input.iss), code: text(input.code) },
            commandId,
            issuedAt,
          );
        } else if (action === "refresh") {
          if (existing) await existing.refresh(commandId, issuedAt);
          else if (this.anonymous.has(key))
            await new McpInstallationService(governance, this.configuration.network).refresh(
              authorization,
              scope,
              installationId,
              commandId,
              issuedAt,
            );
          else {
            // A lost credential owner must never leave previously reviewed capabilities active.
            await new McpInstallationService(governance, this.configuration.network).change(
              authorization,
              scope,
              { action: "disable", installationId },
              crypto.randomUUID(),
              issuedAt,
            );
            throw new McpRefusal("installation_unavailable");
          }
        } else if (action === "revoke") {
          await new McpInstallationService(governance, this.configuration.network).change(
            authorization,
            scope,
            { action: "revoke", installationId },
            commandId,
            issuedAt,
          );
          await this.configuration.changed(authorization, scope);
          // Remote cleanup may fail (including a busy handle); canonical admission is already
          // revoked and the provider closes in the handle's finally path in either case.
          if (existing) await existing.revoke(crypto.randomUUID(), issuedAt);
        } else if (action === "review") {
          await new McpInstallationService(governance, this.configuration.network).change(
            authorization,
            scope,
            {
              ...input,
              action: "review",
              installationId,
            } as unknown as McpInstallationReviewChange,
            commandId,
            issuedAt,
          );
        } else if (action === "bind") {
          const binding = input.binding as McpBinding | undefined;
          if (!binding || binding.installationId !== installationId)
            throw new McpRefusal("installation_change_failed");
          await new PostgreSqlMcpBindings(client).change(
            authorization,
            scope,
            binding,
            commandId,
            issuedAt,
          );
        }
        return { ok: true };
      } catch (error) {
        if ((action === "oauth-callback" || action === "refresh") && existing) {
          await existing.close();
          this.handles.delete(key);
          this.owned.delete(key);
        }
        throw error;
      } finally {
        if (action === "revoke") {
          await existing?.close();
          this.handles.delete(key);
          this.owned.delete(key);
          this.anonymous.delete(key);
        }
        // Failed refresh also disables reviews. Notify even when an operation's outcome is uncertain.
        await this.configuration.changed(authorization, scope);
      }
    });
  }
}
