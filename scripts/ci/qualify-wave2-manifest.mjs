// The Wave 2 evidence manifest (plan §19): built from one Qualification run's receipts and the
// journal long-run results, and validated by recomputing every disposition from those facts. An
// item whose proof needs judgement names its review and stays `review`; scope the maintainer moved to a later
// wave is `deferred` with its issue; an item whose test:db case is absent is `missing`. The manifest
// never claims more than its receipts show.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./evidence.mjs";
import { RECEIPTS, receipt } from "./qualify-wave1-manifest.mjs";
import { worldPackDirectories } from "./world-packs.mjs";

export { RECEIPTS };
export const MANIFEST_FILE = "wave2-evidence-manifest.json";
export const PLAN = "docs/waves/clockgrove-wave-2-journal-replay-implementation-plan.md";
// The Wave 2 evidence directory: written only in Qualification, which names it in
// CLOCKGROVE_WAVE2_EVIDENCE, outside CI_EVIDENCE_DIR, so the Wave 0 evidence manifest is unchanged.
/** Written by the journal parity long runs (apps/runtime/test/journal-long-runs.ts). */
export const JOURNAL_RESULT = "journal-long-runs.json";
/** Written by scripts/database/test.mjs (vitest JSON reporter). */
export const TEST_DB_REPORT = "test-db.vitest.json";
/** The long runs the journal parity runs, each as its `main` and `aggregate` plans. */
export const JOURNAL_LONG_RUNS = [
  "fixture/long-run-30-days",
  "fixture/reference/long-run-30-days",
  "fixture/reference/long-run-one-year",
];
/** Checks every journal run must report passed: parity, replay (item 9) and the bundle (item 12). */
export const REQUIRED_CHECKS = [
  "steps",
  "state-hash",
  "event-stream",
  "replay",
  "snapshot-replay",
  "checkpoints",
  "bundle",
];
/** The test:db suites that inject crash windows (plan §14). */
export const FAULT_SUITES = [
  "scripts/database/test.mjs",
  "apps/runtime/test/world-command.postgres.test.ts",
  "apps/runtime/test/world-provisioning.postgres.test.ts",
  "apps/runtime/test/world-readiness.postgres.test.ts",
  "apps/runtime/test/due-work.postgres.test.ts",
  "apps/runtime/test/dispatch-delivery.postgres.test.ts",
  "apps/runtime/test/artifact-store.postgres.test.ts",
  "apps/runtime/test/partition-snapshot.postgres.test.ts",
];
/** The RLS attack suite, its fixtures and the pooled-connection isolation suite, all in test:db. */
export const RLS_SUITES = [
  "tests/database/authorization.sql",
  "tests/database/seed.sql",
  "tests/database/journal-fixture.sql",
  "tests/database/hostile-fixture.sql",
  "apps/runtime/test/journal-isolation.postgres.test.ts",
];
/** RW-0209's prior-release fixture cases in test:db, by their full vitest names. */
export const PRIOR_RELEASE = {
  suite: "apps/runtime/test/prior-release-fixtures.postgres.test.ts",
  /** Every prior fixture migrates to head, replays to its recorded hash and regains a snapshot. */
  migration:
    "prior-release database fixtures migrate to head keeping every row and event byte, and replay to the recorded hashes",
  /** A stored historic kernel event version replays through its upcaster. */
  upcaster:
    "prior-release database fixtures replays a stored historic kernel event version through its upcaster and refuses an unsupported one",
};
const REVIEW = "independent review of the exact candidate";

/** Scope the maintainer's decisions place outside Wave 2, with the issue that owns it. */
export const DEFERRED = {
  deployable: {
    scope: "main remains deployable: the hosted staging path",
    owner: "Wave 3 entry; Waves 1 and 2 run under the readiness exception",
    issues: [415, 693],
  },
  effectIntents: {
    scope: "the effect_intents table; Wave 2 proves the preview gate and dispatch-intent atomicity",
    owner: "Wave 5, the first external-effect producer (issue 654 D3)",
    issues: [654],
  },
  timelines: {
    scope:
      "timeline/fork foundation, experimental re-execution and canonical rebuild by re-execution (plan §9.3, §9.4, §10); Wave 2 rebuild is replay verification",
    owner: "Wave 7, beside re-execution and preview branches (plan §10 amendment; issue 677)",
    issues: [677],
  },
};

