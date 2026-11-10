import { type McpDiscoverySnapshot, RemoteHttpMcpDiscovery } from "./mcp-http.js";
import type { McpInstallationChange, McpInstallationScope } from "./mcp-installations.js";
import { type McpNetworkPort, McpRefusal, SafeMcpHttpClient } from "./mcp-network.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

export interface McpInstallationGovernancePort {
  authorize(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
  ): Promise<boolean>;
  read(
    authorization: RuntimeAuthorizationContext,
    scope: Pick<McpInstallationScope, "worldId" | "timelineId">,
    installationId: string,
  ): Promise<Record<string, unknown> | undefined>;
  change(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    change: McpInstallationChange,
    commandId: string,
    issuedAt: string,
  ): Promise<unknown>;
}

export type McpInstallationReviewChange = Extract<
  McpInstallationChange,
  { readonly action: "review" | "disable" | "revoke" }
>;

function snapshotContext(
  authorization: RuntimeAuthorizationContext,
  scope: McpInstallationScope,
): [RuntimeAuthorizationContext, McpInstallationScope] {
  return [
    {
      ...authorization,
      privacyCeiling: {
        ...authorization.privacyCeiling,
        allowedCategories: [...authorization.privacyCeiling.allowedCategories],
      },
    },
    { ...scope },
  ];
}

/** Trusted composition supplies authenticated identity and an admitted-address network adapter. */
export class McpInstallationService {
  private readonly discovery: RemoteHttpMcpDiscovery;
  constructor(
    private readonly governance: McpInstallationGovernancePort,
    network: McpNetworkPort,
  ) {
    this.discovery = new RemoteHttpMcpDiscovery(new SafeMcpHttpClient(network));
  }

  private async authorize(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
  ): Promise<void> {
    let allowed = false;
    try {
      allowed = await this.governance.authorize(authorization, scope);
    } catch {
      throw new McpRefusal("installation_authority_required");
    }
    if (!allowed) throw new McpRefusal("installation_authority_required");
  }

  private async commit(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    change: McpInstallationChange,
    commandId: string,
    issuedAt: string,
  ): Promise<void> {
    try {
      // The canonical writer rechecks authority after the network round trips.
      await this.governance.change(authorization, scope, change, commandId, issuedAt);
    } catch {
      throw new McpRefusal("installation_change_failed");
    }
  }

  async install(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    input: { readonly installationId: string; readonly url: string },
    commandId: string,
    issuedAt: string,
  ): Promise<void> {
    const { installationId, url } = input;
    [authorization, scope] = snapshotContext(authorization, scope);
    await this.authorize(authorization, scope);
    const snapshot = await this.discovery.discover(url);
    await this.commit(
      authorization,
      scope,
      { action: "install", installationId, url, snapshot },
      commandId,
      issuedAt,
    );
  }

  async refresh(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    installationId: string,
    commandId: string,
    issuedAt: string,
  ): Promise<void> {
    [authorization, scope] = snapshotContext(authorization, scope);
    await this.authorize(authorization, scope);
    let record: Record<string, unknown> | undefined;
    try {
      record = await this.governance.read(authorization, scope, installationId);
    } catch {
      throw new McpRefusal("installation_unavailable");
    }
    if (
      record?.space_id !== scope.spaceId ||
      record.status !== "active" ||
      typeof record.url !== "string"
    )
      throw new McpRefusal("installation_unavailable");
    let snapshot: McpDiscoverySnapshot;
    try {
      snapshot = await this.discovery.discover(record.url);
    } catch (error) {
      // Without a complete admitted listing, none of the old reviews is safe to retain.
      await this.commit(
        authorization,
        scope,
        { action: "disable", installationId },
        // Safety invalidation is a new command, even when the refresh command was retried.
        crypto.randomUUID(),
        issuedAt,
      );
      if (error instanceof McpRefusal) throw error;
      throw new McpRefusal("discovery_failed");
    }
    await this.commit(
      authorization,
      scope,
      { action: "refresh", installationId, snapshot },
      commandId,
      issuedAt,
    );
  }

  async change(
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    input: McpInstallationReviewChange,
    commandId: string,
    issuedAt: string,
  ): Promise<void> {
    [authorization, scope] = snapshotContext(authorization, scope);
    let change: McpInstallationReviewChange;
    if (input.action === "review") {
      change = {
        action: "review",
        installationId: input.installationId,
        candidateId: input.candidateId,
        schemaHash: input.schemaHash,
        protocolVersion: input.protocolVersion,
        effectClass: input.effectClass,
        enabled: input.enabled,
      };
    } else if (input.action === "disable" || input.action === "revoke") {
      change = { action: input.action, installationId: input.installationId };
    } else {
      throw new McpRefusal("installation_change_failed");
    }
    await this.authorize(authorization, scope);
    await this.commit(authorization, scope, change, commandId, issuedAt);
  }
}
