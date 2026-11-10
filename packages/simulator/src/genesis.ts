import {
  type CommandId,
  decodeAttributionEnvelope,
  decodeExecutionContextRef,
} from "@clockgrove/contracts";
import {
  type ArchetypeDefinition,
  compareUtf16,
  createDefinitionRegistry,
  createInitialComponentRegistry,
  createWorldState,
  deriveComfort,
  deriveEnvironmentState,
  deriveLifecycleStage,
  type EffectiveObject,
  EnvironmentValidationError,
  ecologyDisagreement,
  environmentDisagreement,
  lifecycleDisagreement,
  type NamedRandomState,
  plantStageIndex,
  projectEffectiveObjectsToWorldState,
  resolveEffectiveObject,
  SCRIPTED_COGNITION_VERSION,
  type ScriptedCognitionState,
  type ScriptedEntry,
  scriptedCognitionDisagreement,
  type TraitDefinition,
  validateScriptedCognition,
  type WorldBehaviorPack,
  type WorldState,
  wellbeingDisagreement,
} from "@clockgrove/domain";
import {
  canonicalBytes,
  createDeterministicIdSource,
  createWorldSchedules,
  executeWorldKernel,
  serializeNamedRandomState,
  simulationTimeMs,
  type WorldCommand,
  type WorldKernelInput,
  worldRegistryIdentity,
} from "@clockgrove/kernel";
import {
  type ActorDefinitionDocument,
  type ActorPlacement,
  buildWorldPack,
  type DefinitionRef,
  decodeResource,
  type ValidatedWorldPack,
  validateWorldPack,
  WORLD_PACK_ENGINE_VERSION,
  type WorldPackArtifactRef,
  type WorldPackPorts,
} from "@clockgrove/world-pack-sdk";
import { GENESIS_BUNDLE_KIND, SIMULATOR_VERSION } from "./constants.js";
import { deepFreeze, isRecord } from "./scenario/support.js";

/** The one port seeding needs: lowercase hexadecimal SHA-256 of exact bytes. */
export interface SimulatorPorts {
  sha256(bytes: Uint8Array): Promise<string>;
}

