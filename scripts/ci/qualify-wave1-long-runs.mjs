#!/usr/bin/env node
// Wave 1 long-run qualification (plan §9.3, §10, §13): the 30-day and one-year scenarios of
// fixture-hall@1 and test-world@1, each on Node and on workerd with summarised recording.
// Usage: pnpm run qualify:wave1:long-runs [<evidence-dir>] [--concurrency <n>]
// It checks the long-run invariants and the declared small-step versus aggregate equivalence,
// requires byte-identical Node and workerd bundles and records each run's wall time and peak
// memory per runtime in wave1-long-runs.json, outside the compared bundles, beside the declared
// budget they must stay within. Exit 0 only if all pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { checkLongRunBundle, summaryHashes } from "./qualify-wave1-long-run-checks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const child = path.join(root, "scripts/ci/qualify-wave1-long-run-child.mjs");
export const RESULT_FILE = "wave1-long-runs.json";
export const RUNTIMES = ["node", "workers"];
export const DAY_MS = 86_400_000n;
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const longRun = (pack, scenario, days) => ({
  packDirectory: path.join(root, "worlds", pack),
  scenarioFile: path.join(root, "worlds", pack, "long-runs", `${scenario}.json`),
  horizonMs: BigInt(days) * DAY_MS,
});
/** Longest first, so the one-year test-world runs start together and bound the wall time. */
export const WAVE1_LONG_RUNS = [
  longRun("fixture", "long-run-one-year", 365),
  longRun("fixture/reference", "long-run-one-year", 365),
  longRun("fixture", "long-run-30-days", 30),
  longRun("fixture/reference", "long-run-30-days", 30),
];

export const BUDGET_SOURCE =
  "2x the run's maximum in Qualification run 39604752325 on b58578a (2026-10-27), except test-world one-year workerd peak memory: 6534 MiB, 2x the highest peak, 3267 MiB in Qualification run 39525850979, across seven Qualification runs (3267, 2549, 2991, 1871, 1667, 1301 and 1657 MiB) (2026-10-27)";
/**
 * Wall-time and peak-memory budget of each long run per runtime (plan §9.1 Performance), keyed by
 * pack id, not version, so a pack version bump keeps them. Source: BUDGET_SOURCE.
 */
const BUDGET_TABLE = [
  // pack id, scenario, runtime, wall time (s), peak memory (MiB)
  ["clockgrove.fixture-hall", "long-run-30-days", "node", 12.8, 448],
  ["clockgrove.fixture-hall", "long-run-30-days", "workers", 11.4, 320],
  ["clockgrove.fixture-hall", "long-run-one-year", "node", 134.4, 760],
  ["clockgrove.fixture-hall", "long-run-one-year", "workers", 127.2, 524],
  ["clockgrove.test-world", "long-run-30-days", "node", 73.6, 912],
  ["clockgrove.test-world", "long-run-30-days", "workers", 73.2, 1126],
  ["clockgrove.test-world", "long-run-one-year", "node", 851.2, 934],
  // Peak memory is BUDGET_SOURCE's exception: 2x the highest peak across seven Qualification runs.
  ["clockgrove.test-world", "long-run-one-year", "workers", 849.6, 6534],
];
export const WAVE1_LONG_RUN_BUDGETS = Object.fromEntries(
  BUDGET_TABLE.map(([pack, scenario, runtime, seconds, mebibytes]) => [
    `${pack} ${scenario} ${runtime}`,
    { durationMs: Math.round(seconds * 1000), peakMemoryBytes: mebibytes * 2 ** 20 },
  ]),
);

/**
 * The budget beside the measured counters. A counter above its budget, or one that was not
 * measured, fails the run: a budget is never met by a missing measurement.
 */
export function longRunBudget(budget, observation) {
  if (!budget) return { status: "exceeded", problems: ["no declared budget"] };
  const problems = [];
  for (const [counter, limit] of Object.entries(budget)) {
    const measured = observation[counter];
    if (!Number.isFinite(measured)) problems.push(`${counter} not measured`);
    else if (measured > limit) problems.push(`${counter} ${measured} above ${limit}`);
  }
  return { ...budget, status: problems.length ? "exceeded" : "within", problems };
}

/** SDK resource JSON with `{"$bigint":"n"}` values revived. */
const resource = async (file) =>
  JSON.parse(await readFile(file, "utf8"), (_key, value) =>
    value && typeof value === "object" && Object.keys(value).join() === "$bigint"
      ? BigInt(value.$bigint)
      : value,
  );

