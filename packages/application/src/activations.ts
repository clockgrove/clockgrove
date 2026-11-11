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
}

export interface ActivationPolicy {
  readonly allowModel: boolean;
  /** Lifetime model opportunities, shared by every configuration of this actor. */
  readonly modelBudget: number;
}

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
