import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runnerUrl = new URL("../../../scripts/decision-shadow-runner.mjs", import.meta.url).href;

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
        "--margin",
        "1000000000000",
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
