import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";

import { type EnvironmentPolicy, EnvironmentValidationError } from "../environment/environment.js";
import type { WorldEntity } from "../world.js";

/** Comfort of one needs actor: derived from hunger, thirst and wetness, never stored independently. */
export type Comfort = "comfortable" | "uncomfortable";
export type ComfortCause = "hungry" | "thirsty" | "wet";
export type WellbeingNeed = "hunger" | "thirst";
export type HealthThreshold = "critical";
export type HealthDirection = "entered" | "left";

/**
 * Versioned, optional world-behavior policy record; it requires an `environment` record. Every
 * rate is integer basis points per decision interval, every threshold integer basis points.
 */
export interface WellbeingPolicy {
  readonly schemaVersion: 1;
  /** 0..10000 per decision interval. */
  readonly thirstPerInterval: number;
  /** 0..10000 per decision interval while uncomfortable. */
  readonly healthLossPerInterval: number;
  /** 0..10000 per decision interval while comfortable. */
  readonly healthRecoveryPerInterval: number;
  /** 1..10000: hunger at or above this value is urgent. */
  readonly urgentHunger: number;
  /** 1..10000: thirst at or above this value is urgent. */
  readonly urgentThirst: number;
  /** 1..10000: health below this value is critical. */
  readonly criticalHealth: number;
}

export interface WellbeingEntry {
  readonly objectId: ObjectId;
  readonly thirst: number;
  readonly thirstRemainder: bigint;
  readonly health: number;
  readonly healthRemainder: bigint;
  readonly comfort: Comfort;
  /** Always equal to the actor's `needs.integratedAt` in a consistent state. */
  readonly integratedAt: SimTimeMs;
}

/** Present on `WorldState` exactly when the policy has a `wellbeing`; one entry per needs actor. */
export interface WellbeingState {
  readonly entries: readonly WellbeingEntry[];
}

export type WellbeingEventData =
  | Readonly<{
      type: "wellbeing.integrated";
      payload: Readonly<{
        objectId: ObjectId;
        thirst: number;
        thirstRemainder: bigint;
        health: number;
        healthRemainder: bigint;
        integratedAt: SimTimeMs;
      }>;
    }>
  | Readonly<{
      type: "needs.threshold-crossed";
      payload: Readonly<{ objectId: ObjectId; need: WellbeingNeed; value: number }>;
    }>
  | Readonly<{
      type: "comfort.changed";
      payload: Readonly<{ objectId: ObjectId; comfort: Comfort; causes: readonly ComfortCause[] }>;
    }>
  | Readonly<{
      type: "health.threshold-crossed";
      payload: Readonly<{
        objectId: ObjectId;
        threshold: HealthThreshold;
        direction: HealthDirection;
        health: number;
      }>;
    }>;

export const WELLBEING_POLICY_VERSION = 1;
const MAX_SIM_TIME = (1n << 63n) - 1n;
const MAX_ENTRIES = 128;

