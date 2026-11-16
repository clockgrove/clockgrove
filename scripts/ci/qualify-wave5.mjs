#!/usr/bin/env node
// Builds the Wave 5 qualification manifest (plan §20, RW-0510) on one frozen candidate.
// Usage: pnpm run qualify:wave5 [--out <dir>]
// Records the declared comparison domains first, then runs the §17 local suites and the database
// attack suite on this checkout with CLOCKGROVE_WAVE5_EVIDENCE set, so the native world-owner
// journeys write their §18 samples beside the manifest, and runs the scripted evals. It maps every
// §17 scenario, the crash matrix, the security fixtures, the §18 gates and the §20 items to the
// tests that prove them, aggregates the §18 measurements, and keeps hosted and real-provider items
// pending on issue 3 and the rubric pilot pending on its owner. The manifest and its evidence are
// written once to a directory this run owns and made read-only; a second run never overwrites them.
// Exit 0 when the manifest is written, whatever the exit decision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { digest, root } from "./evidence.mjs";

const MANIFEST_FILE = "wave5-manifest.json";
const PLAN =
  "docs/waves/clockgrove-wave-5-conversations-models-capabilities-mcp-implementation-plan.md";
const MATRIX = "scripts/ci/qualify-wave5-scenarios.json";
const COMPARISON = "scripts/ci/qualify-wave5-comparison.json";
/** Hosted qualification of Waves 2-5 (owner decision 2a, issue 169), blocked on staging and deploy. */
const HOSTED = { ownerIssue: 3, blockedOn: [1, 2] };
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
/**
 * The §17 local suites in plan order, then the database attack suite, with the files each runs
 * (package.json names the same files; tests/ci/qualify-wave5.test.mjs checks they agree). A
 * browser suite needs CI=true, the guard of tests/ci/vitest.browser.config.ts. Decision: 15 minutes
 * per suite, as qualify:wave4, except test:db, which runs every PostgreSQL attack file: 60 minutes.
 */
const SUITES = (await json(path.join(root, MATRIX))).suites.map((suite) => ({
  ...suite,
  files: suite.files.map((pattern) => new RegExp(pattern, "u")),
}));
const SUITE_TIMEOUT_MS = 15 * 60_000;
/** The scripted evaluations, never --live: scripted models are deterministic fixtures. */
const EVALS = [
  { name: "wake-triage", script: "scripts/wake-triage-eval.mjs" },
  { name: "moderation", script: "scripts/moderation-eval.mjs" },
];

