import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repositoryRoot } from "./lib.mjs";

// Captures the prior-release database fixture of a release tag into db/fixtures/prior/<tag>:
// the tag is checked out in a temporary worktree, and its own code migrates a fresh cluster,
// provisions a world and runs one committed scenario through the Journal (apps/runtime/test/prior-release.ts
// and scripts/database/prior-fixtures.mjs, copied from this checkout). Usage: node scripts/database/capture-prior-release.mjs <tag>

const tag = process.argv[2];
if (!tag || !/^[\w.-]+$/u.test(tag)) throw new Error("usage: capture-prior-release.mjs <tag>");
const git = (...args) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const commit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
const output = path.join(repositoryRoot, "db/fixtures/prior", tag);
const temporary = await mkdtemp(path.join(os.tmpdir(), "clockgrove-prior-release-"));
const checkout = path.join(temporary, "repository");
const inCheckout = (command, args) =>
  execFileSync(command, args, { cwd: checkout, stdio: "inherit" });

git("worktree", "add", "--detach", checkout, commit);
try {
  inCheckout("pnpm", ["install", "--frozen-lockfile"]);
  const test = path.join(checkout, "apps/runtime/test");
  for (const file of ["apps/runtime/test/prior-release.ts", "scripts/database/prior-fixtures.mjs"])
    await copyFile(path.join(repositoryRoot, file), path.join(checkout, file));
  await writeFile(
    path.join(test, "prior-release-capture.test.ts"),
    `import { it } from "vitest";
import { capturePriorRelease } from "./prior-release.js";
it("captures ${tag}", () => capturePriorRelease(${JSON.stringify(output)}, "${tag}", "${commit}"), 300_000);
`,
  );
  inCheckout("pnpm", [
    "exec",
    "vitest",
    "run",
    "--config",
    "apps/runtime/vitest.runtime.config.ts",
    "apps/runtime/test/prior-release-capture.test.ts",
  ]);
} finally {
  git("worktree", "remove", "--force", checkout);
  await rm(temporary, { recursive: true, force: true });
}
console.log(`captured ${tag} (${commit}) into ${path.relative(repositoryRoot, output)}`);
