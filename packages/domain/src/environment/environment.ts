import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";

import { DomainValidationError } from "../actor-process.js";

/** Versioned, optional world-behavior policy record; both cycles are anchored at simulation time 0. */
export interface EnvironmentPhase {
  /** Pack data, unique within the policy. */
  readonly name: string;
  /** Offset within the day in simulation milliseconds; the first phase starts at 0. */
  readonly startMs: bigint;
  readonly lightBand: string;
}

export interface EnvironmentWeatherSegment {
  readonly durationMs: bigint;
  /** Basis points, 0..10000. */
  readonly rainIntensity: number;
  readonly temperatureBand: string;
}

export interface EnvironmentPolicy {
  readonly schemaVersion: 1;
  readonly dayLengthMs: bigint;
  readonly phases: readonly EnvironmentPhase[];
  readonly weatherSegments: readonly EnvironmentWeatherSegment[];
  /** Basis points 1..10000: wetness at or above this value is `wet`. */
  readonly wetThreshold: number;
  /** Basis points 1..10000: wetness at or above this value is `uncomfortable`. */
  readonly discomfortThreshold: number;
}

/** Present on `WorldState` exactly when the policy has an `environment`. */
export interface EnvironmentState {
  readonly phase: string;
  readonly lightBand: string;
  readonly nextPhaseBoundary: SimTimeMs;
  readonly segmentIndex: number;
  readonly temperatureBand: string;
  readonly nextWeatherBoundary: SimTimeMs;
}

export type RainChange = "began" | "ended" | "changed" | "unchanged";
export type ExposureThreshold = "wet" | "uncomfortable";
export type ExposureDirection = "entered" | "left";

export type EnvironmentEventData =
  | Readonly<{
      type: "environment.phase-changed";
      payload: Readonly<{ phase: string; lightBand: string; nextPhaseBoundary: SimTimeMs }>;
    }>
  | Readonly<{
      type: "weather.transitioned";
      payload: Readonly<{
        segmentIndex: number;
        rainIntensity: number;
        temperatureBand: string;
        nextWeatherBoundary: SimTimeMs;
        rainChange: RainChange;
      }>;
    }>
  | Readonly<{
      type: "exposure.threshold-crossed";
      payload: Readonly<{
        objectId: ObjectId;
        threshold: ExposureThreshold;
        direction: ExposureDirection;
        wetness: number;
      }>;
    }>;

export const ENVIRONMENT_POLICY_VERSION = 1;
export const MAX_ENVIRONMENT_ENTRIES = 64;
/** Day length and segment durations stay far below the signed-64-bit simulation-time ceiling. */
export const MAX_ENVIRONMENT_DURATION_MS = 1n << 53n;
const MAX_BOUNDARY = 1n << 64n;

