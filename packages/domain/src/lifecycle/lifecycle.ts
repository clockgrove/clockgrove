import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";

import { EnvironmentValidationError } from "../environment/environment.js";
import type { WellbeingPolicy, WellbeingState } from "../wellbeing/wellbeing.js";
import type { WorldEntity } from "../world.js";

export type LifecycleCause = "lifespan" | "health";
export type LifecycleCoParent = "required" | "none";

export interface LifecycleStage {
  readonly name: string;
  /** Age at which the stage starts; the first stage starts at 0n and starts strictly increase. */
  readonly startsAtAgeMs: bigint;
}

export interface GestationMilestone {
  readonly name: string;
  /** Strictly between 0n and `gestationMs`, strictly increasing. */
  readonly atMs: bigint;
}

export interface ReproductionPolicy {
  readonly fertileStages: readonly string[];
  /** Conception is attempted at every positive multiple of this interval, anchored at time 0. */
  readonly conceptionIntervalMs: bigint;
  /** 0..10000 basis points. */
  readonly conceptionChance: number;
  readonly coParent: LifecycleCoParent;
  readonly gestationMs: bigint;
  readonly gestationMilestones: readonly GestationMilestone[];
  readonly cooldownMs: bigint;
  /** 1..128 living actors. */
  readonly maxPopulation: number;
}

export interface LifecycleSeason {
  readonly name: string;
  readonly startMs: bigint;
}

/** Optional seasonal hook: it only restricts the seasons in which conception may be attempted. */
export interface LifecycleSeasonalHook {
  readonly schemaVersion: 1;
  readonly yearLengthMs: bigint;
  readonly seasons: readonly LifecycleSeason[];
  readonly conceptionSeasons: readonly string[];
}

/** Versioned, optional world-behavior policy record; it requires a `wellbeing` record. */
export interface LifecyclePolicy {
  readonly schemaVersion: 1;
  /** 2..16 stages. */
  readonly stages: readonly LifecycleStage[];
  /** Age at which an actor dies of old age; greater than the last stage start, at most 2^53. */
  readonly lifespanMs: bigint;
  /** Health at or below this value is death; 0..10000 and below `wellbeing.criticalHealth`. */
  readonly deathHealth: number;
  readonly reproduction: ReproductionPolicy;
  /** Null disables successor intents; otherwise the rule name carried by each intent. */
  readonly successorRule: string | null;
  readonly seasonal?: LifecycleSeasonalHook;
}

export interface LifecycleGestation {
  readonly conceivedAt: SimTimeMs;
  readonly dueAt: SimTimeMs;
  readonly coParentId: ObjectId | null;
  readonly childId: ObjectId;
  /** Number of declared gestation milestones already passed. */
  readonly milestoneIndex: number;
}

export interface LifecycleDeath {
  readonly diedAt: SimTimeMs;
  readonly cause: LifecycleCause;
}

export interface LifecycleEntry {
  readonly objectId: ObjectId;
  readonly householdId: string;
  /** 0..2 sorted unique parent object ids; each keeps its entry after death. */
  readonly parentIds: readonly ObjectId[];
  readonly generation: number;
  /** Signed birth time; founders may be born before time zero. */
  readonly bornAt: bigint;
  readonly stageIndex: number;
  readonly conceptions: number;
  readonly lastBirthAt: SimTimeMs | null;
  readonly gestation: LifecycleGestation | null;
  readonly death: LifecycleDeath | null;
}

/** Present on `WorldState` exactly when the policy has a `lifecycle`; one entry per needs actor. */
export interface LifecycleState {
  readonly households: readonly string[];
  readonly entries: readonly LifecycleEntry[];
}

export type LifecycleEventData =
  | Readonly<{
      type: "lifecycle.conceived";
      payload: Readonly<{
        objectId: ObjectId;
        coParentId: ObjectId | null;
        childId: ObjectId;
        dueAt: SimTimeMs;
      }>;
    }>
  | Readonly<{
      type: "lifecycle.gestation-milestone";
      payload: Readonly<{
        objectId: ObjectId;
        childId: ObjectId;
        milestoneIndex: number;
        milestoneName: string;
      }>;
    }>
  | Readonly<{
      type: "lifecycle.born";
      payload: Readonly<{
        childId: ObjectId;
        gestatingParentId: ObjectId;
        coParentId: ObjectId | null;
      }>;
    }>
  | Readonly<{
      type: "lifecycle.stage-changed";
      payload: Readonly<{ objectId: ObjectId; stageIndex: number; stageName: string }>;
    }>
  | Readonly<{
      type: "lifecycle.died";
      payload: Readonly<{ objectId: ObjectId; cause: LifecycleCause; health: number }>;
    }>
  | Readonly<{
      type: "lifecycle.successor-intended";
      payload: Readonly<{ objectId: ObjectId; successorId: ObjectId; rule: string }>;
    }>;

