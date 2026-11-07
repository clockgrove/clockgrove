import type { DispatchSettlement } from "@clockgrove/application";
import {
  installAuthorization,
  PostgreSqlDispatchStore,
  PostgreSqlJournal,
} from "@clockgrove/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authorization,
  type Category,
  type JournalDatabase,
  journalRequest,
  openJournalDatabase,
  run,
  type Side,
} from "./journal-request.js";

const PUBLIC: Category[] = ["public_scene"];
const BOTH: Category[] = ["public_scene", "conversation"];
const HOUR_MS = 3_600_000;

// One database serves the four tests, in order; each leaves no due dispatch behind.
let db: JournalDatabase;
let first: JournalDatabase["clients"][number];
let journal: PostgreSqlJournal;
let store: PostgreSqlDispatchStore;

beforeAll(async () => {
  db = await openJournalDatabase(2);
  first = db.clients[0]!;
  journal = new PostgreSqlJournal(first);
  store = new PostgreSqlDispatchStore(db.clients[1]!);
}, 60_000);

afterAll(() => db?.close());

describe("dispatch claims and leases in PostgreSQL", () => {
  it("concurrent claims on two connections return disjoint rows", async () => {
    await seed("a", ["c1", "c2", "c3", "c4"], "public_scene");
    // The first connection holds its claim open; SKIP LOCKED lets the second claim pass its rows.
    await first.query("BEGIN");
    await installAuthorization(first, authorization("a", BOTH) as never);
    const held = await first.query(
      "SELECT dispatch_id FROM clockgrove.claim_dispatches('world-reactions', 2, 'holder-1', 60000)",
    );
    const other = await claim("a", BOTH);
    await first.query("COMMIT");
    expect(held.rows.map((row) => (row as { dispatch_id: string }).dispatch_id)).toEqual([
      "dispatch-c1-j-a",
      "dispatch-c2-j-a",
    ]);
    expect(other.map((item) => item.dispatchId)).toEqual(["dispatch-c3-j-a", "dispatch-c4-j-a"]);
    for (const name of ["c1", "c2", "c3", "c4"]) {
      expect(
        await settle("a", BOTH, {
          dispatchId: `dispatch-${name}-j-a`,
          attempt: 1,
          outcome: "delivered",
        }),
      ).toBe(true);
    }
  });

  it("an expired lease (leaseMs 0) is reclaimed with attempt+1, and the stale attempt cannot settle", async () => {
    await seed("a", ["lease"], "public_scene");
    const [stale] = await claim("a", PUBLIC, 0);
    expect(stale).toMatchObject({
      dispatchId: "dispatch-lease-j-a",
      attempt: 1,
      correlationId: "correlation-lease",
    });
    expect((await claim("a", PUBLIC))[0]).toMatchObject({
      dispatchId: "dispatch-lease-j-a",
      attempt: 2,
    });
    expect(
      await settle("a", PUBLIC, {
        dispatchId: "dispatch-lease-j-a",
        attempt: 1,
        outcome: "delivered",
      }),
    ).toBe(false);
    expect(await statuses("lease")).toBe("dispatch-lease-j-a:leased:2");
    expect(
      await settle("a", PUBLIC, {
        dispatchId: "dispatch-lease-j-a",
        attempt: 2,
        outcome: "delivered",
      }),
    ).toBe(true);
    // A settled dispatch stays settled, even at its current attempt.
    const late = {
      attempt: 2,
      outcome: "retry",
      errorClass: "retryable",
      retryAfterMs: 0,
    } as const;
    expect(await settle("a", PUBLIC, { ...late, dispatchId: "dispatch-lease-j-a" })).toBe(false);
    expect(await statuses("lease")).toBe("dispatch-lease-j-a:delivered:2");
  });

  it("retry returns the row to pending after backoff; delivered and failed are terminal and never reclaimed", async () => {
    await seed("a", ["soon", "later", "broken"], "public_scene");
    expect(await claim("a", PUBLIC, 0)).toHaveLength(3);
    const retry = { attempt: 1, outcome: "retry", errorClass: "retryable" } as const;
    expect(
      await settle("a", PUBLIC, { ...retry, dispatchId: "dispatch-soon-j-a", retryAfterMs: 0 }),
    ).toBe(true);
    expect(
      await settle("a", PUBLIC, {
        ...retry,
        dispatchId: "dispatch-later-j-a",
        retryAfterMs: HOUR_MS,
      }),
    ).toBe(true);
    const failed = {
      dispatchId: "dispatch-broken-j-a",
      attempt: 1,
      outcome: "failed",
      errorClass: "permanent",
    } as const;
    expect(await settle("a", PUBLIC, failed)).toBe(true);
    // The expired 0 ms lease would make every row due; only the retry past its backoff is.
    const again = await claim("a", PUBLIC, 0);
    expect(again.map((item) => [item.dispatchId, item.attempt])).toEqual([
      ["dispatch-soon-j-a", 2],
    ]);
    expect(
      await settle("a", PUBLIC, {
        dispatchId: "dispatch-soon-j-a",
        attempt: 2,
        outcome: "delivered",
      }),
    ).toBe(true);
    expect(await claim("a", PUBLIC, 0)).toEqual([]);
    expect(await statuses("broken", "later", "soon")).toBe(
      "dispatch-broken-j-a:failed:1|dispatch-later-j-a:pending:1|dispatch-soon-j-a:delivered:2",
    );
  });

  it("another tenant or a lower privacy ceiling claims nothing", async () => {
    await seed("a", ["secret"], "conversation");
    await seed("b", ["other"], "public_scene");
    expect((await claim("b", BOTH, 0)).map((item) => item.dispatchId)).toEqual([
      "dispatch-other-j-b",
    ]);
    expect(await claim("a", PUBLIC, 0)).toEqual([]);
    const [secret] = await claim("a", ["conversation"]);
    expect(secret).toMatchObject({
      dispatchId: "dispatch-secret-j-a",
      privacyClass: "conversation",
    });
    const delivered = {
      dispatchId: "dispatch-secret-j-a",
      attempt: 1,
      outcome: "delivered",
    } as const;
    expect(await settle("b", BOTH, delivered)).toBe(false);
    expect(await settle("a", PUBLIC, delivered)).toBe(false);
    expect(await statuses("secret")).toBe("dispatch-secret-j-a:leased:1");
  });
});

async function seed(side: Side, names: string[], privacyClass: Category): Promise<void> {
  for (const name of names) await run(journal, journalRequest(side, name, privacyClass, BOTH));
}

function claim(side: Side, ceiling: Category[], leaseMs = HOUR_MS) {
  const request = {
    channel: "world-reactions",
    limit: 10,
    leaseOwner: "holder-2",
    leaseMs,
  } as const;
  return store.claim({ ...request, authorization: authorization(side, ceiling) as never });
}

function settle(side: Side, ceiling: Category[], settlement: DispatchSettlement) {
  return store.settle(authorization(side, ceiling) as never, settlement);
}

/** `dispatch_id:status:attempts` of the named tenant A dispatches, as the admin sees them. */
function statuses(...names: string[]): Promise<string> {
  const ids = names.map((name) => `'dispatch-${name}-j-a'`).join(", ");
  return db.truth(
    `SELECT string_agg(concat_ws(':', dispatch_id, status, attempts), '|' ORDER BY dispatch_id)
       FROM clockgrove.event_dispatches WHERE tenant_id = 'tenant-j-a' AND dispatch_id IN (${ids})`,
  );
}
