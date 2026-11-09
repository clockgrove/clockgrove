// Per-PR proof of the Wave 1 long-run qualifier on short horizons: the same documents, cut to hours
// and days, run on Node and workerd through the qualifier, and each invariant check refuses a bundle
// that breaks it. The 30-day and one-year runs themselves belong to the qualification workflow.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decodeCanonicalBytes } from "../../packages/simulator/src/canonical-decode.ts";
import { checkLongRunBundle } from "../../scripts/ci/qualify-wave1-long-run-checks.mjs";
import { qualifyLongRuns } from "../../scripts/ci/qualify-wave1-long-runs.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const HOUR = 3_600_000n;
let directory;
let result;
let bundle;

/** A committed long-run document cut to `hours` after the pack epoch, written to the temp dir. */
async function shortRun(pack, epoch, hours, stepMs) {
  const file = path.join(root, "worlds", pack, "long-runs/long-run-30-days.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  const to = { $bigint: String(epoch + BigInt(hours) * HOUR) };
  document.steps[0] = { ...document.steps[0], to, stepMs: { $bigint: String(stepMs) } };
  document.variants[0].steps[0].to = to;
  const scenarioFile = path.join(directory, `${pack.replaceAll("/", "-")}-${hours}.json`);
  await writeFile(scenarioFile, JSON.stringify(document));
  return {
    packDirectory: path.join(root, "worlds", pack),
    scenarioFile,
    horizonMs: BigInt(hours) * HOUR,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave1-long-runs-test-"));
  const plan = [
    await shortRun("fixture/reference", 8_640_000_000n, 72, 24n * HOUR),
    await shortRun("fixture", 100_000n, 1, 600_000n),
  ];
  const tiny = { durationMs: 1, peakMemoryBytes: 1 };
  result = await qualifyLongRuns({
    directory: path.join(directory, "evidence"),
    plan,
    budgets: { "clockgrove.test-world long-run-30-days workers": tiny },
    concurrency: 4,
    log: () => {},
  });
  const residents = result.runs.find((run) => run.pack === "clockgrove.fixture-hall@1.1.0");
  const bytes = await readFile(
    path.join(directory, "evidence", residents.runtimes.node.bundle.path),
  );
  bundle = decodeCanonicalBytes(new Uint8Array(bytes)).value;
}, 120_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("short horizons pass every observable check with identical Node and workerd bundles", async () => {
  expect(result.runs.map((run) => [run.pack, run.horizonMs])).toEqual([
    ["clockgrove.fixture-hall@1.1.0", String(72n * HOUR)],
    ["clockgrove.test-world@1.1.0", String(HOUR)],
  ]);
  for (const run of result.runs) {
    expect(run.checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(run.runtimes.node.bundle.digest).toBe(run.runtimes.workers.bundle.digest);
  }
  // The cut documents keep their names, so the declared 30-day budgets apply, except test-world's
  // workerd budget, cut to 1 ms and 1 byte: exceeding it alone fails that run and the result.
  const verdicts = result.runs.map(({ status, runtimes }) => {
    return [status, runtimes.node.budget.status, runtimes.workers.budget.status];
  });
  expect(verdicts).toEqual([
    ["passed", "within", "within"],
    ["failed", "within", "exceeded"],
  ]);
  expect([result.runs[0].runtimes.node.budget.durationMs, result.status]).toEqual([
    12_800,
    "failed",
  ]);
}, 30_000);

const failing = (mutate) => {
  const copy = structuredClone(bundle);
  mutate(copy, copy.runs[0]);
  return checkLongRunBundle(copy, { maxPopulation: 4 })
    .filter((check) => check.status === "failed")
    .map((check) => check.id);
};
const resourceObject = (run) => run.finalState.entities.find((entity) => entity.resource);
const actor = (run) =>
  run.summary.subjects.find((subject) => subject.events.some((e) => e.type === "routine.selected"));

it.each([
  [
    "no-negative-or-conjured-resources",
    (_bundle, run) => (resourceObject(run).resource.quantity = -1),
  ],
  [
    "no-orphans-or-containment-cycles",
    (_bundle, run) => (run.finalState.entities[0].locationId = "missing"),
  ],
  [
    "no-duplicate-births-deaths-schedules",
    (_bundle, run) => (run.summary.scheduleDuplicateIds = 1),
  ],
  ["event-volume-bounded", (_bundle, run) => (run.events.count *= 3)],
  ["scheduler-queue-bounded", (_bundle, run) => (run.summary.schedulePeak = 1000)],
  ["deterministic-summaries", (_bundle, run) => (run.replay.matches = false)],
  ["decision-references-resolve", (_bundle, run) => (run.summary.undispatchedDecisions = 1)],
  [
    "dead-actors-inactive",
    (_bundle, run) =>
      actor(run).events.push({ type: "lifecycle.died", count: 1, first: 0n, last: 0n }),
  ],
  ["declared-equivalence", (copy) => (copy.equivalences[0].equivalent = false)],
  ["scenario-assertions", (copy) => (copy.assertions[0].passed = false)],
])("%s refuses a bundle that breaks it", (id, mutate) => {
  expect(failing(() => {})).toEqual([]);
  expect(failing(mutate)).toContain(id);
});

it("never passes the perception check it cannot observe, and refuses full recordings", () => {
  const checks = checkLongRunBundle(bundle, { maxPopulation: 4 });
  expect(checks.find((check) => check.id === "no-private-perception-in-public-view").status).toBe(
    "not-observable",
  );
  const full = structuredClone(bundle);
  full.runs[0].recording = "full";
  expect(
    new Set(checkLongRunBundle(full, { maxPopulation: 4 }).map((check) => check.status)),
  ).toEqual(new Set(["failed"]));
});
