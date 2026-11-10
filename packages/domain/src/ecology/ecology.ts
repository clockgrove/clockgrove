import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";

import { type EnvironmentPolicy, EnvironmentValidationError } from "../environment/environment.js";
import type { WorldEntity } from "../world.js";

/** Resource kinds a source can declare. */
export type EcologyResourceKind = "food" | "water";

export interface EcologySource {
  readonly objectId: ObjectId;
  readonly kind: EcologyResourceKind;
  /** Positive first appearance time; the source appears there and every period after it. */
  readonly firstAtMs: bigint;
  readonly periodMs: bigint;
  /** Positive integer quantity added by each appearance. */
  readonly quantity: number;
}

export interface EcologyPerishable {
  readonly objectId: ObjectId;
  /** Positive shelf life of the food the holder holds, in simulation milliseconds. */
  readonly shelfLifeMs: bigint;
}

export interface EcologyStage {
  /** Pack data, unique within the plant. */
  readonly name: string;
  /** Growing milliseconds at which the stage begins; the first stage's threshold is 0. */
  readonly thresholdMs: bigint;
  /** Food produced once when this noninitial stage is reached, held by the plant. */
  readonly yield?: Readonly<{ quantity: number }>;
}

export interface EcologyPlant {
  readonly objectId: ObjectId;
  /** Light band names of the environment under which the plant grows. */
  readonly growingLightBands: readonly string[];
  readonly stages: readonly EcologyStage[];
}

/** A bounded water holder with an explicit weather cause. */
export interface EcologyWaterHolder {
  readonly objectId: ObjectId;
  readonly capacity: number;
  /** Units/hour at full rain and no shelter. */
  readonly catchment: number;
  /** Units/hour removed independently of rain. */
  readonly evaporationPerHour: number;
}

export interface EcologyWaterState {
  readonly objectId: ObjectId;
  readonly collectionRemainder: bigint;
  readonly evaporationRemainder: bigint;
  readonly integratedAt: SimTimeMs;
}

/** Versioned, optional world-behavior policy record; it requires an `environment` record. */
export interface EcologyPolicy {
  readonly waterHolders?: readonly EcologyWaterHolder[];
  readonly schemaVersion: 1;
  readonly sources: readonly EcologySource[];
  readonly perishables: readonly EcologyPerishable[];
  readonly plants: readonly EcologyPlant[];
}

export interface EcologyPerishableState {
  readonly objectId: ObjectId;
  /** The time the holder's current food arrived, or `null` when it is empty. */
  readonly arrivedAt: SimTimeMs | null;
}

export interface EcologyPlantState {
  readonly objectId: ObjectId;
  readonly stage: number;
  readonly growingMs: bigint;
  readonly wetness: number;
  readonly wetnessRemainder: bigint;
  readonly integratedAt: SimTimeMs;
}

/** Present on `WorldState` exactly when the policy has an `ecology`; entries are in policy order. */
export interface EcologyState {
  readonly waterHolders?: readonly EcologyWaterState[];
  readonly perishables: readonly EcologyPerishableState[];
  readonly plants: readonly EcologyPlantState[];
}

export type EcologyEventData =
  | Readonly<{
      type: "resource.weather-integrated";
      payload: EcologyWaterState & Readonly<{ collected: number; evaporated: number }>;
    }>
  | Readonly<{
      type: "resource.appeared";
      payload: Readonly<{ objectId: ObjectId; kind: EcologyResourceKind; quantity: number }>;
    }>
  | Readonly<{
      type: "resource.spoiled";
      payload: Readonly<{ objectId: ObjectId; kind: "food"; quantity: number }>;
    }>
  | Readonly<{
      type: "growth.stage-changed";
      payload: Readonly<{
        objectId: ObjectId;
        stageIndex: number;
        stageName: string;
        yield?: Readonly<{ quantity: number }>;
      }>;
    }>
  | Readonly<{
      type: "growth.integrated";
      payload: Readonly<{
        objectId: ObjectId;
        growingMs: bigint;
        wetness: number;
        wetnessRemainder: bigint;
        integratedAt: SimTimeMs;
      }>;
    }>;

export const ECOLOGY_POLICY_VERSION = 1;
export const MAX_ECOLOGY_ENTRIES = 64;
export const MIN_PLANT_STAGES = 2;
export const MAX_PLANT_STAGES = 16;
/** Durations, first times and growth thresholds are bigints of at most 2^53. */
export const MAX_ECOLOGY_DURATION_MS = 1n << 53n;
const MAX_SIM_TIME = (1n << 63n) - 1n;
const MAX_WETNESS_REMAINDER = MAX_SIM_TIME * 100_000_000n;

