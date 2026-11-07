import { ContractDecodeError, decodeOpaqueId, type SimTimeMs } from "@clockgrove/contracts";
import { containmentSchema, lifecycleSchema, resourceSchema } from "./components/catalog/index.js";
import type { EcologyPolicy, EcologyState } from "./ecology/ecology.js";
import type { EnvironmentPolicy, EnvironmentState } from "./environment/environment.js";
import type {
  LifecyclePolicy,
  LifecycleSeasonalHook,
  LifecycleState,
} from "./lifecycle/lifecycle.js";
import {
  type FixedPointVector,
  fixedPoint,
  type SemanticPose,
  type SpatialFrame,
} from "./spatial.js";
import type {
  AmbiguityCondition,
  AmbiguityDeclaration,
  ScriptedCognitionState,
  UtilityPolicy,
} from "./utility/utility.js";
import type { WellbeingPolicy, WellbeingState } from "./wellbeing/wellbeing.js";
import {
  createWorldState,
  validateWorldBehaviorPack,
  type WorldBehaviorPack,
  type WorldBehaviorPolicy,
  type WorldEntity,
  type WorldState,
} from "./world.js";

/** First-slice input, not the complete WorldPackManifest or an installation/genesis receipt. */
export interface WorldScenario {
  readonly pack: WorldBehaviorPack;
  readonly initialState: WorldState;
}

