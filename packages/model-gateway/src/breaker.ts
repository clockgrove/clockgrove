/**
 * Per-route circuit breaker. Decision: 3 consecutive retryable failures open it, because one or two
 * are ordinary provider noise; after 30 s one trial call is let through (half-open).
 */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 30_000;

export class RouteBreaker {
  consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  state(now: number): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return now - this.openedAt >= BREAKER_COOLDOWN_MS ? "half_open" : "open";
  }

  /** Whether a call may use this route now; a half-open breaker admits one trial at a time. */
  admit(now: number): boolean {
    const state = this.state(now);
    if (state === "closed") return true;
    if (state === "open" || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  succeeded(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  failed(now: number): void {
    this.consecutiveFailures += 1;
    if (this.trialInFlight || this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      this.openedAt = now;
    }
    this.trialInFlight = false;
  }

  /** A call that ended without a verdict on the route (refusal, cancellation, bad output). */
  released(): void {
    this.trialInFlight = false;
  }
}
