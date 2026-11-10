// CI guards nothing else exercises: the contract checker refuses drift, evidence never promotes an
// unobserved or failed command to a pass, test:runtime shards run each file once and count only as
// a complete set, Quality measures a pull request against the main it merges into, and deadlines
// settle termination-resistant descendants; the license check reads SPDX expressions, npm's legacy
// licenses array and exact-version verified records.
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  collectEvidence,
  readPassingReceipt,
  recordCommand,
  validateEvidence,
} from "../../scripts/ci/evidence.mjs";
import {
  assertRuntimePartition,
  partitionRuntimeFiles,
  runtimeShards,
  shardCommands,
} from "../../scripts/ci/runtime-shards.mjs";
import { checkContractDrift } from "../../scripts/contract-drift.mjs";
import { checkLicense, componentLicenses } from "../../scripts/supply-chain.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (command, args, cwd = root) =>
  spawnSync(command, args, { cwd, encoding: "utf8", timeout: 90_000 });
const execution = { provider: "local", runId: null, runAttempt: null };
async function inTemporary(prefix, operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
// Spawns scripts/contract-drift.mjs twice and reprints every contract source.
it(
  "contract checker ignores reformatting but rejects unregenerated drift and a regenerated contract without a version bump",
  () =>
    inTemporary("clockgrove-contract-journey-", async (directory) => {
      await cp(
        path.join(root, "packages/contracts/src"),
        path.join(directory, "packages/contracts/src"),
        { recursive: true },
      );
      await cp(
        path.join(root, "scripts/contracts.generated.json"),
        path.join(directory, "scripts/contracts.generated.json"),
      );
      const baseline = await checkContractDrift(directory);
      const sources = path.join(directory, "packages/contracts/src");
      for (const name of await readdir(sources)) {
        const text = await readFile(path.join(sources, name), "utf8");
        const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        await writeFile(
          path.join(sources, name),
          ts.createPrinter({ removeComments: true }).printFile(file),
        );
      }
      expect(await checkContractDrift(directory, baseline)).toEqual(baseline);
      await writeFile(
        path.join(directory, "packages/contracts/src/drift.ts"),
        "export interface ChangedSchema { readonly newField: string }\n",
      );
      const drift = run("node", [path.join(root, "scripts/contract-drift.mjs"), directory]);
      expect(drift.status).not.toBe(0);
      expect(`${drift.stdout}${drift.stderr}`).toContain("contract drift: regenerate");
      expect(
        run("node", [path.join(root, "scripts/contract-drift.mjs"), directory, "--generate"])
          .status,
      ).toBe(0);
      const generated = await checkContractDrift(directory, baseline);
      await writeFile(
        path.join(directory, "scripts/contracts.generated.json"),
        JSON.stringify({ ...generated, version: baseline.version }),
      );
      await expect(checkContractDrift(directory, baseline)).rejects.toThrow(
        "version bump required",
      );
    }),
  60_000,
);
it(
  "evidence binds receipts to the observed command and never promotes an unobserved outcome",
  () =>
    inTemporary("clockgrove-evidence-journey-", async (directory) => {
      expect(await recordCommand(directory, "node-version", ["node", "--version"])).toBe(0);
      const manifest = await collectEvidence(directory, execution);
      const observed = await readPassingReceipt(directory, "node-version", manifest.candidate, [
        "node",
        "--version",
      ]);
      for (const mutation of [
        { tree: "0".repeat(40) },
        { exitCode: 23 },
        { signal: "SIGTERM" },
        { command: ["node", "--help"] },
      ]) {
        await writeFile(
          path.join(directory, "node-version.result.json"),
          JSON.stringify({ ...observed, ...mutation }),
        );
        await expect(
          readPassingReceipt(directory, "node-version", manifest.candidate, ["node", "--version"]),
        ).rejects.toThrow();
      }
      await writeFile(path.join(directory, "node-version.result.json"), JSON.stringify(observed));
      expect(
        await recordCommand(directory, "signal", [
          "node",
          "-e",
          'process.kill(process.pid, "SIGTERM")',
        ]),
      ).not.toBe(0);
      const killed = JSON.parse(await readFile(path.join(directory, "signal.result.json"), "utf8"));
      expect(killed).toMatchObject({ exitCode: null, status: "unknown", signal: "SIGTERM" });
      const collected = await collectEvidence(directory, execution);
      await expect(
        validateEvidence({ ...collected, commands: [{ ...killed, status: "passed" }] }),
      ).rejects.toThrow("execution outcome mismatch");
      await expect(
        validateEvidence({ ...manifest, knownRisks: ["ghp_" + "z".repeat(36)] }),
      ).rejects.toThrow("secret-shaped value detected");
      // Deployment retry evidence is held to what the deploy produces (tests/infra covers each rule).
      const publication = (status, attempt) => ({
        ...observed,
        command: ["Wrangler Worker publication"],
        status,
        exitCode: status === "passed" ? 0 : 1,
        ...(attempt ? { attempt } : {}),
      });
      await expect(
        validateEvidence({
          ...manifest,
          deployments: [
            {
              environment: "staging",
              commit: manifest.candidate.commit,
              buildDigest: `sha256:${"1".repeat(64)}`,
              status: "passed",
              phases: [publication("unknown"), publication("passed", 2)],
            },
          ],
        }),
      ).rejects.toThrow("deploy retry of a phase that is never retried");
      await expect(recordCommand(directory, "node-version", ["node", "--version"])).rejects.toThrow(
        "refuse overwriting prior command evidence",
      );
    }),
  60_000,
);
// Spawns `vitest list` once for the bare run and once per shard, serially (scripts/ci/runtime-shards.mjs):
// about 3 s idle; on a loaded Quality runner it timed out at 31 s (run 41385415754), so its budget grows with the shard count.
it(
  "test:runtime shards run every bare-run file exactly once and count only as a complete set",
  () =>
    inTemporary("clockgrove-runtime-shards-", async (directory) => {
      expect(partitionRuntimeFiles(["a", "b", "c", "d"], { a: 5, b: 4, c: 3 }, 2)).toEqual([
        ["a", "c"],
        ["b", "d"],
      ]);
      const runtime = await runtimeShards();
      const { files, shards } = runtime;
      expect(files).toContain("apps/runtime/test/native.postgres.test.ts");
      expect(files).not.toContain("apps/runtime/test/runtime.postgres.test.ts");
      const [first, ...rest] = shards;
      expect(() => assertRuntimePartition(files, [first.slice(1), ...rest])).toThrow();
      expect(() => assertRuntimePartition(files, [...shards, []])).toThrow("names a file");
      const alsoDatabase = (names) =>
        names ? [...names, "apps/runtime/test/runtime.postgres.test.ts"].sort() : files;
      await expect(runtimeShards(4, alsoDatabase)).rejects.toThrow("runs exactly its files");
      expect(shardCommands(runtime)[0][1].slice(0, 4)).toEqual([
        "pnpm",
        "run",
        "test:runtime",
        "--no-file-parallelism",
      ]);
      const missing = async () => (await collectEvidence(directory, execution)).extensions;
      for (const [index, [label, command]] of shardCommands(runtime).entries()) {
        if (index > 0) expect((await missing()).missingCommands).toContain("test:runtime");
        await recordCommand(directory, label, ["node", "--version"]);
        const file = path.join(directory, `${label}.result.json`);
        await writeFile(
          file,
          JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), command }),
        );
      }
      const manifest = await collectEvidence(directory, execution);
      expect(manifest.extensions.missingCommands).not.toContain("test:runtime");
      expect(manifest.extensions.runtimeShards).toEqual(runtime);
      const doubled = { files, shards: [[...first, rest[0][0]], ...rest] };
      await expect(
        validateEvidence({
          ...manifest,
          extensions: { ...manifest.extensions, runtimeShards: doubled },
        }),
      ).rejects.toThrow("exactly one shard");
    }),
  120_000,
);
it("Quality measures a pull request against the main its merge commit was built on, not the event's base.sha", () =>
  inTemporary("clockgrove-contract-base-", async (directory) => {
    const quality = await readFile(path.join(root, ".github/workflows/quality.yml"), "utf8");
    expect(quality).not.toContain("pull_request.base.sha");
    const scripts = [
      ...quality.matchAll(
        /Record the contract base commit\n.*\n +PUSH_BEFORE: \$\{\{ github\.event\.before \}\}\n.*run: \|\n((?: {10}.*\n)+)/gu,
      ),
    ].map(([, script]) => script);
    expect(scripts).toHaveLength(2);
    const git = (...args) =>
      run("git", ["-c", "user.name=ci", "-c", "user.email=ci@invalid", ...args], directory).stdout;
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "stale base");
    git("switch", "-c", "pr");
    git("commit", "--allow-empty", "-m", "pull request");
    git("switch", "main");
    git("commit", "--allow-empty", "-m", "main moved");
    const main = git("rev-parse", "HEAD").trim();
    git("merge", "--no-ff", "pr", "-m", "merge ref");
    const GITHUB_ENV = path.join(directory, "env");
    for (const script of scripts) {
      for (const GITHUB_EVENT_NAME of ["pull_request", "push"]) {
        const env = { ...process.env, GITHUB_EVENT_NAME, GITHUB_ENV, PUSH_BEFORE: "before" };
        expect(spawnSync("bash", ["-ec", script], { cwd: directory, env }).status).toBe(0);
      }
    }
    expect(await readFile(GITHUB_ENV, "utf8")).toBe(
      `CONTRACT_BASE_COMMIT=${main}\nCONTRACT_BASE_COMMIT=before\n`.repeat(2),
    );
  }));
