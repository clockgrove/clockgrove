import type { z } from "zod";

/**
 * The project-owned model port. Callers name an alias; provider, model, bounds and fallback are
 * pinned by the alias. No provider SDK type crosses this module.
 */
export interface ModelGateway {
  /** Streams text deltas to `onText`; resolves to an outcome and never rejects for provider faults. */
  stream(
    request: ModelRequest,
    signal?: AbortSignal,
    onText?: (delta: string) => void,
  ): Promise<ModelOutcome<string>>;
  /** Asks for JSON and validates it with `request.schema`; invalid output is `invalid_output`. */
  generateObject<T>(
    request: StructuredModelRequest<T>,
    signal?: AbortSignal,
  ): Promise<ModelOutcome<T>>;
  inspect(alias: string): ModelRouteStatus;
}

export interface ModelAttribution {
  readonly tenantId: string;
  readonly worldId: string;
  readonly actorId: string;
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ModelRequest {
  readonly alias: string;
  /** Caller-chosen attempt identity, repeated in the accounting record. */
  readonly callId: string;
  readonly attribution: ModelAttribution;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
}

export interface StructuredModelRequest<T> extends ModelRequest {
  readonly schema: z.ZodType<T>;
}

/** Explicit, recoverable failure states. None of them is thrown. */
export type ModelFailureCode =
  | "unavailable"
  | "timeout"
  | "rate_limited"
  | "refused"
  | "invalid_output"
  | "budget_exceeded"
  | "input_too_large"
  | "cancelled";

export type ModelOutcome<T> =
  | Readonly<{ status: "completed"; value: T; record: ModelCallRecord }>
  | Readonly<{
      status: "failed";
      code: ModelFailureCode;
      /** True when the same request may succeed later; cognition degrades, the world continues. */
      retryable: boolean;
      record: ModelCallRecord;
    }>;

export type RouteAttemptOutcome =
  | "completed"
  | "skipped_breaker_open"
  | "credential_missing"
  | "timeout_before_first_byte"
  | "timeout_after_first_byte"
  | "rate_limited"
  | "unavailable"
  | "refused"
  | "invalid_output"
  | "cancelled";

export interface RouteAttempt {
  readonly routeId: string;
  readonly provider: ProviderKind;
  /** The route's pinned model name. */
  readonly model: string;
  /** The model the provider reported serving, when it reported one. */
  readonly responseModel: string | null;
  readonly outcome: RouteAttemptOutcome;
  /** HTTP status when the provider answered with one. */
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly firstByteMs: number | null;
  /** `null` means unknown, not zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicrousd: number | null;
  /** Cost the gateway itself reported, in USD, when it reported one. */
  readonly reportedCostUsd: number | null;
  readonly finishReason: string | null;
}

/** One record per call: what was tried, what it cost, and why each route was or was not used. */
export interface ModelCallRecord {
  readonly callId: string;
  readonly alias: string;
  readonly policyVersion: string;
  readonly attribution: ModelAttribution;
  /**
   * `primary`, `fallback` (a later route ended the call), `input_refused` (the request exceeds the
   * alias's input bound), `budget_refused` or `exhausted`.
   */
  readonly decision: "primary" | "fallback" | "input_refused" | "budget_refused" | "exhausted";
  readonly attempts: readonly RouteAttempt[];
  readonly reservedMicrousd: number;
  /** `null` when a route streamed text without reporting usage; the reservation is then spent. */
  readonly costMicrousd: number | null;
  /** SHA-256 hex of the canonical request and of the output text; the text itself is not kept. */
  readonly requestSha256: string;
  readonly outputSha256: string | null;
}

export interface ModelRouteStatus {
  readonly alias: string;
  readonly policyVersion: string;
  readonly routes: readonly Readonly<{
    routeId: string;
    provider: ProviderKind;
    model: string;
    breaker: "closed" | "open" | "half_open";
    consecutiveFailures: number;
  }>[];
}

export type ProviderKind = "scripted" | "vercel-ai-gateway" | "anthropic";

/** Accounting leaves the gateway through this port. */
export interface ModelAccountingSink {
  record(record: ModelCallRecord): void | Promise<void>;
}

/** Spend is reserved before a call and settled after it, outside any prompt. */
export interface ModelBudgetPort {
  reserve(scope: string, microusd: number): ModelBudgetReservation | undefined;
  settle(reservation: ModelBudgetReservation, actualMicrousd: number): void;
}

export interface ModelBudgetReservation {
  readonly scope: string;
  readonly microusd: number;
}

/** Resolves a credential reference (an environment name) to a secret; used only by adapters. */
export type CredentialResolver = (reference: string) => string | undefined;
