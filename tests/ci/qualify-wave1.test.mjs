// The Wave 1 evidence manifest claims no more than its receipts show: receipts alone pass only the
// item they prove, every other item stays pending, and tampered receipts or an upgraded disposition
// are refused.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decodeCanonicalBytes } from "../../packages/simulator/src/canonical-decode.ts";
import { digest } from "../../scripts/ci/evidence.mjs";
import {
  buildWave1Manifest,
  literalChecklist,
  RECEIPTS,
  validateWave1Manifest,
} from "../../scripts/ci/qualify-wave1-manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let directory;

async function writeReceipt(name, command, overrides = {}) {
  const log = `${name} ok\n`;
  await writeFile(path.join(directory, `${name}.log`), log);
  await writeFile(
    path.join(directory, `${name}.result.json`),
    JSON.stringify({
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      usage: null,
      command,
      exitCode: 0,
      status: "passed",
      signal: null,
      errorCode: null,
      startedAt: "2026-10-19T00:00:00.000Z",
      completedAt: "2026-10-19T00:00:01.000Z",
      outputDigest: digest(log),
      ...overrides,
    }),
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave1-manifest-test-"));
  for (const [name, command] of RECEIPTS) await writeReceipt(name, command);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const build = () =>
  buildWave1Manifest({
    root,
    qualificationDirectory: directory,
    longRunDirectory: null,
    execution: { provider: "local", runId: null, runAttempt: null },
    decode: (bytes) => decodeCanonicalBytes(new Uint8Array(bytes)).value,
  });

it("passes only what receipts show and refuses an upgraded disposition or exit decision", async () => {
  const manifest = await validateWave1Manifest(await build(), root);
  const items = await literalChecklist(root);
  expect(manifest.exitChecklist.map((entry) => entry.disposition)).toEqual(
    items.map((_item, index) => (index === 2 ? "passed" : "pending")),
  );
  expect(manifest.exitDecision.status).toBe("not-qualified");
  const upgraded = structuredClone(manifest);
  Object.assign(upgraded.exitChecklist[6], { disposition: "passed", observed: "x", pending: null });
  await expect(validateWave1Manifest(upgraded, root)).rejects.toThrow("dispositions exceed");
  const decided = structuredClone(manifest);
  decided.exitDecision = { status: "qualified", unmet: [] };
  await expect(validateWave1Manifest(decided, root)).rejects.toThrow("exit decision");
});

it("refuses a receipt whose log, command or candidate does not match", async () => {
  const [name, command] = RECEIPTS[2];
  await writeFile(path.join(directory, `${name}.log`), "changed\n");
  await expect(build()).rejects.toThrow("receipt log mismatch");
  await writeReceipt(name, ["pnpm", "other"]);
  await expect(build()).rejects.toThrow("receipt command mismatch");
  await writeReceipt(name, command, { commit: "0".repeat(40) });
  await expect(build()).rejects.toThrow("candidate mismatch");
  await writeReceipt(name, command);
});