export const LIFECYCLE_POLICY_VERSION = 1;
export const LIFECYCLE_MAX_STAGES = 16;
export const LIFECYCLE_MAX_ENTRIES = 128;
const MAX_SIM_TIME = (1n << 63n) - 1n;
const MIN_SIM_TIME = -(1n << 63n);
const MAX_DURATION = 1n << 53n;

/** Validation failure whose `path` is the full canonical path (`policy.lifecycle...` or `state.lifecycle...`). */
export class LifecycleValidationError extends EnvironmentValidationError {
  constructor(path: string, message: string) {
    super(path, message);
    this.name = "LifecycleValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new LifecycleValidationError(path, message);
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

function array(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail(path, "expected an array");
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(path, "expected a dense array");
  if (value.length < minimum || value.length > maximum)
    return fail(path, `expected ${minimum} through ${maximum} entries`);
  return value as unknown[];
}

function name(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    return fail(path, "expected a nonempty name without outer whitespace");
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
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

function duration(value: unknown, path: string, minimum: bigint): bigint {
  if (typeof value !== "bigint" || value < minimum || value > MAX_DURATION)
    return fail(path, `expected a bigint duration from ${minimum} through 2^53`);
  return value;
}

function time(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SIM_TIME)
    return fail(path, "expected nonnegative signed-64-bit simulation milliseconds");
  return value;
}

/** Validates an untrusted lifecycle policy record; throws `LifecycleValidationError`. */
export function validateLifecyclePolicy(
  value: unknown,
  wellbeing: WellbeingPolicy | undefined,
  path = "policy.lifecycle",
): asserts value is LifecyclePolicy {
  const root = exactObject(
    value,
    ["schemaVersion", "stages", "lifespanMs", "deathHealth", "reproduction", "successorRule"],
    path,
    ["seasonal"],
  );
  if (root.schemaVersion !== LIFECYCLE_POLICY_VERSION)
    fail(`${path}.schemaVersion`, "unsupported lifecycle schema version");
  if (wellbeing === undefined) fail(path, "lifecycle requires a wellbeing record");
  const stageList = array(root.stages, `${path}.stages`, 2, LIFECYCLE_MAX_STAGES);
  const stageNames = new Set<string>();
  let previousStart = -1n;
  for (const [index, stage] of stageList.entries()) {
    const at = `${path}.stages[${index}]`;
    const record = exactObject(stage, ["name", "startsAtAgeMs"], at);
    const stageName = name(record.name, `${at}.name`);
    if (stageNames.has(stageName)) fail(`${at}.name`, "stage names must be unique");
    stageNames.add(stageName);
    const start = duration(record.startsAtAgeMs, `${at}.startsAtAgeMs`, 0n);
    if (index === 0 && start !== 0n) fail(`${at}.startsAtAgeMs`, "the first stage starts at age 0");
    if (start <= previousStart) fail(`${at}.startsAtAgeMs`, "stage starts must strictly increase");
    previousStart = start;
  }
  const lifespan = duration(root.lifespanMs, `${path}.lifespanMs`, 1n);
  if (lifespan <= previousStart)
    fail(`${path}.lifespanMs`, "the lifespan must exceed the last stage start");
  const deathHealth = integer(root.deathHealth, `${path}.deathHealth`, 0, 10_000);
  if (deathHealth >= wellbeing.criticalHealth)
    fail(`${path}.deathHealth`, "must be below the wellbeing critical health");
  validateReproduction(root.reproduction, stageNames, `${path}.reproduction`);
  if (root.successorRule !== null) name(root.successorRule, `${path}.successorRule`);
  if (Object.hasOwn(root, "seasonal")) validateSeasonal(root.seasonal, `${path}.seasonal`);
}

function validateReproduction(value: unknown, stageNames: ReadonlySet<string>, path: string): void {
  const root = exactObject(
    value,
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
    path,
  );
  const fertile = array(root.fertileStages, `${path}.fertileStages`, 1, LIFECYCLE_MAX_STAGES);
  const seen = new Set<string>();
  for (const [index, stage] of fertile.entries()) {
    const at = `${path}.fertileStages[${index}]`;
    const stageName = name(stage, at);
    if (!stageNames.has(stageName)) fail(at, "names an undeclared stage");
    if (seen.has(stageName)) fail(at, "fertile stages must be unique");
    seen.add(stageName);
  }
  duration(root.conceptionIntervalMs, `${path}.conceptionIntervalMs`, 1n);
  integer(root.conceptionChance, `${path}.conceptionChance`, 0, 10_000);
  if (root.coParent !== "required" && root.coParent !== "none")
    fail(`${path}.coParent`, "expected required or none");
  const gestation = duration(root.gestationMs, `${path}.gestationMs`, 1n);
  const milestones = array(root.gestationMilestones, `${path}.gestationMilestones`, 0, 8);
  const milestoneNames = new Set<string>();
  let previous = 0n;
  for (const [index, milestone] of milestones.entries()) {
    const at = `${path}.gestationMilestones[${index}]`;
    const record = exactObject(milestone, ["name", "atMs"], at);
    const milestoneName = name(record.name, `${at}.name`);
    if (milestoneNames.has(milestoneName)) fail(`${at}.name`, "milestone names must be unique");
    milestoneNames.add(milestoneName);
    const atMs = duration(record.atMs, `${at}.atMs`, 0n);
    if (atMs <= previous || atMs >= gestation)
      fail(`${at}.atMs`, "milestones must lie strictly inside the gestation and strictly increase");
    previous = atMs;
  }
  duration(root.cooldownMs, `${path}.cooldownMs`, 0n);
  integer(root.maxPopulation, `${path}.maxPopulation`, 1, LIFECYCLE_MAX_ENTRIES);
}

function validateSeasonal(value: unknown, path: string): void {
  const root = exactObject(
    value,
    ["schemaVersion", "yearLengthMs", "seasons", "conceptionSeasons"],
    path,
  );
  if (root.schemaVersion !== 1)
    fail(`${path}.schemaVersion`, "unsupported seasonal schema version");
  const year = duration(root.yearLengthMs, `${path}.yearLengthMs`, 1n);
  const seasons = array(root.seasons, `${path}.seasons`, 1, 16);
  const names = new Set<string>();
  let previous = -1n;
  for (const [index, season] of seasons.entries()) {
    const at = `${path}.seasons[${index}]`;
    const record = exactObject(season, ["name", "startMs"], at);
    const seasonName = name(record.name, `${at}.name`);
    if (names.has(seasonName)) fail(`${at}.name`, "season names must be unique");
    names.add(seasonName);
    const start = duration(record.startMs, `${at}.startMs`, 0n);
    if (index === 0 && start !== 0n) fail(`${at}.startMs`, "the first season starts at 0");
    if (start <= previous) fail(`${at}.startMs`, "season starts must strictly increase");
    if (start >= year) fail(`${at}.startMs`, "season starts must lie inside the year");
    previous = start;
  }
  const conception = array(root.conceptionSeasons, `${path}.conceptionSeasons`, 1, 16);
  const seen = new Set<string>();
  for (const [index, season] of conception.entries()) {
    const at = `${path}.conceptionSeasons[${index}]`;
    const seasonName = name(season, at);
    if (!names.has(seasonName)) fail(at, "names an undeclared season");
    if (seen.has(seasonName)) fail(at, "conception seasons must be unique");
    seen.add(seasonName);
  }
}

/** Validates an untrusted lifecycle state record; throws `LifecycleValidationError`. */
export function validateLifecycleState(
  value: unknown,
  path = "state.lifecycle",
): asserts value is LifecycleState {
  const root = exactObject(value, ["households", "entries"], path);
  const households = array(root.households, `${path}.households`, 0, LIFECYCLE_MAX_ENTRIES);
  let previousHousehold: string | undefined;
  for (const [index, household] of households.entries()) {
    const id = name(household, `${path}.households[${index}]`);
    if (previousHousehold !== undefined && !(previousHousehold < id))
      fail(`${path}.households`, "households must be unique and sorted");
    previousHousehold = id;
  }
  const entries = array(root.entries, `${path}.entries`, 0, LIFECYCLE_MAX_ENTRIES);
  let previous: string | undefined;
  for (const [index, entry] of entries.entries()) {
    const at = `${path}.entries[${index}]`;
    const record = exactObject(
      entry,
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
    const id = name(record.objectId, `${at}.objectId`);
    if (previous !== undefined && !(previous < id))
      fail(`${path}.entries`, "entries must be unique and in object id order");
    previous = id;
    name(record.householdId, `${at}.householdId`);
    const parents = array(record.parentIds, `${at}.parentIds`, 0, 2);
    let previousParent: string | undefined;
    for (const [parentIndex, parent] of parents.entries()) {
      const parentId = name(parent, `${at}.parentIds[${parentIndex}]`);
      if (parentId === id)
        fail(`${at}.parentIds[${parentIndex}]`, "an object is not its own parent");
      if (previousParent !== undefined && !(previousParent < parentId))
        fail(`${at}.parentIds`, "parent ids must be unique and sorted");
      previousParent = parentId;
    }
    integer(record.generation, `${at}.generation`, 0, 1_000_000);
    if (
      typeof record.bornAt !== "bigint" ||
      record.bornAt < MIN_SIM_TIME ||
      record.bornAt > MAX_SIM_TIME
    )
      fail(`${at}.bornAt`, "expected a signed-64-bit simulation time bigint");
    integer(record.stageIndex, `${at}.stageIndex`, 0, LIFECYCLE_MAX_STAGES - 1);
    integer(record.conceptions, `${at}.conceptions`, 0, Number.MAX_SAFE_INTEGER);
    if (record.lastBirthAt !== null) time(record.lastBirthAt, `${at}.lastBirthAt`);
    if (record.gestation !== null) {
      const gestationPath = `${at}.gestation`;
      const gestation = exactObject(
        record.gestation,
        ["conceivedAt", "dueAt", "coParentId", "childId", "milestoneIndex"],
        gestationPath,
      );
      const conceivedAt = time(gestation.conceivedAt, `${gestationPath}.conceivedAt`);
      const dueAt = time(gestation.dueAt, `${gestationPath}.dueAt`);
      if (dueAt <= conceivedAt) fail(`${gestationPath}.dueAt`, "must lie after the conception");
      if (gestation.coParentId !== null) name(gestation.coParentId, `${gestationPath}.coParentId`);
      name(gestation.childId, `${gestationPath}.childId`);
      integer(gestation.milestoneIndex, `${gestationPath}.milestoneIndex`, 0, 8);
    }
    if (record.death !== null) {
      const deathPath = `${at}.death`;
      const death = exactObject(record.death, ["diedAt", "cause"], deathPath);
      time(death.diedAt, `${deathPath}.diedAt`);
      if (death.cause !== "lifespan" && death.cause !== "health")
        fail(`${deathPath}.cause`, "unsupported cause of death");
    }
  }
}

/** The index of the stage reached at `atTime` for an actor born at `bornAt`; stage 0 before birth. */
export function deriveLifecycleStage(
  policy: Pick<LifecyclePolicy, "stages">,
  bornAt: bigint,
  atTime: bigint,
): number {
  const age = atTime - bornAt;
  let stage = 0;
  for (const [index, candidate] of policy.stages.entries())
    if (candidate.startsAtAgeMs <= age) stage = index;
  return stage;
}

/** The index of the season in force at `atTime`, anchored at simulation time 0. */
export function deriveLifecycleSeason(
  hook: Pick<LifecycleSeasonalHook, "yearLengthMs" | "seasons">,
  atTime: bigint,
): number {
  const into = ((atTime % hook.yearLengthMs) + hook.yearLengthMs) % hook.yearLengthMs;
  let season = 0;
  for (const [index, candidate] of hook.seasons.entries())
    if (candidate.startMs <= into) season = index;
  return season;
}

type LifecyclePolicyHost = Readonly<{
  wellbeing?: WellbeingPolicy;
  lifecycle?: LifecyclePolicy;
}>;
type LifecycleStateHost = Readonly<{
  simulationTime: SimTimeMs;
  wellbeing?: WellbeingState;
  lifecycle?: LifecycleState;
  entities: readonly WorldEntity[];
}>;

/**
 * Returns the offending canonical path when the lifecycle state record and the policy disagree, or
 * `undefined` when they agree. Entries are exactly one per needs actor in object id order; each
 * stage is the one its age reaches (frozen at death), parents and households resolve, the death
 * record agrees with the entity's Lifecycle status, and nobody living is past a death condition.
 */
export function lifecycleDisagreement(
  policy: LifecyclePolicyHost,
  state: LifecycleStateHost,
): string | undefined {
  const declared = policy.lifecycle;
  const record = state.lifecycle;
  if (declared === undefined) return record === undefined ? undefined : "state.lifecycle";
  if (record === undefined) return "state.lifecycle";
  const actors = state.entities.filter((entity) => entity.needs !== undefined);
  if (record.entries.length !== actors.length) return "state.lifecycle.entries";
  for (const [index, actor] of actors.entries())
    if (record.entries[index]!.objectId !== actor.objectId) return "state.lifecycle.entries";
  const known = new Set(record.entries.map((entry) => entry.objectId));
  const households = new Set(record.households);
  const now = state.simulationTime;
  for (const [index, entry] of record.entries.entries()) {
    const at = `state.lifecycle.entries[${index}]`;
    const actor = actors[index]!;
    const dead = actor.lifecycle?.status === "dead";
    if ((entry.death !== null) !== dead) return `${at}.death`;
    // The dead are frozen at the millisecond before they died: a death precedes a same-time stage change.
    const stageTime =
      entry.death === null || entry.death.diedAt > now ? now : entry.death.diedAt - 1n;
    if (entry.stageIndex !== deriveLifecycleStage(declared, entry.bornAt, stageTime))
      return `${at}.stageIndex`;
    if (entry.parentIds.some((parentId) => !known.has(parentId))) return `${at}.parentIds`;
    if (!households.has(entry.householdId)) return `${at}.householdId`;
    if (entry.death !== null) {
      if (entry.gestation !== null) return `${at}.gestation`;
      continue;
    }
    if (entry.bornAt + declared.lifespanMs <= now) return `${at}.death`;
    const health =
      policy.wellbeing === undefined
        ? undefined
        : state.wellbeing?.entries.find((candidate) => candidate.objectId === entry.objectId)
            ?.health;
    if (health !== undefined && health <= declared.deathHealth) return `${at}.death`;
    const gestation = entry.gestation;
    if (gestation !== null) {
      const reproduction = declared.reproduction;
      if (gestation.dueAt !== gestation.conceivedAt + reproduction.gestationMs)
        return `${at}.gestation.dueAt`;
      if (gestation.dueAt <= now || gestation.conceivedAt > now) return `${at}.gestation.dueAt`;
      if (gestation.coParentId !== null && !known.has(gestation.coParentId))
        return `${at}.gestation.coParentId`;
      let passed = 0;
      for (const milestone of reproduction.gestationMilestones)
        if (gestation.conceivedAt + milestone.atMs <= now) passed += 1;
      if (gestation.milestoneIndex !== passed) return `${at}.gestation.milestoneIndex`;
    }
  }
  return undefined;
}

export interface LifecycleLinks {
  readonly entity: WorldEntity;
  readonly entry: LifecycleEntry;
  /** Parent entities in parent id order, living or dead. */
  readonly parents: readonly WorldEntity[];
  readonly householdId: string;
  /** Every object id with the same household, in object id order, living or dead. */
  readonly householdMembers: readonly ObjectId[];
}

/**
 * Resolves an object's lifecycle entry, parent entities and household. Dead parents stay in
 * `state.entities` and keep their entries, so links resolve after every parent has died. Returns
 * `undefined` for an unknown object or when any link fails to resolve.
 */
export function resolveLifecycleLinks(
  state: Readonly<{ entities: readonly WorldEntity[]; lifecycle?: LifecycleState }>,
  objectId: ObjectId,
): LifecycleLinks | undefined {
  const lifecycle = state.lifecycle;
  if (lifecycle === undefined) return undefined;
  const entry = lifecycle.entries.find((candidate) => candidate.objectId === objectId);
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  if (entry === undefined || entity === undefined) return undefined;
  const parents: WorldEntity[] = [];
  for (const parentId of entry.parentIds) {
    const parent = state.entities.find((candidate) => candidate.objectId === parentId);
    if (
      parent === undefined ||
      !lifecycle.entries.some((candidate) => candidate.objectId === parentId)
    )
      return undefined;
    parents.push(parent);
  }
  if (!lifecycle.households.includes(entry.householdId)) return undefined;
  const householdMembers = lifecycle.entries
    .filter((candidate) => candidate.householdId === entry.householdId)
    .map((candidate) => candidate.objectId);
  return Object.freeze({
    entity,
    entry,
    parents: Object.freeze(parents),
    householdId: entry.householdId,
    householdMembers: Object.freeze(householdMembers),
  });
}
