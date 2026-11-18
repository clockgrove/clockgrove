import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommand } from "./canonical-commands.mjs";
import { assertRuntimePartition, partitionRuntimeFiles } from "./runtime-shards.mjs";

// Quality runs the browser journeys (tests/ci/vitest.browser.config.ts) as `browserShardCount`
// shards, each on its own runner, the way runtime-shards.mjs shards test:runtime. A shard names its
// files and keeps the config's one-file-at-a-time order. Files are packed greedily, longest first,
// by the seconds in browser-shard-durations.json (a file it does not list counts as their mean), so
// a stale entry only unbalances the shards. The quality job recomputes the partition and accepts the
// shard receipts in place of the one browser receipt only when every file the config lists is in
// exactly one shard and Vitest lists exactly those files for it. Decision: four shards. Issue 405
// measured the single browser job at 32 m (2026-11-17), and the durations, measured file by file on
// 2026-11-18, total ~25 m. A shard is whole files, so dev-world (~7.5 m) and living-hall (~7 m) each
// take a shard and bound the slowest one; the other eight fill two shards of ~5.5 m.
export const browserShardCount = 4;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const durationsFile = path.join(root, "scripts/ci/browser-shard-durations.json");
const shardReceipt = /^browser-\d+-of-(\d+)\.result\.json$/u;

export const browserShardLabel = (index, count) => `browser-${index}-of-${count}`;
export const browserShardCommand = (files) => [...browserCommand, ...files];
export const browserShardCommands = ({ shards }) =>
  shards.map((files, index) => [
    browserShardLabel(index + 1, shards.length),
    browserShardCommand(files),
  ]);
// The files the browser config runs for `names`, from Vitest's own listing; no names is the whole
// config. The config throws without CI=true; listing launches no browser. Memoised as runtimeFiles is.
const listings = new Map();
export function browserFiles(names = []) {
  const key = JSON.stringify(names);
  if (!listings.has(key)) listings.set(key, listBrowserFiles(names));
  return [...listings.get(key)];
}
function listBrowserFiles(names) {
  const listed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        ...names,
        "--config",
        "tests/ci/vitest.browser.config.ts",
        "--filesOnly",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } },
    ),
  );
  return listed.map(({ file }) => path.relative(root, file)).sort();
}
export async function browserShards(count = browserShardCount, listFiles = browserFiles) {
  const durations = JSON.parse(await readFile(durationsFile, "utf8"));
  const files = listFiles();
  const shards = partitionRuntimeFiles(files, durations, count);
  assertRuntimePartition(files, shards);
  for (const shard of shards)
    assert.deepEqual(listFiles(shard), shard, "every browser shard runs exactly its files");
  return { files, shards };
}
// The shard set whose receipts `directory` holds, with each shard's [label, command].
export async function recordedBrowserShards(directory) {
  const names = (await readdir(directory)).filter((name) => shardReceipt.test(name));
  const counts = new Set(names.map((name) => name.match(shardReceipt)[1]));
  assert(counts.size <= 1, "browser shard receipts disagree on the shard count");
  if (counts.size === 0) return { browser: null, commands: [] };
  const browser = await browserShards(Number([...counts][0]));
  const commands = browserShardCommands(browser);
  for (const name of names)
    assert(
      commands.some(([label]) => `${label}.result.json` === name),
      `unknown browser shard receipt: ${name}`,
    );
  return { browser, commands };
}
// `node scripts/ci/browser-shards.mjs <report.json>` rewrites the durations from the Vitest JSON
// report of a whole browser run (`--reporter=json --outputFile=<report.json>`).
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
