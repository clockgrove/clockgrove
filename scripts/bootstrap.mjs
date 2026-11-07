import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalCommands } from "./ci/canonical-commands.mjs";
import { digest, fileInventory, recordCommand, root } from "./ci/evidence.mjs";
import { runtimeShards, shardCommands } from "./ci/runtime-shards.mjs";
import { discoverPostgresTools } from "./database/lib.mjs";

export { canonicalCommands };
export async function verifyLfs(directory = root) {
  const names = execFileSync("git", ["lfs", "ls-files", "--name-only"], {
    cwd: directory,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(names.length, "required LFS inventory missing");
  for (const name of names) {
    assert.equal(
      execFileSync("git", ["check-attr", "filter", "--", name], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
      `${name}: filter: lfs`,
      "required LFS attribute changed",
    );
    const pointer = execFileSync("git", ["show", `HEAD:${name}`], {
      cwd: directory,
      encoding: "utf8",
    });
    const oid = pointer.match(/^oid sha256:([a-f0-9]{64})$/mu)?.[1];
    const size = pointer.match(/^size (\d+)$/mu)?.[1];
    const bytes = await readFile(path.join(directory, name));
    assert.equal(digest(bytes), `sha256:${oid}`, `hydrate required LFS input: ${name}`);
    assert.equal(bytes.length, Number(size), `LFS size mismatch: ${name}`);
    if (name === "assets/brand/clockgrove/master/clockgrove-approved-original.png") {
      assert.equal(
        digest(bytes),
        "sha256:d6608b8fcc0b6710a4be3195235d84398a4795f6ced6b16cd4c14392df51225a",
      );
      assert.equal(bytes.length, 2238479);
    }
  }
}
export async function prerequisites() {
  assert.equal(process.platform, "linux", "supported Linux host required");
  assert.equal(process.versions.node, "24.21.0", "Node 24.21.0 required");
  assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), "12.9.1");
  for (const [tool, args] of [
    ["corepack", ["--version"]],
    ["python3", ["--version"]],
    ["git", ["--version"]],
    ["git-lfs", ["--version"]],
    ["curl", ["--version"]],
  ])
    execFileSync(tool, args, { stdio: "pipe" });
  assert.match(execFileSync("tofu", ["version"], { encoding: "utf8" }), /^OpenTofu v1\.13\.1\b/u);
  await discoverPostgresTools();
  await verifyLfs();
}
// `names` selects a share of the canonical commands, in canonical order. Quality's parallel jobs
// each record one share; its quality job merges every share's receipts into one manifest.
export async function bootstrap(directory, names = canonicalCommands.map(([name]) => name)) {
  assert(path.isAbsolute(directory), "explicit absolute evidence directory required");
  for (const name of names)
    assert(
      canonicalCommands.some(([canonical]) => canonical === name),
      `unknown canonical command: ${name}`,
    );
  await mkdir(directory, { recursive: true });
  await prerequisites();
  let failure = 0;
  for (const [name, command] of canonicalCommands.filter(([name]) => names.includes(name))) {
    // Preserve Quality's always-run runtime and supply-chain failure evidence.
    if (failure !== 0 && !["test-runtime", "supply-chain"].includes(name)) continue;
    const code = await recordCommand(directory, name, command);
    if (code !== 0 && failure === 0) failure = code;
  }
  return failure;
}
// One of Quality's test:runtime shards (scripts/ci/runtime-shards.mjs), recorded as its own receipt.
export async function runtimeShard(directory, index) {
  assert(path.isAbsolute(directory), "explicit absolute evidence directory required");
  const runtime = await runtimeShards();
  const shard = shardCommands(runtime)[index - 1];
  assert(shard, `unknown runtime shard: ${index}`);
  await mkdir(directory, { recursive: true });
  await prerequisites();
  return recordCommand(directory, ...shard);
}
export async function disposeDerived() {
  const outputs = [
    "node_modules",
    ".turbo",
    "apps/web/dist",
    "apps/runtime/dist",
    "apps/runtime/.wrangler",
  ];
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory())
        for (const leaf of ["node_modules", ".turbo"])
          outputs.push(`${parent}/${entry.name}/${leaf}`);
    }
  }
  for (const output of outputs) {
    assert.equal(
      execFileSync("git", ["ls-files", "--", output], { cwd: root, encoding: "utf8" }),
      "",
      "refuse deletion of tracked source",
    );
    const target = path.join(root, output);
    const info = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    assert(!info?.isSymbolicLink(), "refuse disposable output symlink");
    await rm(target, { recursive: true, force: true });
  }
  return outputs;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? process.env.CI_EVIDENCE_DIR;
  assert(directory, "supply an owned absolute evidence directory");
  const only = process.argv[3] === "--only" ? process.argv[4]?.split(",") : undefined;
  assert(process.argv[3] !== "--only" || only?.length, "--only requires command names");
  process.exitCode =
    process.argv[3] === "--runtime-shard"
      ? await runtimeShard(directory, Number(process.argv[4]))
      : await bootstrap(directory, only);
  if (process.exitCode === 0 && process.argv[3] === "--dispose-derived") {
    // Evidence must live outside this isolated source root; previous receipts stay intact.
    assert(
      !path.resolve(directory).startsWith(`${root}${path.sep}`),
      "disposal journey evidence must be outside source",
    );
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
      .toString()
      .split("\0")
      .filter(Boolean);
    const sourceDigest = async () =>
      digest(
        JSON.stringify(
          await Promise.all(
            tracked.map(async (name) => [name, digest(await readFile(path.join(root, name)))]),
          ),
        ),
      );
    const before = await sourceDigest();
    const prior = await fileInventory(directory);
    const deleted = await disposeDerived();
    await verifyLfs();
    assert.equal(await sourceDigest(), before, "disposal altered source or hydrated LFS bytes");
    assert.deepEqual(await fileInventory(directory), prior, "disposal altered prior evidence");
    process.exitCode = await bootstrap(path.join(directory, "after-disposal"));
    assert.equal(
      await sourceDigest(),
      before,
      "repeated bootstrap altered source or hydrated LFS bytes",
    );
    if (process.exitCode === 0)
      await writeFile(
        path.join(directory, "bootstrap.json"),
        JSON.stringify({
          commit: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          deleted,
          sourceDigest: before,
          priorEvidenceDigest: digest(JSON.stringify(prior)),
          repetitions: 1,
          preserved: ["source", "hydrated LFS", "prior evidence"],
        }),
      );
  }
}
