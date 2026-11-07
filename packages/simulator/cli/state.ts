import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import { isRecord } from "../src/scenario/support.js";
import { UnreadableInput } from "./input.js";
import { compareText } from "./pack-source.js";

export const SIMULATION_STATE_KIND = "clockgrove.simulation-state";

/** The scenario name command ids are derived from. */
export const SESSION_SCENARIO = "session";

const STATE_FIELDS = [
  "kind",
  "version",
  "pack",
  "genesis",
  "scenarioName",
  "steps",
  "run",
  "finalStateHash",
  "bundleHash",
] as const;

/** A state file read back; nothing in it is trusted until `verifyState` has checked it. */
export interface StateDocument {
  /** The embedded `clockgrove.pack-artifact` document. */
  readonly pack: unknown;
  /** The embedded genesis bundle. */
  readonly genesis: unknown;
  readonly scenarioName: string;
  readonly steps: readonly unknown[];
  readonly run: unknown;
  readonly finalStateHash: string;
  readonly bundleHash: string;
  /** The SHA-256 of the file's canonical bytes without `bundleHash`. */
  readonly computedBundleHash: string;
}

export interface StateParts {
  readonly pack: unknown;
  readonly genesis: unknown;
  readonly scenarioName: string;
  readonly steps: readonly unknown[];
  readonly run: unknown;
  readonly finalStateHash: string;
}

/** The canonical bytes of the state file, and the `bundleHash` they record. */
export function encodeState(parts: StateParts): {
  readonly bytes: Uint8Array;
  readonly bundleHash: string;
} {
  const withoutHash = { kind: SIMULATION_STATE_KIND, version: 1, ...parts };
  const bundleHash = sha256Hex(canonicalBytes(withoutHash));
  return { bytes: canonicalBytes({ ...withoutHash, bundleHash }), bundleHash };
}

function malformed(): never {
  throw new UnreadableInput("NOT_SIMULATION_STATE");
}

/** Reads a decoded document as a state file; anything else is `NOT_SIMULATION_STATE`. */
export function readStateDocument(document: unknown): StateDocument {
  if (!isRecord(document) || document.kind !== SIMULATION_STATE_KIND) return malformed();
  const keys = Object.keys(document).sort(compareText);
  const expected = [...STATE_FIELDS].sort(compareText);
  if (keys.length !== expected.length || expected.some((key, index) => key !== keys[index]))
    return malformed();
  const { bundleHash, ...withoutHash } = document;
  if (
    document.version !== 1 ||
    typeof document.scenarioName !== "string" ||
    !Array.isArray(document.steps) ||
    typeof document.finalStateHash !== "string" ||
    typeof bundleHash !== "string"
  )
    return malformed();
  return {
    pack: document.pack,
    genesis: document.genesis,
    scenarioName: document.scenarioName,
    steps: document.steps,
    run: document.run,
    finalStateHash: document.finalStateHash,
    bundleHash,
    computedBundleHash: sha256Hex(canonicalBytes(withoutHash)),
  };
}