export interface SeedRefusal {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * A failed seeding. `defect` is true only when an exception that is not a refusal was caught (an internal
 * defect or a failing port); `error` is then the generic `MALFORMED_INPUT` catch-all. Refusals omit it.
 */
export interface SeedFailure {
  readonly ok: false;
  readonly error: SeedRefusal;
  readonly defect?: true;
}

export type SeedResult<T> = { readonly ok: true; readonly value: T } | SeedFailure;

export interface GenesisBundle {
  readonly kind: typeof GENESIS_BUNDLE_KIND;
  readonly version: 1;
  readonly simulatorVersion: string;
  readonly engineVersion: string;
  readonly artifact: WorldPackArtifactRef;
  readonly world: {
    readonly tenantId: string;
    readonly worldId: string;
    readonly timelineId: string;
    readonly partitionId: string;
  };
  readonly clock: unknown;
  readonly cognitiveSeeds: readonly unknown[];
  readonly genesisCommandId: string;
  readonly seedCommands: readonly {
    readonly key: string;
    readonly type: string;
    readonly version: number;
    readonly commandId: string;
  }[];
  readonly events: readonly unknown[];
  readonly decisionTraces: readonly unknown[];
  readonly schedules: readonly unknown[];
  readonly counters: {
    readonly seedCommands: number;
    readonly events: number;
    readonly schedules: number;
  };
  readonly state: WorldState;
  readonly initialStateHash: string;
  readonly seedProjection: { readonly expected: string; readonly actual: string };
  readonly randomState: string;
  readonly finalStateHash: string;
  readonly bundleHash: string;
}

export interface SeedGenesisValue {
  readonly bundle: GenesisBundle;
  readonly bytes: Uint8Array;
}

/**
 * The kernel behaviour pack of a validated pack (its identity, content hash, archetypes and policy), or
 * null when the pack has no behaviour policy.
 */
export function behaviorPackOf(
  pack: ValidatedWorldPack,
  artifact: WorldPackArtifactRef,
): WorldBehaviorPack | null {
  const policy = pack.behaviorPolicy;
  if (policy === null) return null;
  return {
    schemaVersion: 1,
    packId: pack.id,
    packVersion: pack.version,
    contentHash: artifact.contentHash,
    archetypes: pack.archetypes.map((entry) => `${entry.id}@${entry.version}`),
    policy,
  };
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: string, path: string, message: string): never {
  throw new Refusal(code, path, message);
}

function toRefusal(error: unknown): SeedFailure {
  if (error instanceof Refusal)
    return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
  return {
    ok: false,
    error: { code: "MALFORMED_INPUT", path: "input", message: "seeding could not be completed" },
    defect: true,
  };
}

/** Ports for building artifacts that `seedGenesis` accepts. */
export function createSimulatorPackPorts(ports: SimulatorPorts): WorldPackPorts {
  return {
    canonicalBytes,
    sha256: (bytes) => ports.sha256(bytes),
    commandCatalog: worldRegistryIdentity().commands.map(([type, version]) => ({ type, version })),
  };
}

const ARTIFACT_FIELDS = [
  "packId",
  "version",
  "contentHash",
  "engineCompatibility",
  "resourceManifestHash",
  "assetManifestHash",
  "migrationSetHash",
  "buildToolVersion",
] as const;

function readArtifact(value: unknown): WorldPackArtifactRef {
  if (!isRecord(value))
    return refuse("MALFORMED_INPUT", "input.artifact", "artifact must be a record");
  for (const key of Object.keys(value))
    if (!(ARTIFACT_FIELDS as readonly string[]).includes(key))
      refuse("UNKNOWN_FIELD", `input.artifact.${key}`, "unknown artifact field");
  for (const field of ARTIFACT_FIELDS) {
    if (!Object.hasOwn(value, field))
      refuse("MISSING_FIELD", `input.artifact.${field}`, "missing artifact field");
    if (typeof value[field] !== "string")
      refuse("MALFORMED_INPUT", `input.artifact.${field}`, "artifact field must be a string");
  }
  return value as unknown as WorldPackArtifactRef;
}

function readInput(input: unknown): { artifact: WorldPackArtifactRef; source: unknown } {
  if (!isRecord(input)) return refuse("MALFORMED_INPUT", "input", "input must be a record");
  for (const key of Object.keys(input))
    if (key !== "artifact" && key !== "source")
      refuse("UNKNOWN_FIELD", `input.${key}`, "unknown input field");
  if (!Object.hasOwn(input, "artifact"))
    refuse("MISSING_FIELD", "input.artifact", "artifact is required");
  if (!Object.hasOwn(input, "source"))
    refuse("MISSING_FIELD", "input.source", "source is required");
  return { artifact: readArtifact(input.artifact), source: input.source };
}

const RANGE =
  /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function checkEngine(range: string): void {
  const path = "artifact.engineCompatibility";
  const match = RANGE.exec(range);
  if (match === null)
    return refuse("MALFORMED_INPUT", path, "engine compatibility must be '>=A.B.C <D.E.F'");
  const numbers = match.slice(1).map(Number);
  const engine = WORLD_PACK_ENGINE_VERSION.split(".").map(Number);
  const order = (left: number[], right: number[]): number => {
    for (let index = 0; index < 3; index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  if (order(engine, numbers.slice(0, 3)) < 0 || order(engine, numbers.slice(3, 6)) >= 0)
    refuse("ENGINE_INCOMPATIBLE", path, `engine ${WORLD_PACK_ENGINE_VERSION} is outside ${range}`);
}

function assertData(value: unknown, path: string, depth = 0): void {
  if (depth > 64) refuse("INVALID_SEED_COMMAND", path, "payload is nested too deeply");
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "bigint":
      return;
    case "number":
      if (!Number.isFinite(value))
        refuse("INVALID_SEED_COMMAND", path, "payload number must be finite");
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertData(item, `${path}[${index}]`, depth + 1));
        return;
      }
      if (!isRecord(value)) refuse("INVALID_SEED_COMMAND", path, "payload must be plain data");
      for (const key of Object.keys(value)) assertData(value[key], `${path}.${key}`, depth + 1);
      return;
    }
    default:
      refuse("INVALID_SEED_COMMAND", path, "payload must be plain data");
  }
}

