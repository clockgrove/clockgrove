import type { WorldState } from "@clockgrove/domain";
import { compareUtf16, SCRIPTED_COGNITION_VERSION } from "@clockgrove/domain";
import {
  canonicalBytes,
  canonicalSerialize,
  RANDOM_CONTRACT_VERSION,
  restoreNamedRandomState,
  sha256Hex,
} from "@clockgrove/kernel";

import type { CanonicalNode } from "./canonical-node.js";
import { decodeCanonicalNode, encodeCanonicalNode } from "./canonical-node.js";
import { plainValue } from "./partition-state.js";
import { WorldProvisioningRefusedError } from "./world-provisioning-errors.js";

export const BIRTH_VERSION = 1;

const SCRIPTED_SEED_TYPE = "clockgrove.scripted-cognition";
const SEED_PROJECTION_KIND = "clockgrove.seed-projection";

/** A pack space as one partition: the partition id and stream id derive from the world's genesis partition. */
export interface BirthPartition {
  readonly spaceId: string;
  readonly frameId: string;
  readonly partitionId: string;
  readonly streamId: string;
}

export interface GenesisClockPolicy {
  readonly epoch: bigint;
  readonly wallEpoch: string;
  readonly simulationMillisecondsPerWallMillisecond: number;
  readonly decisionIntervalMs: bigint;
}

/** A cognitive seed stored only as a reference into the immutable pack artifact. */
export interface BirthSeedRef {
  readonly seedId: string;
  readonly seedVersion: number;
  readonly sha256: string;
}

export type BirthSectionName = "environment" | "ecology" | "wellbeing" | "lifecycle" | "processes" | "boundaryExchanges";
export type BirthElementKind = "frame" | "region" | "anchor-graph" | "entity";

export interface BirthSectionRow {
  readonly section: BirthSectionName;
  readonly sectionVersion: number;
  readonly node: CanonicalNode;
}

export interface BirthSpaceRow {
  readonly partitionId: string;
  readonly spaceId: string;
  readonly kind: BirthElementKind;
  readonly key: string;
  /** Position in the original state array; unique per kind across the world. */
  readonly ordinal: number;
  readonly node: CanonicalNode;
}

export interface BirthScheduleRow {
  readonly ordinal: number;
  readonly node: CanonicalNode;
}

export interface BirthRandomStreamRow {
  readonly name: string;
  readonly algorithm: string;
  readonly algorithmVersion: number;
  readonly draws: string;
  readonly stateWords: readonly string[];
}

/** The post-seed world, split into the rows the store keeps. */
export interface BirthState {
  readonly birthVersion: number;
  readonly stateSchemaVersion: number;
  readonly statePartitionId: string;
  readonly scalars: CanonicalNode;
  readonly clockPolicy: CanonicalNode;
  readonly simulationEpoch: string;
  readonly seedProjectionHash: string;
  readonly sections: readonly BirthSectionRow[];
  readonly spaceState: readonly BirthSpaceRow[];
  readonly schedules: readonly BirthScheduleRow[];
  readonly randomStreams: readonly BirthRandomStreamRow[];
  readonly seedRefs: readonly BirthSeedRef[];
}

/** A cognitive seed resource of the stored artifact: its reference and exact bytes. */
export interface BirthSeedResource extends BirthSeedRef {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Decodes the bytes of a pack resource; injected because the pack format belongs to the pack SDK. */
export type DecodeResource = (bytes: Uint8Array, path: string) => unknown;

export interface SplitBirthStateInput {
  readonly state: WorldState;
  readonly schedules: readonly unknown[];
  readonly randomState: string;
  readonly clock: GenesisClockPolicy;
  readonly cognitiveSeeds: readonly BirthSeedRef[];
  readonly partitions: readonly BirthPartition[];
  readonly seedProjectionHash: string;
}

const STATE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "partitionId",
  "tenantId",
  "worldId",
  "timelineId",
  "revision",
  "simulationTime",
  "weather",
  "environment",
  "ecology",
  "processes",
  "boundaryExchanges",
  "wellbeing",
  "lifecycle",
  "scriptedCognition",
  "spatialFrames",
  "spatialRegions",
  "anchorGraphs",
  "entities",
]);

const SECTIONS: readonly BirthSectionName[] = [
  "environment",
  "ecology",
  "wellbeing",
  "lifecycle",
  "processes",
  "boundaryExchanges",
];

function refuse(code: string, path: string, message: string): never {
  throw new WorldProvisioningRefusedError(code, path, message);
}

