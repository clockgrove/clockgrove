// The Wave 3 evidence manifest claims no more than its evidence shows: receipts pass only the items
// they prove, native-owner runs are compared with the committed goldens, and the validator refuses a
// hosted item marked passed or relabelled, an exit decision that does not follow the checklist, a
// receipt whose candidate or log digest does not match, scenario parity its runs do not show and a
// fault matrix with a dropped or forged case.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { digest } from "../../scripts/ci/evidence.mjs";
import {
  buildWave3Manifest,
  LOAD_CURVES,
  RECEIPTS,
  validateWave3Manifest,
} from "../../scripts/ci/qualify-wave3-manifest.mjs";
import { decode } from "./decode-once.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let directory;

async function writeReceipt(
  name,
  command,
  log = `${name} ok\n`,
  commit = git("rev-parse", "HEAD"),
) {
  await writeFile(path.join(directory, `${name}.log`), log);
  await writeFile(
    path.join(directory, `${name}.result.json`),
    JSON.stringify({
      ...{ commit, tree: git("rev-parse", "HEAD^{tree}"), usage: null, command, exitCode: 0 },
      ...{ status: "passed", signal: null, errorCode: null, outputDigest: digest(log) },
    }),
  );
}

/** The test:long-run log lines native-parity.long-run.test.ts prints through Turbo, per golden and soak run. */
async function nativeLog(hash = (golden) => golden) {
  const lines = [];
  for (const pack of ["fixture", "raccoons"]) {
    for (const name of await readdir(path.join(root, "worlds", pack, "goldens")))
      for (const run of decode(await readFile(path.join(root, "worlds", pack, "goldens", name)))
        .runs)
        lines.push([`${pack}/${name.slice(0, -5)}:${run.name}`, hash(run.finalStateHash)]);
    lines.push([`${pack}/long-run-30-days:main`, digest(pack)]);
  }
  return lines
    .map(
      ([id, actual]) =>
        `@clockgrove/runtime:test:long-run: native-owner parity ${id}: match actual ${actual} expected ${actual} (4 commands, 0 continuation chunks, 0 retries, 1 restarts, 9 ms)\n`,
    )
    .join("");
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "clockgrove-wave3-manifest-test-"));
  for (const [name, command] of RECEIPTS) await writeReceipt(name, command);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const build = () =>
  buildWave3Manifest({
    root,
    qualificationDirectory: directory,
    loadCurveDirectory: directory,
    execution: { provider: "local", runId: null, runAttempt: null },
    schema: { hash: digest("schema"), method: "test", postgres: "18.6" },
    decode,
  });
const validate = (manifest) => validateWave3Manifest(manifest, root, decode);
const dispositions = (manifest) => manifest.exitChecklist.map((entry) => entry.disposition);
/** The validator refuses `manifest` after `change`, naming `message`. */
async function refuses(manifest, change, message) {
  const forged = structuredClone(manifest);
  change(forged);
  await expect(validate(forged)).rejects.toThrow(message);
}

it("passes local items from receipts, defers and reviews by the plan, and keeps hosted items pending", async () => {
  const manifest = await validate(await build());
  // Items 4, 6, 13, 16, 18 and 19 need real Cloudflare or a staging deploy; 1, 7 and
  // 17 need review; 14 and 15 left the wave. Item 16's local half also lacks native scenario parity.
  expect(dispositions(manifest)).toEqual([
    ...["review", "passed", "passed", "pending", "passed", "pending", "review", "passed", "passed"],
    ...["passed", "passed", "passed", "pending", "deferred", "deferred", "pending", "review"],
    ...["pending", "pending"],
  ]);
  expect(manifest.exitChecklist[18].pending.issues).toEqual([693]);
  expect(manifest.exitChecklist[3].pending).toEqual({
    missing:
      "real Cloudflare staging qualification: plan §18.2 and the hosted rows of the §17 matrix",
    issues: [881],
  });
  expect(manifest.exitDecision.status).toBe("not-qualified");
  expect(manifest.cloudQualification.map((entry) => entry.disposition)).toEqual(
    Array(8).fill("pending"),
  );
  expect(manifest.scenarios.status).toBe("incomplete");
  expect(manifest.loadCurves.status).toBe("missing");

  const forgeries = [
    [(m) => Object.assign(m.exitChecklist[17], { disposition: "passed" }), "without hosted"],
    [(m) => (m.exitDecision.status = "pending-review"), "exit decision"],
    [(m) => (m.tests[2].commit = "0".repeat(40)), "receipt candidate mismatch"],
    [(m) => (m.tests[2].tree = "0".repeat(40)), "receipt tree mismatch"],
    [(m) => (m.scenarios.status = "passed"), "native scenario parity status"],
    [(m) => (m.scenarios.goldens = []), "committed goldens"],
    [(m) => Object.assign(m.cloudQualification[0], { disposition: "deferred" }), "§18.2"],
    [(m) => (m.cloudQualification[1].pending.issues = []), "§18.2"],
    [(m) => (m.faults.cases = m.faults.cases.filter((e) => e.issue !== "#881")), "fault matrix"],
    [(m) => (m.faults.digest = digest("forged")), "fault matrix"],
  ];
  for (const [change, message] of forgeries) await refuses(manifest, change, message);
});

it("compares every native-owner run with its golden and records the load curves' unobserved budget as pending", async () => {
  await writeReceipt(
    "test-long-run",
    RECEIPTS.find(([name]) => name === "test-long-run")[1],
    await nativeLog(),
  );
  const curves = path.join(directory, "load-curves");
  await mkdir(curves, { recursive: true });
  await writeReceipt(LOAD_CURVES[0], [...LOAD_CURVES[1], curves]);
  const candidate = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  const budget = { name: "EXAMPLE_BUDGET.unobserved", default: 1, status: "not-observable" };
  await writeFile(
    path.join(curves, "wave3-load-curves.json"),
    JSON.stringify({
      kind: "clockgrove.wave3-load-curves",
      candidate,
      status: "passed",
      budgets: [budget],
    }),
  );
  const manifest = await validate(await build());
  expect(manifest.scenarios.status).toBe("passed");
  await refuses(manifest, (m) => (m.scenarios.runs[0].finalStateHash = digest("x")), "match");
  expect(manifest.loadCurves.budgets[0].disposition).toEqual({ status: "pending", issues: [] });
  expect(manifest.exitChecklist[17].hosted.local).toBe("passed");
  expect(manifest.exitChecklist[17].disposition).toBe("pending");

  await writeReceipt(
    "test-long-run",
    RECEIPTS.find(([name]) => name === "test-long-run")[1],
    await nativeLog(() => digest("other")),
  );
  await expect(build()).rejects.toThrow("golden mismatch under a passing test:long-run");
});

it("refuses a receipt whose log digest or candidate does not match", async () => {
  const [name, command] = RECEIPTS.find(([entry]) => entry === "test-runtime");
  await writeReceipt(name, command);
  await writeFile(path.join(directory, `${name}.log`), "edited\n");
  await expect(build()).rejects.toThrow("receipt log mismatch");
  await writeReceipt(name, command, "ok\n", "0".repeat(40));
  await expect(build()).rejects.toThrow("candidate mismatch");
});
