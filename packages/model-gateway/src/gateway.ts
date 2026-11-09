import { z } from "zod";
import {
  BILLING_UNKNOWN,
  type ProviderBilling,
  ProviderFailure,
  type RouteAdapter,
  type RouteCall,
} from "./adapter.js";
import { costCeilingMicrousd, type ModelAliasDefinition, type ModelRoute } from "./aliases.js";
import { RouteBreaker } from "./breaker.js";
import type {
  DecisionAdapter,
  DecisionAliasDefinition,
  DecisionCallRecord,
  DecisionOutcome,
  DecisionRequest,
} from "./decision.js";
import type {
  ModelAccountingSink,
  ModelBudgetPort,
  ModelCallRecord,
  ModelFailureCode,
  ModelGateway,
  ModelOutcome,
  ModelRequest,
  ModelRouteStatus,
  ProviderKind,
  RouteAttempt,
  RouteAttemptOutcome,
  StructuredModelRequest,
} from "./port.js";

export interface ModelGatewayOptions {
  readonly aliases: readonly ModelAliasDefinition[];
  readonly adapters: Readonly<Partial<Record<ProviderKind, RouteAdapter>>>;
  readonly budget: ModelBudgetPort;
  readonly accounting: ModelAccountingSink;
  readonly now?: () => number;
  /** Decision aliases and the adapters that serve them; absent, `decide` refuses its alias. */
  readonly decisionAliases?: readonly DecisionAliasDefinition[];
  readonly decisionAdapters?: Readonly<Partial<Record<ProviderKind, DecisionAdapter>>>;
}

/** Route outcomes after which the next route of the alias is tried. */
const FALLBACK_ON = new Set<RouteAttemptOutcome>([
  "skipped_breaker_open",
  "credential_missing",
  "timeout_before_first_byte",
  "rate_limited",
  "unavailable",
]);

/** Route outcomes that count against the route's breaker. */
const BREAKER_FAILURES = new Set<RouteAttemptOutcome>([
  "timeout_before_first_byte",
  "timeout_after_first_byte",
  "rate_limited",
  "unavailable",
]);

interface RouteResult {
  readonly attempt: RouteAttempt;
  readonly text: string;
  readonly retryable: boolean;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const now = options.now ?? Date.now;
  const aliases = new Map(options.aliases.map((alias) => [alias.alias, alias]));
  // A missing adapter is a composition error: refuse it here, before any call reserves budget.
  for (const alias of options.aliases) {
    for (const route of alias.routes) {
      if (options.adapters[route.provider] === undefined) {
        throw new Error(`no adapter for model provider: ${route.provider}`);
      }
    }
  }
  const breakers = new Map<string, RouteBreaker>();
  const breaker = (route: ModelRoute) => {
    let found = breakers.get(route.id);
    if (found === undefined) breakers.set(route.id, (found = new RouteBreaker()));
    return found;
  };

  const decisionAliases = new Map((options.decisionAliases ?? []).map((a) => [a.alias, a]));
  for (const alias of decisionAliases.values()) {
    if (options.decisionAdapters?.[alias.route.provider] === undefined)
      throw new Error(`no decision adapter for model provider: ${alias.route.provider}`);
  }

