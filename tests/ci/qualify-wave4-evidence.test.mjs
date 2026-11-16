import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { resolveRow } from "../../scripts/ci/qualify-wave4-evidence.mjs";

// Issue 357: a Wave 4 row is proven only by cited tests that ran and passed in the run's reports.
const root = new URL("../../", import.meta.url);
const matrix = JSON.parse(readFileSync(new URL("scripts/ci/qualify-wave4-scenarios.json", root)));
const file = "apps/web/test/boundaries.test.mjs";
const row = { id: "X", coverage: "full", evidence: [{ file, test: "outer inner" }] };
const report = (status, fullName = "outer inner") => ({
  testResults: [{ name: new URL(file, root).pathname, assertionResults: [{ fullName, status }] }],
});
const resolve = (results) => resolveRow(row, { suiteOf: () => "test:scene", results }).status;

it("proves a row only when every cited test passed in the suite's report", () => {
  expect(resolve({ "test:scene": report("passed") })).toBe("passed");
  for (const status of ["skipped", "pending", "todo", "failed"])
    expect(resolve({ "test:scene": report(status) })).toBe("failed");
  expect(resolve({ "test:scene": report("passed", "outer renamed") })).toBe("failed");
  expect(resolve({ "test:scene": { testResults: [] } })).toBe("failed");
  expect(resolve({ "test:scene": null })).toBe("failed");
  // A native-owner test is skipped in the main run and passes in its child run's report.
  expect(resolve({ "test:scene": [report("skipped"), report("passed")] })).toBe("passed");
  expect(resolve({ "test:scene": [report("skipped"), report("failed")] })).toBe("failed");
  const outside = resolveRow(row, { suiteOf: () => undefined, results: {} });
  expect([outside.status, outside.evidence[0].result]).toEqual([
    "deviation",
    "outside-wave4-suites",
  ]);
});

/** Full names of a file's it/test calls: describe titles and the title joined by spaces. */
function testNames(source, name) {
  const names = [];
  const visit = (node, titles) => {
    let next = titles;
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee))
        callee = callee.expression;
      const title = node.arguments[0];
      if (ts.isIdentifier(callee) && title && ts.isStringLiteralLike(title)) {
        if (callee.text === "describe") next = [...titles, title.text];
        else if (callee.text === "it" || callee.text === "test")
          // it.each titles carry a format placeholder, which Vitest fills per case.
          names.push([...titles, title.text].join(" "));
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true), []);
  return names.map(
    (full) =>
      new RegExp(`^${full.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace("%s", ".+")}$`, "u"),
  );
}

it("cites only tests that exist in their files", () => {
  const cited = [...matrix.scenarios, ...matrix.failureMatrix].flatMap(({ id, evidence }) =>
    evidence.map((entry) => ({ id, ...entry })),
  );
  const names = new Map();
  const missing = cited.filter(({ file, test }) => {
    if (!names.has(file))
      names.set(file, testNames(readFileSync(new URL(file, root), "utf8"), file));
    return !names.get(file).some((pattern) => pattern.test(test));
  });
  expect(missing).toEqual([]);
  expect(cited.every((entry) => entry.marker === undefined && typeof entry.test === "string")).toBe(
    true,
  );
});