/** The literal §19 checklist items of the Wave 2 plan. */
export async function literalChecklist(root) {
  const plan = await readFile(path.join(root, PLAN), "utf8");
  return plan
    .split("## 19. Exit evidence checklist\n")[1]
    .split("\n---")[0]
    .match(/^- \[ \] (.+)$/gmu)
    .map((line) => line.slice(6));
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const files = async (root, list) =>
  Promise.all(
    list.map(async (file) => ({
      path: file,
      digest: digest(await readFile(path.join(root, file))),
    })),
  );

/** Every committed golden: file digest, bundle hash and each run's final state hash. */
async function scenarios(root, decode) {
  const found = [];
  for (const pack of await worldPackDirectories(root)) {
    const directory = path.join("worlds", pack, "goldens");
    const names = await readdir(path.join(root, directory)).catch(() => []);
    for (const name of names
      .filter((file) => file.endsWith(".json") && !file.endsWith(".actual.json"))
      .sort()) {
      const bytes = await readFile(path.join(root, directory, name));
      const bundle = decode(bytes);
      found.push({
        pack,
        scenario: name.slice(0, -".json".length),
        path: `${directory}/${name}`,
        digest: digest(bytes),
        bundleHash: bundle.bundleHash,
        runs: bundle.runs.map((run) => ({
          run: String(run.name),
          finalStateHash: String(run.finalStateHash),
        })),
      });
    }
  }
  return found;
}

const runKey = (run) => `${run.set}:${run.pack}/${run.scenario}:${run.run}`;

/**
 * The journal long-run results: bound to the candidate, every scenario run's final hash equal to its
 * golden's, and complete only when every golden run and every declared long run is present.
 */
async function journal(directory, candidate, goldens) {
  const result = directory ? await readJson(path.join(directory, JOURNAL_RESULT)) : undefined;
  if (result === undefined) return { status: "missing", runs: [], performance: [] };
  assert.equal(result.kind, "clockgrove.wave2-journal-long-runs", "journal result kind");
  assert.equal(result.candidate.commit, candidate.commit, "journal long-run candidate mismatch");
  assert.equal(result.candidate.tree, candidate.tree, "journal long-run tree mismatch");
  const golden = new Map(
    goldens.flatMap((entry) =>
      entry.runs.map((run) => [
        `scenarios:${entry.pack}/${entry.scenario}:${run.run}`,
        run.finalStateHash,
      ]),
    ),
  );
  const required = [
    ...golden.keys(),
    ...JOURNAL_LONG_RUNS.flatMap((name) => [
      `long-runs:${name}:main`,
      `long-runs:${name}:aggregate`,
    ]),
  ].sort();
  const runs = result.runs.map((run) => {
    if (run.set === "scenarios")
      assert.equal(run.finalStateHash, golden.get(runKey(run)), `${runKey(run)} golden mismatch`);
    const checks = run.checks.map(({ id, passed }) => ({ id, passed }));
    const passed =
      run.passed &&
      checks.every((check) => check.passed) &&
      REQUIRED_CHECKS.every((id) => checks.some((check) => check.id === id));
    return {
      set: run.set,
      pack: run.pack,
      scenario: run.scenario,
      run: run.run,
      reference: run.reference,
      passed,
      finalStateHash: run.finalStateHash,
      kernelCalls: run.kernelCalls,
      events: run.events,
      snapshots: run.snapshots,
      suffixEvents: run.suffixEvents,
      checks,
    };
  });
  const covered = JSON.stringify(runs.map(runKey).sort()) === JSON.stringify(required);
  const performance = result.runs
    .filter((run) => run.set === "long-runs")
    .map((run) => ({
      pack: run.pack,
      scenario: run.scenario,
      run: run.run,
      kernelCalls: run.kernelCalls,
      kernelMs: run.kernelMs,
      journalMs: run.journalMs,
      journalLatencyMs: run.journalLatencyMs,
      replay: {
        events: run.replay.events,
        ms: run.replay.ms,
        eventsPerSecond:
          run.replay.ms > 0 ? Math.round((run.replay.events * 1000) / run.replay.ms) : null,
      },
    }));
  return {
    status: runs.some((run) => !run.passed) ? "failed" : covered ? "passed" : "incomplete",
    resultDigest: digest(await readFile(path.join(directory, JOURNAL_RESULT))),
    host: result.host,
    definitions: {
      journalLatencyMs:
        "per kernel call: the world-command journal call's wall time less its kernel time (nearest-rank percentiles)",
      replay:
        "verifyPartitionReplay in diagnostic mode on the run's database: full replay from the stored birth with every snapshot's hash checked, plus the latest snapshot and its suffix; events are kernel events folded",
    },
    runs,
    performance,
  };
}

/** test:db's per-case results for the named suites, from its vitest JSON report. */
function cases(report, suites) {
  if (report === undefined) return null;
  return report.testResults
    .map((file) => ({ file, suite: suites.find((suite) => file.name.endsWith(`/${suite}`)) }))
    .filter(({ suite }) => suite !== undefined)
    .flatMap(({ file, suite }) =>
      file.assertionResults.map((result) => ({
        suite,
        name: result.fullName,
        status: result.status,
      })),
    );
}

/** The bootstrap disposal journey's record, when it was written for this candidate. */
async function bootstrap(directory, candidate) {
  const record = directory ? await readJson(path.join(directory, "bootstrap.json")) : undefined;
  if (record === undefined) return { status: "missing" };
  assert.equal(record.commit, candidate.commit, "bootstrap record candidate mismatch");
  assert.equal(record.tree, candidate.tree, "bootstrap record tree mismatch");
  return {
    status: "passed",
    digest: digest(await readFile(path.join(directory, "bootstrap.json"))),
  };
}

const receiptStatus = (manifest, name) =>
  manifest.tests.find((item) => item.name === name)?.status ?? "missing";

/** A prior-release case is `passed` or `failed` only as reported; absent or not run is `missing`. */
function priorReleaseStatus(manifest, key) {
  const found = (manifest.priorRelease.cases ?? []).filter(
    (entry) => entry.name === PRIOR_RELEASE[key],
  );
  if (found.some((entry) => entry.status === "failed")) return "failed";
  return found.length === 1 && found[0].status === "passed" ? "passed" : "missing";
}

/** One disposition per literal item, derived only from the manifest's own facts. */
export function exitChecklist(manifest, items) {
  const receipts = (...names) => names.map((name) => `tests:${name}`);
  const statuses = (names) => names.map((name) => receiptStatus(manifest, name));
  const journalPassed = manifest.journal.status === "passed";
  const rules = [
    {
      evidence: [],
      review: `${REVIEW}: the packet Issues' merges (RW-0201 via Wave 0 issue 269 and issue 624, RW-0202 issue 627, RW-0203 issue 642, RW-0204/RW-0205 issue 649, RW-0206 issue 654, RW-0207 issue 667, RW-0208 issue 677, RW-0209 issue 694 and issue 832, RW-0210 issue 686) are on the candidate in dependency order`,
    },
    {
      evidence: [...receipts("db-verify", "test-db"), "priorRelease"],
      needs: ["db-verify", "test-db"],
      priorRelease: ["migration"],
      observed:
        "db:verify migrates an empty and a representative current-schema database and the 0001 baseline forward; test:db migrates every disposable cluster it uses and every prior-release fixture to head with no lost row or event byte",
    },
    {
      evidence: [...receipts("test-db", "db-verify"), "rls"],
      needs: ["test-db", "db-verify"],
      observed:
        "test:db runs the RLS attack suite as the runtime role (it fails naming any RLS table it does not exercise) and the pooled-connection isolation suite; db:verify checks the runtime role's grants",
    },
    {
      evidence: [...receipts("test-long-run"), "journal", "scenarios"],
      needs: ["test-long-run"],
      journal: true,
      observed:
        "Every committed scenario run through the Journal ends on its golden's final hash with the golden's kernel event stream, and each long run matches its pure run",
    },
    {
      evidence: receipts("test-db"),
      review: `${REVIEW}: which test:db cases prove the command ID/request-hash and expected-revision matrix`,
    },
    {
      evidence: [...receipts("test-db"), "faults"],
      review: `${REVIEW}: the faults cases cover plan §14's crash windows with no lost or duplicate acknowledged mutation`,
    },
    {
      evidence: receipts("test-db"),
      review: `${REVIEW}: which test:db cases prove event, projection, schedule and dispatch atomicity and the preview effect gate`,
      deferred: ["effectIntents"],
    },
    {
      evidence: [...receipts("test-db"), "faults"],
      review: `${REVIEW}: the provisioning fault points survive every crash window without duplicated seed state`,
    },
    {
      evidence: [...receipts("test-long-run"), "journal"],
      needs: ["test-long-run"],
      journal: true,
      observed:
        "Every journal run's replay from birth, its latest snapshot plus suffix and every snapshot checkpoint equal the live state hash",
    },
    {
      evidence: receipts("test-db", "test-replay"),
      review: `${REVIEW}: the corrupt snapshot, event and bundle cases fail by name`,
    },
    {
      evidence: [...receipts("test-db", "test-replay"), "priorRelease"],
      needs: ["test-db", "test-replay"],
      priorRelease: ["migration", "upcaster"],
      observed:
        "Every prior-release fixture migrated to head replays from birth and in the offline bundle to its recorded hash, regains a snapshot whose suffix replays to the live hash, and its stored historic event versions replay through their upcasters; test:replay replays the event goldens",
      deferred: ["timelines"],
    },
    {
      evidence: [...receipts("test-long-run"), "journal"],
      needs: ["test-long-run"],
      journal: true,
      observed:
        "Every journal run's exported bundle verifies with no database to the golden's (or pure run's) final hash",
    },
    {
      evidence: receipts("test-db"),
      review: `${REVIEW}: the causal inspector cases return a complete chain under authorization (issue 686 exit check)`,
    },
    {
      evidence: [...receipts("install", "qualify-wave0"), "bootstrap"],
      needs: ["install", "qualify-wave0"],
      bootstrap: true,
      observed:
        "The disposal journey bootstraps the candidate twice with one command and qualify:wave0 passes local recovery and independent builds",
      deferred: ["deployable"],
    },
  ];
  assert.equal(rules.length, items.length, "a §19 item has no disposition rule");
  return items.map((item, index) => {
    const rule = rules[index];
    let disposition;
    if (rule.review) disposition = "review";
    else {
      const needed = statuses(rule.needs);
      const prior = (rule.priorRelease ?? []).map((key) => priorReleaseStatus(manifest, key));
      const passed =
        needed.every((status) => status === "passed") &&
        prior.every((status) => status === "passed") &&
        (!rule.journal || journalPassed) &&
        (!rule.bootstrap || manifest.bootstrap.status === "passed");
      const failed =
        needed.includes("failed") ||
        prior.includes("failed") ||
        (rule.journal && manifest.journal.status === "failed");
      disposition = passed
        ? "passed"
        : failed
          ? "failed"
          : prior.includes("missing")
            ? "missing"
            : "pending";
    }
    return {
      item,
      disposition,
      evidence: rule.evidence,
      observed: disposition === "passed" ? rule.observed : null,
      review: rule.review ?? null,
      deferred: (rule.deferred ?? []).map((key) => DEFERRED[key]),
    };
  });
}

/** `qualified` needs every item passed or deferred; only open reviews make it `pending-review`. */
function exitDecision(checklist) {
  const unmet = checklist.filter((entry) => !["passed", "deferred"].includes(entry.disposition));
  return {
    status: unmet.length
      ? unmet.every((entry) => entry.disposition === "review")
        ? "pending-review"
        : "not-qualified"
      : "qualified",
    unmet: unmet.map((entry) => entry.item),
    review: checklist.filter((entry) => entry.disposition === "review").map((entry) => entry.item),
    deferred: checklist
      .filter((entry) => entry.deferred.length)
      .map((entry) => ({
        item: entry.item,
        issues: entry.deferred.flatMap((part) => part.issues),
      })),
  };
}

/**
 * `schema` is the migrated database's schema identity, measured by the caller (see qualify-wave2.mjs);
 * `decode` reads canonical golden bytes.
 */
export async function buildWave2Manifest({
  root,
  qualificationDirectory,
  wave2Directory,
  execution,
  schema,
  decode,
}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const candidate = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const migrations = (await readdir(path.join(root, "db/migrations")))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  const tests = [];
  for (const [name, command] of RECEIPTS)
    tests.push(await receipt(qualificationDirectory, name, command, candidate));
  const goldens = await scenarios(root, decode);
  const reportBytes = wave2Directory
    ? await readFile(path.join(wave2Directory, TEST_DB_REPORT)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const report = reportBytes && JSON.parse(reportBytes.toString("utf8"));
  const testDb = tests.find((item) => item.name === "test-db").status;
  const manifest = {
    kind: "clockgrove.wave2-evidence-manifest",
    // 2: the prior-release fixture cases.
    version: 2,
    candidate,
    execution,
    versions: {
      toolchain: {
        node: rootManifest.engines.node,
        pnpm: rootManifest.packageManager.replace(/^pnpm@/u, ""),
        wrangler: rootManifest.devDependencies.wrangler,
      },
      lockfileDigest: digest(await readFile(path.join(root, "pnpm-lock.yaml"))),
    },
    database: {
      migrationHead: migrations.at(-1).slice(0, -".sql".length),
      migrations: await files(
        root,
        migrations.map((name) => `db/migrations/${name}`),
      ),
      schema,
    },
    tests,
    testDbReport: report ? { digest: digest(reportBytes), success: report.success === true } : null,
    faults: {
      receipt: testDb,
      suites: await files(root, FAULT_SUITES),
      cases: cases(report, FAULT_SUITES),
    },
    rls: {
      receipt: testDb,
      suites: await files(root, RLS_SUITES),
      cases: cases(report, RLS_SUITES),
    },
    priorRelease: {
      receipt: testDb,
      suites: await files(root, [PRIOR_RELEASE.suite]),
      cases: cases(report, [PRIOR_RELEASE.suite]),
    },
    scenarios: goldens,
    journal: await journal(wave2Directory, candidate, goldens),
    bootstrap: await bootstrap(qualificationDirectory, candidate),
    deferredScope: Object.values(DEFERRED),
  };
  manifest.exitChecklist = exitChecklist(manifest, await literalChecklist(root));
  manifest.exitDecision = exitDecision(manifest.exitChecklist);
  return manifest;
}

/** Repository-owned validation: shape, candidate binding and dispositions recomputed from facts. */
export async function validateWave2Manifest(manifest, root) {
  assert.equal(manifest.kind, "clockgrove.wave2-evidence-manifest", "manifest kind");
  assert.equal(manifest.version, 2, "manifest version");
  assert.match(manifest.candidate.commit, /^[0-9a-f]{40}$/u, "candidate commit");
  assert.match(manifest.versions.lockfileDigest, DIGEST, "lockfile digest");
  assert.match(manifest.database.schema.hash, DIGEST, "schema hash");
  assert.equal(
    `db/migrations/${manifest.database.migrationHead}.sql`,
    manifest.database.migrations.at(-1)?.path,
    "migration head",
  );
  assert.deepEqual(
    manifest.tests.map((item) => item.name),
    RECEIPTS.map(([name]) => name),
    "one entry per qualification receipt",
  );
  for (const item of manifest.tests) {
    assert(["passed", "failed", "unknown", "missing"].includes(item.status), `${item.name} status`);
    if (item.status === "passed") {
      assert.equal(item.commit, manifest.candidate.commit, `${item.name} candidate`);
      assert.equal(item.tree, manifest.candidate.tree, `${item.name} tree`);
      assert.equal(item.exitCode, 0, `${item.name} exit code`);
    }
  }
  if (manifest.faults.receipt === "passed") {
    assert(manifest.testDbReport?.success !== false, "test:db passed but its report failed");
    for (const entry of [
      ...(manifest.faults.cases ?? []),
      ...(manifest.rls.cases ?? []),
      ...(manifest.priorRelease.cases ?? []),
    ])
      assert.notEqual(entry.status, "failed", `${entry.name} failed under a passing test:db`);
  }
  assert(manifest.scenarios.length > 0, "golden scenario hashes required");
  for (const golden of manifest.scenarios) assert.match(golden.digest, DIGEST, golden.path);
  if (manifest.journal.status === "passed") {
    assert(
      manifest.journal.runs.every((run) => run.passed),
      "a passed journal has a failed run",
    );
    assert.equal(
      manifest.journal.performance.length,
      JOURNAL_LONG_RUNS.length * 2,
      "one performance entry per long run",
    );
    for (const entry of manifest.journal.performance) {
      const name = `${entry.pack}/${entry.scenario}:${entry.run}`;
      assert(Number.isFinite(entry.replay.eventsPerSecond), `${name} replay throughput`);
      assert(Number.isFinite(entry.journalLatencyMs.p95), `${name} journal latency`);
    }
  }
  const items = await literalChecklist(root);
  assert.deepEqual(
    manifest.exitChecklist.map((entry) => entry.item),
    items,
    "exactly one disposition per literal §19 item",
  );
  assert.deepEqual(
    manifest.exitChecklist,
    exitChecklist(manifest, items),
    "dispositions exceed their receipts",
  );
  assert.deepEqual(
    manifest.exitDecision,
    exitDecision(manifest.exitChecklist),
    "exit decision does not follow the checklist",
  );
  return manifest;
}
