import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAKE_TRIAGE_CASES, wakeTriageEvaluation } from "@clockgrove/application";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const answer = (label: string, costUsd?: number, confidence = 0.9) => ({
  kind: "answer",
  answer: { type: "choice", label, confidence },
  ...(costUsd === undefined ? {} : { costUsd }),
});

it("reports accuracy and the routine blind-spot rate for labelled wakes from the evaluation command", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wake-triage-eval-"));
  try {
    const output = path.join(directory, "report.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/wake-triage-eval.mjs", "--output", output],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          // Deliberate errors on top of the scripted label answers, each with a literal effect.
          WAKE_TRIAGE_EVAL_SCRIPT: JSON.stringify({
            "routine_condition_fails-01": answer("compiled_routine", 0.0001),
            "routine_condition_fails-02": answer("compiled_routine", 0.0001),
            // Below the 0.65 threshold: shows by status, never as an answer or the blind spot.
            "routine_condition_fails-03": answer("compiled_routine", 0.0001, 0.3),
            "nothing_material-01": answer("cant_tell", 0.0001),
            // A label outside the options fails the call; the report must not grow from it.
            "nothing_material-02": answer("__proto__", 0.0001),
            "no_routine-01": { kind: "http", status: 503 },
            "routine_holds-01": answer("compiled_routine"),
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report).toMatchObject({ measurement: "scripted", cases: 40 });
    expect(report.models.map((model: { model: string }) => model.model)).toEqual([
      "scripted-wake-a",
      "scripted-wake-b",
    ]);
    for (const model of report.models) {
      expect(model.statuses).toEqual({
        "cant-tell": 1,
        failed: 2,
        "low-confidence": 1,
        picked: 36,
      });
      // 36 picked answers, two of them the blind-spot error.
      expect(model.answered).toBe(36);
      expect(model.correct).toBe(34);
      expect(model.accuracy).toBe(34 / 36);
      expect(model.cohorts.routine_condition_fails).toEqual({
        cases: 8,
        answered: 7,
        correct: 5,
        accuracy: 5 / 7,
        compiledRoutine: 2,
      });
      expect(model.blindSpot).toEqual({ cases: 8, compiledRoutine: 2, rate: 0.25 });
      expect(model.confusion.full_turn).toMatchObject({
        compiled_routine: 2,
        failed: 1,
        "low-confidence": 1,
      });
      expect(model.confusion.suppress).toEqual({ "cant-tell": 1, failed: 1, suppress: 6 });
      expect(model.knownCostMicrousd).toBe(3800);
      // The 503 and the answer without a cost are both unknown.
      expect(model.unknownCostCalls).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

it("keeps __proto__ from a model answer or a case label as an ordinary key of the report", () => {
  const [wake] = WAKE_TRIAGE_CASES.filter((item) => item.id === "nothing_material-01");
  if (wake === undefined) throw new Error("missing case");
  // Forged inputs: judgeWake never returns these labels, but the scorer must not trust that.
  const cases = [wake, { ...wake, id: "forged", expected: "__proto__" }];
  const record = { costMicrousd: null, latencyMs: null };
  const report = wakeTriageEvaluation(
    cases as unknown as typeof WAKE_TRIAGE_CASES,
    [
      { ...record, caseId: wake.id, status: "picked", choice: "__proto__" },
      { ...record, caseId: wake.id, status: "__proto__", choice: null },
      { ...record, caseId: "forged", status: "failed", choice: null },
    ] as unknown as Parameters<typeof wakeTriageEvaluation>[1],
  );
  expect("failed" in {}).toBe(false);
  expect(Object.entries(report.statuses)).toEqual([
    ["picked", 1],
    ["__proto__", 1],
    ["failed", 1],
  ]);
  expect(Object.entries(report.labels)).toEqual([["__proto__", 1]]);
  expect(Object.entries(report.confusion)).toEqual([
    ["suppress", { ["__proto__"]: 2 }],
    ["__proto__", { failed: 1 }],
  ]);
  expect(report.answered).toBe(1);
  expect(report.correct).toBe(0);
});
