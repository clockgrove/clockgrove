import type { BrowserScope } from "./browser-protocol.js";
import type { ConversationChannel } from "./channels.js";
import type { PrincipalId } from "./ids.js";

/** Private actor-to-person delivery. Public Say never becomes a private notification implicitly. */
export interface DeliveryRequested {
  readonly type: "DeliveryRequested";
  readonly version: 1;
  readonly scope: BrowserScope;
  readonly actorId: string;
  readonly sessionId: string;
  readonly recipientPrincipalId: PrincipalId;
  readonly channelBinding: { readonly channel: ConversationChannel; readonly threadId: string };
  readonly reason: {
    readonly kind: "event" | "goal" | "promise" | "subscription";
    readonly id: string;
  };
  readonly urgency: "normal" | "urgent";
  readonly contentArtifactId: string;
  readonly privacyClass: "conversation";
  readonly consentVersion: number;
  readonly policyVersion: "delivery-policy-v1";
  readonly dedupeKey: string;
  readonly quietHoursBehavior: "delay" | "silent" | "reject";
  readonly budgetReservation: { readonly id: string; readonly units: number };
}

/** One mutable preference per recipient/canonical actor/world timeline; budget never resets. */
export interface DeliveryConsent {
  readonly enabled: boolean;
  readonly timezone: string;
  /** Equal start/end disables the interval; boundaries are local minutes since midnight. */
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  /** Decision: message units are recipient-authorized lifetime capacity, not money. */
  readonly budgetLimit: number;
  readonly version: number;
  readonly reservedUnits: number;
}

export interface DeliveryDecision {
  readonly status: "approved" | "delayed" | "downgraded" | "rejected";
  readonly reason:
    | "allowed"
    | "quiet_hours"
    | "consent_required"
    | "consent_changed"
    | "policy_changed"
    | "budget_exhausted";
  readonly effectiveUrgency: "normal" | "urgent" | "silent";
}

export interface DeliveryReceipt extends DeliveryDecision {
  readonly request: DeliveryRequested;
  readonly evaluatedAt: string;
  readonly reservedUnits: number;
  readonly sink: "fake" | "preview" | null;
}

export interface DeliveryResult {
  readonly disposition: "recorded" | "deduplicated";
  readonly receipt: DeliveryReceipt;
}
