// The Wave 3 evidence manifest (plan §23): built from one Qualification run's receipts and its load
// curves, and validated by recomputing every disposition from those facts. An item passes only from
// receipts and evidence bound to the candidate. An item whose proof needs judgement names its review;
// scope a dated plan amendment moved out of Wave 3 is deferred to its wave; an item that needs real
// Cloudflare stays pending on the issue that owns the hosted evidence, and nothing here
// can supply hosted evidence. The manifest never claims more than its evidence shows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { runtimeCommands } from "../check-runtime-commands.mjs";
import { sameCommand } from "./canonical-commands.mjs";
import { digest } from "./evidence.mjs";
import { RECEIPTS, receipt } from "./qualify-wave1-manifest.mjs";
import { LOAD_CURVES_FILE } from "./qualify-wave3-load-curves.mjs";
import { worldPackDirectories } from "./world-packs.mjs";

export { RECEIPTS };
export const MANIFEST_FILE = "wave3-evidence-manifest.json";
export const PLAN = "docs/waves/clockgrove-wave-3-actor-fabric-implementation-plan.md";
export const FAULT_MATRIX = "scripts/ci/wave3-fault-matrix.json";
/**
 * The wave3-load-curves job's receipt; its one further argument is the directory, inside that job's
 * evidence directory, that the result is written to.
 */
export const LOAD_CURVES = [
  "qualify-wave3-load-curves",
  ["pnpm", "run", "qualify:wave3:load-curves"],
];
/** The fault matrix's canonical commands, by the receipt that records each. */
const COMMAND_RECEIPTS = { test: "test", "test:db": "test-db", "test:runtime": "test-runtime" };
/**
 * Load-curve budgets the fixture cannot observe yet, with the issue that makes them observable (none
 * since issue 900 made `DUE_WORK_ADVANCE_BUDGET.maxInputs` observable).
 */
export const UNOBSERVED_BUDGETS = {};
const REVIEW = "independent review of the exact candidate";

/** Hosted evidence: none of it can be produced locally or in Qualification, which deploys nothing. */
export const HOSTED = {
  cloudflare: {
    scope:
      "real Cloudflare staging qualification: plan §18.2 and the hosted rows of the §17 matrix",
    issues: [3],
  },
  deployable: {
    scope: "a deploy of main to real staging and the authenticated staging path",
    issues: [2],
  },
};
/** Scope the plan's dated amendments moved out of Wave 3, with the wave that owns it. */
export const DEFERRED = {
  actorAgent: { scope: "the ActorAgentDO foundation (RW-0307)", owner: "Wave 5 (plan §9.3)" },
  transfer: { scope: "cross-space transfer (RW-0308)", owner: "Wave 11 (plan §13)" },
  fidelity: {
    scope: "hot/warm/dormant tiers and runtime cells; Wave 3 fidelity is awake/asleep",
    owner: "Wave 11 (plan §10.2)",
  },
};

const section = (plan, heading, end) => plan.split(`${heading}\n`)[1]?.split(end)[0] ?? "";

/** The literal §23 checklist items and §18.2 hosted items of the Wave 3 plan. */
export async function literalItems(root) {
  const plan = await readFile(path.join(root, PLAN), "utf8");
  const bullets = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);
  return {
    checklist: bullets(
      section(plan, "## 23. Exit evidence checklist", "\n---"),
      /^- \[ \] (.+)$/gmu,
    ),
    hosted: bullets(
      section(plan, "### 18.2 Staging cloud qualification", "\n### "),
      /^- (.+);?$/gmu,
    ).map((item) => item.replace(/[;.]$/u, "")),
  };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const files = async (root, list) =>
  Promise.all(
    list.map(async (file) => ({
      path: file,
      digest: digest(await readFile(path.join(root, file))),
    })),
  );

/** Runtime and compatibility versions and the binding manifest of every Wrangler environment. */
async function runtime(root, rootManifest) {
  const directory = "infra/wrangler";
  const names = (await readdir(path.join(root, directory))).filter((name) =>
    name.endsWith(".json"),
  );
  const bindings = await files(
    root,
    names.sort().map((name) => `${directory}/${name}`),
  );
  const wrangler = createRequire(
    createRequire(path.join(root, "package.json")).resolve("wrangler/package.json"),
  );
  const miniflare = createRequire(wrangler.resolve("miniflare"));
  const environments = [];
  for (const { path: file } of bindings) {
    const config = JSON.parse(await readFile(path.join(root, file), "utf8"));
    environments.push({
      file,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
    });
  }
  return {
    wrangler: rootManifest.devDependencies.wrangler,
    miniflare: wrangler("miniflare/package.json").version,
    workerd: miniflare("workerd/package.json").version,
    environments,
    bindingManifest: { files: bindings, digest: digest(JSON.stringify(bindings)) },
  };
}