/** Validation failure whose `path` is the full canonical path (`policy.wellbeing...` or `state.wellbeing...`). */
export class WellbeingValidationError extends EnvironmentValidationError {
  constructor(path: string, message: string) {
    super(path, message);
    this.name = "WellbeingValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new WellbeingValidationError(path, message);
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

/** Validates an untrusted wellbeing policy record; throws `WellbeingValidationError`. */
export function validateWellbeingPolicy(
  value: unknown,
  environment: EnvironmentPolicy | undefined,
  path = "policy.wellbeing",
): asserts value is WellbeingPolicy {
  const root = exactObject(
    value,
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
  if (root.schemaVersion !== WELLBEING_POLICY_VERSION)
    fail(`${path}.schemaVersion`, "unsupported wellbeing schema version");
  if (environment === undefined) fail(path, "wellbeing requires an environment record");
  for (const key of [
    "thirstPerInterval",
    "healthLossPerInterval",
    "healthRecoveryPerInterval",
  ] as const)
    basisPoints(root[key], `${path}.${key}`, 0);
  for (const key of ["urgentHunger", "urgentThirst", "criticalHealth"] as const)
    basisPoints(root[key], `${path}.${key}`, 1);
}

const COMFORTS: readonly unknown[] = ["comfortable", "uncomfortable"];

/** Validates an untrusted wellbeing state record; throws `WellbeingValidationError`. */
export function validateWellbeingState(
  value: unknown,
  path = "state.wellbeing",
): asserts value is WellbeingState {
  const root = exactObject(value, ["entries"], path);
  const entries = root.entries;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype)
    return fail(`${path}.entries`, "expected an array");
  if (Reflect.ownKeys(entries).length !== entries.length + 1)
    return fail(`${path}.entries`, "expected a dense array");
  if (entries.length > MAX_ENTRIES) return fail(`${path}.entries`, "expected at most 128 entries");
  let previous: string | undefined;
  for (const [index, entry] of (entries as unknown[]).entries()) {
    const at = `${path}.entries[${index}]`;
    const record = exactObject(
      entry,
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
    const id = record.objectId;
    if (typeof id !== "string" || id.length === 0 || id.length > 512 || id.trim() !== id)
      fail(`${at}.objectId`, "expected a nonempty name without outer whitespace");
    if (previous !== undefined && !(previous < id))
      fail(`${at}.objectId`, "entries must be unique and in object id order");
    previous = id;
    basisPoints(record.thirst, `${at}.thirst`, 0);
    basisPoints(record.health, `${at}.health`, 0);
    for (const key of ["thirstRemainder", "healthRemainder"] as const) {
      const remainder = record[key];
      if (typeof remainder !== "bigint" || remainder < 0n || remainder >= MAX_SIM_TIME)
        fail(`${at}.${key}`, "expected a nonnegative bigint remainder");
    }
    if (!COMFORTS.includes(record.comfort)) fail(`${at}.comfort`, "unsupported comfort");
    const time = record.integratedAt;
    if (typeof time !== "bigint" || time < 0n || time > MAX_SIM_TIME)
      fail(`${at}.integratedAt`, "expected nonnegative signed-64-bit simulation milliseconds");
  }
}

/** The comfort and sorted causes in force for the given need values (the one derivation rule). */
export function deriveComfort(
  environment: Pick<EnvironmentPolicy, "discomfortThreshold">,
  wellbeing: Pick<WellbeingPolicy, "urgentHunger" | "urgentThirst">,
  values: Readonly<{ hunger: number; thirst: number; wetness: number }>,
): Readonly<{ comfort: Comfort; causes: readonly ComfortCause[] }> {
  const causes: ComfortCause[] = [];
  if (values.hunger >= wellbeing.urgentHunger) causes.push("hungry");
  if (values.thirst >= wellbeing.urgentThirst) causes.push("thirsty");
  if (values.wetness >= environment.discomfortThreshold) causes.push("wet");
  return Object.freeze({
    comfort: causes.length === 0 ? "comfortable" : "uncomfortable",
    causes: Object.freeze(causes),
  });
}

type WellbeingPolicyHost = Readonly<{
  decisionIntervalMs: bigint;
  environment?: EnvironmentPolicy;
  wellbeing?: WellbeingPolicy;
}>;
type WellbeingStateHost = Readonly<{
  wellbeing?: WellbeingState;
  entities: readonly WorldEntity[];
}>;

/**
 * Returns the offending canonical path when the wellbeing state record and the policy disagree, or
 * `undefined` when they agree. A policy without `wellbeing` requires a state without one, and vice
 * versa; entries are exactly one per needs actor in object id order, each integrated through the
 * actor's `needs.integratedAt` with the comfort the needs derive.
 */
export function wellbeingDisagreement(
  policy: WellbeingPolicyHost,
  state: WellbeingStateHost,
): string | undefined {
  const declared = policy.wellbeing;
  const record = state.wellbeing;
  if (declared === undefined) return record === undefined ? undefined : "state.wellbeing";
  if (record === undefined) return "state.wellbeing";
  const environment = policy.environment;
  const actors = state.entities.filter((entity) => entity.needs !== undefined);
  if (record.entries.length !== actors.length) return "state.wellbeing.entries";
  for (const [index, actor] of actors.entries()) {
    const entry = record.entries[index]!;
    const at = `state.wellbeing.entries[${index}]`;
    const needs = actor.needs!;
    if (entry.objectId !== actor.objectId) return `${at}.objectId`;
    if (entry.integratedAt !== needs.integratedAt) return `${at}.integratedAt`;
    if (entry.thirstRemainder >= policy.decisionIntervalMs) return `${at}.thirstRemainder`;
    if (entry.healthRemainder >= policy.decisionIntervalMs) return `${at}.healthRemainder`;
    if (environment === undefined) return "state.wellbeing";
    const derived = deriveComfort(environment, declared, {
      hunger: needs.hunger,
      thirst: entry.thirst,
      wetness: needs.wetness,
    });
    if (entry.comfort !== derived.comfort) return `${at}.comfort`;
  }
  return undefined;
}
