import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const COVERAGE = ["full", "partial", "gap", "not_applicable"];
const STATUSES = new Set(["passed", "skipped", "pending", "todo", "failed"]);

/**
 * The status Vitest's JSON reports give the cited test in the cited file; `missing` when absent. A
 * native-owner test is skipped in the main run and runs in its child, so any report that passed it
 * counts, and otherwise the first report's status stands.
 */
function testResult(report, root, file, test) {
  const statuses = [report ?? []]
    .flat()
    .flatMap(({ testResults }) => testResults)
    .filter(({ name }) => path.relative(root, name).split(path.sep).join("/") === file)
    .flatMap(({ assertionResults }) => assertionResults)
    .filter(({ fullName }) => fullName === test)
    .map(({ status }) => (STATUSES.has(status) ? status : "failed"));
  return statuses.includes("passed") ? "passed" : (statuses[0] ?? "missing");
}

/**
 * Resolves one §15.2 / §16 row. An evidence entry is proven only by a report of its suite in which
 * the cited test ran and passed: a skipped, deleted, renamed or unreported test fails the row.
 * `results` maps a suite name to its parsed Vitest JSON report (or a list of them: the main run and
 * its native-owner child runs), or null when it left none.
 */
export function resolveRow(row, { suiteOf, results }) {
  assert(COVERAGE.includes(row.coverage), `${row.id}: unknown coverage ${row.coverage}`);
  // An owner ruled the item out of this wave: it carries its reason and no evidence, and is no gap.
  if (row.coverage === "not_applicable") {
    assert(
      typeof row.reason === "string" && row.reason !== "" && row.evidence.length === 0,
      `${row.id}: not_applicable needs a reason and no evidence`,
    );
    return { ...row, status: "not_applicable" };
  }
  const evidence = row.evidence.map(({ file, test }) => {
    const suite = suiteOf(file) ?? null;
    return {
      file,
      test,
      suite,
      result:
        suite === null
          ? "outside-wave4-suites"
          : testResult(results[suite] ?? null, root, file, test),
    };
  });
  const proven =
    evidence.length > 0 &&
    evidence.every(({ result }) => result === "passed" || result === "outside-wave4-suites");
  // Evidence no §15.1 suite runs was not executed on this candidate: it is a citation, not a pass.
  const ran = evidence.every(({ result }) => result === "passed");
  // A gap has no evidence to run: it is a deviation of its own, never a pass.
  const status =
    row.coverage === "gap"
      ? "gap"
      : !proven
        ? "failed"
        : row.coverage === "full" && ran
          ? "passed"
          : "deviation";
  const outside = evidence.filter(({ result }) => result === "outside-wave4-suites");
  const deviation =
    row.coverage === "full" && !ran
      ? `cited evidence outside the §15.1 suites, not run on this candidate: ${outside.map(({ file }) => file).join(", ")}`
      : row.deviation;
  return { ...row, evidence, status, ...(deviation ? { deviation } : {}) };
}