interface Prepared {
  readonly pack: ValidatedWorldPack;
  readonly artifact: WorldPackArtifactRef;
}

/** SDK build of `source` (refusals pass through) and the policy gates that precede execution. */
async function prepare(source: unknown, packPorts: WorldPackPorts): Promise<Prepared> {
  const validated = await validateWorldPack(source, packPorts);
  if (!validated.ok)
    throw new Refusal(validated.error.code, validated.error.path, validated.error.message);
  const built = await buildWorldPack(source, packPorts);
  if (!built.ok) throw new Refusal(built.error.code, built.error.path, built.error.message);
  return { pack: validated.value, artifact: built.value.artifact };
}

function checkPolicy(pack: ValidatedWorldPack): void {
  if (pack.behaviorPolicy === null && pack.seedCommands.length > 0)
    refuse("MISSING_BEHAVIOR_POLICY", "manifest.policies", "seed commands need a behaviour policy");
}

const SCRIPTED_SEED_TYPE = "clockgrove.scripted-cognition";
const SCRIPTED_SEED_FIELDS = ["type", "schemaVersion", "entries"];

interface ScriptedSeeds {
  readonly state: ScriptedCognitionState;
  /** For each merged entry, the manifest index of its seed and its index within that seed. */
  readonly origins: readonly { readonly seed: number; readonly entry: number }[];
}

/** Facts read from the manifest and resources that the validated pack does not keep in order. */
interface SourceFacts {
  readonly scripted: ScriptedSeeds | undefined;
  readonly actorLoc: ReadonlyMap<string, string>;
}

function readSourceFacts(pack: ValidatedWorldPack, source: unknown): SourceFacts {
  const { manifest, resources } = source as {
    manifest: {
      actors?: { id: string }[];
      cognitiveSeeds?: { path: string }[];
    };
    resources: Record<string, Uint8Array>;
  };
  const actorLoc = new Map<string, string>();
  (manifest.actors ?? []).forEach((entry, index) =>
    actorLoc.set(entry.id, `manifest.actors[${index}]`),
  );

  const merged: { entry: ScriptedEntry; seed: number; index: number }[] = [];
  const refs = new Map<string, string>();
  const policy = pack.behaviorPolicy;
  let last = -1;
  for (const [seedIndex, seedEntry] of (manifest.cognitiveSeeds ?? []).entries()) {
    const document = decodeResource(resources[seedEntry.path] as Uint8Array, seedEntry.path);
    if (!isRecord(document) || document.type !== SCRIPTED_SEED_TYPE) continue;
    const at = `manifest.cognitiveSeeds[${seedIndex}]`;
    if (policy === null || policy.utility === undefined)
      refuse("INVALID_COGNITIVE_SEED", at, "scripted cognition needs a utility policy");
    for (const key of Object.keys(document).sort(compareUtf16))
      if (!SCRIPTED_SEED_FIELDS.includes(key))
        refuse("INVALID_COGNITIVE_SEED", `${at}#${key}`, "unknown scripted cognition field");
    for (const key of SCRIPTED_SEED_FIELDS)
      if (!Object.hasOwn(document, key))
        refuse("INVALID_COGNITIVE_SEED", `${at}#${key}`, "missing scripted cognition field");
    if (document.schemaVersion !== SCRIPTED_COGNITION_VERSION)
      refuse("INVALID_COGNITIVE_SEED", `${at}#schemaVersion`, "unsupported schema version");
    if (!Array.isArray(document.entries))
      refuse("INVALID_COGNITIVE_SEED", `${at}#entries`, "entries must be an array");
    try {
      validateScriptedCognition({
        schemaVersion: SCRIPTED_COGNITION_VERSION,
        source: "scripted",
        entries: document.entries,
      });
    } catch (error) {
      if (error instanceof EnvironmentValidationError)
        return refuse("INVALID_COGNITIVE_SEED", `${at}#${error.path}`, error.message);
      throw error;
    }
    for (const [index, entry] of (document.entries as ScriptedEntry[]).entries()) {
      if (refs.has(entry.ref))
        refuse(
          "INVALID_COGNITIVE_SEED",
          `${at}#entries[${index}]`,
          "ref is already seeded by another entry",
        );
      refs.set(entry.ref, at);
      merged.push({ entry, seed: seedIndex, index });
    }
    last = seedIndex;
  }
  if (last < 0) return { scripted: undefined, actorLoc };
  merged.sort((left, right) => compareUtf16(left.entry.ref, right.entry.ref));
  const state = {
    schemaVersion: SCRIPTED_COGNITION_VERSION,
    source: "scripted",
    entries: merged.map((item) => item.entry),
  };
  try {
    validateScriptedCognition(state);
  } catch (error) {
    if (error instanceof EnvironmentValidationError)
      return refuse(
        "INVALID_COGNITIVE_SEED",
        `manifest.cognitiveSeeds[${last}]#${error.path}`,
        error.message,
      );
    throw error;
  }
  return {
    scripted: {
      state: state as ScriptedCognitionState,
      origins: merged.map((item) => ({ seed: item.seed, entry: item.index })),
    },
    actorLoc,
  };
}

