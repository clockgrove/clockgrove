#!/usr/bin/env node
// Builds the Wave 4 qualification manifest (plan §19) on one frozen candidate.
// Usage: pnpm run qualify:wave4 [--out <dir>]
// Runs the §15.1 suites on this checkout with CLOCKGROVE_WAVE4_EVIDENCE set, so the browser suites
// write their captures, accessibility report, Web Vitals and load evidence beside the manifest. Then
// it maps the §15.2 scenarios and the §16 matrix to the tests that prove them, compares the golden
// captures with human approvals and keeps hosted Cloudflare items pending on issue 3. The manifest and
// its evidence are written once to a directory this run owns and made read-only; a second run never
// overwrites them. Exit 0 when the manifest is written, whatever the exit decision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownedSubprocess } from "../lib/subprocess.mjs";
import { digest, root } from "./evidence.mjs";

export const MANIFEST_FILE = "wave4-manifest.json";
const PLAN = "docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md";
/** Hosted qualification of Waves 2-4, blocked on staging and the deploy of main. */
const HOSTED = { ownerIssue: 3, blockedOn: [1, 2] };
/**
 * The §15.1 suites in plan order, with the files each runs. A browser suite needs CI=true, the
 * guard of tests/ci/vitest.browser.config.ts. Decision: 15 minutes per suite, three times the
 * longest local run (the e2e journey, 210 s deadline), so a stuck suite fails rather than hangs.
 */
