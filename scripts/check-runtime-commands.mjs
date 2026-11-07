// Wave 3 plan §18.1 runtime test commands (docs/runbooks/development.md, "Acceptance commands").
// Each command the plan lists is a root package script, or a dated amendment in §18.1 removes it. A
// scoped script runs a non-empty, named set of existing apps/runtime test files, and no file is named
// twice: not within one script, and not by two scripts. `pnpm check` runs this, and the Wave 3
// evidence manifest records the result.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const PLAN = "docs/waves/clockgrove-wave-3-actor-fabric-implementation-plan.md";
const TESTS = "apps/runtime/test";
/** The canonical commands §18.1 lists; their bodies are the acceptance gates (development.md). */
const CANONICAL = ["check", "test:runtime"];
/** A scoped script: one runtime Vitest config and the test files it runs. */
const SCRIPT =
  /^vitest run --config apps\/runtime\/vitest\.(runtime|long-run)\.config\.ts((?: apps\/runtime\/test\/\S+\.test\.ts)+)$/u;

/** The §18.1 section: its listed command names and its amendment paragraphs. */
export function planCommands(plan) {
  const section = plan.split(/^### 18\.1 .+$/mu)[1]?.split(/^### /mu)[0] ?? "";
  const block = section.split("```")[1] ?? "";
  return {
    commands: [...block.matchAll(/^pnpm (\S+)$/gmu)].map((match) => match[1]),
    amendments: section
      .split("\n\n")
      .filter((paragraph) => /^Amended \(.*\d{4}-\d{2}-\d{2}.*\):/u.test(paragraph)),
  };
}

/** A command an amendment sentence removes, naming it in backticks with the word "removed". */
const removedBy = (amendments, name) =>
  amendments.find((paragraph) =>
    paragraph
      .split(/(?<=\.)\s+/u)
      .some((sentence) => /\bremoved\b/u.test(sentence) && sentence.includes(`\`${name}\``)),
  );

/**
 * Each listed command's record and the problems found, given the plan, the root scripts, the runtime
 * test files (repository-relative) and the long-run files that `test:long-run` runs.
 */
export function runtimeCommandProblems(plan, scripts, runtimeFiles, longRunFiles) {
  const { commands, amendments } = planCommands(plan);
  const problems = [];
  const owner = new Map();
  const records = commands.map((name) => {
    if (CANONICAL.includes(name))
      return scripts[name]
        ? { command: name, disposition: "canonical" }
        : (problems.push(`§18.1 ${name}: no root script`),
          { command: name, disposition: "missing" });
    if (scripts[name] === undefined) {
      const amendment = removedBy(amendments, name);
      if (amendment === undefined) problems.push(`§18.1 ${name}: neither a script nor removed`);
      return amendment
        ? { command: name, disposition: "removed", amendment }
        : { command: name, disposition: "missing" };
    }
    const match = SCRIPT.exec(scripts[name]);
    if (match === null) {
      problems.push(`§18.1 ${name}: not a runtime config and a named list of test files`);
      return { command: name, disposition: "missing" };
    }
    const files = match[2].trim().split(" ");
    const allowed = match[1] === "runtime" ? runtimeFiles : longRunFiles;
    for (const file of files) {
      if (!allowed.includes(file))
        problems.push(`§18.1 ${name}: ${file} is not a ${match[1]} test`);
      if (owner.has(file))
        problems.push(`§18.1 ${name}: ${file} is also run by ${owner.get(file)}`);
      owner.set(file, name);
    }
    return { command: name, disposition: "script", config: match[1], files };
  });
  if (commands.length === 0) problems.push("§18.1 lists no commands");
  return { commands: records, problems };
}

async function testFiles(root, directory = TESTS) {
  const found = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await testFiles(root, file)));
    else if (file.endsWith(".test.ts")) found.push(file);
  }
  return found.sort();
}

/** The §18.1 commands as the manifest records them; throws when any has a problem. */
export async function runtimeCommands(root) {
  const plan = await readFile(path.join(root, PLAN), "utf8");
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const files = await testFiles(root);
  // test:runtime and test:db together run every non-long-run file (apps/runtime/vitest.runtime.config.ts);
  // test:long-run runs every long-run file but the load curves (vitest.long-run.config.ts).
  const longRun = (file) => file.endsWith(".long-run.test.ts");
  const result = runtimeCommandProblems(
    plan,
    scripts,
    files.filter((file) => !longRun(file)),
    files.filter((file) => longRun(file) && !file.endsWith("/load-curves.long-run.test.ts")),
  );
  assert.deepEqual(result.problems, [], result.problems.join("\n"));
  return result.commands;
}

export async function checkRuntimeCommands(root) {
  // Negative control: an unremoved missing command, a file that is not a runtime test and a file two
  // scripts name are each reported.
  const run = (...files) =>
    `vitest run --config apps/runtime/vitest.runtime.config.ts ${files.join(" ")}`;
  const control = runtimeCommandProblems(
    "### 18.1 x\n```text\npnpm a\npnpm b\npnpm c\npnpm d\n```\n\nAmended (2026-01-01): `d` is removed.\n",
    {
      b: run("apps/runtime/test/x.test.ts"),
      c: run("apps/runtime/test/y.test.ts", "apps/runtime/test/x.test.ts"),
    },
    ["apps/runtime/test/x.test.ts"],
    [],
  ).problems;
  assert.equal(control.length, 3, `runtime commands negative control: ${control.join("; ")}`);
  const commands = await runtimeCommands(root);
  console.log(
    `runtime commands: ${commands.filter((entry) => entry.disposition === "script").length} scripts, ${commands.filter((entry) => entry.disposition === "removed").length} removed by amendment`,
  );
}