/** Every committed golden run's final state hash, as `{ run: "pack/scenario:run", finalStateHash }`. */
async function goldenRuns(root, decode) {
  const found = [];
  for (const pack of await worldPackDirectories(root)) {
    const directory = path.join(root, "worlds", pack, "goldens");
    for (const name of (await readdir(directory).catch(() => [])).filter(
      (file) => file.endsWith(".json") && !file.endsWith(".actual.json"),
    ))
      for (const run of decode(await readFile(path.join(directory, name))).runs)
        found.push({
          run: `${pack}/${name.slice(0, -".json".length)}:${run.name}`,
          finalStateHash: String(run.finalStateHash),
        });
  }
  return found;
}

/**
 * Native scenario parity's status from its own facts: `passed` needs every committed golden run
 * reported once and on its golden's hash, each pack's 30-day soak on its pure run, and a passed
 * test:long-run receipt.
 */
export function scenarioStatus({ goldens, runs, soak }, longRunStatus) {
  if (longRunStatus === "missing") return "missing";
  const golden = new Map(goldens.map((entry) => [entry.run, entry.finalStateHash]));
  const reported = new Set(runs.map((entry) => entry.run));
  const packs = new Set(goldens.map((entry) => entry.run.slice(0, entry.run.lastIndexOf("/"))));
  const complete =
    reported.size === runs.length &&
    reported.size === golden.size &&
    [...reported].every((run) => golden.has(run)) &&
    [...packs].every((pack) =>
      soak.some((entry) => entry.run.startsWith(`${pack}/long-run-30-days:`)),
    );
  const failed =
    longRunStatus === "failed" ||
    runs.some((entry) => entry.finalStateHash !== golden.get(entry.run)) ||
    soak.some((entry) => entry.finalStateHash !== entry.pureFinalStateHash);
  return failed
    ? "failed"
    : !complete
      ? "incomplete"
      : longRunStatus === "passed"
        ? "passed"
        : "pending";
}

/**
 * The line reportNativeParity (apps/runtime/test/world-owner/native-parity.ts) prints per run, as
 * Turbo relays it from the runtime package's test:long-run task (with or without its task prefix).
 */
const NATIVE_LINE =
  /^(?:@clockgrove\/runtime:test:long-run: )?native-owner parity ([\w-]+(?:\/[\w-]+)*)\/([\w-]+):([^\s:]+): (?:match|MISMATCH) actual (\S+) expected (\S+) \((\d+) commands, (\d+) continuation chunks, (\d+) retries, (\d+) restarts, (\d+) ms\)$/gmu;

/**
 * Native-owner scenario parity from the test:long-run log (native-parity.long-run.test.ts): each
 * golden run's final hash as PostgreSQL held it, compared here with the committed golden, and each
 * pack's 30-day accelerated soak against its pure run. The log is authenticated by its receipt.
 */
async function scenarios(root, directory, longRun, decode) {
  const goldens = await goldenRuns(root, decode);
  const golden = new Map(goldens.map((entry) => [entry.run, entry.finalStateHash]));
  if (longRun.status === "missing") return { goldens, status: "missing", runs: [], soak: [] };
  // Terminal colour codes, if a runner adds them, are not part of a line.
  const log = (await readFile(path.join(directory, "test-long-run.log"), "utf8")).replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
    "",
  );
  const runs = [];
  const soak = [];
  const seen = new Set();
  for (const [
    ,
    pack,
    scenario,
    run,
    actual,
    expected,
    commands,
    chunks,
    retries,
    restarts,
  ] of log.matchAll(NATIVE_LINE)) {
    const id = `${pack}/${scenario}:${run}`;
    assert(!seen.has(id), `${id} reported twice in the test:long-run log`);
    seen.add(id);
    const counts = { commands: +commands, chunks: +chunks, retries: +retries, restarts: +restarts };
    if (golden.has(id)) {
      const matches = actual === golden.get(id);
      assert(
        matches || longRun.status !== "passed",
        `${id} golden mismatch under a passing test:long-run`,
      );
      runs.push({ run: id, finalStateHash: actual, matches, ...counts });
    } else
      soak.push({
        run: id,
        finalStateHash: actual,
        pureFinalStateHash: expected,
        matches: actual === expected,
        ...counts,
      });
  }
  return { goldens, status: scenarioStatus({ goldens, runs, soak }, longRun.status), runs, soak };
}

