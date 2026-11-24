import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AiSdkRouteAdapter,
  callUsage,
  createModelGateway,
  InMemoryModelBudget,
  type ModelAliasDefinition,
  type ModelCallRecord,
  ScriptedModelProvider,
} from "../src/index.js";

// A local stand-in for the Anthropic Messages API, so the real adapter runs offline.
type Behaviour =
  | {
      reply: string[];
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      thinking?: number;
    }
  | { stallAfter: string[] }
  | { overloadAfter: string[] }
  | { status: number };
const queues: Record<string, Behaviour[]> = { primary: [], fallback: [] };
const received: { route: string; headers: IncomingHttpHeaders; body: string }[] = [];
let server: Server;
let origin = "";

function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const route = request.url?.split("/")[1] ?? "";
      received.push({ route, headers: request.headers, body });
      const behaviour = queues[route]?.shift() ?? { status: 500 };
      if ("status" in behaviour) {
        response.writeHead(behaviour.status, { "content-type": "application/json" });
        response.end('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const input = "input" in behaviour ? behaviour.input : 1;
      response.write(
        sse({
          type: "message_start",
          message: {
            id: "msg_local",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: input,
              output_tokens: 1,
              ...("cacheRead" in behaviour ? { cache_read_input_tokens: behaviour.cacheRead } : {}),
              ...("cacheWrite" in behaviour
                ? { cache_creation_input_tokens: behaviour.cacheWrite }
                : {}),
            },
          },
        }),
      );
      const chunks =
        "reply" in behaviour
          ? behaviour.reply
          : "stallAfter" in behaviour
            ? behaviour.stallAfter
            : behaviour.overloadAfter;
      if (chunks.length > 0) {
        response.write(
          sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        );
      }
      for (const text of chunks) {
        response.write(
          sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
        );
      }
      if ("overloadAfter" in behaviour) {
        const error = { type: "overloaded_error", message: "Overloaded" };
        response.end(sse({ type: "error", error }));
        return;
      }
      if (!("reply" in behaviour)) return; // stall with the response open
      response.write(sse({ type: "content_block_stop", index: 0 }));
      response.write(
        sse({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: behaviour.output,
            ...(behaviour.thinking === undefined
              ? {}
              : { output_tokens_details: { thinking_tokens: behaviour.thinking } }),
          },
        }),
      );
      response.end(sse({ type: "message_stop" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // One untimed call first: the adapter's one-time start-up cost (module set-up, the first local
  // connection) on a loaded runner must not count against the tests' 400 ms first-byte window.
  queues.primary = [{ reply: ["warm"], input: 1, output: 1 }];
  await localGateway([], SECRETS, undefined, {
    firstByteMs: 30_000,
    idleMs: 30_000,
    totalMs: 30_000,
  }).stream(
    { alias: "resident.local", callId: "warm-up", attribution, ...ask },
    undefined,
    () => {},
  );
  queues.primary = [];
  queues.fallback = [];
  received.length = 0;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const SECRETS: Record<string, string> = {
  PRIMARY_KEY: "local primary credential",
  FALLBACK_KEY: "local fallback credential",
};
const attribution = { tenantId: "tenant-a", worldId: "world-a", actorId: "resident" };
const ask = { system: "You are Resident.", messages: [{ role: "user" as const, text: "Hi" }] };

function localGateway(
  records: ModelCallRecord[],
  credentials = SECRETS,
  budget = new InMemoryModelBudget(() => 1_000_000),
  timeouts: ModelAliasDefinition["timeouts"] = { firstByteMs: 400, idleMs: 400, totalMs: 10_000 },
) {
  const route = (name: string, credential: string) => ({
    id: `local/${name}`,
    provider: "anthropic" as const,
    model: "claude-opus-5-5",
    credential,
    baseURL: `${origin}/${name}/v1`,
    priceUsdPerMTok: { input: 4, output: 20 },
  });
  const alias: ModelAliasDefinition = {
    alias: "resident.local",
    policyVersion: "resident.local@1",
    routes: [route("primary", "PRIMARY_KEY"), route("fallback", "FALLBACK_KEY")],
    maxInputTokens: 1_000,
    maxOutputTokens: 100,
    timeouts,
  };
  return createModelGateway({
    aliases: [alias],
    adapters: { anthropic: new AiSdkRouteAdapter((name) => credentials[name]) },
    budget,
    accounting: { record: (record) => void records.push(record) },
  });
}

describe("model gateway through the AI SDK adapter", () => {
  it("streams a reply, accounts tokens and cost, and sends the key only as a header", async () => {
    const records: ModelCallRecord[] = [];
    queues.primary = [{ reply: ["Hel", "lo"], input: 12, output: 7 }];
    received.length = 0;
    const deltas: string[] = [];
    const outcome = await localGateway(records).stream(
      { alias: "resident.local", callId: "call-1", attribution, ...ask },
      undefined,
      (delta) => deltas.push(delta),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.status === "completed" && outcome.value).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(records).toEqual([outcome.record]);
    expect(outcome.record).toMatchObject({
      callId: "call-1",
      alias: "resident.local",
      policyVersion: "resident.local@1",
      attribution,
      decision: "primary",
      reservedMicrousd: 2_172, // measured input (17 + 2 + 8 + 16 = 43) × 4 + 100 × 20
      costMicrousd: 188, // 12 × 4 + 7 × 20
      outputSha256: "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
    });
    expect(outcome.record.attempts).toMatchObject([
      {
        routeId: "local/primary",
        outcome: "completed",
        inputTokens: 12,
        outputTokens: 7,
        costMicrousd: 188,
        responseModel: "claude-opus-5-5",
        finishReason: "stop",
      },
    ]);
    const [request] = received;
    expect(request?.headers["x-api-key"]).toBe(SECRETS.PRIMARY_KEY);
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 100,
    });
    for (const secret of Object.values(SECRETS)) {
      expect(request?.body).not.toContain(secret);
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });

  it("reports a call's usage by token type, cached and reasoning tokens as parts of the totals", async () => {
    // Issue 329: one completed attempt whose provider reported cache reads, cache writes and
    // thinking tokens. The AI SDK's input total includes both cache counts; reasoning is a part of
    // the output.
    queues.primary = [
      { reply: ["Hi"], input: 10, output: 9, cacheRead: 30, cacheWrite: 5, thinking: 4 },
    ];
    const cached = await localGateway([]).stream({
      alias: "resident.local",
      callId: "u-1",
      attribution,
      ...ask,
    });
    expect(callUsage(cached.record)).toEqual({
      inputTokens: 45,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 5,
      outputTokens: 9,
      reasoningTokens: 4,
      calls: 1,
      costMicrousd: 360, // 45 × 4 + 9 × 20
    });
    // Over two attempts: the primary reached its provider and timed out before first bytes without
    // reporting usage, so every token total is unknown, never the fallback's alone.
    queues.primary = [{ stallAfter: [] }];
    queues.fallback = [{ reply: ["ok"], input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }];
    const fellBack = await localGateway([]).stream({
      alias: "resident.local",
      callId: "u-2",
      attribution,
      ...ask,
    });
    expect([fellBack.record.decision, callUsage(fellBack.record)]).toEqual([
      "fallback",
      {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        calls: 2,
        costMicrousd: 60, // the gateway's own cost record: 5 × 4 + 2 × 20
      },
    ]);
    // An attempt that never reached a provider counts nothing: the fallback's reported tokens are
    // the call's whole use. The provider reported no thinking tokens, so reasoning is unknown.
    const breakerGateway = localGateway([]);
    queues.primary = [{ status: 529 }, { status: 529 }, { status: 529 }];
    queues.fallback = Array.from({ length: 4 }, () => ({
      reply: ["ok"],
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
    }));
    for (const callId of ["u-3", "u-4", "u-5"])
      await breakerGateway.stream({ alias: "resident.local", callId, attribution, ...ask });
    const skipped = await breakerGateway.stream({
      alias: "resident.local",
      callId: "u-6",
      attribution,
      ...ask,
    });
    expect([
      skipped.record.attempts.map((attempt) => attempt.outcome),
      callUsage(skipped.record),
    ]).toEqual([
      ["skipped_breaker_open", "completed"],
      {
        inputTokens: 4,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: null,
        calls: 1,
        costMicrousd: 56,
      },
    ]);
  });

  it("falls back after a timeout before first bytes, but not after first bytes", async () => {
    const records: ModelCallRecord[] = [];
    const budget = new InMemoryModelBudget(() => 1_000_000);
    const gateway = localGateway(records, SECRETS, budget);
    queues.primary = [{ stallAfter: [] }, { stallAfter: ["Hal"] }, { overloadAfter: ["Hel"] }];
    queues.fallback = [{ reply: ["Fine."], input: 5, output: 2 }];
    const before = await gateway.stream({
      alias: "resident.local",
      callId: "c-1",
      attribution,
      ...ask,
    });
    expect(before.status === "completed" && before.value).toBe("Fine.");
    expect(before.record.decision).toBe("fallback");
    expect(before.record.attempts.map((attempt) => attempt.outcome)).toEqual([
      "timeout_before_first_byte",
      "completed",
    ]);
    const deltas: string[] = [];
    const after = await gateway.stream(
      { alias: "resident.local", callId: "c-2", attribution, ...ask },
      undefined,
      (delta) => deltas.push(delta),
    );
    expect(after).toMatchObject({ status: "failed", code: "timeout", retryable: true });
    expect(after.record.attempts.map((attempt) => attempt.outcome)).toEqual([
      "timeout_after_first_byte",
    ]);
    // Tokens streamed without usage are billed but unknown, so the reservation stays spent.
    expect(after.record.costMicrousd).toBeNull();
    expect(budget.spentMicrousd("tenant-a/world-a")).toBe(60 + 2_172);
    const overloaded = await gateway.stream(
      { alias: "resident.local", callId: "c-3", attribution, ...ask },
      undefined,
      (delta) => deltas.push(delta),
    );
    expect(overloaded).toMatchObject({ status: "failed", code: "unavailable" });
    expect(overloaded.record.decision).toBe("primary");
    expect(overloaded.record.attempts).toMatchObject([{ outcome: "unavailable" }]);
    expect(deltas).toEqual(["Hal", "Hel"]);
  });

  it("sends a JSON schema to the provider and validates its structured reply", async () => {
    queues.primary = [{ reply: ['{"mood":', '"calm"}'], input: 9, output: 6 }];
    received.length = 0;
    const mood = z.object({ mood: z.enum(["calm", "curious"]) });
    const request = { alias: "resident.local", callId: "o-1", attribution, ...ask, schema: mood };
    const outcome = await localGateway([]).generateObject(request);
    expect(outcome.status === "completed" && outcome.value).toEqual({ mood: "calm" });
    expect(received[0]?.body).toContain('"required":["mood"]');
    const huge = { ...request, callId: "o-2", system: "é".repeat(500) };
    const refused = await localGateway([]).generateObject(huge);
    // 500 two-byte characters, "Hi" and the schema, with framing: refused with its measured size.
    expect(refused).toMatchObject({
      status: "failed",
      code: "input_too_large",
      retryable: false,
      inputTokens: 1_000 + 2 + 8 + 16 + JSON.stringify(z.toJSONSchema(mood)).length,
      maxInputTokens: 1_000,
    });
    expect(refused.record).toMatchObject({ decision: "input_refused", attempts: [] });
    expect(received).toHaveLength(1);
  });

  it("opens the breaker after three overloads and routes around it visibly", async () => {
    const records: ModelCallRecord[] = [];
    const gateway = localGateway(records);
    queues.primary = [{ status: 529 }, { status: 529 }, { status: 529 }];
    queues.fallback = Array.from({ length: 4 }, () => ({ reply: ["ok"], input: 1, output: 1 }));
    received.length = 0;
    for (const callId of ["b-1", "b-2", "b-3", "b-4"]) {
      const outcome = await gateway.stream({
        alias: "resident.local",
        callId,
        attribution,
        ...ask,
      });
      expect(outcome.status).toBe("completed");
    }
    expect(records[0]?.attempts[0]).toMatchObject({ outcome: "unavailable", httpStatus: 529 });
    expect(records[3]?.attempts.map((attempt) => attempt.outcome)).toEqual([
      "skipped_breaker_open",
      "completed",
    ]);
    expect(received.filter((request) => request.route === "primary")).toHaveLength(3);
    expect(gateway.inspect("resident.local").routes.map((route) => route.breaker)).toEqual([
      "open",
      "closed",
    ]);
  });

  it("ends a provider 400 as a request failure without charging or leaving the route", async () => {
    const records: ModelCallRecord[] = [];
    const gateway = localGateway(records);
    queues.primary = [{ status: 400 }];
    queues.fallback = [{ reply: ["ok"], input: 1, output: 1 }];
    const outcome = await gateway.stream({
      alias: "resident.local",
      callId: "r-1",
      attribution,
      ...ask,
    });
    expect(outcome).toMatchObject({ status: "failed", code: "request_rejected", retryable: false });
    expect(outcome.record.attempts).toMatchObject([
      { outcome: "request_rejected", httpStatus: 400 },
    ]);
    expect(gateway.inspect("resident.local").routes[0]).toMatchObject({
      breaker: "closed",
      consecutiveFailures: 0,
    });
  });

  it("reports every route down as a recoverable state without calling out", async () => {
    const records: ModelCallRecord[] = [];
    received.length = 0;
    const outcome = await localGateway(records, {}).stream({
      alias: "resident.local",
      callId: "d-1",
      attribution,
      ...ask,
    });
    expect(outcome).toMatchObject({ status: "failed", code: "unavailable", retryable: false });
    expect(outcome.record.decision).toBe("exhausted");
    expect(outcome.record.attempts.map((attempt) => attempt.outcome)).toEqual([
      "credential_missing",
      "credential_missing",
    ]);
    expect(received).toEqual([]);
  });
});

describe("model gateway with the scripted provider", () => {
  const alias: ModelAliasDefinition = {
    alias: "resident.scripted",
    policyVersion: "resident.scripted@1",
    routes: [
      {
        id: "scripted/a",
        provider: "scripted",
        model: "scripted-v1",
        credential: null,
        priceUsdPerMTok: { input: 1, output: 1 },
      },
    ],
    maxInputTokens: 1_000,
    maxOutputTokens: 10,
    timeouts: { firstByteMs: 1_000, idleMs: 1_000, totalMs: 5_000 },
  };
  const mood = z.object({ mood: z.enum(["calm", "curious"]) });

  it("validates structured output, refuses over budget and survives a down provider", async () => {
    const records: ModelCallRecord[] = [];
    const scripted = new ScriptedModelProvider({
      "scripted/a": [
        { kind: "reply", chunks: ['{"mood":', '"calm"}'], inputTokens: 3, outputTokens: 4 },
        { kind: "reply", chunks: ['{"mood":"angry"}'], inputTokens: 3, outputTokens: 4 },
        { kind: "http", status: 503 },
      ],
    });
    const budget = new InMemoryModelBudget((scope) => (scope === "tenant-a/world-a" ? 2_000 : 0));
    const gateway = createModelGateway({
      aliases: [alias],
      adapters: { scripted },
      budget,
      accounting: { record: (record) => void records.push(record) },
    });
    const request = { alias: "resident.scripted", attribution, ...ask, schema: mood };
    const valid = await gateway.generateObject({ ...request, callId: "s-1" });
    expect(valid.status === "completed" && valid.value).toEqual({ mood: "calm" });
    expect(scripted.calls[0]?.jsonSchema).toMatchObject({ required: ["mood"] });
    const invalid = await gateway.generateObject({ ...request, callId: "s-2" });
    expect(invalid).toMatchObject({ status: "failed", code: "invalid_output", retryable: true });
    const down = await gateway.stream({ ...request, callId: "s-3" });
    expect(down).toMatchObject({ status: "failed", code: "unavailable", retryable: true });
    expect(down.record.attempts[0]).toMatchObject({ outcome: "unavailable", httpStatus: 503 });
    const otherWorld = { ...attribution, worldId: "world-b" };
    const refused = await gateway.stream({ ...request, callId: "s-4", attribution: otherWorld });
    expect(refused).toMatchObject({ status: "failed", code: "budget_exceeded" });
    expect(refused.record).toMatchObject({ decision: "budget_refused", attempts: [] });
    expect(scripted.calls).toHaveLength(3);
    expect(records.map((record) => record.callId)).toEqual(["s-1", "s-2", "s-3", "s-4"]);
    const unwired = { aliases: [alias], adapters: {}, budget, accounting: { record: () => {} } };
    expect(() => createModelGateway(unwired)).toThrow(/no adapter/u);
  });

  it("ends a call whose fallback the caller refuses or cannot decide, keeping the evidence", async () => {
    const records: ModelCallRecord[] = [];
    const scripted = new ScriptedModelProvider({
      "scripted/a": [
        { kind: "http", status: 503 },
        { kind: "http", status: 503 },
      ],
      "scripted/b": [],
    });
    const budget = new InMemoryModelBudget(() => 1_000_000);
    const twoRoutes: ModelAliasDefinition = {
      ...alias,
      routes: [alias.routes[0]!, { ...alias.routes[0]!, id: "scripted/b" }],
    };
    const gateway = createModelGateway({
      aliases: [twoRoutes],
      adapters: { scripted },
      budget,
      accounting: { record: (record) => void records.push(record) },
    });
    const request = { alias: "resident.scripted", attribution, ...ask, schema: mood };
    const asked: { routeId: string; reserveMicrousd: number }[] = [];
    const refused = await gateway.generateObject({
      ...request,
      callId: "f-1",
      admitFallback: async (route) => {
        asked.push(route);
        return false;
      },
    });
    expect(refused).toMatchObject({ status: "failed", code: "budget_exceeded", retryable: false });
    expect(refused.record.decision).toBe("budget_refused");
    expect(refused.record.attempts.map((attempt) => [attempt.routeId, attempt.outcome])).toEqual([
      ["scripted/a", "unavailable"],
    ]);
    expect(asked).toEqual([{ routeId: "scripted/b", reserveMicrousd: expect.any(Number) }]);
    expect(asked[0]!.reserveMicrousd).toBeGreaterThan(0);

    const storeDown = new Error("store unavailable");
    await expect(
      gateway.generateObject({
        ...request,
        callId: "f-2",
        admitFallback: () => Promise.reject(storeDown),
      }),
    ).rejects.toBe(storeDown);
    expect(records.map((record) => record.callId)).toEqual(["f-1", "f-2"]);
    expect(records[1]).toMatchObject({ decision: "exhausted", costMicrousd: 0 });
    expect(records[1]!.attempts.map((attempt) => attempt.routeId)).toEqual(["scripted/a"]);
    // The second route was never called, and both reservations were settled to their real cost.
    expect(scripted.calls.map((call) => call.route.id)).toEqual(["scripted/a", "scripted/a"]);
    expect(budget.spentMicrousd("tenant-a/world-a")).toBe(0);
  });
});