/** The caller hashes the actual canonical scenario input before calling this pure decoder. */
export function decodeWorldScenario(input: unknown, contentHash: string): WorldScenario {
  const root = object(input, ["schemaVersion", "pack", "initialState"], "scenario");
  version(root, "scenario");
  const rawPack = object(
    root.pack,
    ["schemaVersion", "packId", "packVersion", "archetypes", "policy"],
    "pack",
  );
  version(rawPack, "pack");
  const rawPolicy = object(
    rawPack.policy,
    [
      "schemaVersion",
      "version",
      "decisionIntervalMs",
      "hungerPerInterval",
      "wetnessPerInterval",
      "dryingPerInterval",
      "hungerWeight",
      "shelterWeight",
    ],
    "policy",
    ["environment", "ecology", "wellbeing", "utility", "lifecycle"],
  );
  version(rawPolicy, "policy");
  const policy: WorldBehaviorPolicy = {
    schemaVersion: 1,
    version: text(rawPolicy.version, "policy.version"),
    decisionIntervalMs: decimal(rawPolicy.decisionIntervalMs, "policy.decisionIntervalMs"),
    hungerPerInterval: integer(rawPolicy.hungerPerInterval, "policy.hungerPerInterval"),
    wetnessPerInterval: integer(rawPolicy.wetnessPerInterval, "policy.wetnessPerInterval"),
    dryingPerInterval: integer(rawPolicy.dryingPerInterval, "policy.dryingPerInterval"),
    hungerWeight: integer(rawPolicy.hungerWeight, "policy.hungerWeight"),
    shelterWeight: integer(rawPolicy.shelterWeight, "policy.shelterWeight"),
    ...(rawPolicy.environment === undefined
      ? {}
      : { environment: environmentPolicy(rawPolicy.environment, "policy.environment") }),
    ...(rawPolicy.ecology === undefined
      ? {}
      : { ecology: ecologyPolicy(rawPolicy.ecology, "policy.ecology") }),
    ...(rawPolicy.wellbeing === undefined
      ? {}
      : { wellbeing: wellbeingPolicy(rawPolicy.wellbeing, "policy.wellbeing") }),
    ...(rawPolicy.utility === undefined
      ? {}
      : { utility: utilityPolicy(rawPolicy.utility, "policy.utility") }),
    ...(rawPolicy.lifecycle === undefined
      ? {}
      : { lifecycle: lifecyclePolicy(rawPolicy.lifecycle, "policy.lifecycle") }),
  };
  const pack: WorldBehaviorPack = {
    schemaVersion: 1,
    packId: text(rawPack.packId, "pack.packId"),
    packVersion: text(rawPack.packVersion, "pack.packVersion"),
    contentHash,
    archetypes: list(rawPack.archetypes, "pack.archetypes", text),
    policy,
  };
  const raw = object(
    root.initialState,
    [
      "schemaVersion",
      "tenantId",
      "worldId",
      "timelineId",
      "partitionId",
      "revision",
      "simulationTime",
      "weather",
      "spatialFrames",
      "entities",
    ],
    "initialState",
    ["environment", "ecology", "wellbeing", "scriptedCognition", "lifecycle"],
  );
  version(raw, "initialState");
  const weather = object(raw.weather, ["rainIntensity"], "initialState.weather");
  const initialState: WorldState = {
    schemaVersion: 1,
    tenantId: decodeOpaqueId(raw.tenantId, "TenantId"),
    worldId: decodeOpaqueId(raw.worldId, "WorldId"),
    timelineId: decodeOpaqueId(raw.timelineId, "TimelineId"),
    partitionId: decodeOpaqueId(raw.partitionId, "PartitionId"),
    revision: decimal(raw.revision, "initialState.revision"),
    simulationTime: decimal(raw.simulationTime, "initialState.simulationTime") as SimTimeMs,
    weather: {
      rainIntensity: integer(weather.rainIntensity, "initialState.weather.rainIntensity"),
    },
    ...(raw.environment === undefined
      ? {}
      : { environment: environmentState(raw.environment, "initialState.environment") }),
    ...(raw.ecology === undefined
      ? {}
      : { ecology: ecologyState(raw.ecology, "initialState.ecology") }),
    ...(raw.wellbeing === undefined
      ? {}
      : { wellbeing: wellbeingState(raw.wellbeing, "initialState.wellbeing") }),
    ...(raw.scriptedCognition === undefined
      ? {}
      : {
          scriptedCognition: scriptedCognitionState(
            raw.scriptedCognition,
            "initialState.scriptedCognition",
          ),
        }),
    ...(raw.lifecycle === undefined
      ? {}
      : { lifecycle: lifecycleState(raw.lifecycle, "initialState.lifecycle") }),
    spatialFrames: list(raw.spatialFrames, "initialState.spatialFrames", frame),
    entities: list(raw.entities, "initialState.entities", entity),
  };
  validateWorldBehaviorPack(pack);
  return Object.freeze({
    pack: Object.freeze({
      ...pack,
      archetypes: Object.freeze([...pack.archetypes]),
      policy: Object.freeze(policy),
    }),
    initialState: createWorldState(initialState),
  });
}

function environmentPolicy(input: unknown, path: string): EnvironmentPolicy {
  const raw = object(
    input,
    [
      "schemaVersion",
      "dayLengthMs",
      "phases",
      "weatherSegments",
      "wetThreshold",
      "discomfortThreshold",
    ],
    path,
  );
  version(raw, path);
  return {
    schemaVersion: 1,
    dayLengthMs: decimal(raw.dayLengthMs, `${path}.dayLengthMs`),
    phases: list(raw.phases, `${path}.phases`, (value, at) => {
      const phase = object(value, ["name", "startMs", "lightBand"], at);
      return {
        name: text(phase.name, `${at}.name`),
        startMs: decimal(phase.startMs, `${at}.startMs`),
        lightBand: text(phase.lightBand, `${at}.lightBand`),
      };
    }),
    weatherSegments: list(raw.weatherSegments, `${path}.weatherSegments`, (value, at) => {
      const segment = object(value, ["durationMs", "rainIntensity", "temperatureBand"], at);
      return {
        durationMs: decimal(segment.durationMs, `${at}.durationMs`),
        rainIntensity: integer(segment.rainIntensity, `${at}.rainIntensity`),
        temperatureBand: text(segment.temperatureBand, `${at}.temperatureBand`),
      };
    }),
    wetThreshold: integer(raw.wetThreshold, `${path}.wetThreshold`),
    discomfortThreshold: integer(raw.discomfortThreshold, `${path}.discomfortThreshold`),
  };
}

