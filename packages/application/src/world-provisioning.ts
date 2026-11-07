import type { ScheduleQueue, WorldScheduledPayload } from "@clockgrove/kernel";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";

import {
  storedProvisioningRequest,
  storedProvisioningRequestIdentity,
} from "./lifecycle-workflows.js";
import { encodePartitionState } from "./partition-state.js";

import type {
  BirthPartition,
  BirthSeedResource,
  BirthState,
  DecodeResource,
} from "./world-birth.js";
import { reconstructSeedProjectionHash, splitBirthState } from "./world-birth.js";
import {
  PackVersionConflictError,
  ProvisioningCaseFailedError,
  ProvisioningStageError,
  WorldGenesisDefectError,
  WorldProvisioningRefusedError,
} from "./world-provisioning-errors.js";
import {
  genesisCreatedRequest,
  projectionVerifiedRequest,
  seedCommandAppliedRequest,
  worldReadyRequest,
} from "./world-provisioning-journal.js";
import type {
  BeginCaseOutcome,
  ProvisionedWorld,
  ProvisionWorldRequest,
  WorldProvisioningPorts,
} from "./world-provisioning-ports.js";

const REQUEST_KIND = "clockgrove.world-provisioning-request";

type OpenCase = Extract<BeginCaseOutcome, { readonly kind: "open" }>;

function assertReconstructs(
  birth: BirthState,
  seedResources: readonly BirthSeedResource[],
  decode: DecodeResource,
  expected: string,
  where: string,
): string {
  const actual = reconstructSeedProjectionHash(birth, seedResources, decode);
  if (actual !== expected) {
    throw new WorldProvisioningRefusedError(
      "PROJECTION_MISMATCH",
      where,
      `reconstructed seed projection ${actual} differs from the expected ${expected}`,
    );
  }
  return actual;
}

/**
 * Births a world from a validated pack artifact through one idempotent, resumable provisioning case.
 *
 * Genesis seeding runs here, outside every database transaction. The store then commits short
 * transactions, one per stage: genesis rows and `WorldGenesisCreated`, one per seed command, the
 * stored-state verification and finally `WorldReady`. A world becomes `ready` only in the last one.
 * Retrying the same case resumes at the first stage that has not committed.
 */
export async function provisionWorld(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
): Promise<ProvisionedWorld> {
  const begun = await beginProvisioning(request, ports);
  if (begun.kind === "ready") return begun.world;
  if (begun.kind === "failed") throw new ProvisioningCaseFailedError(begun.refusal);
  try {
    return await advance(request, ports, begun, "ready");
  } catch (error) {
    throw await recordOutcome(request, ports, error);
  }
}

/** Runs the canonical birth stages and leaves readiness to the readiness Workflow. */
export async function provisionWorldToVerified(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
): Promise<void> {
  const begun = await beginProvisioning(request, ports);
  if (begun.kind === "ready") return;
  if (begun.kind === "failed") throw new ProvisioningCaseFailedError(begun.refusal);
  try {
    await advance(request, ports, begun, "verified");
  } catch (error) {
    throw await recordOutcome(request, ports, error);
  }
}

/** Commits the birth-to-live handoff only after canonical projection verification. */
export async function readyProvisionedWorld(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
): Promise<ProvisionedWorld> {
  const begun = await beginProvisioning(request, ports);
  if (begun.kind === "ready") return begun.world;
  if (begun.kind === "failed") throw new ProvisioningCaseFailedError(begun.refusal);
  if (begun.status !== "verified") {
    throw new ProvisioningStageError(request.caseId, "readiness", begun.status);
  }
  try {
    return await advance(request, ports, begun, "ready");
  } catch (error) {
    throw await recordOutcome(request, ports, error);
  }
}

/** The durable case hash used by direct callers and trusted Workflow registration. */
export function provisioningRequestHash(request: ProvisionWorldRequest): string {
  return sha256Hex(
    canonicalBytes({
      kind: REQUEST_KIND,
      version: 1,
      tenantId: request.authorization.tenantId,
      artifact: request.artifact,
    }),
  );
}

function beginProvisioning(request: ProvisionWorldRequest, ports: WorldProvisioningPorts) {
  return ports.store.beginCase({
    authorization: request.authorization,
    caseId: request.caseId,
    requestHash: provisioningRequestHash(request),
    artifact: request.artifact,
    requestIdentityHash:
      request.registeredIdentityHash ??
      storedProvisioningRequestIdentity(storedProvisioningRequest(request)),
  });
}

