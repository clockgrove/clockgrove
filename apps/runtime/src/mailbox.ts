/**
 * A physical owner's application mailbox (Wave 3 plan §8): one FIFO lane, initially one per
 * SpaceDO. A Durable Object runs one event at a time but interleaves at every await, so the owner
 * serializes its physical work here. Mailbox order is admission order only; PostgreSQL assigns
 * canonical order when the journal commits. Its state is runtime state (§7.2): held in memory,
 * never persisted and never world truth.
 */

import type { RuntimeScope } from "./types.js";

/** The bounds of one owner mailbox, read on every admission. */
export interface OwnerMailboxBounds {
  /** Entries admitted and not yet settled, the active one included. A request beyond it is refused. */
  readonly maxDepth: number;
  /** Milliseconds from enqueue within which a request entry must start and answer. */
  readonly requestDeadlineMs: number;
  /** The retry hint, in seconds, of every mailbox refusal. */
  readonly retryAfterSeconds: number;
}

/**
 * Decisions, measured by the Wave 3 load curves (issue 851, `pnpm run qualify:wave3:load-curves`;
 * docs/runbooks/runtime.md "Runtime budgets and load curves"), which keep them. Locally a command
 * served in 41 to 43 ms (p50), so a full mailbox of 32 drains in about 1.5 s.
 * - `requestDeadlineMs` 30 s, decision: the same 30 s as one kernel call's idle bound
 *   (`WORLD_COMMAND_TIMEOUTS.idleInTransactionTimeoutMs` in `@clockgrove/persistence`, itself the
 *   Workers default CPU limit of one invocation). That bound covers one kernel call, not a whole
 *   entry: an entry also waits in the queue, and its statements (10 s each), lock waits (3 s each)
 *   and inline overdue steps add to it, so a slow but healthy command can outlast 30 s. Such an
 *   entry is answered `owner_mailbox_timeout` and runs on, so its caller loses only a retry.
 *   Measured: the oldest entry of a full mailbox waited 1.4 to 1.7 s.
 * - `maxDepth` 32, decision: a client command runs at most 8 overdue steps inline
 *   (`OVERDUE_DEADLINE_LIMIT`, 280 to 419 ms measured), so 32 such entries drain in under 14 s,
 *   well inside the deadline. A deeper queue would mostly admit entries that expire waiting.
 *   Measured: a burst of 32 concurrent clients fills it unrefused; 48, the next level, is refused.
 * - `retryAfterSeconds` 1, decision: the hint `world_catching_up` already gives (`worker.ts`).
 *   Measured: a full mailbox frees about 24 entries a second.
 */
export const SPACE_MAILBOX_BOUNDS: OwnerMailboxBounds = Object.freeze({
  maxDepth: 32,
  requestDeadlineMs: 30_000,
  retryAfterSeconds: 1,
});

export type OwnerMailboxEntryKind =
  | "command"
  | "resume"
  | "inspect"
  | "alarm"
  | "reconcile-alarm"
  | "catch-up";

/**
 * Clock work is admitted at any depth and has no deadline: one native alarm and one Workflow step at
 * a time bound it, each with its provider's own retry, and refusing it would stall the clock.
 */
const CLOCK_WORK: ReadonlySet<OwnerMailboxEntryKind> = new Set([
  "alarm",
  "reconcile-alarm",
  "catch-up",
]);

/**
 * What an entry serves: a client command carries its scope, command, request and correlation IDs
 * and route epoch; resume and inspection their scope, request and correlation IDs; catch-up its
 * Workflow run; alarm work only its kind (one at a time, its scope read inside the entry).
 */
export interface OwnerMailboxRequest {
  readonly kind: OwnerMailboxEntryKind;
  readonly scope?: RuntimeScope;
  readonly commandId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly routeEpoch?: bigint;
}

export interface OwnerMailboxEntry extends OwnerMailboxRequest {
  readonly enqueueOrder: number;
  readonly enqueuedAt: number;
  /** Null for clock work. */
  readonly deadlineAt: number | null;
  readonly startedAt: number | null;
}

export interface OwnerMailboxState {
  readonly depth: number;
  readonly oldestEntryAgeMs: number;
  readonly active: OwnerMailboxEntry | null;
  readonly admission: "open" | "full";
}

export type OwnerMailboxRefusal =
  | "owner_mailbox_full"
  | "owner_mailbox_expired"
  | "owner_mailbox_timeout";

/**
 * A request the mailbox answered without its result. Each is retryable with the same accepted bytes:
 * - `owner_mailbox_full`: refused before enqueue; nothing ran.
 * - `owner_mailbox_expired`: its deadline passed while it waited; dropped unstarted, nothing ran.
 * - `owner_mailbox_timeout`: its deadline passed after it started. It keeps its place, runs on and
 *   may commit, so this never reports failure: the exact retry returns the stored receipt.
 */