function environmentState(input: unknown, path: string): EnvironmentState {
  const raw = object(
    input,
    [
      "phase",
      "lightBand",
      "nextPhaseBoundary",
      "segmentIndex",
      "temperatureBand",
      "nextWeatherBoundary",
    ],
    path,
  );
  return {
    phase: text(raw.phase, `${path}.phase`),
    lightBand: text(raw.lightBand, `${path}.lightBand`),
    nextPhaseBoundary: decimal(raw.nextPhaseBoundary, `${path}.nextPhaseBoundary`) as SimTimeMs,
    segmentIndex: integer(raw.segmentIndex, `${path}.segmentIndex`),
    temperatureBand: text(raw.temperatureBand, `${path}.temperatureBand`),
    nextWeatherBoundary: decimal(
      raw.nextWeatherBoundary,
      `${path}.nextWeatherBoundary`,
    ) as SimTimeMs,
  };
}

function ecologyPolicy(input: unknown, path: string): EcologyPolicy {
  const raw = object(input, ["schemaVersion", "sources", "perishables", "plants"], path);
  version(raw, path);
  return {
    schemaVersion: 1,
    sources: list(raw.sources, `${path}.sources`, (value, at) => {
      const source = object(value, ["objectId", "kind", "firstAtMs", "periodMs", "quantity"], at);
      if (source.kind !== "food" && source.kind !== "water")
        fail(`${at}.kind`, "expected food or water");
      return {
        objectId: decodeOpaqueId(source.objectId, "ObjectId", `${at}.objectId`),
        kind: source.kind,
        firstAtMs: decimal(source.firstAtMs, `${at}.firstAtMs`),
        periodMs: decimal(source.periodMs, `${at}.periodMs`),
        quantity: integer(source.quantity, `${at}.quantity`),
      };
    }),
    perishables: list(raw.perishables, `${path}.perishables`, (value, at) => {
      const holder = object(value, ["objectId", "shelfLifeMs"], at);
      return {
        objectId: decodeOpaqueId(holder.objectId, "ObjectId", `${at}.objectId`),
        shelfLifeMs: decimal(holder.shelfLifeMs, `${at}.shelfLifeMs`),
      };
    }),
    plants: list(raw.plants, `${path}.plants`, (value, at) => {
      const plant = object(value, ["objectId", "growingLightBands", "stages"], at);
      return {
        objectId: decodeOpaqueId(plant.objectId, "ObjectId", `${at}.objectId`),
        growingLightBands: list(plant.growingLightBands, `${at}.growingLightBands`, text),
        stages: list(plant.stages, `${at}.stages`, (stageValue, stageAt) => {
          const stage = object(stageValue, ["name", "thresholdMs"], stageAt);
          return {
            name: text(stage.name, `${stageAt}.name`),
            thresholdMs: decimal(stage.thresholdMs, `${stageAt}.thresholdMs`),
          };
        }),
      };
    }),
  };
}

function ecologyState(input: unknown, path: string): EcologyState {
  const raw = object(input, ["perishables", "plants"], path);
  return {
    perishables: list(raw.perishables, `${path}.perishables`, (value, at) => {
      const holder = object(value, ["objectId", "arrivedAt"], at);
      return {
        objectId: decodeOpaqueId(holder.objectId, "ObjectId", `${at}.objectId`),
        arrivedAt:
          holder.arrivedAt === null
            ? null
            : (decimal(holder.arrivedAt, `${at}.arrivedAt`) as SimTimeMs),
      };
    }),
    plants: list(raw.plants, `${path}.plants`, (value, at) => {
      const plant = object(
        value,
        ["objectId", "stage", "growingMs", "wetness", "wetnessRemainder", "integratedAt"],
        at,
      );
      return {
        objectId: decodeOpaqueId(plant.objectId, "ObjectId", `${at}.objectId`),
        stage: integer(plant.stage, `${at}.stage`),
        growingMs: decimal(plant.growingMs, `${at}.growingMs`),
        wetness: integer(plant.wetness, `${at}.wetness`),
        wetnessRemainder: decimal(plant.wetnessRemainder, `${at}.wetnessRemainder`),
        integratedAt: decimal(plant.integratedAt, `${at}.integratedAt`) as SimTimeMs,
      };
    }),
  };
}

