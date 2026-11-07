import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Quality runs the bare `pnpm test:runtime` as `runtimeShardCount` shards, each on its own runner
//. A shard names its files and keeps the bare run's serial order (`--no-file-parallelism`):
// each native owner journey runs workerd, its own PostgreSQL cluster and a child Vitest, and they
// were never qualified running together on one runner. Files are packed greedily, longest first,
// by the seconds in runtime-shard-durations.json (a file it does not list counts as their mean), so
// a stale entry only unbalances the shards. The quality job recomputes the partition and accepts
// the shard receipts in place of the one test-runtime receipt only when every file the bare run
// lists is in exactly one shard and Vitest lists exactly those files for it. Decision: four shards; at the measured ~393 s of serial runtime
// tests on QUALITY_RUNNER (five main runs, 2026-10-31) each takes about 100 s, which keeps the
// database share under 3 minutes with each runner's ~30 s of setup.
export const runtimeShardCount = 4;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const durationsFile = path.join(root, "scripts/ci/runtime-shard-durations.json");
const shardReceipt = /^test-runtime-\d+-of-(\d+)\.result\.json$/u;

export const runtimeShardLabel = (index, count) => `test-runtime-${index}-of-${count}`;
export const runtimeShardCommand = (files) => [
  "pnpm",
  "run",
  "test:runtime",
  "--no-file-parallelism",
  ...files,
];
export const shardCommands = ({ shards }) =>
  shards.map((files, index) => [
    runtimeShardLabel(index + 1, shards.length),
    runtimeShardCommand(files),
  ]);
// The files `pnpm test:runtime <names>` runs, from Vitest's own listing; no names is the bare run.
// The names go first: `--json` takes a following argument as the file to write its listing to.
// The tree a process checks does not change under it, so each listing spawns Vitest once per
// process: evidence collection re-derives the shards on every call and would otherwise spawn it
// once per shard each time.
const listings = new Map();
export function runtimeFiles(names = []) {
  const key = JSON.stringify(names);
  if (!listings.has(key)) listings.set(key, listRuntimeFiles(names));
  return [...listings.get(key)];
}
function listRuntimeFiles(names) {
  const listed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        ...names,
        "--config",
        "apps/runtime/vitest.runtime.config.ts",
        "--filesOnly",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  return listed.map(({ file }) => path.relative(root, file)).sort();
}
export function partitionRuntimeFiles(files, durations, count) {
  const known = files.filter((file) => Object.hasOwn(durations, file));
  const mean = known.reduce((sum, file) => sum + durations[file], 0) / (known.length || 1);
  const seconds = (file) => (Object.hasOwn(durations, file) ? durations[file] : mean);
  const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  for (const file of [...files].sort(
    (left, right) => seconds(right) - seconds(left) || left.localeCompare(right, "en"),
  )) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.seconds += seconds(file);
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files.sort());
}
export function assertRuntimePartition(files, shards) {
  assert(
    shards.every((shard) => shard.length > 0),
    "every runtime shard names a file; an empty one would run the whole bare test:runtime",
  );
  assert.deepEqual(
    shards.flat().sort(),
    [...files].sort(),
    "every runtime test file runs in exactly one shard",
  );
}
// Vitest runs every included file whose path contains a name, test:db's files among them once a
// run names files, so each shard must also list exactly its own files.
export async function runtimeShards(count = runtimeShardCount, listFiles = runtimeFiles) {
  const durations = JSON.parse(await readFile(durationsFile, "utf8"));
  const files = listFiles();
  const shards = partitionRuntimeFiles(files, durations, count);
  assertRuntimePartition(files, shards);
  for (const shard of shards)
    assert.deepEqual(listFiles(shard), shard, "every runtime shard runs exactly its files");
  return { files, shards };
}
// The shard set whose receipts `directory` holds, with each shard's [label, command].
export async function recordedRuntimeShards(directory) {
  const names = (await readdir(directory)).filter((name) => shardReceipt.test(name));
  const counts = new Set(names.map((name) => name.match(shardReceipt)[1]));
  assert(counts.size <= 1, "runtime shard receipts disagree on the shard count");
  if (counts.size === 0) return { runtime: null, commands: [] };
  const runtime = await runtimeShards(Number([...counts][0]));
  const commands = shardCommands(runtime);
  for (const name of names)
    assert(
      commands.some(([label]) => `${label}.result.json` === name),
      `unknown runtime shard receipt: ${name}`,
    );
  return { runtime, commands };
}
// `node scripts/ci/runtime-shards.mjs <report.json>` rewrites the durations from the Vitest JSON
// report of a bare, serial test:runtime run (`--reporter=json --outputFile=<report.json>`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], "utf8"));
  const durations = report.testResults
    .map((result) => [
      path.relative(root, result.name),
      Math.round((result.endTime - result.startTime) / 100) / 10,
    ])
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  await writeFile(durationsFile, `${JSON.stringify(Object.fromEntries(durations), null, 2)}\n`);
}
