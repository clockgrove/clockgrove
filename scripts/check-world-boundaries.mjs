import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import ts from "typescript";
import { forbidden } from "../dependency-cruiser.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const code = /\.(?:[cm]?[jt]sx?|json|css)$/u;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "coverage"].includes(entry.name))
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else if (entry.isFile() && code.test(entry.name)) files.push(file);
  }
  return files;
}

export function isWorldPath(value, config) {
  const normalized = value.replaceAll("\\", "/");
  return new RegExp(
    `(?:^|/)${escapePattern(config.worldRoot)}/(?!${escapePattern(config.fixture)}(?:/|$))[^/]+(?:/|$)`,
    "u",
  ).test(normalized);
}

/**
 * A world identifier as a whole word, not inside another word ("yard" is not in "courtyard"). A
 * dotted namespace matches at its start, in any case. A name matches as a word of its own in lower
 * or upper case (`name`, `NAME_WORLD`, `name-world`), or capitalised as a camel-case part
 * (`NameWorld`, `useNameView`), with an optional plural `s`. A digit is no other word, so `name2.png`
 * and `NAME2` match.
 */
function identifierPattern(identifier) {
  const name = escapePattern(identifier);
  if (identifier.endsWith(".")) return new RegExp(`(?<![A-Za-z0-9_])${name}`, "iu");
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const capital = lower[0].toUpperCase() + lower.slice(1);
  return new RegExp(
    `(?<![A-Za-z])${lower}s?(?![a-z])|(?<![A-Z])${capital}s?(?![a-z])|(?<![A-Za-z])${upper}S?(?![A-Z])`,
    "u",
  );
}

export function worldNameProblems(file, source, config) {
  if (
    config.allowPaths.some((allowed) => file.startsWith(allowed)) ||
    file.split("/").some((segment) => config.allowSegments.includes(segment)) ||
    new RegExp(config.allowFilePattern, "u").test(file)
  )
    return [];
  const problems = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const identifier of config.identifiers) {
      const pattern = identifierPattern(identifier);
      if (pattern.test(line) || (index === 0 && pattern.test(file))) {
        problems.push(`${file}:${index + 1}: ${identifier}`);
      }
    }
  }
  return problems;
}

