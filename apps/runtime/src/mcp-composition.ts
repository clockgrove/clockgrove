import type { McpNetworkPort, McpOAuthClient } from "@clockgrove/application";
import type { McpSecretPostgreSqlClient } from "@clockgrove/persistence";
import {
  type McpRuntimeConfiguration,
  McpRuntimeOperator,
  openPostgreSqlMcpProvider,
} from "./mcp.js";

/** Local composition inputs are trusted operator configuration, never request fields. */
export interface McpCompositionConfiguration {
  readonly environment: string;
  readonly runtimeDatabaseUrl: string;
  readonly withClient: McpRuntimeConfiguration["withClient"];
  readonly openSecretClient: () => McpSecretPostgreSqlClient;
  /** Direct, separately privileged, non-pooling connection; never the runtime Hyperdrive. */
  readonly secretDatabaseUrl: string;
  readonly credentialKeyring: {
    readonly activeVersion: string;
    readonly keys: ReadonlyMap<string, Awaited<ReturnType<typeof crypto.subtle.importKey>>>;
  };
  readonly network: McpNetworkPort;
  readonly oauthClient: (url: string) => McpOAuthClient;
  readonly maxInstallations: number;
  readonly changed: McpRuntimeConfiguration["changed"];
}

/** Hosted activation awaits issue 3's egress receipt; the local network has no production switch. */
export function composeMcpOperator(configuration: McpCompositionConfiguration): McpRuntimeOperator {
  if (configuration.environment !== "local")
    throw new Error("MCP hosted activation pending issue 3");
  if (
    !configuration.runtimeDatabaseUrl ||
    !configuration.secretDatabaseUrl ||
    configuration.secretDatabaseUrl === configuration.runtimeDatabaseUrl
  )
    throw new Error("MCP isolated provider configuration required");
  return new McpRuntimeOperator({
    withClient: configuration.withClient,
    network: configuration.network,
    openProvider: (scope) =>
      openPostgreSqlMcpProvider(
        configuration.openSecretClient(),
        scope,
        configuration.credentialKeyring,
        configuration.network,
      ),
    oauthClient: configuration.oauthClient,
    maxInstallations: configuration.maxInstallations,
    changed: configuration.changed,
  });
}