function wellbeingPolicy(input: unknown, path: string): WellbeingPolicy {
  const raw = object(
    input,
    [
      "schemaVersion",
      "thirstPerInterval",
      "healthLossPerInterval",
      "healthRecoveryPerInterval",
      "urgentHunger",
      "urgentThirst",
      "criticalHealth",
    ],
    path,
  );
  version(raw, path);
  return {
    schemaVersion: 1,
    thirstPerInterval: integer(raw.thirstPerInterval, `${path}.thirstPerInterval`),
    healthLossPerInterval: integer(raw.healthLossPerInterval, `${path}.healthLossPerInterval`),
    healthRecoveryPerInterval: integer(
      raw.healthRecoveryPerInterval,
      `${path}.healthRecoveryPerInterval`,
    ),
    urgentHunger: integer(raw.urgentHunger, `${path}.urgentHunger`),
    urgentThirst: integer(raw.urgentThirst, `${path}.urgentThirst`),
    criticalHealth: integer(raw.criticalHealth, `${path}.criticalHealth`),
  };
}

function wellbeingState(input: unknown, path: string): WellbeingState {
  const raw = object(input, ["entries"], path);
  return {
    entries: list(raw.entries, `${path}.entries`, (value, at) => {
      const entry = object(
        value,
        [
          "objectId",
          "thirst",
          "thirstRemainder",
          "health",
          "healthRemainder",
          "comfort",
          "integratedAt",
        ],
        at,
      );
      if (entry.comfort !== "comfortable" && entry.comfort !== "uncomfortable")
        fail(`${at}.comfort`, "expected comfortable or uncomfortable");
      return {
        objectId: decodeOpaqueId(entry.objectId, "ObjectId", `${at}.objectId`),
        thirst: integer(entry.thirst, `${at}.thirst`),
        thirstRemainder: decimal(entry.thirstRemainder, `${at}.thirstRemainder`),
        health: integer(entry.health, `${at}.health`),
        healthRemainder: decimal(entry.healthRemainder, `${at}.healthRemainder`),
        comfort: entry.comfort,
        integratedAt: decimal(entry.integratedAt, `${at}.integratedAt`) as SimTimeMs,
      };
    }),
  };
}