export function worldImportProblems(file, source, config, worldPackages = new Set()) {
  const problems = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (
        isWorldPath(value, config) ||
        [...worldPackages].some((name) => value === name || value.startsWith(`${name}/`))
      ) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        problems.push(`${file}:${line}: platform depends on world input ${value}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return problems;
}

async function scanWorldNames(repositoryRoot, sourceRoot, config) {
  const names = [];
  for (const absolute of await filesUnder(path.join(repositoryRoot, sourceRoot))) {
    const file = path.relative(repositoryRoot, absolute).split(path.sep).join("/");
    names.push(...worldNameProblems(file, await readFile(absolute, "utf8"), config));
  }
  return names;
}

export async function checkWorldBoundaries(repositoryRoot = root) {
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, "scripts/world-boundaries.json"), "utf8"),
  );
  const worldPackages = new Set();
  for (const file of await filesUnder(path.join(repositoryRoot, config.worldRoot))) {
    if (
      path.basename(file) !== "package.json" ||
      !isWorldPath(path.relative(repositoryRoot, file), config)
    )
      continue;
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (manifest.name) worldPackages.add(manifest.name);
  }
  assert.equal(worldNameProblems("apps/web/src/example.ts", "clockgrove.pack", config).length, 0);
  assert.equal(
    worldNameProblems("apps/web/src/example.ts", config.identifiers.join(" "), config).length,
    config.identifiers.length,
  );
  assert.equal(
    worldNameProblems("worlds/fixture/example.ts", config.identifiers.join(" "), config).length,
    0,
  );
  // A name inside another word or a generic word is not a world's content; the name itself is.
  const [name] = config.identifiers;
  const capital = name[0].toUpperCase() + name.slice(1);
  assert.deepEqual(
    worldNameProblems(
      "apps/web/src/example.ts",
      `courtyard vineyard yard ${capital}ish ${name}er grover.x`,
      config,
    ),
    [],
  );
  for (const named of [
    `use${capital}View`,
    `${name.toUpperCase()}_WORLD`,
    `${name}s-world`,
    `${name}2.png`,
    `${capital}2`,
    `${name.toUpperCase()}2`,
  ])
    assert.equal(worldNameProblems("apps/web/src/example.ts", named, config).length, 1, named);
  assert.equal(
    worldImportProblems(
      "apps/web/src/example.ts",
      'import("../../worlds/example/pack.json")',
      config,
    ).length,
    1,
  );
  assert.equal(
    worldImportProblems(
      "apps/web/src/example.ts",
      'import("../../worlds/fixture/pack.json")',
      config,
    ).length,
    0,
  );
  assert.equal(
    worldImportProblems(
      "apps/web/src/example.ts",
      'require("@example/world")',
      config,
      new Set(["@example/world"]),
    ).length,
    1,
  );
  const negativeRoot = await mkdtemp(path.join(tmpdir(), "world-boundary-"));
  try {
    await mkdir(path.join(negativeRoot, "apps", "platform"), { recursive: true });
    await mkdir(path.join(negativeRoot, "worlds", "forbidden"), { recursive: true });
    await writeFile(path.join(negativeRoot, "worlds", "forbidden", "presentation.json"), "{}\n");
    await writeFile(
      path.join(negativeRoot, "apps", "platform", "example.ts"),
      'import presentation from "../../worlds/forbidden/presentation.json"; export { presentation };\n',
    );
    const negative = await cruise(["apps/platform/example.ts"], {
      baseDir: negativeRoot,
      validate: true,
      ruleSet: { forbidden },
    });
    assert(
      negative.output.summary.violations.some(
        (violation) => violation.rule.name === "no-platform-to-world",
      ),
      "depcruise must reject a resolved platform-to-world dependency",
    );
  } finally {
    await rm(negativeRoot, { recursive: true, force: true });
  }
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const field of dependencyFields) {
    for (const [name, value] of Object.entries(rootManifest[field] ?? {})) {
      assert(
        !worldPackages.has(name) && !isWorldPath(value, config),
        `package.json: forbidden ${field} ${name}`,
      );
    }
  }
  assert.deepEqual(
    await scanWorldNames(repositoryRoot, "tests/dependency-boundaries/world-names", {
      ...config,
      allowPaths: [],
      allowSegments: [],
      allowFilePattern: "$^",
    }),
    [`tests/dependency-boundaries/world-names/branding.json:1: ${config.identifiers[0]}`],
    "JSON source must participate in the filesystem identifier scan",
  );
  assert.deepEqual(
    worldNameProblems("scripts/world-boundaries.json", config.identifiers.join(" "), config),
    [],
  );
  const names = [];
  const dependencies = [];
  for (const sourceRoot of config.sourceRoots) {
    names.push(...(await scanWorldNames(repositoryRoot, sourceRoot, config)));
    for (const absolute of await filesUnder(path.join(repositoryRoot, sourceRoot))) {
      const file = path.relative(repositoryRoot, absolute).split(path.sep).join("/");
      const source = await readFile(absolute, "utf8");
      const platform = /^(?:apps|packages)\//u.test(file);
      const test =
        config.allowSegments.some((segment) => file.split("/").includes(segment)) ||
        new RegExp(config.allowFilePattern, "u").test(file);
      if (!platform || test) continue;
      if (file.endsWith("package.json")) {
        const manifest = JSON.parse(source);
        for (const field of dependencyFields) {
          for (const [name, value] of Object.entries(manifest[field] ?? {})) {
            if (worldPackages.has(name) || isWorldPath(value, config))
              dependencies.push(`${file}: forbidden ${field} ${name}`);
          }
        }
      } else if (/\.[cm]?[jt]sx?$/u.test(file)) {
        dependencies.push(...worldImportProblems(file, source, config, worldPackages));
      }
    }
  }
  assert.deepEqual(dependencies, [], dependencies.join("\n"));
  console.log(
    `world identifiers: ${names.length} occurrences (${config.enforceNames ? "enforced" : "report-only"}); ${config.activation}`,
  );
  for (const occurrence of names) console.log(occurrence);
  if (config.enforceNames) assert.deepEqual(names, [], names.join("\n"));
  console.log("platform-to-world dependencies: none");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await checkWorldBoundaries();
