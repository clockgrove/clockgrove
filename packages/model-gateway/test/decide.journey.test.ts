import { describe, expect, it } from "vitest";
import {
  createModelGateway,
  type DecisionCallRecord,
  decisionAlias,
  InMemoryModelBudget,
  ScriptedDecider,
} from "../src/index.js";

const attribution = { tenantId: "t", worldId: "w", actorId: "resident" };
const alias = decisionAlias({ alias: "shadow.default", model: "perplexity/pplx-decider-v1.2" });
const question = { type: "choice", options: { stay: null, "seek-food:bin": "the bin" } } as const;

function gateway(decider: ScriptedDecider, records: DecisionCallRecord[]) {
  return createModelGateway({
    aliases: [],
    adapters: {},
    decisionAliases: [alias],
    decisionAdapters: { "vercel-ai-gateway": decider },
    budget: new InMemoryModelBudget(() => 2000),
    accounting: { record: () => undefined, recordDecision: (record) => void records.push(record) },
  });
}

describe("decide on the model gateway port", () => {
  it("records model, latency, cost, label and confidence, and refuses a failure explicitly", async () => {
    const records: DecisionCallRecord[] = [];
    const decider = new ScriptedDecider({
      [alias.route.id]: [
        {
          kind: "answer",
          answer: { type: "choice", label: "seek-food:bin", confidence: 0.62 },
          costUsd: 0.000028,
        },
        { kind: "http", status: 429 },
      ],
    });
    const models = gateway(decider, records);
    const request = { alias: alias.alias, callId: "c1", attribution, state: "hungry", question };
    const answered = await models.decide(request);
    expect(answered.status).toBe("completed");
    expect(records[0]).toMatchObject({
      model: "perplexity/pplx-decider-v1.2",
      outcome: "completed",
      label: "seek-food:bin",
      confidence: 0.62,
      costMicrousd: 28,
    });
    expect(typeof records[0]?.latencyMs).toBe("number");
    const limited = await models.decide({ ...request, callId: "c2" });
    expect(limited).toMatchObject({ status: "failed", code: "rate_limited", retryable: true });
    expect(records[1]).toMatchObject({ outcome: "rate_limited", label: null });
    const exhausted = await models.decide({ ...request, callId: "c3" });
    expect(exhausted).toMatchObject({ status: "failed", code: "unavailable" });
  });
});
