import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UTILITY_FEATURE_SCALES } from "@clockgrove/kernel";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runnerUrl = new URL("../../../scripts/decision-shadow-runner.mjs", import.meta.url).href;
const applicationUrl = new URL("../../application/src/index.ts", import.meta.url).href;
const gatewayUrl = new URL("../../model-gateway/src/index.ts", import.meta.url).href;
const fixturePack = path.join(root, "worlds/fixture/reference");
const TEN_DAYS = "864000000";

interface Margin {
  readonly gap: string;
  readonly withinDeclaredMargin: boolean | null;
}
interface ShadowRecord {
  readonly utilityMargin: Margin;
  readonly trigger: { readonly margin: string | null };
  readonly shadow: { readonly status: string; readonly detail: string | null };
}

/** A provider that always answers the first offered option, at a reported cost. */
function answeringAdapter(calls: { state: string; question: unknown }[] = []) {
  return {
    decide: async (call: { state: string; question: { options: Record<string, string> } }) => {
      calls.push(call);
      return {
        answer: { type: "choice", label: Object.keys(call.question.options)[0], confidence: 0.9 },
        inputTokens: 10,
        outputTokens: 1,
        reportedCostUsd: 0.00001,
        responseModel: "test-model",
      };
    },
  };
}

const alias = { alias: "test.shadow", model: "test-model" };

