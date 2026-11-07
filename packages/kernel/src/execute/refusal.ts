/**
 * Stable machine codes. Every refusal is returned, never thrown out of the executor, and carries
 * no message, stack, host path, timestamp or other nondeterministic text.
 */
export const REFUSAL_CODES = Object.freeze([
  "invalid-input",
  "unsupported-input",
  "unknown-command-version",
  "unknown-event-version",
  "revision-conflict",
  "precondition-failed",
  "invariant-violated",
  "delta-mismatch",
  "mutation-detected",
  "empty-result",
  "handler-failed",
  "reducer-failed",
  "check-error",
  "duplicate-registration",
  "missing-registration-part",
  "unknown-policy-kind",
  "missing-reducer",
  "orphan-reducer",
] as const);

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Canonically encodable envelope; `check` is `name@version`, `path` a canonical path string. */
export interface Refusal {
  readonly code: RefusalCode;
  readonly path: string;
  readonly check?: string;
}

export function refusal(code: RefusalCode, path: string, check?: string): Refusal {
  return Object.freeze(check === undefined ? { code, path } : { code, path, check });
}

/** Internal carrier used to unwind to the executor boundary; its message is never exposed. */
export class RefusalSignal extends Error {
  readonly refusal: Refusal;
  constructor(value: Refusal) {
    super(value.code);
    this.name = "RefusalSignal";
    this.refusal = value;
  }
}

/** Throws an `invalid-input` signal for the executor to convert into a returned refusal. */
export function invalid(path: string): never {
  throw new RefusalSignal(refusal("invalid-input", path));
}

export type RegistrationResult = Readonly<{ ok: true }> | Readonly<{ ok: false; error: Refusal }>;

export const REGISTERED: RegistrationResult = Object.freeze({ ok: true });

export function registrationRefusal(code: RefusalCode, path: string): RegistrationResult {
  return Object.freeze({ ok: false, error: refusal(code, path) });
}

export function isRefusalSignal(value: unknown): value is RefusalSignal {
  return value instanceof RefusalSignal;
}
