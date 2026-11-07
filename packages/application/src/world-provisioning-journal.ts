import {
  constructActorAddress,
  decodeActorTargetBinding,
  decodeAttributionEnvelope,
  decodeCommandEnvelope,
  decodeOpaqueId,
  decodePrivacyCategory,
} from "@clockgrove/contracts";
import { canonicalBytes, simulationTimeMs } from "@clockgrove/kernel";

import { allowDecision, worldProvisioningCommandId } from "./authority-decision.js";
import { encodeCanonicalNode } from "./canonical-node.js";
import {
  JOURNAL_EVENT_REGISTRY,
  WORLD_GENESIS_CREATED,
  WORLD_PROJECTION_VERIFIED,
  WORLD_READY,
  WORLD_SEED_COMMAND_APPLIED,
} from "./event-registry.js";
import type { JournalExecuteRequest } from "./journal.js";
import { computePayloadHash, verifyJournalRequest } from "./journal-verification.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type { BirthPartition } from "./world-birth.js";
import type { GenesisBirth } from "./world-provisioning-ports.js";

const ACTOR = "world-provisioning";

interface Step {
  readonly commandId: string;
  readonly commandType: string;
  readonly eventType: string;
  readonly payload: unknown;
}

/**
 * One verified canonical journal command with exactly one lifecycle event on the first space's stream. Every
 * identifier derives from the genesis command id, so a retried step presents identical bytes and the
 * journal replays its stored receipt instead of appending again.
 */
function lifecycleRequest(
  authorization: RuntimeAuthorizationContext,
  birth: GenesisBirth,
  partition: BirthPartition,
  step: Step,
): JournalExecuteRequest {
  const { tenantId, worldId, timelineId } = birth.world;
  const binding = decodeActorTargetBinding({
    tenantId,
    worldId,
    timelineId,
    kind: "world",
    id: worldId,
  });
  const attribution = {
    effectiveActorId: ACTOR,
    causalRootActionId: birth.genesisCommandId,
  };
  // Stage command IDs live in the trusted namespace, which runtime requests may not use.
  const commandId = worldProvisioningCommandId(step.commandId);
  const rawCommand = {
    schemaVersion: 2,
    commandId,
    type: step.commandType,
    target: constructActorAddress(binding),
    expected: {},
    issuedAt: birth.clock.wallEpoch,
    context: { version: 1, correlationId: birth.genesisCommandId, requestId: commandId },
    attribution,
    payload: step.payload,
  };
  const command = decodeCommandEnvelope<string, unknown>(rawCommand, binding, (payload) => payload);
  const route = {
    partitionId: decodeOpaqueId(partition.partitionId, "PartitionId"),
    spaceId: decodeOpaqueId(partition.spaceId, "SpaceId"),
    streamId: decodeOpaqueId(partition.streamId, "StreamId"),
  };
  // Each stage is its own command with its own minted decision. Provisioning runs with the
  // caller's trusted authorization context; its inputs are recorded as they are.
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
  const request: JournalExecuteRequest = {
    authorization,
    command,
    commandBytes: canonicalBytes(rawCommand),
    route,
    authorityDecision,
    events: [
      {
        schemaVersion: 2,
        eventId: decodeOpaqueId(`${commandId}:event`, "EventId"),
        type: step.eventType,
        ...route,
        simulationTime: simulationTimeMs(birth.clock.epoch),
        correlationId: decodeOpaqueId(birth.genesisCommandId, "CorrelationId"),
        attribution: decodeAttributionEnvelope({
          ...attribution,
          authorityDecisionId: authorityDecision.authorityDecisionId,
        }),
        policyVersions: {},
        privacyClass: decodePrivacyCategory("public_scene"),
        payloadHash: computePayloadHash(step.payload),
        payload: step.payload,
      },
    ],
    dispatches: [],
    stableResult: { commandId, eventType: step.eventType },
    projectionDelta: null,
  };
  verifyJournalRequest(request, JOURNAL_EVENT_REGISTRY);
  return request;
}

export function genesisCreatedRequest(
  authorization: RuntimeAuthorizationContext,
  birth: GenesisBirth,
  partitions: readonly BirthPartition[],
  caseId: string,
  first: BirthPartition,
): JournalExecuteRequest {
  return lifecycleRequest(authorization, birth, first, {
    commandId: birth.genesisCommandId,
    commandType: "CreateWorldGenesis",
    eventType: WORLD_GENESIS_CREATED,
    payload: {
      caseId,
      packId: birth.artifact.packId,
      packVersion: birth.artifact.version,
      contentHash: birth.artifact.contentHash,
      worldId: birth.world.worldId,
      timelineId: birth.world.timelineId,
      partitions: partitions.map((partition) => ({
        spaceId: partition.spaceId,
        partitionId: partition.partitionId,
        streamId: partition.streamId,
      })),
      seedCommands: birth.seedCommands.length,
      expectedSeedProjectionHash: birth.expectedSeedProjectionHash,
    },
  });
}

/** The recorded kernel events of one seed command, typed-node encoded inside a single lifecycle event. */
export function seedCommandAppliedRequest(
  authorization: RuntimeAuthorizationContext,
  birth: GenesisBirth,
  first: BirthPartition,
  index: number,
): JournalExecuteRequest {
  const seed = birth.seedCommands[index];
  if (seed === undefined) throw new RangeError(`seed command ${index} does not exist`);
  const events = birth.events.filter(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "commandId" in event &&
      event.commandId === seed.commandId,
  );
  return lifecycleRequest(authorization, birth, first, {
    commandId: seed.commandId,
    commandType: seed.type,
    eventType: WORLD_SEED_COMMAND_APPLIED,
    payload: {
      key: seed.key,
      type: seed.type,
      version: seed.version,
      commandId: seed.commandId,
      eventCount: events.length,
      events: encodeCanonicalNode(events),
    },
  });
}

export function projectionVerifiedRequest(
  authorization: RuntimeAuthorizationContext,
  birth: GenesisBirth,
  first: BirthPartition,
  reconstructedHash: string,
): JournalExecuteRequest {
  return lifecycleRequest(authorization, birth, first, {
    commandId: `${birth.genesisCommandId}:projection-verified`,
    commandType: "VerifyWorldProjection",
    eventType: WORLD_PROJECTION_VERIFIED,
    payload: {
      expectedSeedProjectionHash: birth.expectedSeedProjectionHash,
      reconstructedSeedProjectionHash: reconstructedHash,
    },
  });
}

export function worldReadyRequest(
  authorization: RuntimeAuthorizationContext,
  birth: GenesisBirth,
  first: BirthPartition,
  installationId: string,
): JournalExecuteRequest {
  return lifecycleRequest(authorization, birth, first, {
    commandId: `${birth.genesisCommandId}:world-ready`,
    commandType: "MarkWorldReady",
    eventType: WORLD_READY,
    payload: {
      worldId: birth.world.worldId,
      timelineId: birth.world.timelineId,
      installationId,
      seedProjectionHash: birth.expectedSeedProjectionHash,
    },
  });
}
