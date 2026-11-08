import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
      // Dotted namespaces match at their start; ordinary names also catch camel-case symbols.
      const prefix = identifier.endsWith(".") ? "(?<![A-Za-z0-9_])" : "";
      const pattern = new RegExp(`${prefix}${escapePattern(identifier)}`, "iu");
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
  const negative = await cruise(
    [path.join(repositoryRoot, "tests/dependency-boundaries/forbidden-platform-to-world.ts")],
    {
      validate: true,
      ruleSet: { forbidden },
      tsConfig: { fileName: path.join(repositoryRoot, "tsconfig.base.json") },
    },
  );
  assert(
    negative.output.summary.violations.some(
      (violation) => violation.rule.name === "no-platform-to-world",
    ),
    "depcruise must reject the platform-to-world negative fixture",
  );
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
    ["tests/dependency-boundaries/world-names/branding.json:1: raccoon"],
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
