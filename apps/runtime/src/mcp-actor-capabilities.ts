import {
  CAPABILITY_REGISTRY,
  type McpCapabilityBinding,
  type McpRegistryContext,
  type McpRegistryInstallation,
  type RuntimeAuthorizationContext,
  resolveMcpCapabilityRegistry,
} from "@clockgrove/application";
import { type PostgreSqlClient, withClientTransaction } from "@clockgrove/persistence";

/** Fresh canonical admission for a new actor use; no credentials, network or remote executor. */
export function readActorMcpCapabilities(
  client: PostgreSqlClient,
  authorization: RuntimeAuthorizationContext,
  context: McpRegistryContext,
) {
  authorization = structuredClone(authorization);
  context = structuredClone(context);
  if (authorization.tenantId !== context.tenantId) throw new Error("MCP actor context unavailable");
  return withClientTransaction(client, { authorization }, async () => {
    const result = await client.query(
      "SELECT clockgrove.actor_mcp_admission($1,$2,$3,$4,$5) AS admission",
      [context.tenantId, context.worldId, context.timelineId, context.actorId, context.sessionId],
    );
    const admission = (
      result.rows[0] as {
        admission: {
          revision: string;
          installations: McpRegistryInstallation[];
          bindings: McpCapabilityBinding[];
        };
      }
    ).admission;
    const revision = Number(admission.revision);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("MCP capability revision unavailable");
    return {
      ...resolveMcpCapabilityRegistry(admission.installations, admission.bindings, context),
      revision,
    };
  });
}

/** Hosted admission stays internal until the deployed private-egress receipt is accepted. */
export async function resolveActorCapabilities(
  providerEnvironment: string | undefined,
  runtimeGrants: readonly string[],
  loadCanonical: () => ReturnType<typeof readActorMcpCapabilities>,
): ReturnType<typeof readActorMcpCapabilities> {
  if (providerEnvironment !== "local")
    return {
      registry: CAPABILITY_REGISTRY,
      grants: CAPABILITY_REGISTRY.grantsFor(runtimeGrants),
      revision: 0,
    };
  return loadCanonical();
}