/** The pack identity, clock epoch and lifecycle population bound, and the checked document. */
async function describe(item) {
  const manifest = await resource(path.join(item.packDirectory, "manifest.json"));
  const policies = await Promise.all(
    manifest.policies.map((entry) =>
      resource(path.join(item.packDirectory, "resources", entry.path)),
    ),
  );
  const clock = policies.find((policy) => policy.type === "clockgrove.clock-policy");
  const behavior = policies.find((policy) => policy.type === "clockgrove.world-behavior-policy");
  const documentBytes = await readFile(item.scenarioFile);
  const document = await resource(item.scenarioFile);
  const pack = `${manifest.id}@${manifest.version}`;
  assert.equal(`${document.pack.id}@${document.pack.version}`, pack, "scenario pack mismatch");
  assert.equal(document.recording, "summarised", `${document.name} must record summarised`);
  const end = document.steps.findLast((step) => step.kind === "advance")?.to;
  assert.equal(end - clock.epoch, item.horizonMs, `${document.name} horizon mismatch`);
  return {
    packId: manifest.id,
    pack,
    scenario: document.name,
    horizonMs: item.horizonMs,
    horizonDays: Number(item.horizonMs) / Number(DAY_MS),
    document: { path: path.relative(root, item.scenarioFile), digest: digest(documentBytes) },
    equivalences: document.equivalences,
    maxPopulation: behavior?.policy?.lifecycle?.reproduction?.maxPopulation ?? null,
  };
}

async function runChild(item, runtime, bundleFile, timeoutMs) {
  const started = performance.now();
  const result = await ownedSubprocess(
    process.execPath,
    ["--no-warnings", child, item.packDirectory, item.scenarioFile, runtime, bundleFile],
    { cwd: root, timeoutMs, killGraceMs: 10_000 },
  );
  const processWallMs = Math.round(performance.now() - started);
  let report = null;
  try {
    report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    // No report: the child failed before it could write one.
  }
  const passed = result.status === 0 && !result.error && report?.ok === true;
  return {
    status: passed ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal ?? null,
    refusal: report?.refusal ?? null,
    observation: report ? { ...report.observation, processWallMs } : { processWallMs },
    stderr: passed ? undefined : result.stderr.slice(-4000),
  };
}

/** Runs `tasks` with at most `limit` in flight, keeping their order in the results. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function candidate() {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
}

/**
 * Runs `plan` (default: the four Wave 1 long runs) in every runtime, checks each against its
 * budget (`budgets` overrides WAVE1_LONG_RUN_BUDGETS entries, for tests) and writes
 * `<directory>/wave1-long-runs.json` and the bundles. Returns the result document.
 */
