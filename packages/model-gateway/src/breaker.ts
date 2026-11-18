/**
 * Per-route circuit breaker. Decision: 3 consecutive retryable failures open it, because one or two
 * are ordinary provider noise; after 30 s one trial call is let through (half-open).
 */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 30_000;

export type RecordedBreakerState = "closed" | "open" | "half_open";

/** One change of the breaker's recorded state, caused by the call that holds the ticket. */
export interface BreakerMove {
  readonly from: RecordedBreakerState;
  readonly to: RecordedBreakerState;
  readonly consecutiveFailures: number;
}

/** One admitted call's hold on the breaker; only the ticket of the admitted trial ends the trial. */
export interface BreakerTicket {
  readonly trial: boolean;
}

export class RouteBreaker {
  consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trial: BreakerTicket | null = null;

  /** Whether calls are admitted now: the cooldown makes an open breaker half-open (a trial is due). */
  state(now: number): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return now - this.openedAt >= BREAKER_COOLDOWN_MS ? "half_open" : "open";
  }

  /**
   * The state the breaker's record follows: half-open only while an admitted trial is in flight, so
   * each `open>half_open` is answered by that trial's own end, and an elapsed cooldown alone moves
   * nothing.
   */
  private recorded(): RecordedBreakerState {
    if (this.openedAt === null) return "closed";
    return this.trial === null ? "open" : "half_open";
  }

  private change(apply: () => void): BreakerMove | undefined {
    const from = this.recorded();
    apply();
    const to = this.recorded();
    return from === to ? undefined : { from, to, consecutiveFailures: this.consecutiveFailures };
  }

  /** A ticket when a call may use this route now; a half-open breaker admits one trial at a time. */
  admit(now: number): { readonly ticket: BreakerTicket; readonly move?: BreakerMove } | undefined {
    const state = this.state(now);
    if (state === "closed") return { ticket: { trial: false } };
    if (state === "open" || this.trial !== null) return undefined;
    const ticket: BreakerTicket = { trial: true };
    const move = this.change(() => {
      this.trial = ticket;
    });
    return move === undefined ? { ticket } : { ticket, move };
  }

  /** Any success closes the breaker, a trial's or a call admitted before it opened. */
  succeeded(_ticket: BreakerTicket): BreakerMove | undefined {
    return this.change(() => {
      this.consecutiveFailures = 0;
      this.openedAt = null;
      this.trial = null;
    });
  }

  failed(now: number, ticket: BreakerTicket): BreakerMove | undefined {
    return this.change(() => {
      this.consecutiveFailures += 1;
      const isTrial = this.trial === ticket;
      if (isTrial || this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) this.openedAt = now;
      if (isTrial) this.trial = null;
    });
  }

  /**
   * A call that ended without a verdict on the route (refusal, cancellation, bad output). An
   * abandoned trial returns the breaker to open, and the next call may try again at once.
   */
  released(ticket: BreakerTicket): BreakerMove | undefined {
    return this.change(() => {
      if (this.trial === ticket) this.trial = null;
    });
  }
}