/** Adds the optional behaviour-policy sections to a state built from its entities. */
function withSections(pack: ValidatedWorldPack, state: WorldState, facts: SourceFacts): WorldState {
  const policy = pack.behaviorPolicy;
  if (policy === null) return state;
  const epoch = state.simulationTime;
  const extras: Record<string, unknown> = {};
  const actors = state.entities.filter((entity) => entity.needs !== undefined);
  if (policy.environment !== undefined)
    extras.environment = deriveEnvironmentState(policy.environment, epoch);
  if (policy.ecology !== undefined)
    extras.ecology = {
      perishables: policy.ecology.perishables.map((holder) => ({
        objectId: holder.objectId,
        arrivedAt:
          (state.entities.find((entity) => entity.objectId === holder.objectId)?.resource
            ?.quantity ?? 0) > 0
            ? epoch
            : null,
      })),
      plants: policy.ecology.plants.map((plant) => ({
        objectId: plant.objectId,
        stage: plantStageIndex(plant, 0n),
        growingMs: 0n,
        wetness: 0,
        wetnessRemainder: 0n,
        integratedAt: epoch,
      })),
      ...(policy.ecology.waterHolders === undefined
        ? {}
        : {
            waterHolders: policy.ecology.waterHolders.map((holder) => ({
              objectId: holder.objectId,
              collectionRemainder: 0n,
              evaporationRemainder: 0n,
              integratedAt: epoch,
            })),
          }),
    };
  if (policy.wellbeing !== undefined)
    extras.wellbeing = {
      entries: actors.map((actor) => {
        const needs = actor.needs!;
        const comfort =
          policy.environment === undefined
            ? "comfortable"
            : deriveComfort(policy.environment, policy.wellbeing!, {
                hunger: needs.hunger,
                thirst: 0,
                wetness: needs.wetness,
              }).comfort;
        return {
          objectId: actor.objectId,
          thirst: 0,
          thirstRemainder: 0n,
          health: 10_000,
          healthRemainder: 0n,
          comfort,
          integratedAt: needs.integratedAt,
        };
      }),
    };
  if (policy.lifecycle !== undefined) {
    const needsIds = new Set(actors.map((actor) => actor.objectId as string));
    const seeds = new Map(pack.definitions.actors.map((actor) => [actor.id, actor.lifecycle]));
    const entries = actors.map((actor) => {
      const at = `${facts.actorLoc.get(actor.objectId) ?? "manifest.actors"}#lifecycle`;
      const seed = seeds.get(actor.objectId);
      if (seed === undefined || seed === null)
        return refuse("INVALID_INITIAL_STATE", at, "a needs actor needs a lifecycle seed");
      if (
        seed.parentIds.length > 2 ||
        seed.parentIds.some((parent) => parent === actor.objectId || !needsIds.has(parent))
      )
        refuse(
          "INVALID_INITIAL_STATE",
          `${at}.parentIds`,
          "parents must be other declared needs actors",
        );
      if (seed.bornAt > epoch)
        refuse("INVALID_INITIAL_STATE", `${at}.bornAt`, "bornAt lies after the clock epoch");
      return {
        objectId: actor.objectId,
        householdId: seed.householdId,
        parentIds: [...seed.parentIds],
        generation: seed.generation,
        bornAt: seed.bornAt,
        stageIndex: deriveLifecycleStage(policy.lifecycle!, seed.bornAt, epoch),
        conceptions: 0,
        lastBirthAt: null,
        gestation: null,
        death: null,
      };
    });
    extras.lifecycle = {
      households: [...new Set(entries.map((entry) => entry.householdId))].sort(compareUtf16),
      entries,
    };
  }
  if (facts.scripted !== undefined) extras.scriptedCognition = facts.scripted.state;
  const next = createWorldState({ ...state, ...extras } as unknown as WorldState);
  const scripted = scriptedCognitionDisagreement(policy, next);
  if (scripted !== undefined) {
    const match = /entries\[(\d+)\]\.(\w+)$/u.exec(scripted);
    const origin = facts.scripted?.origins[Number(match?.[1])];
    if (match !== null && origin !== undefined)
      refuse(
        "INVALID_COGNITIVE_SEED",
        `manifest.cognitiveSeeds[${origin.seed}]#entries[${origin.entry}].${match[2]}`,
        "scripted entry disagrees with the initial world",
      );
    refuse(
      "INVALID_COGNITIVE_SEED",
      "manifest.cognitiveSeeds",
      "scripted cognition disagrees with the policy",
    );
  }
  const disagreement =
    environmentDisagreement(policy, next) ??
    ecologyDisagreement(policy, next) ??
    wellbeingDisagreement(policy, next) ??
    lifecycleDisagreement(policy, next);
  if (disagreement !== undefined)
    refuse(
      "INVALID_INITIAL_STATE",
      "manifest",
      `initial ${disagreement} disagrees with the policy`,
    );
  return next;
}

