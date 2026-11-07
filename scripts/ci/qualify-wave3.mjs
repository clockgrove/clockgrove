#!/usr/bin/env node
// Builds and validates the Wave 3 evidence manifest (plan §23).
// Usage: pnpm run qualify:wave3 [--qualification <dir>] [--load-curves <dir>] [--out <dir>]
// --qualification is the Qualification job's evidence directory (the canonical, test:long-run and
// qualify:wave0 receipts and their logs); --load-curves is the wave3-load-curves job's evidence
// directory (its receipt and wave3-load-curves.json). Missing evidence stays missing or pending, and
// hosted items stay pending. Exit 0 when the manifest validates, whatever the exit decision.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMigrations, withDisposableDatabase } from "../database/lib.mjs";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { digest, root } from "./evidence.mjs";
import {
  buildWave3Manifest,
  MANIFEST_FILE,
  validateWave3Manifest,
} from "./qualify-wave3-manifest.mjs";

const options = { qualification: null, "load-curves": null, out: null };
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

/** The schema identity, measured as qualify:wave2 measures it (scripts/ci/qualify-wave2.mjs). */
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

const manifest = await buildWave3Manifest({
  root,
  qualificationDirectory: options.qualification,
  loadCurveDirectory: options["load-curves"],
  execution: {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  schema,
  decode,
});
await validateWave3Manifest(manifest, root, decode);
const out = options.out ?? (await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave3-manifest-")));
await mkdir(out, { recursive: true });
await access(path.join(out, MANIFEST_FILE)).then(
  () => {
    throw new Error("refuse overwriting a prior Wave 3 manifest; use a separately owned directory");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
for (const entry of manifest.exitChecklist)
  process.stdout.write(
    `${entry.disposition.padEnd(8)} ${entry.item}${entry.pending?.issues.length ? ` (${entry.pending.issues.map((issue) => `#${issue}`).join(", ")})` : ""}\n`,
  );
for (const entry of manifest.cloudQualification)
  process.stdout.write(`${entry.disposition.padEnd(8)} §18.2 ${entry.item}\n`);
const { scenarios, loadCurves } = manifest;
process.stdout.write(
  `native scenario parity: ${scenarios.status}, ${scenarios.runs.filter((run) => run.matches).length}/${scenarios.goldens.length} golden runs and ${scenarios.soak.length} soak runs matched\n`,
);
process.stdout.write(`load curves: ${loadCurves.status}\n`);
for (const budget of loadCurves.budgets ?? [])
  process.stdout.write(
    `  ${budget.name}: ${budget.disposition.status}${budget.disposition.issues?.length ? ` (#${budget.disposition.issues.join(", #")})` : ""}\n`,
  );
process.stdout.write(
  `exit decision: ${manifest.exitDecision.status}\nWave 3 evidence manifest: ${path.join(out, MANIFEST_FILE)}\n`,
);
