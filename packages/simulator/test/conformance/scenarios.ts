import { fromBase64, toWireRequest, type WireResponse } from "../../cli/wire.js";
import { decodeCanonicalBytes } from "../../src/canonical-decode.js";
import { packRuleIds } from "./checks.js";
import { CHECKS, type ConformanceProblem, throwIfProblems } from "./failure.js";
import { bytesEqual, describeDifference, removeActualBundle, writeActualBundle } from "./golden.js";
import type { LoadedPack } from "./pack-source.js";
import {
  type Observation,
  ResourceLedger,
  type RuntimeRun,
  runInNode,
  runInWorkers,
  startWorkers,
} from "./runtime.js";

type Rec = Record<string, any>;

/**
 * One scenario run on one runtime: the observations next to the bundle hash. Observations are
 * measured by the harness and are not part of the hashed bundle.
 */
export interface RunReport {
  readonly pack: string;
  readonly scenario: string;
  readonly runtime: string;
  readonly bundleHash: string;
  readonly durationMs: number;
  readonly peakMemoryBytes: number | null;
  readonly peakMemoryNullReason: string | null;
}

/** Problems with a report: a missing runtime, duration, peak memory (or its reason) or hash. */
export function reportProblems(report: Partial<Record<keyof RunReport, unknown>>): string[] {
  const problems: string[] = [];
  if (typeof report.runtime !== "string" || report.runtime === "")
    problems.push("runtime identifier is missing");
  if (
    typeof report.durationMs !== "number" ||
    !Number.isFinite(report.durationMs) ||
    report.durationMs < 0
  )
    problems.push("duration is missing");
  if (report.peakMemoryBytes === null || report.peakMemoryBytes === undefined) {
    if (typeof report.peakMemoryNullReason !== "string" || report.peakMemoryNullReason === "")
      problems.push("peak memory is missing and no reason is stated for null");
  } else if (typeof report.peakMemoryBytes !== "number" || !(report.peakMemoryBytes >= 0)) {
    problems.push("peak memory is not a number of bytes");
  }
  if (typeof report.bundleHash !== "string" || !/^[0-9a-f]{64}$/u.test(report.bundleHash))
    problems.push("bundle hash is missing");
  return problems;
}

/** The run-observations problems of a list of reports, each naming pack, scenario and runtime. */
export function reportListProblems(
  pack: string,
  reports: readonly Partial<Record<keyof RunReport, unknown>>[],
): ConformanceProblem[] {
  return reports.flatMap((report) =>
    reportProblems(report).map((detail) => ({
      pack,
      check: CHECKS.observations,
      detail: `scenario ${String(report.scenario)} on ${String(report.runtime)}: ${detail}`,
    })),
  );
}

/** Fails when any report lacks its runtime identifier, duration, peak memory (or reason) or hash. */
export function checkRunReports(
  pack: string,
  reports: readonly Partial<Record<keyof RunReport, unknown>>[],
): void {
  throwIfProblems(reportListProblems(pack, reports));
}

export function toReport(
  pack: string,
  scenario: string,
  bundleHash: string,
  observation: Observation,
): RunReport {
  return { pack, scenario, bundleHash, ...observation };
}

interface Decoded {
  readonly bytes: Uint8Array;
  readonly bundle: Rec;
}

function decodeRun(run: RuntimeRun): Decoded | string {
  const response: WireResponse = run.response;
  if (!response.ok)
    return `${response.stage} refused: ${response.code} at ${response.path}: ${response.message}`;
  const bytes = fromBase64(response.bundle);
  const decoded = decodeCanonicalBytes(bytes);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null)
    return "the returned bytes are not a canonical bundle";
  return { bytes, bundle: decoded.value as Rec };
}

export interface ScenarioEvidence {
  readonly scenario: string;
  readonly bytes: Uint8Array;
  readonly bundle: Rec;
  readonly reports: readonly RunReport[];
}

export interface RunScenariosResult {
  readonly evidence: readonly ScenarioEvidence[];
  readonly reports: readonly RunReport[];
}

export interface CheckScenariosOptions {
  /** Also run in workerd and check Node/Workers parity (default). Node-only skips both. */
  readonly workers?: boolean;
}

/**
 * Runs every committed scenario in Node and in workerd and checks parity, assertions, goldens,
 * observations and rule-intent coverage. Workers and temporary directories are disposed even when a
 * check fails; actual bundles are written next to their golden for review and reported by path.
 * With `workers: false` only the Node run, its assertions, golden, observations and rule intents
 * are checked.
 */
