// The Wave 2 evidence manifest claims no more than its receipts show: receipts and journal results
// pass only the items they prove, review items stay `review`, deferred items name their issue, and a
// journal result that disagrees with a golden or an upgraded disposition is refused.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { digest } from "../../scripts/ci/evidence.mjs";
import {
  buildWave2Manifest,
  JOURNAL_LONG_RUNS,
  JOURNAL_RESULT,
  PRIOR_RELEASE,
  RECEIPTS,
  REQUIRED_CHECKS,
  TEST_DB_REPORT,
  validateWave2Manifest,
} from "../../scripts/ci/qualify-wave2-manifest.mjs";
import { decode } from "./decode-once.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let directory;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave2-manifest-test-"));
  for (const [name, command] of RECEIPTS) {
    const log = `${name} ok\n`;
    await writeFile(path.join(directory, `${name}.log`), log);
    await writeFile(
      path.join(directory, `${name}.result.json`),
      JSON.stringify({
        commit: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        usage: null,
        command,
        exitCode: 0,
        status: "passed",
        signal: null,
        errorCode: null,
        startedAt: "2026-10-19T00:00:00.000Z",
        completedAt: "2026-10-19T00:00:01.000Z",
        outputDigest: digest(log),
      }),
    );
  }
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const build = () =>
  buildWave2Manifest({
    root,
    qualificationDirectory: directory,
    wave2Directory: directory,
    execution: { provider: "local", runId: null, runAttempt: null },
    schema: { hash: digest("schema"), method: "test", postgres: "18.6" },
    decode,
  });

/** A passing journal result: every golden run and every declared long run. */
async function writeJournal(edit = (runs) => runs) {
  const run = (set, pack, scenario, name, finalStateHash) => ({
    set,
    pack,
    scenario,
    run: name,
    reference: set === "scenarios" ? "golden" : "pure",
    passed: true,
    checks: REQUIRED_CHECKS.map((id) => ({ id, passed: true })),
    kernelCalls: 4,
    events: 10,
    snapshots: 3,
    suffixEvents: 2,
    kernelMs: 5,
    journalMs: 20,
    finalStateHash,
    journalLatencyMs: { calls: 4, p50: 4, p95: 6, max: 6, mean: 5 },
    replay: { events: 12, ms: 3 },
  });
  const runs = [];
  for (const pack of ["fixture", "raccoons"])
    for (const name of await readdir(path.join(root, "worlds", pack, "goldens"))) {
      const golden = decode(await readFile(path.join(root, "worlds", pack, "goldens", name)));
      for (const entry of golden.runs)
        runs.push(run("scenarios", pack, name.slice(0, -5), entry.name, entry.finalStateHash));
    }
  for (const name of JOURNAL_LONG_RUNS) {
    const [pack, scenario] = name.split("/");
    for (const plan of ["main", "aggregate"])
      runs.push(run("long-runs", pack, scenario, plan, digest(name)));
  }
  await writeFile(
    path.join(directory, JOURNAL_RESULT),
    JSON.stringify({
      kind: "clockgrove.wave2-journal-long-runs",
      version: 1,
      candidate: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") },
      host: { cpus: 4 },
      runs: edit(runs),
    }),
  );
}

const dispositions = (manifest) => manifest.exitChecklist.map((entry) => entry.disposition);

it("passes only what receipts and journal results show and refuses an upgrade", async () => {
  const receiptsOnly = await validateWave2Manifest(await build(), root);
  // Items 2 and 11 need test:db's prior-release cases; items 4, 9 and 12 need the journal results;
  // item 14 needs the bootstrap record.
  expect(dispositions(receiptsOnly)).toEqual([
    "review",
    "missing",
    "passed",
    "pending",
    "review",
    "review",
    "review",
    "review",
    "pending",
    "review",
    "missing",
    "pending",
    "review",
    "pending",
  ]);
  expect(receiptsOnly.exitDecision.status).toBe("not-qualified");
  expect(receiptsOnly.exitChecklist[13].deferred[0].issues).toEqual([415, 693]);

  await writeJournal();
  const withJournal = await validateWave2Manifest(await build(), root);
  expect(withJournal.journal.status).toBe("passed");
  expect([3, 8, 11].map((index) => withJournal.exitChecklist[index].disposition)).toEqual([
    "passed",
    "passed",
    "passed",
  ]);
  expect(withJournal.journal.performance[0].replay.eventsPerSecond).toBe(4000);

  const upgraded = structuredClone(withJournal);
  Object.assign(upgraded.exitChecklist[4], { disposition: "passed", observed: "x" });
  await expect(validateWave2Manifest(upgraded, root)).rejects.toThrow("dispositions exceed");
  const decided = structuredClone(withJournal);
  decided.exitDecision.status = "qualified";
  await expect(validateWave2Manifest(decided, root)).rejects.toThrow("exit decision");
});

it("refuses a journal run whose final hash is not its golden's, and an incomplete set", async () => {
  await writeJournal((runs) => [{ ...runs[0], finalStateHash: digest("other") }, ...runs.slice(1)]);
  await expect(build()).rejects.toThrow("golden mismatch");
  await writeJournal((runs) => runs.slice(1));
  expect((await build()).journal.status).toBe("incomplete");
});

it("passes RW-0209's items only from passed prior-release cases in test:db's report", async () => {
  const report = (statuses) =>
    writeFile(
      path.join(directory, TEST_DB_REPORT),
      JSON.stringify({
        success: !Object.values(statuses).includes("failed"),
        testResults: [
          {
            name: path.join(root, PRIOR_RELEASE.suite),
            assertionResults: Object.entries(statuses).map(([key, status]) => ({
              fullName: PRIOR_RELEASE[key],
              status,
            })),
          },
        ],
      }),
    );
  const items = (manifest) => [1, 10].map((index) => manifest.exitChecklist[index].disposition);
  await report({ migration: "passed", upcaster: "passed" });
  const passed = await validateWave2Manifest(await build(), root);
  expect(items(passed)).toEqual(["passed", "passed"]);
  expect(passed.exitChecklist[10].deferred.map((part) => part.issues)).toEqual([[677]]);
  await report({ migration: "passed", upcaster: "skipped" });
  expect(items(await build())).toEqual(["passed", "missing"]);
  await report({ migration: "failed", upcaster: "passed" });
  expect(items(await build())).toEqual(["failed", "failed"]);
});
