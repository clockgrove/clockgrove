import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const answer = (label: string, costUsd?: number) => ({
  kind: "answer",
  answer: { type: "choice", label, confidence: 0.9 },
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
      expect(model.statuses).toEqual({ "cant-tell": 1, failed: 1, picked: 38 });
      // 38 picked answers, two of them the blind-spot error.
      expect(model.answered).toBe(38);
      expect(model.correct).toBe(36);
      expect(model.accuracy).toBe(36 / 38);
      expect(model.cohorts.routine_condition_fails).toEqual({
        cases: 8,
        answered: 8,
        correct: 6,
        accuracy: 6 / 8,
        compiledRoutine: 2,
      });
      expect(model.blindSpot).toEqual({ cases: 8, compiledRoutine: 2, rate: 0.25 });
      expect(model.confusion.full_turn).toMatchObject({ compiled_routine: 2, failed: 1 });
      expect(model.confusion.suppress).toMatchObject({ cant_tell: 1, suppress: 7 });
      expect(model.knownCostMicrousd).toBe(3800);
      // The 503 and the answer without a cost are both unknown.
      expect(model.unknownCostCalls).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
