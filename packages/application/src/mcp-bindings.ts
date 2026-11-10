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
import type {
  McpEffectClass,
  McpInstallationAuthority,
  McpInstallationScope,
} from "./mcp-installations.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

export interface McpBindingConstraints {
  readonly inputFields?: readonly string[];
  readonly destinations?: readonly string[];
  readonly callsPerTurn: number;
  readonly effectClasses: readonly McpEffectClass[];
  readonly budgetMicrousd?: number;
  readonly expiresAt?: string;
}
export interface McpBinding {
  readonly bindingId: string;
  readonly installationId: string;
  readonly candidateId: string;
  readonly schemaHash: string;
  readonly protocolVersion: string;
  readonly scopeType: "tenant" | "world" | "timeline" | "actor" | "session";
  readonly scopeId: string;
  readonly effect: "allow" | "deny";
  readonly enabled: boolean;
  readonly constraints: McpBindingConstraints;
}

export interface McpScopedBinding extends McpBinding {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Bindings change only under canonical installation authority; the Journal retains every policy. */
export function mcpBindingRequest(
  authorization: RuntimeAuthorizationContext,
  scope: McpInstallationScope,
  change: McpBinding,
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
    type: "McpBindingChange",
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
        type: "McpBindingChanged",
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
    stableResult: { installationId: change.installationId, bindingId: change.bindingId },
    projectionDelta: null,
  };
}
