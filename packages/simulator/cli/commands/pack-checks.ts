import { buildWorldPack, decodeResource, WorldPackError } from "@clockgrove/world-pack-sdk";
import { runScenario, seedGenesis, verifyGenesisBundle } from "../../src/index.js";
import { ARTIFACT_REF_FIELDS, type PackArtifact } from "../artifact.js";
import type { Refusal } from "../envelope.js";
import { type SdkSource, sdkSource } from "../pack-source.js";
import { packPorts, ports } from "../ports.js";

export type CheckName =
  | "artifact-integrity"
  | "seed-genesis"
  | "scenario-assertions"
  | "golden-match";

export interface CheckResult {
  readonly name: CheckName;
  /** The scenario a scenario check ran for; null for the pack-wide checks. */
  readonly scenario: string | null;
  /** `skipped` when an earlier failure leaves nothing to check. */
  readonly status: "passed" | "failed" | "skipped";
  readonly refusal: Refusal | null;
  readonly evidence: unknown;
}

function passed(name: CheckName, scenario: string | null, evidence: unknown): CheckResult {
  return { name, scenario, status: "passed", refusal: null, evidence };
}

function failedCheck(
  name: CheckName,
  scenario: string | null,
  refusal: Refusal,
  evidence: unknown = null,
): CheckResult {
  return { name, scenario, status: "failed", refusal, evidence };
}

function skipped(name: CheckName, scenario: string | null): CheckResult {
  return { name, scenario, status: "skipped", refusal: null, evidence: null };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(right);
}

export interface Rebuilt {
  readonly source: SdkSource;
  readonly artifact: PackArtifact["artifact"];
}

/** Rebuilds the embedded source and compares the result with what the artifact file records. */
export async function checkIntegrity(
  file: PackArtifact,
): Promise<{ readonly check: CheckResult; readonly rebuilt: Rebuilt | null }> {
  const name = "artifact-integrity";
  let source: SdkSource;
  try {
    source = sdkSource(file);
  } catch (error) {
    if (error instanceof WorldPackError)
      return {
        check: failedCheck(name, null, {
          code: error.code,
          path: error.path,
          message: error.message,
        }),
        rebuilt: null,
      };
    throw error;
  }
  const built = await buildWorldPack(source, packPorts);
  if (!built.ok) return { check: failedCheck(name, null, built.error), rebuilt: null };
  const rebuilt = { source, artifact: built.value.artifact };
  if (file.bundleHash !== file.computedBundleHash)
    return {
      check: failedCheck(name, null, {
        code: "BUNDLE_HASH_MISMATCH",
        path: "bundleHash",
        message: "bundleHash differs from the artifact file contents",
      }),
      rebuilt,
    };
  for (const field of ARTIFACT_REF_FIELDS)
    if (file.artifact[field] !== built.value.artifact[field])
      return {
        check: failedCheck(name, null, {
          code: "ARTIFACT_MISMATCH",
          path: `artifact.${field}`,
          message: `${field} differs from the artifact rebuilt from the embedded source`,
        }),
        rebuilt,
      };
  return { check: passed(name, null, { bundleHash: file.bundleHash }), rebuilt };
}

async function checkSeed(rebuilt: Rebuilt): Promise<CheckResult> {
  const name = "seed-genesis";
  const input = { artifact: rebuilt.artifact, source: rebuilt.source };
  const seeded = await seedGenesis(input, ports);
  if (!seeded.ok) return failedCheck(name, null, seeded.error);
  const verified = await verifyGenesisBundle({ bundle: seeded.value.bytes, ...input }, ports);
  if (!verified.ok) return failedCheck(name, null, verified.error);
  return passed(name, null, { bundleHash: verified.value.bundleHash });
}

async function checkScenario(
  rebuilt: Rebuilt,
  scenario: PackArtifact["scenarios"][number],
  golden: Uint8Array | undefined,
): Promise<CheckResult[]> {
  let document: unknown;
  try {
    document = decodeResource(scenario.bytes, `scenarios/${scenario.name}.json`);
  } catch (error) {
    if (error instanceof WorldPackError)
      return [
        failedCheck("scenario-assertions", scenario.name, {
          code: error.code,
          path: error.path,
          message: error.message,
        }),
        skipped("golden-match", scenario.name),
      ];
    throw error;
  }
  const run = await runScenario({ ...rebuilt, scenario: document }, ports);
  if (!run.ok)
    return [
      failedCheck("scenario-assertions", scenario.name, run.error),
      skipped("golden-match", scenario.name),
    ];
  const { bundle, bytes } = run.value;
  const failedAssertions = bundle.assertions
    .filter((assertion) => assertion.passed !== true)
    .map((assertion) => String(assertion.id));
  const assertions =
    failedAssertions.length === 0
      ? passed("scenario-assertions", scenario.name, { count: bundle.assertions.length })
      : failedCheck(
          "scenario-assertions",
          scenario.name,
          {
            code: "ASSERTION_FAILED",
            path: `scenario.assertions.${failedAssertions[0]}`,
            message: "an assertion recorded in the scenario bundle failed",
          },
          { failed: failedAssertions },
        );
  const evidence = { bundleHash: bundle.bundleHash };
  const goldenCheck =
    golden === undefined
      ? failedCheck(
          "golden-match",
          scenario.name,
          {
            code: "GOLDEN_MISSING",
            path: `goldens/${scenario.name}.json`,
            message: "no golden is embedded for the scenario",
          },
          evidence,
        )
      : sameBytes(golden, bytes)
        ? passed("golden-match", scenario.name, evidence)
        : failedCheck(
            "golden-match",
            scenario.name,
            {
              code: "GOLDEN_MISMATCH",
              path: `goldens/${scenario.name}.json`,
              message: "the scenario bundle bytes differ from the embedded golden",
            },
            evidence,
          );
  return [assertions, goldenCheck];
}

/**
 * The pack-wide checks, then `scenario-assertions` and `golden-match` for every embedded scenario in
 * name order. When the embedded source cannot be rebuilt the later checks are `skipped`.
 */
export async function runPackChecks(file: PackArtifact): Promise<CheckResult[]> {
  const { check: integrity, rebuilt } = await checkIntegrity(file);
  const checks = [integrity];
  if (rebuilt === null) {
    checks.push(skipped("seed-genesis", null));
    for (const scenario of file.scenarios)
      checks.push(
        skipped("scenario-assertions", scenario.name),
        skipped("golden-match", scenario.name),
      );
    return checks;
  }
  checks.push(await checkSeed(rebuilt));
  const goldens = new Map(file.goldens.map((golden) => [golden.name, golden.bytes]));
  for (const scenario of file.scenarios)
    checks.push(...(await checkScenario(rebuilt, scenario, goldens.get(scenario.name))));
  return checks;
}
