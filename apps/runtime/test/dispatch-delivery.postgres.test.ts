import { DispatchHintNotifier, type DispatchStore, sweepDispatches } from "@clockgrove/application";
import type { QueueEnvelope } from "@clockgrove/contracts";
import { PostgreSqlDispatchStore, PostgreSqlJournal } from "@clockgrove/persistence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authorization,
  type JournalDatabase,
  journalRequest,
  openJournalDatabase,
  run,
} from "./journal-request.js";

let db: JournalDatabase;
let stores: PostgreSqlDispatchStore[];
const journal = (notifier?: DispatchHintNotifier, hooks = {}) =>
  new PostgreSqlJournal(db.clients[0]!, notifier, hooks);
const command = (name: string) => journalRequest("a", name, "public_scene", ["public_scene"]);
// The fake queue records every publish in order, and fails while `failing` is set.
const published: QueueEnvelope<unknown>[] = [];
const publisher = {
  failing: false,
  async publish(message: QueueEnvelope<unknown>) {
    if (this.failing) throw new Error("queue unavailable");
    published.push(message);
  },
};
const sent = () => published.map((message) => `${message.messageId}@${message.attemptHint}`);

beforeAll(async () => {
  db = await openJournalDatabase(5);
  stores = db.clients.slice(1).map((client) => new PostgreSqlDispatchStore(client));
}, 60_000);
afterAll(() => db?.close());
beforeEach(() => void (published.length = 0));

describe("committed events dispatch exactly once", () => {
  it("lost hint: nothing is published until a sweep, which publishes once; the hint path delivers immediately", async () => {
    const lostResponse = journal(undefined, {
      afterCommit: () => Promise.reject(new Error("response lost")),
    });
    await expect(run(lostResponse, command("lost-1"))).rejects.toThrow("response lost");
    await run(
      journal(new DispatchHintNotifier(() => Promise.reject(new Error("hint lost")))),
      command("lost-2"),
    );
    expect(published).toEqual([]);
    expect(await sweep()).toMatchObject({ delivered: 2 });
    expect(await sweep()).toMatchObject({ delivered: 0 });
    expect(sent()).toEqual(["dispatch-lost-1-j-a@1", "dispatch-lost-2-j-a@1"]);
    await run(journal(new DispatchHintNotifier(() => sweep())), command("hinted"));
    expect(sent().at(-1)).toBe("dispatch-hinted-j-a@1");
    expect(await statuses()).toBe("delivered:1:3");
  });

  it("duplicate sweeps: four concurrent sweeps on separate connections publish each dispatch once", async () => {
    const names = Array.from({ length: 8 }, (_, index) => `many-${index}`);
    for (const name of names) await run(journal(), command(name));
    await Promise.all(stores.map((store) => sweep(store)));
    expect(sent().sort()).toEqual(names.map((name) => `dispatch-${name}-j-a@1`).sort());
    expect(await statuses()).toBe("delivered:1:11");
  });

  it("crash after publish before settle: republished under the same messageId and delivered once", async () => {
    await run(journal(), command("crash"));
    const crashing: DispatchStore = {
      claim: (request) => stores[0]!.claim(request),
      settle: () => Promise.reject(new Error("crashed")),
    };
    await expect(sweepDispatches(sweepRequest(0), { store: crashing, publisher })).rejects.toThrow(
      "crashed",
    );
    expect(await sweep(stores[1], 0)).toMatchObject({ delivered: 1 });
    expect(sent()).toEqual(["dispatch-crash-j-a@1", "dispatch-crash-j-a@2"]);
    expect(await statuses("crash")).toBe("delivered:2:1");
  });

  it("publisher failure retries, then ends failed with last_error_class after maxAttempts", async () => {
    await run(journal(), command("flaky"));
    publisher.failing = true;
    const result = await sweep().finally(() => (publisher.failing = false));
    expect(result).toEqual({ delivered: 0, retried: 2, failed: 1, stale: 0 });
    expect(await statuses("flaky", "last_error_class")).toBe("failed:3:retryable");
  });

  it("publication retry delays double to the store ceiling before an operator-visible failure", async () => {
    await run(journal(), command("bounded-backoff"));
    const delays: number[] = [];
    const durableStore = stores[0];
    if (durableStore === undefined) throw new Error("dispatch fixture store absent");
    const store: DispatchStore = {
      claim: (request) => durableStore.claim(request),
      settle: async (authorization, settlement) => {
        if (settlement.outcome === "retry") delays.push(settlement.retryAfterMs);
        return durableStore.settle(authorization, settlement);
      },
    };
    publisher.failing = true;
    try {
      // Exponent 17 is the first 1-second doubling above the existing one-day cap;
      // the following attempt reaches this test's terminal boundary.
      for (const priorAttempt of [0, 1, 17, 18]) {
        await db.truth(
          `UPDATE clockgrove.event_dispatches SET attempts=${priorAttempt}, next_attempt_at=now() WHERE dispatch_id='dispatch-bounded-backoff-j-a'`,
        );
        await sweepDispatches(
          { ...sweepRequest(), retryAfterMs: 1_000, maxAttempts: 19 },
          { store, publisher },
        );
      }
    } finally {
      publisher.failing = false;
    }
    expect(delays).toEqual([1_000, 2_000, 86_400_000]);
    expect(await statuses("bounded-backoff", "last_error_class")).toBe("failed:19:retryable");
  });
});

function sweepRequest(leaseMs = 3_600_000) {
  const request = {
    channel: "world-reactions",
    limit: 2,
    leaseOwner: "sweeper",
    maxAttempts: 3,
    retryAfterMs: 0,
  } as const;
  return { ...request, leaseMs, authorization: authorization("a", ["public_scene"]) as never };
}

function sweep(store = stores[0]!, leaseMs?: number) {
  return sweepDispatches(sweepRequest(leaseMs), { store, publisher });
}

/** `status:attempts:<last column>` groups of tenant A's dispatches, or of one of them. */
function statuses(name?: string, last = "count(*)"): Promise<string> {
  const filter = name === undefined ? "" : `AND dispatch_id = 'dispatch-${name}-j-a'`;
  const groups = last === "count(*)" ? "status, attempts" : `status, attempts, ${last}`;
  return db.truth(
    `SELECT string_agg(concat_ws(':', status, attempts, value), '|') FROM (SELECT status, attempts, ${last} AS value
       FROM clockgrove.event_dispatches WHERE tenant_id = 'tenant-j-a' ${filter} GROUP BY ${groups}) AS grouped`,
  );
}
