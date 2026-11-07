import type { WorldState } from "@clockgrove/domain";
import type { WorldPackArtifactRef } from "@clockgrove/world-pack-sdk";
import type { GenesisBundle } from "../genesis.js";
import type { CompareOperator, EquivalenceField, ScenarioDocument } from "./document.js";
import type { PathSegment } from "./support.js";

export const SCENARIO_BUNDLE_KIND = "clockgrove.scenario-bundle";
export const SCENARIO_BUNDLE_VERSION = 1;

/** A refusal of malformed scenario input: `{ code, path, message }`. */
export interface ScenarioRefusalValue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** A record in a run: canonical data whose members the kernel defines. */
export type RunRecord = Readonly<Record<string, unknown>>;

/** What a summarised run keeps of an ordered record list: its length and a chained digest. */
export interface StreamSummary {
  readonly count: number;
  readonly digest: string | null;
}

/** An ordered record list: the records themselves in a full run, a `StreamSummary` in a summarised one. */
export type RecordList = readonly RunRecord[] | StreamSummary;

export interface RandomStreamRecord {
  readonly name: string;
  readonly algorithm: string;
  readonly algorithmVersion: number;
  readonly draws: bigint;
  readonly state: readonly bigint[];
}

export interface ScheduleRecord {
  readonly scheduleId: string;
  readonly kind: string;
  readonly dueAt: bigint;
  readonly payload: unknown;
}

/** One executed plan: the canonical record of the main run or of a variant. */
export interface ScenarioRun {
  readonly name: string;
  readonly randomState: {
    readonly before: readonly RandomStreamRecord[];
    readonly after: readonly RandomStreamRecord[];
  };
  readonly commands: readonly RunRecord[];
  readonly scheduledInputs: RecordList;
  readonly scheduleMutations: RecordList;
  readonly schedule: {
    readonly initial: readonly ScheduleRecord[];
    readonly remaining: readonly ScheduleRecord[];
    readonly nextDueAt: bigint | null;
  };
  readonly events: RecordList;
  readonly decisions: RecordList;
  readonly scriptedInputsUsed: readonly string[];
  readonly rules: {
    readonly evaluated: boolean;
    readonly rules: readonly { readonly id: string; readonly version: number }[];
    readonly evaluations: RecordList;
    readonly intents: RecordList;
    readonly trace: RecordList;
    readonly cooldowns: readonly unknown[];
    readonly disposition: "recorded-not-executed";
  };
  readonly perception: RecordList;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly startStateHash: string;
  readonly finalState: WorldState;
  readonly finalStateHash: string;
  readonly replay: {
    readonly from: "post-seed-state";
    readonly eventCount: number;
    readonly replayedStateHash: string | null;
    readonly finalStateHash: string;
    readonly failure: string | null;
    readonly matches: boolean;
  };
  /** Present only in a summarised run. */
  readonly recording?: "summarised";
  readonly summary?: RunRecord;
}

/** Whether a declared equivalence holds between two runs, and over which fields it does not. */
export interface EquivalenceResult {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly fields: readonly EquivalenceField[];
  readonly eventTypes: readonly string[];
  readonly ignoreEventTypes: readonly string[];
  readonly ignoreStatePaths: readonly (readonly (string | number)[])[];
  readonly equivalent: boolean;
  readonly differences: readonly EquivalenceField[];
}

export interface PathAssertionResult {
  readonly id: string;
  readonly kind: "path";
  readonly run: string;
  readonly path: readonly PathSegment[];
  readonly operator: CompareOperator;
  readonly expected: unknown;
  readonly found: boolean;
  readonly observedKind: "missing" | "scalar" | "composite";
  readonly observed: unknown;
  readonly passed: boolean;
}

export interface EventCountAssertionResult {
  readonly id: string;
  readonly kind: "eventCount";
  readonly run: string;
  readonly eventType: string | null;
  readonly from: bigint | null;
  readonly to: bigint | null;
  readonly operator: CompareOperator;
  readonly expected: number;
  readonly observed: number;
  readonly passed: boolean;
}

export interface EquivalenceAssertionResult {
  readonly id: string;
  readonly kind: "equivalence";
  readonly equivalence: string;
  readonly expected: boolean;
  readonly observed: boolean;
  readonly passed: boolean;
}

export type AssertionResult =
  | PathAssertionResult
  | EventCountAssertionResult
  | EquivalenceAssertionResult;

export interface RegistryPair {
  readonly type: string;
  readonly version: number;
}

export interface BundleVersions {
  readonly simulator: string;
  readonly packEngine: string;
  readonly canonicalEncoding: string;
  readonly catchUpEngine: string;
  readonly audienceResolver: string;
  readonly randomContract: string;
  readonly randomAlgorithm: string;
  readonly behaviorPolicy: string | null;
  readonly scriptedCognition: number;
  readonly scenarioSchema: number;
  readonly genesisBundle: number;
}

export interface ScriptedInput {
  readonly scripted: true;
  readonly origin: "cognitive-seed";
  readonly ref: string;
  readonly entry: ScriptedCognitionEntry;
}

/**
 * The canonical scenario bundle. Top-level field names are closed and documented in
 * `docs/scenarios.md`; every value is canonical data (plain records, arrays, strings, safe integers,
 * bigints, booleans and null).
 */
export interface ScenarioBundle {
  readonly kind: typeof SCENARIO_BUNDLE_KIND;
  readonly version: typeof SCENARIO_BUNDLE_VERSION;
  readonly versions: BundleVersions;
  readonly pack: { readonly id: string; readonly version: string };
  readonly artifact: WorldPackArtifactRef;
  readonly kernel: {
    readonly commands: readonly RegistryPair[];
    readonly events: readonly RegistryPair[];
    readonly reducers: readonly RegistryPair[];
  };
  readonly prng: {
    readonly contract: string;
    readonly algorithm: string;
    readonly streams: readonly {
      readonly name: string;
      readonly algorithm: string;
      readonly algorithmVersion: number;
      readonly seed: string;
    }[];
  };
  readonly genesis: {
    readonly bundleHash: string;
    readonly initialStateHash: string;
    readonly finalStateHash: string;
    readonly seedProjection: GenesisBundle["seedProjection"];
    readonly counters: GenesisBundle["counters"];
    readonly world: GenesisBundle["world"];
  };
  readonly scenario: {
    readonly name: string;
    readonly hash: string;
    readonly document: ScenarioDocument;
  };
  readonly scriptedInputs: readonly ScriptedInput[];
  readonly runs: readonly ScenarioRun[];
  readonly equivalences: readonly EquivalenceResult[];
  readonly assertions: readonly AssertionResult[];
  readonly replayVerified: boolean;
  readonly bundleHash: string;
}

/** One scripted cognition entry as the genesis state holds it. */
type ScriptedCognitionEntry = NonNullable<WorldState["scriptedCognition"]>["entries"][number];

export interface RunScenarioValue {
  readonly bundle: ScenarioBundle;
  readonly bytes: Uint8Array;
}

export type ScenarioResult =
  | { readonly ok: true; readonly value: RunScenarioValue }
  | { readonly ok: false; readonly error: ScenarioRefusalValue };