/** Validation failure whose `path` is the full canonical path (`policy.ecology...` or `state.ecology...`). */
export class EcologyValidationError extends EnvironmentValidationError {
  constructor(path: string, message: string) {
    super(path, message);
    this.name = "EcologyValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new EcologyValidationError(path, message);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail(path, "expected an object");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(path, "expected a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))
      return fail(`${path}.${String(key)}`, "unknown field");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) return fail(`${path}.${key}`, "accessors are not data");
    if (descriptor.value === undefined) return fail(`${path}.${key}`, "undefined is not data");
  }
  for (const key of keys)
    if (!Object.hasOwn(descriptors, key)) return fail(`${path}.${key}`, "missing field");
  return value as Record<string, unknown>;
}

function name(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    return fail(
      path,
      "expected a nonempty name of at most 512 characters without outer whitespace",
    );
  return value;
}

function list(value: unknown, path: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail(path, "expected an array");
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(path, "expected a dense array");
  if (value.length < minimum || value.length > maximum)
    return fail(path, `expected ${minimum} to ${maximum} entries`);
  return value as readonly unknown[];
}

function positive(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_ECOLOGY_DURATION_MS)
    return fail(path, "expected a positive bigint within range");
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  )
    return fail(path, `expected an integer from ${minimum} through ${maximum}`);
  return value;
}

/**
 * Validates an untrusted ecology policy record; throws `EcologyValidationError`. Ecology is allowed
 * only with an environment record, whose phases declare every growing light band.
 */
