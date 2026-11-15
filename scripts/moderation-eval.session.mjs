import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { gatewayShadowDecider } from "../apps/runtime/src/decision-shadow.ts";
import {
  ACTOR_REPLY_CASES,
  ACTOR_REPLY_CATEGORY_CODES,
  categoryRates,
  judgeActorReply,
  judgeModeration,
  MODERATION_CATEGORY_CASES,
  MODERATION_CATEGORY_CODES,
  moderationCohortRates,
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
const live = process.env.CLOCKGROVE_MODERATION_EVAL_LIVE === "1";
const attribution = { tenantId: "eval", worldId: "moderation-eval", actorId: "eval" };
const yesNo = (codes, labelled) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      { type: "boolean", label: labelled.includes(code) ? "true" : "false", confidence: 0.9 },
    ]),
  );
// Scripted answers repeat each case's label, unless MODERATION_EVAL_SCRIPT names another step.
const overrides = JSON.parse(process.env.MODERATION_EVAL_SCRIPT ?? "{}");
const scripted = (id, label, codes, labelled) =>
  overrides[id] ?? {
    kind: "answer",
    answer: { type: "choice", label, confidence: 0.9 },
    answers: yesNo(codes, labelled),
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

it("measures the labelled category and actor-reply sets on the configured decision models", async () => {
  const policies = JSON.parse(process.env.MODERATION_SHADOW_MODELS);
  const key = process.env.AI_GATEWAY_API_KEY;
  // Decision: a $2 run cap covers three models at the $0.001 per-call ceiling: 253 messages plus
  // 52 replies is 305 calls per model, 915 calls and at most $0.915 for three.
  const capMicrousd = Math.round(Number(process.env.MODERATION_EVAL_MAX_USD ?? "2") * 1e6);
  const budget = new InMemoryModelBudget(() => capMicrousd);
  const models = [];
  for (const configured of policies) {
    const policy = {
      policyVersion: configured.policyVersion ?? "moderation-shadow@3",
      modelAlias: configured.modelAlias,
      model: configured.model,
      confidenceThreshold: configured.confidenceThreshold ?? 6500,
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
    const moderation = await pool(MODERATION_CATEGORY_CASES, async (item) => {
      const record = await judgeModeration({
        subject: {
          sessionId: "moderation-eval",
          messageId: item.id,
          actorId: "eval",
          simulationTime: "0",
          input: item.text,
        },
        policy,
        decider: deciderFor(
          scripted(
            item.id,
            `${item.disposition}_${item.injection ? "injection" : "clean"}`,
            MODERATION_CATEGORY_CODES,
            item.codes,
          ),
        ),
      });
      return { caseId: item.id, ...record };
    });
    const replies = await pool(ACTOR_REPLY_CASES, async (item) => {
      const record = await judgeActorReply({
        subject: {
          ...attribution,
          sessionId: "actor-reply-eval",
          messageId: item.id,
          reply: item.text,
        },
        policy: {
          ...policy,
          policyVersion: configured.replyPolicyVersion ?? "actor-reply-shadow@1",
        },
        decider: deciderFor(
          scripted(
            `reply:${item.id}`,
            item.codes.length > 0 ? "severe" : "clean",
            ACTOR_REPLY_CATEGORY_CODES,
            item.codes,
          ),
        ),
      });
      return { caseId: item.id, ...record };
    });
    const statuses = (rows) =>
      Object.fromEntries(
        [...new Set(rows.map((row) => row.status))]
          .sort()
          .map((status) => [status, rows.filter((row) => row.status === status).length]),
      );
    const injections = moderation.filter((row) => row.injection !== null);
    models.push({
      modelAlias: policy.modelAlias,
      model: policy.model,
      moderation: {
        policyVersion: policy.policyVersion,
        statuses: statuses(moderation),
        categories: categoryRates(MODERATION_CATEGORY_CODES, MODERATION_CATEGORY_CASES, moderation),
        cohorts: moderationCohortRates(moderation),
        injectionAccuracy:
          injections.length === 0
            ? null
            : injections.filter(
                (row) =>
                  row.injection ===
                  MODERATION_CATEGORY_CASES.find((item) => item.id === row.caseId).injection,
              ).length / injections.length,
      },
      actorReplies: {
        statuses: statuses(replies),
        categories: categoryRates(ACTOR_REPLY_CATEGORY_CODES, ACTOR_REPLY_CASES, replies),
      },
    });
  }
  const output = process.env.CLOCKGROVE_MODERATION_EVAL_OUTPUT;
  expect(output).toBeTruthy();
  const measurement = live ? (key ? "live" : "model-unavailable") : "scripted";
  await writeFile(
    output,
    `${JSON.stringify(
      {
        measurement,
        cases: {
          moderation: MODERATION_CATEGORY_CASES.length,
          actorReplies: ACTOR_REPLY_CASES.length,
        },
        spentMicrousd: budget.spentMicrousd("eval/moderation-eval"),
        models,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`Moderation ${measurement} evaluation written to ${output}\n`);
});
