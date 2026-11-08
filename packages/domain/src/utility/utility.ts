import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";

import { EnvironmentValidationError } from "../environment/environment.js";
import { FIXED_POINT_LIMIT } from "../spatial/parse.js";
import type { WellbeingPolicy } from "../wellbeing/wellbeing.js";
import type { WorldEntity } from "../world.js";

export const UTILITY_POLICY_VERSION = 1;
export const UTILITY_SCORER = "clockgrove.routine-utility";
export const UTILITY_SCORER_VERSION = 1;
export const SCRIPTED_COGNITION_VERSION = 1;
export const SCRIPTED_REF_PREFIX = "scripted:";
export const MAX_SCRIPTED_ENTRIES = 64;
export const AMBIGUITY_DECLARATION_VERSION = 1;
/** The closed set of ambiguity conditions, in their canonical (sorted) order. */
export const AMBIGUITY_CONDITION_KINDS = Object.freeze([
  "score-margin",
  "unperceived-target",
] as const);
export const DECISION_POINTS_VERSION = 1;
export const MAX_DECISION_POINTS = 8;
export const MAX_DECISION_POINT_FEATURES = 16;
/** The closed set of decision-point triggers. */
export const DECISION_TRIGGER_KINDS = Object.freeze([
  "declared-ambiguity",
  "score-margin",
] as const);
const DECISION_POINT_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const DECISION_MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const DECISION_FEATURE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAX_SIM_TIME = (1n << 63n) - 1n;

export type AmbiguityConditionKind = (typeof AMBIGUITY_CONDITION_KINDS)[number];

/**
 * One declared ambiguity condition: `score-margin` holds when the two best eligible candidates'
 * scores differ by at most `maxMargin`; `unperceived-target` (a novelty condition) holds when the
 * selected seek's target is not perceived, so the choice rests on scripted evidence alone.
 */
export type AmbiguityCondition =
  | Readonly<{ kind: "score-margin"; maxMargin: bigint }>
  | Readonly<{ kind: "unperceived-target" }>;

/** Versioned, bounded declaration of the routine choices a later planner may take up. */
export interface AmbiguityDeclaration {
  readonly schemaVersion: 1;
  /** One condition per kind at most, sorted by kind. */
  readonly conditions: readonly AmbiguityCondition[];
}

/**
 * When a decision point fires on a planning request: `score-margin` when the request's margin is
 * within `maxMargin`; `declared-ambiguity` on any request the ambiguity declaration raised.
 */
export type DecisionTrigger =
  | Readonly<{ kind: "score-margin"; maxMargin: bigint }>
  | Readonly<{ kind: "declared-ambiguity" }>;

/**
 * One decision-model decision point (the decision ladder's fourth tier). It runs in shadow mode
 * only: the model picks among the kernel's own valid candidates beside the utility choice and
 * never changes it. `fallback` is the deterministic choice taken whenever the model abstains.
 */
export interface DecisionPointDeclaration {
  readonly id: string;
  readonly trigger: DecisionTrigger;
  /** Always the kernel's valid (eligible) candidate set; the model never adds an option. */
  readonly candidates: "kernel-valid";
  /** Feature names shown to the model, sorted and unique. */
  readonly features: readonly string[];
  /** A configured model alias; the model behind it is configuration, never code. */
  readonly modelAlias: string;
  /** Basis points, 0..10000: a pick below it abstains to the fallback. */
  readonly confidenceThreshold: number;
  /** Per run: at most `maxCalls` model calls and `maxMicrousd` of spend. */
  readonly budget: Readonly<{ maxCalls: number; maxMicrousd: number }>;
  readonly fallback: "utility-top-pick";
}

export interface DecisionPointsDeclaration {
  readonly schemaVersion: 1;
  /** One to `MAX_DECISION_POINTS`, sorted by unique id. */
  readonly points: readonly DecisionPointDeclaration[];
}

/**
 * Versioned, optional world-behavior policy record; it requires a `wellbeing` record. Weights and
 * rates are integer basis points, `unitsPerSecond` and `perceptionRange` fixed-point bigints.
 */
