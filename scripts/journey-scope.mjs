// Says whether a change is in what the browser journey exercises (AGENTS.md, Validation and
// completion). Informational: it prints reasons and a verdict and exits 0; 2 means git failed.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BROWSER_CONFIG = "tests/ci/vitest.browser.config.ts";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST = /\.test\.[a-z]+$|^vitest\..*config\.[a-z]+$/u;
// Build output, dependencies, and a package's own tests: the journey loads a package's sources, and
// reaches a test helper (apps/runtime/test/world-owner/native-harness.ts) only by naming it.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".wrangler",
  "coverage",
  "test",
]);

/** Every workspace package under apps/ and packages/, by name. */
function workspacePackages(root) {
  const packages = new Map();
  for (const group of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = readdirSync(path.join(root, group), { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const json = JSON.parse(
          readFileSync(path.join(root, group, entry.name, "package.json"), "utf8"),
        );
        packages.set(json.name, { dir: `${group}/${entry.name}/`, json });
      } catch {}
    }
  }
  return packages;
}

/** Repository-relative source files under a directory, skipping build output and tests. */
function sourcesUnder(root, directory) {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(path.join(root, directory), { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    const relative = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourcesUnder(root, `${relative}/`));
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) files.push(relative);
  }
  return files;
}

/** The string literals in a source file's code, not its comments. */
function stringLiterals(file, text) {
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return literals;
}

function kind(root, relative) {
  try {
    const stats = statSync(path.join(root, relative));
    return stats.isDirectory() ? "directory" : "file";
  } catch {
    return undefined;
  }
}

/**
 * The repository path a string literal in `file` names, if any: a relative import or path
 * (`../../scripts/database/lib.mjs`, a `.js` specifier for its `.ts` source), or a path from the
 * repository root (`scripts/dev-world.mjs`, `db/migrations`) as spawned scripts and read
 * directories are named. A directory counts only below the top level, so `../../` or `worlds`
 * alone is no path the journey exercises.
 */
function namedPath(root, file, literal) {
  if (!/^[\w@.][\w@./-]*$/u.test(literal) || !literal.includes("/")) return undefined;
  const base = literal.startsWith(".") ? path.posix.dirname(file) : "";
  const relative = path.posix.normalize(path.posix.join(base, literal)).replace(/\/$/u, "");
  if (relative.startsWith("..") || relative === "." || relative.split("/").includes("node_modules"))
    return undefined;
  const candidates = [relative];
  if (/\.[cm]?js$/u.test(relative)) candidates.push(relative.replace(/js$/u, "ts"));
  if (!/\.[a-z]+$/u.test(relative))
    candidates.push(`${relative}.ts`, `${relative}.mjs`, `${relative}.js`, `${relative}/index.ts`);
  for (const candidate of candidates) {
    const found = kind(root, candidate);
    if (found === "file") return { file: candidate };
    if (found === "directory" && candidate.split("/").length >= 2)
      return { directory: `${candidate}/` };
  }
  return undefined;
}

/**
 * Repository-relative path prefixes and files the browser journey exercises. It starts from the
 * apps the journey serves (`apps/web`, `apps/runtime`), the browser config and every test it
 * includes, and follows what each source loads: workspace packages by name, relative imports, and
 * the repository paths it names, such as a script it spawns or migrations it applies. A workspace
 * package reached is in scope whole, with its own package.json dependencies, and its sources
 * (not its tests) are followed; a file of it reached by path, such as a test harness, is followed
 * too.
 */
export function journeyPaths(root) {
  const packages = workspacePackages(root);
  const paths = new Set(["worlds/fixture/", "tests/e2e/", BROWSER_CONFIG]);
  const seenPackages = new Set();
  const seenFiles = new Set();
  const queue = [];
  const visitPackage = (name) => {
    const pkg = packages.get(name);
    if (!pkg || seenPackages.has(name)) return;
    seenPackages.add(name);
    paths.add(pkg.dir);
    queue.push(...sourcesUnder(root, pkg.dir));
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, range] of Object.entries(pkg.json[field] ?? {}))
        if (String(range).startsWith("workspace:")) visitPackage(dependency);
  };
  const visitPath = (relative) => {
    // Another suite's test or config named in a shard list or a vitest run is not the journey's.
    const name = path.posix.basename(relative);
    if (TEST.test(name) && !name.includes(".journey.browser.test.")) return;
    const owner = [...packages.entries()].find(([, pkg]) => relative.startsWith(pkg.dir));
    if (owner) {
      // A file of a package reached by path is followed; a directory in it adds nothing more.
      visitPackage(owner[0]);
      if (!relative.endsWith("/")) queue.push(relative);
    } else if (relative.endsWith("/")) {
      paths.add(relative);
      queue.push(...sourcesUnder(root, relative));
    } else {
      paths.add(relative);
      queue.push(relative);
    }
  };
  visitPackage("@clockgrove/web");
  visitPackage("@clockgrove/runtime");
  paths.add(BROWSER_CONFIG);
  queue.push(BROWSER_CONFIG);
  while (queue.length > 0) {
    const file = queue.pop();
    if (seenFiles.has(file) || !SOURCE.test(file)) continue;
    seenFiles.add(file);
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const literal of stringLiterals(file, text)) {
      const workspace = /^(@clockgrove\/[\w.-]+)/u.exec(literal);
      if (workspace) {
        visitPackage(workspace[1]);
        continue;
      }
      const named = namedPath(root, file, literal);
      if (named && !paths.has(named.file ?? named.directory))
        visitPath(named.file ?? named.directory);
    }
  }
  paths.add("package.json").add("pnpm-lock.yaml").add("pnpm-workspace.yaml");
  return [...paths].sort();
}

/** The changed files the journey exercises, each with the path that puts it in scope. */
export function journeyReasons(files, paths) {
  const reasons = [];
  for (const file of files) {
    if (file.endsWith(".md")) continue;
    const match = paths.find((entry) =>
      entry.endsWith("/") ? file.startsWith(entry) : file === entry,
    );
    if (match) reasons.push({ file, because: match });
    else if (file.includes(".journey.browser.test."))
      reasons.push({ file, because: "a browser journey test" });
  }
  return reasons;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function changedFiles(root, base) {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const files = new Set(git(root, ["diff", "--name-only", mergeBase]).split("\n"));
  for (const line of git(root, ["status", "--porcelain", "--untracked-files=all"]).split("\n")) {
    if (!line) continue;
    const name = line.slice(3);
    files.add(name.includes(" -> ") ? name.split(" -> ")[1] : name);
  }
  files.delete("");
  return [...files].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let files;
  try {
    files = changedFiles(root, process.argv[2] ?? "origin/main");
  } catch (error) {
    console.error(`journey-scope: git failed: ${error.message}`);
    process.exit(2);
  }
  const reasons = journeyReasons(files, journeyPaths(root));
  for (const { file, because } of reasons) console.log(`${file}: in ${because}`);
  console.log(`browser journey: ${reasons.length > 0 ? "required" : "not required"}`);
}