const readOptional = (file) =>
  readFile(file).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

/**
 * The wave3-load-curves job's receipt and result, bound to the candidate. The job writes the result
 * to a directory inside its evidence directory, named by the command's one argument.
 */
async function loadCurves(directory, candidate) {
  const [name, prefix] = LOAD_CURVES;
  const recordedBytes =
    directory && (await readOptional(path.join(directory, `${name}.result.json`)));
  const recorded = recordedBytes ? JSON.parse(recordedBytes.toString("utf8")) : undefined;
  // Any other command is refused by `receipt` as a command mismatch.
  const command =
    Array.isArray(recorded?.command) &&
    recorded.command.length === prefix.length + 1 &&
    sameCommand(recorded.command.slice(0, prefix.length), prefix)
      ? recorded.command
      : prefix;
  const result = await receipt(recorded ? directory : null, name, command, candidate);
  const bytes =
    recorded &&
    (await readOptional(path.join(directory, path.basename(command.at(-1)), LOAD_CURVES_FILE)));
  if (!bytes) return { receipt: result, status: result.status === "failed" ? "failed" : "missing" };
  const curves = JSON.parse(bytes.toString("utf8"));
  assert.equal(curves.kind, "clockgrove.wave3-load-curves", "load-curve result kind");
  assert.equal(curves.candidate.commit, candidate.commit, "load-curve candidate mismatch");
  assert.equal(curves.candidate.tree, candidate.tree, "load-curve tree mismatch");
  const passed = result.status === "passed" && curves.status === "passed";
  return {
    receipt: result,
    status: passed
      ? "passed"
      : [result.status, curves.status].includes("failed")
        ? "failed"
        : "pending",
    digest: digest(bytes),
    documentation: curves.documentation,
    host: curves.host ?? null,
    wallTime: curves.wallTime,
    loadCurves: curves.loadCurves,
    resourceCounters: curves.resourceCounters,
    budgets: (curves.budgets ?? []).map((budget) => ({
      ...budget,
      disposition: budgetDisposition(budget),
    })),
    partitionSeams: curves.partitionSeams ?? null,
  };
}

/** A measured budget is `measured`; a hint is a hint; one the fixture cannot see is pending. */
function budgetDisposition(budget) {
  if (budget.status === "hint") return { status: "hint" };
  if (["tripped", "not-reached"].includes(budget.status)) return { status: "measured" };
  return { status: "pending", issues: [UNOBSERVED_BUDGETS[budget.name]].filter(Boolean) };
}

const receiptStatus = (manifest, name) =>
  manifest.tests.find((item) => item.name === name)?.status ?? "missing";

/**
 * Every §17 case of the fault matrix's bytes: a tested case takes its command's receipt status; the
 * rest keep their owner.
 */
export const faults = (matrixBytes, tests) => ({
  digest: digest(matrixBytes),
  cases: JSON.parse(matrixBytes.toString("utf8")).rows.map((entry) => ({
    ...entry,
    status:
      entry.disposition === "tested"
        ? receiptStatus({ tests }, COMMAND_RECEIPTS[entry.command])
        : entry.disposition,
  })),
});

/** Every literal §18.2 item, pending on the issue that owns hosted Cloudflare evidence. */
export const cloudQualification = (hosted) =>
  hosted.map((item) => ({
    item,
    disposition: "pending",
    pending: { missing: HOSTED.cloudflare.scope, issues: HOSTED.cloudflare.issues },
  }));

