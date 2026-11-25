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
  it("asks named questions in the same decisions call and fails a call that leaves one unanswered", async () => {
    const bodies: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        const choice = {
          type: "choice",
          choice: "stay",
          probabilities: { stay: 0.7, "seek-food:bin": 0.3 },
        };
        const named = { type: "boolean", probability: 0.8 };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            answers: bodies.length === 1 ? { q: choice, minor: named } : { q: choice },
            usage: { inputTokens: 10, outputTokens: 2 },
            providerMetadata: { gateway: { cost: "0.000004" } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const named = decisionAlias({ alias: "named", model: "fixture", baseURL });
      const models = createModelGateway({
        aliases: [],
        adapters: {},
        decisionAliases: [named],
        decisionAdapters: {
          "vercel-ai-gateway": new AiSdkDecisionAdapter(() => "local test credential"),
        },
        budget: new InMemoryModelBudget(() => 5000),
        accounting: { record: () => undefined },
      });
      const request = {
        alias: "named",
        callId: "n1",
        attribution,
        state: "resting",
        question,
        questions: { minor: { type: "boolean", instructions: "Is the sender a minor?" } },
      } as const;
      const answered = await models.decide(request);
      expect(answered).toMatchObject({
        status: "completed",
        value: { label: "stay", confidence: 0.7 },
        answers: { minor: { type: "boolean", label: "true", confidence: 0.8 } },
        record: { costMicrousd: 4 },
      });
      expect(JSON.stringify(bodies[0])).toContain("Is the sender a minor?");
      expect(await models.decide({ ...request, callId: "n2" })).toMatchObject({
        status: "failed",
        code: "unavailable",
        record: { costMicrousd: 4 },
      });
      expect(bodies).toHaveLength(2);
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
      // A request rejected before any model ran (malformed, no such model, too large): nothing billed.
      [400, { error: { message: "bad request" } }],
      [404, { error: { message: "model not found" } }],
      [413, { error: { message: "payload too large" } }],
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
      for (const callId of ["refused-priced", "refused-unknown", "invalid", "limited"])
        outcomes.push(await ask("answered", callId));
      for (const callId of ["malformed", "no-model", "too-large", "server"])
        outcomes.push(await ask("answered", callId));
      outcomes.push(await ask("keyless", "no-credential"));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(9).fill("failed"));
      expect(records.map((record) => [record.outcome, record.costMicrousd])).toEqual([
        ["refused", 9],
        ["refused", null],
        ["unavailable", 5],
        ["rate_limited", 0],
        ["request_rejected", 0],
        ["request_rejected", 0],
        ["request_rejected", 0],
        ["unavailable", null],
        ["unavailable", 0],
      ]);
      expect(records.map((record) => record.reservedMicrousd)).toEqual(Array(9).fill(1000));
      expect(index).toBe(8);
      // Settled: 9 + 1000 (unknown) + 5 + 0 + 0 + 0 + 0 + 1000 (unknown) + 0.
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

  it("says whether the provider was called and carries the tokens it reported, unknown as null", async () => {
    const records: DecisionCallRecord[] = [];
    const decider = new ScriptedDecider({
      [alias.route.id]: [
        {
          kind: "answer",
          answer: { type: "choice", label: "stay", confidence: 0.9 },
          inputTokens: 30,
          outputTokens: 3,
        },
        { kind: "http", status: 429 },
        // Last: its unknown cost spends the whole reservation.
        { kind: "http", status: 503 },
      ],
    });
    const models = gateway(decider, records);
    const request = { alias: alias.alias, callId: "u1", attribution, state: "hungry", question };
    await models.decide(request);
    await models.decide({ ...request, callId: "u2" });
    await models.decide({ ...request, callId: "u3" });
    // Refused before the provider: input over the alias's 8192 bytes.
    await models.decide({ ...request, callId: "u4", state: "x".repeat(8193) });
    const usage = (record: DecisionCallRecord | undefined) => [
      record?.outcome,
      record?.providerCalled,
      record?.inputTokens,
      record?.outputTokens,
    ];
    expect(records.map(usage)).toEqual([
      ["completed", true, 30, 3],
      ["rate_limited", true, 0, 0],
      ["unavailable", true, null, null],
      ["input_too_large", false, 0, 0],
    ]);
    expect(decider.calls).toHaveLength(3);

    // Refused by the budget before the provider: nothing sent.
    const broke: DecisionCallRecord[] = [];
    await createModelGateway({
      aliases: [],
      adapters: {},
      decisionAliases: [alias],
      decisionAdapters: { "vercel-ai-gateway": new ScriptedDecider({}) },
      budget: new InMemoryModelBudget(() => 0),
      accounting: { record: () => undefined, recordDecision: (record) => void broke.push(record) },
    }).decide({ ...request, callId: "u5" });
    expect(broke.map(usage)).toEqual([["budget_exceeded", false, 0, 0]]);
  });

  it("records each breaker change on the decision that caused it, a trial answered by its own end", async () => {
    let clock = 1_000_000;
    const records: DecisionCallRecord[] = [];
    const answer = { type: "choice", label: "stay", confidence: null } as const;
    const decider = new ScriptedDecider({
      [alias.route.id]: [
        { kind: "answer", answer, delayMs: 50 },
        { kind: "http", status: 529 },
        { kind: "http", status: 529 },
        { kind: "http", status: 529 },
        { kind: "refusal" },
        { kind: "answer", answer },
      ],
    });
    const models = createModelGateway({
      aliases: [],
      adapters: {},
      decisionAliases: [alias],
      decisionAdapters: { "vercel-ai-gateway": decider },
      budget: new InMemoryModelBudget(() => 1_000_000),
      accounting: {
        record: () => undefined,
        recordDecision: (record) => void records.push(record),
      },
      now: () => clock,
    });
    const ask = (callId: string) =>
      models.decide({ alias: "shadow.default", callId, attribution, state: "resting", question });
    const moves = (callId: string) =>
      (records.find((record) => record.callId === callId)?.breakerTransitions ?? []).map(
        (move) => `${move.from}>${move.to} ${move.consecutiveFailures}`,
      );
    // Admitted while closed, it answers only after three overloads opened the route and its
    // cooldown elapsed: its success closes an open breaker; no trial ran.
    const straggler = ask("straggler");
    for (const callId of ["o-1", "o-2", "o-3"]) await ask(callId);
    clock += 31_000;
    await straggler;
    expect(["o-1", "o-2", "o-3", "straggler"].map(moves)).toEqual([
      [],
      [],
      ["closed>open 3"],
      ["open>closed 0"],
    ]);
    // Open again; a trial that ends without a verdict returns it to open, and the next is a trial.
    const reopen = new ScriptedDecider({
      [alias.route.id]: [
        { kind: "http", status: 529 },
        { kind: "http", status: 529 },
        { kind: "http", status: 529 },
        { kind: "refusal" },
        { kind: "answer", answer },
      ],
    });
    const again = createModelGateway({
      aliases: [],
      adapters: {},
      decisionAliases: [alias],
      decisionAdapters: { "vercel-ai-gateway": reopen },
      budget: new InMemoryModelBudget(() => 1_000_000),
      accounting: {
        record: () => undefined,
        recordDecision: (record) => void records.push(record),
      },
      now: () => clock,
    });
    for (const callId of ["r-1", "r-2", "r-3"])
      await again.decide({ alias: "shadow.default", callId, attribution, state: "s", question });
    clock += 31_000;
    for (const callId of ["trial-refused", "trial-answered"])
      await again.decide({ alias: "shadow.default", callId, attribution, state: "s", question });
    expect(["r-3", "trial-refused", "trial-answered"].map(moves)).toEqual([
      ["closed>open 3"],
      ["open>half_open 3", "half_open>open 3"],
      ["open>half_open 3", "half_open>closed 0"],
    ]);
  });
});
