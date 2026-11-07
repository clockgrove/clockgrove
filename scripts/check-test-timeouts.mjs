// Test timeout floor (docs/runbooks/testing.md): Vitest's 5 s default timed out tests that pass
// locally on CI's 2-core runners. Every Vitest config sets testTimeout and
// hookTimeout to at least 30 s, the root vitest.config.ts that a bare `vitest run` (`pnpm
// test:replay`) resolves among them, and no test, suite or hook passes a shorter timeout.
// expect.poll's 1 s default failed the browser journey on a loaded runner the same way, so
// every config sets expect.poll.timeout too, and no expect.poll call passes a shorter one.
// `pnpm check` runs this through scripts/check-boundaries.mjs.
import assert from "node:assert/strict";
import ts from "typescript";
import { sourceFiles } from "./check-browser-tests.mjs";

const FLOOR = 30_000;
const RULE = `Vitest timeouts are at least ${FLOOR} ms`;
const ROOT_CONFIG = "vitest.config.ts";
const CONFIG = /(?:^|\/)vitest(?:\.[\w-]+)*\.(?:config|workspace)\.[cm]?[jt]s$/u;
const TEST_CODE = /(?:^|\/)tests?\/|\.test\.[cm]?[jt]sx?$/u;
const TIMEOUTS = ["testTimeout", "hookTimeout", "expect.poll.timeout"];
const API = new Set([
  "it",
  "test",
  "describe",
  "suite",
  "bench",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "onTestFinished",
  "onTestFailed",
]);
const ARITHMETIC = {
  [ts.SyntaxKind.PlusToken]: (left, right) => left + right,
  [ts.SyntaxKind.MinusToken]: (left, right) => left - right,
  [ts.SyntaxKind.AsteriskToken]: (left, right) => left * right,
  [ts.SyntaxKind.SlashToken]: (left, right) => left / right,
};
/** A property's value, or for a shorthand `{ timeout }` the identifier it names. */
const option = (object, name) => {
  const property = object.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      candidate.name.getText() === name,
  );
  return property?.initializer ?? property?.name;
};
/** The value at a dotted path through nested object literals, if every step is one. */
const setting = (object, path) =>
  path
    .split(".")
    .reduce(
      (value, name) =>
        value && ts.isObjectLiteralExpression(value) ? option(value, name) : undefined,
      object,
    );

/** The number an expression folds to from literals, arithmetic and the file's constants, if any. */
function fold(node, constants) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return fold(node.expression, constants);
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isBinaryExpression(node))
    return ARITHMETIC[node.operatorToken.kind]?.(
      fold(node.left, constants),
      fold(node.right, constants),
    );
  return undefined;
}

/** One problem per short or missing timeout in the given [repository-relative path, source] pairs. */
export function testTimeoutProblems(files) {
  const problems = [];
  for (const [file, source] of files) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const report = (node, problem) =>
      problems.push(
        `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${problem}; ${RULE}`,
      );
    const constants = new Map();
    const aliases = new Map();
    const collect = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        node.parent.flags & ts.NodeFlags.Const
      )
        constants.set(node.name.text, fold(node.initializer, constants));
      if (
        ts.isImportSpecifier(node) &&
        node.propertyName &&
        node.parent.parent.parent.moduleSpecifier.text === "vitest"
      )
        aliases.set(node.name.text, node.propertyName.text);
      ts.forEachChild(node, collect);
    };
    collect(tree);
    const below = (node) => fold(node, constants) < FLOOR;
    let settings = 0;
    const visit = (node) => {
      if (
        CONFIG.test(file) &&
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "test" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        settings += 1;
        for (const name of TIMEOUTS) {
          const value = setting(node.initializer, name);
          if (!value) report(node, `test omits ${name}`);
          else if (!(fold(value, constants) >= FLOOR)) report(value, `${name} ${value.getText()}`);
        }
      }
      if (!CONFIG.test(file) && ts.isCallExpression(node)) {
        const [options] = node.arguments;
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "setConfig" &&
          options &&
          ts.isObjectLiteralExpression(options)
        )
          for (const name of TIMEOUTS) {
            const value = setting(options, name);
            if (value && below(value)) report(value, `setConfig ${name} ${value.getText()}`);
          }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "poll" &&
          ts.isIdentifier(node.expression.expression) &&
          (aliases.get(node.expression.expression.text) ?? node.expression.expression.text) ===
            "expect"
        ) {
          const timeout = setting(node.arguments[1], "timeout");
          if (timeout && below(timeout))
            report(timeout, `expect.poll timeout ${timeout.getText()}`);
        }
        let callee = node.expression;
        while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee))
          callee = callee.expression;
        if (ts.isIdentifier(callee) && API.has(aliases.get(callee.text) ?? callee.text))
          for (const argument of node.arguments.slice(1)) {
            const timeout = ts.isObjectLiteralExpression(argument)
              ? option(argument, "timeout")
              : argument;
            if (timeout && below(timeout))
              report(timeout, `${callee.text} timeout ${timeout.getText()}`);
          }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (CONFIG.test(file) && settings === 0) report(tree, "sets no test options");
  }
  if (!files.some(([file]) => file === ROOT_CONFIG))
    problems.push(
      `${ROOT_CONFIG}: missing, so a bare \`vitest run\` takes the 5 s default; ${RULE}`,
    );
  return problems;
}