/** One disposition per literal §23 item, derived only from the manifest's own facts. */
export function exitChecklist(manifest, items) {
  const receipts = (...names) => names.map((name) => `tests:${name}`);
  const rules = [
    {
      evidence: [],
      review: `${REVIEW}: the Objectives issue 698, issue 699, issue 700, issue 701 and issue 702 and the cleanup merges are on the candidate with frozen contracts`,
      deferred: ["actorAgent", "transfer"],
    },
    {
      evidence: receipts("test", "check"),
      needs: ["test", "check"],
      observed:
        "pnpm test proves the Worker fails closed without authentication and never routes, and that Cloudflare composition ignores an injected test provider; pnpm check refuses production imports of test authentication",
    },
    {
      evidence: receipts("test-db"),
      needs: ["test-db"],
      observed:
        "test:db's local composition journey pins literal golden route vectors for world, space and actor-agent names: versioned SHA-256 digests over opaque canonical IDs",
    },
    {
      evidence: [...receipts("test-runtime"), "faults"],
      needs: ["test-runtime"],
      hosted: "cloudflare",
      observed: "local creation, eviction and restart recover the committed state from PostgreSQL",
    },
    {
      evidence: receipts("test-runtime"),
      needs: ["test-runtime"],
      deferred: ["fidelity"],
      observed:
        "a replaced runtime, with or without its local storage, keeps its world and space identity and rehydrates from PostgreSQL",
    },
    {
      evidence: [...receipts("test-runtime", "test"), "faults"],
      needs: ["test-runtime", "test"],
      // Its §17 row's superseded route-name version after a Cloudflare deployment is pending on issue 3.
      hosted: "cloudflare",
      observed:
        "As amended: stale supplied epochs are refused against the shared routing epoch before mutation, also after hydration, and stale incarnations are fenced by owner generation",
    },
    {
      evidence: [...receipts("test-long-run"), "loadCurves"],
      review: `${REVIEW}: the autonomous parity's long-sleep mode shows awake/asleep material equivalence and the load curves' alarm lateness bounds wake latency, for which no budget is declared`,
      deferred: ["fidelity"],
    },
    {
      evidence: [...receipts("test-runtime"), "faults"],
      needs: ["test-runtime"],
      observed:
        "The native owner answers a world command only from its journal outcome, before and after a lost commit",
    },
    {
      evidence: [...receipts("test-runtime"), "faults"],
      needs: ["test-runtime"],
      observed:
        "Local state behind, ahead of or corrupt against PostgreSQL is replaced from PostgreSQL",
    },
    {
      evidence: [...receipts("test-runtime"), "faults"],
      needs: ["test-runtime"],
      observed:
        "The SpaceDO mailbox's depth, deadline, cancellation and interleaving matrix passes",
    },
    {
      evidence: [...receipts("test", "test-runtime", "test-db"), "faults"],
      needs: ["test", "test-runtime", "test-db"],
      observed:
        "One-alarm activation, pause, resume and policy changes, retries and catch-up escalation to the Workflow pass",
    },
    {
      evidence: [...receipts("test-runtime", "test-db"), "faults"],
      needs: ["test-runtime", "test-db"],
      observed:
        "world-reactions publishes, deduplicates redelivery, isolates poison siblings, dead-letters and replays through the operator action",
    },
    {
      evidence: [...receipts("test-runtime", "test-db"), "faults"],
      needs: ["test-runtime", "test-db"],
      hosted: "cloudflare",
      observed: "local Workflow retry, cancel, replacement and result reconciliation pass",
    },
    { evidence: [], deferred: ["actorAgent"], whole: true },
    { evidence: [], deferred: ["transfer"], whole: true },
    {
      evidence: [...receipts("test-long-run"), "scenarios"],
      needs: ["test-long-run"],
      scenarios: true,
      hosted: "cloudflare",
      observed:
        "Every golden run through the native owner ends on its golden's final hash, and live, frequent-alarm, sleep, catch-up, redelivery, restart and replacement runs match headless execution",
    },
    {
      evidence: [...receipts("test-runtime", "test-db"), "faults"],
      review: `${REVIEW}: the runtime-state view and causal chain diagnose each tested §17 case with causal links`,
    },
    {
      evidence: [
        ...receipts("test", "test-db", "test-runtime", "test-long-run"),
        "scenarios",
        "loadCurves",
      ],
      needs: ["test", "test-db", "test-runtime", "test-long-run"],
      scenarios: true,
      loadCurves: true,
      hosted: "cloudflare",
      observed: "the local runtime suites, native scenario parity and load curves pass",
    },
    {
      evidence: receipts("install", "qualify-wave0"),
      needs: ["install", "qualify-wave0"],
      hosted: "deployable",
      observed: "a frozen install and local recovery and independent builds reproduce",
    },
  ];
  assert.equal(rules.length, items.length, "a §23 item has no disposition rule");
  return items.map((item, index) => {
    const rule = rules[index];
    const statuses = (rule.needs ?? []).map((name) => receiptStatus(manifest, name));
    const facts = [
      ...statuses,
      ...(rule.scenarios ? [manifest.scenarios.status] : []),
      ...(rule.loadCurves ? [manifest.loadCurves.status] : []),
    ];
    const local = facts.includes("failed")
      ? "failed"
      : facts.every((status) => status === "passed")
        ? "passed"
        : "pending";
    const disposition = rule.whole
      ? "deferred"
      : rule.review
        ? "review"
        : local === "failed"
          ? "failed"
          : rule.hosted || local === "pending"
            ? "pending"
            : "passed";
    // What a pending item lacks: local evidence this Qualification run supplies, then hosted evidence.
    const lacking = [
      ...(rule.needs ?? [])
        .filter((_, at) => statuses[at] !== "passed")
        .map((name) => `${name} receipt`),
      ...(rule.scenarios && manifest.scenarios.status !== "passed"
        ? ["native scenario parity"]
        : []),
      ...(rule.loadCurves && manifest.loadCurves.status !== "passed" ? ["load curves"] : []),
    ].map((part) => `a passing ${part} at the candidate`);
    if (rule.hosted) lacking.push(HOSTED[rule.hosted].scope);
    return {
      item,
      disposition,
      evidence: rule.evidence,
      observed:
        disposition === "passed" || (rule.hosted && local === "passed") ? rule.observed : null,
      review: rule.review ?? null,
      pending:
        disposition === "pending"
          ? { missing: lacking.join("; "), issues: rule.hosted ? HOSTED[rule.hosted].issues : [] }
          : null,
      hosted: rule.hosted ? { ...HOSTED[rule.hosted], local } : null,
      deferred: (rule.deferred ?? []).map((key) => DEFERRED[key]),
    };
  });
}