it("runs the supported CLI on a selected external pack with models off and preserves replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shadow-command-"));
  try {
    const alias = path.join(directory, "alias.json");
    const output = path.join(directory, "report.json");
    const pack = path.join(directory, "world-pack");
    await cp(path.join(root, "worlds/fixture/reference"), pack, { recursive: true });
    await writeFile(alias, JSON.stringify({ alias: "test.shadow", model: "test-model" }));
    execFileSync(
      process.execPath,
      [
        path.join(root, "scripts/decision-shadow.mjs"),
        "--pack",
        pack,
        "--alias",
        alias,
        "--out",
        output,
        "--span-ms",
        "86400000",
        "--spend-microusd",
        "0",
        "--models-off",
      ],
      { cwd: directory, timeout: 60_000, stdio: "pipe" },
    );
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.budget).toEqual({
      capMicrousd: 0,
      perCallCeilingMicrousd: 1000,
      reservedMicrousd: 0,
      calls: 0,
    });
    expect(report.replay.matches).toBe(true);
    expect(report.records).toEqual([]);
    // No margin given: the documented default samples every decision; cohorts use the pack's margin.
    expect(report.sampling).toEqual({ rule: "every-decision", margin: "76250000" });
    expect(report.cohortMargin).toEqual({ margin: "0", source: "pack" });
    expect(report.utilityAgreement.skipped).toEqual({
      decisions: 1,
      reasons: {
        "not-utility-tier": 0,
        "single-candidate": 1,
        "no-ambiguity-condition": 0,
        "out-of-point-scope": 0,
        "trigger-not-met": 0,
      },
    });
    expect(report.reference).toMatchObject({ total: 3, correct: 0, accuracy: null });
    expect(report.finalStateHash).toBe(
      "66fe54f533fbcae9ac8a2b17de71ff310503c5512489f3a41e65b3a43f158455",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("scores labelled fixture state variations through a scripted provider independently and reserves unknown-cost calls across the whole run", async () => {
  const { runShadowDay } = await import(runnerUrl);
  const calls: unknown[] = [];
  const adapter = {
    decide: async (call: { question: { options: Record<string, string> } }) => {
      const index = calls.length;
      calls.push(call);
      const keys = Object.keys(call.question.options);
      const label = index === 0 ? keys.find((key) => key.startsWith("seek-shelter:")) : "stay:";
      return {
        answer: { type: "choice", label, confidence: 0.9 },
        inputTokens: null,
        outputTokens: null,
        reportedCostUsd: null,
        responseModel: "test-model",
      };
    },
  };
  const report = await runShadowDay(
    {
      pack: path.join(root, "worlds/fixture/reference"),
      spanMs: "86400000",
      margin: "1000000000000",
      spendMicrousd: 5000,
      alias: { alias: "test.shadow", model: "test-model" },
    },
    adapter,
  );
  expect(report.reference).toMatchObject({ total: 3, correct: 3, accuracy: 1 });
  expect(
    report.reference.cases.map((entry: { id: string; record: { trigger: { margin: string } } }) => [
      entry.id,
      entry.record.trigger.margin,
    ]),
  ).toEqual([
    ["heavy-rain", "1"],
    ["dry-weather", "1"],
    ["weak-distant-shelter", "0"],
  ]);
  expect(
    report.reference.cases.map((entry: { declaredMargin: string }) => entry.declaredMargin),
  ).toEqual(["2", "2", "2"]);
  expect(
    report.reference.cases.map((entry: { expectedPick: string }) => entry.expectedPick),
  ).toEqual(["seek-shelter:fixture.cedar-hollow", "stay:", "stay:"]);
  expect(report.budget).toEqual({
    capMicrousd: 5000,
    perCallCeilingMicrousd: 1000,
    reservedMicrousd: 5000,
    calls: 5,
  });
  expect(calls).toHaveLength(5);
  // The run's cap stopped the other sampled decisions: over budget, never gateway failures.
  expect(report.utilityAgreement.points[0]).toMatchObject({ failed: 0, overBudget: 3 });
  expect(
    report.records.map((record: ShadowRecord) => [record.shadow.status, record.shadow.detail]),
  ).toEqual([
    ["picked", null],
    ["picked", null],
    ["over-budget", "shared-budget"],
    ["over-budget", "shared-budget"],
    ["over-budget", "shared-budget"],
  ]);
  // Latency is reported apart for world and reference calls, with p50 and p95.
  expect(report.latency.world).toMatchObject({ calls: 2 });
  expect(report.latency.reference).toMatchObject({ calls: 3 });
  for (const summary of [report.latency.world, report.latency.reference])
    for (const field of ["meanMs", "p50Ms", "p95Ms"]) expect(typeof summary[field]).toBe("number");
  expect(typeof report.utilityAgreement.points[0].p50LatencyMs).toBe("number");
  // Every shown feature carries its scale: the weak shelter reads as 0.01% protection, and each
  // feature named in a request has a legend line with its unit and range.
  const weak = (calls[2] as { state: string }).state;
  expect(weak).toContain("protection 1/10000 (0.01%)");
  for (const call of calls as { state: string; question: { options: Record<string, string> } }[]) {
    const [shown = "", legend = ""] = call.state.split("\nFeature scales:\n");
    // Each shown value is a share of 10000, a yes/no flag, a duration or a stated range.
    const values = [
      ...[shown, ...Object.values(call.question.options)]
        .join("\n")
        .matchAll(/(?<=^|: |, )([A-Za-z]+) (\S+(?: \S+)?)/gm),
    ].filter(([, name]) => name !== undefined && name in UTILITY_FEATURE_SCALES);
    expect(values.length).toBeGreaterThan(0);
    for (const [, name, value] of values) {
      expect(value).toMatch(/^(\d+\/10000 \([\d.]+%\)|yes|no|\d+ ms|\d+ \(range)/);
      expect(legend).toMatch(
        new RegExp(
          `^- ${name}: (basis points from \\d+ to \\d+|yes or no|milliseconds, 0 or more); `,
          "m",
        ),
      );
    }
  }
  expect(report.reference.cases[2].record.utilityChoice).toBe("seek-shelter:fixture.cedar-hollow");
  expect(JSON.stringify(calls)).not.toContain("score");
  expect(JSON.stringify(calls)).not.toContain(report.reference.cases[0].reason);
  expect(report.unknownCosts).toBe(5);
  expect(report.measuredCostMicrousd).toBe(0);
  expect(report.replay.matches).toBe(true);
  expect(report.finalStateHash).toBe(
    "66fe54f533fbcae9ac8a2b17de71ff310503c5512489f3a41e65b3a43f158455",
  );
});

it("classifies within and outside the pack's declared margin apart from sampling, on a real run", async () => {
  const { runShadowDay } = await import(runnerUrl);
  const run = async (extra: Record<string, string>) =>
    runShadowDay(
      { pack: fixturePack, spanMs: TEN_DAYS, spendMicrousd: 100000, alias, ...extra },
      answeringAdapter(),
    );
  const cohorts = (report: { records: ShadowRecord[] }) => ({
    within: report.records.filter((record) => record.utilityMargin.withinDeclaredMargin === true)
      .length,
    outside: report.records.filter((record) => record.utilityMargin.withinDeclaredMargin === false)
      .length,
  });
  // The documented wide operator margin samples every decision; the pack's own margin (0) still
  // classifies, so the easy decisions are reported outside it, not as close calls.
  const wide = await run({ margin: "1000000000000" });
  expect(wide.sampling).toEqual({ rule: "operator-margin", margin: "1000000000000" });
  expect(wide.cohortMargin).toEqual({ margin: "0", source: "pack" });
  expect(cohorts(wide)).toEqual({ within: 1, outside: 31 });
  expect(wide.utilityAgreement.points[0].outsideMargin.decisions).toBe(31);
  expect(
    wide.records
      .filter((record: ShadowRecord) => record.utilityMargin.withinDeclaredMargin === false)
      .every((record: ShadowRecord) => BigInt(record.utilityMargin.gap) > 0n),
  ).toBe(true);
  // Every committed decision is either sampled or counted as skipped with its reason.
  expect(wide.records.length + wide.utilityAgreement.skipped.decisions).toBe(33);
  expect(wide.utilityAgreement.skipped.reasons["single-candidate"]).toBe(1);
  // Without a margin the default samples the same decisions.
  expect(cohorts(await run({}))).toEqual({ within: 1, outside: 31 });
  // A stated cohort margin replaces the pack's for classification only.
  const stated = await run({ cohortMargin: "5000000" });
  expect(stated.cohortMargin).toEqual({ margin: "5000000", source: "operator" });
  expect(cohorts(stated)).toEqual({ within: 4, outside: 28 });
  // At the pack's own margin the two unperceived-target decisions are sampled too; the rest are
  // counted as skipped, none silently dropped.
  const declared = await run({ margin: "0" });
  expect(declared.records).toHaveLength(3);
  expect(
    declared.records.filter((record: ShadowRecord) => record.trigger.margin === null),
  ).toHaveLength(2);
  expect(declared.utilityAgreement.skipped.reasons).toMatchObject({
    "single-candidate": 1,
    "no-ambiguity-condition": 29,
    "trigger-not-met": 0,
  });
});

it("charges an unknown cost against the point's spend budget and reports a shared-budget refusal as over budget", async () => {
  const { simulate } = await import(runnerUrl);
  const { runDecisionShadow, decisionShadowReport } = await import(applicationUrl);
  const { gatewayShadowDecider } = await import(
    new URL("../../../apps/runtime/src/decision-shadow.ts", import.meta.url).href
  );
  const { createModelGateway, decisionAlias, InMemoryModelBudget, ScriptedDecider } = await import(
    gatewayUrl
  );
  const simulation = await simulate(fixturePack, 86400000n);
  const definition = decisionAlias(alias);
  const declarations = (maxMicrousd: number) => ({
    ambiguity: { schemaVersion: 1, conditions: [{ kind: "score-margin", maxMargin: 10n ** 12n }] },
    decisionPoints: {
      schemaVersion: 1,
      points: [
        {
          id: "test.point",
          trigger: { kind: "declared-ambiguity" },
          candidates: "kernel-valid",
          signatureScope: "actor",
          marginBuckets: { noneMax: 0n, smallMax: 1n },
          features: ["hunger", "travelMs"],
          modelAlias: definition.alias,
          confidenceThreshold: 0,
          budget: { maxCalls: 100, maxMicrousd },
          fallback: "utility-top-pick",
        },
      ],
    },
  });
  const answers = (costUsd?: number) =>
    Array.from({ length: 8 }, () => ({
      kind: "answer",
      answer: { type: "choice", label: "cant_tell", confidence: 0.9 },
      ...(costUsd === undefined ? {} : { costUsd }),
    }));
  const decider = (steps: unknown[], budgetMicrousd: number) =>
    gatewayShadowDecider(
      createModelGateway({
        aliases: [],
        adapters: {},
        decisionAliases: [definition],
        decisionAdapters: {
          "vercel-ai-gateway": new ScriptedDecider({ [definition.route.id]: steps }),
        },
        budget: new InMemoryModelBudget(() => budgetMicrousd),
        accounting: { record: () => undefined },
      }),
      { tenantId: "t", worldId: "w", actorId: "shadow" },
    );
  const statuses = (records: ShadowRecord[]) =>
    records.map((record) => [record.shadow.status, record.shadow.detail]);
  // Unknown cost (no reported cost, no price): charged at the 1000 reservation, so a point with a
  // 2500 spend budget stops after three calls instead of calling for every decision.
  const unknown = await runDecisionShadow({
    subjects: simulation.subjects,
    declarations: declarations(2500),
    decider: decider(answers(), 1_000_000),
  });
  expect(statuses(unknown)).toEqual([
    ["cant-tell", null],
    ["cant-tell", null],
    ["cant-tell", null],
    ["over-budget", "spend"],
    ["over-budget", "spend"],
  ]);
  // A decider that reports neither cost nor reservation exhausts the point's spend at once.
  const bare = await runDecisionShadow({
    subjects: simulation.subjects,
    declarations: declarations(2500),
    decider: {
      pick: async () => ({
        status: "completed",
        label: "cant_tell",
        confidence: 0.9,
        model: "test-model",
        latencyMs: 1,
        costMicrousd: null,
      }),
    },
  });
  expect(statuses(bare).map(([status]) => status)).toEqual([
    "cant-tell",
    "over-budget",
    "over-budget",
    "over-budget",
    "over-budget",
  ]);
  // The gateway's own budget (1000) refuses the second reservation: over budget, not failed.
  const shared = await runDecisionShadow({
    subjects: simulation.subjects,
    declarations: declarations(1_000_000),
    decider: decider(answers(0.000028), 1000),
  });
  expect(statuses(shared)).toEqual([
    ["cant-tell", null],
    ["over-budget", "shared-budget"],
    ["over-budget", "shared-budget"],
    ["over-budget", "shared-budget"],
    ["over-budget", "shared-budget"],
  ]);
  expect(decisionShadowReport(shared).points[0]).toMatchObject({ failed: 0, overBudget: 4 });
});

it("states a scale for every feature the native scorer records", async () => {
  const { simulate } = await import(runnerUrl);
  const simulation = await simulate(fixturePack, BigInt(TEN_DAYS));
  const names = new Set<string>(
    simulation.subjects.flatMap(
      (subject: { trace: { candidates: { features: Record<string, bigint> }[] } }) =>
        subject.trace.candidates.flatMap((candidate) => Object.keys(candidate.features)),
    ),
  );
  expect([...names].sort()).toEqual(Object.keys(UTILITY_FEATURE_SCALES).sort());
});
