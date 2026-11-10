import {
  constructActorAddress,
  decodeActorTargetBinding,
  decodeAttributionEnvelope,
  decodeCommandEnvelope,
  decodeOpaqueId,
} from "@clockgrove/contracts";
import { simulationTimeMs } from "@clockgrove/kernel";
import { allowDecision } from "./authority-decision.js";
import type { JournalExecuteRequest } from "./journal.js";
import { computePayloadHash } from "./journal-verification.js";
import type { McpDiscoverySnapshot } from "./mcp-http.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

export interface McpInstallationAuthority {
  readonly membershipId: string;
  readonly personaId: string;
  readonly roles: readonly string[];
  readonly grants: readonly string[];
  readonly simulationTime: string;
}
export const MCP_INSTALLATION_GRANT = "runtime:mcp-install";
export type McpEffectClass =
  | "read"
  | "world-write"
  | "external-write"
  | "destructive"
  | "network"
  | "cost";
export interface McpInstallationScope {
  readonly worldId: string;
  readonly timelineId: string;
  readonly spaceId: string;
  readonly partitionId: string;
  readonly streamId: string;
}
export type McpInstallationChange =
  | {
      readonly action: "install";
      readonly installationId: string;
      readonly url: string;
      readonly snapshot: McpDiscoverySnapshot;
    }
  | {
      readonly action: "refresh";
      readonly installationId: string;
      readonly snapshot: McpDiscoverySnapshot;
    }
  | {
      readonly action: "review";
      readonly installationId: string;
      readonly candidateId: string;
      readonly schemaHash: string;
      readonly protocolVersion: string;
      readonly effectClass: McpEffectClass;
      readonly enabled: boolean;
    }
  | { readonly action: "disable" | "revoke"; readonly installationId: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Trusted composition supplies discovery snapshots, never browser-supplied server claims. */
export function mcpInstallationRequest(
  authorization: RuntimeAuthorizationContext,
  scope: McpInstallationScope,
  change: McpInstallationChange,
  commandId: string,
  issuedAt: string,
  authority: McpInstallationAuthority,
): JournalExecuteRequest {
  const binding = decodeActorTargetBinding({
    tenantId: authorization.tenantId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    kind: "world",
    id: scope.worldId,
  });
  const attribution = {
    principalId: authorization.principalId,
    worldMembershipId: decodeOpaqueId(authority.membershipId, "WorldMembershipId"),
    personaId: decodeOpaqueId(authority.personaId, "WorldPersonaId"),
    initiatorId: authorization.principalId,
    effectiveActorId: authority.personaId,
    causalRootActionId: commandId,
  };
  const payload = { operationJson: stableJson(change) };
  const rawCommand = {
    schemaVersion: 2,
    commandId,
    type: "McpInstallationChange",
    target: constructActorAddress(binding),
    expected: {},
    issuedAt,
    context: { version: 1, correlationId: commandId, requestId: commandId },
    attribution,
    payload,
  };
  const command = decodeCommandEnvelope<string, unknown>(rawCommand, binding, (x) => x);
  const route = {
    partitionId: decodeOpaqueId(scope.partitionId, "PartitionId"),
    spaceId: decodeOpaqueId(scope.spaceId, "SpaceId"),
    streamId: decodeOpaqueId(scope.streamId, "StreamId"),
  };
  const authorityDecision = allowDecision({
    tenantId: authorization.tenantId,
    worldId: command.target.worldId,
    timelineId: command.target.timelineId,
    commandId: command.commandId,
    attribution: command.attribution,
    inputs: {
      principalId: authorization.principalId,
      worldMembershipId: attribution.worldMembershipId,
      personaId: attribution.personaId,
      roles: authority.roles.map((x) => decodeOpaqueId(x, "RoleId")),
      grants: authority.grants.map((x) => decodeOpaqueId(x, "GrantRef")),
      privacyCeiling: authorization.privacyCeiling,
    },
  });
  return {
    authorization,
    command,
    commandBytes: new TextEncoder().encode(stableJson(rawCommand)),
    route,
    authorityDecision,
    events: [
      {
        schemaVersion: 2,
        eventId: decodeOpaqueId(`${commandId}:event`, "EventId"),
        type: "McpInstallationChanged",
        ...route,
        simulationTime: simulationTimeMs(BigInt(authority.simulationTime)),
        correlationId: decodeOpaqueId(commandId, "CorrelationId"),
        attribution: decodeAttributionEnvelope({
          ...attribution,
          authorityDecisionId: authorityDecision.authorityDecisionId,
        }),
        principalId: authorization.principalId,
        policyVersions: {},
        privacyClass: "operator_evidence",
        payloadHash: computePayloadHash(payload),
        payload,
      },
    ],
    dispatches: [],
    stableResult: { installationId: change.installationId },
    projectionDelta: null,
  };
}
