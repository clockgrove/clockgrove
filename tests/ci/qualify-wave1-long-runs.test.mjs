// Per-PR proof of the Wave 1 long-run qualifier on short horizons: the same documents, cut to hours
// and days, run on Node and workerd through the qualifier, and each invariant check refuses a bundle
// that breaks it. The 30-day and one-year runs themselves belong to the qualification workflow.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPackDirectory } from "../../packages/simulator/cli/pack-source.ts";
import { runInNode } from "../../packages/simulator/cli/runtime.ts";
import { fromBase64, toWireRequest } from "../../packages/simulator/cli/wire.ts";
import { decodeCanonicalBytes } from "../../packages/simulator/src/canonical-decode.ts";
import { checkLongRunBundle } from "../../scripts/ci/qualify-wave1-long-run-checks.mjs";
import {
  qualifyLongRuns,
  WAVE1_LONG_RUN_BUDGETS,
} from "../../scripts/ci/qualify-wave1-long-runs.mjs";

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
  // Wall time on a shared runner is not deterministic: fixture-hall's 72-hour cut sometimes passed its
  // declared 12.8 s Node budget under load (issue 275). Its budgets are made generous here, so only
  // test-world's cut-down workerd budget decides a verdict. test-world's Node run keeps its declared budget.
  const roomy = { durationMs: 600_000, peakMemoryBytes: 8 * 2 ** 30 };
  result = await qualifyLongRuns({
    directory: path.join(directory, "evidence"),
    plan,
    budgets: {
      "clockgrove.fixture-hall long-run-30-days node": roomy,
      "clockgrove.fixture-hall long-run-30-days workers": roomy,
      "clockgrove.test-world long-run-30-days workers": tiny,
    },
    concurrency: 4,
    log: () => {},
  });
  const residents = result.runs.find((run) => run.pack === "clockgrove.fixture-hall@1.3.0");
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
    ["clockgrove.fixture-hall@1.3.0", String(72n * HOUR)],
    ["clockgrove.test-world@1.1.0", String(HOUR)],
  ]);
  for (const run of result.runs) {
    expect(run.checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(run.runtimes.node.bundle.digest).toBe(run.runtimes.workers.bundle.digest);
  }
  // The cut documents keep their names, so the declared 30-day budgets apply (test-world's Node run),
  // except fixture-hall's (made generous above) and test-world's workerd budget, cut to 1 ms and
  // 1 byte: exceeding it alone fails that run and the result.
  const verdicts = result.runs.map(({ status, runtimes }) => {
    return [status, runtimes.node.budget.status, runtimes.workers.budget.status];
  });
  expect(verdicts).toEqual([
    ["passed", "within", "within"],
    ["failed", "within", "exceeded"],
  ]);
  expect([result.runs[1].runtimes.node.budget.durationMs, result.status]).toEqual([
    WAVE1_LONG_RUN_BUDGETS["clockgrove.test-world long-run-30-days node"].durationMs,
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
    "no-negative-or-conjured-resources",
    (_bundle, run) => (run.eventCounts["resource.appeared"] = 1),
  ],
  [
    "no-negative-or-conjured-resources",
    (_bundle, run) => (resourceObject(run).resource.quantity += 1),
  ],
  ["no-negative-or-conjured-resources", (_bundle, run) => delete run.summary.resources],
  [
    "no-orphans-or-containment-cycles",
    (_bundle, run) => (run.finalState.entities[0].locationId = "missing"),
  ],
  [
    "no-duplicate-births-deaths-schedules",
    (_bundle, run) => (run.summary.scheduleDuplicateIds = 1),
  ],
  ["event-volume-bounded", (_bundle, run) => (run.eventCounts["routine.selected"] += 1)],
  ["event-volume-bounded", (_bundle, run) => (run.eventCounts["movement.region-remained"] = 1)],
  ["event-volume-bounded", (_bundle, run) => (run.eventCounts["needs.changed"] *= 50)],
  ["scheduler-queue-bounded", (_bundle, run) => (run.summary.schedulePeak = 1000)],
  ["deterministic-summaries", (_bundle, run) => (run.replay.matches = false)],
  ["decision-references-resolve", (_bundle, run) => (run.summary.undispatchedDecisions = 1)],
  [
    "dead-actors-inactive",
    (_bundle, run) =>
      actor(run).events.push({ type: "lifecycle.died", count: 1, first: 0n, last: 0n }),
  ],
  [
    "dead-actors-inactive",
    // Dies after its last autonomous action, so only the later pack verb it causes breaks the rule.
    (_bundle, run) => {
      const { objectId, events } = actor(run);
      const end = events.reduce((last, event) => (event.last > last ? event.last : last), 0n);
      events.push({ type: "lifecycle.died", count: 1, first: end, last: end });
      const verb = { type: "pack.verb-used", count: 1, first: end + 1n, last: end + 1n };
      run.summary.causes.push({ actorId: objectId, events: [verb] });
    },
  ],
  // Autonomous events the engine attributes to the scenario or a process, about the actor after its
  // death: each is the actor acting, not something happening to its body.
  ...["needs.relieved", "lifecycle.conceived", "movement.completed", "location.changed"].map(
    (type) => [
      "dead-actors-inactive",
      (_bundle, run) => {
        const { events } = actor(run);
        const end = events.reduce((last, event) => (event.last > last ? event.last : last), 0n);
        events.push({ type: "lifecycle.died", count: 1, first: end, last: end });
        events.push({ type, count: 1, first: end + 1n, last: end + 1n });
      },
    ],
  ),
  ["declared-equivalence", (copy) => (copy.equivalences[0].equivalent = false)],
  ["scenario-assertions", (copy) => (copy.assertions[0].passed = false)],
])("%s refuses a bundle that breaks it", (id, mutate) => {
  expect(failing(() => {})).toEqual([]);
  expect(failing(mutate)).toContain(id);
});

