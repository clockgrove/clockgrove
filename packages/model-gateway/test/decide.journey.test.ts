import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  AiSdkDecisionAdapter,
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
  it("keeps unpriced token usage unknown through the HTTP adapter and distinguishes configured and reported costs", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            answers: {
              q: {
                type: "choice",
                choice: "stay",
                probabilities: { stay: 0.9, "seek-food:bin": 0.1 },
              },
            },
            usage: { inputTokens: 10, outputTokens: 2 },
            ...(calls === 4 ? { providerMetadata: { gateway: { cost: "0.000007" } } } : {}),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const records: DecisionCallRecord[] = [];
      const aliases = [
        decisionAlias({ alias: "unknown", model: "fixture", baseURL }),
        decisionAlias({
          alias: "priced",
          model: "fixture",
          baseURL,
          priceUsdPerMTok: { input: 2, output: 5 },
        }),
        decisionAlias({
          alias: "free",
          model: "fixture",
          baseURL,
          priceUsdPerMTok: { input: 0, output: 0 },
        }),
        decisionAlias({
          alias: "reported",
          model: "fixture",
          baseURL,
          priceUsdPerMTok: { input: 2, output: 5 },
        }),
      ];
      const budget = new InMemoryModelBudget(() => 5000);
      const models = createModelGateway({
        aliases: [],
        adapters: {},
        decisionAliases: aliases,
        decisionAdapters: {
          "vercel-ai-gateway": new AiSdkDecisionAdapter(() => "local test credential"),
        },
        budget,
        accounting: {
          record: () => undefined,
          recordDecision: (record) => void records.push(record),
        },
      });
      for (const definition of aliases) {
        expect(
          (
            await models.decide({
              alias: definition.alias,
              callId: definition.alias,
              attribution,
              state: "resting",
              question,
            })
          ).status,
        ).toBe("completed");
      }
      expect(records.map((record) => record.costMicrousd)).toEqual([null, 30, 0, 7]);
      expect(calls).toBe(4);
      expect(budget.spentMicrousd("t/w")).toBe(1037);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
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
