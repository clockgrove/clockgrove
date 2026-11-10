import {
  type McpBinding,
  type McpInstallationAuthority,
  type McpInstallationScope,
  type McpScopedBinding,
  mcpBindingRequest,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { decodeResult, encodeRequest } from "./postgres-journal.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

/** Canonical policy adapter; callers cannot write bindings without their attributed Journal event. */
export class PostgreSqlMcpBindings {
  constructor(private readonly client: PostgreSqlClient) {}
  authorize(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
  ): Promise<boolean> {
    authorization = structuredClone(authorization);
    scope = { ...scope };
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.mcp_install_authority($1,$2,$3,$4,$5) AS authority",
        [authorization.tenantId, scope.worldId, scope.timelineId, scope.spaceId, scope.partitionId],
      );
      return (result.rows[0] as { authority: McpInstallationAuthority | null }).authority !== null;
    });
  }
  change(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    change: McpBinding,
    commandId: string,
    issuedAt: string,
  ) {
    authorization = structuredClone(authorization);
    scope = { ...scope };
    change = structuredClone(change);
    return withClientTransaction(this.client, { authorization }, async () => {
      const canonical = await this.client.query(
        "SELECT clockgrove.mcp_install_authority($1,$2,$3,$4,$5) AS authority",
        [authorization.tenantId, scope.worldId, scope.timelineId, scope.spaceId, scope.partitionId],
      );
      const authority = (canonical.rows[0] as { authority: McpInstallationAuthority | null })
        .authority;
      if (authority === null) throw new Error("MCP installation authority required");
      const request = mcpBindingRequest(
        authorization,
        scope,
        change,
        commandId,
        issuedAt,
        authority,
      );
      const result = await this.client.query(
        "SELECT clockgrove.change_mcp_binding($1::bytea,$2::jsonb) AS result",
        [request.commandBytes, encodeRequest(request)],
      );
      return decodeResult(result.rows[0]);
    });
  }
  list(
    authorization: RuntimeAuthorizationContext,
    scope: Pick<McpInstallationScope, "worldId" | "timelineId">,
    installationId: string,
  ) {
    authorization = structuredClone(authorization);
    scope = { ...scope };
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        "SELECT binding,tenant_id,world_id,timeline_id FROM clockgrove.mcp_bindings WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND installation_id=$4 ORDER BY binding_id",
        [authorization.tenantId, scope.worldId, scope.timelineId, installationId],
      );
      return result.rows.map((row) => {
        const value = row as {
          binding: McpBinding;
          tenant_id: string;
          world_id: string;
          timeline_id: string;
        };
        return {
          ...value.binding,
          tenantId: value.tenant_id,
          worldId: value.world_id,
          timelineId: value.timeline_id,
        } satisfies McpScopedBinding;
      });
    });
  }
}