export interface UtilityPolicy {
  readonly schemaVersion: 1;
  readonly scorer: "clockgrove.routine-utility";
  readonly scorerVersion: 1;
  /** 0..10000. */
  readonly thirstWeight: number;
  /** 0..10000. */
  readonly expectationWeight: number;
  /** 0..10000. */
  readonly travelWeight: number;
  /** Positive fixed-point speed of routine movements. */
  readonly unitsPerSecond: bigint;
  /** Nonnegative fixed-point perception range. */
  readonly perceptionRange: bigint;
  /** Positive safe integer: material units taken at one arrival. */
  readonly biteQuantity: number;
  /** 1..10000 basis points of hunger relieved per consumed unit. */
  readonly hungerReliefPerUnit: number;
  /** 1..10000 basis points of thirst relieved per consumed unit. */
  readonly thirstReliefPerUnit: number;
  /** Optional: absent keeps the canonical encoding and emits no planning request. */
  readonly ambiguity?: AmbiguityDeclaration;
  /** Optional, requires `ambiguity`: absent keeps the canonical encoding and runs no shadow tier. */
  readonly decisionPoints?: DecisionPointsDeclaration;
}

export type ScriptedKind = "belief" | "memory";

/** A scripted (never production) belief or memory about one target of one needs actor. */
export interface ScriptedEntry {
  /** Always begins `scripted:`. */
  readonly ref: string;
  readonly kind: ScriptedKind;
  readonly actorId: ObjectId;
  readonly targetObjectId: ObjectId;
  /** 0..10000. */
  readonly value: number;
  readonly effectiveAt: SimTimeMs;
  /**
   * Optional: the needs actor this evidence came from. Only for kind `belief`, never the entry's own
   * actor. It is never effective when `effectiveAt` is after that actor's death.
   */
  readonly attributedTo?: ObjectId;
}

/** Present on `WorldState` only with a `utility` policy; every entry is marked `source: "scripted"`. */
export interface ScriptedCognitionState {
  readonly schemaVersion: 1;
  readonly source: "scripted";
  /** At most 64 entries, sorted by unique `ref`. */
  readonly entries: readonly ScriptedEntry[];
}

export type UtilityNeed = "hunger" | "thirst";

export type UtilityEventData =
  | Readonly<{
      type: "location.changed";
      payload: Readonly<{ objectId: ObjectId; locationId: ObjectId | null; planId: string }>;
    }>
  | Readonly<{
      type: "needs.relieved";
      payload: Readonly<{
        objectId: ObjectId;
        need: UtilityNeed;
        sourceObjectId: ObjectId;
        quantity: number;
        value: number;
        planId: string;
      }>;
    }>;

/** Validation failure whose `path` is the full canonical path (`policy.utility...` or `state.scriptedCognition...`). */
export class UtilityValidationError extends EnvironmentValidationError {
  constructor(path: string, message: string) {
    super(path, message);
    this.name = "UtilityValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new UtilityValidationError(path, message);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail(path, "expected an object");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(path, "expected a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !keys.includes(key))
      return fail(`${path}.${String(key)}`, "unknown field");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) return fail(`${path}.${key}`, "accessors are not data");
    if (descriptor.value === undefined) return fail(`${path}.${key}`, "undefined is not data");
  }
  for (const key of keys)
    if (!Object.hasOwn(descriptors, key)) return fail(`${path}.${key}`, "missing field");
  return value as Record<string, unknown>;
}

function basisPoints(value: unknown, path: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > 10_000
  )
    return fail(path, `expected integer basis points from ${minimum} through 10000`);
  return value;
}

