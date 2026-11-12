import type {
  BrowserScope,
  DeliveryConsent,
  DeliveryDecision,
  DeliveryReceipt,
  DeliveryRequested,
  DeliveryResult,
} from "@clockgrove/contracts";
import type { RuntimeAuthorizationContext } from "./persistence.js";

export interface DeliveryTarget {
  readonly scope: BrowserScope;
  readonly actorId: string;
  readonly sessionId: string;
}

export interface GovernedDeliveryPort {
  configureConsent(
    authorization: RuntimeAuthorizationContext,
    target: DeliveryTarget,
    input: Omit<DeliveryConsent, "version" | "reservedUnits">,
  ): Promise<DeliveryConsent>;
  request(
    authorization: RuntimeAuthorizationContext,
    request: DeliveryRequested,
  ): Promise<DeliveryResult>;
  resume(
    authorization: RuntimeAuthorizationContext,
    target: DeliveryTarget,
    dedupeKey: string,
  ): Promise<DeliveryReceipt>;
  replay(
    authorization: RuntimeAuthorizationContext,
    target: DeliveryTarget,
    dedupeKey: string,
  ): Promise<DeliveryReceipt | undefined>;
}

export class DeliveryRefusedError extends Error {
  override readonly name = "DeliveryRefusedError";
  constructor(
    readonly code:
      | "delivery_not_found"
      | "delivery_target_invalid"
      | "delivery_key_reused"
      | "delivery_policy_invalid",
  ) {
    super(code);
  }
}

export function validateDeliveryConsent(
  input: Omit<DeliveryConsent, "version" | "reservedUnits">,
): void {
  if (
    !input ||
    typeof input.timezone !== "string" ||
    input.timezone.length === 0 ||
    (input.quietHours !== null &&
      (typeof input.quietHours !== "object" || input.quietHours === undefined))
  )
    throw new DeliveryRefusedError("delivery_policy_invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new DeliveryRefusedError("delivery_policy_invalid");
  }
  if (
    typeof input.enabled !== "boolean" ||
    !Number.isSafeInteger(input.budgetLimit) ||
    input.budgetLimit < 0 ||
    (input.quietHours !== null &&
      [input.quietHours.startMinute, input.quietHours.endMinute].some(
        (v) => !Number.isInteger(v) || v < 0 || v >= 24 * 60,
      ))
  )
    throw new DeliveryRefusedError("delivery_policy_invalid");
}

/** Caller has already reserved capacity. Re-evaluate this against current consent before dispatch. */
export function evaluateDeliveryPolicy(
  request: DeliveryRequested,
  consent: DeliveryConsent | undefined,
  now: Date,
): DeliveryDecision {
  if (!Number.isFinite(now.getTime())) throw new DeliveryRefusedError("delivery_policy_invalid");
  const decision = (
    status: DeliveryDecision["status"],
    reason: DeliveryDecision["reason"],
    effectiveUrgency: DeliveryDecision["effectiveUrgency"] = request.urgency,
  ): DeliveryDecision => ({ status, reason, effectiveUrgency });
  if (request.policyVersion !== "delivery-policy-v1") return decision("rejected", "policy_changed");
  // A solicited reply spends the committed Talk turn's one-response allowance.
  // Persistence verifies that provenance before this policy can approve it.
  if (request.reason.kind === "response") return decision("approved", "allowed");
  if (!consent?.enabled) return decision("rejected", "consent_required");
  if (request.consentVersion !== consent.version) return decision("rejected", "consent_changed");
  const quiet = consent.quietHours;
  if (quiet !== null && quiet.startMinute !== quiet.endMinute) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: consent.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const local =
      Number(parts.find((v) => v.type === "hour")!.value) * 60 +
      Number(parts.find((v) => v.type === "minute")!.value);
    const inQuiet =
      quiet.startMinute < quiet.endMinute
        ? local >= quiet.startMinute && local < quiet.endMinute
        : local >= quiet.startMinute || local < quiet.endMinute;
    if (inQuiet) {
      if (request.quietHoursBehavior === "silent")
        return decision("downgraded", "quiet_hours", "silent");
      return decision(
        request.quietHoursBehavior === "reject" ? "rejected" : "delayed",
        "quiet_hours",
      );
    }
  }
  return decision("approved", "allowed");
}