function lifecyclePolicy(input: unknown, path: string): LifecyclePolicy {
  const raw = object(
    input,
    ["schemaVersion", "stages", "lifespanMs", "deathHealth", "reproduction", "successorRule"],
    path,
    ["seasonal"],
  );
  version(raw, path);
  const reproduction = object(
    raw.reproduction,
    [
      "fertileStages",
      "conceptionIntervalMs",
      "conceptionChance",
      "coParent",
      "gestationMs",
      "gestationMilestones",
      "cooldownMs",
      "maxPopulation",
    ],
    `${path}.reproduction`,
  );
  if (reproduction.coParent !== "required" && reproduction.coParent !== "none")
    fail(`${path}.reproduction.coParent`, "expected required or none");
  const seasonalRaw = raw.seasonal;
  let seasonal: LifecycleSeasonalHook | undefined;
  if (seasonalRaw !== undefined) {
    const hook = object(
      seasonalRaw,
      ["schemaVersion", "yearLengthMs", "seasons", "conceptionSeasons"],
      `${path}.seasonal`,
    );
    version(hook, `${path}.seasonal`);
    seasonal = {
      schemaVersion: 1,
      yearLengthMs: decimal(hook.yearLengthMs, `${path}.seasonal.yearLengthMs`),
      seasons: list(hook.seasons, `${path}.seasonal.seasons`, (value, at) => {
        const season = object(value, ["name", "startMs"], at);
        return {
          name: text(season.name, `${at}.name`),
          startMs: decimal(season.startMs, `${at}.startMs`),
        };
      }),
      conceptionSeasons: list(hook.conceptionSeasons, `${path}.seasonal.conceptionSeasons`, text),
    };
  }
  if (raw.successorRule !== null) text(raw.successorRule, `${path}.successorRule`);
  return {
    schemaVersion: 1,
    stages: list(raw.stages, `${path}.stages`, (value, at) => {
      const stage = object(value, ["name", "startsAtAgeMs"], at);
      return {
        name: text(stage.name, `${at}.name`),
        startsAtAgeMs: decimal(stage.startsAtAgeMs, `${at}.startsAtAgeMs`),
      };
    }),
    lifespanMs: decimal(raw.lifespanMs, `${path}.lifespanMs`),
    deathHealth: integer(raw.deathHealth, `${path}.deathHealth`),
    reproduction: {
      fertileStages: list(reproduction.fertileStages, `${path}.reproduction.fertileStages`, text),
      conceptionIntervalMs: decimal(
        reproduction.conceptionIntervalMs,
        `${path}.reproduction.conceptionIntervalMs`,
      ),
      conceptionChance: integer(
        reproduction.conceptionChance,
        `${path}.reproduction.conceptionChance`,
      ),
      coParent: reproduction.coParent,
      gestationMs: decimal(reproduction.gestationMs, `${path}.reproduction.gestationMs`),
      gestationMilestones: list(
        reproduction.gestationMilestones,
        `${path}.reproduction.gestationMilestones`,
        (value, at) => {
          const milestone = object(value, ["name", "atMs"], at);
          return {
            name: text(milestone.name, `${at}.name`),
            atMs: decimal(milestone.atMs, `${at}.atMs`),
          };
        },
      ),
      cooldownMs: decimal(reproduction.cooldownMs, `${path}.reproduction.cooldownMs`),
      maxPopulation: integer(reproduction.maxPopulation, `${path}.reproduction.maxPopulation`),
    },
    successorRule: raw.successorRule as string | null,
    ...(seasonal === undefined ? {} : { seasonal }),
  };
}

function lifecycleState(input: unknown, path: string): LifecycleState {
  const raw = object(input, ["households", "entries"], path);
  const byText = (left: string, right: string): number =>
    left === right ? 0 : left < right ? -1 : 1;
  const decoded = {
    households: list(raw.households, `${path}.households`, text),
    entries: list(raw.entries, `${path}.entries`, (value, at) => {
      const entry = object(
        value,
        [
          "objectId",
          "householdId",
          "parentIds",
          "generation",
          "bornAt",
          "stageIndex",
          "conceptions",
          "lastBirthAt",
          "gestation",
          "death",
        ],
        at,
      );
      const gestation =
        entry.gestation === null
          ? null
          : (() => {
              const record = object(
                entry.gestation,
                ["conceivedAt", "dueAt", "coParentId", "childId", "milestoneIndex"],
                `${at}.gestation`,
              );
              return {
                conceivedAt: decimal(
                  record.conceivedAt,
                  `${at}.gestation.conceivedAt`,
                ) as SimTimeMs,
                dueAt: decimal(record.dueAt, `${at}.gestation.dueAt`) as SimTimeMs,
                coParentId:
                  record.coParentId === null
                    ? null
                    : decodeOpaqueId(record.coParentId, "ObjectId", `${at}.gestation.coParentId`),
                childId: decodeOpaqueId(record.childId, "ObjectId", `${at}.gestation.childId`),
                milestoneIndex: integer(record.milestoneIndex, `${at}.gestation.milestoneIndex`),
              };
            })();
      const death =
        entry.death === null
          ? null
          : (() => {
              const record = object(entry.death, ["diedAt", "cause"], `${at}.death`);
              if (record.cause !== "lifespan" && record.cause !== "health")
                fail(`${at}.death.cause`, "expected lifespan or health");
              return {
                diedAt: decimal(record.diedAt, `${at}.death.diedAt`) as SimTimeMs,
                cause: record.cause as "lifespan" | "health",
              };
            })();
      return {
        objectId: decodeOpaqueId(entry.objectId, "ObjectId", `${at}.objectId`),
        householdId: text(entry.householdId, `${at}.householdId`),
        parentIds: list(entry.parentIds, `${at}.parentIds`, (id, idAt) =>
          decodeOpaqueId(id, "ObjectId", idAt),
        ),
        generation: integer(entry.generation, `${at}.generation`),
        bornAt: decimal(entry.bornAt, `${at}.bornAt`),
        stageIndex: integer(entry.stageIndex, `${at}.stageIndex`),
        conceptions: integer(entry.conceptions, `${at}.conceptions`),
        lastBirthAt:
          entry.lastBirthAt === null
            ? null
            : (decimal(entry.lastBirthAt, `${at}.lastBirthAt`) as SimTimeMs),
        gestation,
        death,
      };
    }),
  };
  // Input order is not meaningful: the record is canonicalized by id (duplicates stay and are refused).
  return {
    households: [...decoded.households].sort(byText),
    entries: [...decoded.entries].sort((left, right) => byText(left.objectId, right.objectId)),
  } as LifecycleState;
}

