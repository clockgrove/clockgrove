import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CommandTable, optionValue } from "../../cli/args.js";
import { runCli } from "../../cli/main.js";
import {
  ResourceLedger,
  WORKERS_PEAK_MEMORY_REASON,
  WorkersUnavailable,
} from "../../cli/runtime.js";
import { type RuntimeName, runNamedScenario } from "../../cli/scenario.js";
import {
  FIXTURE_SCENARIO,
  type FixturePackOptions,
  writeFixturePack,
} from "../conformance/fixture-pack.js";
import { SMALL_PACKS } from "../conformance/pack-source.js";
import {
  committedScenarios,
  expectCommittedScenariosMatch,
  treeDigest,
} from "./committed-scenarios.js";
import { invoke, readEnvelope, stableBytes, temporaryDirectory } from "./helpers.js";

type Rec = Record<string, any>;

let scratch: Awaited<ReturnType<typeof temporaryDirectory>>;
beforeAll(async () => {
  scratch = await temporaryDirectory();
});
afterAll(() => scratch.dispose());

describe("simulate scenario through the executable", () => {
  it("runs every committed scenario of the small packs in Node, matching its golden, without touching worlds/", async () => {
    // The remaining packs run through this CLI path in scenario.long-run.test.ts.
    const scenarios = (await committedScenarios()).filter(({ pack }) => SMALL_PACKS.includes(pack));
    expect(scenarios.length).toBeGreaterThan(0);
    await expectCommittedScenariosMatch(scenarios);
  });

  it("reports the same whole result in workerd as in Node, and only the observations differ", async () => {
    const node = await invoke(["simulate", "scenario", "neutral-conformance", "--runtime", "node"]);
    const workers = await invoke([
      "simulate",
      "scenario",
      "neutral-conformance",
      "--runtime",
      "workers",
    ]);
    expect(workers.run.exitCode).toBe(0);
    expect(workers.envelope.observations).toMatchObject({
      runtime: "Cloudflare-Workers (workerd)",
      peakMemoryBytes: null,
      peakMemoryNullReason: WORKERS_PEAK_MEMORY_REASON,
    });
    expect(Buffer.from(stableBytes(workers.envelope))).toEqual(
      Buffer.from(stableBytes(node.envelope)),
    );
  });

  it("refuses an unknown scenario (exit 1), and a bad runtime or a missing name (exit 2)", async () => {
    for (const [args, exitCode, refusal] of [
      [["no-such-scenario", "--runtime", "node"], 1, { code: "UNKNOWN_SCENARIO", path: "<name>" }],
      [["cedar-growth", "--runtime", "deno"], 2, { code: "MALFORMED_VALUE", path: "--runtime" }],
      [["--runtime", "node"], 2, { code: "MISSING_ARGUMENT", path: "<name>" }],
    ] as const) {
      const { run, envelope } = await invoke(["simulate", "scenario", ...args]);
      expect(run.exitCode).toBe(exitCode);
      expect(envelope.result).toBeNull();
      expect(envelope.refusal).toMatchObject(refusal);
    }
  });
});

/** The scenario command over a temporary pack root, rendered as the executable renders it. */
async function render(packRoot: string, name: string, runtime: RuntimeName = "node") {
  const commands: CommandTable = new Map([
    [
      "simulate scenario",
      {
        positionals: ["<name>"],
        options: ["--runtime"],
        run: (options) =>
          runNamedScenario({ packRoot, name: optionValue(options, "<name>"), runtime }),
      },
    ],
  ]);
  const stdout: Uint8Array[] = [];
  const exitCode = await runCli(["simulate", "scenario", name, "--runtime", runtime], commands, {
    stdout: (bytes) => stdout.push(bytes),
    stderr: () => undefined,
  });
  return { exitCode, envelope: readEnvelope(Buffer.concat(stdout)) };
}

async function packRoot(name: string, packs: Record<string, FixturePackOptions>): Promise<string> {
  const root = join(scratch.path, name);
  for (const [pack, options] of Object.entries(packs)) await writeFixturePack(root, pack, options);
  return root;
}

describe("the shared scenario path over a temporary pack root", () => {
  it("refuses a name in two packs with AMBIGUOUS_SCENARIO", async () => {
    const root = await packRoot("ambiguous", { alpha: {}, beta: {} });
    const { exitCode, envelope } = await render(root, FIXTURE_SCENARIO);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    expect(envelope.refusal).toMatchObject({ code: "AMBIGUOUS_SCENARIO", path: "<name>" });
    expect(envelope.result).toBeNull();
  });

  it("reports a bundle that differs from its golden with the differing fields, writing nothing", async () => {
    const root = await packRoot("mismatch", { alpha: { golden: "mismatch" } });
    const before = await treeDigest(root);
    const { exitCode, envelope } = await render(root, FIXTURE_SCENARIO);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    const golden = (envelope.result as Rec).golden as Rec;
    expect(golden.status).toBe("mismatch");
    expect(golden.difference.fields).toEqual(["assertions", "bundleHash", "runs", "scenario"]);
    expect(await treeDigest(root)).toEqual(before);
  });

  it("reports a scenario without a golden as missing", async () => {
    const root = await packRoot("missing", { alpha: { golden: "missing" } });
    const { exitCode, envelope } = await render(root, FIXTURE_SCENARIO);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    expect((envelope.result as Rec).golden).toEqual({ status: "missing", difference: null });
    expect(existsSync(join(root, "alpha", "goldens", `${FIXTURE_SCENARIO}.json`))).toBe(false);
  });

  it("reports a failing assertion as failed while the golden matches", async () => {
    const root = await packRoot("failing", { alpha: { failingAssertion: true } });
    const { exitCode, envelope } = await render(root, FIXTURE_SCENARIO);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe("failed");
    const result = envelope.result as Rec;
    expect(result.golden.status).toBe("match");
    expect((result.assertions as Rec[]).map((item) => [item.id, item.passed])).toEqual([
      ["count-holds", true],
      ["count-cannot-hold", false],
    ]);
  });
});

describe("workers runs dispose what they start", () => {
  it("disposes the worker and its directories after a run that fails its golden", async () => {
    const root = await packRoot("workers-failure", { alpha: { golden: "mismatch" } });
    const ledger = new ResourceLedger();
    const outcome = await runNamedScenario({
      packRoot: root,
      name: FIXTURE_SCENARIO,
      runtime: "workers",
      ledger,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.observed?.runtime).toBe("Cloudflare-Workers (workerd)");
    expect(ledger.workers.length).toBe(1);
    expect(ledger.workers.every((worker) => worker.disposed)).toBe(true);
    expect(ledger.tempDirs.length).toBe(1);
    for (const directory of ledger.tempDirs) expect(existsSync(directory)).toBe(false);
  });

  it("exits 1 with WORKERS_UNAVAILABLE when workerd cannot start, disposing the directories", async () => {
    const root = await packRoot("workers-unavailable", { alpha: {} });
    const ledger = new ResourceLedger();
    const outcome = await runNamedScenario({
      packRoot: root,
      name: FIXTURE_SCENARIO,
      runtime: "workers",
      ledger,
      startWorkers: async (owner) => {
        await owner.makeTempDir("clockgrove-test-workers-");
        throw new WorkersUnavailable("workerd cannot start");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.refusal).toEqual({
      code: "WORKERS_UNAVAILABLE",
      path: "--runtime",
      message: "workerd cannot start",
    });
    expect(ledger.tempDirs.length).toBe(1);
    for (const directory of ledger.tempDirs) expect(existsSync(directory)).toBe(false);
  });
});