/**
 * Splits a post-seed state into birth rows. Anything a row cannot represent exactly is refused, so a
 * stored birth can always be reconstructed byte for byte.
 */
export function splitBirthState(input: SplitBirthStateInput): BirthState {
  const { state, partitions } = input;
  for (const key of Object.keys(state)) {
    if (!STATE_KEYS.has(key))
      refuse("UNSUPPORTED_STATE_SECTION", `state.${key}`, "no birth rows store this section");
  }
  if (state.spatialRegions !== undefined && state.spatialRegions.length === 0) {
    refuse(
      "UNSUPPORTED_STATE_SECTION",
      "state.spatialRegions",
      "an empty but present region list cannot be stored",
    );
  }
  if (state.anchorGraphs !== undefined && state.anchorGraphs.length === 0) {
    refuse(
      "UNSUPPORTED_STATE_SECTION",
      "state.anchorGraphs",
      "an empty but present anchor graph list cannot be stored",
    );
  }
  if (state.scriptedCognition !== undefined && input.cognitiveSeeds.length === 0) {
    refuse(
      "COGNITIVE_SEED_MISMATCH",
      "state.scriptedCognition",
      "scripted cognition has no cognitive seed to reference",
    );
  }

  const sections: BirthSectionRow[] = [];
  for (const section of SECTIONS) {
    const value = state[section];
    if (value !== undefined) {
      sections.push({
        section,
        sectionVersion: state.schemaVersion,
        node: encodeCanonicalNode(value),
      });
    }
  }

  const byFrame = new Map(partitions.map((partition) => [partition.frameId, partition]));
  const bySpace = new Map(partitions.map((partition) => [partition.spaceId, partition]));
  const spaceState: BirthSpaceRow[] = [];
  const place = (
    partition: BirthPartition | undefined,
    kind: BirthElementKind,
    key: string,
    ordinal: number,
    value: unknown,
    path: string,
  ): void => {
    if (partition === undefined)
      refuse("UNKNOWN_SPACE_REFERENCE", path, "the element belongs to no declared space");
    spaceState.push({
      partitionId: partition.partitionId,
      spaceId: partition.spaceId,
      kind,
      key,
      ordinal,
      node: encodeCanonicalNode(value),
    });
  };
  state.spatialFrames.forEach((frame, index) =>
    place(
      byFrame.get(frame.frameId),
      "frame",
      frame.frameId,
      index,
      frame,
      `state.spatialFrames[${index}]`,
    ),
  );
  (state.spatialRegions ?? []).forEach((region, index) =>
    place(
      byFrame.get(region.frameId),
      "region",
      `${region.regionId}@${region.version}`,
      index,
      region,
      `state.spatialRegions[${index}]`,
    ),
  );
  (state.anchorGraphs ?? []).forEach((graph, index) =>
    place(
      byFrame.get(graph.frameId),
      "anchor-graph",
      `${graph.graphId}@${graph.version}`,
      index,
      graph,
      `state.anchorGraphs[${index}]`,
    ),
  );
  state.entities.forEach((entity, index) =>
    place(
      bySpace.get(entity.spaceId),
      "entity",
      entity.objectId,
      index,
      entity,
      `state.entities[${index}]`,
    ),
  );

  let randomStreams: BirthRandomStreamRow[];
  try {
    randomStreams = Object.values(restoreNamedRandomState(input.randomState)).map((stream) => {
      if (stream.algorithm.version !== 1)
        throw new TypeError("unsupported random algorithm version");
      return {
        name: stream.name,
        algorithm: stream.algorithm.algorithm,
        algorithmVersion: stream.algorithm.version,
        draws: stream.draws.toString(),
        stateWords: stream.state.map(String),
      };
    });
  } catch (error) {
    if (error instanceof TypeError)
      refuse("UNSUPPORTED_RANDOM_STATE", "randomState", error.message);
    throw error;
  }

  return {
    birthVersion: BIRTH_VERSION,
    stateSchemaVersion: state.schemaVersion,
    statePartitionId: state.partitionId,
    scalars: encodeCanonicalNode({
      tenantId: state.tenantId,
      worldId: state.worldId,
      timelineId: state.timelineId,
      revision: state.revision,
      simulationTime: state.simulationTime,
      weather: state.weather,
    }),
    clockPolicy: encodeCanonicalNode(input.clock),
    simulationEpoch: input.clock.epoch.toString(),
    seedProjectionHash: input.seedProjectionHash,
    sections,
    spaceState,
    schedules: input.schedules.map((schedule, ordinal) => ({
      ordinal,
      node: encodeCanonicalNode(schedule),
    })),
    randomStreams,
    seedRefs: input.cognitiveSeeds,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The scripted cognition state, rebuilt from the referenced seed resources and verified by digest. */
function scriptedCognition(
  refs: readonly BirthSeedRef[],
  resources: readonly BirthSeedResource[],
  decode: DecodeResource,
):
  | {
      readonly schemaVersion: number;
      readonly source: "scripted";
      readonly entries: readonly unknown[];
    }
  | undefined {
  const entries: { readonly ref: string }[] = [];
  let scripted = false;
  for (const ref of refs) {
    const resource = resources.find(
      (candidate) =>
        candidate.seedId === ref.seedId &&
        candidate.seedVersion === ref.seedVersion &&
        candidate.sha256 === ref.sha256,
    );
    if (resource === undefined) {
      refuse(
        "COGNITIVE_SEED_MISMATCH",
        `seed:${ref.seedId}`,
        "the referenced seed is not in the stored artifact",
      );
    }
    if (sha256Hex(resource.bytes) !== ref.sha256) {
      refuse(
        "COGNITIVE_SEED_MISMATCH",
        `seed:${ref.seedId}`,
        "the stored seed bytes do not match their digest",
      );
    }
    const document = decode(resource.bytes, resource.path);
    if (!isRecord(document) || document.type !== SCRIPTED_SEED_TYPE) continue;
    if (!Array.isArray(document.entries)) {
      refuse(
        "COGNITIVE_SEED_MISMATCH",
        `seed:${ref.seedId}`,
        "scripted seed entries must be an array",
      );
    }
    scripted = true;
    for (const entry of document.entries) {
      if (!isRecord(entry) || typeof entry.ref !== "string") {
        refuse("COGNITIVE_SEED_MISMATCH", `seed:${ref.seedId}`, "scripted seed entry has no ref");
      }
      entries.push({ ...entry, ref: entry.ref });
    }
  }
  if (!scripted) return undefined;
  entries.sort((left, right) => compareUtf16(left.ref, right.ref));
  return { schemaVersion: SCRIPTED_COGNITION_VERSION, source: "scripted", entries };
}

function ordered(rows: readonly BirthSpaceRow[], kind: BirthElementKind): unknown[] {
  return rows
    .filter((row) => row.kind === kind)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => decodeCanonicalNode(row.node));
}

function randomWire(streams: readonly BirthRandomStreamRow[]): string {
  return canonicalSerialize([
    RANDOM_CONTRACT_VERSION,
    [...streams]
      .sort((left, right) => compareUtf16(left.name, right.name))
      .map((stream) => [
        stream.name,
        stream.algorithm,
        String(stream.algorithmVersion),
        stream.draws,
        [...stream.stateWords],
      ]),
  ]);
}

/**
 * The world state of a stored birth. It reads only the birth rows and the stored cognitive seed
 * resources; scripted cognition is rebuilt from the references, never from a copy.
 */
export function reconstructBirthState(
  birth: BirthState,
  seedResources: readonly BirthSeedResource[],
  decode: DecodeResource,
): WorldState {
  const scalars = decodeCanonicalNode(birth.scalars);
  if (!isRecord(scalars))
    refuse("INVALID_BIRTH_STATE", "scalars", "stored scalars are not a record");
  const state: Record<string, unknown> = {
    ...scalars,
    schemaVersion: birth.stateSchemaVersion,
    partitionId: birth.statePartitionId,
  };
  for (const row of birth.sections) state[row.section] = decodeCanonicalNode(row.node);
  const cognition = scriptedCognition(birth.seedRefs, seedResources, decode);
  if (cognition !== undefined) state.scriptedCognition = cognition;
  state.spatialFrames = ordered(birth.spaceState, "frame");
  const regions = ordered(birth.spaceState, "region");
  if (regions.length > 0) state.spatialRegions = regions;
  const graphs = ordered(birth.spaceState, "anchor-graph");
  if (graphs.length > 0) state.anchorGraphs = graphs;
  state.entities = ordered(birth.spaceState, "entity");
  return plainValue(state) as WorldState;
}

/** The seed projection hash of a stored birth: its state, schedules and random state. */
export function reconstructSeedProjectionHash(
  birth: BirthState,
  seedResources: readonly BirthSeedResource[],
  decode: DecodeResource,
): string {
  return sha256Hex(
    canonicalBytes({
      kind: SEED_PROJECTION_KIND,
      version: 1,
      state: reconstructBirthState(birth, seedResources, decode),
      schedules: [...birth.schedules]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((row) => decodeCanonicalNode(row.node)),
      randomState: randomWire(birth.randomStreams),
    }),
  );
}
