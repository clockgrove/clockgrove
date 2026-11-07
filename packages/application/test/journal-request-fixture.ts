import {
  constructActorAddress,
  decodeActorTargetBinding,
  decodeAttributionEnvelope,
  decodeCommandEnvelope,
  decodeOpaqueId,
  decodePrivacyCategory,
  decodePrivacyCeiling,
} from "@clockgrove/contracts";
import { canonicalBytes, simulationTimeMs } from "@clockgrove/kernel";

import {
  allowDecision,
  computePayloadHash,
  type JournalEventDraft,
  type JournalExecuteRequest,
} from "../src/index.js";

export interface FixtureScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly partitionId: string;
  readonly spaceId: string;
  readonly streamId: string;
}

export const FIXTURE_EVENT_TYPE = "Recorded";

export const FIXTURE_SCOPE: FixtureScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  worldId: "world-1",
  timelineId: "timeline-1",
  partitionId: "partition-1",
  spaceId: "space-1",
  streamId: "stream-1",
};

function routeOf(scope: FixtureScope) {
  return {
    partitionId: decodeOpaqueId(scope.partitionId, "PartitionId"),
    spaceId: decodeOpaqueId(scope.spaceId, "SpaceId"),
    streamId: decodeOpaqueId(scope.streamId, "StreamId"),
  };
}

/** A draft of `Recorded` at schema version 2 whose hash matches its payload, unless overridden. */
export function fixtureDraft(
  scope: FixtureScope,
  eventId: string,
  overrides: Partial<JournalEventDraft> = {},
): JournalEventDraft {
  const payload = overrides.payload ?? { eventId };
  return {
    schemaVersion: 2,
    eventId: decodeOpaqueId(eventId, "EventId"),
    type: FIXTURE_EVENT_TYPE,
    ...routeOf(scope),
    simulationTime: simulationTimeMs(0n),
    correlationId: decodeOpaqueId("correlation-1", "CorrelationId"),
    attribution: decodeAttributionEnvelope({
      effectiveActorId: scope.worldId,
      causalRootActionId: "action-1",
      authorityDecisionId: "authority-1",
    }),
    policyVersions: {},
    privacyClass: decodePrivacyCategory("public_scene"),
    payloadHash: computePayloadHash(payload),
    payload,
    ...overrides,
  };
}

export function fixtureRequest(
  scope: FixtureScope,
  commandId: string,
  events: readonly JournalEventDraft[],
): JournalExecuteRequest {
  const binding = decodeActorTargetBinding({
    tenantId: scope.tenantId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    kind: "world",
    id: scope.worldId,
  });
  const rawCommand = {
    schemaVersion: 2,
    commandId,
    type: "Record",
    target: constructActorAddress(binding),
    expected: {},
    issuedAt: "2026-10-01T00:00:00.000Z",
    context: { version: 1, correlationId: "correlation-1", requestId: `request-${commandId}` },
    attribution: { effectiveActorId: scope.worldId, causalRootActionId: "action-1" },
    payload: {},
  };
  const command = decodeCommandEnvelope<string, unknown>(rawCommand, binding, (payload) => payload);
  const authorization = {
    tenantId: decodeOpaqueId(scope.tenantId, "TenantId"),
    principalId: decodeOpaqueId(scope.principalId, "PrincipalId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
  };
  const authorityDecision = allowDecision({
    tenantId: command.target.tenantId,
    worldId: command.target.worldId,
    timelineId: command.target.timelineId,
    commandId: command.commandId,
    attribution: command.attribution,
    inputs: {
      principalId: authorization.principalId,
      roles: [],
      grants: [],
      privacyCeiling: authorization.privacyCeiling,
    },
  });
  return {
    authorization,
    command,
    commandBytes: canonicalBytes(rawCommand),
    route: routeOf(scope),
    authorityDecision,
    // Every draft seals the command's minted decision.
    events: events.map((draft) => ({
      ...draft,
      attribution: {
        ...draft.attribution,
        authorityDecisionId: authorityDecision.authorityDecisionId,
      },
    })),
    dispatches: [],
    stableResult: { ok: true },
    projectionDelta: null,
  };
}
