import type { ModelRoute } from "./aliases.js";
import type { ModelMessage } from "./port.js";

/** What the gateway asks one route for. Adapters own every provider type behind this shape. */
export interface RouteCall {
  readonly route: ModelRoute;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  /** JSON Schema of a structured answer; absent for free text. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export type ProviderEvent =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "finish";
      finishReason: string;
      inputTokens: number | null;
      outputTokens: number | null;
      reportedCostUsd: number | null;
      responseModel: string | null;
    }>;

export interface RouteAdapter {
  stream(call: RouteCall): AsyncIterable<ProviderEvent>;
}

/**
 * What a failed provider call may have billed. `none`: provably nothing (no request was sent, or
 * the gateway refused it before routing to a model). `usage`: the provider answered and reported
 * this usage before the call failed (a model refusal, an answer that failed to parse). `unknown`:
 * anything else; the caller keeps its whole reservation spent.
 */
export type ProviderBilling =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{
      kind: "usage";
      inputTokens: number | null;
      outputTokens: number | null;
      reportedCostUsd: number | null;
    }>;

export const NOTHING_BILLED: ProviderBilling = Object.freeze({ kind: "none" });
export const BILLING_UNKNOWN: ProviderBilling = Object.freeze({ kind: "unknown" });

/**
 * HTTP refusals the gateway gives before routing to a model (authentication, payment and rate
 * limit) bill nothing; any other status may follow model work, so its billing is unknown.
 */
export function httpFailureBilling(status: number): ProviderBilling {
  return status === 401 || status === 402 || status === 403 || status === 429
    ? NOTHING_BILLED
    : BILLING_UNKNOWN;
}

/** A provider fault, already classified. Its message never carries provider text or secrets. */
export class ProviderFailure extends Error {
  constructor(
    readonly kind: "credential_missing" | "rate_limited" | "unavailable" | "refused",
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    /** Read by the decision path; unknown unless the adapter knows better. */
    readonly billing: ProviderBilling = BILLING_UNKNOWN,
  ) {
    super(`model provider failure: ${kind}${httpStatus === null ? "" : ` (${httpStatus})`}`);
  }
}
