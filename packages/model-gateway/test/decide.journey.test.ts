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
  it("prices or keeps unknown a call the provider answered before it failed, and records zero only for one that provably billed nothing", async () => {
    // One provider response per call, in order, through the real SDK adapter over HTTP.
    const replies: readonly (readonly [number, unknown])[] = [
      // A model refusal with a reported cost: priced, not free.
      [
        200,
        {
          answers: { q: { type: "refusal" } },
          usage: { inputTokens: 40, outputTokens: 1 },
          providerMetadata: { gateway: { cost: "0.000009" } },
        },
      ],
      // A model refusal with tokens but no reported cost or price: unknown.
      [200, { answers: { q: { type: "refusal" } }, usage: { inputTokens: 40, outputTokens: 1 } }],
      // An answer the SDK rejects after the provider replied (an option never offered): priced.
      [
        200,
        {
          answers: { q: { type: "choice", choice: "invented" } },
          usage: { inputTokens: 40, outputTokens: 1 },
          providerMetadata: { gateway: { cost: "0.000005" } },
        },
      ],
      // A rate limit refused before any model ran: nothing billed.
      [429, { error: { message: "rate limited" } }],
      // A server error may follow model work: unknown.
      [500, { error: { message: "upstream failed" } }],
    ];
    let index = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const [status, body] = replies[index] ?? [500, {}];
        index += 1;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const records: DecisionCallRecord[] = [];
      const answered = decisionAlias({ alias: "answered", model: "fixture", baseURL });
      const keyless = decisionAlias({
        alias: "keyless",
        // Its own route, so the breaker the failures above trip does not stop it first.
        model: "fixture-keyless",
        baseURL,
        credential: "ABSENT_CREDENTIAL",
      });
      const budget = new InMemoryModelBudget(() => 10_000);
      const models = createModelGateway({
        aliases: [],
        adapters: {},
        decisionAliases: [answered, keyless],
        decisionAdapters: {
          "vercel-ai-gateway": new AiSdkDecisionAdapter((reference) =>
            reference === "ABSENT_CREDENTIAL" ? undefined : "local test credential",
          ),
        },
        budget,
        accounting: {
          record: () => undefined,
          recordDecision: (record) => void records.push(record),
        },
      });
      const ask = (alias: string, callId: string) =>
        models.decide({ alias, callId, attribution, state: "resting", question });
      const outcomes = [];
      for (const callId of ["refused-priced", "refused-unknown", "invalid", "limited", "server"])
        outcomes.push(await ask("answered", callId));
      outcomes.push(await ask("keyless", "no-credential"));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(6).fill("failed"));
      expect(records.map((record) => [record.outcome, record.costMicrousd])).toEqual([
        ["refused", 9],
        ["refused", null],
        ["unavailable", 5],
        ["rate_limited", 0],
        ["unavailable", null],
        ["unavailable", 0],
      ]);
      expect(records.map((record) => record.reservedMicrousd)).toEqual(Array(6).fill(1000));
      expect(index).toBe(5);
      // Settled: 9 + 1000 (unknown) + 5 + 0 + 1000 (unknown) + 0.
      expect(budget.spentMicrousd("t/w")).toBe(2014);
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
    expect(records[1]).toMatchObject({ outcome: "rate_limited", label: null, costMicrousd: 0 });
    const exhausted = await models.decide({ ...request, callId: "c3" });
    expect(exhausted).toMatchObject({ status: "failed", code: "unavailable" });
  });
});
