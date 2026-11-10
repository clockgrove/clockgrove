import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import type { RunParity } from "./journal-parity.js";

// The journal parity long runs (pnpm test:long-run) and their evidence. The runs are split across
// test files so they run in parallel, each file with its own disposable PostgreSQL cluster. This
// module is also the long-run config's global setup: in Qualification (CLOCKGROVE_WAVE2_EVIDENCE
// names a directory) each file leaves its finished runs in a parts directory, and the teardown
// writes them, in the order of the lists below, to journal-long-runs.json there, for qualify:wave2.

export const SCENARIOS = [
  ["fixture", "neutral-conformance"],
  ["fixture/reference", "birth-and-parentage"],
  ["fixture/reference", "boundary-walk"],
  ["fixture/reference", "cedar-growth"],
  ["fixture/reference", "death-and-successor"],
  ["fixture/reference", "differential-perception"],
  ["fixture/reference", "favorite-snack-house"],
  ["fixture/reference", "fence-gap-portal"],
  ["fixture/reference", "food-decay-and-conservation"],
  ["fixture/reference", "months-fast-forward"],
  ["fixture/reference", "rain-shelter-comfort"],
  ["fixture/reference", "social-learning"],
  ["fixture/reference", "street-dwell"],
  ["fixture/reference", "walk-crossings"],
  ["fixture/reference", "walk-out-of-den"],
] as const;

/**
 * Committed scenarios the long runs leave out, as "pack/scenario" with the reason. A scenario under
 * worlds/<pack>/scenarios/ must be in SCENARIOS or here; journal-parity.postgres.test.ts checks it.
 */
export const SCENARIO_EXCLUSIONS: Readonly<Record<string, string>> = {};

export const LONG_RUNS = [
  ["fixture", "long-run-30-days"],
  ["fixture/reference", "long-run-30-days"],
  ["fixture/reference", "long-run-one-year"],
] as const;

export type FinishedRun = { set: "scenarios" | "long-runs"; run: RunParity };

declare module "vitest" {
  export interface ProvidedContext {
    /** The directory each long-run file writes its finished runs to; null outside Qualification. */
    journalLongRunParts: string | null;
  }
}

/** A run's position in the evidence: scenarios before long runs, each in its list's order. */
function position({ set, run }: FinishedRun): number {
  const list: readonly (readonly [string, string])[] = set === "scenarios" ? SCENARIOS : LONG_RUNS;
  const index = list.findIndex(
    ([pack, scenario]) => pack === run.pack && scenario === run.scenario,
  );
  return (set === "scenarios" ? 0 : SCENARIOS.length + 1) + (index < 0 ? list.length : index);
}

async function writeEvidence(directory: string, parts: string): Promise<void> {
  const finished: FinishedRun[] = [];
  for (const name of (await readdir(parts)).sort())
    finished.push(...(JSON.parse(await readFile(path.join(parts, name), "utf8")) as FinishedRun[]));
  // A stable sort keeps each scenario's runs in the order the scenario ran them.
  finished.sort((left, right) => position(left) - position(right));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  const evidence = {
    kind: "clockgrove.wave2-journal-long-runs",
    version: 1,
    candidate: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") },
    host: {
      cpus: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    runs: finished.map(({ set, run }) => ({
      set,
      ...run,
      checks: run.checks.map(({ id, passed }) => ({ id, passed })),
    })),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "journal-long-runs.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

/** Global setup: provides the parts directory; the teardown writes the evidence from every part. */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const directory = process.env.CLOCKGROVE_WAVE2_EVIDENCE;
  if (!directory) {
    project.provide("journalLongRunParts", null);
    return;
  }
  const parts = await mkdtemp(path.join(os.tmpdir(), "clockgrove-journal-long-runs-"));
  project.provide("journalLongRunParts", parts);
  return async () => {
    try {
      await writeEvidence(directory, parts);
    } finally {
      await rm(parts, { recursive: true, force: true });
    }
  };
}
