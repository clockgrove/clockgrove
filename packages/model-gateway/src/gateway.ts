import { z } from "zod";
import { ProviderFailure, type RouteAdapter, type RouteCall } from "./adapter.js";
import { costCeilingMicrousd, type ModelAliasDefinition, type ModelRoute } from "./aliases.js";
import { RouteBreaker } from "./breaker.js";
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
  const breakers = new Map<string, RouteBreaker>();
  const breaker = (route: ModelRoute) => {
    let found = breakers.get(route.id);
    if (found === undefined) breakers.set(route.id, (found = new RouteBreaker()));
    return found;
  };

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
      if (!FALLBACK_ON.has(result.attempt.outcome)) break;
    }
    const attempts = results.map((result) => result.attempt);
    const costMicrousd = attempts.reduce((sum, attempt) => sum + (attempt.costMicrousd ?? 0), 0);
    options.budget.settle(reservation, costMicrousd);
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
      decision: FALLBACK_ON.has(outcome)
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
      if (outer?.aborted) {
        result = { attempt: attempt("cancelled"), text, retryable: true };
      } else if (error instanceof ProviderFailure) {
        result = {
          attempt: attempt(error.kind, { httpStatus: error.httpStatus }),
          text,
          retryable: error.retryable,
        };
      } else {
        result = { attempt: attempt("unavailable"), text, retryable: false };
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
          finishReason: finish?.finishReason ?? null,
        }),
        text,
        retryable: false,
      };
    }
  }

  return {
    stream: (request, signal, onText) => call<string>(request, signal, onText, undefined),
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