/** Validates an untrusted utility policy record; throws `UtilityValidationError`. */
export function validateUtilityPolicy(
  value: unknown,
  wellbeing: WellbeingPolicy | undefined,
  path = "policy.utility",
): asserts value is UtilityPolicy {
  const hasAmbiguity =
    value !== null && typeof value === "object" && Object.hasOwn(value, "ambiguity");
  const hasPoints =
    value !== null && typeof value === "object" && Object.hasOwn(value, "decisionPoints");
  const root = exactObject(
    value,
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
      ...(hasAmbiguity ? ["ambiguity"] : []),
      ...(hasPoints ? ["decisionPoints"] : []),
    ],
    path,
  );
  if (root.schemaVersion !== UTILITY_POLICY_VERSION)
    fail(`${path}.schemaVersion`, "unsupported utility schema version");
  if (root.scorer !== UTILITY_SCORER) fail(`${path}.scorer`, "unsupported utility scorer");
  if (root.scorerVersion !== UTILITY_SCORER_VERSION)
    fail(`${path}.scorerVersion`, "unsupported utility scorer version");
  if (wellbeing === undefined) fail(path, "utility requires a wellbeing record");
  for (const key of ["thirstWeight", "expectationWeight", "travelWeight"] as const)
    basisPoints(root[key], `${path}.${key}`, 0);
  const speed = root.unitsPerSecond;
  if (typeof speed !== "bigint" || speed <= 0n || speed > FIXED_POINT_LIMIT)
    fail(`${path}.unitsPerSecond`, "expected a positive fixed-point bigint");
  const range = root.perceptionRange;
  if (typeof range !== "bigint" || range < 0n || range > FIXED_POINT_LIMIT)
    fail(`${path}.perceptionRange`, "expected a nonnegative fixed-point bigint");
  const bite = root.biteQuantity;
  if (typeof bite !== "number" || !Number.isSafeInteger(bite) || bite < 1)
    fail(`${path}.biteQuantity`, "expected a positive safe integer");
  for (const key of ["hungerReliefPerUnit", "thirstReliefPerUnit"] as const)
    basisPoints(root[key], `${path}.${key}`, 1);
  if (hasAmbiguity) validateAmbiguityDeclaration(root.ambiguity, `${path}.ambiguity`);
  if (hasPoints) {
    if (!hasAmbiguity)
      fail(`${path}.decisionPoints`, "decision points require an ambiguity declaration");
    validateDecisionPoints(root.decisionPoints, `${path}.decisionPoints`);
  }
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  )
    fail(path, `expected an integer from ${minimum} through ${maximum}`);
}

/** Validates an untrusted decision-points declaration; throws `UtilityValidationError`. */
function validateDecisionPoints(value: unknown, path: string): void {
  const root = exactObject(value, ["schemaVersion", "points"], path);
  if (root.schemaVersion !== DECISION_POINTS_VERSION)
    fail(`${path}.schemaVersion`, "unsupported decision points schema version");
  const points = root.points;
  if (!Array.isArray(points) || Object.getPrototypeOf(points) !== Array.prototype)
    return fail(`${path}.points`, "expected an array");
  if (Reflect.ownKeys(points).length !== points.length + 1)
    return fail(`${path}.points`, "expected a dense array");
  if (points.length === 0 || points.length > MAX_DECISION_POINTS)
    return fail(`${path}.points`, `expected one to ${MAX_DECISION_POINTS} points`);
  let previous: string | undefined;
  for (const [index, point] of (points as unknown[]).entries()) {
    const at = `${path}.points[${index}]`;
    const record = exactObject(
      point,
      [
        "id",
        "trigger",
        "candidates",
        "features",
        "modelAlias",
        "confidenceThreshold",
        "budget",
        "fallback",
      ],
      at,
    );
    const id = record.id;
    if (typeof id !== "string" || !DECISION_POINT_ID.test(id))
      fail(`${at}.id`, "expected a lowercase identifier of at most 64 characters");
    if (previous !== undefined && (id as string) <= previous)
      fail(`${at}.id`, "points must be unique and sorted by id");
    previous = id as string;
    const kind: unknown =
      typeof record.trigger === "object" && record.trigger !== null
        ? Object.getOwnPropertyDescriptor(record.trigger, "kind")?.value
        : undefined;
    if (!DECISION_TRIGGER_KINDS.includes(kind as never))
      fail(`${at}.trigger.kind`, "unsupported decision trigger");
    const trigger = exactObject(
      record.trigger,
      kind === "score-margin" ? ["kind", "maxMargin"] : ["kind"],
      `${at}.trigger`,
    );
    if (kind === "score-margin") {
      const margin = trigger.maxMargin;
      if (typeof margin !== "bigint" || margin < 0n || margin > FIXED_POINT_LIMIT)
        fail(`${at}.trigger.maxMargin`, "expected a nonnegative fixed-point bigint");
    }
    if (record.candidates !== "kernel-valid")
      fail(
        `${at}.candidates`,
        'expected "kernel-valid": the model only chooses among valid options',
      );
    const features = record.features;
    if (
      !Array.isArray(features) ||
      Object.getPrototypeOf(features) !== Array.prototype ||
      Reflect.ownKeys(features).length !== features.length + 1 ||
      features.length === 0 ||
      features.length > MAX_DECISION_POINT_FEATURES
    )
      fail(`${at}.features`, `expected one to ${MAX_DECISION_POINT_FEATURES} feature names`);
    (features as unknown[]).forEach((feature, featureIndex, all) => {
      if (typeof feature !== "string" || !DECISION_FEATURE.test(feature))
        fail(`${at}.features[${featureIndex}]`, "expected a feature name");
      if (featureIndex > 0 && (feature as string) <= (all[featureIndex - 1] as string))
        fail(`${at}.features[${featureIndex}]`, "features must be unique and sorted");
    });
    if (typeof record.modelAlias !== "string" || !DECISION_MODEL_ALIAS.test(record.modelAlias))
      fail(`${at}.modelAlias`, "expected a model alias");
    boundedInteger(record.confidenceThreshold, `${at}.confidenceThreshold`, 0, 10_000);
    const budget = exactObject(record.budget, ["maxCalls", "maxMicrousd"], `${at}.budget`);
    boundedInteger(budget.maxCalls, `${at}.budget.maxCalls`, 1, 1_000_000);
    boundedInteger(budget.maxMicrousd, `${at}.budget.maxMicrousd`, 1, 1_000_000_000);
    if (record.fallback !== "utility-top-pick")
      fail(`${at}.fallback`, 'expected "utility-top-pick"');
  }
}