  async function decide(request: DecisionRequest, outer?: AbortSignal): Promise<DecisionOutcome> {
    const alias = decisionAliases.get(request.alias);
    if (alias === undefined) throw new Error(`unknown decision alias: ${request.alias}`);
    const { route } = alias;
    const started = now();
    const requestSha256 = await sha256(
      JSON.stringify([alias.alias, alias.policyVersion, request.state, request.question]),
    );
    const recordOf = (
      outcome: DecisionCallRecord["outcome"],
      fields: Partial<DecisionCallRecord> = {},
    ): DecisionCallRecord => ({
      callId: request.callId,
      alias: alias.alias,
      policyVersion: alias.policyVersion,
      attribution: request.attribution,
      model: route.model,
      responseModel: null,
      outcome,
      label: null,
      confidence: null,
      latencyMs: now() - started,
      costMicrousd: 0,
      reservedMicrousd: 0,
      requestSha256,
      ...fields,
    });
    const fail = async (
      code: ModelFailureCode,
      retryable: boolean,
      fields: Partial<DecisionCallRecord> = {},
    ): Promise<DecisionOutcome> => {
      const record = recordOf(code, fields);
      await options.accounting.recordDecision?.(record);
      return { status: "failed", code, retryable, record };
    };
    const encoder = new TextEncoder();
    const bytes =
      encoder.encode(request.state).length +
      encoder.encode(JSON.stringify(request.question)).length;
    if (bytes > alias.maxInputBytes) return fail("input_too_large", false);
    if (outer?.aborted) return fail("cancelled", true);
    const routeBreaker = breaker(route);
    if (!routeBreaker.admit(started)) return fail("unavailable", true);
    const scope = `${request.attribution.tenantId}/${request.attribution.worldId}`;
    const reservation = options.budget.reserve(scope, alias.maxCostMicrousd);
    if (reservation === undefined) return fail("budget_exceeded", true);
    const adapter = options.decisionAdapters?.[route.provider] as DecisionAdapter;
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", abortFromOuter, { once: true });
    try {
      const reply = await withTimeout(
        adapter.decide({
          route,
          state: request.state,
          question: request.question,
          signal: controller.signal,
        }),
        alias.timeoutMs,
      );
      const reserved = { reservedMicrousd: reservation.microusd };
      if (reply === TIMED_OUT) {
        controller.abort(new Error("decision timed out"));
        routeBreaker.failed(now());
        options.budget.settle(reservation, reservation.microusd);
        return await fail("timeout", true, { costMicrousd: null, ...reserved });
      }
      const cost = decisionCost(alias, reply);
      options.budget.settle(reservation, cost ?? reservation.microusd);
      routeBreaker.succeeded();
      const record = recordOf("completed", {
        responseModel: reply.responseModel,
        label: reply.answer.label,
        confidence: reply.answer.confidence,
        costMicrousd: cost,
        ...reserved,
      });
      await options.accounting.recordDecision?.(record);
      return { status: "completed", value: reply.answer, record };
    } catch (error) {
      // Only a failure that provably billed nothing settles at zero. A model refusal or an answer
      // that failed afterwards is priced from its usage; anything else keeps the reservation spent.
      const billing: ProviderBilling =
        !outer?.aborted && error instanceof ProviderFailure ? error.billing : BILLING_UNKNOWN;
      const cost =
        billing.kind === "none"
          ? 0
          : billing.kind === "usage"
            ? decisionCost(alias, billing)
            : null;
      options.budget.settle(reservation, cost ?? reservation.microusd);
      const kind = outer?.aborted
        ? "cancelled"
        : error instanceof ProviderFailure
          ? error.kind
          : "unavailable";
      if (kind === "rate_limited" || kind === "unavailable") routeBreaker.failed(now());
      else routeBreaker.released();
      const code = kind === "credential_missing" ? "unavailable" : kind;
      const retryable = error instanceof ProviderFailure ? error.retryable : kind === "cancelled";
      return await fail(code, retryable, {
        costMicrousd: cost,
        reservedMicrousd: reservation.microusd,
      });
    } finally {
      outer?.removeEventListener("abort", abortFromOuter);
    }
  }

  async function call<T>(
    request: ModelRequest,
    signal: AbortSignal | undefined,
    onText: ((delta: string) => void) | undefined,
    structured: z.ZodType<T> | undefined,
  ): Promise<ModelOutcome<T>> {
    const alias = aliases.get(request.alias);
    if (alias === undefined) throw new Error(`unknown model alias: ${request.alias}`);
    const jsonSchema =
      structured === undefined
        ? undefined
        : (z.toJSONSchema(structured) as Readonly<Record<string, unknown>>);
    const requestSha256 = await sha256(
      JSON.stringify([
        alias.alias,
        alias.policyVersion,
        request.system,
        request.messages,
        jsonSchema ?? null,
      ]),
    );
    const base = {
      callId: request.callId,
      alias: alias.alias,
      policyVersion: alias.policyVersion,
      attribution: request.attribution,
      requestSha256,
    };
    if (inputTokenBound(request, jsonSchema) > alias.maxInputTokens) {
      const record: ModelCallRecord = {
        ...base,
        decision: "input_refused",
        attempts: [],
        reservedMicrousd: 0,
        costMicrousd: 0,
        outputSha256: null,
      };
      await options.accounting.record(record);
      return { status: "failed", code: "input_too_large", retryable: false, record };
    }
    const scope = `${request.attribution.tenantId}/${request.attribution.worldId}`;
    const reservation = options.budget.reserve(scope, costCeilingMicrousd(alias));
    if (reservation === undefined) {
      const record: ModelCallRecord = {
        ...base,
        decision: "budget_refused",
        attempts: [],
        reservedMicrousd: 0,
        costMicrousd: 0,
        outputSha256: null,
      };
      await options.accounting.record(record);
      return { status: "failed", code: "budget_exceeded", retryable: true, record };
    }

    const results: RouteResult[] = [];
    for (const route of alias.routes) {
      const result = await attemptRoute(alias, route, request, signal, onText, jsonSchema);
      results.push(result);
      if (!fallsBack(result.attempt)) break;
    }
    const attempts = results.map((result) => result.attempt);
    // A route that streamed text bills its tokens even when it ended without usage: its cost is
    // unknown, so the whole reservation stays spent.
    const costUnknown = attempts.some(
      (attempt) => attempt.firstByteMs !== null && attempt.costMicrousd === null,
    );
    const costMicrousd = costUnknown
      ? null
      : attempts.reduce((sum, attempt) => sum + (attempt.costMicrousd ?? 0), 0);
    options.budget.settle(reservation, costMicrousd ?? reservation.microusd);
    const last = results[results.length - 1] as RouteResult;
    let outcome = last.attempt.outcome;
    let value: unknown = last.text;
    if (outcome === "completed" && structured !== undefined) {
      const parsed = parseStructured(last.text, structured);
      if (parsed.success) value = parsed.data;
      else outcome = "invalid_output";
    }
    const record: ModelCallRecord = {
      ...base,
      decision: fallsBack(last.attempt)
        ? "exhausted"
        : results.length === 1
          ? "primary"
          : "fallback",
      attempts:
        outcome === last.attempt.outcome
          ? attempts
          : [...attempts.slice(0, -1), { ...last.attempt, outcome }],
      reservedMicrousd: reservation.microusd,
      costMicrousd,
      outputSha256: last.text === "" ? null : await sha256(last.text),
    };
    await options.accounting.record(record);
    if (outcome === "completed") return { status: "completed", value: value as T, record };
    return {
      status: "failed",
      code: failureCode(outcome),
      retryable: outcome === "invalid_output" || results.some((result) => result.retryable),
      record,
    };
  }