const refKey = (ref: DefinitionRef): string => JSON.stringify([ref.id, ref.version]);
const compareRefs = (left: DefinitionRef, right: DefinitionRef): number =>
  compareUtf16(left.id, right.id) || left.version - right.version;

interface WorldIds {
  readonly tenantId: never;
  readonly worldId: never;
  readonly timelineId: never;
  readonly partitionId: never;
}

/** Every identity is a pure function of pack id, version and a role or seed key. */
function identitySource(pack: ValidatedWorldPack, stream: string) {
  return createDeterministicIdSource({
    commandId: `${pack.id}@${pack.version}` as CommandId,
    eventIndex: 0,
    randomStream: stream,
  });
}

function worldIds(pack: ValidatedWorldPack): WorldIds {
  const source = identitySource(pack, "world");
  return {
    tenantId: source.next("TenantId") as never,
    worldId: source.next("WorldId") as never,
    timelineId: source.next("TimelineId") as never,
    partitionId: source.next("PartitionId") as never,
  };
}

function initialState(pack: ValidatedWorldPack, ids: WorldIds, facts: SourceFacts): WorldState {
  return withSections(pack, entityState(pack, ids), facts);
}

function entityState(pack: ValidatedWorldPack, ids: WorldIds): WorldState {
  const simulationTime = simulationTimeMs(pack.clockPolicy.epoch);
  const frames = pack.spaces.map((space) => space.frame);
  const regions = pack.spaces.flatMap((space) => space.regions);
  const graphs = pack.spaces.flatMap((space) =>
    space.anchorGraph === null ? [] : [space.anchorGraph],
  );
  const base = {
    schemaVersion: 1,
    tenantId: ids.tenantId,
    worldId: ids.worldId,
    timelineId: ids.timelineId,
    partitionId: ids.partitionId,
    revision: 0n,
    simulationTime,
    weather: { rainIntensity: 0 },
    spatialFrames: frames,
    ...(regions.length > 0 ? { spatialRegions: regions } : {}),
    ...(graphs.length > 0 ? { anchorGraphs: graphs } : {}),
  } as unknown as Omit<WorldState, "entities">;

  const placed = pack.definitions.actors.filter(
    (actor): actor is ActorDefinitionDocument & { placement: ActorPlacement } =>
      actor.placement !== null,
  );
  if (placed.length === 0) return createWorldState({ ...base, entities: [] });

  const registry = createDefinitionRegistry();
  for (const trait of pack.definitions.traits)
    registry.registerTrait(trait as unknown as TraitDefinition);
  for (const archetype of pack.definitions.archetypes)
    registry.registerArchetype(archetype as unknown as ArchetypeDefinition);
  const traitsByKey = new Map(pack.definitions.traits.map((trait) => [refKey(trait), trait]));
  const archetypesByKey = new Map(pack.definitions.archetypes.map((item) => [refKey(item), item]));
  const closure = (roots: readonly DefinitionRef[]): DefinitionRef[] => {
    const seen = new Map<string, DefinitionRef>();
    const visit = (ref: DefinitionRef): void => {
      const key = refKey(ref);
      if (seen.has(key)) return;
      seen.set(key, { id: ref.id, version: ref.version });
      for (const child of traitsByKey.get(key)?.traits ?? []) visit(child);
    };
    roots.forEach(visit);
    return [...seen.values()].sort(compareRefs);
  };

  const components = createInitialComponentRegistry();
  const objects: EffectiveObject[] = placed.map((actor) => {
    const space = pack.spaces.find(
      (item) =>
        item.id === actor.placement.space.id && item.version === actor.placement.space.version,
    );
    if (space === undefined)
      return refuse("INVALID_INITIAL_STATE", "manifest.actors", "actor placement names no space");
    const archetype = archetypesByKey.get(refKey(actor.archetype));
    const pins = closure([...(archetype?.traits ?? []), ...actor.traits]);
    const snapshot = (type: string, state: unknown) => ({ type, version: 1, state });
    return resolveEffectiveObject({
      components,
      definitions: registry,
      definition: {
        id: actor.id,
        worldId: ids.worldId,
        archetype: actor.archetype,
        traits: actor.traits,
        overrides: actor.overrides,
        capabilities: actor.capabilities.map((capability) => ({
          id: `${capability.id}@${capability.version}`,
          capabilityId: capability.id,
          version: capability.version,
        })),
      },
      state: {
        worldId: ids.worldId,
        timelineId: ids.timelineId,
        objectId: actor.id,
        spaceId: space.id,
        components: {
          "clockgrove.identity": snapshot("clockgrove.identity", {
            objectId: actor.id,
            displayName: actor.id,
            aliases: [],
          }),
          "clockgrove.archetype": snapshot("clockgrove.archetype", {
            archetype: { id: actor.archetype.id, version: actor.archetype.version },
            traits: pins,
          }),
          "clockgrove.spatial-transform": snapshot("clockgrove.spatial-transform", {
            spaceId: space.id,
            pose: {
              frameId: space.frame.frameId,
              frameVersion: space.frame.version,
              coordinates: [...actor.placement.coordinates],
            },
          }),
        },
        lifecycleStatus: "active",
        revision: 0n,
      },
      context: {
        tenantId: ids.tenantId,
        worldId: ids.worldId,
        timelineId: ids.timelineId,
        objectId: actor.id,
        simulationTime,
        spatialFrames: frames,
        expectedArchetype: actor.archetype,
        expectedTraits: pins,
      },
    } as never);
  });
  return projectEffectiveObjectsToWorldState(base, objects, components);
}

