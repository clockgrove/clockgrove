// Lean-test budget (docs/runbooks/testing.md): net test lines stay within added production
// lines, and new unit-test files appear only in declared unit-test areas.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const code = /\.(ts|tsx|mjs|js|sql)$/u;
const isTest = (file) => /(^|\/)tests?\//u.test(file) || /\.test\.[a-z]+$/u.test(file);
const isIntegrationTest = (file) =>
  /\.(postgres|long-run|journey)\.[a-z.]*test\.[a-z]+$/u.test(file);
const isTestFile = (file) => /\.test\.(ts|tsx|mjs|js)$/u.test(file);

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function baseCommit(root) {
  const declared = process.env.CONTRACT_BASE_COMMIT;
  if (declared && /^[0-9a-f]{40}$/u.test(declared) && !/^0+$/u.test(declared)) {
    if (git(root, ["cat-file", "-e", `${declared}^{commit}`]) !== undefined) return declared;
  }
  // Factory validation passes the Objective's accepted base; its checkout's origin/main can be stale.
  const factoryBase = process.env.FACTORY_BASE_SHA;
  if (factoryBase && /^[0-9a-f]{40}$/u.test(factoryBase)) {
    if (git(root, ["merge-base", "--is-ancestor", factoryBase, "HEAD"]) !== undefined)
      return factoryBase;
  }
  return git(root, ["merge-base", "HEAD", "origin/main"])?.trim() || undefined;
}

export async function checkTestBudget(root) {
  const base = baseCommit(root);
  if (!base) {
    console.log("test budget: skipped; no base commit");
    return;
  }
  const policy = JSON.parse(await readFile(path.join(root, "scripts/test-budget.json"), "utf8"));
  // Committed and uncommitted changes against the base, plus untracked files.
  const added = new Map();
  const deleted = new Map();
  for (const line of git(root, ["diff", "--numstat", "--no-renames", base]).split("\n")) {
    const [lines, removed, file] = line.split("\t");
    if (file && code.test(file) && lines !== "-") {
      added.set(file, Number(lines));
      deleted.set(file, Number(removed));
    }
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n");
  for (const file of untracked.filter((name) => code.test(name))) {
    added.set(file, (await readFile(path.join(root, file), "utf8")).split("\n").length);
  }
  const created = new Set([
    ...git(root, ["diff", "--name-only", "--diff-filter=A", base]).split("\n"),
    ...untracked,
  ]);
  // Test lines count net (added minus deleted, issue 996), so a change that shrinks the tests never fails.
  let test = 0;
  let production = 0;
  for (const [file, lines] of added) {
    if (isTest(file)) test += lines - (deleted.get(file) ?? 0);
    else production += lines;
  }
  // Recorded, reviewed exceptions (testing.md): each excuses at most `lines` added lines of one test
  // file that this change creates, so it lapses once the change has merged.
  let excused = 0;
  const notes = [];
  for (const { file, lines, decision, reason } of policy.testLineExceptions ?? []) {
    assert.ok(
      isTest(file) && Number.isSafeInteger(lines) && lines > 0 && decision && reason,
      "test budget: each testLineExceptions entry needs a test file, positive lines, decision and reason",
    );
    if (!created.has(file)) continue;
    const count = Math.min(lines, added.get(file) ?? 0);
    excused += count;
    notes.push(`; ${count} excused in ${file} (${decision})`);
  }
  const failures = [];
  if (test - excused > production + policy.testLineAllowance)
    failures.push(
      `net test lines (${test}, ${excused} excused) exceed added production lines (${production}) by more than ${policy.testLineAllowance}`,
    );
  const unit = [...created].filter(
    (file) =>
      isTestFile(file) &&
      !isIntegrationTest(file) &&
      !policy.unitTestAreas.some((area) => file.startsWith(area)),
  );
  if (unit.length > 0)
    failures.push(`new unit-test files outside unitTestAreas: ${unit.join(", ")}`);
  assert.equal(
    failures.length,
    0,
    `test budget (docs/runbooks/testing.md): ${failures.join("; ")}`,
  );
  console.log(
    `test budget: passed; ${test} net test vs ${production} added production lines${notes.join("")}`,
  );
}