/** `qualified` needs every item passed or deferred; only open reviews make it `pending-review`. */
function exitDecision(checklist) {
  const unmet = checklist.filter((entry) => !["passed", "deferred"].includes(entry.disposition));
  return {
    status: unmet.length
      ? unmet.every((entry) => entry.disposition === "review")
        ? "pending-review"
        : "not-qualified"
      : "qualified",
    unmet: unmet.map((entry) => entry.item),
    review: checklist.filter((entry) => entry.disposition === "review").map((entry) => entry.item),
    pending: checklist
      .filter((entry) => entry.disposition === "pending")
      .map((entry) => ({ item: entry.item, issues: entry.pending.issues })),
  };
}

/**
 * `schema` is the migrated database's schema identity, measured by the caller (qualify-wave3.mjs);
 * `decode` reads canonical golden bytes.
 */
export async function buildWave3Manifest({
  root,
  qualificationDirectory,
  loadCurveDirectory,
  execution,
  schema,
  decode,
}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const candidate = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=no") === "",
  };
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const migrations = (await readdir(path.join(root, "db/migrations")))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  const tests = [];
  for (const [name, command] of RECEIPTS)
    tests.push(await receipt(qualificationDirectory, name, command, candidate));
  const load = await loadCurves(loadCurveDirectory, candidate);
  tests.push(load.receipt);
  const { checklist, hosted } = await literalItems(root);
  const manifest = {
    kind: "clockgrove.wave3-evidence-manifest",
    version: 1,
    candidate,
    execution,
    versions: {
      toolchain: {
        node: rootManifest.engines.node,
        pnpm: rootManifest.packageManager.replace(/^pnpm@/u, ""),
      },
      lockfileDigest: digest(await readFile(path.join(root, "pnpm-lock.yaml"))),
    },
    runtime: await runtime(root, rootManifest),
    database: {
      migrationHead: migrations.at(-1).slice(0, -".sql".length),
      migrations: await files(
        root,
        migrations.map((name) => `db/migrations/${name}`),
      ),
      schema,
    },
    tests,
    runtimeCommands: await runtimeCommands(root),
    faults: faults(await readFile(path.join(root, FAULT_MATRIX)), tests),
    scenarios: await scenarios(
      root,
      qualificationDirectory,
      tests.find((item) => item.name === "test-long-run"),
      decode,
    ),
    loadCurves: (({ receipt: _receipt, ...rest }) => rest)(load),
    cloudQualification: cloudQualification(hosted),
    deferredScope: Object.values(DEFERRED),
  };
  manifest.exitChecklist = exitChecklist(manifest, checklist);
  manifest.exitDecision = exitDecision(manifest.exitChecklist);
  return manifest;
}