function initialRandomState(pack: ValidatedWorldPack): NamedRandomState {
  return Object.fromEntries(
    pack.randomStreams.map((stream) => [
      stream.name,
      {
        name: stream.name,
        algorithm: { algorithm: stream.algorithm, version: stream.algorithmVersion },
        state: stream.state.map((word) => BigInt(word)),
        draws: BigInt(stream.draws),
      },
    ]),
  ) as unknown as NamedRandomState;
}

interface Execution {
  readonly world: GenesisBundle["world"];
  readonly genesisCommandId: string;
  readonly seedCommands: GenesisBundle["seedCommands"];
  readonly initial: WorldState;
  readonly state: WorldState;
  readonly events: readonly unknown[];
  readonly decisionTraces: readonly unknown[];
  readonly schedules: readonly unknown[];
  readonly randomState: string;
  readonly projection: string;
}

async function execute(
  pack: ValidatedWorldPack,
  artifact: WorldPackArtifactRef,
  ports: SimulatorPorts,
  facts: SourceFacts,
): Promise<Execution> {
  for (const [index, seed] of pack.seedCommands.entries()) {
    const at = `manifest.seedCommands[${index}]`;
    assertData(seed.payload, `${at}.payload`);
    if ((seed.payload as { schemaVersion?: unknown }).schemaVersion !== seed.version)
      refuse(
        "INVALID_SEED_COMMAND",
        `${at}.payload.schemaVersion`,
        "payload version differs from the seed version",
      );
  }
  const ids = worldIds(pack);
  const genesisCommandId = identitySource(pack, "genesis").next("CommandId") as string;
  const seedIds = pack.seedCommands.map(
    (seed) => identitySource(pack, `seed:${seed.key}`).next("CommandId") as string,
  );

  let initial: WorldState;
  try {
    initial = initialState(pack, ids, facts);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse(
      "INVALID_INITIAL_STATE",
      "manifest",
      "the initial world state could not be built",
    );
  }

  const policy = pack.behaviorPolicy;
  const behaviorPack = behaviorPackOf(pack, artifact);
  const genesisIds = createDeterministicIdSource({
    commandId: genesisCommandId as CommandId,
    eventIndex: 0,
    randomStream: "genesis",
  });
  let schedules: unknown = [];
  if (behaviorPack !== null) {
    try {
      schedules = createWorldSchedules(initial, behaviorPack, genesisIds);
    } catch {
      return refuse(
        "INVALID_INITIAL_STATE",
        "manifest.policies",
        "initial schedules could not be built",
      );
    }
  }

  const attribution = decodeAttributionEnvelope({
    effectiveActorId: "simulator-genesis",
    causalRootActionId: genesisCommandId,
    authorityDecisionId: "simulator-genesis-authority",
  });
  let state = initial;
  let randomState = initialRandomState(pack);
  const events: unknown[] = [];
  const decisionTraces: unknown[] = [];
  for (const [index, seed] of pack.seedCommands.entries()) {
    const commandId = seedIds[index] as CommandId;
    const command = {
      schemaVersion: 1,
      commandId,
      type: seed.type,
      target: {
        version: 1,
        tenantId: state.tenantId,
        worldId: state.worldId,
        timelineId: state.timelineId,
        kind: "world",
        id: state.worldId,
      },
      expected: { partitionRevision: state.revision },
      issuedAt: pack.clockPolicy.wallEpoch,
      context: decodeExecutionContextRef({
        version: 1,
        correlationId: genesisCommandId,
        requestId: commandId,
      }),
      attribution: {
        effectiveActorId: attribution.effectiveActorId,
        causalRootActionId: attribution.causalRootActionId,
      },
      payload: seed.payload,
    } as unknown as WorldCommand;
    const kernelInput = {
      partition: {
        schemaVersion: 1,
        partitionId: state.partitionId,
        revision: state.revision,
        state,
      },
      input: { kind: "command", command },
      simulationTime: state.simulationTime,
      attribution,
      policies: {
        schemaVersion: 1,
        policyVersions: { routine: policy?.version ?? "" },
        policy,
      },
      pack: {
        schemaVersion: 1,
        packId: pack.id,
        packVersion: pack.version,
        pack: behaviorPack,
      },
      randomState,
      ids: createDeterministicIdSource({ commandId, eventIndex: 0, randomStream: "seed" }),
      schedules,
    } as unknown as WorldKernelInput;
    const outcome = executeWorldKernel(kernelInput);
    if (!outcome.ok)
      return refuse(
        "SEED_COMMAND_REFUSED",
        `manifest.seedCommands[${index}]`,
        `kernel refused ${seed.type}@${seed.version}: ${String(outcome.error.code)} at ${String(outcome.error.path)}`,
      );
    if (!outcome.result.complete)
      return refuse(
        "SEED_COMMAND_REFUSED",
        `manifest.seedCommands[${index}]`,
        `${seed.type}@${seed.version} did not complete in one step`,
      );
    state = outcome.result.state;
    schedules = outcome.result.schedules;
    randomState = outcome.result.updatedRandomState;
    events.push(...outcome.result.events);
    decisionTraces.push(...outcome.result.decisionDrafts);
  }

  const serializedRandom = serializeNamedRandomState(randomState);
  const projection = await ports.sha256(
    canonicalBytes({
      kind: "clockgrove.seed-projection",
      version: 1,
      state,
      schedules,
      randomState: serializedRandom,
    }),
  );
  return {
    world: {
      tenantId: ids.tenantId,
      worldId: ids.worldId,
      timelineId: ids.timelineId,
      partitionId: ids.partitionId,
    },
    genesisCommandId,
    seedCommands: pack.seedCommands.map((seed, index) => ({
      key: seed.key,
      type: seed.type,
      version: seed.version,
      commandId: seedIds[index] as string,
    })),
    initial,
    state,
    events,
    decisionTraces,
    schedules: schedules as readonly unknown[],
    randomState: serializedRandom,
    projection,
  };
}