export class OwnerMailboxError extends Error {
  constructor(
    readonly code: OwnerMailboxRefusal,
    readonly retryAfterSeconds: number,
  ) {
    super(`owner mailbox refused: ${code}`);
    this.name = "OwnerMailboxError";
  }
}

interface Slot {
  entry: OwnerMailboxEntry;
  readonly operation: (entry: OwnerMailboxEntry) => Promise<unknown>;
  readonly answer: PromiseWithResolvers<unknown>;
  readonly retryAfterSeconds: number;
  answered: boolean;
  timer?: ReturnType<typeof setTimeout>;
  work?: Promise<unknown>;
}

export interface OwnerMailboxOptions {
  readonly bounds: () => OwnerMailboxBounds;
  /**
   * Sees every operation failure (the owner-generation reset). `abandoned` is true when the caller
   * was already answered `owner_mailbox_timeout`, so the failure reached no caller and the owner
   * must log it.
   */
  readonly failed: (error: unknown, entry: OwnerMailboxEntry, abandoned: boolean) => void;
  /** Keeps the owner alive for started work whose caller was already answered. */
  readonly retain: (work: Promise<unknown>) => void;
}

export class OwnerMailbox {
  private readonly queued: Slot[] = [];
  private active: Slot | undefined;
  private enqueued = 0;

  constructor(private readonly options: OwnerMailboxOptions) {}

  /**
   * Admits after the caller's authorization (§8); refuses a request beyond the depth bound. The
   * operation receives its entry as it starts, with its enqueue and start times.
   */
  admit<T>(
    request: OwnerMailboxRequest,
    operation: (entry: OwnerMailboxEntry) => Promise<T>,
  ): Promise<T> {
    const bounds = this.options.bounds();
    const clockWork = CLOCK_WORK.has(request.kind);
    if (!clockWork && this.depth >= bounds.maxDepth)
      return Promise.reject(new OwnerMailboxError("owner_mailbox_full", bounds.retryAfterSeconds));
    const now = Date.now();
    const slot: Slot = {
      entry: {
        ...request,
        enqueueOrder: ++this.enqueued,
        enqueuedAt: now,
        deadlineAt: clockWork ? null : now + bounds.requestDeadlineMs,
        startedAt: null,
      },
      operation,
      answer: Promise.withResolvers(),
      retryAfterSeconds: bounds.retryAfterSeconds,
      answered: false,
    };
    if (!clockWork) slot.timer = setTimeout(() => this.expire(slot), bounds.requestDeadlineMs);
    this.queued.push(slot);
    this.pump();
    return slot.answer.promise as Promise<T>;
  }

  state(): OwnerMailboxState {
    // FIFO: the active entry was enqueued before every waiting one.
    const oldest = this.active ?? this.queued[0];
    return {
      depth: this.depth,
      oldestEntryAgeMs: oldest === undefined ? 0 : Date.now() - oldest.entry.enqueuedAt,
      active: this.active?.entry ?? null,
      admission: this.depth >= this.options.bounds().maxDepth ? "full" : "open",
    };
  }

  private get depth(): number {
    return this.queued.length + (this.active === undefined ? 0 : 1);
  }

  private pump(): void {
    while (this.active === undefined) {
      const slot = this.queued.shift();
      if (slot === undefined) return;
      const { deadlineAt } = slot.entry;
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        clearTimeout(slot.timer);
        this.refuse(slot, "owner_mailbox_expired");
        continue;
      }
      this.active = slot;
      const entry = { ...slot.entry, startedAt: Date.now() };
      slot.entry = entry;
      // A later microtask, as the former promise chain; a synchronous throw becomes a rejection.
      const work = Promise.resolve().then(() => slot.operation(entry));
      slot.work = work;
      work.then(
        (value) => this.finish(slot, () => slot.answer.resolve(value)),
        (error: unknown) => {
          const abandoned = slot.answered;
          this.finish(slot, () => slot.answer.reject(error));
          this.options.failed(error, slot.entry, abandoned);
        },
      );
    }
  }

  /** Settles the active entry and starts the next: a failed or cancelled entry strands nothing. */
  private finish(slot: Slot, answer: () => void): void {
    clearTimeout(slot.timer);
    this.active = undefined;
    if (!slot.answered) {
      slot.answered = true;
      answer();
    }
    this.pump();
  }

  private expire(slot: Slot): void {
    const waiting = this.queued.indexOf(slot);
    if (waiting >= 0) {
      this.queued.splice(waiting, 1);
      this.refuse(slot, "owner_mailbox_expired");
    } else if (this.active === slot && slot.work !== undefined) {
      // Started: it keeps the lane until it settles, so commit order is unchanged.
      this.options.retain(slot.work);
      this.refuse(slot, "owner_mailbox_timeout");
    }
  }

  private refuse(slot: Slot, code: OwnerMailboxRefusal): void {
    if (slot.answered) return;
    slot.answered = true;
    slot.answer.reject(new OwnerMailboxError(code, slot.retryAfterSeconds));
  }
}