/** Moves the first lifecycle entry out of the counted state into the lineage, dead (#358). */
const moveToLineage = (run, { keepEntity = false } = {}) => {
  const state = run.finalState;
  const entry = state.lifecycle.entries[0];
  const subject = run.summary.subjects.find((item) => item.objectId === entry.objectId);
  const end = subject.events.reduce((last, event) => (event.last > last ? event.last : last), 0n);
  subject.events.push({ type: "lifecycle.died", count: 1, first: end, last: end });
  const entity = state.entities.find((item) => item.objectId === entry.objectId);
  state.lifecycle.entries = state.lifecycle.entries.slice(1);
  // The dead have nothing queued.
  run.schedule.remaining = run.schedule.remaining.filter(
    (item) => item.payload?.objectId !== entry.objectId,
  );
  state.lifecycle.lineage = [
    { ...entry, death: { diedAt: end, cause: "age" }, archetypeId: entity.archetypeId },
  ];
  if (keepEntity) return;
  state.entities = state.entities.filter((item) => item.objectId !== entry.objectId);
  state.wellbeing.entries = state.wellbeing.entries.filter(
    (item) => item.objectId !== entry.objectId,
  );
};

it("reads the dead a birth moved to lifecycle.lineage as lives, not missing objects", () => {
  expect(failing((_bundle, run) => moveToLineage(run))).toEqual([]);
  expect(failing((_bundle, run) => moveToLineage(run, { keepEntity: true }))).toEqual([
    "no-orphans-or-containment-cycles",
  ]);
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

it("dead-actors-inactive refuses an event the engine attributes to an actor after its death", async () => {
  // fixture-hall's companion (born at 432_000_000, lifespan 10_800_000_000) dies of old age at
  // 11_232_000_000 and holds fixture.influence in the committed pack. A day after its death the
  // scenario speaks through it (a `via` command step): the engine attributes the transfer to the
  // companion (`summary.causes`), and the check refuses exactly that event.
  const files = await readPackDirectory(path.join(root, "worlds/fixture/reference"));
  const document = JSON.parse(
    await readFile(
      path.join(root, "worlds/fixture/reference/long-runs/long-run-30-days.json"),
      "utf8",
    ),
  );
  const at = { $bigint: String(11_232_000_000n + 24n * HOUR) };
  document.steps = [
    { ...document.steps[0], to: at, stepMs: { $bigint: String(24n * HOUR) } },
    {
      key: "dead-companion-transfers",
      kind: "command",
      type: "resource.transfer",
      version: 1,
      payload: {
        fromObjectId: "fixture.water-bowl",
        toObjectId: "fixture.household-water",
        kind: "water",
        quantity: 1,
      },
      via: { actor: "fixture.companion", capability: "fixture.influence@1" },
    },
  ];
  document.variants[0].steps[0].to = at;
  const run = await runInNode(
    toWireRequest({
      manifestBytes: files.manifest,
      resourceBytes: files.resources,
      scenarioBytes: new TextEncoder().encode(JSON.stringify(document)),
    }),
  );
  expect(run.response.ok).toBe(true);
  const dead = decodeCanonicalBytes(fromBase64(run.response.bundle)).value;
  const check = checkLongRunBundle(dead, { maxPopulation: 6 }).find(
    ({ id }) => id === "dead-actors-inactive",
  );
  expect([check.status, check.problems]).toEqual([
    "failed",
    ["main: fixture.companion caused resource.transferred after its death"],
  ]);
}, 60_000);
