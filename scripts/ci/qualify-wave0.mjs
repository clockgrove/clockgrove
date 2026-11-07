import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalCommands, verifyLfs } from "../bootstrap.mjs";
import {
  browserCommand,
  localRecoveryCommand,
  nativeRecoveryCommand,
} from "./canonical-commands.mjs";
import {
  collectEvidence,
  digest,
  fileInventory,
  readPassingReceipt,
  recordCommand,
  root,
} from "./evidence.mjs";
import { recordedRuntimeShards } from "./runtime-shards.mjs";

const strictCi = process.env.GITHUB_ACTIONS === "true";
const suppliedDirectory = process.env.CI_EVIDENCE_DIR;
assert(!strictCi || suppliedDirectory, "CI qualification requires actual bootstrap receipts");
assert(
  !suppliedDirectory || path.isAbsolute(suppliedDirectory),
  "absolute evidence directory required",
);
const directory =
  suppliedDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "clockgrove-local-evidence-")));
await mkdir(directory, { recursive: true });
const pending = [];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
if (strictCi) {
  assert(/^[1-9]\d*$/u.test(process.env.GITHUB_RUN_ID ?? ""), "actual CI run identity required");
  assert(
    /^[1-9]\d*$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? ""),
    "actual CI run attempt required",
  );
  assert.equal(process.env.GITHUB_SHA, commit, "actual CI candidate identity required");
  await readPassingReceipt(directory, "browser", { commit, tree }, browserCommand);
  await readPassingReceipt(directory, "build", { commit, tree }, [
    "node",
    "scripts/ci/build.mjs",
    path.join(directory, "build"),
  ]);
}
const ciFiles = strictCi ? await fileInventory(path.join(directory, "build")) : null;
if (strictCi)
  assert(
    ciFiles.length &&
      ciFiles.some((file) => file.path.startsWith("worker/")) &&
      ciFiles.some((file) => file.path.startsWith("web/")),
    "complete actual CI build inventory required",
  );
assert.equal(
  git("status", "--porcelain", "--untracked-files=normal"),
  "",
  "freeze a clean candidate before qualification",
);
// Quality records test:runtime as shards; then every shard's receipt replaces the single one.
const { commands: runtimeShardCommands } = await recordedRuntimeShards(directory);
for (const [name, command] of canonicalCommands.flatMap((entry) =>
  entry[0] === "test-runtime" && runtimeShardCommands.length ? runtimeShardCommands : [entry],
)) {
  const bytes = await readFile(path.join(directory, `${name}.result.json`), "utf8").catch(
    (error) => {
      if (error.code !== "ENOENT" || strictCi) throw error;
      pending.push(`Actual canonical bootstrap receipt: ${name}`);
      return null;
    },
  );
  if (bytes === null) continue;
  await readPassingReceipt(directory, name, { commit, tree }, command);
}
// Quality runs one pass; only the qualification workflow runs the disposal journey.
const bootstrapBytes = await readFile(path.join(directory, "bootstrap.json"), "utf8").catch(
  (error) => {
    if (error.code !== "ENOENT") throw error;
    pending.push("Actual isolated bootstrap/disposal proof at the published candidate");
    return null;
  },
);
if (bootstrapBytes !== null) {
  const bootstrapProof = JSON.parse(bootstrapBytes);
  assert.equal(bootstrapProof.commit, commit, "isolated bootstrap candidate mismatch");
  assert.equal(bootstrapProof.tree, tree, "isolated bootstrap tree mismatch");
  assert.equal(bootstrapProof.repetitions, 1, "isolated disposal/bootstrap journey required");
}
const lfsNames = git("lfs", "ls-files", "--name-only").split("\n").filter(Boolean);
let hydrated = true;
for (const name of lfsNames) {
  const bytes = await readFile(path.join(root, name));
  if (bytes.toString("utf8", 0, 64).startsWith("version https://git-lfs.github.com/spec/v1\n"))
    hydrated = false;
}
assert(!strictCi || hydrated, "CI qualification requires hydrated approved LFS inputs");
if (hydrated) await verifyLfs();
else
  pending.push(
    "Hydrated approved LFS inputs and two independent complete source/build inventories in Quality",
  );
process.env.WAVE0_RECOVERY = "1";
assert.equal(
  await recordCommand(directory, "local-recovery", localRecoveryCommand),
  0,
  "real restored-history recovery failed",
);
process.env.WAVE0_NATIVE_RECOVERY = "1";
try {
  assert.equal(
    await recordCommand(directory, "native-recovery", nativeRecoveryCommand),
    0,
    "native runtime recovery failed",
  );
} finally {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct uncached Vitest journey outside Turbo
  delete process.env.WAVE0_NATIVE_RECOVERY;
}
// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct uncached Vitest journey outside Turbo
delete process.env.WAVE0_RECOVERY;
if (hydrated) {
  const owner = await mkdtemp(path.join(os.tmpdir(), "clockgrove-reproduction-"));
  try {
    const builds = [];
    for (const label of ["left", "right"]) {
      const source = path.join(owner, label);
      // Local object-only clone; no credential, remote, hook, LFS download or shared worktree mutation.
      execFileSync(
        "git",
        ["-c", "credential.helper=", "clone", "--no-hardlinks", "--no-checkout", root, source],
        { stdio: "pipe" },
      );
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], {
        cwd: source,
        stdio: "pipe",
        env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      });
      const lfs = git("lfs", "ls-files", "--name-only").split("\n").filter(Boolean);
      for (const name of lfs) await cp(path.join(root, name), path.join(source, name));
      await verifyLfs(source);
      const receipts = path.join(directory, `reproduction-${label}`);
      await mkdir(receipts, { recursive: true });
      for (const [name, command] of [
        ["install", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]],
        ["build", ["node", "scripts/ci/build.mjs", path.join(owner, `${label}-build`)]],
      ]) {
        assert.equal(
          await recordCommand(directory, `reproduction-${label}-${name}`, [
            "node",
            path.join(source, "scripts/ci/evidence.mjs"),
            "run",
            receipts,
            name,
            ...command,
          ]),
          0,
          "independent source build failed",
        );
      }
      const inventory = await fileInventory(path.join(owner, `${label}-build`));
      assert(
        inventory.some((file) => file.path.startsWith("worker/")) &&
          inventory.some((file) => file.path.startsWith("web/")),
        "complete worker/web inventory required",
      );
      builds.push({ inventory, buildDigest: digest(JSON.stringify(inventory)) });
    }
    assert.deepEqual(builds[0], builds[1], "independent produced build inventories differ");
    if (strictCi)
      assert.deepEqual(
        builds[0].inventory,
        ciFiles,
        "actual CI build/reproduction inventory mismatch",
      );
    await writeFile(
      path.join(directory, "reproduction.json"),
      JSON.stringify({
        commit,
        tree,
        ...builds[0],
        comparisonInventory: builds[1].inventory,
        sourceRoots: "two independently installed owned local clones",
        ciComparison: "pending exact published candidate CI manifest at final Objective review",
      }),
    );
  } finally {
    await rm(owner, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    evidenceDirectory: directory,
    pending,
    qualification: strictCi ? "ci" : "local",
  }),
);
await collectEvidence(
  directory,
  {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  path.join(directory, "build"),
);
