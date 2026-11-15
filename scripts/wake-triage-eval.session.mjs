import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { gatewayShadowDecider } from "../apps/runtime/src/decision-shadow.ts";
import {
  judgeWake,
  WAKE_TRIAGE_CASES,
  wakeTriageEvaluation,
} from "../packages/application/src/index.ts";
import {
  AiSdkDecisionAdapter,
  createModelGateway,
  decisionAlias,
  InMemoryModelBudget,
  ScriptedDecider,
} from "../packages/model-gateway/src/index.ts";

// Decision: eight calls in flight keeps a three-model run inside the runner's thirty minutes.
const CONCURRENCY = 8;
const live = process.env.CLOCKGROVE_WAKE_TRIAGE_EVAL_LIVE === "1";
const attribution = { tenantId: "eval", worldId: "wake-triage-eval", actorId: "eval" };
// Scripted answers repeat each case's label, unless WAKE_TRIAGE_EVAL_SCRIPT names another step.
const overrides = JSON.parse(process.env.WAKE_TRIAGE_EVAL_SCRIPT ?? "{}");
const scripted = (item) =>
  overrides[item.id] ?? {
    kind: "answer",
    answer: { type: "choice", label: item.expected, confidence: 0.9 },
    costUsd: 0.0001,
  };

async function pool(items, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

it("measures the labelled wakes on the configured decision models", async () => {
  const policies = JSON.parse(process.env.WAKE_TRIAGE_MODELS);
  const key = process.env.AI_GATEWAY_API_KEY;
  // Decision: a $1 run cap is ample for three models at the $0.001 per-call ceiling: 40 cases times
  // three models is 120 calls and at most $0.12.
  const capMicrousd = Math.round(Number(process.env.WAKE_TRIAGE_EVAL_MAX_USD ?? "1") * 1e6);
  const budget = new InMemoryModelBudget(() => capMicrousd);
  const models = [];
  for (const configured of policies) {
    const policy = {
      policyVersion: configured.policyVersion ?? "wake-triage@1",
      modelAlias: configured.modelAlias,
      model: configured.model,
      confidenceThreshold: configured.confidenceThreshold ?? 6500,
      dailyBudgetMicrousd: 0,
      maxCostMicrousd: configured.maxCostMicrousd ?? 1000,
    };
    const alias = decisionAlias({
      alias: policy.modelAlias,
      model: policy.model,
      maxCostMicrousd: policy.maxCostMicrousd,
    });
    const deciderFor = (step) =>
      gatewayShadowDecider(
        createModelGateway({
          aliases: [],
          adapters: {},
          decisionAliases: [alias],
          decisionAdapters: {
            "vercel-ai-gateway": live
              ? new AiSdkDecisionAdapter(() => key)
              : new ScriptedDecider({ [alias.route.id]: [step] }),
          },
          budget,
          accounting: { record: () => undefined },
        }),
        attribution,
      );
    const records = await pool(WAKE_TRIAGE_CASES, async (item) => {
      const record = await judgeWake({
        subject: {
          requestId: item.id,
          objectId: "eval",
          sessionId: "wake-triage-eval",
          messageId: item.id,
          simulationTime: "0",
          ...item.subject,
        },
        policy,
        decider: deciderFor(scripted(item)),
        reserved: true,
      });
      return { caseId: item.id, ...record };
    });
    models.push({
      modelAlias: policy.modelAlias,
      model: policy.model,
      policyVersion: policy.policyVersion,
      ...wakeTriageEvaluation(WAKE_TRIAGE_CASES, records),
    });
  }
  const output = process.env.CLOCKGROVE_WAKE_TRIAGE_EVAL_OUTPUT;
  expect(output).toBeTruthy();
  const measurement = live ? (key ? "live" : "model-unavailable") : "scripted";
  await writeFile(
    output,
    `${JSON.stringify(
      {
        measurement,
        cases: WAKE_TRIAGE_CASES.length,
        spentMicrousd: budget.spentMicrousd("eval/wake-triage-eval"),
        models,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`Wake triage ${measurement} evaluation written to ${output}\n`);
});