/** Validation failure whose `path` is the full canonical path (`policy.environment...` or `state.environment...`). */
export class EnvironmentValidationError extends DomainValidationError {
  constructor(path: string, message: string) {
    super(path, message);
    this.name = "EnvironmentValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new EnvironmentValidationError(path, message);
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

function duration(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_ENVIRONMENT_DURATION_MS)
    return fail(path, "expected a positive bigint duration within range");
  return value;
}

function entries(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail(path, "expected an array");
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(path, "expected a dense array");
  if (value.length < 1 || value.length > MAX_ENVIRONMENT_ENTRIES)
    return fail(path, "expected 1 to 64 entries");
  return value as readonly unknown[];
}

/** Validates an untrusted environment policy record; throws `EnvironmentValidationError`. */
export function validateEnvironmentPolicy(
  value: unknown,
  path = "policy.environment",
): asserts value is EnvironmentPolicy {
  const root = exactObject(
    value,
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
  if (root.schemaVersion !== ENVIRONMENT_POLICY_VERSION)
    fail(`${path}.schemaVersion`, "unsupported environment schema version");
  const dayLength = duration(root.dayLengthMs, `${path}.dayLengthMs`);
  const phases = entries(root.phases, `${path}.phases`);
  const names = new Set<string>();
  let previous = -1n;
  for (const [index, entry] of phases.entries()) {
    const at = `${path}.phases[${index}]`;
    const phase = exactObject(entry, ["name", "startMs", "lightBand"], at);
    const phaseName = name(phase.name, `${at}.name`);
    if (names.has(phaseName)) fail(`${at}.name`, "phase names must be unique");
    names.add(phaseName);
    name(phase.lightBand, `${at}.lightBand`);
    const start = phase.startMs;
    if (typeof start !== "bigint" || start < 0n || start >= dayLength)
      fail(`${at}.startMs`, "expected a bigint start offset below the day length");
    if (index === 0 && start !== 0n) fail(`${at}.startMs`, "the first phase must start at 0");
    if (start <= previous) fail(`${at}.startMs`, "phase starts must strictly increase");
    previous = start;
  }
  const segments = entries(root.weatherSegments, `${path}.weatherSegments`);
  for (const [index, entry] of segments.entries()) {
    const at = `${path}.weatherSegments[${index}]`;
    const segment = exactObject(entry, ["durationMs", "rainIntensity", "temperatureBand"], at);
    duration(segment.durationMs, `${at}.durationMs`);
    basisPoints(segment.rainIntensity, `${at}.rainIntensity`, 0);
    name(segment.temperatureBand, `${at}.temperatureBand`);
  }
  basisPoints(root.wetThreshold, `${path}.wetThreshold`, 1);
  basisPoints(root.discomfortThreshold, `${path}.discomfortThreshold`, 1);
}

/** Validates an untrusted environment state record; throws `EnvironmentValidationError`. */
export function validateEnvironmentState(
  value: unknown,
  path = "state.environment",
): asserts value is EnvironmentState {
  const root = exactObject(
    value,
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
  name(root.phase, `${path}.phase`);
  name(root.lightBand, `${path}.lightBand`);
  name(root.temperatureBand, `${path}.temperatureBand`);
  for (const key of ["nextPhaseBoundary", "nextWeatherBoundary"] as const) {
    const time = root[key];
    if (typeof time !== "bigint" || time < 1n || time > MAX_BOUNDARY)
      fail(`${path}.${key}`, "expected a positive bigint boundary time");
  }
  const index = root.segmentIndex;
  if (
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    Object.is(index, -0) ||
    index < 0 ||
    index >= MAX_ENVIRONMENT_ENTRIES
  )
    fail(`${path}.segmentIndex`, "expected a segment index from 0 through 63");
}

function mod(value: bigint, modulus: bigint): bigint {
  return value % modulus;
}

/** The record the policy derives at simulation time `time` (both cycles anchored at 0). */
export function deriveEnvironmentState(policy: EnvironmentPolicy, time: bigint): EnvironmentState {
  const offset = mod(time, policy.dayLengthMs);
  const dayStart = time - offset;
  let phaseIndex = 0;
  for (const [index, phase] of policy.phases.entries())
    if (phase.startMs <= offset) phaseIndex = index;
  const phase = policy.phases[phaseIndex]!;
  const following = policy.phases[phaseIndex + 1];
  const nextPhaseBoundary =
    dayStart + (following === undefined ? policy.dayLengthMs : following.startMs);
  const cycle = policy.weatherSegments.reduce((total, segment) => total + segment.durationMs, 0n);
  const cycleOffset = mod(time, cycle);
  const cycleStart = time - cycleOffset;
  let segmentIndex = 0;
  let segmentStart = 0n;
  for (const [index, segment] of policy.weatherSegments.entries()) {
    if (cycleOffset < segmentStart + segment.durationMs) {
      segmentIndex = index;
      break;
    }
    segmentStart += segment.durationMs;
  }
  const segment = policy.weatherSegments[segmentIndex]!;
  return Object.freeze({
    phase: phase.name,
    lightBand: phase.lightBand,
    nextPhaseBoundary: nextPhaseBoundary as SimTimeMs,
    segmentIndex,
    temperatureBand: segment.temperatureBand,
    nextWeatherBoundary: (cycleStart + segmentStart + segment.durationMs) as SimTimeMs,
  });
}

/** Classifies a rain change from the intensity in force to the intensity the segment authors. */
export function classifyRainChange(before: number, after: number): RainChange {
  if (before === after) return "unchanged";
  if (before === 0) return "began";
  if (after === 0) return "ended";
  return "changed";
}

/**
 * Returns the offending canonical path when the state record and the policy disagree at the
 * state's simulation time, or `undefined` when they agree. A policy without `environment`
 * requires a state without one, and vice versa.
 */
export function environmentDisagreement(
  policy: Readonly<{ environment?: EnvironmentPolicy }>,
  state: Readonly<{ simulationTime: SimTimeMs; environment?: EnvironmentState }>,
): string | undefined {
  const declared = policy.environment;
  const record = state.environment;
  if (declared === undefined) return record === undefined ? undefined : "state.environment";
  if (record === undefined) return "state.environment";
  const derived = deriveEnvironmentState(declared, state.simulationTime);
  for (const key of [
    "phase",
    "lightBand",
    "nextPhaseBoundary",
    "segmentIndex",
    "temperatureBand",
    "nextWeatherBoundary",
  ] as const)
    if (record[key] !== derived[key]) return `state.environment.${key}`;
  return undefined;
}
