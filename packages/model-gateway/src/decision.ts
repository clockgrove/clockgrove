import type { ModelRoute } from "./aliases.js";
import type { ModelAttribution, ModelFailureCode } from "./port.js";

/** A bounded question: the caller lists the options; the model never invents one. */
export type DecisionQuestion =
  | Readonly<{
      type: "choice";
      /** Option label to its description. A label is the model's whole answer. */
      options: Readonly<Record<string, string | null>>;
      instructions?: string;
    }>
  | Readonly<{ type: "score"; levels: readonly string[]; instructions?: string }>
  | Readonly<{ type: "boolean"; instructions: string }>;

export interface DecisionRequest {
  readonly alias: string;
  /** Caller-chosen attempt identity, repeated in the call record. */
  readonly callId: string;
  readonly attribution: ModelAttribution;
  /** The facts the question is decided against, as text. */
  readonly state: string;
  readonly question: DecisionQuestion;
}

/** `confidence` is the model's probability for its answer, or null when it reported none. */
export type DecisionAnswer =
  | Readonly<{ type: "choice"; label: string; confidence: number | null }>
  | Readonly<{ type: "score"; label: string; score: number; confidence: number | null }>
  | Readonly<{ type: "boolean"; label: "true" | "false"; confidence: number | null }>;

/** One record per decide call; `null` means unknown, not zero. */
export interface DecisionCallRecord {
  readonly callId: string;
  readonly alias: string;
  readonly policyVersion: string;
  readonly attribution: ModelAttribution;
  /** The alias's configured model name. */
  readonly model: string;
  /** The model the provider reported serving, when it reported one. */
  readonly responseModel: string | null;
  readonly outcome: "completed" | ModelFailureCode;
  readonly label: string | null;
  readonly confidence: number | null;
  readonly latencyMs: number;
  readonly costMicrousd: number | null;
  readonly requestSha256: string;
}

export type DecisionOutcome =
  | Readonly<{ status: "completed"; value: DecisionAnswer; record: DecisionCallRecord }>
  | Readonly<{
      status: "failed";
      code: ModelFailureCode;
      retryable: boolean;
      record: DecisionCallRecord;
    }>;

/**
 * A decision alias. The model is configuration, never code: the free tier reached only some
 * models, and the choice among them is an operator's.
 */
export interface DecisionAliasDefinition {
  readonly alias: string;
  readonly policyVersion: string;
  readonly route: ModelRoute;
  /** Largest request the alias accepts, in UTF-8 bytes of state and options. */
  readonly maxInputBytes: number;
  readonly timeoutMs: number;
  /** The most one call may cost; reserved before the call and settled after it. */
  readonly maxCostMicrousd: number;
}

/** What the gateway asks a decision adapter for. Provider types stay behind the adapter. */
export interface DecisionCall {
  readonly route: ModelRoute;
  readonly state: string;
  readonly question: DecisionQuestion;
  readonly signal: AbortSignal;
}

export interface DecisionAdapterResult {
  readonly answer: DecisionAnswer;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Cost the gateway itself reported, in USD, when it reported one. */
  readonly reportedCostUsd: number | null;
  readonly responseModel: string | null;
}

export interface DecisionAdapter {
  /** Throws a `ProviderFailure` for a classified fault. */
  decide(call: DecisionCall): Promise<DecisionAdapterResult>;
}

/**
 * An alias for one decision model, built from configuration. Prices are optional: when the gateway
 * reports a cost it is used, otherwise the cost is unknown.
 */
export function decisionAlias(config: {
  readonly alias: string;
  readonly model: string;
  readonly credential?: string | null;
  readonly baseURL?: string;
  readonly maxInputBytes?: number;
  readonly timeoutMs?: number;
  readonly maxCostMicrousd?: number;
  readonly priceUsdPerMTok?: Readonly<{ input: number; output: number }>;
}): DecisionAliasDefinition {
  return {
    alias: config.alias,
    policyVersion: `${config.alias}@1`,
    route: {
      id: `vercel-ai-gateway/${config.model}`,
      provider: "vercel-ai-gateway",
      model: config.model,
      credential: config.credential === undefined ? "AI_GATEWAY_API_KEY" : config.credential,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      priceUsdPerMTok: config.priceUsdPerMTok ?? { input: 0, output: 0 },
    },
    // Decisions: 8 KiB of state, a 5 s bound (measured p95 stayed under 650 ms) and a $0.001 ceiling
    // per call (measured cost per answer was at most $0.00015) keep one shadow call small.
    maxInputBytes: config.maxInputBytes ?? 8192,
    timeoutMs: config.timeoutMs ?? 5000,
    maxCostMicrousd: config.maxCostMicrousd ?? 1000,
  };
}