export function validateEcologyPolicy(
  value: unknown,
  environment: EnvironmentPolicy | undefined,
  path = "policy.ecology",
): asserts value is EcologyPolicy {
  const root = exactObject(value, ["schemaVersion", "sources", "perishables", "plants"], path, [
    "waterHolders",
  ]);
  if (root.schemaVersion !== ECOLOGY_POLICY_VERSION)
    fail(`${path}.schemaVersion`, "unsupported ecology schema version");
  if (environment === undefined) fail(path, "ecology requires an environment record");
  const bands = new Set(environment.phases.map((phase) => phase.lightBand));
  const sourceIds = new Set<string>();
  const perishableIds = new Set<string>();
  const plantIds = new Set<string>();
  const perishableKinds = new Map<string, string>();
  const sources = list(root.sources, `${path}.sources`, 0, MAX_ECOLOGY_ENTRIES);
  for (const [index, entry] of sources.entries()) {
    const at = `${path}.sources[${index}]`;
    const source = exactObject(
      entry,
      ["objectId", "kind", "firstAtMs", "periodMs", "quantity"],
      at,
    );
    const id = name(source.objectId, `${at}.objectId`);
    if (sourceIds.has(id)) fail(`${at}.objectId`, "source object ids must be unique");
    sourceIds.add(id);
    if (source.kind !== "food" && source.kind !== "water")
      fail(`${at}.kind`, "expected food or water");
    perishableKinds.set(id, source.kind);
    positive(source.firstAtMs, `${at}.firstAtMs`);
    positive(source.periodMs, `${at}.periodMs`);
    safeInteger(source.quantity, `${at}.quantity`, 1, Number.MAX_SAFE_INTEGER);
  }
  const perishables = list(root.perishables, `${path}.perishables`, 0, MAX_ECOLOGY_ENTRIES);
  for (const [index, entry] of perishables.entries()) {
    const at = `${path}.perishables[${index}]`;
    const holder = exactObject(entry, ["objectId", "shelfLifeMs"], at);
    const id = name(holder.objectId, `${at}.objectId`);
    if (perishableIds.has(id))
      fail(`${at}.objectId`, "perishable holder object ids must be unique");
    perishableIds.add(id);
    positive(holder.shelfLifeMs, `${at}.shelfLifeMs`);
    if (perishableKinds.get(id) === "water")
      fail(`${at}.objectId`, "perishable holders hold food, never water");
  }
  const waterIds = new Set<string>();
  if (root.waterHolders !== undefined)
    for (const [index, value] of list(
      root.waterHolders,
      `${path}.waterHolders`,
      0,
      MAX_ECOLOGY_ENTRIES,
    ).entries()) {
      const at = `${path}.waterHolders[${index}]`;
      const holder = exactObject(
        value,
        ["objectId", "capacity", "catchment", "evaporationPerHour"],
        at,
      );
      const id = name(holder.objectId, `${at}.objectId`);
      if (waterIds.has(id) || sourceIds.has(id) || perishableIds.has(id))
        fail(
          `${at}.objectId`,
          "weather holders must be unique and separate from sources and perishables",
        );
      waterIds.add(id);
      safeInteger(holder.capacity, `${at}.capacity`, 1, Number.MAX_SAFE_INTEGER);
      safeInteger(holder.catchment, `${at}.catchment`, 0, Number.MAX_SAFE_INTEGER);
      safeInteger(
        holder.evaporationPerHour,
        `${at}.evaporationPerHour`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    }
  const plants = list(root.plants, `${path}.plants`, 0, MAX_ECOLOGY_ENTRIES);
  for (const [index, entry] of plants.entries()) {
    const at = `${path}.plants[${index}]`;
    const plant = exactObject(entry, ["objectId", "growingLightBands", "stages"], at);
    const id = name(plant.objectId, `${at}.objectId`);
    if (plantIds.has(id)) fail(`${at}.objectId`, "plant object ids must be unique");
    plantIds.add(id);
    if (sourceIds.has(id) || perishableIds.has(id) || waterIds.has(id))
      fail(`${at}.objectId`, "a plant is never also a source or perishable holder");
    const growing = list(
      plant.growingLightBands,
      `${at}.growingLightBands`,
      1,
      MAX_ECOLOGY_ENTRIES,
    );
    const seenBands = new Set<string>();
    for (const [bandIndex, band] of growing.entries()) {
      const label = name(band, `${at}.growingLightBands[${bandIndex}]`);
      if (seenBands.has(label))
        fail(`${at}.growingLightBands[${bandIndex}]`, "light bands must be unique");
      seenBands.add(label);
      if (!bands.has(label))
        fail(
          `${at}.growingLightBands[${bandIndex}]`,
          "no environment phase declares the light band",
        );
    }
    const stages = list(plant.stages, `${at}.stages`, MIN_PLANT_STAGES, MAX_PLANT_STAGES);
    const stageNames = new Set<string>();
    let previous = -1n;
    let totalYield = 0n;
    for (const [stageIndex, stageEntry] of stages.entries()) {
      const stageAt = `${at}.stages[${stageIndex}]`;
      const stage = exactObject(stageEntry, ["name", "thresholdMs"], stageAt, ["yield"]);
      if (stage.yield !== undefined) {
        if (stageIndex === 0) fail(`${stageAt}.yield`, "the initial stage cannot yield");
        const yieldPolicy = exactObject(stage.yield, ["quantity"], `${stageAt}.yield`);
        totalYield += BigInt(
          safeInteger(
            yieldPolicy.quantity,
            `${stageAt}.yield.quantity`,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
        );
        if (totalYield > BigInt(Number.MAX_SAFE_INTEGER))
          fail(
            `${stageAt}.yield.quantity`,
            "total plant yield exceeds the material quantity range",
          );
      }
      const label = name(stage.name, `${stageAt}.name`);
      if (stageNames.has(label)) fail(`${stageAt}.name`, "stage names must be unique");
      stageNames.add(label);
      const threshold = stage.thresholdMs;
      if (typeof threshold !== "bigint" || threshold < 0n || threshold > MAX_ECOLOGY_DURATION_MS)
        fail(`${stageAt}.thresholdMs`, "expected a nonnegative bigint threshold within range");
      if (stageIndex === 0 && threshold !== 0n)
        fail(`${stageAt}.thresholdMs`, "the first stage threshold must be 0");
      if (threshold <= previous)
        fail(`${stageAt}.thresholdMs`, "thresholds must strictly increase");
      previous = threshold;
    }
  }
}

/** Validates the shape of an untrusted ecology state record; throws `EcologyValidationError`. */
export function validateEcologyState(
  value: unknown,
  path = "state.ecology",
): asserts value is EcologyState {
  const root = exactObject(value, ["perishables", "plants"], path, ["waterHolders"]);
  if (root.waterHolders !== undefined)
    for (const [index, value] of list(
      root.waterHolders,
      `${path}.waterHolders`,
      0,
      MAX_ECOLOGY_ENTRIES,
    ).entries()) {
      const at = `${path}.waterHolders[${index}]`;
      const entry = exactObject(
        value,
        ["objectId", "collectionRemainder", "evaporationRemainder", "integratedAt"],
        at,
      );
      name(entry.objectId, `${at}.objectId`);
      for (const [key, limit] of [
        ["collectionRemainder", 360_000_000_000_000n],
        ["evaporationRemainder", 3_600_000n],
        ["integratedAt", MAX_SIM_TIME + 1n],
      ] as const)
        if (typeof entry[key] !== "bigint" || entry[key] < 0n || entry[key] >= limit)
          fail(`${at}.${key}`, "expected a nonnegative bigint within range");
    }
  for (const [index, entry] of list(
    root.perishables,
    `${path}.perishables`,
    0,
    MAX_ECOLOGY_ENTRIES,
  ).entries()) {
    const at = `${path}.perishables[${index}]`;
    const holder = exactObject(entry, ["objectId", "arrivedAt"], at);
    name(holder.objectId, `${at}.objectId`);
    const arrived = holder.arrivedAt;
    if (arrived !== null && (typeof arrived !== "bigint" || arrived < 0n || arrived > MAX_SIM_TIME))
      fail(`${at}.arrivedAt`, "expected null or a nonnegative bigint time");
  }
  for (const [index, entry] of list(
    root.plants,
    `${path}.plants`,
    0,
    MAX_ECOLOGY_ENTRIES,
  ).entries()) {
    const at = `${path}.plants[${index}]`;
    const plant = exactObject(
      entry,
      ["objectId", "stage", "growingMs", "wetness", "wetnessRemainder", "integratedAt"],
      at,
    );
    name(plant.objectId, `${at}.objectId`);
    safeInteger(plant.stage, `${at}.stage`, 0, MAX_PLANT_STAGES - 1);
    if (
      typeof plant.growingMs !== "bigint" ||
      plant.growingMs < 0n ||
      plant.growingMs > MAX_SIM_TIME
    )
      fail(`${at}.growingMs`, "expected a nonnegative bigint");
    safeInteger(plant.wetness, `${at}.wetness`, 0, 10_000);
    if (
      typeof plant.wetnessRemainder !== "bigint" ||
      plant.wetnessRemainder < 0n ||
      plant.wetnessRemainder >= MAX_WETNESS_REMAINDER
    )
      fail(`${at}.wetnessRemainder`, "expected a nonnegative bigint within range");
    if (
      typeof plant.integratedAt !== "bigint" ||
      plant.integratedAt < 0n ||
      plant.integratedAt > MAX_SIM_TIME
    )
      fail(`${at}.integratedAt`, "expected a nonnegative bigint time");
  }
}

/** The stage index a plant is at after `growingMs` growing milliseconds (the last stage stays). */
export function plantStageIndex(plant: EcologyPlant, growingMs: bigint): number {
  let index = 0;
  for (const [stageIndex, stage] of plant.stages.entries())
    if (stage.thresholdMs <= growingMs) index = stageIndex;
  return index;
}

/** Whether a holder is active: no lifecycle component means active. */
export function entityIsActive(entity: Pick<WorldEntity, "lifecycle">): boolean {
  return entity.lifecycle === undefined || entity.lifecycle.status === "active";
}

/**
 * Derived freshness reading in basis points: `floor(10000 × remaining shelf life / shelf life)`
 * for a holder that holds food, reaching 0 at `arrivedAt + shelfLifeMs`; `null` for an empty holder.
 */
export function foodFreshnessBasisPoints(
  holder: Readonly<{ shelfLifeMs: bigint; arrivedAt: SimTimeMs | null; quantity: number }>,
  now: SimTimeMs,
): number | null {
  if (holder.quantity <= 0 || holder.arrivedAt === null) return null;
  let remaining = holder.arrivedAt + holder.shelfLifeMs - now;
  if (remaining < 0n) remaining = 0n;
  if (remaining > holder.shelfLifeMs) remaining = holder.shelfLifeMs;
  return Number((10_000n * remaining) / holder.shelfLifeMs);
}

export type ResourceAvailability = "available" | "unavailable";

/** Derived availability: `available` for a positive quantity, `unavailable` otherwise. */
export function resourceAvailability(
  resource: Readonly<{ quantity: number }> | undefined,
): ResourceAvailability {
  return resource !== undefined && resource.quantity > 0 ? "available" : "unavailable";
}

/**
 * Recomputes perishable arrival times after a quantity change: cleared when a holder is empty, set
 * (to `inherit` for the named holder, else `time`) when it goes from empty to holding food.
 */
export function settleArrivals(
  ecology: EcologyState | undefined,
  before: readonly WorldEntity[],
  after: readonly WorldEntity[],
  time: SimTimeMs,
  inherit?: Readonly<{ objectId: string; arrivedAt: SimTimeMs }>,
): EcologyState | undefined {
  if (ecology === undefined) return undefined;
  const quantity = (entities: readonly WorldEntity[], id: string): number =>
    entities.find((entity) => entity.objectId === id)?.resource?.quantity ?? 0;
  return {
    ...ecology,
    perishables: ecology.perishables.map((entry) => {
      const next = quantity(after, entry.objectId);
      if (next === 0) return entry.arrivedAt === null ? entry : { ...entry, arrivedAt: null };
      if (quantity(before, entry.objectId) > 0) return entry;
      return {
        ...entry,
        arrivedAt: inherit?.objectId === entry.objectId ? inherit.arrivedAt : time,
      };
    }),
  };
}

type EcologyPolicyHost = Readonly<{ environment?: EnvironmentPolicy; ecology?: EcologyPolicy }>;
type EcologyStateHost = Readonly<{
  simulationTime: SimTimeMs;
  ecology?: EcologyState;
  entities: readonly WorldEntity[];
}>;

/**
 * Returns the offending canonical path when the ecology state record and the policy disagree at the
 * state's simulation time, or `undefined` when they agree. A policy without `ecology` requires a
 * state without one, and vice versa.
 */
export function ecologyDisagreement(
  policy: EcologyPolicyHost,
  state: EcologyStateHost,
): string | undefined {
  const declared = policy.ecology;
  const record = state.ecology;
  if (declared === undefined) return record === undefined ? undefined : "state.ecology";
  if (record === undefined) return "state.ecology";
  if (
    (declared.waterHolders === undefined) !== (record.waterHolders === undefined) ||
    (declared.waterHolders?.length ?? 0) !== (record.waterHolders?.length ?? 0)
  )
    return "state.ecology.waterHolders";
  for (const [index, holder] of (declared.waterHolders ?? []).entries()) {
    const entry = record.waterHolders![index]!;
    const at = `state.ecology.waterHolders[${index}]`;
    const entity = state.entities.find((candidate) => candidate.objectId === holder.objectId);
    if (entry.objectId !== holder.objectId || entity?.resource?.kind !== "water")
      return `${at}.objectId`;
    if (entity.resource.quantity > holder.capacity)
      return `policy.ecology.waterHolders[${index}].capacity`;
    if (entry.integratedAt !== state.simulationTime) return `${at}.integratedAt`;
  }
  const find = (id: string): WorldEntity | undefined =>
    state.entities.find((entity) => entity.objectId === id);
  if (record.perishables.length !== declared.perishables.length) return "state.ecology.perishables";
  if (record.plants.length !== declared.plants.length) return "state.ecology.plants";
  for (const [index, source] of declared.sources.entries()) {
    const entity = find(source.objectId);
    if (entity === undefined) return `policy.ecology.sources[${index}].objectId`;
    if (entity.resource?.kind !== source.kind) return `policy.ecology.sources[${index}].kind`;
  }
  for (const [index, holder] of declared.perishables.entries()) {
    const entry = record.perishables[index]!;
    const at = `state.ecology.perishables[${index}]`;
    if (entry.objectId !== holder.objectId) return `${at}.objectId`;
    const entity = find(holder.objectId);
    if (entity === undefined) return `${at}.objectId`;
    if (entity.resource?.kind !== "food") return `${at}.objectId`;
    const holds = entity.resource.quantity > 0;
    if (!holds && entry.arrivedAt !== null) return `${at}.arrivedAt`;
    if (holds && entry.arrivedAt === null) return `${at}.arrivedAt`;
    if (entry.arrivedAt !== null) {
      if (entry.arrivedAt > state.simulationTime) return `${at}.arrivedAt`;
      if (entry.arrivedAt + holder.shelfLifeMs <= state.simulationTime && entityIsActive(entity))
        return `${at}.arrivedAt`;
    }
  }
  for (const [index, plant] of declared.plants.entries()) {
    const entry = record.plants[index]!;
    const at = `state.ecology.plants[${index}]`;
    if (entry.objectId !== plant.objectId) return `${at}.objectId`;
    const entity = find(plant.objectId);
    if (entity === undefined) return `${at}.objectId`;
    if (plant.stages.some((stage) => stage.yield !== undefined)) {
      if (entity.resource?.kind !== "food") return `policy.ecology.plants[${index}].objectId`;
      const remaining = plant.stages.reduce(
        (sum, stage, stageIndex) =>
          sum + (stageIndex > entry.stage ? BigInt(stage.yield?.quantity ?? 0) : 0n),
        0n,
      );
      if (BigInt(entity.resource.quantity) + remaining > BigInt(Number.MAX_SAFE_INTEGER))
        return `${at}.stage`;
    }
    if (entry.integratedAt > state.simulationTime) return `${at}.integratedAt`;
    if (entry.stage !== plantStageIndex(plant, entry.growingMs)) return `${at}.stage`;
  }
  return undefined;
}
