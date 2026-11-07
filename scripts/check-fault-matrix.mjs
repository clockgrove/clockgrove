// Wave 3 §17 failure and recovery matrix (docs/runbooks/runtime.md, "Failure and recovery matrix").
// Each literal §17 row maps to cases, and each case is tested by a named test that exists, deferred
// to a later wave, or pending on its owning issue. `pnpm check` runs this, so deleting or renaming a
// cited test fails the check instead of silently leaving its case unproven.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const MATRIX = "scripts/ci/wave3-fault-matrix.json";
const PLAN = "docs/waves/clockgrove-wave-3-actor-fabric-implementation-plan.md";
const FIELDS = { tested: ["file", "test", "command"], deferred: ["wave"], pending: ["issue"] };
const FORMS = { deferred: ["wave", /^Wave \d+$/u], pending: ["issue", /^#\d+$/u] };

/** The literal §17 rows: the bullets of the plan's "17. Failure and recovery matrix" section. */
export function planRows(plan) {
  const section = plan.split(/^## 17\. Failure and recovery matrix$/mu)[1]?.split(/^## /mu)[0];
  return [...(section ?? "").matchAll(/^- (.+?)[;.]?$/gmu)].map((match) => match[1]);
}

/** The canonical command that runs a test file (docs/runbooks/development.md). */
function commandOf(file, databaseFiles) {
  if (databaseFiles.includes(file)) return "test:db";
  return /^apps\/runtime\/test\/.+\.postgres\.test\.ts$/u.test(file) ? "test:runtime" : "test";
}

/**
 * A Vitest call (`it`, `it.skipIf(...)`, `it.each(...)`, `test`) whose name is exactly `name`, outside
 * comments: the source is re-printed by TypeScript without them, so a commented-out test is not one.
 */
function declaresTest(source, name) {
  const file = ts.createSourceFile("cited.ts", source, ts.ScriptTarget.Latest);
  const code = ts.createPrinter({ removeComments: true }).printFile(file);
  const literal = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `\\b(?:it|test)(?:\\.\\w+\\((?:[^()]|\\([^()]*\\))*\\))?\\(\\s*${literal}`,
    "u",
  ).test(code);
}

/** Problems with the matrix, given the plan's rows, each cited file's text and test:db's files. */
export function faultMatrixProblems(matrix, rows, sources, databaseFiles) {
  const problems = [];
  for (const [index, entry] of matrix.rows.entries()) {
    const at = `${MATRIX} case ${index + 1} (${entry.row}: ${entry.case})`;
    const fields = FIELDS[entry.disposition];
    if (!rows.includes(entry.row)) problems.push(`${at}: not a §17 row`);
    if (typeof entry.case !== "string" || entry.case === "") problems.push(`${at}: no case`);
    if (fields === undefined) {
      problems.push(`${at}: disposition must be tested, deferred or pending`);
      continue;
    }
    const keys = ["row", "case", "disposition", ...fields];
    if (
      Object.keys(entry).some((key) => !keys.includes(key)) ||
      fields.some((key) => typeof entry[key] !== "string" || entry[key] === "")
    ) {
      problems.push(`${at}: ${entry.disposition} needs exactly ${fields.join(", ")}`);
      continue;
    }
    const [field, form] = FORMS[entry.disposition] ?? [];
    if (form !== undefined && !form.test(entry[field]))
      problems.push(`${at}: ${field} ${entry[field]} does not match ${form}`);
    if (entry.disposition !== "tested") continue;
    const source = sources.get(entry.file);
    if (source === undefined) problems.push(`${at}: ${entry.file} does not exist`);
    else if (!declaresTest(source, entry.test))
      problems.push(`${at}: ${entry.file} has no test named "${entry.test}"`);
    const command = commandOf(entry.file, databaseFiles);
    if (entry.command !== command)
      problems.push(`${at}: runs under ${command}, not ${entry.command}`);
  }
  for (const row of rows)
    if (!matrix.rows.some((entry) => entry.row === row))
      problems.push(`§17 row "${row}" has no case in ${MATRIX}`);
  return problems;
}

export async function checkFaultMatrix(root) {
  const read = (file) => readFile(path.join(root, file), "utf8");
  const matrix = JSON.parse(await read(MATRIX));
  const rows = planRows(await read(PLAN));
  assert(rows.length > 0, `${PLAN} §17 lists no rows`);
  const files = [...new Set(matrix.rows.flatMap((entry) => (entry.file ? [entry.file] : [])))];
  const sources = new Map(
    await Promise.all(files.map(async (file) => [file, await read(file).catch(() => undefined)])),
  );
  const databaseFiles = [
    ...(await read("scripts/database/test.mjs")).matchAll(
      /"(apps\/runtime\/test\/[\w.-]+\.postgres\.test\.ts)"/gu,
    ),
  ].map((match) => match[1]);
  // Negative control: a renamed test, a commented-out test, an unknown disposition and an unmapped
  // row are each reported.
  const tested = { row: "a", case: "c", disposition: "tested", test: "x", command: "test" };
  const control = faultMatrixProblems(
    {
      rows: [
        { ...tested, file: "f.test.ts" },
        { ...tested, file: "g.test.ts" },
        { row: "a", case: "c", disposition: "proven" },
      ],
    },
    ["a", "b"],
    new Map([
      ["f.test.ts", 'it("kept x", () => {});'],
      ["g.test.ts", '// it("x", () => {});\n/* it("x", () => {}); */'],
    ]),
    [],
  );
  assert.equal(control.length, 4, `fault matrix negative control: ${control.join("; ")}`);
  const problems = faultMatrixProblems(matrix, rows, sources, databaseFiles);
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(`fault matrix: ${matrix.rows.length} cases cover the ${rows.length} §17 rows`);
}