/** Validates an untrusted ambiguity declaration; throws `UtilityValidationError`. */
function validateAmbiguityDeclaration(value: unknown, path: string): void {
  const root = exactObject(value, ["schemaVersion", "conditions"], path);
  if (root.schemaVersion !== AMBIGUITY_DECLARATION_VERSION)
    fail(`${path}.schemaVersion`, "unsupported ambiguity schema version");
  const conditions = root.conditions;
  if (!Array.isArray(conditions) || Object.getPrototypeOf(conditions) !== Array.prototype)
    return fail(`${path}.conditions`, "expected an array");
  if (Reflect.ownKeys(conditions).length !== conditions.length + 1)
    return fail(`${path}.conditions`, "expected a dense array");
  // Bounded by the closed set: at most one condition per kind.
  if (conditions.length === 0 || conditions.length > AMBIGUITY_CONDITION_KINDS.length)
    return fail(`${path}.conditions`, "expected one condition per declared kind at most");
  let previous = -1;
  for (const [index, condition] of (conditions as unknown[]).entries()) {
    const at = `${path}.conditions[${index}]`;
    if (condition === null || typeof condition !== "object" || Array.isArray(condition))
      return fail(at, "expected an object");
    const kind: unknown = Object.getOwnPropertyDescriptor(condition, "kind")?.value;
    const order = AMBIGUITY_CONDITION_KINDS.indexOf(kind as AmbiguityConditionKind);
    if (order < 0) fail(`${at}.kind`, "unsupported ambiguity condition");
    if (order <= previous) fail(`${at}.kind`, "conditions must be unique and sorted by kind");
    previous = order;
    const record = exactObject(
      condition,
      kind === "score-margin" ? ["kind", "maxMargin"] : ["kind"],
      at,
    );
    if (kind === "score-margin") {
      const margin = record.maxMargin;
      // Decision: the same bound every fixed-point policy bigint carries (FIXED_POINT_LIMIT).
      if (typeof margin !== "bigint" || margin < 0n || margin > FIXED_POINT_LIMIT)
        fail(`${at}.maxMargin`, "expected a nonnegative fixed-point bigint");
    }
  }
}

const KINDS: readonly unknown[] = ["belief", "memory"];

/**
 * Validates the structure of an untrusted scripted-cognition record; throws `UtilityValidationError`.
 * Its dependency on the policy and on the state's entities is `scriptedCognitionDisagreement`.
 */
