import type {
  PrincipalMappingPort,
  RuntimeAuthorizationScope,
  VerifiedExternalIdentity,
  WorkspaceAuthorizationPort,
  WorldAuthorizationPort,
} from "@clockgrove/application";
import {
  type BrowserScope,
  decodeBrowserScope,
  decodeOpaqueId,
  decodePrivacyCeiling,
  type PrincipalId,
} from "@clockgrove/contracts";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

/** Management lookup seam: raw SDK subject never enters application/domain contracts. */
export class PostgreSqlManagementReaders
  implements PrincipalMappingPort, WorkspaceAuthorizationPort
{
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly environment: string,
  ) {}

  async resolveIdentity(environment: string, subject: string) {
    if (
      environment !== this.environment ||
      environment.trim() !== environment ||
      !environment ||
      !subject
    )
      return undefined;
    return read(
      this.client,
      { "lookup.environment": environment, "lookup.subject": subject },
      async () => {
        const row = await one(
          this.client,
          `SELECT link.external_identity_id FROM clockgrove_management.identity_links link
        JOIN clockgrove_management.principals principal USING(principal_id)
        WHERE link.environment = $1 AND link.subject = $2 AND link.revoked_at IS NULL AND principal.revoked_at IS NULL`,
          [environment, subject],
        );
        return row === undefined
          ? undefined
          : decodeOpaqueId(row.external_identity_id, "ExternalIdentityId");
      },
    );
  }

  async resolvePrincipal(identity: VerifiedExternalIdentity) {
    return read(
      this.client,
      { "lookup.environment": this.environment, "lookup.identity": identity.externalIdentityId },
      async () => {
        const row = await one(
          this.client,
          `SELECT link.principal_id FROM clockgrove_management.identity_links link
        JOIN clockgrove_management.principals principal USING(principal_id)
        WHERE link.environment = $1 AND link.external_identity_id = $2 AND link.revoked_at IS NULL AND principal.revoked_at IS NULL`,
          [this.environment, identity.externalIdentityId],
        );
        return row === undefined ? undefined : decodeOpaqueId(row.principal_id, "PrincipalId");
      },
    );
  }

  async resolveWorkspace(
    principalId: Parameters<WorkspaceAuthorizationPort["resolveWorkspace"]>[0],
    tenantId: Parameters<WorkspaceAuthorizationPort["resolveWorkspace"]>[1],
  ) {
    return read(
      this.client,
      { "app.principal_id": principalId, "app.tenant_id": tenantId },
      async () => {
        const row = await one(
          this.client,
          `SELECT membership.* FROM clockgrove_management.workspace_memberships membership
        JOIN clockgrove_management.principals principal USING(principal_id)
        WHERE tenant_id = $1 AND membership.principal_id = $2 AND membership.revoked_at IS NULL AND principal.revoked_at IS NULL`,
          [tenantId, principalId],
        );
        if (row === undefined) return undefined;
        return {
          principalId: decodeOpaqueId(row.principal_id, "PrincipalId"),
          tenantId: decodeOpaqueId(row.tenant_id, "TenantId"),
          membershipId: decodeOpaqueId(row.membership_id, "WorkspaceMembershipId"),
          roles: ids(row.roles, "RoleId"),
          grants: ids(row.grants, "GrantRef"),
        };
      },
    );
  }
}

