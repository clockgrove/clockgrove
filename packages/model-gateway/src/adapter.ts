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
 * HTTP refusals given before any model ran bill nothing: the gateway's authentication, payment and
 * rate limit refusals (401, 402, 403, 429), and a request rejected as such (issue 366): malformed
 * (400), naming no model or route (404) or over the body limit (413). Any other status (408, 5xx,
 * one without a known meaning) may follow model work, so its billing is unknown.
 */
const REFUSED_BEFORE_MODEL: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 413, 429]);
export function httpFailureBilling(status: number): ProviderBilling {
  return REFUSED_BEFORE_MODEL.has(status) ? NOTHING_BILLED : BILLING_UNKNOWN;
}

/**
 * A 4xx the provider gave to the request itself (a refused schema, an over-long prompt) says
 * nothing about the route's health, so it is not a route fault. 401, 402 and 403 are the route's
 * credential or account, and 408 and 429 are transient: those stay route faults.
 */
export function isRequestRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status);
}

/** A provider fault, already classified. Its message never carries provider text or secrets. */
export class ProviderFailure extends Error {
  constructor(
    readonly kind:
      | "credential_missing"
      | "rate_limited"
      | "unavailable"
      | "request_rejected"
      | "refused",
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    /** Read by the decision path; unknown unless the adapter knows better. */
    readonly billing: ProviderBilling = BILLING_UNKNOWN,
  ) {
    super(`model provider failure: ${kind}${httpStatus === null ? "" : ` (${httpStatus})`}`);
  }
}