export function validateScriptedCognition(
  value: unknown,
  path = "state.scriptedCognition",
): asserts value is ScriptedCognitionState {
  const root = exactObject(value, ["schemaVersion", "source", "entries"], path);
  if (root.schemaVersion !== SCRIPTED_COGNITION_VERSION)
    fail(`${path}.schemaVersion`, "unsupported scripted cognition schema version");
  if (root.source !== "scripted") fail(`${path}.source`, 'expected the source "scripted"');
  const entries = root.entries;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype)
    return fail(`${path}.entries`, "expected an array");
  if (Reflect.ownKeys(entries).length !== entries.length + 1)
    return fail(`${path}.entries`, "expected a dense array");
  if (entries.length > MAX_SCRIPTED_ENTRIES)
    return fail(`${path}.entries`, "expected at most 64 entries");
  let previous: string | undefined;
  for (const [index, entry] of (entries as unknown[]).entries()) {
    const at = `${path}.entries[${index}]`;
    const hasAttribution =
      entry !== null && typeof entry === "object" && Object.hasOwn(entry, "attributedTo");
    const record = exactObject(
      entry,
      [
        "ref",
        "kind",
        "actorId",
        "targetObjectId",
        "value",
        "effectiveAt",
        ...(hasAttribution ? ["attributedTo"] : []),
      ],
      at,
    );
    const ref = record.ref;
    if (typeof ref !== "string" || ref.length > 512 || !ref.startsWith(SCRIPTED_REF_PREFIX))
      fail(`${at}.ref`, "expected a ref beginning scripted:");
    if (previous !== undefined && !(previous < ref))
      fail(`${at}.ref`, "refs must be unique and sorted");
    previous = ref;
    if (!KINDS.includes(record.kind)) fail(`${at}.kind`, "expected belief or memory");
    for (const key of ["actorId", "targetObjectId"] as const) {
      const id = record[key];
      if (typeof id !== "string" || id.length === 0 || id.length > 512 || id.trim() !== id)
        fail(`${at}.${key}`, "expected a nonempty name without outer whitespace");
    }
    if (hasAttribution) {
      const source = record.attributedTo;
      if (
        typeof source !== "string" ||
        source.length === 0 ||
        source.length > 512 ||
        source.trim() !== source
      )
        fail(`${at}.attributedTo`, "expected an object id");
      if (source === record.actorId)
        fail(`${at}.attributedTo`, "evidence cannot be attributed to its own actor");
      if (record.kind === "memory")
        fail(`${at}.attributedTo`, "attributed evidence is never a copied firsthand memory");
    }
    basisPoints(record.value, `${at}.value`, 0);
    const time = record.effectiveAt;
    if (typeof time !== "bigint" || time < 0n || time > MAX_SIM_TIME)
      fail(`${at}.effectiveAt`, "expected nonnegative signed-64-bit simulation milliseconds");
  }
}

type ScriptedPolicyHost = Readonly<{ utility?: UtilityPolicy }>;
type ScriptedStateHost = Readonly<{
  scriptedCognition?: ScriptedCognitionState;
  entities: readonly WorldEntity[];
}>;

function entityActive(entity: WorldEntity): boolean {
  return entity.lifecycle === undefined || entity.lifecycle.status === "active";
}

/** Whether an entity can be the target of a seek: an active food or water holder, or a shelter. */
export function isUtilityTarget(entity: WorldEntity): boolean {
  return (
    entityActive(entity) &&
    (entity.shelter !== undefined ||
      entity.resource?.kind === "food" ||
      entity.resource?.kind === "water")
  );
}

/**
 * Returns the offending canonical path when the scripted record and the policy or entities
 * disagree, or `undefined` when they agree. A record needs a `utility` policy; every entry names a
 * needs actor and an active food holder, water holder or shelter. An entry whose actor has died no
 * longer applies and never disagrees.
 */
export function scriptedCognitionDisagreement(
  policy: ScriptedPolicyHost,
  state: ScriptedStateHost,
): string | undefined {
  const record = state.scriptedCognition;
  if (record === undefined) return undefined;
  if (policy.utility === undefined) return "state.scriptedCognition";
  for (const [index, entry] of record.entries.entries()) {
    const at = `state.scriptedCognition.entries[${index}]`;
    const actor = state.entities.find((candidate) => candidate.objectId === entry.actorId);
    if (actor === undefined || actor.needs === undefined) return `${at}.actorId`;
    // A dead actor never decides again, so its entries no longer apply and are not checked further.
    if (actor.lifecycle?.status === "dead") continue;
    if (!entityActive(actor)) return `${at}.actorId`;
    const target = state.entities.find((candidate) => candidate.objectId === entry.targetObjectId);
    if (target === undefined || !isUtilityTarget(target)) return `${at}.targetObjectId`;
    if (entry.attributedTo !== undefined) {
      const source = state.entities.find((candidate) => candidate.objectId === entry.attributedTo);
      if (source === undefined || source.needs === undefined) return `${at}.attributedTo`;
    }
  }
  return undefined;
}