it("CI deadlines settle termination-resistant descendants without promoting timeout to pass", () =>
  inTemporary("clockgrove-deadline-", async (directory) => {
    const descendant = `const net = require('node:net'); process.on('SIGTERM', () => {}); const server = net.createServer(); server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));`;
    const leader = `const { spawn } = require('node:child_process'); process.on('SIGTERM', () => process.exit(0)); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
    expect(
      await recordCommand(directory, "stalled", [process.execPath, "-e", leader], {
        timeoutMs: 500,
        killGraceMs: 100,
      }),
    ).not.toBe(0);
    const receipt = JSON.parse(await readFile(path.join(directory, "stalled.result.json"), "utf8"));
    expect(receipt).toMatchObject({ status: "unknown", errorCode: "ETIMEDOUT" });
    const observed = JSON.parse(
      (await readFile(path.join(directory, "stalled.log"), "utf8")).trim(),
    );
    const stat = await readFile(`/proc/${observed.pid}/stat`, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
    const { createConnection } = await import("node:net");
    const { once } = await import("node:events");
    const socket = createConnection({ host: "127.0.0.1", port: observed.port });
    socket.setTimeout(1_000, () => socket.destroy(new Error("owned descendant remains active")));
    try {
      expect((await once(socket, "error"))[0].code).toBe("ECONNREFUSED");
    } finally {
      socket.destroy();
    }
  }));
it("license check evaluates SPDX OR, AND, precedence and WITH, and refuses garbled expressions", () => {
  const verdict = (license) => {
    try {
      checkLicense(license, "component");
      return "allowed";
    } catch {
      return "refused";
    }
  };
  expect(
    [
      "(AFL-2.1 OR BSD-3-Clause)",
      "MIT AND AFL-2.1",
      "AFL-2.1 OR MIT AND GPL-2.0",
      "(AFL-2.1 OR MIT) AND ISC",
      "GPL-2.0 WITH Classpath-exception-2.0 OR MIT",
      "MIT WITH LLVM-exception",
      "(MIT OR ISC",
      "MIT or ISC",
      "MIT ISC",
      "SEE LICENSE IN LICENSE.md",
    ].map(verdict),
  ).toEqual([
    "allowed",
    "refused",
    "refused",
    "allowed",
    "allowed",
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
  ]);
});
it("license check reads npm's legacy licenses array and verified records for the exact version only", () => {
  const verdict = (key, metadata) => {
    try {
      checkLicense(componentLicenses(key, metadata)[0]?.expression, key);
      return "allowed";
    } catch (error) {
      return error.message.endsWith("missing dependency license") ? "missing" : "refused";
    }
  };
  const legacy = (...types) => ({ licenses: types.map((type) => ({ type, url: "x" })) });
  expect([
    verdict("format@0.2.2", legacy("MIT")),
    verdict("dual@1.0.0", legacy("GPL-2.0", "MIT")),
    verdict("gpl@1.0.0", legacy("GPL-2.0")),
    verdict("empty@1.0.0", { licenses: [] }),
    verdict("prose@1.0.0", legacy("Apache 2.0")),
    verdict("operator@1.0.0", legacy("MIT", "OR")),
    verdict("untyped@1.0.0", { licenses: [{ url: "x" }] }),
    verdict("object@1.0.0", { licenses: { type: "MIT" } }),
    verdict("@google/design.md@0.4.0", {}),
    verdict("@google/design.md@0.4.1", {}),
    verdict("@google/design.md@0.4.0", { license: "GPL-2.0" }),
  ]).toEqual([
    "allowed",
    "allowed",
    "refused",
    "missing",
    "missing",
    "missing",
    "missing",
    "missing",
    "allowed",
    "missing",
    "refused",
  ]);
});
