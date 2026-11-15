import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const no = { type: "boolean", label: "false", confidence: 0.9 };
const yes = { type: "boolean", label: "true", confidence: 0.9 };
const answer = (label: string, answers: Record<string, object>, costUsd?: number) => ({
  kind: "answer",
  answer: { type: "choice", label, confidence: 0.9 },
  answers,
  ...(costUsd === undefined ? {} : { costUsd }),
});
const moderation = (extra: Record<string, object> = {}) => ({
  sexual_minors: no,
  harm_to_others: no,
  self_harm_intent: no,
  self_harm_encouragement: no,
  stated_minor: no,
  ...extra,
});
const reply = { sexual_minors: no, self_harm_encouragement: no, harmful_instructions: no };

it("reports per-code miss and false-trigger rates, cohort block rates and actor-reply cost per 1,000 replies from the evaluation command", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "moderation-eval-"));
  try {
    const output = path.join(directory, "report.json");
    const result = spawnSync(
      process.execPath,
      ["scripts/moderation-eval.mjs", "--output", output],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          // Deliberate errors on top of the scripted label answers, each with a literal effect.
          MODERATION_EVAL_SCRIPT: JSON.stringify({
            "hate-01": answer("flag_clean", moderation(), 0.0001),
            "harm_to_others-01": answer("block_clean", moderation(), 0.0001),
            "benign-01": answer("allow_clean", moderation({ harm_to_others: yes }), 0.0001),
            "self_harm_encouragement-01": { kind: "http", status: 503 },
            "reply:harmful_instructions-01": answer("clean", reply, 0.0004),
            "reply:clean-01": answer("clean", reply),
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report).toMatchObject({
      measurement: "scripted",
      cases: { moderation: 253, actorReplies: 52 },
    });
    expect(report.models.map((model: { model: string }) => model.model)).toEqual([
      "scripted-moderation-a",
      "scripted-moderation-b",
    ]);
    for (const model of report.models) {
      const { categories, cohorts, statuses } = model.moderation;
      expect(statuses).toEqual({ failed: 1, picked: 252 });
      expect(categories.perCode.harm_to_others).toEqual({
        positives: 30,
        negatives: 223,
        answeredPositives: 30,
        answeredNegatives: 222,
        misses: 1,
        falseTriggers: 1,
        missRate: 1 / 30,
        falseTriggerRate: 1 / 222,
      });
      expect(categories.perCode.self_harm_encouragement).toMatchObject({
        positives: 25,
        answeredPositives: 24,
        misses: 0,
        missRate: 0,
      });
      expect(cohorts.hate).toEqual({
        cases: 25,
        answered: 25,
        blocked: 24,
        expectedBlock: 25,
        blockRate: 24 / 25,
        notBlocked: 1,
        notBlockedRate: 1 / 25,
        correct: 24,
        accuracy: 24 / 25,
      });
      // The unanswered block-labelled message still counts as not blocked.
      expect(cohorts.self_harm_encouragement).toMatchObject({
        answered: 24,
        blockRate: 1,
        notBlocked: 1,
        notBlockedRate: 1 / 25,
      });
      const replies = model.actorReplies.categories;
      expect(replies.perCode.harmful_instructions).toMatchObject({
        positives: 12,
        misses: 1,
        falseTriggers: 0,
      });
      expect(replies.total).toMatchObject({
        observed: 52,
        failed: 0,
        knownCostMicrousd: 5400,
        unknownCostCalls: 1,
      });
      expect(replies.total.costPerThousandUsd).toBeCloseTo(5400 / 51 / 1000, 12);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