function utilityPolicy(input: unknown, path: string): UtilityPolicy {
  const raw = object(
    input,
    [
      "schemaVersion",
      "scorer",
      "scorerVersion",
      "thirstWeight",
      "expectationWeight",
      "travelWeight",
      "unitsPerSecond",
      "perceptionRange",
      "biteQuantity",
      "hungerReliefPerUnit",
      "thirstReliefPerUnit",
    ],
    path,
    ["ambiguity"],
  );
  version(raw, path);
  if (raw.scorer !== "clockgrove.routine-utility") fail(`${path}.scorer`, "unsupported scorer");
  if (raw.scorerVersion !== 1) fail(`${path}.scorerVersion`, "unsupported scorer version");
  return {
    schemaVersion: 1,
    scorer: "clockgrove.routine-utility",
    scorerVersion: 1,
    thirstWeight: integer(raw.thirstWeight, `${path}.thirstWeight`),
    expectationWeight: integer(raw.expectationWeight, `${path}.expectationWeight`),
    travelWeight: integer(raw.travelWeight, `${path}.travelWeight`),
    unitsPerSecond: decimal(raw.unitsPerSecond, `${path}.unitsPerSecond`),
    perceptionRange: decimal(raw.perceptionRange, `${path}.perceptionRange`),
    biteQuantity: integer(raw.biteQuantity, `${path}.biteQuantity`),
    hungerReliefPerUnit: integer(raw.hungerReliefPerUnit, `${path}.hungerReliefPerUnit`),
    thirstReliefPerUnit: integer(raw.thirstReliefPerUnit, `${path}.thirstReliefPerUnit`),
    ...(raw.ambiguity === undefined
      ? {}
      : { ambiguity: ambiguityDeclaration(raw.ambiguity, `${path}.ambiguity`) }),
  };
}

/** Decodes the JSON shape; `validateUtilityPolicy` checks kinds, order and bounds. */
function ambiguityDeclaration(input: unknown, path: string): AmbiguityDeclaration {
  const raw = object(input, ["schemaVersion", "conditions"], path);
  version(raw, path);
  return {
    schemaVersion: 1,
    conditions: list(raw.conditions, `${path}.conditions`, (value, at) => {
      const condition = object(value, ["kind"], at, ["maxMargin"]);
      return (
        condition.maxMargin === undefined
          ? { kind: condition.kind }
          : { kind: condition.kind, maxMargin: decimal(condition.maxMargin, `${at}.maxMargin`) }
      ) as AmbiguityCondition;
    }),
  };
}

