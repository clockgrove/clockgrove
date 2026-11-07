// The Wave 1 evidence manifest (plan §13): built only from receipts this run can authenticate, and
// validated by recomputing every disposition from those receipts. An exit item that needs
// independent review stays pending; the manifest never claims more than its receipts show.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertPassingReceiptFacts,
  canonicalCommands,
  sameCommand,
} from "./canonical-commands.mjs";
import { digest } from "./evidence.mjs";
import { checkLongRunBundle } from "./qualify-wave1-long-run-checks.mjs";
import {
  RESULT_FILE as LONG_RUN_RESULT,
  longRunBudget,
  WAVE1_LONG_RUN_BUDGETS,
} from "./qualify-wave1-long-runs.mjs";

export const MANIFEST_FILE = "wave1-evidence-manifest.json";
export const PLAN = "docs/waves/clockgrove-wave-1-world-kernel-implementation-plan.md";
/** The qualification run's receipts this manifest reads, by evidence name. */
export const RECEIPTS = [
  ...canonicalCommands,
  ["test-long-run", ["pnpm", "run", "test:long-run"]],
  ["qualify-wave0", ["pnpm", "run", "qualify:wave0"]],
];
const REVIEW = "independent review of the exact candidate";

/** The literal §13 checklist items of the Wave 1 plan. */
export async function literalChecklist(root) {
  const plan = await readFile(path.join(root, PLAN), "utf8");
  return plan
    .split("## 13. Exit evidence checklist\n")[1]
    .split("\n---")[0]
    .match(/^- \[ \] (.+)$/gmu)
    .map((line) => line.slice(6));
}

