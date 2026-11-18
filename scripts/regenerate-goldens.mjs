#!/usr/bin/env node
// pnpm run goldens:regenerate: accepts the scenario bundles the conformance suite reports as golden
// mismatches. It runs the suite, moves each goldens/<scenario>.actual.json the suite wrote over its
// golden, and runs the suite again; any other failure leaves worlds/ exactly as it was.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SIMULATOR = join(REPO_ROOT, "packages", "simulator");
const SUITE = "test/conformance/conformance.test.ts";
const WORLDS = resolve(process.env.CLOCKGROVE_CONFORMANCE_WORLDS || join(REPO_ROOT, "worlds"));
const ACTUAL = ".actual.json";
const GOLDEN_CHECK = "golden-match";

const vitest = join(
  dirname(createRequire(join(SIMULATOR, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);
const reportDirectory = mkdtempSync(join(tmpdir(), "clockgrove-goldens-"));

/** Every goldens/*.actual.json under the worlds root, with its bytes. */
function actualFiles(directory = WORLDS, found = new Map()) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) actualFiles(path, found);
    else if (basename(directory) === "goldens" && entry.name.endsWith(ACTUAL))
      found.set(path, readFileSync(path));
  }
  return found;
}

/** Runs the suite; returns the failures, each `{ name, checks, actuals }`, or null when it passed. */
function runSuite(pass) {
  const report = join(reportDirectory, `run-${pass}.json`);
  console.info(`goldens:regenerate: conformance run ${pass}: ${SUITE}`);
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "--config",
      "vitest.config.ts",
      SUITE,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
    ],
    {
      cwd: SIMULATOR,
      stdio: "inherit",
      env: { ...process.env, CLOCKGROVE_CONFORMANCE_WORLDS: WORLDS },
    },
  );
  let results;
  try {
    results = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    const reason = run.error?.message ?? `exit ${run.status ?? run.signal}`;
    return [{ name: `vitest wrote no report (${reason})`, checks: [], actuals: [] }];
  }
  if (run.status === 0 && results.success) return null;
  const failures = [];
  for (const file of results.testResults) {
    const failed = file.assertionResults.filter((test) => test.status === "failed");
    for (const test of failed) failures.push(describe(test.fullName, test.failureMessages));
    if (file.status === "failed" && failed.length === 0)
      failures.push(describe(relative(REPO_ROOT, file.name), [file.message]));
  }
  if (failures.length === 0)
    failures.push({ name: `vitest exited ${run.status}`, checks: [], actuals: [] });
  return failures;
}

function describe(name, messages) {
  const lines = messages.flatMap((message) => String(message ?? "").split("\n"));
  const problems = lines.filter((line) => /^(?:\w+: )?pack "/.test(line));
  return {
    name,
    checks: [...new Set(problems.map((line) => /check "([^"]+)"/.exec(line)?.[1] ?? "unknown"))],
    // A failure that names no check (a build, import or assertion error) is not a golden mismatch.
    onlyGolden:
      problems.length > 0 &&
      problems.every((line) => line.includes(`check "${GOLDEN_CHECK}"`) && line.includes(ACTUAL)),
    actuals: problems.flatMap((line) => {
      const path = / was written to (\S+?\.actual\.json)/.exec(line)?.[1];
      return path === undefined ? [] : [resolve(path)];
    }),
  };
}

function isAcceptable(actual) {
  const inside = relative(WORLDS, actual);
  return (
    !inside.startsWith(`..${sep}`) &&
    inside !== ".." &&
    !inside.startsWith(sep) &&
    basename(dirname(actual)) === "goldens" &&
    basename(actual).endsWith(ACTUAL)
  );
}

function summary(failures) {
  return failures
    .map((failure) => {
      const checks = failure.checks.length === 0 ? "" : ` (check ${failure.checks.join(", ")})`;
      return `  - ${failure.name}${checks}`;
    })
    .join("\n");
}

const before = actualFiles();
const goldens = new Map();

/** Puts every golden and *.actual.json back to the bytes they had before this command started. */
function restore() {
  for (const [path, bytes] of goldens) {
    if (bytes === null) rmSync(path, { force: true });
    else writeFileSync(path, bytes);
  }
  for (const path of actualFiles().keys()) if (!before.has(path)) rmSync(path, { force: true });
  for (const [path, bytes] of before) writeFileSync(path, bytes);
}

function fail(message) {
  restore();
  console.error(`goldens:regenerate: ${message}\nNo file under ${WORLDS} was changed.`);
  process.exitCode = 1;
}

try {
  const first = runSuite(1);
  if (first === null) {
    console.info("goldens:regenerate: every golden already matches; nothing was changed.");
  } else if (first.some((failure) => !failure.onlyGolden)) {
    fail(
      `the conformance suite failed for a reason other than a golden mismatch:\n${summary(first)}`,
    );
  } else {
    const actuals = [...new Set(first.flatMap((failure) => failure.actuals))];
    const outside = actuals.filter((actual) => !isAcceptable(actual));
    if (actuals.length === 0 || outside.length > 0) {
      fail(`refusing to move these actual bundles: ${outside.join(", ") || "(none named)"}`);
    } else {
      for (const actual of actuals) {
        const golden = `${actual.slice(0, -ACTUAL.length)}.json`;
        let bytes = null;
        try {
          bytes = readFileSync(golden);
        } catch {}
        goldens.set(golden, bytes);
        renameSync(actual, golden);
        console.info(`goldens:regenerate: accepted ${relative(process.cwd(), golden)}`);
      }
      const second = runSuite(2);
      if (second === null) {
        for (const path of actualFiles().keys()) rmSync(path, { force: true });
        console.info(
          `goldens:regenerate: ${actuals.length} golden(s) rewritten; review their diff.`,
        );
      } else {
        fail(`the conformance suite still fails after accepting the goldens:\n${summary(second)}`);
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 70;
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