function scriptedCognitionState(input: unknown, path: string): ScriptedCognitionState {
  const raw = object(input, ["schemaVersion", "source", "entries"], path);
  version(raw, path);
  if (raw.source !== "scripted") fail(`${path}.source`, 'expected the source "scripted"');
  return {
    schemaVersion: 1,
    source: "scripted",
    entries: list(raw.entries, `${path}.entries`, (value, at) => {
      const entry = object(
        value,
        ["ref", "kind", "actorId", "targetObjectId", "value", "effectiveAt"],
        at,
        ["attributedTo"],
      );
      if (entry.kind !== "belief" && entry.kind !== "memory")
        fail(`${at}.kind`, "expected belief or memory");
      return {
        ref: text(entry.ref, `${at}.ref`),
        kind: entry.kind,
        actorId: decodeOpaqueId(entry.actorId, "ObjectId", `${at}.actorId`),
        targetObjectId: decodeOpaqueId(entry.targetObjectId, "ObjectId", `${at}.targetObjectId`),
        value: integer(entry.value, `${at}.value`),
        effectiveAt: decimal(entry.effectiveAt, `${at}.effectiveAt`) as SimTimeMs,
        ...(entry.attributedTo === undefined
          ? {}
          : { attributedTo: decodeOpaqueId(entry.attributedTo, "ObjectId", `${at}.attributedTo`) }),
      };
    }),
  };
}

function frame(input: unknown, path: string): SpatialFrame {
  const raw = object(
    input,
    ["frameId", "version", "dimensions", "unit", "axes", "origin", "gravity"],
    path,
  );
  const unit = object(raw.unit, ["name", "fractionalDigits"], `${path}.unit`);
  const axes = object(raw.axes, ["axes"], `${path}.axes`);
  const gravity = object(raw.gravity, ["kind", "vector"], `${path}.gravity`);
  if (raw.dimensions !== 2 && raw.dimensions !== 3)
    fail(`${path}.dimensions`, "expected two or three dimensions");
  if (gravity.kind !== "constant-vector")
    fail(`${path}.gravity.kind`, "unsupported gravity convention");
  return {
    frameId: decodeOpaqueId(raw.frameId, "SpatialFrameId", `${path}.frameId`),
    version: integer(raw.version, `${path}.version`),
    dimensions: raw.dimensions,
    unit: {
      name: text(unit.name, `${path}.unit.name`),
      fractionalDigits: integer(unit.fractionalDigits, `${path}.unit.fractionalDigits`),
    },
    axes: {
      axes: list(axes.axes, `${path}.axes.axes`, (axis, axisPath) => {
        const declaration = object(axis, ["name", "positiveDirection"], axisPath);
        return {
          name: text(declaration.name, `${axisPath}.name`),
          positiveDirection: text(declaration.positiveDirection, `${axisPath}.positiveDirection`),
        };
      }) as SpatialFrame["axes"]["axes"],
    },
    origin: coordinates(raw.origin, `${path}.origin`),
    gravity: {
      kind: "constant-vector",
      vector: coordinates(gravity.vector, `${path}.gravity.vector`),
    },
  };
}

