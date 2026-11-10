import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretValues } from "../check-secrets.mjs";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import {
  assertPassingReceiptFacts,
  browserCommand,
  canonicalCommands,
  commandRoles,
  localRecoveryCommand,
  nativeRecoveryCommand,
  sameCommand,
} from "./canonical-commands.mjs";
import { checklist, validateChecklist } from "./checklist.mjs";
import { nativeRecoveryReceipt, validateNativeRecoveryProof } from "./native-recovery.mjs";
import { assertRuntimePartition, recordedRuntimeShards, shardCommands } from "./runtime-shards.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export async function readPassingReceipt(directory, name, candidate, command) {
  const receipt = JSON.parse(await readFile(path.join(directory, `${name}.result.json`), "utf8"));
  assertPassingReceiptFacts(receipt, candidate, command);
  assert.equal(
    receipt.outputDigest,
    digest(await readFile(path.join(directory, `${name}.log`))),
    "passing receipt log mismatch",
  );
  return receipt;
}
// The deploy retries only a failed provision apply (scripts/ci/deploy.mjs): at most `attempts` runs,
// `backoffSeconds` apart. Each retry re-reads state, then plans, reviews and applies, in this order.
export const provisionRetry = { attempts: 4, backoffSeconds: [15, 30, 60] };
const provisionApply = "OpenTofu provision apply";
const retriedPhases = [
  "read owned persisted resource identities",
  "OpenTofu provision plan",
  "OpenTofu provision review",
  provisionApply,
];
// A deployment's phases that still decide its outcome: all but a provision apply that a later
// attempt passed. That attempt planned against the state the failed one left, so the failed one's
// effect is no longer open.
export function outstandingPhases(phases) {
  const attempt = (phase) => phase.attempt ?? 1;
  return phases.filter(
    (phase) =>
      phase.status === "passed" ||
      phase.command[0] !== provisionApply ||
      !phases.some(
        (later) =>
          later.status === "passed" &&
          later.command[0] === provisionApply &&
          attempt(later) > attempt(phase),
      ),
  );
}
// Retry evidence must be what the deploy produces: attempt n (2 up to the limit) starts only after
// attempt n-1's provision apply did not pass, and runs the retried phases in order, nothing between.
export function assertRetryEvidence(phases) {
  let attempt = 1;
  let due = [];
  let lastApply;
  for (const phase of phases) {
    const name = phase.command[0];
    const n = phase.attempt ?? 1;
    if (!retriedPhases.includes(name)) {
      assert(!phase.attempt, "deploy retry of a phase that is never retried");
      assert.equal(due.length, 0, "deploy retry interrupted by another phase");
      continue;
    }
    if (n === attempt + 1) {
      assert(
        lastApply?.attempt === attempt && lastApply.status !== "passed",
        "deploy retry without a failed provision apply before it",
      );
      assert(n <= provisionRetry.attempts, "deploy retry beyond its attempt limit");
      attempt = n;
      due = [...retriedPhases];
    }
    assert.equal(n, attempt, "deploy retry attempt out of order");
    if (n > 1) assert.equal(due.shift(), name, "deploy retry phases out of order");
    if (name === provisionApply) lastApply = { attempt: n, status: phase.status };
  }
}
// OpenTofu's time limits (scripts/ci/deploy.mjs) end a deploy at the phase they hit, retrying
// nothing. A phase stopped at its limit (reason `timeout`) was interrupted with no result, so its
// effect is unknown; one refused because its limit did not fit the deploy's budget (reason
// `budget`) never started, so it failed with no effect and no observation.
export function assertTimeoutEvidence(phases) {
  phases.forEach((phase, index) => {
    if (!phase.reason) return;
    if (phase.reason === "timeout")
      assert(
        phase.status === "unknown" && phase.errorCode === "ETIMEDOUT",
        "timed-out phase outcome mismatch",
      );
    else
      assert(
        phase.status === "failed" &&
          phase.exitCode === null &&
          !phase.signal &&
          !phase.errorCode &&
          phase.startedAt === phase.completedAt,
        "refused phase outcome mismatch",
      );
    assert.equal(index, phases.length - 1, "deployment continued after a time-limited phase");
  });
}
// One deployment's outcome against its phases.
export function assertDeploymentOutcome(deployment) {
  assertTimeoutEvidence(deployment.phases);
  assertRetryEvidence(deployment.phases);
  const outstanding = outstandingPhases(deployment.phases);
  if (outstanding.some((phase) => phase.status === "unknown"))
    assert.equal(deployment.status, "unknown", "deployment effect uncertainty mismatch");
  if (deployment.status === "passed")
    assert(
      deployment.phases.length > 0 && outstanding.every((phase) => phase.status === "passed"),
      "deployment outcome mismatch",
    );
}
// Child observations only: wrapper failures have a separate nonzero CLI result.
export function subprocessEvidence(result) {
  const exitCode = typeof result.status === "number" ? result.status : null;
  const signal = Object.hasOwn(osConstants.signals, result.signal ?? "") ? result.signal : null;
  const errorCode = [
    "ENOENT",
    "EACCES",
    "ENOEXEC",
    "ENOBUFS",
    "ETIMEDOUT",
    "EINVAL",
    "EAGAIN",
    "EMFILE",
    "ENFILE",
    "ENOMEM",
    "E2BIG",
    "EIO",
    "ENOTDIR",
    "EPERM",
  ].includes(result.error?.code)
    ? result.error.code
    : null;
  return {
    exitCode,
    status:
      exitCode === null || result.error || signal
        ? "unknown"
        : exitCode === 0
          ? "passed"
          : "failed",
    signal,
    errorCode,
  };
}
export async function validateEvidence(manifest) {
  const schema = JSON.parse(
    await readFile(path.join(root, "schemas/evidence-manifest.schema.json"), "utf8"),
  );
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert(validate(manifest), `incomplete evidence manifest: ${JSON.stringify(validate.errors)}`);
  assertNoSecretValues(JSON.stringify(manifest), "evidence manifest");
  const deploymentPhases = manifest.deployments.flatMap((deployment) => deployment.phases);
  for (const result of [
    ...manifest.commands,
    ...manifest.tests,
    ...manifest.migrations,
    ...manifest.security,
    ...deploymentPhases,
  ]) {
    assert.equal(result.commit, manifest.candidate.commit, "execution result candidate mismatch");
    if (result.tree)
      assert.equal(result.tree, manifest.candidate.tree, "execution result tree mismatch");
    assert.equal(
      result.status === "passed",
      result.exitCode === 0 && !result.signal && !result.errorCode,
      "execution outcome mismatch",
    );
    // A deploy phase refused for time never ran (assertTimeoutEvidence holds it to that).
    if (deploymentPhases.includes(result) && result.reason === "budget") continue;
    if (result.exitCode === null || result.signal || result.errorCode)
      assert.equal(result.status, "unknown", "unobserved execution outcome mismatch");
    else if (result.exitCode !== 0)
      assert.equal(
        result.status,
        deploymentPhases.includes(result) && /apply|publication/u.test(result.command[0])
          ? "unknown"
          : "failed",
        "execution outcome mismatch",
      );
    if (result.status === "passed")
      assertPassingReceiptFacts(result, manifest.candidate, result.command);
  }
  for (const deployment of manifest.deployments) {
    assertDeploymentOutcome(deployment);
    assert.equal(deployment.commit, manifest.candidate.commit, "deployment candidate mismatch");
    assert.equal(
      deployment.buildDigest,
      manifest.candidate.buildDigest,
      "deployment build mismatch",
    );
  }
  for (const artifact of manifest.artifacts) {
    assert.equal(artifact.commit, manifest.candidate.commit, "artifact candidate mismatch");
    assert.equal(artifact.buildDigest, manifest.candidate.buildDigest, "artifact build mismatch");
  }
  const retainedLog = (name, result) => {
    assert(
      manifest.artifacts.some(
        (artifact) => artifact.path === `${name}.log` && artifact.digest === result.outputDigest,
      ),
      "positive receipt retained log mismatch",
    );
  };
  const runtime = manifest.extensions.runtimeShards;
  if (runtime) assertRuntimePartition(runtime.files, runtime.shards);
  const runtimeShardCommands = runtime ? shardCommands(runtime) : [];
  const roles = {
    ...commandRoles,
    tests: [...commandRoles.tests, ...runtimeShardCommands.map(([label]) => label)],
  };
  for (const [role, names] of Object.entries(roles)) {
    for (const result of manifest[role].filter((result) => result.status === "passed")) {
      const descriptor = [...canonicalCommands, ...runtimeShardCommands].find(
        ([name, command]) => names.includes(name) && sameCommand(command, result.command),
      );
      assert(descriptor, "positive execution role command mismatch");
      assert.deepEqual(
        result,
        manifest.commands.find((observed) => sameCommand(observed.command, descriptor[1])),
        "positive execution role has no matching observed receipt",
      );
      retainedLog(descriptor[0], result);
    }
  }
  for (const [name, command, evidence] of [
    ["browser", browserCommand, "browser.result.json"],
    ["recovery", localRecoveryCommand, "local-recovery.json"],
  ]) {
    const summary = manifest[name];
    if (summary.status !== "passed") continue;
    const observed = manifest.commands.find(
      (result) => result.status === "passed" && sameCommand(result.command, command),
    );
    assert(observed, "positive summary has no matching observed receipt");
    assertPassingReceiptFacts(observed, manifest.candidate, command);
    retainedLog(name === "recovery" ? "local-recovery" : name, observed);
    assert.deepEqual(summary.evidence, [evidence], "positive summary evidence mismatch");
    assert(
      manifest.artifacts.some((artifact) => artifact.path === evidence),
      "positive summary proof artifact missing",
    );
  }
  const nativeObserved = nativeRecoveryReceipt(
    manifest.candidate,
    manifest.artifacts,
    manifest.commands,
  );
  if (nativeObserved || manifest.nativeRecovery?.status === "passed") {
    assert.equal(
      manifest.nativeRecovery?.status,
      "passed",
      "positive native checklist requires validated summary",
    );
    const observed = nativeRecoveryReceipt(
      manifest.candidate,
      manifest.artifacts,
      manifest.commands,
    );
    assert(observed, "positive native recovery has no matching observed receipt");
    assert.deepEqual(
      manifest.nativeRecovery.evidence,
      ["native-recovery.json"],
      "positive native recovery evidence mismatch",
    );
    const proof = validateNativeRecoveryProof(
      manifest.extensions.nativeRecoveryProof,
      manifest.candidate,
      manifest.versions.lockfileDigest,
    );
    assert.equal(
      observed.artifact.digest,
      digest(JSON.stringify(proof)),
      "native recovery artifact digest mismatch",
    );
  } else
    assert(!manifest.extensions.nativeRecoveryProof, "unsupported positive native recovery proof");
  await validateChecklist(manifest, root);
  return manifest;
}
export async function fileInventory(directory) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      assert(!entry.isSymbolicLink(), "build artifact symlinks forbidden");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        assert(
          !/\.(?:tfstate|tfplan)(?:\.|$)/u.test(name),
          "sensitive state or plan artifact refused",
        );
        const bytes = await readFile(path.join(directory, name));
        assertNoSecretValues(bytes.toString("utf8"), name);
        files.push({ path: name, digest: digest(bytes) });
      }
    }
  }
  await walk("");
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export async function collectEvidence(directory, execution, buildDirectory) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  assert(
    !process.env.GITHUB_SHA || commit === process.env.GITHUB_SHA,
    "CI candidate commit mismatch",
  );
  const files = buildDirectory
    ? await fileInventory(buildDirectory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    : [];
  const buildDigest = files.length ? digest(JSON.stringify(files)) : null;
  const candidate = {
    commit,
    tree,
    buildDigest,
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
  const results = [];
  const namedResults = new Map();
  const { runtime, commands: runtimeShardCommands } = await recordedRuntimeShards(directory);
  const expectedCommands = new Map([
    ...canonicalCommands,
    ...runtimeShardCommands,
    ["browser", browserCommand],
    ["local-recovery", localRecoveryCommand],
    ["native-recovery", nativeRecoveryCommand],
    ["build", ["node", "scripts/ci/build.mjs", buildDirectory ?? path.join(directory, "build")]],
  ]);
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".result.json"))
    .sort()) {
    const result = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    assert.equal(result.commit, commit, "execution result candidate mismatch");
    assert.equal(
      result.outputDigest,
      digest(await readFile(path.join(directory, name.replace(".result.json", ".log")))),
      "execution log digest mismatch",
    );
    const label = name.slice(0, -".result.json".length);
    if (result.status === "passed")
      await readPassingReceipt(
        directory,
        label,
        candidate,
        expectedCommands.get(label) ?? result.command,
      );
    namedResults.set(label, result);
    results.push(result);
  }
  const observed = (name) => {
    const result = namedResults.get(name);
    return sameCommand(result?.command, expectedCommands.get(name)) ? result : undefined;
  };
  const canonicalResults = (names) => names.map(observed).filter(Boolean);
  const runtimeShardLabels = runtimeShardCommands.map(([label]) => label);
  // Quality's shards observe test:runtime only as a complete set.
  const shardedRuntime = runtime !== null && runtimeShardLabels.every(observed);
  const contracts = JSON.parse(
    await readFile(path.join(root, "scripts/contracts.generated.json"), "utf8"),
  );
  const manifest = {
    manifestVersion: 1,
    candidate,
    execution,
    versions: {
      toolchain: { node: "24.21.0", pnpm: "12.9.1", opentofu: "1.13.1", wrangler: "4.147.0" },
      lockfileDigest: digest(await readFile(path.join(root, "pnpm-lock.yaml"))),
      contracts,
      databaseMigrations: await fileInventory(path.join(root, "db/migrations")),
      infrastructureRevision: tree,
      runtime: JSON.parse(await readFile(path.join(root, "infra/wrangler/ci.json"), "utf8")),
      worldPacks: null,
      policies: null,
    },
    commands: results,
    browser: {
      status: observed("browser")?.status ?? "missing",
      evidence: observed("browser") ? ["browser.result.json"] : [],
    },
    tests: canonicalResults([...commandRoles.tests, ...runtimeShardLabels]),
    fixtureHashes: await fileInventory(path.join(root, "packages/contracts/test/fixtures")),
    stateHashes: [],
    migrations: canonicalResults(commandRoles.migrations),
    security: canonicalResults(commandRoles.security),
    recovery: { status: "missing", evidence: [] },
    nativeRecovery: { status: "missing", evidence: [] },
    cloudQualification: { status: "pending", dependencies: ["#1", "#2"], evidence: [] },
    deployments: [],
    focusedReview: { status: "needs-human", evidence: [] },
    knownRisks: [
      "Independent exact-candidate review is unverified",
      "Hosted deployment acceptance and full Wave 0 qualification remain pending",
    ],
    waivers: [],
    artifacts: [],
    extensions: {
      missingCommands: [
        "install",
        "check",
        "test",
        "test:db",
        "test:runtime",
        "verify:docs",
        "infra:validate",
        "verify:supply-chain",
      ].filter((expected) => {
        if (expected === "test:runtime" && shardedRuntime) return false;
        const descriptor = canonicalCommands.find(([, command]) => command.includes(expected));
        return !descriptor || !observed(descriptor[0]);
      }),
      ...(runtime ? { runtimeShards: runtime } : {}),
    },
  };
  for (const name of (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        (!name.endsWith(".result.json") || name === "browser.result.json") &&
        name !== "evidence-manifest.json",
    )
    .sort()) {
    assert(
      /^[a-z0-9-]+\.log$/u.test(name) ||
        [
          "bootstrap.json",
          "local-recovery.json",
          "native-recovery.json",
          "reproduction.json",
          "browser.json",
          "browser.result.json",
          "sbom.json",
          "licenses.json",
          "vulnerabilities.json",
          "supply-chain.json",
        ].includes(name),
      "undeclared ordinary evidence artifact refused",
    );
    const file = path.join(directory, name);
    const bytes = await readFile(file);
    assertNoSecretValues(bytes.toString("utf8"), name);
    manifest.artifacts.push({ path: name, digest: digest(bytes), commit, buildDigest });
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "evidence artifact symlinks forbidden");
    if (!entry.isDirectory()) continue;
    assert(
      ["build", "after-disposal", "reproduction-left", "reproduction-right"].includes(entry.name),
      "undeclared evidence directory refused",
    );
    if (entry.name === "build") continue;
    for (const file of await fileInventory(path.join(directory, entry.name))) {
      assert(
        /^[a-z0-9-]+\.(?:log|result\.json)$/u.test(file.path) ||
          ["sbom.json", "licenses.json", "vulnerabilities.json", "supply-chain.json"].includes(
            file.path,
          ),
        "undeclared nested evidence artifact refused",
      );
      manifest.artifacts.push({ ...file, path: `${entry.name}/${file.path}`, commit, buildDigest });
    }
  }
  manifest.artifacts.push(
    ...files.map((file) => ({ ...file, path: `build/${file.path}`, commit, buildDigest })),
  );
  for (const name of ["bootstrap.json", "local-recovery.json", "reproduction.json"]) {
    if (!manifest.artifacts.some((artifact) => artifact.path === name)) continue;
    const proof = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    assert.equal(proof.commit, commit, "local evidence candidate mismatch");
    assert.equal(proof.tree, tree, "local evidence tree mismatch");
    if (name === "bootstrap.json") {
      assert.equal(proof.repetitions, 1, "disposal must repeat exactly once");
      for (const [label, command] of canonicalCommands) {
        await readPassingReceipt(path.join(directory, "after-disposal"), label, candidate, command);
      }
    } else if (name === "reproduction.json") {
      assert(
        Array.isArray(proof.inventory) &&
          proof.inventory.length &&
          proof.inventory.some((file) => file.path.startsWith("worker/")) &&
          proof.inventory.some((file) => file.path.startsWith("web/")),
        "complete reproduction Worker/web inventory required",
      );
      assert.deepEqual(
        proof.inventory,
        proof.comparisonInventory,
        "independent reproduction inventories differ",
      );
      assert.equal(
        proof.buildDigest,
        digest(JSON.stringify(proof.inventory)),
        "reproduction inventory digest mismatch",
      );
      if (buildDigest !== null) {
        assert.equal(
          proof.buildDigest,
          buildDigest,
          "exact candidate build/reproduction digest mismatch",
        );
        assert.deepEqual(
          proof.inventory,
          files,
          "exact candidate build/reproduction inventory mismatch",
        );
      }
      const outputRoots = [];
      for (const side of ["left", "right"]) {
        const wrapper = JSON.parse(
          await readFile(path.join(directory, `reproduction-${side}-build.result.json`), "utf8"),
        );
        const output = wrapper.command[7];
        assert(
          typeof output === "string" && path.isAbsolute(output),
          "owned build output required",
        );
        const owner = path.dirname(output);
        assert(
          path.basename(owner).startsWith("clockgrove-reproduction-"),
          "owned build root required",
        );
        assert.equal(path.basename(output), `${side}-build`, "independent build output mismatch");
        outputRoots.push(output);
        for (const label of ["install", "build"]) {
          const command =
            label === "install"
              ? ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
              : ["node", "scripts/ci/build.mjs", output];
          const nested = path.join(directory, `reproduction-${side}`);
          await readPassingReceipt(directory, `reproduction-${side}-${label}`, candidate, [
            "node",
            path.join(owner, side, "scripts/ci/evidence.mjs"),
            "run",
            nested,
            label,
            ...command,
          ]);
          await readPassingReceipt(nested, label, candidate, command);
        }
      }
      assert.notEqual(outputRoots[0], outputRoots[1], "independent build outputs must differ");
      assert.equal(
        path.dirname(outputRoots[0]),
        path.dirname(outputRoots[1]),
        "independent builds must share their owned reproduction scope",
      );
    } else {
      if (observed("local-recovery")?.status === "passed")
        await readPassingReceipt(directory, "local-recovery", candidate, localRecoveryCommand);
      assert.equal(proof.canonicalPreserved, true, "recovery must preserve canonical state");
      assert.equal(
        proof.duplicateCounts,
        "1|1|1|correlation-runtime",
        "recovery duplicate outcome changed",
      );
    }
  }
  if (manifest.artifacts.some((artifact) => artifact.path === "native-recovery.json")) {
    await readPassingReceipt(directory, "native-recovery", candidate, nativeRecoveryCommand);
    const proof = JSON.parse(await readFile(path.join(directory, "native-recovery.json"), "utf8"));
    manifest.extensions.nativeRecoveryProof = validateNativeRecoveryProof(
      proof,
      candidate,
      manifest.versions.lockfileDigest,
    );
  }
  const nativeResult = observed("native-recovery");
  manifest.nativeRecovery = {
    status:
      nativeResult?.status === "passed" && !manifest.extensions.nativeRecoveryProof
        ? "missing"
        : (nativeResult?.status ?? "missing"),
    evidence: manifest.extensions.nativeRecoveryProof ? ["native-recovery.json"] : [],
  };
  manifest.knownRisks.push(
    "Actual missed/duplicate/reordered Queue or webhook effects remain pending",
  );
  const recoveryProof = manifest.artifacts.some(
    (artifact) => artifact.path === "local-recovery.json",
  );
  manifest.recovery = {
    status:
      observed("local-recovery")?.status === "passed" && !recoveryProof
        ? "missing"
        : (observed("local-recovery")?.status ?? "missing"),
    evidence: recoveryProof ? ["local-recovery.json"] : [],
  };
  manifest.wave0Checklist = checklist(candidate, execution, manifest.artifacts, results);
  await validateEvidence(manifest);
  await writeFile(
    path.join(directory, "evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
export async function recordCommand(directory, name, command, options = {}) {
  assert(/^[a-z0-9-]+$/u.test(name), "invalid CI evidence name");
  await mkdir(directory, { recursive: true });
  await access(path.join(directory, `${name}.result.json`)).then(
    () => {
      throw new Error(
        "refuse overwriting prior command evidence; use a separately owned directory",
      );
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const start = new Date().toISOString();
  const result = await ownedSubprocess(command[0], command.slice(1), {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    killGraceMs: options.killGraceMs ?? 30_000,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, CI_EVIDENCE_DIR: directory },
  });
  let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  try {
    assertNoSecretValues(output, "CI command output");
  } catch {
    output = "Command output withheld: secret-shaped values detected\n";
  }
  process.stdout.write(output);
  await writeFile(path.join(directory, `${name}.log`), output);
  await writeFile(
    path.join(directory, `${name}.result.json`),
    JSON.stringify({
      commit,
      tree,
      usage: null,
      command,
      ...subprocessEvidence(result),
      startedAt: start,
      completedAt: new Date().toISOString(),
      outputDigest: digest(output),
    }),
  );
  return result.status === 0 && !result.error && !result.signal ? 0 : result.status || 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, directory, name, ...command] = process.argv.slice(2);
  if (mode === "run") process.exitCode = await recordCommand(directory, name, command);
  else if (mode === "generate")
    await collectEvidence(
      directory,
      {
        provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      },
      name,
    );
  else throw new Error("evidence command requires run or generate");
}