/** Reads `<name>.result.json` and its log; a passing receipt must match the candidate exactly. */
export async function receipt(directory, name, command, candidate) {
  if (!directory) return { name, command, status: "missing" };
  let result;
  try {
    result = JSON.parse(await readFile(path.join(directory, `${name}.result.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { name, command, status: "missing" };
    throw error;
  }
  const log = await readFile(path.join(directory, `${name}.log`));
  assert.equal(result.outputDigest, digest(log), `${name} receipt log mismatch`);
  assert(sameCommand(result.command, command), `${name} receipt command mismatch`);
  if (result.status === "passed") assertPassingReceiptFacts(result, candidate, command);
  const { status, exitCode, commit, tree, outputDigest, startedAt, completedAt } = result;
  return { name, command, status, exitCode, commit, tree, outputDigest, startedAt, completedAt };
}

/** Every committed golden: file digest, bundle hash and the pack artifact it was built from. */
async function goldens(root, decode) {
  const found = [];
  const entries = await readdir(path.join(root, "worlds"), { withFileTypes: true });
  for (const pack of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!pack.isDirectory()) continue;
    const directory = path.join("worlds", pack.name, "goldens");
    const names = await readdir(path.join(root, directory)).catch(() => []);
    for (const name of names
      .filter((file) => file.endsWith(".json") && !file.endsWith(".actual.json"))
      .sort()) {
      const bytes = await readFile(path.join(root, directory, name));
      const bundle = decode(bytes);
      found.push({
        path: `${directory}/${name}`,
        digest: digest(bytes),
        bundleHash: bundle.bundleHash,
        pack: `${bundle.pack.id}@${bundle.pack.version}`,
        artifactDigest: digest(JSON.stringify(bundle.artifact)),
      });
    }
  }
  return found;
}

/** The required Wave 1 long runs: both packs at 30 days and one year. */
export const REQUIRED_LONG_RUNS = [
  "clockgrove.green-lake-yard@1.1.0:30",
  "clockgrove.green-lake-yard@1.1.0:365",
  "clockgrove.test-world@1.1.0:30",
  "clockgrove.test-world@1.1.0:365",
];
const DAY_MS = 86_400_000n;

/** Each committed pack's clock epoch, by `id@version`. */
async function packEpochs(root) {
  const revive = (_key, value) =>
    value && typeof value === "object" && Object.keys(value).join() === "$bigint"
      ? BigInt(value.$bigint)
      : value;
  const epochs = new Map();
  for (const entry of await readdir(path.join(root, "worlds"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, "worlds", entry.name);
    const manifest = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
      revive,
    );
    for (const policy of manifest.policies) {
      const body = JSON.parse(
        await readFile(path.join(directory, "resources", policy.path), "utf8"),
        revive,
      );
      if (body.type === "clockgrove.clock-policy")
        epochs.set(`${manifest.id}@${manifest.version}`, body.epoch);
    }
  }
  return epochs;
}

/**
 * Reads the long-run results, re-authenticates every retained bundle against its recorded digest
 * and re-runs the checks; a recorded outcome the bundles do not reproduce is refused.
 */
async function longRuns(root, directory, candidate, decode) {
  if (!directory) return { status: "missing", runs: [] };
  let result;
  try {
    result = JSON.parse(await readFile(path.join(directory, LONG_RUN_RESULT), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", runs: [] };
    throw error;
  }
  assert.equal(result.candidate.commit, candidate.commit, "long-run candidate mismatch");
  assert.equal(result.candidate.tree, candidate.tree, "long-run tree mismatch");
  const epochs = await packEpochs(root);
  const runs = [];
  for (const run of result.runs) {
    const runtimes = {};
    const digests = [];
    let bundle = null;
    for (const [runtime, outcome] of Object.entries(run.runtimes)) {
      if (outcome.status === "passed") {
        const bytes = await readFile(path.join(directory, outcome.bundle.path));
        assert.equal(
          digest(bytes),
          outcome.bundle.digest,
          `${run.scenario} ${runtime} bundle mismatch`,
        );
        digests.push(outcome.bundle.digest);
        bundle ??= decode(bytes);
      }
      const {
        durationMs = null,
        peakMemoryBytes = null,
        peakMemorySource = null,
      } = outcome.observation;
      // The budget verdict is recomputed from the declared budgets and the recorded counters.
      const packId = run.pack.slice(0, run.pack.lastIndexOf("@"));
      const declared = WAVE1_LONG_RUN_BUDGETS[`${packId} ${run.scenario} ${runtime}`];
      const budget = longRunBudget(declared, outcome.observation);
      assert.deepEqual(
        outcome.budget,
        budget,
        `${run.scenario} ${runtime} budget is not reproduced`,
      );
      runtimes[runtime] = {
        status: outcome.status,
        bundleDigest: outcome.bundle?.digest ?? null,
        durationMs,
        peakMemoryBytes,
        peakMemorySource,
        budget,
      };
    }
    const identical =
      digests.length === Object.keys(run.runtimes).length && new Set(digests).size === 1;
    assert.equal(identical, run.identical, `${run.scenario} recorded identity is not reproduced`);
    const checks = bundle ? checkLongRunBundle(bundle, { maxPopulation: run.maxPopulation }) : [];
    if (bundle) {
      // The horizon is read from the bundle's own document, not taken from the results file.
      assert.equal(
        `${bundle.pack.id}@${bundle.pack.version}`,
        run.pack,
        `${run.scenario} pack mismatch`,
      );
      const end = bundle.scenario.document.steps.findLast((step) => step.kind === "advance").to;
      assert.equal(
        String(end - epochs.get(run.pack)),
        run.horizonMs,
        `${run.scenario} horizon mismatch`,
      );
    }
    const recorded = run.checks.map(({ id, status }) => ({ id, status }));
    assert.deepEqual(
      checks.map(({ id, status }) => ({ id, status })),
      recorded,
      `${run.scenario} recorded checks are not reproduced`,
    );
    runs.push({
      pack: run.pack,
      scenario: run.scenario,
      horizonMs: run.horizonMs,
      status: run.status,
      identical,
      artifactDigest: bundle ? digest(JSON.stringify(bundle.artifact)) : null,
      checks: recorded,
      summaryHashes: run.summaryHashes,
      runtimes,
    });
  }
  return {
    status: result.status,
    resultDigest: digest(await readFile(path.join(directory, LONG_RUN_RESULT))),
    execution: result.execution,
    host: result.host,
    runs,
  };
}

/** The packet record, with each merge resolved in the candidate's history and the order checked. */
async function dependencyOrder(root, commit) {
  const record = JSON.parse(
    await readFile(path.join(root, "scripts/ci/qualify-wave1-packets.json"), "utf8"),
  );
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const ancestor = (older, newer) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", older, newer], {
        cwd: root,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  const summary = record.packets.map(({ id, consumes, merges, corrections }) => ({
    id,
    consumes,
    prs: merges.map((merge) => merge.pr),
    corrections: corrections.map((merge) => merge.pr),
  }));
  const recordDigest = digest(
    await readFile(path.join(root, "scripts/ci/qualify-wave1-packets.json")),
  );
  // The record names the merges in the repository's earlier history. A clone that holds none of them (the public
  // repository began from a single commit) cannot check the order; the record stands as written.
  const present = (sha) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (
    !record.packets.some((packet) =>
      [...packet.merges, ...packet.corrections].some((merge) => present(merge.commit)),
    )
  )
    return { status: "historical", recordDigest, problems: [], packets: summary };
  const problems = [];
  const packets = new Map(record.packets.map((packet) => [packet.id, packet]));
  for (const packet of record.packets) {
    for (const merge of [...packet.merges, ...packet.corrections]) {
      if (!ancestor(merge.commit, commit))
        problems.push(`${packet.id} #${merge.pr} is not in the candidate`);
      else if (
        !git("log", "-1", "--format=%s", merge.commit).match(new RegExp(`#${merge.pr}\\b`, "u"))
      )
        problems.push(`${packet.id} commit ${merge.commit} does not merge #${merge.pr}`);
    }
    const first = packet.merges[0]?.commit;
    for (const producer of packet.consumes) {
      const last = packets.get(producer)?.merges.at(-1)?.commit;
      if (!first || !last) problems.push(`${packet.id} or ${producer} has no merge`);
      else if (!ancestor(last, first))
        problems.push(`${packet.id} was merged before ${producer} was complete`);
    }
  }
  return {
    status: problems.length ? "failed" : "passed",
    recordDigest,
    problems,
    packets: summary,
  };
}

const passedReceipt = (manifest, name) =>
  manifest.tests.find((item) => item.name === name)?.status === "passed";

/** One disposition per literal item, derived only from the manifest's own facts. */
export function exitChecklist(manifest, items) {
  const receipts = (...names) => names.map((name) => `tests:${name}`);
  const covered = manifest.longRuns.runs
    .filter((run) => BigInt(run.horizonMs) % DAY_MS === 0n)
    .map((run) => `${run.pack}:${BigInt(run.horizonMs) / DAY_MS}`)
    .sort();
  const longRunsPassed =
    manifest.longRuns.status === "passed" &&
    JSON.stringify(covered) === JSON.stringify(REQUIRED_LONG_RUNS);
  const packsReproducible =
    manifest.packs.length === 2 && manifest.packs.every((pack) => pack.reproducible);
  const rules = [
    {
      evidence: ["dependencyOrder"],
      failed: manifest.dependencyOrder.status === "failed",
      pending: `RW-0110 includes this wave qualification; ${REVIEW} must accept the packet-to-merge record`,
    },
    {
      evidence: [...receipts("test"), "goldens", "longRuns"],
      passed: passedReceipt(manifest, "test") && longRunsPassed && packsReproducible,
      observed:
        "pnpm test validates and builds both packs; every golden and every Node and workerd long-run bundle names the same artifact hashes per pack",
      pending:
        "Passing test receipt, passing long runs and one artifact hash per pack across goldens and long runs",
    },
    {
      evidence: [...receipts("test", "test-long-run"), "goldens"],
      passed: passedReceipt(manifest, "test") && passedReceipt(manifest, "test-long-run"),
      observed:
        "pnpm test runs every committed scenario against its golden in Node (and the fixture pack in workerd); test:long-run runs the raccoon scenarios in workerd",
      pending: "Passing test and test:long-run receipts at the candidate",
    },
    {
      evidence: [...receipts("test-long-run"), "longRuns"],
      passed: longRunsPassed && passedReceipt(manifest, "test-long-run"),
      observed:
        "Both packs' 30-day and one-year runs pass every invariant a summarised recording shows; private perception is not observable there and is covered by the kernel long-run privacy probe in test:long-run",
      pending: "Passing Wave 1 long runs and test:long-run receipt at the candidate",
    },
    {
      evidence: [...receipts("test"), "longRuns"],
      passed: longRunsPassed && passedReceipt(manifest, "test"),
      observed:
        "Each long run's one-day steps equal its single aggregate call in final state and threshold and lifecycle events; the scheduler differential pairs pass in pnpm test",
      pending: "Passing Wave 1 long runs and test receipt at the candidate",
    },
    {
      evidence: [...receipts("test-long-run"), "longRuns"],
      passed:
        longRunsPassed &&
        manifest.longRuns.runs.every((run) => run.identical) &&
        passedReceipt(manifest, "test-long-run"),
      observed:
        "Every long-run bundle is byte-identical between Node and workerd; test:long-run passes the kernel Node/workerd evidence differential",
      pending: "Byte-identical Node and workerd long runs and a passing test:long-run receipt",
    },
    {
      evidence: receipts("test"),
      pending: `${REVIEW}: which passing tests prove the historic upcasts`,
    },
    {
      evidence: receipts("check", "test"),
      pending: `${REVIEW}: the boundary and forbidden-API checks cover domain and kernel`,
    },
    {
      evidence: receipts("test"),
      pending: `${REVIEW}: decision traces and perception evidence are inspectable from the CLI`,
    },
    {
      evidence: [...receipts("test"), "longRuns"],
      pending: `${REVIEW}: the event-volume tests and long-run counts show semantic scaling`,
    },
    {
      evidence: receipts("test"),
      pending: `${REVIEW}: test-world@1 needed no engine source change`,
    },
    {
      evidence: receipts("verify-docs"),
      pending: `${REVIEW}: package READMEs, protocol docs and ADRs are current`,
    },
    {
      evidence: receipts("qualify-wave0"),
      pending: "Quality on the main candidate and the Wave 0 hosted items establish deployability",
    },
  ];
  assert.equal(rules.length, items.length, "a §13 item has no disposition rule");
  return items.map((item, index) => {
    const rule = rules[index];
    const disposition = rule.failed ? "failed" : rule.passed ? "passed" : "pending";
    return {
      item,
      disposition,
      evidence: rule.evidence,
      observed: disposition === "passed" ? rule.observed : null,
      pending: disposition === "passed" ? null : rule.pending,
    };
  });
}

/** Packs and whether goldens and long-run bundles agree on one artifact per pack. */
function packs(goldenList, longRunResults) {
  const ids = [...new Set(goldenList.map((golden) => golden.pack))].sort();
  return ids.map((id) => {
    const artifacts = new Set([
      ...goldenList.filter((golden) => golden.pack === id).map((golden) => golden.artifactDigest),
      ...longRunResults.runs
        .filter((run) => run.pack === id && run.artifactDigest)
        .map((run) => run.artifactDigest),
    ]);
    return { id, artifactDigests: [...artifacts], reproducible: artifacts.size === 1 };
  });
}

export async function buildWave1Manifest({
  root,
  qualificationDirectory,
  longRunDirectory,
  execution,
  decode,
}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const candidate = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const tests = [];
  for (const [name, command] of RECEIPTS)
    tests.push(await receipt(qualificationDirectory, name, command, candidate));
  const goldenList = await goldens(root, decode);
  const longRunResults = await longRuns(root, longRunDirectory, candidate, decode);
  const wave0 = qualificationDirectory
    ? await readFile(path.join(qualificationDirectory, "evidence-manifest.json")).then(
        digest,
        () => null,
      )
    : null;
  const manifest = {
    kind: "clockgrove.wave1-evidence-manifest",
    version: 1,
    candidate,
    execution,
    versions: {
      toolchain: {
        node: rootManifest.engines.node,
        pnpm: rootManifest.packageManager.replace(/^pnpm@/u, ""),
        wrangler: rootManifest.devDependencies.wrangler,
      },
      lockfileDigest: digest(await readFile(path.join(root, "pnpm-lock.yaml"))),
    },
    tests,
    wave0ManifestDigest: wave0,
    goldens: goldenList,
    packs: packs(goldenList, longRunResults),
    longRuns: longRunResults,
    dependencyOrder: await dependencyOrder(root, candidate.commit),
  };
  manifest.exitChecklist = exitChecklist(manifest, await literalChecklist(root));
  const pending = manifest.exitChecklist.filter((entry) => entry.disposition !== "passed");
  manifest.exitDecision = {
    status: pending.length ? "not-qualified" : "qualified",
    unmet: pending.map((entry) => entry.item),
  };
  return manifest;
}

/** Repository-owned validation: shape, candidate binding and dispositions recomputed from facts. */
export async function validateWave1Manifest(manifest, root) {
  assert.equal(manifest.kind, "clockgrove.wave1-evidence-manifest", "manifest kind");
  assert.equal(manifest.version, 1, "manifest version");
  assert.match(manifest.candidate.commit, /^[0-9a-f]{40}$/u, "candidate commit");
  assert.match(manifest.versions.lockfileDigest, /^sha256:[0-9a-f]{64}$/u, "lockfile digest");
  assert.deepEqual(
    manifest.tests.map((item) => item.name),
    RECEIPTS.map(([name]) => name),
    "one entry per qualification receipt",
  );
  for (const item of manifest.tests) {
    assert(["passed", "failed", "unknown", "missing"].includes(item.status), `${item.name} status`);
    if (item.status === "passed") {
      assert.equal(item.commit, manifest.candidate.commit, `${item.name} candidate`);
      assert.equal(item.tree, manifest.candidate.tree, `${item.name} tree`);
      assert.equal(item.exitCode, 0, `${item.name} exit code`);
    }
  }
  assert(manifest.goldens.length > 0, "golden bundle hashes required");
  for (const golden of manifest.goldens)
    assert.match(golden.digest, /^sha256:[0-9a-f]{64}$/u, golden.path);
  if (manifest.longRuns.status === "passed")
    for (const run of manifest.longRuns.runs) {
      assert(run.identical && run.status === "passed", `${run.scenario} passed run`);
      assert(!run.checks.some((check) => check.status === "failed"), `${run.scenario} checks`);
      for (const outcome of Object.values(run.runtimes)) {
        assert(Number.isFinite(outcome.durationMs), `${run.scenario} wall time counter`);
        assert.equal(outcome.budget.status, "within", `${run.scenario} within its budget`);
      }
    }
  const items = await literalChecklist(root);
  assert.deepEqual(
    manifest.exitChecklist.map((entry) => entry.item),
    items,
    "exactly one disposition per literal §13 item",
  );
  assert.deepEqual(
    manifest.exitChecklist,
    exitChecklist(manifest, items),
    "dispositions exceed their receipts",
  );
  const unmet = manifest.exitChecklist.filter((entry) => entry.disposition !== "passed");
  assert.deepEqual(
    manifest.exitDecision,
    {
      status: unmet.length ? "not-qualified" : "qualified",
      unmet: unmet.map((entry) => entry.item),
    },
    "exit decision does not follow the checklist",
  );
  return manifest;
}
