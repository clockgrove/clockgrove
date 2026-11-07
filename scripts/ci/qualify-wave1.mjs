#!/usr/bin/env node
// Builds and validates the Wave 1 evidence manifest (plan §13).
// Usage: pnpm run qualify:wave1 [--qualification <dir>] [--long-runs <dir>] [--out <dir>]
// --qualification is the qualification job's evidence directory (canonical, test:long-run and
// qualify:wave0 receipts); --long-runs is the qualify:wave1:long-runs evidence directory. Missing
// evidence stays missing or pending. Exit 0 when the manifest validates, whatever the exit decision.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "./evidence.mjs";
import {
  buildWave1Manifest,
  MANIFEST_FILE,
  validateWave1Manifest,
} from "./qualify-wave1-manifest.mjs";

const options = { qualification: null, "long-runs": null, out: null };
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

await import("../../packages/simulator/cli/typescript-hooks.mjs");
const { decodeCanonicalBytes } = await import("../../packages/simulator/src/canonical-decode.ts");
const decode = (bytes) => {
  const decoded = decodeCanonicalBytes(new Uint8Array(bytes));
  assert(decoded.ok, "a bundle is not canonical bytes");
  return decoded.value;
};

const manifest = await buildWave1Manifest({
  root,
  qualificationDirectory: options.qualification,
  longRunDirectory: options["long-runs"],
  execution: {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  decode,
});
await validateWave1Manifest(manifest, root);
const out = options.out ?? (await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave1-manifest-")));
await mkdir(out, { recursive: true });
await access(path.join(out, MANIFEST_FILE)).then(
  () => {
    throw new Error("refuse overwriting a prior Wave 1 manifest; use a separately owned directory");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
for (const entry of manifest.exitChecklist)
  process.stdout.write(`${entry.disposition.padEnd(7)} ${entry.item}\n`);
process.stdout.write(
  `exit decision: ${manifest.exitDecision.status}\nWave 1 evidence manifest: ${path.join(out, MANIFEST_FILE)}\n`,
);