export async function checkScenarios(
  pack: LoadedPack,
  ledger: ResourceLedger = new ResourceLedger(),
  options: CheckScenariosOptions = {},
): Promise<RunScenariosResult> {
  const withWorkers = options.workers ?? true;
  const problems: ConformanceProblem[] = [];
  const add = (check: string, detail: string) => problems.push({ pack: pack.name, check, detail });
  const evidence: ScenarioEvidence[] = [];
  const reports: RunReport[] = [];
  try {
    const goldens = new Map(pack.goldens.map((golden) => [golden.name, golden.bytes]));
    const session =
      pack.scenarios.length === 0 || !withWorkers
        ? undefined
        : await startWorkers(pack.name, ledger);
    for (const scenario of pack.scenarios) {
      const request = toWireRequest({
        manifestBytes: pack.manifestBytes,
        resourceBytes: pack.resourceBytes,
        scenarioBytes: scenario.bytes,
      });
      const node = await runInNode(request);
      const workers = withWorkers ? await runInWorkers(pack.name, session!, request) : undefined;
      const nodeDecoded = decodeRun(node);
      const workersDecoded = workers === undefined ? undefined : decodeRun(workers);
      const label = `scenario ${scenario.name}`;
      if (typeof nodeDecoded === "string") add(CHECKS.parity, `${label}: Node run: ${nodeDecoded}`);
      if (typeof workersDecoded === "string")
        add(CHECKS.parity, `${label}: Workers run: ${workersDecoded}`);
      if (typeof nodeDecoded === "string" || typeof workersDecoded === "string") continue;

      const nodeHash = String(nodeDecoded.bundle.bundleHash);
      const workersHash =
        workersDecoded === undefined ? undefined : String(workersDecoded.bundle.bundleHash);
      const runReports = [toReport(pack.name, scenario.name, nodeHash, node.observation)];
      if (workers !== undefined && workersHash !== undefined)
        runReports.push(toReport(pack.name, scenario.name, workersHash, workers.observation));
      for (const report of runReports) {
        console.info(`conformance-run ${JSON.stringify(report)}`);
        reports.push(report);
      }
      evidence.push({
        scenario: scenario.name,
        bytes: nodeDecoded.bytes,
        bundle: nodeDecoded.bundle,
        reports: runReports,
      });

      if (
        workersDecoded !== undefined &&
        (!bytesEqual(nodeDecoded.bytes, workersDecoded.bytes) || nodeHash !== workersHash)
      ) {
        const difference = describeDifference(nodeDecoded.bytes, workersDecoded.bytes);
        add(
          CHECKS.parity,
          `${label}: Node and Workers bundles differ (hashes ${nodeHash} and ${workersHash}); differing bundle fields: ${
            typeof difference === "string" ? difference : difference.fields.join(", ")
          }`,
        );
      }

      const failed = (nodeDecoded.bundle.assertions as Rec[])
        .filter((assertion) => assertion.passed !== true)
        .map((assertion) => String(assertion.id));
      if (failed.length > 0)
        add(CHECKS.assertions, `${label}: failing assertions: ${failed.join(", ")}`);

      const golden = goldens.get(scenario.name);
      if (golden === undefined) {
        const path = await writeActualBundle(pack, scenario.name, nodeDecoded.bytes);
        add(
          CHECKS.golden,
          `${label}: no golden is committed under goldens/${scenario.name}.json; the actual bundle (hash ${nodeHash}) was written to ${path}; review it and copy it to goldens/${scenario.name}.json`,
        );
      } else if (!bytesEqual(golden, nodeDecoded.bytes)) {
        const difference = describeDifference(golden, nodeDecoded.bytes);
        const path = await writeActualBundle(pack, scenario.name, nodeDecoded.bytes);
        const text =
          difference === "golden-not-canonical"
            ? "the golden is not canonical bundle bytes, so every bundle field differs"
            : `differing bundle fields: ${difference.fields.join(", ") || "(none)"}; first differences: ${difference.paths.join(", ")}`;
        add(
          CHECKS.golden,
          `${label}: golden mismatch: ${text}; the actual bundle (hash ${nodeHash}) was written to ${path}`,
        );
      } else {
        await removeActualBundle(pack, scenario.name);
      }
    }

    for (const problem of reportListProblems(pack.name, reports)) problems.push(problem);

    const ruleIds = new Set(await packRuleIds(pack));
    const emitted = new Set<string>();
    for (const item of evidence)
      for (const run of item.bundle.runs as Rec[])
        for (const intent of (run.rules?.intents ?? []) as Rec[])
          emitted.add(String(intent.ruleId));
    if (![...ruleIds].some((id) => emitted.has(id)))
      add(CHECKS.ruleIntents, "no rule of the pack emits an intent in any committed scenario");
  } finally {
    await ledger.disposeAll();
  }
  throwIfProblems(problems);
  return { evidence, reports };
}