export async function qualifyLongRuns({
  directory,
  plan = WAVE1_LONG_RUNS,
  runtimes = RUNTIMES,
  budgets = {},
  concurrency = 2,
  timeoutMs = 120 * 60_000,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  await mkdir(path.join(directory, "bundles"), { recursive: true });
  await access(path.join(directory, RESULT_FILE)).then(
    () => {
      throw new Error(
        "refuse overwriting prior long-run evidence; use a separately owned directory",
      );
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const { decodeCanonicalBytes } = await import("../../packages/simulator/src/canonical-decode.ts");
  // Read before the runs start, so a later checkout change cannot relabel them.
  const runCandidate = candidate();
  const startedAt = new Date().toISOString();
  const described = await Promise.all(plan.map(describe));
  const name = (item) =>
    `${path.basename(item.packDirectory)}-${path.basename(item.scenarioFile, ".json")}`;
  const tasks = plan.flatMap((item, index) =>
    runtimes.map((runtime) => async () => {
      const bundle = `bundles/${name(item)}.${runtime}.bin`;
      log(`start ${described[index].pack} ${described[index].scenario} on ${runtime}`);
      const outcome = await runChild(item, runtime, path.join(directory, bundle), timeoutMs);
      const { packId, scenario } = described[index];
      const key = `${packId} ${scenario} ${runtime}`;
      outcome.budget = longRunBudget(
        budgets[key] ?? WAVE1_LONG_RUN_BUDGETS[key],
        outcome.observation,
      );
      const seconds = (ms) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
      const mebibytes = (bytes) => (bytes ? `${Math.round(bytes / 2 ** 20)} MiB` : "unmeasured");
      const { durationMs, peakMemoryBytes } = outcome.observation;
      log(
        `${outcome.status} ${described[index].pack} ${scenario} on ${runtime}: ${seconds(durationMs)}, peak ${mebibytes(peakMemoryBytes)}; budget ${seconds(outcome.budget.durationMs)}, ${mebibytes(outcome.budget.peakMemoryBytes)}: ${outcome.budget.status}`,
      );
      return { index, runtime, bundle, outcome };
    }),
  );
  const finished = await pool(tasks, concurrency);

  const runs = [];
  for (const [index, description] of described.entries()) {
    const { equivalences, packId: _packId, ...facts } = description;
    const { maxPopulation } = facts;
    const perRuntime = {};
    const bytes = {};
    for (const { runtime, bundle, outcome } of finished.filter((task) => task.index === index)) {
      if (outcome.status === "passed") {
        bytes[runtime] = await readFile(path.join(directory, bundle));
        outcome.bundle = { path: bundle, digest: digest(bytes[runtime]) };
      }
      perRuntime[runtime] = outcome;
    }
    const produced = runtimes.filter((runtime) => bytes[runtime]);
    const identical =
      produced.length === runtimes.length &&
      produced.every((runtime) => Buffer.compare(bytes[runtime], bytes[runtimes[0]]) === 0);
    let checks = [];
    let hashes = null;
    let counts = null;
    if (produced.length) {
      const decoded = decodeCanonicalBytes(new Uint8Array(bytes[produced[0]]));
      assert(decoded.ok, "a scenario bundle is not canonical bytes");
      const bundle = decoded.value;
      for (const runtime of produced) perRuntime[runtime].bundle.bundleHash = bundle.bundleHash;
      checks = checkLongRunBundle(bundle, { maxPopulation });
      hashes = summaryHashes(bundle);
      counts = Object.fromEntries(
        bundle.runs.map((run) => [
          run.name,
          {
            events: run.events.count,
            kernelCalls: run.commands.reduce(
              (sum, command) => sum + (command.outcome.calls ?? 0),
              0,
            ),
            advanceChunks: run.commands.filter((command) => command.role === "advance").length,
            schedulePeak: run.summary.schedulePeak,
            eventCounts: run.eventCounts,
          },
        ]),
      );
    }
    const withinBudgets = Object.values(perRuntime).every(
      (outcome) => outcome.budget.status === "within",
    );
    const status =
      identical &&
      withinBudgets &&
      checks.length &&
      checks.every((check) => check.status !== "failed")
        ? "passed"
        : "failed";
    runs.push({
      ...facts,
      horizonMs: facts.horizonMs.toString(),
      equivalence: equivalences,
      status,
      identical,
      withinBudgets,
      runtimes: perRuntime,
      checks,
      summaryHashes: hashes,
      counts,
    });
  }

  const result = {
    kind: "clockgrove.wave1-long-runs",
    version: 1,
    candidate: runCandidate,
    execution: {
      provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      concurrency,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    status: runs.every((run) => run.status === "passed") ? "passed" : "failed",
    budgetSource: BUDGET_SOURCE,
    runs,
  };
  await writeFile(path.join(directory, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function parseArguments(argv) {
  const options = { directory: null, concurrency: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    // pnpm 12 forwards a literal `--` separator to the script.
    if (argv[index] === "--") continue;
    if (argv[index] === "--concurrency") {
      options.concurrency = Number(argv[++index]);
      assert(
        Number.isSafeInteger(options.concurrency) && options.concurrency > 0,
        "bad concurrency",
      );
    } else if (options.directory === null && !argv[index].startsWith("--"))
      options.directory = path.resolve(argv[index]);
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("../../packages/simulator/cli/typescript-hooks.mjs");
  const options = parseArguments(process.argv.slice(2));
  const directory =
    options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave1-long-runs-")));
  const result = await qualifyLongRuns({ directory, concurrency: options.concurrency });
  for (const run of result.runs) {
    const failed = run.checks.filter((check) => check.status === "failed");
    process.stdout.write(
      `${run.status} ${run.pack} ${run.scenario}: identical=${run.identical} withinBudgets=${run.withinBudgets}${failed.length ? ` failed=${failed.map((check) => check.id).join(",")}` : ""}\n`,
    );
    for (const [runtime, { budget }] of Object.entries(run.runtimes))
      if (budget.status !== "within")
        process.stdout.write(`  ${runtime} over budget: ${budget.problems.join("; ")}\n`);
  }
  process.stdout.write(`Wave 1 long-run evidence: ${path.join(directory, RESULT_FILE)}\n`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}