export async function checkTestTimeouts(root) {
  // Negative control: a short and a missing config timeout or expect.poll timeout, an inline
  // project's, a config with no test options, a missing root config, and a short test, suite,
  // hook, `each`, aliased, onTestFinished, setConfig and expect.poll timeout (aliased expect
  // included), as a literal, arithmetic, a constant or a shorthand constant, are refused; a longer
  // one, a regular expression's `test` and a node:test grader's are not.
  const workspace = [
    "export default defineConfig({",
    "  test: {",
    "    testTimeout: 30_000,",
    "    hookTimeout: 240000,",
    '    projects: [{ test: { name: "infra", testTimeout: 5000, expect: { poll: { timeout: 1000 } } } }],',
    "  },",
    "});",
  ].join("\n");
  const suite = [
    'import { it as vitestIt, onTestFinished, expect as check } from "vitest";',
    "const SECOND = 1000;",
    'it("a", async () => {}, 5000);',
    'it.skipIf(slow)("b", () => {}, 60_000);',
    'describe("c", { timeout: 10_000 }, () => {',
    "  beforeAll(() => {}, 1_000);",
    '  test.each([1, 2])("d", () => {}, { timeout: 29_999 });',
    "  it(\"e\", () => expect.poll(probe, { timeout: SECOND }).toBe(/x/.test('x', 5)));",
    '  vitestIt("f", () => onTestFinished(() => {}, 5 * SECOND), SECOND);',
    "  vi.setConfig({ testTimeout: 2 * SECOND, hookTimeout: (SECOND + 1) * 30, expect: { poll: { timeout: 500 } } });",
    "  expect.poll(probe, { interval: 5, timeout: 30 * SECOND }).toBe(1);",
    "  const timeout = SECOND; check.poll(probe, { timeout }).toBe(1);",
    "});",
  ].join("\n");
  assert.deepEqual(
    testTimeoutProblems([
      ["vitest.workspace.ts", workspace],
      ["packages/kernel/vitest.long-run.config.ts", "export default defineConfig({});"],
      ["apps/runtime/test/owner.postgres.test.ts", suite],
    ]),
    [
      "vitest.workspace.ts:2: test omits expect.poll.timeout",
      "vitest.workspace.ts:5: testTimeout 5000",
      "vitest.workspace.ts:5: test omits hookTimeout",
      "vitest.workspace.ts:5: expect.poll.timeout 1000",
      "packages/kernel/vitest.long-run.config.ts:1: sets no test options",
      "apps/runtime/test/owner.postgres.test.ts:3: it timeout 5000",
      "apps/runtime/test/owner.postgres.test.ts:5: describe timeout 10_000",
      "apps/runtime/test/owner.postgres.test.ts:6: beforeAll timeout 1_000",
      "apps/runtime/test/owner.postgres.test.ts:7: test timeout 29_999",
      "apps/runtime/test/owner.postgres.test.ts:8: expect.poll timeout SECOND",
      "apps/runtime/test/owner.postgres.test.ts:9: vitestIt timeout SECOND",
      "apps/runtime/test/owner.postgres.test.ts:9: onTestFinished timeout 5 * SECOND",
      "apps/runtime/test/owner.postgres.test.ts:10: setConfig testTimeout 2 * SECOND",
      "apps/runtime/test/owner.postgres.test.ts:10: setConfig expect.poll.timeout 500",
      "apps/runtime/test/owner.postgres.test.ts:12: expect.poll timeout timeout",
      `${ROOT_CONFIG}: missing, so a bare \`vitest run\` takes the 5 s default`,
    ].map((problem) => `${problem}; ${RULE}`),
    "test timeout floor negative control",
  );
  const files = await sourceFiles(root, (file) => CONFIG.test(file) || TEST_CODE.test(file));
  const problems = testTimeoutProblems(files);
  assert.deepEqual(problems, [], problems.join("\n"));
  const configs = files.filter(([file]) => CONFIG.test(file)).length;
  console.log(
    `test timeout floor: ${configs} Vitest configs and ${files.length - configs} test files hold ${FLOOR} ms`,
  );
}
