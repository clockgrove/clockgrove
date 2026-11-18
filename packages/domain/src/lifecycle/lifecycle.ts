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

/** What one kind of actor follows: its stages, lifespan, death, reproduction and successor rule. */
export interface LifecycleKind {
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

/** The original single-kind form: its one lifecycle applies to every needs actor. */
export interface LifecyclePolicyV1 extends LifecycleKind {
  readonly schemaVersion: 1;
}

/** A lifecycle shared by the listed pinned archetypes (`id@version`), each in at most one kind. */
export interface LifecycleKindPolicy extends LifecycleKind {
  readonly archetypes: readonly string[];
}

/** Per-kind form: an actor whose archetype is in no kind has no lifecycle. */
export interface LifecyclePolicyV2 {
  readonly schemaVersion: 2;
  /** 1..16 kinds. */
  readonly kinds: readonly LifecycleKindPolicy[];
}

/** Versioned, optional world-behavior policy record; it requires a `wellbeing` record. */
export type LifecyclePolicy = LifecyclePolicyV1 | LifecyclePolicyV2;

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
  /** 0..2 sorted unique parent object ids; each keeps its entry, or a lineage entry, after death. */
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

/** A dead actor moved out of the counted state: its entry as it died, with its archetype. */
export interface LifecycleLineageEntry extends LifecycleEntry {
  readonly archetypeId: string;
  readonly gestation: null;
  readonly death: LifecycleDeath;
}

/** Present on `WorldState` exactly when the policy has a `lifecycle`; one entry per needs actor. */
export interface LifecycleState {
  readonly households: readonly string[];
  readonly entries: readonly LifecycleEntry[];
  /**
   * The dead moved out of `entries` and `state.entities` (sorted by object id, at most
   * `LIFECYCLE_MAX_LINEAGE`); absent until the first move, so earlier states keep their bytes.
   */
  readonly lineage?: readonly LifecycleLineageEntry[];
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
export const LIFECYCLE_MAX_KINDS = 16;
export const LIFECYCLE_MAX_ENTRIES = 128;
/**
 * Decision (#358): eight full populations of the 128-actor cap. Past it the earliest dead that no
 * entry names as a parent or co-parent leave the state; the journal keeps every life's events.
 */
export const LIFECYCLE_MAX_LINEAGE = 1024;
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

const KIND_KEYS = ["stages", "lifespanMs", "deathHealth", "reproduction", "successorRule"];

/** Validates an untrusted lifecycle policy record; throws `LifecycleValidationError`. */
export function validateLifecyclePolicy(
  value: unknown,
  wellbeing: WellbeingPolicy | undefined,
  path = "policy.lifecycle",
): asserts value is LifecyclePolicy {
  const declared =
    value !== null && typeof value === "object"
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (declared !== 2) {
    const root = exactObject(value, ["schemaVersion", ...KIND_KEYS], path, ["seasonal"]);
    if (root.schemaVersion !== LIFECYCLE_POLICY_VERSION)
      fail(`${path}.schemaVersion`, "unsupported lifecycle schema version");
    validateKind(root, wellbeing, path);
    return;
  }
  const root = exactObject(value, ["schemaVersion", "kinds"], path);
  if (wellbeing === undefined) fail(path, "lifecycle requires a wellbeing record");
  const kinds = array(root.kinds, `${path}.kinds`, 1, LIFECYCLE_MAX_KINDS);
  const claimed = new Set<string>();
  for (const [index, kind] of kinds.entries()) {
    const at = `${path}.kinds[${index}]`;
    const record = exactObject(kind, [...KIND_KEYS, "archetypes"], at, ["seasonal"]);
    for (const [position, archetype] of array(
      record.archetypes,
      `${at}.archetypes`,
      1,
      LIFECYCLE_MAX_ENTRIES,
    ).entries()) {
      const id = name(archetype, `${at}.archetypes[${position}]`);
      if (claimed.has(id))
        fail(`${at}.archetypes[${position}]`, "an archetype is in one kind only");
      claimed.add(id);
    }
    validateKind(record, wellbeing, at);
  }
}

function validateKind(
  root: Record<string, unknown>,
  wellbeing: WellbeingPolicy | undefined,
  path: string,
): void {
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

/** The lifecycle an actor of this pinned archetype follows; `undefined` when its kind declares none. */
export function lifecycleForKind(
  policy: LifecyclePolicy,
  archetypeId: string,
): LifecycleKind | undefined {
  if (policy.schemaVersion === 1) return policy;
  return policy.kinds.find((kind) => kind.archetypes.includes(archetypeId));
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
  const root = exactObject(value, ["households", "entries"], path, ["lineage"]);
  const households = array(root.households, `${path}.households`, 0, LIFECYCLE_MAX_ENTRIES);
  let previousHousehold: string | undefined;
  for (const [index, household] of households.entries()) {
    const id = name(household, `${path}.households[${index}]`);
    if (previousHousehold !== undefined && !(previousHousehold < id))
      fail(`${path}.households`, "households must be unique and sorted");
    previousHousehold = id;
  }
  validateEntries(
    array(root.entries, `${path}.entries`, 0, LIFECYCLE_MAX_ENTRIES),
    `${path}.entries`,
    false,
  );
  if (Object.hasOwn(root, "lineage"))
    validateEntries(
      array(root.lineage, `${path}.lineage`, 1, LIFECYCLE_MAX_LINEAGE),
      `${path}.lineage`,
      true,
    );
}

const ENTRY_KEYS = [
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
];

function validateEntries(entries: readonly unknown[], path: string, lineage: boolean): void {
  let previous: string | undefined;
  for (const [index, entry] of entries.entries()) {
    const at = `${path}[${index}]`;
    const record = exactObject(entry, lineage ? [...ENTRY_KEYS, "archetypeId"] : ENTRY_KEYS, at);
    const id = name(record.objectId, `${at}.objectId`);
    if (previous !== undefined && !(previous < id))
      fail(path, "entries must be unique and in object id order");
    previous = id;
    if (lineage) {
      name(record.archetypeId, `${at}.archetypeId`);
      if (record.death === null) fail(`${at}.death`, "a lineage entry is dead");
      if (record.gestation !== null) fail(`${at}.gestation`, "a lineage entry does not gestate");
    }
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
  policy: Pick<LifecycleKind, "stages">,
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
  const lineage = record.lineage ?? [];
  const known = new Set(record.entries.map((entry) => entry.objectId));
  const households = new Set(record.households);
  for (const [index, dead] of lineage.entries()) {
    const at = `state.lifecycle.lineage[${index}]`;
    if (known.has(dead.objectId) || state.entities.some((e) => e.objectId === dead.objectId))
      return `${at}.objectId`;
    if (!households.has(dead.householdId)) return `${at}.householdId`;
  }
  for (const dead of lineage) known.add(dead.objectId);
  const now = state.simulationTime;
  for (const [index, entry] of record.entries.entries()) {
    const at = `state.lifecycle.entries[${index}]`;
    const actor = actors[index]!;
    const dead = actor.lifecycle?.status === "dead";
    if ((entry.death !== null) !== dead) return `${at}.death`;
    const kind = lifecycleForKind(declared, actor.archetypeId);
    // The dead are frozen at the millisecond before they died: a death precedes a same-time stage change.
    const stageTime =
      entry.death === null || entry.death.diedAt > now ? now : entry.death.diedAt - 1n;
    if (
      entry.stageIndex !==
      (kind === undefined ? 0 : deriveLifecycleStage(kind, entry.bornAt, stageTime))
    )
      return `${at}.stageIndex`;
    if (entry.parentIds.some((parentId) => !known.has(parentId))) return `${at}.parentIds`;
    if (!households.has(entry.householdId)) return `${at}.householdId`;
    if (kind === undefined) {
      if (entry.death !== null || entry.gestation !== null) return `${at}.death`;
      continue;
    }
    if (entry.death !== null) {
      if (entry.gestation !== null) return `${at}.gestation`;
      continue;
    }
    if (entry.bornAt + kind.lifespanMs <= now) return `${at}.death`;
    const health =
      policy.wellbeing === undefined
        ? undefined
        : state.wellbeing?.entries.find((candidate) => candidate.objectId === entry.objectId)
            ?.health;
    if (health !== undefined && health <= kind.deathHealth) return `${at}.death`;
    const gestation = entry.gestation;
    if (gestation !== null) {
      const reproduction = kind.reproduction;
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

/** One life in the lifecycle record: a counted entry or a lineage entry. */
export type LifecycleLife = LifecycleEntry | LifecycleLineageEntry;

export interface LifecycleLinks {
  /** The object's entity; `undefined` once it has moved to the lineage. */
  readonly entity: WorldEntity | undefined;
  readonly entry: LifecycleLife;
  /** Parent lives in parent id order, living or dead. */
  readonly parents: readonly LifecycleLife[];
  readonly householdId: string;
  /** Every object id with the same household, in object id order, living or dead. */
  readonly householdMembers: readonly ObjectId[];
}

/** The entry of a living or dead object, in `entries` or the lineage; `undefined` if unknown. */
export function findLifecycleLife(
  lifecycle: LifecycleState | undefined,
  objectId: string,
): LifecycleLife | undefined {
  return (
    lifecycle?.entries.find((candidate) => candidate.objectId === objectId) ??
    lifecycle?.lineage?.find((candidate) => candidate.objectId === objectId)
  );
}

/**
 * Resolves an object's lifecycle entry, parents and household from `entries` and the lineage, so
 * links resolve after a parent has died and left the counted state. Returns `undefined` for an
 * unknown object or when any link fails to resolve (a parent evicted from a full lineage).
 */
export function resolveLifecycleLinks(
  state: Readonly<{ entities: readonly WorldEntity[]; lifecycle?: LifecycleState }>,
  objectId: ObjectId,
): LifecycleLinks | undefined {
  const lifecycle = state.lifecycle;
  if (lifecycle === undefined) return undefined;
  const entry = findLifecycleLife(lifecycle, objectId);
  if (entry === undefined) return undefined;
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  if (entity === undefined && !("archetypeId" in entry)) return undefined;
  const parents: LifecycleLife[] = [];
  for (const parentId of entry.parentIds) {
    const parent = findLifecycleLife(lifecycle, parentId);
    if (parent === undefined) return undefined;
    parents.push(parent);
  }
  if (!lifecycle.households.includes(entry.householdId)) return undefined;
  const householdMembers = [...lifecycle.entries, ...(lifecycle.lineage ?? [])]
    .filter((candidate) => candidate.householdId === entry.householdId)
    .map((candidate) => candidate.objectId)
    .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  return Object.freeze({
    entity,
    entry,
    parents: Object.freeze(parents),
    householdId: entry.householdId,
    householdMembers: Object.freeze(householdMembers),
  });
}

type CompactableState = Readonly<{
  entities: readonly WorldEntity[];
  wellbeing?: WellbeingState;
  lifecycle?: LifecycleState;
}>;

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, into);
}

/**
 * The dead that can leave the counted state: a needs actor with a death record and Lifecycle
 * status `dead` whose object id no other part of the state names (outside its own entity, its
 * wellbeing entry and the lifecycle record). One walk over the state; sorted by object id.
 */
export function removableLifecycleDead<S extends CompactableState>(state: S): readonly ObjectId[] {
  const lifecycle = state.lifecycle;
  if (lifecycle === undefined) return [];
  const dead = new Set<string>();
  for (const entry of lifecycle.entries) if (entry.death !== null) dead.add(entry.objectId);
  for (const entity of state.entities)
    if (dead.has(entity.objectId) && entity.lifecycle?.status !== "dead")
      dead.delete(entity.objectId);
  if (dead.size === 0) return [];
  const named = new Set<string>();
  for (const [key, value] of Object.entries(state)) {
    if (key === "lifecycle") continue;
    if (key === "entities") {
      for (const entity of state.entities)
        if (!dead.has(entity.objectId)) collectStrings(entity, named);
    } else if (key === "wellbeing") {
      for (const entry of state.wellbeing?.entries ?? [])
        if (!dead.has(entry.objectId)) collectStrings(entry, named);
    } else collectStrings(value, named);
  }
  return [...dead].filter((id) => !named.has(id)).sort() as ObjectId[];
}

/**
 * Moves every removable dead actor (`removableLifecycleDead`) out of `entities`, `wellbeing` and
 * `lifecycle.entries` into `lifecycle.lineage`, then keeps the lineage within
 * `LIFECYCLE_MAX_LINEAGE` by dropping the earliest dead of the earlier lineage (by death time,
 * then object id) that no remaining entry names as a parent or gestating co-parent. Returns the state unchanged when
 * nothing can move. Pure and deterministic.
 */
export function moveDeadToLineage<S extends CompactableState>(state: S): S {
  const lifecycle = state.lifecycle;
  const removable = new Set<string>(removableLifecycleDead(state));
  if (lifecycle === undefined || removable.size === 0) return state;
  const archetypes = new Map(state.entities.map((entity) => [entity.objectId, entity.archetypeId]));
  const entries = lifecycle.entries.filter((entry) => !removable.has(entry.objectId));
  const moved = lifecycle.entries
    .filter((entry) => removable.has(entry.objectId))
    .map(
      (entry): LifecycleLineageEntry => ({
        ...entry,
        gestation: null,
        death: entry.death!,
        archetypeId: archetypes.get(entry.objectId)!,
      }),
    );
  const earlier = lifecycle.lineage ?? [];
  let lineage = [...earlier, ...moved];
  if (lineage.length > LIFECYCLE_MAX_LINEAGE) {
    const pinned = new Set<string>();
    for (const entry of entries) {
      for (const parentId of entry.parentIds) pinned.add(parentId);
      if (entry.gestation?.coParentId != null) pinned.add(entry.gestation.coParentId);
    }
    // Only earlier lineage entries leave: an entity never disappears in the same step it moves.
    const evict = new Set(
      earlier
        .filter((dead) => !pinned.has(dead.objectId))
        .sort((left, right) =>
          left.death.diedAt !== right.death.diedAt
            ? left.death.diedAt < right.death.diedAt
              ? -1
              : 1
            : left.objectId < right.objectId
              ? -1
              : 1,
        )
        .slice(0, lineage.length - LIFECYCLE_MAX_LINEAGE)
        .map((dead) => dead.objectId),
    );
    lineage = lineage.filter((dead) => !evict.has(dead.objectId));
  }
  lineage.sort((left, right) => (left.objectId < right.objectId ? -1 : 1));
  return {
    ...state,
    entities: state.entities.filter((entity) => !removable.has(entity.objectId)),
    ...(state.wellbeing === undefined
      ? {}
      : {
          wellbeing: {
            ...state.wellbeing,
            entries: state.wellbeing.entries.filter((entry) => !removable.has(entry.objectId)),
          },
        }),
    lifecycle: { ...lifecycle, entries, lineage },
  };
}