  async function attemptRoute(
    alias: ModelAliasDefinition,
    route: ModelRoute,
    request: ModelRequest,
    outer: AbortSignal | undefined,
    onText: ((delta: string) => void) | undefined,
    jsonSchema: Readonly<Record<string, unknown>> | undefined,
  ): Promise<RouteResult> {
    const started = now();
    const routeBreaker = breaker(route);
    const attempt = (
      outcome: RouteAttemptOutcome,
      fields: Partial<RouteAttempt> = {},
    ): RouteAttempt => ({
      routeId: route.id,
      provider: route.provider,
      model: route.model,
      responseModel: null,
      outcome,
      httpStatus: null,
      latencyMs: now() - started,
      firstByteMs: null,
      inputTokens: null,
      outputTokens: null,
      costMicrousd: null,
      reportedCostUsd: null,
      finishReason: null,
      ...fields,
    });
    if (outer?.aborted) return { attempt: attempt("cancelled"), text: "", retryable: true };
    if (!routeBreaker.admit(started)) {
      return { attempt: attempt("skipped_breaker_open"), text: "", retryable: true };
    }
    const adapter = options.adapters[route.provider];
    if (adapter === undefined) throw new Error(`no adapter for model provider: ${route.provider}`);

    const controller = new AbortController();
    const abortFromOuter = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", abortFromOuter, { once: true });
    const routeCall: RouteCall = {
      route,
      system: request.system,
      messages: request.messages,
      maxOutputTokens: alias.maxOutputTokens,
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
      signal: controller.signal,
    };
    const iterator = adapter.stream(routeCall)[Symbol.asyncIterator]();
    let text = "";
    let firstByteAt: number | null = null;
    let finish: Extract<
      Awaited<ReturnType<typeof iterator.next>>["value"],
      { kind: "finish" }
    > | null = null;
    let result: RouteResult;
    try {
      const deadline = started + alias.timeouts.totalMs;
      for (;;) {
        const window = firstByteAt === null ? alias.timeouts.firstByteMs : alias.timeouts.idleMs;
        const next = await withTimeout(iterator.next(), Math.min(window, deadline - now()));
        if (next === TIMED_OUT) {
          controller.abort(new Error("model route timed out"));
          void iterator.return?.().catch(() => undefined);
          const outcome =
            firstByteAt === null ? "timeout_before_first_byte" : "timeout_after_first_byte";
          result = {
            attempt: attempt(outcome, {
              firstByteMs: firstByteAt === null ? null : firstByteAt - started,
            }),
            text,
            retryable: true,
          };
          break;
        }
        if (next.done) {
          result = completed();
          break;
        }
        const event = next.value;
        if (event.kind === "text") {
          if (firstByteAt === null) firstByteAt = now();
          text += event.text;
          onText?.(event.text);
        } else {
          finish = event;
        }
      }
    } catch (error) {
      const firstByteMs = firstByteAt === null ? null : firstByteAt - started;
      if (outer?.aborted) {
        result = { attempt: attempt("cancelled", { firstByteMs }), text, retryable: true };
      } else if (error instanceof ProviderFailure) {
        result = {
          attempt: attempt(error.kind, { httpStatus: error.httpStatus, firstByteMs }),
          text,
          retryable: error.retryable,
        };
      } else {
        result = { attempt: attempt("unavailable", { firstByteMs }), text, retryable: false };
      }
    } finally {
      outer?.removeEventListener("abort", abortFromOuter);
    }
    if (BREAKER_FAILURES.has(result.attempt.outcome)) routeBreaker.failed(now());
    else if (result.attempt.outcome === "completed") routeBreaker.succeeded();
    else routeBreaker.released();
    return result;

    function completed(): RouteResult {
      const inputTokens = finish?.inputTokens ?? null;
      const outputTokens = finish?.outputTokens ?? null;
      const refused = finish?.finishReason === "content-filter";
      return {
        attempt: attempt(refused ? "refused" : "completed", {
          firstByteMs: firstByteAt === null ? null : firstByteAt - started,
          inputTokens,
          outputTokens,
          costMicrousd:
            inputTokens === null || outputTokens === null
              ? null
              : Math.round(
                  inputTokens * route.priceUsdPerMTok.input +
                    outputTokens * route.priceUsdPerMTok.output,
                ),
          reportedCostUsd: finish?.reportedCostUsd ?? null,
          responseModel: finish?.responseModel ?? null,
          finishReason: finish?.finishReason ?? null,
        }),
        text,
        retryable: false,
      };
    }
  }

