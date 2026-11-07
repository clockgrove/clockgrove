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

/** A provider fault, already classified. Its message never carries provider text or secrets. */
export class ProviderFailure extends Error {
  constructor(
    readonly kind: "credential_missing" | "rate_limited" | "unavailable" | "refused",
    readonly httpStatus: number | null,
    readonly retryable: boolean,
  ) {
    super(`model provider failure: ${kind}${httpStatus === null ? "" : ` (${httpStatus})`}`);
  }
}