/**
 * Repository-owned validation: shape, candidate binding and dispositions recomputed from facts.
 * `decode` reads canonical golden bytes, so scenario parity is checked against the committed goldens.
 */
export async function validateWave3Manifest(manifest, root, decode) {
  assert.equal(manifest.kind, "clockgrove.wave3-evidence-manifest", "manifest kind");
  assert.equal(manifest.version, 1, "manifest version");
  assert.match(manifest.candidate.commit, /^[0-9a-f]{40}$/u, "candidate commit");
  assert.match(manifest.versions.lockfileDigest, DIGEST, "lockfile digest");
  assert.match(manifest.database.schema.hash, DIGEST, "schema hash");
  assert.equal(
    `db/migrations/${manifest.database.migrationHead}.sql`,
    manifest.database.migrations.at(-1)?.path,
    "migration head",
  );
  assert.equal(
    manifest.runtime.bindingManifest.digest,
    digest(JSON.stringify(manifest.runtime.bindingManifest.files)),
    "binding manifest digest",
  );
  assert.deepEqual(
    manifest.tests.map((item) => item.name),
    [...RECEIPTS.map(([name]) => name), LOAD_CURVES[0]],
    "one entry per qualification receipt",
  );
  for (const item of manifest.tests) {
    assert(["passed", "failed", "unknown", "missing"].includes(item.status), `${item.name} status`);
    if (item.status === "passed") {
      assert.equal(
        item.commit,
        manifest.candidate.commit,
        `${item.name} receipt candidate mismatch`,
      );
      assert.equal(item.tree, manifest.candidate.tree, `${item.name} receipt tree mismatch`);
      assert.match(item.outputDigest, DIGEST, `${item.name} log digest`);
      assert.equal(item.exitCode, 0, `${item.name} exit code`);
    }
  }
  assert.deepEqual(
    manifest.faults,
    faults(await readFile(path.join(root, FAULT_MATRIX)), manifest.tests),
    "§17 fault cases do not follow the fault matrix and their receipts",
  );
  assert.deepEqual(manifest.runtimeCommands, await runtimeCommands(root), "§18.1 commands");
  for (const budget of manifest.loadCurves.budgets ?? [])
    assert.deepEqual(budget.disposition, budgetDisposition(budget), `${budget.name} disposition`);
  if (manifest.loadCurves.status === "passed")
    assert.equal(
      receiptStatus(manifest, LOAD_CURVES[0]),
      "passed",
      "load curves without a receipt",
    );
  const { goldens, runs, soak, status } = manifest.scenarios;
  assert.deepEqual(
    goldens,
    await goldenRuns(root, decode),
    "scenario goldens are not the committed goldens",
  );
  for (const entry of runs)
    assert.equal(
      entry.matches,
      entry.finalStateHash === goldens.find((golden) => golden.run === entry.run)?.finalStateHash,
      `${entry.run} match`,
    );
  for (const entry of soak)
    assert.equal(
      entry.matches,
      entry.finalStateHash === entry.pureFinalStateHash,
      `${entry.run} match`,
    );
  assert.equal(
    status,
    scenarioStatus(manifest.scenarios, receiptStatus(manifest, "test-long-run")),
    "native scenario parity status exceeds its runs",
  );
  const { checklist, hosted } = await literalItems(root);
  for (const entry of [
    ...manifest.cloudQualification,
    ...manifest.exitChecklist.filter((item) => item.hosted),
  ])
    assert.notEqual(
      entry.disposition,
      "passed",
      `hosted item "${entry.item}" marked passed without hosted evidence`,
    );
  assert.deepEqual(
    manifest.cloudQualification,
    cloudQualification(hosted),
    "every literal §18.2 item stays pending on issue 3",
  );
  assert.deepEqual(
    manifest.exitChecklist.map((entry) => entry.item),
    checklist,
    "exactly one disposition per literal §23 item",
  );
  assert.deepEqual(
    manifest.exitChecklist,
    exitChecklist(manifest, checklist),
    "dispositions exceed their receipts",
  );
  assert.deepEqual(
    manifest.exitDecision,
    exitDecision(manifest.exitChecklist),
    "exit decision does not follow the checklist",
  );
  return manifest;
}