const SUITES = [
  {
    name: "test:projection",
    browser: false,
    files: [/^packages\/contracts\/test\/(scene-|asset-manifest)/u],
  },
  {
    name: "test:realtime",
    browser: false,
    files: [
      /^apps\/runtime\/test\/(scene-admission|scene-delivery|observer-authority)\.postgres|^apps\/runtime\/test\/(viewed-space|interaction-card)\.journey/u,
    ],
  },
  { name: "test:web", browser: false, files: [/^apps\/web\/test\/.*(convergence|query-state)/u] },
  { name: "test:scene", browser: false, files: [/^apps\/web\/test\/(scene-adapter|boundaries)/u] },
  { name: "test:e2e", browser: true, files: [/^tests\/e2e\//u] },
  { name: "test:visual", browser: true, files: [/^tests\/visual\//u] },
  { name: "test:a11y", browser: true, files: [/^tests\/accessibility\//u] },
  { name: "test:realtime:load", browser: true, files: [/^tests\/load\/realtime\//u] },
];
const SUITE_TIMEOUT_MS = 15 * 60_000;
const GOLDEN_STATES = [
  "daylight-dry",
  "dusk-rain",
  ...["dusk", "night"].flatMap((state) =>
    ["low", "medium", "high"].map((tier) => `${state}-rain-${tier}`),
  ),
  "selected-actor-rail",
  "event-why-inspector",
  "selected-inspectable-object",
  "disconnected-recovering",
  "text-access",
];

const argv = process.argv.slice(2).filter((argument) => argument !== "--");
assert(
  argv.length === 0 || (argv.length === 2 && argv[0] === "--out"),
  "usage: qualify:wave4 [--out <dir>]",
);
const out = path.resolve(argv[1] ?? path.join(root, ".qualification", `wave4-${Date.now()}`));
await access(path.join(out, MANIFEST_FILE)).then(
  () => {
    throw new Error("refuse overwriting a prior Wave 4 manifest; use a separately owned directory");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
const evidence = path.join(out, "evidence");
await mkdir(evidence, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const optionalJson = (file) =>
  json(file).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
/** sha256 over each file's path and bytes, in path order: one digest for a tracked tree. */
async function treeDigest(directory) {
  const files = git("ls-files", "-z", directory).split("\0").filter(Boolean).sort();
  const parts = await Promise.all(
    files.map(async (file) => `${file}\0${digest(await readFile(path.join(root, file)))}`),
  );
  return { files: files.length, digest: digest(parts.join("\n")) };
}

// The frozen candidate: the commit, and whether the working tree differs from it.
const candidate = { commit: git("rev-parse", "HEAD"), clean: git("status", "--porcelain") === "" };

// Protocol, schema and asset versions, read from their sources of truth.
const constants = {};
for (const file of [
  "packages/contracts/src/scene-protocol.ts",
  "packages/contracts/src/scene-connection.ts",
])
  for (const [, name, value] of (await readFile(path.join(root, file), "utf8")).matchAll(
    /^export const (SCENE_(?:PROTOCOL|[A-Z_]+_VERSION)) = ("[^"]+"|\d+);/gmu,
  ))
    constants[name] = JSON.parse(value);
const migrations = git("ls-files", "db/migrations")
  .split("\n")
  .filter((file) => file.endsWith(".sql"))
  .sort();
const versions = {
  protocol: {
    subprotocol: constants.SCENE_PROTOCOL,
    protocolVersion: constants.SCENE_PROTOCOL_VERSION,
    projectionVersion: constants.SCENE_PROJECTION_VERSION,
    clientVersion: constants.SCENE_CLIENT_VERSION,
  },
  schema: {
    latestMigration: migrations.at(-1),
    migrations: migrations.length,
    ...(await treeDigest("db/migrations")),
  },
  assets: {
    assetManifestVersion: constants.SCENE_ASSET_MANIFEST_VERSION,
    manifests: await treeDigest("worlds/fixture/assets/manifests"),
    reviewed: await treeDigest("worlds/fixture/assets/reviewed"),
  },
};
assert(
  Object.values(versions.protocol).every((value) => value !== undefined),
  "a scene version constant is missing",
);

// The browser matrix: the lockfile-pinned Playwright Chromium, read from its package, not launched.
const playwright = await realpath(path.join(root, "node_modules/playwright"));
const browsers = await json(path.join(playwright, "../playwright-core/browsers.json"));
const chromium = browsers.browsers.find((browser) => browser.name === "chromium-headless-shell");
const browserMatrix = {
  engine: "chromium",
  playwright: (await json(path.join(playwright, "package.json"))).version,
  revision: chromium.revision,
  browserVersion: chromium.browserVersion,
  headless: true,
  viewports: [
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ],
  modes: [
    "webgpu-swiftshader",
    "forced-webgl2-swiftshader",
    "webgl-disabled-text-path",
    "reduced-motion",
  ],
};

// Each §15.1 suite runs once on this candidate; its log is evidence beside the manifest.
const suites = [];
for (const suite of SUITES) {
  const started = Date.now();
  const result = await ownedSubprocess("pnpm", ["run", suite.name], {
    cwd: root,
    env: {
      ...process.env,
      CLOCKGROVE_WAVE4_EVIDENCE: evidence,
      ...(suite.browser ? { CI: "true" } : {}),
    },
    timeoutMs: SUITE_TIMEOUT_MS,
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

// §15.2 and §16: each item's cited markers must still be in their files; its result is its suites'.
const matrix = await json(path.join(root, "scripts/ci/qualify-wave4-scenarios.json"));
const COVERAGE = ["full", "partial", "gap", "not_applicable"];
const resolve = async (row) => {
  assert(COVERAGE.includes(row.coverage), `${row.id}: unknown coverage ${row.coverage}`);
  // An owner ruled the item out of this wave: it carries its reason and no evidence, and is no gap.
  if (row.coverage === "not_applicable") {
    assert(
      typeof row.reason === "string" && row.reason !== "" && row.evidence.length === 0,
      `${row.id}: not_applicable needs a reason and no evidence`,
    );
    return { ...row, status: "not_applicable" };
  }
  const evidenceRows = [];
  for (const { file, marker } of row.evidence) {
    const source = await readFile(path.join(root, file), "utf8").catch(() => "");
    const suite = suiteOf(file) ?? null;
    evidenceRows.push({
      file,
      marker,
      found: source.includes(marker),
      suite,
      result: suite === null ? "outside-wave4-suites" : passed(suite) ? "passed" : "failed",
    });
  }
  const proven =
    evidenceRows.length > 0 &&
    evidenceRows.every(({ found, result }) => found && result !== "failed");
  // Evidence no §15.1 suite runs was not executed on this candidate: it is a marker, not a pass.
  const ran = evidenceRows.every(({ result }) => result === "passed");
  // A gap has no evidence to run: it is a deviation of its own, never a pass.
  const status =
    row.coverage === "gap"
      ? "gap"
      : !proven
        ? "failed"
        : row.coverage === "full" && ran
          ? "passed"
          : "deviation";
  const outside = evidenceRows.filter(({ result }) => result === "outside-wave4-suites");
  const deviation =
    row.coverage === "full" && !ran
      ? `cited evidence outside the §15.1 suites, not run on this candidate: ${outside.map(({ file }) => file).join(", ")}`
      : row.deviation;
  return { ...row, evidence: evidenceRows, status, ...(deviation ? { deviation } : {}) };
};
// Reviewer records (plan §19): rows a review did not accept as full, and the reviewed §19 items.
const reviewRecords = await json(path.join(root, "scripts/ci/qualify-wave4-review.json"));
const notFull = new Map(
  reviewRecords.scenarioRowsNotReviewedFull.map(({ id, issue, reason }) => [id, { issue, reason }]),
);
const withReview = (row) =>
  notFull.has(row.id)
    ? { ...row, review: { status: "not-reviewed-full", ...notFull.get(row.id) } }
    : row;
const scenarios = (await Promise.all(matrix.scenarios.map(resolve))).map(withReview);
const failureMatrix = (await Promise.all(matrix.failureMatrix.map(resolve))).map(withReview);
for (const id of notFull.keys())
  assert(
    [...scenarios, ...failureMatrix].some((row) => row.id === id),
    `${id}: no such scenario row`,
  );

// §15.3: capture hashes are taken from the files on disk and compared with human approvals.
const captured = await optionalJson(path.join(evidence, "visual/captures.json"));
const approvals = (await json(path.join(root, "tests/visual/approved-captures.json"))).approvals;
const goldenCaptures = [];
for (const backend of ["webgpu", "webgl2"])
  for (const state of GOLDEN_STATES)
    for (const { width, height } of browserMatrix.viewports) {
      const file = `${backend === "webgl2" ? "webgl2/" : ""}${state}@${width}x${height}.png`;
      const bytes = await readFile(path.join(evidence, "visual", file)).catch(() => null);
      const sha256 = bytes === null ? null : digest(bytes);
      const approved = approvals.filter((approval) => approval.file === file);
      goldenCaptures.push({
        backend,
        state,
        viewport: { width, height },
        file: bytes === null ? null : `evidence/visual/${file}`,
        sha256,
        approval:
          sha256 === null
            ? "missing"
            : approved.some((approval) => approval.sha256 === sha256)
              ? "approved"
              : approved.length > 0
                ? "changed-needs-human-approval"
                : "pending-human-approval",
      });
    }

const accessibility = await optionalJson(path.join(evidence, "accessibility-report.json"));
const load = await optionalJson(path.join(evidence, "realtime-load.json"));
const sceneBudgets = await json(path.join(root, "apps/web/scene-budgets.json"));
const performance = {
  webVitals: captured?.webVitals ?? null,
  interactionToNextPaint:
    "not measured: the journeys drive input through the DOM, not timed user input",
  frameBudgets: {
    budgets: sceneBudgets.budgets ?? sceneBudgets,
    enforcedBy: "test:e2e",
    status: passed("test:e2e") ? "passed" : "failed",
  },
  realtimeLoad: {
    ...(load ?? {}),
    status: passed("test:realtime:load") && load !== null ? "passed" : "failed",
  },
};
const measurements = {
  client: {
    names: captured?.measurements ?? [],
    assertedBy: "test:visual",
    status: passed("test:visual") ? "passed" : "failed",
  },
  server: { assertedBy: "test:realtime:load", status: performance.realtimeLoad.status },
};

// Hosted items stay pending on issue 3 and are never relabelled by local evidence.
const runtimeEvidence = await json(
  path.join(root, "docs/waves/clockgrove-wave-4-runtime-evidence.json"),
);
const cloudflareQualification = [
  ...runtimeEvidence.cloudflareQualification.map(({ scenario }) => scenario),
  "real-cloudflare-reconnect-and-snapshot-fallback",
  "qualify:wave4:staging",
].map((item) => ({ item, status: "pending", ...HOSTED, evidence: null }));

const deviations = [
  ...[...scenarios, ...failureMatrix]
    .filter((row) => row.status !== "passed" && row.status !== "not_applicable")
    .map((row) => ({
      id: row.id,
      item: row.scenario,
      status: row.status,
      reason: row.deviation ?? "cited evidence failed or is missing",
    })),
  {
    id: "V3",
    item: "selected cognitive actor rail (§15.3)",
    status: "deviation",
    reason:
      "fixture-hall has no cognitive actor before Wave 5; the capture is the selected actor Keeper, whose mode is reactive",
  },
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
/**
 * A review item is `reviewed` only when its record covers this candidate and checked the whole item;
 * a record for another candidate, or a partial one, is attached and the item stays `review`.
 */
const reviewed = (item, review) => {
  const record = reviewRecords.reviews.find((entry) => entry.item === item);
  if (record === undefined) return { item, status: "review", review };
  return record.candidate === candidate.commit && record.result === "checked"
    ? { item, status: "reviewed", review, reviewed: record }
    : { item, status: "review", review, lastReview: record };
};
/**
 * The thirteen literal §19 items, each with a disposition (development.md): `passed`/`failed` from
 * the suites that prove it, `pending` on an owner issue, `review` when a person must confirm it, or
 * `reviewed` once a reviewer's record in qualify-wave4-review.json covers this candidate.
 */
const section19 = [
  [
    "RW-0401 through RW-0410 are merged.",
    {
      review:
        "RW-0401 to RW-0409 merge through their issues; RW-0410 is this candidate, merged only after qualification",
    },
  ],
  ["WebSocket authorization and audience filtering occur server-side.", ["test:realtime"]],
  ["Snapshot/patch reducer convergence suite passes.", ["test:web", "test:projection"]],
  ["Hibernation, restart, deploy, reconnect, and snapshot fallback pass on Cloudflare.", null],
  ["React/renderer ownership boundary is enforced.", ["test:scene"]],
  [
    "Reference composition and art-direction tokens are implemented.",
    { review: "the §15.3 golden captures, compared with the reference image by the approver" },
  ],
  [
    "Scene is data-driven; reference image is not a runtime background.",
    {
      review:
        "no suite asserts the absence of the reference image; the approver confirms it on the captures",
    },
  ],
  [
    "Selection, event feed, entity rail, Inspect, Influence, and Why use real contracts.",
    ["test:e2e"],
  ],
  [
    "Entity mode disclosure distinguishes inspectable/reactive/cognitive/interpreted.",
    {
      review:
        "no cognitive or interpreted actor exists before Wave 5 (deviation V3); the e2e and text-path journeys disclose inspectable and reactive",
    },
  ],
  ["Text path covers every required interaction.", ["test:a11y"]],
  [
    "Asset provenance/review/license gates pass.",
    {
      review:
        "pnpm check runs the asset gates on this commit; Quality is their record, not this run",
    },
  ],
  [
    "Visual, accessibility, performance, privacy, and fanout qualifications pass.",
    ["test:visual", "test:a11y", "test:e2e", "test:realtime:load"],
  ],
  [
    "Main remains deployable and local setup remains reproducible.",
    { pending: { ownerIssue: 2, reason: "the deploy of main" } },
  ],
].map(([item, by]) =>
  by === null
    ? { item, status: "pending", pending: HOSTED }
    : Array.isArray(by)
      ? { item, status: by.every(passed) ? "passed" : "failed", evidence: by }
      : by.pending
        ? { item, status: "pending", pending: by.pending }
        : reviewed(item, by.review),
);
for (const { item } of reviewRecords.reviews)
  assert(
    section19.some((entry) => entry.item === item && entry.review !== undefined),
    `review record for an item qualify:wave4 does not mark review: ${item}`,
  );

const blockers = [
  ...suites.filter(({ status }) => status !== "passed").map(({ name }) => `suite ${name} failed`),
  ...goldenCaptures
    .filter(({ approval }) => approval !== "approved")
    .map(({ file, state, approval }) => `${file ?? state}: ${approval}`),
  ...deviations.map(({ id, reason }) => `${id}: ${reason}`),
  ...cloudflareQualification.map(({ item }) => `${item}: pending on issue 3`),
  ...section19
    .filter(({ status }) => status !== "passed" && status !== "reviewed")
    .map(({ item, status }) => `§19 ${item} ${status}`),
  ...(accessibility?.runs?.every((run) => run.violations.length === 0)
    ? []
    : ["accessibility report missing or has violations"]),
];
const manifest = {
  kind: "clockgrove.wave4-qualification",
  plan: `${PLAN}#19-exit-evidence-checklist`,
  generatedAt: new Date().toISOString(),
  execution: {
    provider: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
  },
  candidate,
  versions,
  browserMatrix,
  suites,
  goldenCaptures,
  rendererBackends: captured?.rendererBackends ?? [],
  rendererTierComparisons: captured?.tierComparisons ?? [],
  convergenceAndFaults: {
    scenarios,
    failureMatrix,
    notApplicable: [...scenarios, ...failureMatrix]
      .filter(({ status }) => status === "not_applicable")
      .map(({ id, scenario, reason }) => ({ id, item: scenario, reason })),
  },
  accessibility: {
    report: accessibility === null ? null : "evidence/accessibility-report.json",
    axeVersion: accessibility?.axeVersion ?? null,
    runs: accessibility?.runs?.length ?? 0,
    violations: accessibility?.runs?.flatMap((run) => run.violations) ?? null,
    status: passed("test:a11y") && accessibility !== null ? "passed" : "failed",
  },
  performance,
  measurements,
  cloudflareQualification,
  exitChecklist: section19,
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
for (const entry of section19)
  process.stdout.write(`${entry.status.padEnd(8)} §19 ${entry.item}\n`);
process.stdout.write(
  `golden captures: ${goldenCaptures.filter(({ approval }) => approval === "approved").length}/${goldenCaptures.length} approved\n` +
    `deviations: ${deviations.length}; Cloudflare items pending on issue 3: ${cloudflareQualification.length}\n` +
    `exit decision: ${manifest.exitDecision.status}\n` +
    `Wave 4 manifest: ${path.join(out, MANIFEST_FILE)} ${digest(await readFile(path.join(out, MANIFEST_FILE)))}\n`,
);