const argv = process.argv.slice(2).filter((argument) => argument !== "--");
assert(
  argv.length === 0 || (argv.length === 2 && argv[0] === "--out"),
  "usage: qualify:wave5 [--out <dir>]",
);
const out = path.resolve(argv[1] ?? path.join(root, ".qualification", `wave5-${Date.now()}`));
await access(path.join(out, MANIFEST_FILE)).then(
  () => {
    throw new Error("refuse overwriting a prior Wave 5 manifest; use a separately owned directory");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
const evidence = path.join(out, "evidence");
await mkdir(evidence, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = (file) => readFile(path.join(root, file), "utf8");
/** sha256 over each tracked file's path and bytes, in path order: one digest for a file set. */
async function treeDigest(...paths) {
  const files = git("ls-files", "-z", ...paths)
    .split("\0")
    .filter(Boolean)
    .sort();
  const parts = await Promise.all(
    files.map(async (file) => `${file}\0${digest(await readFile(path.join(root, file)))}`),
  );
  return { files: files.length, digest: digest(parts.join("\n")) };
}
const literals = async (files, pattern) =>
  [
    ...new Set(
      (await Promise.all(files.map(source))).flatMap((text) =>
        [...text.matchAll(pattern)].map((match) => match[1]),
      ),
    ),
  ].sort();

// The comparison domains are declared before the run: copied beside the manifest first.
const comparisonText = await source(COMPARISON);
await writeFile(path.join(out, "comparison-domains.json"), comparisonText);
const comparisonDomains = {
  file: COMPARISON,
  sha256: digest(comparisonText),
  declaredAt: new Date().toISOString(),
  domains: JSON.parse(comparisonText).domains,
};

// The frozen candidate: the commit, and whether the working tree differs from it.
const candidate = { commit: git("rev-parse", "HEAD"), clean: git("status", "--porcelain") === "" };

// Schema, policy, model and tool versions, read from their sources of truth.
const migrations = git("ls-files", "db/migrations")
  .split("\n")
  .filter((file) => file.endsWith(".sql"))
  .sort();
const POLICY_FILES = [
  "packages/application/src/capabilities.ts",
  "packages/application/src/capability-registry.ts",
  "packages/application/src/cognition.ts",
  "packages/application/src/mcp-capability-registry.ts",
  "packages/model-gateway/src/aliases.ts",
];
const MODEL_FILES = [
  "packages/model-gateway/src/aliases.ts",
  "packages/model-gateway/src/gateway.ts",
  "packages/model-gateway/src/scripted.ts",
  "worlds/fixture/reference/runtime.json",
];
const TOOL_FILES = [
  "packages/application/src/capability-registry.ts",
  "packages/application/src/mcp-capability-registry.ts",
  "packages/application/src/mcp-execution.ts",
  "packages/application/src/mcp-http.ts",
  "packages/application/src/mcp-network.ts",
  "apps/runtime/src/mcp-actor-capabilities.ts",
  "apps/runtime/src/world-mcp-server.ts",
];
const dependency = async (pkg, name) => (await json(path.join(root, pkg))).dependencies?.[name];
const fixtureModel = (await json(path.join(root, "worlds/fixture/reference/runtime.json"))).model;
const versions = {
  schema: {
    latestMigration: migrations.at(-1),
    migrations: migrations.length,
    ...(await treeDigest("db/migrations")),
  },
  policy: {
    policyVersions: [
      ...(await literals(POLICY_FILES, /policyVersion:\s*"([^"]+)"/gu)),
      ...(fixtureModel?.aliases ?? []).map(({ policyVersion }) => policyVersion),
    ].sort(),
    promptVersions: await literals(POLICY_FILES, /PROMPT_VERSION = "([^"]+)"/gu),
    ...(await treeDigest(...POLICY_FILES)),
  },
  model: {
    routes: await literals(["packages/model-gateway/src/aliases.ts"], /\bid: "([^"]+)"/gu),
    fixtureWorldAliases: (fixtureModel?.aliases ?? []).map(({ alias, routes }) => ({
      alias,
      routes: routes.map(({ id }) => id),
    })),
    sdk: {
      ai: await dependency("packages/model-gateway/package.json", "ai"),
      "@ai-sdk/anthropic": await dependency(
        "packages/model-gateway/package.json",
        "@ai-sdk/anthropic",
      ),
    },
    ...(await treeDigest(...MODEL_FILES)),
  },
  tools: {
    agentsSdk: await dependency("apps/runtime/package.json", "agents"),
    ...(await treeDigest(...TOOL_FILES)),
  },
};

// Each suite runs once on this candidate; its log is evidence beside the manifest.
const suites = [];
for (const suite of SUITES) {
  const started = Date.now();
  const result = await ownedSubprocess("pnpm", ["run", suite.name], {
    cwd: root,
    env: {
      ...process.env,
      CLOCKGROVE_WAVE5_EVIDENCE: evidence,
      ...(suite.browser ? { CI: "true" } : {}),
    },
    timeoutMs: (suite.timeoutMinutes ?? 15) * 60_000,
  });
  const log = `${result.stdout}${result.stderr}`;
  await writeFile(path.join(evidence, `${suite.name.replaceAll(":", "-")}.log`), log);
  suites.push({
    name: suite.name,
    command: `${suite.browser ? "env CI=true " : ""}pnpm run ${suite.name}`,
    status: result.status === 0 && !result.error ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    logDigest: digest(log),
  });
  process.stdout.write(`${suites.at(-1).status.padEnd(8)} ${suite.name}\n`);
}
const suiteOf = (file) =>
  SUITES.find((suite) => suite.files.some((pattern) => pattern.test(file)))?.name;
const passed = (name) => suites.find((suite) => suite.name === name)?.status === "passed";

// The scripted evaluations: their reports are evidence; a live run is a manual step on issue 3.
const scriptedEvals = [];
for (const { name, script } of EVALS) {
  const report = path.join(evidence, `${name}-eval.json`);
  const result = await ownedSubprocess(process.execPath, [script, "--output", report], {
    cwd: root,
    env: { ...process.env, CLOCKGROVE_WAVE5_EVIDENCE: evidence },
    timeoutMs: SUITE_TIMEOUT_MS,
  });
  const log = `${result.stdout}${result.stderr}`;
  await writeFile(path.join(evidence, `${name}-eval.log`), log);
  const body = await json(report).catch(() => null);
  scriptedEvals.push({
    name,
    command: `node ${script} --output <evidence>/${name}-eval.json`,
    measurement: body?.measurement ?? null,
    status: result.status === 0 && body?.measurement === "scripted" ? "passed" : "failed",
    report: body === null ? null : `evidence/${name}-eval.json`,
    models: (body?.models ?? []).map(({ modelAlias, model, policyVersion, accuracy }) => ({
      modelAlias,
      model,
      policyVersion,
      accuracy,
    })),
    logDigest: digest(log),
  });
}

// Every row's cited markers must still be in their files; its result is its suites'.
const matrix = await json(path.join(root, MATRIX));
const COVERAGE = ["full", "partial", "gap"];
const resolve = async (row) => {
  assert(COVERAGE.includes(row.coverage), `${row.id}: unknown coverage ${row.coverage}`);
  const evidenceRows = [];
  for (const { file, marker } of row.evidence) {
    const text = await source(file).catch(() => "");
    const suite = suiteOf(file) ?? null;
    evidenceRows.push({
      file,
      marker,
      found: text.includes(marker),
      suite,
      result: suite === null ? "outside-wave5-suites" : passed(suite) ? "passed" : "failed",
    });
  }
  const proven =
    evidenceRows.length > 0 &&
    evidenceRows.every(({ found, result }) => found && result !== "failed");
  // Evidence no suite of this run ran was not executed on this candidate: a marker, not a pass.
  const ran = evidenceRows.every(({ result }) => result === "passed");
  const status =
    row.coverage === "gap"
      ? "gap"
      : !proven
        ? "failed"
        : row.coverage === "full" && ran
          ? "passed"
          : "deviation";
  const outside = evidenceRows.filter(({ result }) => result === "outside-wave5-suites");
  const deviation =
    row.coverage === "full" && !ran
      ? `cited evidence no suite of this run ran: ${outside.map(({ file }) => file).join(", ")}`
      : row.deviation;
  return { ...row, evidence: evidenceRows, status, ...(deviation ? { deviation } : {}) };
};
const resolveAll = (rows) => Promise.all(rows.map(resolve));
const scenarios = await resolveAll(matrix.scenarios);
const crashMatrix = await resolveAll(matrix.crashMatrix);
const securityFixtures = await resolveAll(matrix.securityFixtures);
const securityGates = await resolveAll(matrix.securityGates);
const outcomeRows = await resolveAll(matrix.outcomeRows);
const exitRows = await resolveAll(matrix.exitItems);
const allRows = [
  ...scenarios,
  ...crashMatrix,
  ...securityFixtures,
  ...securityGates,
  ...outcomeRows,
  ...exitRows,
];
const byId = (id) => {
  const row = allRows.find((entry) => entry.id === id);
  assert(row, `${id}: no such row in ${MATRIX}`);
  return row;
};

// §18: the native owner journeys' samples, aggregated. Null cost or tokens are unknown, counted.
const sampleDirectory = path.join(evidence, "observability");
const samples = await Promise.all(
  (await readdir(sampleDirectory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => json(path.join(sampleDirectory, name))),
);
const rows = (key) => samples.flatMap((sample) => sample.rows?.[key] ?? []);
const count = (values) =>
  Object.fromEntries(
    [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort(
      ([left], [right]) => String(left).localeCompare(String(right)),
    ),
  );
/** Distribution over known values; nulls are counted as unknown, never as zero. */
const distribution = (values) => {
  const known = values
    .filter((value) => value !== null && value !== undefined)
    .sort((a, b) => a - b);
  const at = (quantile) =>
    known[Math.min(known.length - 1, Math.ceil(quantile * known.length) - 1)];
  return {
    known: known.length,
    unknown: values.length - known.length,
    ...(known.length === 0
      ? {}
      : {
          min: known[0],
          p50: at(0.5),
          p95: at(0.95),
          max: known.at(-1),
          sum: known.reduce((sum, value) => sum + value, 0),
        }),
  };
};
const runs = rows("runs");
const steps = rows("steps");
const attempts = steps.filter(({ kind }) => kind === "model_attempt");
const fibers = rows("fibers");
const activations = rows("activations");
const effects = rows("effects");
const effectAttempts = rows("effectAttempts");
/** Known spend and unknown-cost count per scope: model attempts plus effect attempts. */
const spendBy = (key) =>
  Object.fromEntries(
    [...new Set(attempts.map((step) => step[key]))].sort().map((scope) => {
      const mine = attempts.filter((step) => step[key] === scope);
      return [scope, distribution(mine.map(({ costMicrousd }) => costMicrousd))];
    }),
  );
const observability = {
  samples: {
    count: samples.length,
    files: [...new Set(samples.map(({ file }) => file))].sort(),
    errors: samples
      .filter(({ error }) => error !== undefined)
      .map(({ file, error }) => ({ file, error })),
    directory: "evidence/observability",
  },
  measured: {
    activationReasons: count(activations.map(({ reason }) => reason)),
    activationStatuses: count(activations.map(({ status }) => status)),
    coalesced: activations.filter(({ leader }) => leader === false).length,
    noOpRate:
      activations.length === 0
        ? null
        : activations.filter(({ status }) => status === "noop").length / activations.length,
    budgetDeferred: activations.filter(({ status }) => status === "deferred").length,
    runStatuses: count(runs.map(({ status }) => status)),
    turnDurationMs: distribution(runs.map(({ durationMs }) => durationMs)),
    fiberPhases: count(fibers.map(({ phase }) => phase)),
    fiberAttempts: distribution(fibers.map(({ attempt }) => attempt)),
    recoveredFibers: fibers.filter(({ attempt }) => attempt > 1).length,
    modelAttempts: {
      count: attempts.length,
      byModel: count(attempts.map(({ model }) => model)),
      statuses: count(attempts.map(({ status }) => status)),
      inputTokens: distribution(attempts.map(({ inputTokens }) => inputTokens)),
      outputTokens: distribution(attempts.map(({ outputTokens }) => outputTokens)),
      costMicrousd: distribution(attempts.map(({ costMicrousd }) => costMicrousd)),
      durationMs: distribution(attempts.map(({ durationMs }) => durationMs)),
    },
    stepKinds: count(steps.map(({ kind }) => kind)),
    toolCalls: count(
      steps.filter(({ kind }) => kind === "tool_execution").map(({ tool }) => tool ?? "unnamed"),
    ),
    approvals: count(rows("approvals").map(({ state }) => state)),
    effects: {
      dispositions: count(effects.map(({ disposition }) => disposition)),
      ageMs: distribution(effects.map(({ ageMs }) => ageMs)),
      reservedMicrousd: distribution(effects.map(({ reservedMicrousd }) => reservedMicrousd)),
      attempts: count(effectAttempts.map(({ disposition }) => disposition)),
      uncertain: effectAttempts.filter(({ disposition }) => disposition === "uncertain").length,
      costMicrousd: distribution(effectAttempts.map(({ costMicrousd }) => costMicrousd)),
    },
    deliveryPolicyResults: count(rows("deliveries").map(({ status }) => status)),
    deliverySinks: count(rows("deliverySinks").map(({ sink }) => sink)),
    processes: {
      count: rows("processes").length,
      segments: distribution(rows("processes").map(({ segments }) => segments)),
      leaseEpochs: distribution(rows("processes").map(({ leaseEpoch }) => leaseEpoch)),
    },
    spendMicrousd: Object.fromEntries(
      ["tenant", "world", "timeline", "actor", "session"].map((key) => [key, spendBy(key)]),
    ),
    unknownCost: {
      modelAttempts: attempts.filter(({ costMicrousd }) => costMicrousd === null).length,
      effectAttempts: effectAttempts.filter(({ costMicrousd }) => costMicrousd === null).length,
    },
  },
  // §18 metrics the durable schema does not record: named, never invented.
  notObservable: [
    { metric: "actor/session queue depth", reason: "no durable record; queues are runtime state" },
    {
      metric: "phase time per fiber phase",
      reason:
        "a fiber keeps its created and last-updated time only; fiberAttempts and turnDurationMs are recorded instead",
    },
    {
      metric: "context tokens, sources and exclusions",
      reason:
        "the context manifest is an encrypted conversation-class artifact the sample does not decrypt",
    },
    {
      metric: "provider breaker state",
      reason: "the breaker is gateway memory; test:model-gateway asserts its opening and routing",
    },
  ],
};
const observabilityStatus =
  samples.length > 0 && observability.samples.errors.length === 0 && attempts.length > 0
    ? "measured"
    : "missing";

// Hosted and real-provider items stay pending on issue 3 and are never relabelled by local runs.
const hostedQualification = [
  {
    item: "qualify:wave5:staging",
    note: "the hosted Wave 5 qualification; the command does not exist yet",
  },
  {
    item: "real-provider staging tests",
    note: "manual only, with a repository secret, never in CI by default (owner decision, issue 19): CLOCKGROVE_MODEL_LIVE=1 pnpm --filter @clockgrove/model-gateway test:live, and the evals with --live",
  },
  {
    item: "hosted MCP egress",
    note: "the deterministic fixture MCP servers deployed as their own staging Worker on a separate host (owner decision 3a, issue 169)",
  },
].map((entry) => ({ ...entry, status: "pending", ...HOSTED, evidence: null }));
const humanItems = [
  {
    item: "conversation-usefulness rubric pilot (Kirk plus two testers, three recorded real-route conversations)",
    rubric: "the rubric approved by Kirk on 2026-11-07, issue 19",
    status: "pending",
    owner: "Kirk",
    ownerIssue: 19,
    evidence: null,
  },
];

// §20: each literal item with the rows that prove it.
const rowStatus = (ids) => {
  const cited = ids.map(byId);
  if (cited.some(({ status }) => status === "failed")) return "failed";
  if (cited.every(({ status }) => status === "passed")) return "passed";
  return "deviation";
};
const F_ROWS = crashMatrix.filter(({ id }) => id.startsWith("F-")).map(({ id }) => id);
const SECURITY = securityFixtures.map(({ id }) => id);
const section20 = [
  [
    "RW-0501 through RW-0510 are merged.",
    {
      review:
        "RW-0501 to RW-0509 merge through their issues (#164 to #168, the internal-capabilities Objective and #162); RW-0510 is this candidate, merged only after qualification",
    },
  ],
  [
    "Governed cognitive documents/versioned atomic change sets enforce write classes, authority, limits, provenance, inspector and retention policy.",
    ["X2"],
  ],
  ["Multiple sessions are independent, durable, participant-scoped, and resumable.", ["X3", "S1"]],
  ["Cognitive/interpreted/canonical voice disclosure is visible.", ["X4", "S2"]],
  ["Turn fiber recovers at every injected phase boundary.", [...F_ROWS, "S9"]],
  [
    "Actor activation is triggered, coalesced, budgeted, and no-op suppressible.",
    ["X6", "S10", "S11"],
  ],
  ["Model aliases, attempts, fallback, usage, and cost are inspectable.", ["X7", "S8"]],
  ["Context assembly is authorization-first and revision-grounded.", ["X8", "S3"]],
  [
    "Capabilities, grants, approvals, revocation, and world-command validation pass.",
    ["X9", "S12", "S13"],
  ],
  [
    "MCP lifecycle, network safety, schema drift, result sanitization, and effect idempotency pass.",
    ["X10", ...SECURITY],
  ],
  ["Browser, CLI, and fake channel address one canonical actor/session model.", ["X11"]],
  ["Preview/replay cannot produce live external delivery.", ["X12", "S15", "R-replay-preview"]],
  ["World remains active with model/MCP unavailable.", ["X13", "R-world-active"]],
  ["Local and real-provider/staging qualification pass.", null],
].map(([item, by]) =>
  by === null
    ? {
        item,
        status: "pending",
        pending: HOSTED,
        local: suites.every(({ status }) => status === "passed") ? "passed" : "failed",
      }
    : Array.isArray(by)
      ? { item, status: rowStatus(by), evidence: by }
      : { item, status: "review", review: by.review },
);

const uiAccessibility = {
  suites: ["test:e2e:chat", "test:e2e:approvals"].map((name) => ({
    name,
    status: passed(name) ? "passed" : "failed",
  })),
  rows: ["X14", "S14"].map((id) => ({ id, status: byId(id).status })),
};

const deviations = [
  ...allRows
    .filter(({ status }) => status !== "passed")
    .map(({ id, scenario, item, status, deviation }) => ({
      id,
      item: scenario ?? item,
      status,
      reason: deviation ?? "cited evidence failed or is missing",
    })),
  ...(candidate.clean
    ? []
    : [
        {
          id: "C1",
          item: "frozen candidate",
          status: "deviation",
          reason: "the working tree differs from the commit",
        },
      ]),
];
const blockers = [
  ...suites.filter(({ status }) => status !== "passed").map(({ name }) => `suite ${name} failed`),
  ...scriptedEvals
    .filter(({ status }) => status !== "passed")
    .map(({ name }) => `scripted eval ${name} failed`),
  ...(observabilityStatus === "measured" ? [] : ["§18 observability samples missing or failed"]),
  ...deviations.map(({ id, reason }) => `${id}: ${reason}`),
  ...hostedQualification.map(({ item }) => `${item}: pending on issue 3`),
  ...humanItems.map(({ item, owner }) => `${item}: pending on ${owner}`),
  ...section20
    .filter(({ status }) => status !== "passed")
    .map(({ item, status }) => `§20 ${item} ${status}`),
];
const manifest = {
  kind: "clockgrove.wave5-qualification",
  plan: `${PLAN}#20-exit-evidence-checklist`,
  generatedAt: new Date().toISOString(),
  execution: {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    world: "fixture",
    capacity: "concurrency at the level of the §17 scenarios only (owner decision 5a, issue 169)",
  },
  candidate,
  comparisonDomains,
  versions,
  suites,
  scriptedEvals,
  scenarios,
  crashMatrix: {
    fiberPhases: matrix.fiberPhases,
    terminalPhases: matrix.terminalPhases,
    rows: crashMatrix,
  },
  securityFixtures,
  securityGates,
  outcomeRows,
  exitItemRows: exitRows,
  observability: { status: observabilityStatus, ...observability },
  uiAccessibility,
  hostedQualification,
  humanItems,
  exitChecklist: section20,
  knownDeviations: deviations,
  exitDecision: { status: blockers.length === 0 ? "qualified" : "not-qualified", blockers },
};
await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
// Archived immutably: every file of the run is made read-only, and the manifest digest is printed.
const seal = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await seal(file);
    await chmod(file, entry.isDirectory() ? 0o555 : 0o444);
  }
};
await seal(out);
await chmod(out, 0o555);
for (const entry of section20)
  process.stdout.write(`${entry.status.padEnd(9)} §20 ${entry.item}\n`);
process.stdout.write(
  `deviations: ${deviations.length}; hosted items pending on issue 3: ${hostedQualification.length}\n` +
    `§18 samples: ${samples.length} (${observabilityStatus}); unknown-cost model attempts: ${observability.measured.unknownCost.modelAttempts}\n` +
    `exit decision: ${manifest.exitDecision.status}\n` +
    `Wave 5 manifest: ${path.join(out, MANIFEST_FILE)} ${digest(await readFile(path.join(out, MANIFEST_FILE)))}\n`,
);
