import type {
  CorrelationId,
  EventId,
  PrivacyClass,
  QueueChannel,
  QueueEnvelope,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

import type { JournalExecuteResult, JournalPostCommitNotifier } from "./journal.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

/** `retryable` failures may succeed on a later attempt; `permanent` ones never will. */
export type DispatchErrorClass = "retryable" | "permanent";

export interface DispatchClaimRequest {
  readonly authorization: RuntimeAuthorizationContext;
  readonly channel: QueueChannel;
  /** At most this many due dispatches are claimed. */
  readonly limit: number;
  /** Who holds the lease, for diagnosis. The attempt number, not the owner, fences settlement. */
  readonly leaseOwner: string;
  /** The lease length. Once it expires, another claim may take the dispatch with the next attempt. */
  readonly leaseMs: number;
}

/** A dispatch leased to one holder until its lease expires. */
export interface ClaimedDispatch {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly dispatchId: string;
  readonly eventId: EventId;
  readonly channel: QueueChannel;
  /** The fencing token: only a settlement naming this attempt can settle the claim. */
  readonly attempt: number;
  readonly privacyClass: PrivacyClass;
  readonly payload: unknown;
  /** The correlation ID of the source event. */
  readonly correlationId: CorrelationId;
}

export type DispatchSettlement =
  | Readonly<{ dispatchId: string; attempt: number; outcome: "delivered" }>
  | Readonly<{
      dispatchId: string;
      attempt: number;
      outcome: "retry";
      errorClass: DispatchErrorClass;
      /** The dispatch becomes due again after this delay. */
      retryAfterMs: number;
    }>
  | Readonly<{
      dispatchId: string;
      attempt: number;
      outcome: "failed";
      errorClass: DispatchErrorClass;
    }>;

/**
 * Claims and settles durable dispatch intent. Claims are disjoint across concurrent callers; a
 * dispatch whose lease expired is claimable again with the next attempt number.
 */
export interface DispatchStore {
  /** Leases due dispatches of the channel, oldest due first. */
  claim(request: DispatchClaimRequest): Promise<readonly ClaimedDispatch[]>;
  /**
   * Settles a claim. Returns false, and changes nothing, unless the dispatch is still leased at
   * exactly `settlement.attempt`.
   */
  settle(
    authorization: RuntimeAuthorizationContext,
    settlement: DispatchSettlement,
  ): Promise<boolean>;
}

/** Publishes one dispatch message. Delivery is at least once: consumers dedupe on `messageId`. */
export interface DispatchPublisher {
  publish(message: QueueEnvelope<unknown>): Promise<void>;
}

export interface DispatchSweepRequest extends DispatchClaimRequest {
  /** A publish failure on this attempt or later settles the dispatch as failed. */
  readonly maxAttempts: number;
  /** A failed publish below `maxAttempts` makes the dispatch due again after this initial delay, doubled per attempt and capped at one day. */
  readonly retryAfterMs: number;
}

export interface DispatchSweepPorts {
  readonly store: DispatchStore;
  readonly publisher: DispatchPublisher;
  /**
   * Told of each dispatch this sweep settled `failed`, with the publish error: the terminal failure
   * an operator recovers. Never throws into the sweep.
   */
  readonly failed?: (dispatch: ClaimedDispatch, cause: unknown) => void;
}

export interface DispatchSweepResult {
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  /** Settlements refused because the claim was lost to a newer attempt. */
  readonly stale: number;
}

/** The queue message of a claimed dispatch; a republish of the same dispatch has the same `messageId`. */
export function dispatchMessage(dispatch: ClaimedDispatch): QueueEnvelope<unknown> {
  return {
    schemaVersion: 2,
    messageId: dispatch.dispatchId,
    channel: dispatch.channel,
    tenantId: dispatch.tenantId,
    worldId: dispatch.worldId,
    timelineId: dispatch.timelineId,
    sourceEventId: dispatch.eventId,
    correlationId: dispatch.correlationId,
    attemptHint: dispatch.attempt,
    payload: dispatch.payload,
  };
}

/**
 * Claims, publishes and settles due dispatches of one tenant's channel until none is due. A crash
 * between publish and settle leaves the claim to expire; the next sweep republishes it under the
 * same `messageId`. A store failure ends the sweep and is thrown.
 */
export async function sweepDispatches(
  request: DispatchSweepRequest,
  { store, publisher, failed }: DispatchSweepPorts,
): Promise<DispatchSweepResult> {
  const counts = { delivered: 0, retried: 0, failed: 0, stale: 0 };
  for (;;) {
    const claimed = await store.claim(request);
    if (claimed.length === 0) return counts;
    for (const dispatch of claimed) {
      const base = { dispatchId: dispatch.dispatchId, attempt: dispatch.attempt };
      let settlement: DispatchSettlement;
      let cause: unknown;
      try {
        await publisher.publish(dispatchMessage(dispatch));
        settlement = { ...base, outcome: "delivered" };
      } catch (error) {
        cause = error;
        settlement =
          dispatch.attempt >= request.maxAttempts
            ? { ...base, outcome: "failed", errorClass: "retryable" }
            : {
                ...base,
                outcome: "retry",
                errorClass: "retryable",
                // Same one-day ceiling as the persistence lease/retry boundary.
                retryAfterMs:
                  request.retryAfterMs === 0
                    ? 0
                    : Math.min(86_400_000, request.retryAfterMs * 2 ** (dispatch.attempt - 1)),
              };
      }
      if (!(await store.settle(request.authorization, settlement))) counts.stale += 1;
      else if (settlement.outcome === "delivered") counts.delivered += 1;
      else if (settlement.outcome === "retry") counts.retried += 1;
      else {
        counts.failed += 1;
        try {
          failed?.(dispatch, cause);
        } catch {
          /* An alert sink never stops the sweep. */
        }
      }
    }
  }
}

/**
 * A post-commit hint: a committed result with events wakes the dispatch sweep of its world. The wake
 * must only schedule work, not await it. A lost hint costs latency only, because the next sweep
 * finds the pending dispatch.
 */
export class DispatchHintNotifier implements JournalPostCommitNotifier {
  constructor(private readonly wake: (event: JournalExecuteResult["events"][number]) => unknown) {}

  async notify(result: JournalExecuteResult): Promise<void> {
    const [first] = result.events;
    if (result.outcome === "rejected" || first === undefined) return;
    await this.wake(first);
  }
}
