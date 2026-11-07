// Browser test placement (docs/runbooks/testing.md): only the CI jobs that install Chromium,
// Quality's browser-build share and Qualification, run tests/ci/vitest.browser.config.ts. Playwright
// anywhere outside that config's include passes on a host that has browsers, then fails in CI's
// other shares. `pnpm check` runs this through scripts/check-boundaries.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const BROWSER_CONFIG = "tests/ci/vitest.browser.config.ts";
const RULE = `tests that launch a browser live in the include of ${BROWSER_CONFIG}, run only where CI installs Chromium`;
/**
 * Besides the browser config's include: the browser-build toolchain probe and this check's fixtures.
 * An entry ending in "/" allows a directory.
 */
const TOOLS = ["scripts/ci/browser-toolchain.mjs", "scripts/check-browser-tests.mjs"];
const allows = (allowed, file) =>
  allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
const usages = [
  [
    "imports",
    /(?:\bfrom|\bimport\s*\(?|\brequire(?:\.resolve)?\s*\()\s*["']((?:playwright(?:-core)?|@playwright\/test|@vitest\/browser[\w-]*)(?:\/[^"']*)?)["']/gu,
  ],
  [
    "calls",
    /\b(?:chromium|firefox|webkit)\s*\.\s*(?:launch|connect)\w*|\blaunchPersistentContext\b/gu,
  ],
];

/** One problem per use in the given [repository-relative path, source] pairs outside `allowed`. */
export function browserTestProblems(files, allowed) {
  const problems = [];
  for (const [file, source] of files) {
    if (allows(allowed, file)) continue;
    const code = source
      .split("\n")
      .map((line) => (/^\s*(?:\/\/|\/?\*)/u.test(line) ? "" : line))
      .join("\n");
    for (const [verb, pattern] of usages)
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index).split("\n").length;
        problems.push(`${file}:${line}: ${verb} ${match[1] ?? match[0]}; ${RULE}`);
      }
  }
  return problems;
}

/** [repository-relative path, source] for each tracked or unignored script that `keep` accepts. */
export async function sourceFiles(root, keep) {
  const files = [];
  for (const name of execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && keep(file))) {
    try {
      files.push([name, await readFile(path.join(root, name), "utf8")]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return files;
}

export async function checkBrowserTests(root) {
  const config = await readFile(path.join(root, BROWSER_CONFIG), "utf8");
  const include = [
    ...(/\binclude:\s*\[([^\]]*)\]/u.exec(config)?.[1] ?? "").matchAll(/["']([^"']+)["']/gu),
  ].map((match) => match[1]);
  assert.ok(include.length > 0, `${BROWSER_CONFIG} names no include`);
  const allowed = [...include, ...TOOLS];
  // Negative control: the issue 800 replay's journey is refused under a runtime test directory and in a
  // tests/ci/ file another share runs, a helper's split dynamic import and launchServer are refused
  // while a dependency name and a comment are not, and the journey in the browser include passes.
  const journey =
    'import { chromium } from "playwright";\nconst browser = await chromium.launch();\n';
  const helper =
    'expect(dependency).toBe("playwright");\n// import("playwright")\nconst { chromium } = await import(\n  "playwright");\nawait chromium.launchServer();\n';
  const misplaced = "apps/runtime/test/living-yard.journey.browser.test.ts";
  const regressions = "tests/ci/regressions.test.mjs";
  const support = "packages/testkit/src/browser.ts";
  assert.deepEqual(
    browserTestProblems(
      [
        [misplaced, journey],
        [regressions, journey],
        [support, helper],
        [include[0], journey],
      ],
      allowed,
    ),
    [
      [misplaced, 1, "imports playwright"],
      [misplaced, 2, "calls chromium.launch"],
      [regressions, 1, "imports playwright"],
      [regressions, 2, "calls chromium.launch"],
      [support, 3, "imports playwright"],
      [support, 5, "calls chromium.launchServer"],
    ].map(([file, line, use]) => `${file}:${line}: ${use}; ${RULE}`),
    "browser test placement negative control",
  );
  const files = await sourceFiles(root, (file) => !allows(allowed, file));
  const problems = browserTestProblems(files, allowed);
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(
    `browser test placement: ${files.length} source files outside ${include.join(", ")} launch none`,
  );
}
