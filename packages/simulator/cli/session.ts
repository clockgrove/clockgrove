import { canonicalBytes } from "@clockgrove/kernel";
import type { WorldPackArtifactRef } from "@clockgrove/world-pack-sdk";
import {
  runScenario,
  SCENARIO_KIND,
  SCENARIO_SCHEMA_VERSION,
  type ScenarioBundle,
  verifyGenesisBundle,
} from "../src/index.js";
import { type PackArtifact, readPackArtifact } from "./artifact.js";
import { checkIntegrity } from "./commands/pack-checks.js";
import type { Refusal } from "./envelope.js";
import { UnreadableInput } from "./input.js";
import type { SdkSource } from "./pack-source.js";
import { ports } from "./ports.js";
import { type RunView, viewRun } from "./run-view.js";
import type { StateDocument } from "./state.js";

/** A built pack: its artifact reference and the source it was built from. */
export interface SessionPack {
  readonly artifact: WorldPackArtifactRef;
  readonly source: SdkSource;
}

export interface CommandStep {
  readonly kind: "command";
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AdvanceStep {
  readonly kind: "advance";
  readonly key: string;
  readonly to: bigint;
  readonly mode: "fast-forward";
}

export type SessionStep = CommandStep | AdvanceStep;

export type SessionRun =
  | { readonly ok: true; readonly run: RunView }
  | { readonly ok: false; readonly refusal: Refusal };

function mainRun(bundle: ScenarioBundle): RunView {
  const [main] = bundle.runs;
  if (main === undefined) throw new Error("the scenario bundle has no main run");
  return viewRun(main);
}

/**
 * The state after `steps` is, by definition, the `runScenario` main run of a scenario with exactly
 * those steps. A step the library refuses is returned as that refusal, unchanged.
 */
export async function runSession(
  pack: SessionPack,
  scenarioName: string,
  steps: readonly unknown[],
): Promise<SessionRun> {
  const scenario = {
    kind: SCENARIO_KIND,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name: scenarioName,
    pack: { id: pack.artifact.packId, version: pack.artifact.version },
    steps,
  };
  const result = await runScenario(
    { artifact: pack.artifact, source: pack.source, scenario },
    ports,
  );
  if (!result.ok) return { ok: false, refusal: result.error };
  return { ok: true, run: mainRun(result.value.bundle) };
}

export type VerifiedState =
  | { readonly ok: true; readonly pack: SessionPack; readonly run: RunView }
  | { readonly ok: false; readonly refusal: Refusal };

function mismatch(
  code: "BUNDLE_HASH_MISMATCH" | "BUNDLE_FIELD_MISMATCH",
  field: string,
  what: string,
): VerifiedState {
  return { ok: false, refusal: { code, path: `bundle.${field}`, message: what } };
}

function sameBytes(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left)).equals(canonicalBytes(right));
}

/**
 * Checks a state file: its hash, the embedded pack against its artifact reference, the embedded genesis
 * bundle against a fresh seeding, and the recorded run against a re-execution of the recorded steps.
 * Genesis mismatches are reported at `bundle.genesis.<field>`; other seed refusals pass through.
 */
export async function verifyState(state: StateDocument): Promise<VerifiedState> {
  if (state.bundleHash !== state.computedBundleHash)
    return mismatch(
      "BUNDLE_HASH_MISMATCH",
      "bundleHash",
      "bundleHash differs from the bundle contents",
    );

  const packMismatch = () =>
    mismatch(
      "BUNDLE_FIELD_MISMATCH",
      "pack",
      "the embedded pack source differs from its artifact reference",
    );
  let file: PackArtifact;
  try {
    file = readPackArtifact(state.pack);
  } catch (error) {
    if (error instanceof UnreadableInput) return packMismatch();
    throw error;
  }
  const { check, rebuilt } = await checkIntegrity(file);
  if (check.status !== "passed" || rebuilt === null) return packMismatch();
  const pack: SessionPack = { artifact: rebuilt.artifact, source: rebuilt.source };

  const genesis = await verifyGenesisBundle(
    { bundle: canonicalBytes(state.genesis), ...pack },
    ports,
  );
  if (!genesis.ok) {
    const { code, path, message } = genesis.error;
    const relocated =
      code === "BUNDLE_HASH_MISMATCH" || code === "BUNDLE_FIELD_MISMATCH"
        ? `bundle.genesis${path.slice("bundle".length)}`
        : path;
    return { ok: false, refusal: { code, path: relocated, message } };
  }

  const executed = await runSession(pack, state.scenarioName, state.steps);
  if (!executed.ok) return executed;
  if (!sameBytes(state.run, executed.run.raw))
    return mismatch(
      "BUNDLE_FIELD_MISMATCH",
      "run",
      "the recorded run differs from re-executing the recorded steps",
    );
  if (state.finalStateHash !== executed.run.finalStateHash)
    return mismatch(
      "BUNDLE_FIELD_MISMATCH",
      "finalStateHash",
      "finalStateHash differs from the re-executed run",
    );
  return { ok: true, pack, run: executed.run };
}
