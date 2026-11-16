import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Issue 169: qualify:wave5 is only as honest as its matrix. Every cited marker must still be in its
// file, every cited file must be run by a suite of the run, each suite's files must be the ones its
// package.json command runs, and every §17 suite and scenario, fiber phase and §17 wake kind, and
// security fixture must have its row.
const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const matrix = JSON.parse(read("scripts/ci/qualify-wave5-scenarios.json"));
const scripts = JSON.parse(read("package.json")).scripts;
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.test\.(ts|mjs)$/u.test(file));
const suites = matrix.suites.map((suite) => ({
  ...suite,
  patterns: suite.files.map((pattern) => new RegExp(pattern, "u")),
}));
const rows = [
  ...matrix.scenarios,
  ...matrix.crashMatrix,
  ...matrix.securityFixtures,
  ...matrix.securityGates,
  ...matrix.outcomeRows,
  ...matrix.exitItems,
];

it("cites only present markers in files a suite of the run runs", () => {
  const missing = rows.flatMap(({ id, evidence }) =>
    evidence
      .filter(({ file, marker }) => !read(file).includes(marker))
      .map(({ file }) => `${id} ${file}`),
  );
  const outside = rows.flatMap(({ id, evidence }) =>
    evidence
      .filter(({ file }) => !suites.some(({ patterns }) => patterns.some((p) => p.test(file))))
      .map(({ file }) => `${id} ${file}`),
  );
  expect({ missing, outside }).toEqual({ missing: [], outside: [] });
  for (const row of rows) {
    expect(["full", "partial", "gap"]).toContain(row.coverage);
    if (row.coverage !== "full") expect(row.deviation, row.id).toMatch(/\S/u);
  }
});

it("runs exactly the files each suite's package.json command names", () => {
  /** The tracked test files one `vitest run` command selects by its --root and filters. */
  const selected = (command) => {
    const words = command.trim().split(/\s+/u).slice(2);
    let base = "";
    const filters = [];
    for (let index = 0; index < words.length; index += 1) {
      if (words[index] === "--root") base = `${words[++index]}/`;
      else if (words[index].startsWith("--")) index += 1;
      else filters.push(words[index]);
    }
    return tracked.filter(
      (file) =>
        file.startsWith(base) &&
        (filters.length === 0 || filters.some((filter) => file.includes(filter))),
    );
  };
  for (const suite of suites.filter(({ name }) => name !== "test:db")) {
    const byCommand = scripts[suite.name].split("&&").flatMap(selected).sort();
    const byPattern = tracked.filter((file) => suite.patterns.some((p) => p.test(file))).sort();
    expect(byCommand, suite.name).toEqual(byPattern);
    expect(byCommand.length, suite.name).toBeGreaterThan(0);
  }
});

it("maps every §17 suite and scenario, fiber phase, wake kind and security fixture", () => {
  const plan = read(
    "docs/waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md",
  );
  const section = plan.slice(plan.indexOf("## 17."), plan.indexOf("## 18."));
  const required = [...section.matchAll(/^pnpm (\S+)$/gmu)].map((match) => match[1]);
  expect(suites.map(({ name }) => name)).toEqual([
    ...required.filter((name) => name !== "qualify:wave5:staging"),
    "test:db",
  ]);
  const scenarios = [...section.matchAll(/^- (.+);?$/gmu)].length;
  expect(matrix.scenarios.map(({ id }) => id)).toEqual(
    Array.from({ length: scenarios }, (_, index) => `S${index + 1}`),
  );
  const phases = [
    ...read("packages/contracts/src/turn-fibers.ts")
      .slice(read("packages/contracts/src/turn-fibers.ts").indexOf("TURN_PHASES"))
      .split("]")[0]
      .matchAll(/"([a-z_]+)"/gu),
  ].map((match) => match[1]);
  expect(matrix.fiberPhases).toEqual(phases);
  const inFlight = phases.filter((phase) => !matrix.terminalPhases.includes(phase));
  const crash = matrix.crashMatrix.map(({ id }) => id);
  expect(inFlight.filter((phase) => !crash.includes(`F-${phase}`))).toEqual([]);
  expect(inFlight).toContain("tool_waiting");
  expect(inFlight).toContain("approval_waiting");
  for (const kind of ["direct-message", "perception", "subscription", "heartbeat"])
    expect(crash).toContain(`W-${kind}`);
  expect(matrix.securityFixtures.map(({ id }) => id)).toEqual([
    "SEC-malicious-schema",
    "SEC-prompt-injection",
    "SEC-oversized-response",
    "SEC-redirect",
    "SEC-ssrf",
    "SEC-dns-rebinding",
    "SEC-revocation-during-wait",
    "SEC-result-widens-grants",
    "SEC-secrets-canary",
  ]);
});
