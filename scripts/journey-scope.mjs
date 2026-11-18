// Says whether a change is in what the browser journey exercises (AGENTS.md, Validation and
// completion). Informational: it prints reasons and a verdict and exits 0; 2 means git failed.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_CONFIG = "tests/ci/vitest.browser.config.ts";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

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

/** Repository-relative path prefixes the browser journey exercises. */
export function journeyPaths(root) {
  const packages = workspacePackages(root);
  const seen = new Set();
  const queue = ["@clockgrove/web", "@clockgrove/runtime"];
  while (queue.length > 0) {
    const name = queue.pop();
    const pkg = packages.get(name);
    if (!pkg || seen.has(name)) continue;
    seen.add(name);
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, range] of Object.entries(pkg.json[field] ?? {}))
        if (String(range).startsWith("workspace:")) queue.push(dependency);
  }
  const paths = ["apps/web/", "apps/runtime/", "worlds/fixture/", "tests/e2e/", BROWSER_CONFIG];
  for (const name of seen) paths.push(packages.get(name).dir);
  const config = readFileSync(path.join(root, BROWSER_CONFIG), "utf8");
  for (const [, included] of config.matchAll(/"([^"\s]+\.test\.[a-z]+)"/g)) paths.push(included);
  paths.push("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml");
  return [...new Set(paths)];
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
