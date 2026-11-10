import {
  type McpInstallationAuthority,
  type McpInstallationChange,
  type McpInstallationScope,
  mcpInstallationRequest,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { decodeResult, encodeRequest } from "./postgres-journal.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

/** Internal governance seam; discovery/network and authenticated routes compose in later parts. */
export class PostgreSqlMcpInstallations {
  constructor(private readonly client: PostgreSqlClient) {}
  change(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    change: McpInstallationChange,
    commandId: string,
    issuedAt: string,
  ) {
    return withClientTransaction(this.client, { authorization }, async () => {
      const canonical = await this.client.query(
        "SELECT clockgrove.mcp_install_authority($1,$2,$3,$4,$5) AS authority",
        [authorization.tenantId, scope.worldId, scope.timelineId, scope.spaceId, scope.partitionId],
      );
      const authority = (canonical.rows[0] as { authority: McpInstallationAuthority | null })
        .authority;
      if (authority === null) throw new Error("MCP installation authority required");
      const request = mcpInstallationRequest(
        authorization,
        scope,
        change,
        commandId,
        issuedAt,
        authority,
      );
      const result = await this.client.query(
        "SELECT clockgrove.change_mcp_installation($1::bytea,$2::jsonb) AS result",
        [request.commandBytes, encodeRequest(request)],
      );
      return decodeResult(result.rows[0]);
    });
  }
  read(
    authorization: RuntimeAuthorizationContext,
    scope: Pick<McpInstallationScope, "worldId" | "timelineId">,
    installationId: string,
  ) {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        "SELECT installation_id,owner_principal_id,url,status,snapshot,reviews,drifted,revision::text AS revision FROM clockgrove.mcp_installations WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND installation_id=$4",
        [authorization.tenantId, scope.worldId, scope.timelineId, installationId],
      );
      return result.rows[0] as Record<string, unknown> | undefined;
    });
  }
}
