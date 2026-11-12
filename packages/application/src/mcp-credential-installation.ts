import {
  McpCredentialError,
  type McpCredentialScope,
  McpCredentialVault,
  type McpOAuthClient,
} from "./mcp-credentials.js";
import {
  type AdmittedMcpRead,
  type McpReadEvidence,
  McpReadFailure,
  RemoteHttpMcpReadAdapter,
} from "./mcp-execution.js";
import {
  type McpInstallationGovernancePort,
  McpInstallationService,
} from "./mcp-installation-service.js";
import type { McpInstallationScope } from "./mcp-installations.js";
import {
  type McpNetworkPort,
  McpRefusal,
  remoteMcpUrl,
  SafeMcpHttpClient,
  safeMcpNetworkRefusal,
} from "./mcp-network.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

export interface McpOwnedCredentialProvider {
  readonly vault: McpCredentialVault;
  /** Closing must fence this provider's references before a successor can use them. */
  close(): Promise<void>;
}

/**
 * An exclusive trusted owner of one credential-backed installation attempt. The handle must stay
 * alive across OAuth callbacks; it is not a deployed route or a durable reference directory.
 */
export class McpCredentialInstallation {
  private reference: string | undefined;
  private installed = false;
  private oauth = false;
  private closed = false;
  private busy = false;
  private readonly service: McpInstallationService;

  private constructor(
    private readonly governance: McpInstallationGovernancePort,
    private readonly authorization: RuntimeAuthorizationContext,
    private readonly scope: McpInstallationScope,
    private readonly credentialScope: McpCredentialScope,
    private readonly url: string,
    private readonly provider: McpOwnedCredentialProvider,
    private readonly network: McpNetworkPort,
  ) {
    this.service = new McpInstallationService(governance, network, {
      use: async (send) => {
        if (this.reference === undefined) throw new McpCredentialError();
        return this.provider.vault.use(this.credentialScope, this.reference, send);
      },
    });
  }

  static async open(
    governance: McpInstallationGovernancePort,
    network: McpNetworkPort,
    authorization: RuntimeAuthorizationContext,
    scope: McpInstallationScope,
    input: { readonly installationId: string; readonly url: string },
    openProvider: (scope: McpCredentialScope) => Promise<McpOwnedCredentialProvider>,
  ): Promise<McpCredentialInstallation> {
    authorization = {
      ...authorization,
      privacyCeiling: {
        ...authorization.privacyCeiling,
        allowedCategories: [...authorization.privacyCeiling.allowedCategories],
      },
    };
    scope = { ...scope };
    const { installationId, url } = input;
    try {
      if (!(await governance.authorize(authorization, scope)))
        throw new McpRefusal("installation_authority_required");
      remoteMcpUrl(url);
      if (await governance.read(authorization, scope, installationId))
        throw new McpRefusal("installation_unavailable");
      const credentialScope: McpCredentialScope = Object.freeze({
        tenantId: authorization.tenantId,
        worldId: scope.worldId,
        timelineId: scope.timelineId,
        installationId,
        ownerPrincipalId: authorization.principalId,
      });
      const provider = await openProvider(credentialScope);
      return new McpCredentialInstallation(
        governance,
        authorization,
        scope,
        credentialScope,
        url,
        provider,
        network,
      );
    } catch (error) {
      if (
        error instanceof McpRefusal &&
        ["installation_authority_required", "installation_unavailable"].includes(error.code)
      )
        throw new McpRefusal(error.code);
      throw safeMcpNetworkRefusal(error) ?? new McpCredentialError();
    }
  }

  /** Only the execution adapter resolves the retained credential; no reference leaves this owner. */
  async executeRead(request: AdmittedMcpRead): Promise<McpReadEvidence> {
    if (
      request.endpoint !== this.url ||
      this.reference === undefined ||
      this.closed ||
      !this.installed
    )
      throw new McpReadFailure("credential_unavailable", "not_sent");
    try {
      await this.authorize();
    } catch {
      throw new McpReadFailure("credential_unavailable", "not_sent");
    }
    return new RemoteHttpMcpReadAdapter(
      new SafeMcpHttpClient(this.network),
      this.provider.vault,
    ).execute({
      ...request,
      credential: { scope: this.credentialScope, reference: this.reference },
    });
  }