function entity(input: unknown, path: string): WorldEntity {
  const raw = object(input, ["objectId", "spaceId", "archetypeId", "pose"], path, [
    "needs",
    "shelter",
    "locationId",
    "containment",
    "resource",
    "lifecycle",
  ]);
  const pose = object(raw.pose, ["frameId", "frameVersion", "coordinates"], `${path}.pose`);
  const result: WorldEntity = {
    objectId: decodeOpaqueId(raw.objectId, "ObjectId", `${path}.objectId`),
    spaceId: decodeOpaqueId(raw.spaceId, "SpaceId", `${path}.spaceId`),
    archetypeId: text(raw.archetypeId, `${path}.archetypeId`),
    pose: {
      frameId: decodeOpaqueId(pose.frameId, "SpatialFrameId", `${path}.pose.frameId`),
      frameVersion: integer(pose.frameVersion, `${path}.pose.frameVersion`),
      coordinates: coordinates(pose.coordinates, `${path}.pose.coordinates`),
    } satisfies SemanticPose,
    ...(raw.locationId === undefined
      ? {}
      : { locationId: decodeOpaqueId(raw.locationId, "ObjectId", `${path}.locationId`) }),
    ...(raw.containment === undefined
      ? {}
      : { containment: containmentSchema.parse(raw.containment) }),
    ...(raw.resource === undefined ? {} : { resource: resourceSchema.parse(raw.resource) }),
    ...(raw.lifecycle === undefined ? {} : { lifecycle: lifecycleSchema.parse(raw.lifecycle) }),
    ...(raw.needs === undefined ? {} : { needs: needs(raw.needs, `${path}.needs`) }),
    ...(raw.shelter === undefined ? {} : { shelter: shelter(raw.shelter, `${path}.shelter`) }),
  };
  return result;
}

function needs(input: unknown, path: string): NonNullable<WorldEntity["needs"]> {
  const raw = object(
    input,
    ["hunger", "wetness", "integratedAt", "hungerRemainder", "wetnessRemainder"],
    path,
  );
  return {
    hunger: integer(raw.hunger, `${path}.hunger`),
    wetness: integer(raw.wetness, `${path}.wetness`),
    integratedAt: decimal(raw.integratedAt, `${path}.integratedAt`) as SimTimeMs,
    hungerRemainder: decimal(raw.hungerRemainder, `${path}.hungerRemainder`),
    wetnessRemainder: decimal(raw.wetnessRemainder, `${path}.wetnessRemainder`),
  };
}

function shelter(input: unknown, path: string): NonNullable<WorldEntity["shelter"]> {
  const raw = object(input, ["rainProtection"], path);
  return { rainProtection: integer(raw.rainProtection, `${path}.rainProtection`) };
}

function coordinates(input: unknown, path: string): FixedPointVector<2 | 3> {
  return list(input, path, (value, valuePath) =>
    fixedPoint(decimal(value, valuePath)),
  ) as FixedPointVector<2 | 3>;
}

function object(
  input: unknown,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail(path, "expected a JSON object");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail(path, "expected a plain JSON object");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== "string" || ![...required, ...optional].includes(key))
      fail(path, "unknown field");
    if (!("value" in fields[key]!)) fail(`${path}.${key}`, "accessors are not JSON data");
    if (fields[key]!.value === undefined) fail(`${path}.${key}`, "undefined is not JSON data");
  }
  for (const key of required)
    if (!Object.hasOwn(fields, key)) fail(`${path}.${key}`, "missing field");
  return input as Record<string, unknown>;
}

function list<T>(
  input: unknown,
  path: string,
  decode: (input: unknown, path: string) => T,
): readonly T[] {
  if (!Array.isArray(input) || input.length > 10000)
    fail(path, "expected an array with at most 10000 entries");
  return Array.from(input, (value: unknown, index: number) => decode(value, `${path}[${index}]`));
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 512)
    fail(path, "expected a nonempty string of at most 512 characters");
  return input;
}

function integer(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || Object.is(input, -0))
    fail(path, "expected a safe integer");
  return input;
}

function decimal(input: unknown, path: string): bigint {
  if (typeof input !== "string" || input.length > 256 || !/^(?:0|-?[1-9][0-9]*)$/u.test(input))
    fail(path, "expected a canonical decimal string");
  return BigInt(input);
}

function version(input: Record<string, unknown>, path: string): void {
  if (input.schemaVersion !== 1) fail(`${path}.schemaVersion`, "unsupported schema version");
}

function fail(path: string, message: string): never {
  throw new ContractDecodeError(path, message);
}
