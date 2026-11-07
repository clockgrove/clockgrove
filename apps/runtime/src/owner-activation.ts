import {
  type RuntimeMetricPoint,
  type RuntimeMetrics,
  recordMetric,
} from "@clockgrove/application";
import type { PostgreSqlClient } from "@clockgrove/persistence";
import type { OwnerMailboxEntry } from "./mailbox.js";
import type { RuntimeScope } from "./types.js";

/** The bounds of one alarm or catch-up activation's due-work batch (Wave 3 §19). */
export interface OwnerActivationBudget {
  /** Due-work command attempts it may start. */
  readonly maxCommands: number;
  /** Milliseconds after the activation began after which it starts no further attempt. */
  readonly startWithinMs: number;
}

/**
 * Decision: about 75 ms per kernel call was measured in issue 663, so four attempts started
 * within 250 ms keep one activation near a third of a second. The load curves (issue 851,
 * `pnpm run qualify:wave3:load-curves`, docs/runbooks/runtime.md "Runtime budgets and load curves")
 * keep both: four due-work commands took 166 to 258 ms locally, so `maxCommands` stops a lone
 * world's batch (from 5 overdue advances on), and `startWithinMs`, which four commands nearly reach,
 * stops some batches and steps at a point that varies from run to run: 4 worlds waking together in
 * most runs, 2 in some, and a lone world's batch in a few.
 */
export const OWNER_ACTIVATION_BUDGET: OwnerActivationBudget = Object.freeze({
  maxCommands: 4,
  startWithinMs: 250,
});

/**
 * The resource counters of one owner activation: the work of one admitted mailbox entry (Wave 3
 * §19, §20). It forwards every point that work records to the sink and tallies the world-command
 * transactions among them; the entry's connections count the statements they send. Nothing is read
 * or written to measure them.
 */
export class OwnerActivation implements RuntimeMetrics {
  /** World-command transactions that ran to a result, and the autonomous ones (advances) among them. */
  commands = 0;
  advances = 0;
  /** Their summed transaction time and the events they wrote. */
  journalMs = 0;
  events = 0;
  /** Explicit transactions (by their opening `BEGIN`) and statements sent. */
  transactions = 0;
  statements = 0;

  /** `scope` is the entry's world; an alarm learns it inside its work. */
  constructor(
    private readonly sink: RuntimeMetrics,
    public scope: RuntimeScope | undefined,
  ) {}

  record(point: RuntimeMetricPoint): void {
    if (point.name === "journal_latency_ms") {
      this.commands += 1;
      if (point.label === "autonomous") this.advances += 1;
      this.journalMs += point.value;
    } else if (point.name === "command_events_written") this.events += point.value;
    recordMetric(this.sink, point);
  }

  /** `client`, counting what it sends. */
  counted(client: PostgreSqlClient): PostgreSqlClient {
    return {
      query: (text, values) => {
        this.statements += 1;
        if (/^\s*BEGIN\b/iu.test(text)) this.transactions += 1;
        return client.query(text, values);
      },
    };
  }

  /** The entry's mailbox and resource points once its work settles; none without a known scope. */
  settle(entry: OwnerMailboxEntry): void {
    const { scope } = this;
    if (scope === undefined || entry.startedAt === null) return;
    const point = { tenantId: scope.tenantId, worldId: scope.worldId, label: entry.kind };
    const { startedAt } = entry;
    recordMetric(this.sink, {
      ...point,
      name: "mailbox_wait_ms",
      value: startedAt - entry.enqueuedAt,
    });
    recordMetric(this.sink, {
      ...point,
      name: "mailbox_service_ms",
      value: Date.now() - startedAt,
    });
    recordMetric(this.sink, {
      ...point,
      name: "activation_commands",
      value: this.commands,
      count: this.advances,
    });
    recordMetric(this.sink, {
      ...point,
      name: "activation_journal_ms",
      value: this.journalMs,
      count: this.events,
    });
    recordMetric(this.sink, {
      ...point,
      name: "activation_db_transactions",
      value: this.transactions,
      count: this.statements,
    });
  }
}
