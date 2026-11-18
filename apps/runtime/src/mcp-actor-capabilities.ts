import {
  type ActorCommandPolicy,
  actorCommandPolicyOf,
  CAPABILITY_REGISTRY,
  type McpCapabilityBinding,
  type McpRegistryContext,
  type McpRegistryInstallation,
  type RuntimeAuthorizationContext,
  resolveMcpCapabilityRegistry,
} from "@clockgrove/application";
import {
  type PostgreSqlClient,
  PostgreSqlWorldOwnerReader,
  withClientTransaction,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";

/**
 * The world's own declaration of the commands its actors may propose (issue 359), read from the
 * installed pack's policies under the member's row security. Undefined when the pack has none.
 */
export async function readActorCommandPolicy(
  client: PostgreSqlClient,
  authorization: RuntimeAuthorizationContext,
  scope: { readonly tenantId: string; readonly worldId: string },
): Promise<ActorCommandPolicy | undefined> {
  const installed = await new PostgreSqlWorldOwnerReader(client).installedResources(
    authorization,
    scope as Parameters<PostgreSqlWorldOwnerReader["installedResources"]>[1],
    "policies",
  );
  return actorCommandPolicyOf(
    installed.resources.map((resource) => decodeResource(resource.content, resource.path)),
  );
}

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
  /** The world's actor-command declaration (issue 359); without one, no `world.command` grant. */
  actorCommands?: ActorCommandPolicy,
): ReturnType<typeof readActorMcpCapabilities> {
  if (providerEnvironment !== "local")
    return {
      registry: CAPABILITY_REGISTRY,
      grants: CAPABILITY_REGISTRY.grantsFor(runtimeGrants, actorCommands),
      revision: 0,
    };
  return loadCanonical();
}
