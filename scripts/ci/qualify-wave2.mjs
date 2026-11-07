#!/usr/bin/env node
// Builds and validates the Wave 2 evidence manifest (plan §19).
// Usage: pnpm run qualify:wave2 [--qualification <dir>] [--wave2 <dir>] [--out <dir>]
// --qualification is the Qualification job's evidence directory (the canonical, test:long-run and
// qualify:wave0 receipts); --wave2 is its CLOCKGROVE_WAVE2_EVIDENCE directory (test:db's per-case
// report and the journal long-run results). Missing evidence stays missing or pending. Exit 0 when the manifest validates, whatever the exit decision.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMigrations, withDisposableDatabase } from "../database/lib.mjs";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { digest, root } from "./evidence.mjs";
import {
  buildWave2Manifest,
  MANIFEST_FILE,
  validateWave2Manifest,
} from "./qualify-wave2-manifest.mjs";

const options = { qualification: null, wave2: null, out: null };
// pnpm 12 forwards a literal `--` separator to the script.
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
for (let index = 0; index < argv.length; index += 2) {
  const name = argv[index]?.replace(/^--/u, "");
  assert(
    Object.hasOwn(options, name) && argv[index].startsWith("--"),
    `unknown argument ${argv[index]}`,
  );
  assert(argv[index + 1], `--${name} needs a directory`);
  options[name] = path.resolve(argv[index + 1]);
}

/**
 * The schema identity: `pg_dump --schema-only` of a fresh database migrated to head, with SQL comment
 * lines (host build strings, object headers) removed. A fixed restrict key keeps the dump stable.
 */
let schema;
await withDisposableDatabase(async ({ tools, environment }) => {
  await applyMigrations(tools, environment);
  const dumped = await ownedSubprocess(
    tools.pg_dump,
    ["--schema-only", "--restrict-key=clockgrove"],
    { env: environment, maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(dumped.status, 0, `pg_dump failed: ${dumped.stderr}`);
  const statements = dumped.stdout
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  schema = {
    hash: digest(statements),
    method: "pg_dump --schema-only of a fresh database migrated to head, comment lines removed",
    postgres: (await ownedSubprocess(tools.pg_dump, ["--version"])).stdout.trim(),
  };
});

await import("../../packages/simulator/cli/typescript-hooks.mjs");
const { decodeCanonicalBytes } = await import("../../packages/simulator/src/canonical-decode.ts");
const decode = (bytes) => {
  const decoded = decodeCanonicalBytes(new Uint8Array(bytes));
  assert(decoded.ok, "a golden is not canonical bytes");
  return decoded.value;
};

const manifest = await buildWave2Manifest({
  root,
  qualificationDirectory: options.qualification,
  wave2Directory: options.wave2,
  execution: {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  schema,
  decode,
});
await validateWave2Manifest(manifest, root);
const out = options.out ?? (await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave2-manifest-")));
await mkdir(out, { recursive: true });
await access(path.join(out, MANIFEST_FILE)).then(
  () => {
    throw new Error("refuse overwriting a prior Wave 2 manifest; use a separately owned directory");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
for (const entry of manifest.exitChecklist)
  process.stdout.write(`${entry.disposition.padEnd(8)} ${entry.item}\n`);
for (const entry of manifest.journal.performance)
  process.stdout.write(
    `${entry.pack}/${entry.scenario}:${entry.run}: replay ${entry.replay.eventsPerSecond} events/s, journal p50 ${entry.journalLatencyMs.p50} ms p95 ${entry.journalLatencyMs.p95} ms per call\n`,
  );
process.stdout.write(
  `exit decision: ${manifest.exitDecision.status}\nWave 2 evidence manifest: ${path.join(out, MANIFEST_FILE)}\n`,
);