/** Actual seed projection hash of a source, ignoring its recorded expected hash. */
export async function previewSeedProjection(
  source: unknown,
  ports: SimulatorPorts,
): Promise<SeedResult<{ readonly actual: string }>> {
  try {
    const { pack, artifact } = await prepare(source, createSimulatorPackPorts(ports));
    checkPolicy(pack);
    const run = await execute(pack, artifact, ports, readSourceFacts(pack, source));
    return { ok: true, value: Object.freeze({ actual: run.projection }) };
  } catch (error) {
    return toRefusal(error);
  }
}

/** Total: never throws; every refusal is `{ code, path, message }`. */
export async function seedGenesis(
  input: unknown,
  ports: SimulatorPorts,
): Promise<SeedResult<SeedGenesisValue>> {
  try {
    const { artifact: supplied, source } = readInput(input);
    checkEngine(supplied.engineCompatibility);
    const packPorts = createSimulatorPackPorts(ports);
    const { pack, artifact } = await prepare(source, packPorts);
    for (const field of ARTIFACT_FIELDS)
      if (supplied[field] !== artifact[field])
        refuse(
          "ARTIFACT_MISMATCH",
          `artifact.${field}`,
          `${field} differs from the built artifact`,
        );
    checkPolicy(pack);
    const run = await execute(pack, artifact, ports, readSourceFacts(pack, source));
    if (run.projection !== pack.expectedSeedProjectionHash)
      refuse(
        "SEED_PROJECTION_MISMATCH",
        "manifest.expectedSeedProjectionHash",
        `recorded seed projection hash differs from the seeded projection: expected ${pack.expectedSeedProjectionHash}, actual ${run.projection}`,
      );
    const hash = async (value: unknown) => ports.sha256(canonicalBytes(value));
    const withoutHash = {
      kind: GENESIS_BUNDLE_KIND,
      version: 1,
      simulatorVersion: SIMULATOR_VERSION,
      engineVersion: WORLD_PACK_ENGINE_VERSION,
      artifact: { ...artifact },
      world: run.world,
      clock: pack.clockPolicy,
      cognitiveSeeds: pack.cognitiveSeeds,
      genesisCommandId: run.genesisCommandId,
      seedCommands: run.seedCommands,
      events: run.events,
      decisionTraces: run.decisionTraces,
      schedules: run.schedules,
      counters: {
        seedCommands: run.seedCommands.length,
        events: run.events.length,
        schedules: run.schedules.length,
      },
      state: run.state,
      initialStateHash: await hash(run.initial),
      seedProjection: { expected: pack.expectedSeedProjectionHash, actual: run.projection },
      randomState: run.randomState,
      finalStateHash: await hash(run.state),
    };
    const bundle = deepFreeze({
      ...withoutHash,
      bundleHash: await hash(withoutHash),
    }) as unknown as GenesisBundle;
    return { ok: true, value: Object.freeze({ bundle, bytes: canonicalBytes(bundle) }) };
  } catch (error) {
    return toRefusal(error);
  }
}