  return {
    stream: (request, signal, onText) => call<string>(request, signal, onText, undefined),
    decide,
    generateObject: <T>(request: StructuredModelRequest<T>, signal?: AbortSignal) =>
      call<T>(request, signal, undefined, request.schema),
    inspect(name: string): ModelRouteStatus {
      const alias = aliases.get(name);
      if (alias === undefined) throw new Error(`unknown model alias: ${name}`);
      return {
        alias: alias.alias,
        policyVersion: alias.policyVersion,
        routes: alias.routes.map((route) => ({
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          breaker: breaker(route).state(now()),
          consecutiveFailures: breaker(route).consecutiveFailures,
        })),
      };
    },
  };
}

/**
 * A decision call's cost in microdollars: the gateway-reported cost, else configured prices over
 * reported tokens, else null (unknown, never zero).
 */
function decisionCost(
  alias: DecisionAliasDefinition,
  usage: Readonly<{
    reportedCostUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>,
): number | null {
  if (usage.reportedCostUsd !== null) return Math.round(usage.reportedCostUsd * 1_000_000);
  if (alias.priceConfigured === false || usage.inputTokens === null || usage.outputTokens === null)
    return null;
  return Math.round(
    usage.inputTokens * alias.route.priceUsdPerMTok.input +
      usage.outputTokens * alias.route.priceUsdPerMTok.output,
  );
}

/**
 * Falls back only when the route sent no text: once text has streamed, a second route would
 * duplicate it, whatever ended the first.
 */
function fallsBack(attempt: RouteAttempt): boolean {
  return FALLBACK_ON.has(attempt.outcome) && attempt.firstByteMs === null;
}

/**
 * An upper bound on the request's input tokens, checked before any reservation: one token is at
 * least one UTF-8 byte, plus a margin for message framing.
 */
function inputTokenBound(
  request: ModelRequest,
  jsonSchema: Readonly<Record<string, unknown>> | undefined,
): number {
  const encoder = new TextEncoder();
  const bytes = (text: string) => encoder.encode(text).length;
  return (
    bytes(request.system) +
    request.messages.reduce((sum, message) => sum + bytes(message.text) + 8, 0) +
    (jsonSchema === undefined ? 0 : bytes(JSON.stringify(jsonSchema))) +
    16
  );
}

function parseStructured<T>(text: string, schema: z.ZodType<T>) {
  try {
    return schema.safeParse(JSON.parse(text));
  } catch {
    return { success: false as const };
  }
}

function failureCode(outcome: RouteAttemptOutcome): ModelFailureCode {
  switch (outcome) {
    case "timeout_before_first_byte":
    case "timeout_after_first_byte":
      return "timeout";
    case "rate_limited":
    case "refused":
    case "invalid_output":
    case "cancelled":
      return outcome;
    default:
      return "unavailable";
  }
}

const TIMED_OUT = Symbol("timed out");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
