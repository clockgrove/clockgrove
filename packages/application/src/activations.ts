import type { BrowserScope } from "@clockgrove/contracts";
import type { ConversationParticipant } from "./conversations.js";

export type ActivationReason =
  | { readonly kind: "scheduled_intention"; readonly scheduleId: string }
  | { readonly kind: "subscription"; readonly subscriptionId: string; readonly eventId: string }
  | { readonly kind: "perception"; readonly perceptionId: string }
  | { readonly kind: "threshold"; readonly conditionId: string }
  | { readonly kind: "heartbeat"; readonly heartbeatId: string }
  | { readonly kind: "tool_completed"; readonly effectId: string }
  | { readonly kind: "operator"; readonly commandId: string };

export interface ActivationDeliveryIntent {
  readonly urgency: "normal" | "urgent";
  readonly quietHoursBehavior: "delay" | "silent" | "reject";
}

export interface ActivationConfiguration {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ActivationReason["kind"];
  readonly nextWakeAt: number | null;
  readonly intervalMs: number | null;
  readonly eventType?: string;
  readonly input: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly compiledRoutine: "noop" | "escalate";
  readonly delivery?: ActivationDeliveryIntent;
  /** Present when the actor made it through its own capability (issue 322); operators keep it. */
  readonly origin?: "actor";
}

export interface ActivationPolicy {
  readonly allowModel: boolean;
  /** Lifetime model opportunities, shared by every configuration of this actor. */
  readonly modelBudget: number;
  /**
   * Registry capabilities revoked for this actor (issue 322): its proposals of them are refused
   * `revoked`. Omitted on configure, the stored list is kept.
   */
  readonly revokedCapabilities?: readonly string[];
}

/** Decision (issue 322): at most 32 revoked capability names per actor. */
export const MAX_REVOKED_CAPABILITIES = 32;

export interface ActorActivation {
  readonly activationId: string;
  readonly causalRoot: string;
  readonly configurationId: string;
  readonly reason: ActivationReason;
  readonly evidence: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly input: string;
  readonly status: "pending" | "completed" | "noop" | "deferred";
  readonly outcome: string;
  readonly principalId: string;
  readonly delivery?: ActivationDeliveryIntent;
}

export interface ActivationInspection {
  readonly configurations: readonly ActivationConfiguration[];
  readonly activations: readonly ActorActivation[];
  readonly policy: ActivationPolicy;
  readonly modelCallsReserved: number;
  readonly nextWakeAt: number | null;
  /**
   * The internal capability grants the actor holds through the requesting member, each marked when
   * the actor's canonical policy revokes it (issue 323). Present only for an operator.
   */
  readonly grants?: readonly InternalGrantView[];
  /**
   * Present with `grants`: whether the requesting operator owns the actor's policy (or none exists
   * yet). When false, `policy` and `modelCallsReserved` are not the actor's and its configure is
   * refused, so a view shows neither the budget nor a revoke control.
   */
  readonly policyOwned?: boolean;
}

/** One internal grant as an operator sees it: the registry's definition and the grant's budget. */
export interface InternalGrantView {
  readonly capability: string;
  readonly effect: string;
  readonly callsPerTurn: number;
  readonly commandTypes?: readonly string[];
  readonly revoked: boolean;
}

export interface ActivationWake {
  readonly configurationId: string;
  readonly causalRoot: string;
  readonly reason: ActivationReason;
  readonly evidence: string;
}

export interface ActivationAddress {
  readonly scope: BrowserScope;
  readonly actorId: string;
  readonly participant: ConversationParticipant;
}