/** Records the outcome on the case and returns the error to surface. */
async function recordOutcome(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
  error: unknown,
): Promise<unknown> {
  const scope = { authorization: request.authorization, caseId: request.caseId };
  try {
    if (error instanceof WorldProvisioningRefusedError) {
      await ports.store.recordFailure({ ...scope, refusal: error.refusal });
    } else {
      await ports.store.recordAttemptFailure({
        ...scope,
        failure: {
          code: error instanceof Error ? error.name : "UNKNOWN",
          path: "provisionWorld",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  } catch (evidenceError) {
    return new AggregateError(
      [error, evidenceError],
      "provisioning failed and its failure evidence could not be recorded",
    );
  }
  return error;
}

async function advance(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
  begun: OpenCase,
  phase: "ready",
): Promise<ProvisionedWorld>;
async function advance(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
  begun: OpenCase,
  phase: "verified",
): Promise<void>;
async function advance(
  request: ProvisionWorldRequest,
  ports: WorldProvisioningPorts,
  begun: OpenCase,
  phase: "ready" | "verified",
): Promise<ProvisionedWorld | void> {
  const { authorization, caseId, artifact } = request;
  const scope = { authorization, caseId };
  const { store } = ports;
  if (begun.status === "requested" && begun.storedContentHash !== undefined) {
    if (begun.storedContentHash !== artifact.contentHash) {
      throw new PackVersionConflictError(
        artifact.packId,
        artifact.version,
        begun.storedContentHash,
        artifact.contentHash,
      );
    }
    throw new WorldProvisioningRefusedError(
      "PACK_ALREADY_PROVISIONED",
      "artifact",
      `${artifact.packId}@${artifact.version} is already installed for this tenant by another case`,
    );
  }

  const outcome = await ports.genesis.seed({ artifact, source: request.source });
  if (!outcome.ok) {
    const { code, path, message } = outcome.refusal;
    if (outcome.defect === true) throw new WorldGenesisDefectError(code, path, message);
    throw new WorldProvisioningRefusedError(code, path, message);
  }
  const { birth } = outcome;
  if (birth.world.tenantId !== authorization.tenantId) {
    throw new WorldProvisioningRefusedError(
      "TENANT_MISMATCH",
      "authorization.tenantId",
      `the pack births tenant ${birth.world.tenantId}, not ${authorization.tenantId}`,
    );
  }

  const partitions: BirthPartition[] = birth.spaces.map((space) => ({
    ...space,
    partitionId: `${birth.world.partitionId}:${space.spaceId}`,
    streamId: `${birth.world.partitionId}:${space.spaceId}:stream`,
  }));
  const first = partitions[0];
  if (first === undefined) {
    throw new WorldProvisioningRefusedError(
      "NO_SPACES",
      "pack.spaces",
      "the pack declares no space",
    );
  }
  const stored = splitBirthState({
    state: birth.state,
    schedules: birth.schedules,
    randomState: birth.randomState,
    clock: birth.clock,
    cognitiveSeeds: birth.cognitiveSeeds.map((seed) => ({
      seedId: seed.id,
      seedVersion: seed.version,
      sha256: seed.sha256,
    })),
    partitions,
    seedProjectionHash: birth.expectedSeedProjectionHash,
  });
  assertReconstructs(
    stored,
    birth.resources
      .filter((resource) => resource.kind === "cognitiveSeeds")
      .map((resource) => ({
        seedId: resource.id,
        seedVersion: resource.version,
        sha256: resource.sha256,
        path: resource.path,
        bytes: resource.bytes,
      })),
    ports.decodeResource,
    birth.expectedSeedProjectionHash,
    "birth",
  );
  const installationId = `installation:${caseId}`;

  let status = begun.status;
  if (status === "requested") {
    await store.recordGenesis({
      ...scope,
      artifact,
      resources: birth.resources,
      world: { worldId: birth.world.worldId, timelineId: birth.world.timelineId },
      partitions,
      birth: stored,
      installationId,
      journal: genesisCreatedRequest(authorization, birth, partitions, caseId, first),
    });
    status = "seeding";
  }
  if (status === "seeding") {
    for (let index = begun.seededCommands; index < birth.seedCommands.length; index += 1) {
      await store.applySeedCommand({
        ...scope,
        index,
        journal: seedCommandAppliedRequest(authorization, birth, first, index),
      });
    }
    const read = await store.readBirth({
      ...scope,
      worldId: birth.world.worldId,
      timelineId: birth.world.timelineId,
    });
    const reconstructed = assertReconstructs(
      read.birth,
      read.seedResources,
      ports.decodeResource,
      birth.expectedSeedProjectionHash,
      "storedBirth",
    );
    await store.commitProjectionVerified({
      ...scope,
      journal: projectionVerifiedRequest(authorization, birth, first, reconstructed),
    });
  }
  if (phase === "verified") return;
  // Birth-to-live handoff: the verified post-seed state, schedules and random state become the
  // world's live partition state on the partition that receives its lifecycle events.
  return store.commitReady({
    ...scope,
    journal: worldReadyRequest(authorization, birth, first, installationId),
    live: {
      partition: first,
      state: encodePartitionState({
        state: birth.state,
        schedules: birth.schedules as ScheduleQueue<WorldScheduledPayload>,
        randomState: birth.randomState,
      }),
    },
  });
}
