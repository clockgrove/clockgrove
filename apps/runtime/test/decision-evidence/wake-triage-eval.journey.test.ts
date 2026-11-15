import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
        failed: 1,
        "low-confidence": 1,
        picked: 37,
      });
      // 37 picked answers, two of them the blind-spot error.
      expect(model.answered).toBe(37);
      expect(model.correct).toBe(35);
      expect(model.accuracy).toBe(35 / 37);
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
      expect(model.confusion.suppress).toEqual({ "cant-tell": 1, suppress: 7 });
      expect(model.knownCostMicrousd).toBe(3800);
      // The 503 and the answer without a cost are both unknown.
      expect(model.unknownCostCalls).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