/** Reads only committed participation with exact transaction-local scope and forced RLS. */
export class PostgreSqlWorldAuthorizationReader implements WorldAuthorizationPort {
  constructor(private readonly client: PostgreSqlClient) {}
  async resolveWorld(
    principalId: Parameters<WorldAuthorizationPort["resolveWorld"]>[0],
    scope: RuntimeAuthorizationScope,
  ) {
    return read(
      this.client,
      {
        "app.principal_id": principalId,
        "app.tenant_id": scope.tenantId,
        "app.world_id": scope.worldId,
        "app.timeline_id": scope.timelineId,
        "app.space_id": scope.spaceId,
      },
      async () => {
        const row = await one(
          this.client,
          `SELECT * FROM clockgrove.world_memberships WHERE tenant_id = $1
        AND world_id = $2 AND timeline_id = $3 AND space_id = $4 AND principal_id = $5
        AND revoked_at IS NULL AND committed_at IS NOT NULL`,
          [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId, principalId],
        );
        if (row === undefined) return undefined;
        return {
          principalId: decodeOpaqueId(row.principal_id, "PrincipalId"),
          tenantId: decodeOpaqueId(row.tenant_id, "TenantId"),
          worldId: decodeOpaqueId(row.world_id, "WorldId"),
          timelineId: decodeOpaqueId(row.timeline_id, "TimelineId"),
          spaceId: decodeOpaqueId(row.space_id, "SpaceId"),
          membershipId: decodeOpaqueId(row.membership_id, "WorldMembershipId"),
          personaId: decodeOpaqueId(row.persona_id, "WorldPersonaId"),
          roles: ids(row.roles, "RoleId"),
          grants: ids(
            Array.isArray(row.roles) &&
              row.roles.includes("owner") &&
              !row.roles.includes("actor") &&
              typeof row.principal_id === "string" &&
              !row.principal_id.startsWith("system:") &&
              Array.isArray(row.grants)
              ? [...new Set([...row.grants, "runtime:mcp-install"])]
              : row.grants,
            "GrantRef",
          ),
          privacyCeiling: decodePrivacyCeiling(row.privacy_ceiling),
        };
      },
    );
  }
}

/**
 * The principal's observable scopes through `clockgrove.observable_world_scopes` (0032), which
 * applies the observe grant, revocation, commitment and readiness per row. One indexed read, in
 * byte order of tenant, world, timeline and space.
 */
export class PostgreSqlWorldDirectoryReader {
  constructor(private readonly client: PostgreSqlClient) {}
  async observableScopes(principalId: PrincipalId): Promise<readonly RuntimeAuthorizationScope[]> {
    const scopes = await read(this.client, { "app.principal_id": principalId }, async () => {
      const { rows } = await this.client.query(
        `SELECT tenant_id AS "tenantId", world_id AS "worldId", timeline_id AS "timelineId",
        space_id AS "spaceId" FROM clockgrove.observable_world_scopes()
        ORDER BY tenant_id COLLATE "C", world_id COLLATE "C", timeline_id COLLATE "C", space_id COLLATE "C"`,
      );
      return rows.map(decodeBrowserScope);
    });
    if (scopes === undefined) throw new Error("malformed world directory");
    return scopes;
  }

  /** The scope's arrival readiness through `clockgrove.observable_world_readiness` (0035). */
  async readiness(
    principalId: PrincipalId,
    scope: BrowserScope,
  ): Promise<"ready" | "provisioning" | "failed" | undefined> {
    const answer = await read(this.client, { "app.principal_id": principalId }, async () => {
      const { rows } = await this.client.query(
        "SELECT clockgrove.observable_world_readiness($1, $2, $3, $4) AS readiness",
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      const value = (rows[0] as { readiness?: unknown } | undefined)?.readiness;
      if (value === null) return null;
      if (value === "ready" || value === "provisioning" || value === "failed") return value;
      throw new Error("malformed world readiness");
    });
    return answer ?? undefined;
  }
}

function ids<Name extends string>(value: unknown, name: Name) {
  if (!Array.isArray(value) || new Set(value).size !== value.length)
    throw new Error("malformed authority");
  return value.map((item) => decodeOpaqueId(item, name));
}
async function one(client: PostgreSqlClient, sql: string, values: readonly unknown[]) {
  const { rows } = await client.query(sql, values);
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (typeof row !== "object" || row === null) return undefined;
  return row as Record<string, unknown>;
}
async function read<T>(
  client: PostgreSqlClient,
  settings: Readonly<Record<string, string>>,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withClientTransaction(client, {}, async () => {
      await client.query("SET TRANSACTION READ ONLY");
      for (const [key, value] of Object.entries(settings))
        await client.query("SELECT set_config($1, $2, true)", [key, value]);
      return operation();
    });
  } catch (error) {
    // Malformed durable facts refuse; connection failures are handled at composition.
    if (
      error instanceof Error &&
      (error.name === "ContractDecodeError" || error.message === "malformed authority")
    )
      return undefined;
    throw error;
  }
}