  private async authorize(allowInactive = false): Promise<void> {
    if (this.closed || !(await this.governance.authorize(this.authorization, this.scope)))
      throw new McpCredentialError();
    const row = await this.governance.read(
      this.authorization,
      this.scope,
      this.credentialScope.installationId,
    );
    if (
      this.installed &&
      (row?.owner_principal_id !== this.credentialScope.ownerPrincipalId ||
        row.url !== this.url ||
        row.space_id !== this.scope.spaceId ||
        !(allowInactive ? ["active", "disabled", "revoked"] : ["active"]).includes(
          String(row.status),
        ))
    )
      throw new McpCredentialError();
    if (!this.installed && row !== undefined) throw new McpCredentialError();
  }

  private async exclusive<T>(operation: () => Promise<T>, allowInactive = false): Promise<T> {
    if (this.busy || this.closed) throw new McpCredentialError();
    this.busy = true;
    try {
      await this.authorize(allowInactive);
      return await operation();
    } catch (error) {
      throw safeMcpNetworkRefusal(error) ?? new McpCredentialError();
    } finally {
      this.busy = false;
    }
  }

  private async install(commandId: string, issuedAt: string): Promise<void> {
    try {
      await this.service.install(
        this.authorization,
        this.scope,
        { installationId: this.credentialScope.installationId, url: this.url },
        commandId,
        issuedAt,
      );
      this.installed = true;
      await this.authorize();
    } catch (error) {
      // A rejected or uncertain install cannot leave a reusable credential in this handle.
      await this.close();
      throw safeMcpNetworkRefusal(error) ?? new McpCredentialError();
    }
  }

  async connectStatic(token: string, commandId: string, issuedAt: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.reference !== undefined) throw new McpCredentialError();
      this.reference = await this.provider.vault.store(this.credentialScope, token);
      await this.install(commandId, issuedAt);
    });
  }

  async beginOAuth(client: McpOAuthClient): Promise<{ readonly authorizationUrl: string }> {
    const captured = { ...client, ...(client.scopes ? { scopes: [...client.scopes] } : {}) };
    return this.exclusive(async () => {
      if (this.reference !== undefined || captured.resource !== this.url)
        throw new McpCredentialError();
      const pending = await this.provider.vault.beginOAuth(this.credentialScope, captured);
      this.reference = pending.reference;
      this.oauth = true;
      return { authorizationUrl: pending.authorizationUrl };
    });
  }

  async completeOAuth(
    callback: { readonly state: string; readonly iss: string; readonly code: string },
    commandId: string,
    issuedAt: string,
  ): Promise<void> {
    const captured = { ...callback };
    return this.exclusive(async () => {
      if (this.reference === undefined || this.installed) throw new McpCredentialError();
      try {
        await this.provider.vault.completeOAuth(this.credentialScope, this.reference, captured);
        await this.install(commandId, issuedAt);
      } catch (error) {
        await this.close();
        throw safeMcpNetworkRefusal(error) ?? new McpCredentialError();
      }
    });
  }

  async refresh(commandId: string, issuedAt: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.installed || this.reference === undefined) throw new McpCredentialError();
      try {
        if (this.oauth) await this.provider.vault.refresh(this.credentialScope, this.reference);
        await this.service.refresh(
          this.authorization,
          this.scope,
          this.credentialScope.installationId,
          commandId,
          issuedAt,
        );
      } catch (error) {
        try {
          await this.service.change(
            this.authorization,
            this.scope,
            { action: "disable", installationId: this.credentialScope.installationId },
            crypto.randomUUID(),
            issuedAt,
          );
        } finally {
          await this.close();
        }
        throw safeMcpNetworkRefusal(error) ?? new McpCredentialError();
      }
    });
  }

  async revoke(commandId: string, issuedAt: string): Promise<void> {
    try {
      await this.exclusive(async () => {
        if (this.installed) {
          const row = await this.governance.read(
            this.authorization,
            this.scope,
            this.credentialScope.installationId,
          );
          if (row?.status !== "revoked")
            await this.service.change(
              this.authorization,
              this.scope,
              { action: "revoke", installationId: this.credentialScope.installationId },
              commandId,
              issuedAt,
            );
        }
        if (this.reference !== undefined)
          await this.provider.vault.revoke(this.credentialScope, this.reference);
      }, true);
    } finally {
      // Even a denied cleanup closes this handle without making an unauthorized remote request.
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.provider.close().catch(() => undefined);
  }
}
