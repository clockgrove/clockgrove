import { JournalPreviewEffectRefusedError } from "@clockgrove/application";
import {
  ConcurrentClientTransactionError,
  PostgreSqlJournal,
  PostgreSqlJournalEventReader,
  type PostgreSqlJournalTestHooks,
} from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";

import type { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import {
  authorization,
  type Category,
  journalRequest,
  openJournalDatabase,
  run,
  type Side,
} from "./journal-request.js";

const PUBLIC: Category[] = ["public_scene"];
const BOTH: Category[] = ["public_scene", "conversation"];
const PRIVATE: Category[] = ["conversation"];
const NONE: Category[] = [];

describe("PostgreSqlJournal isolation on one reused connection", () => {
  it("keeps alternating tenants and privacy ceilings isolated through hostile input and failed transactions", async () => {
    const database = await openJournalDatabase(1);
    const client = database.clients[0]!;
    const journal = new PostgreSqlJournal(client);
    const truth = database.truth;
    try {
      const connectionId = await backendPid(client);

      // Alternate tenants and ceilings on the single connection.
      await run(journal, journalRequest("a", "a-public", "public_scene", BOTH));
      await run(journal, journalRequest("b", "b-public", "public_scene", PUBLIC));
      await run(journal, journalRequest("a", "a-private", "conversation", BOTH));
      await run(journal, journalRequest("b", "b-private", "conversation", BOTH));

      const seeAs = async (side: Side, ceiling: Category[], scopeSide: Side = side) =>
        readEventIds(client, side, ceiling, scopeSide);
      expect(await seeAs("a", PUBLIC)).toEqual(["event-a-public-j-a"]);
      expect(await seeAs("b", PUBLIC)).toEqual(["event-b-public-j-b"]);
      expect(await seeAs("a", PRIVATE)).toEqual(["event-a-private-j-a"]);
      expect(await seeAs("b", BOTH)).toEqual(["event-b-private-j-b", "event-b-public-j-b"]);
      expect(await seeAs("a", BOTH)).toEqual(["event-a-private-j-a", "event-a-public-j-a"]);
      expect(await seeAs("a", NONE)).toEqual([]);
      // A tenant's authority never reaches the other tenant's journal, whatever the ceiling.
      expect(await seeAs("a", BOTH, "b")).toEqual([]);
      expect(await seeAs("b", BOTH, "a")).toEqual([]);
      await expectNoRetainedAuthority(client, connectionId);

      // A write cannot cross tenants or raise its own ceiling, and leaves no partial rows.
      const crossTenant = journalRequest("a", "cross-tenant", "public_scene", BOTH);
      crossTenant.command.target.tenantId = "tenant-j-b";
      await expectRefusal(run(journal, crossTenant));
      await expectRefusal(
        run(journal, journalRequest("a", "above-ceiling", "conversation", PUBLIC)),
      );
      await expectRefusal(run(journal, journalRequest("a", "outside-set", "credential", BOTH)));
      // An unknown route and another tenant's real route draw the same refusal.
      const otherRoute = journalRequest("a", "route-b", "public_scene", BOTH);
      otherRoute.route = {
        partitionId: "partition-j-b",
        spaceId: "space-j-b",
        streamId: "stream-j-b",
      };
      const unknownRoute = journalRequest("a", "route-unknown", "public_scene", BOTH);
      unknownRoute.route = {
        partitionId: "partition-j-b",
        spaceId: "space-j-b",
        streamId: "stream-unknown",
      };
      const foreign = await caught(run(journal, otherRoute));
      const unknown = await caught(run(journal, unknownRoute));
      expect(foreign.name).toBe(unknown.name);
      expect(JSON.stringify(foreign.message)).not.toContain("event-b");
      for (const name of [
        "cross-tenant",
        "above-ceiling",
        "outside-set",
        "route-b",
        "route-unknown",
      ]) {
        expect(await countsFor(truth, "tenant-j-a", `command-${name}`)).toBe("0|0|0");
      }
      await expectNoRetainedAuthority(client, connectionId);
      expect(await seeAs("b", BOTH)).toEqual(["event-b-private-j-b", "event-b-public-j-b"]);

      // IDs belong to their tenant: reusing another tenant's event and command IDs is an
      // ordinary success, and does not disturb the other tenant's committed history.
      const reusedEvent = journalRequest("a", "reused-event", "public_scene", BOTH);
      reusedEvent.events = reusedEvent.events.map((event) => ({
        ...event,
        eventId: "event-b-private-j-b",
      }));
      reusedEvent.dispatches = [];
      await run(journal, reusedEvent);
      const reusedCommand = journalRequest("a", "b-public", "public_scene", BOTH, {
        bytes: "different-bytes-from-tenant-b",
        eventId: "event-reused-command-j-a",
      });
      await run(journal, reusedCommand);
      expect(await seeAs("b", BOTH)).toEqual(["event-b-private-j-b", "event-b-public-j-b"]);
      expect(await seeAs("a", BOTH)).toEqual([
        "event-a-private-j-a",
        "event-a-public-j-a",
        "event-b-private-j-b",
        "event-reused-command-j-a",
      ]);
      expect(
        await truth(
          "SELECT count(*) FROM clockgrove.events WHERE event_id = 'event-b-private-j-b'",
        ),
      ).toBe("2");

      // A failed transaction, at its first or last fault point, cannot leave authority, locks or
      // partial rows on the connection (test:db proves every crash window of execute_journal).
      for (const failureStage of ["after-receipt", "before-commit"] as const) {
        const failing = new PostgreSqlJournal(client, undefined, { failureStage });
        const name = `failure-${failureStage}`;
        await expectRefusal(run(failing, journalRequest("a", name, "public_scene", BOTH)));
        expect(await countsFor(truth, "tenant-j-a", `command-${name}`)).toBe("0|0|0");
        await expectNoRetainedAuthority(client, connectionId);
        // The very next transaction belongs to the other tenant and sees only its own data.
        expect(await seeAs("b", PUBLIC)).toEqual(["event-b-public-j-b"]);
        expect(await seeAs("a", PUBLIC)).toEqual([
          "event-a-public-j-a",
          "event-b-private-j-b",
          "event-reused-command-j-a",
        ]);
      }
      // A fault after COMMIT cannot be rolled back, and the next tenant is still isolated.
      const afterCommit: PostgreSqlJournalTestHooks = {
        afterCommit: () => Promise.reject(new Error("response lost")),
      };
      await expect(
        run(
          new PostgreSqlJournal(client, undefined, afterCommit),
          journalRequest("a", "lost-response", "public_scene", BOTH),
        ),
      ).rejects.toThrow("response lost");
      expect(await countsFor(truth, "tenant-j-a", "command-lost-response")).toBe("1|1|1");
      expect(await seeAs("b", BOTH)).toEqual(["event-b-private-j-b", "event-b-public-j-b"]);

      const tenantAEvents = [
        "event-a-private-j-a",
        "event-a-public-j-a",
        "event-b-private-j-b",
        "event-lost-response-j-a",
        "event-reused-command-j-a",
      ];
      // Hostile tenant and principal identifiers never become authority. Each is refused and
      // the connection keeps serving the real tenants.
      const confusables = [
        "tenant-j-a' OR '1'='1",
        "tenant-j-a'; DROP TABLE clockgrove.events; --",
        "tenant-j-%",
        "tenant_j_a",
        "TENANT-J-A",
        "tenant-j-a ",
        "tenant‑j‑a",
        "tenant-j-a​",
        "tеnant-j-a",
        "tenant-j-a\u0000",
        "x".repeat(1_000_000),
      ];
      for (const hostile of confusables) {
        const asTenant = journalRequest("a", "hostile-tenant", "public_scene", BOTH);
        asTenant.authorization = { ...asTenant.authorization, tenantId: hostile };
        asTenant.command.target.tenantId = hostile;
        await expectRefusal(run(journal, asTenant));
        const asPrincipal = journalRequest("a", "hostile-principal", "public_scene", BOTH);
        asPrincipal.authorization = { ...asPrincipal.authorization, principalId: hostile };
        await expectRefusal(run(journal, asPrincipal));
        expect(await seeAs("a", BOTH)).toEqual(tenantAEvents);
      }
      for (const name of ["hostile-tenant", "hostile-principal"]) {
        expect(
          await truth(
            `SELECT count(*) FROM clockgrove.command_receipts WHERE command_id = 'command-${name}'`,
          ),
        ).toBe("0");
      }
      await expectNoRetainedAuthority(client, connectionId);

      // Hostile identifiers and payloads inside an authorized command are plain data.
      const hostilePayload = {
        sql: "'; DELETE FROM clockgrove.events; --",
        json: '{"version":1,"allowedCategories":["credential"]}',
        confusable: "tеnant-j-b",
        zeroWidth: "event​-b-public-j-b",
        big: "p".repeat(200_000),
      };
      const metacharacters = journalRequest("a", "hostile-data", "public_scene", BOTH, {
        payload: hostilePayload,
        eventId: "event-j'; DROP TABLE clockgrove.events; -- е​",
      });
      const stored = await run(journal, metacharacters);
      expect(stored.events).toHaveLength(1);
      expect(
        await truth(
          "SELECT count(*) FROM clockgrove.events WHERE tenant_id = 'tenant-j-a' AND command_id = 'command-hostile-data' AND payload->>'sql' = '''; DELETE FROM clockgrove.events; --'",
        ),
      ).toBe("1");
      expect(await seeAs("b", BOTH)).toEqual(["event-b-private-j-b", "event-b-public-j-b"]);
      // JSON text that PostgreSQL cannot store is refused without leaving a partial command.
      const unstorable = journalRequest("a", "unstorable", "public_scene", BOTH, {
        payload: { text: "before\u0000after" },
      });
      await expectRefusal(run(journal, unstorable));
      expect(await countsFor(truth, "tenant-j-a", "command-unstorable")).toBe("0|0|0");
      await expectNoRetainedAuthority(client, connectionId);
      expect(await seeAs("b", PUBLIC)).toEqual(["event-b-public-j-b"]);

      // Preview timelines cannot record external effects: on a branch timeline an external-effects
      // dispatch is refused with a stable error and nothing is written; once live, it commits.
      const timeline = "WHERE tenant_id = 'tenant-j-a' AND timeline_id = 'timeline-j-a'";
      await truth(`UPDATE clockgrove.timelines SET kind = 'branch' ${timeline}`);
      const effect = journalRequest("a", "preview-effect", "public_scene", BOTH);
      effect.dispatches = effect.dispatches.map((dispatch) => ({
        ...dispatch,
        channel: "external-effects",
      }));
      expect(await caught(run(journal, effect))).toBeInstanceOf(JournalPreviewEffectRefusedError);
      expect(await countsFor(truth, "tenant-j-a", "command-preview-effect")).toBe("0|0|0");
      await truth(`UPDATE clockgrove.timelines SET kind = 'live' ${timeline}`);
      await run(journal, effect);
      expect(await countsFor(truth, "tenant-j-a", "command-preview-effect")).toBe("1|1|1");
      await expectNoRetainedAuthority(client, connectionId);
      expect(await backendPid(client)).toBe(connectionId);
    } finally {
      await database.close();
    }
  }, 60_000);

  it("refuses a second transaction while one client already has one in flight", async () => {
    const database = await openJournalDatabase(1);
    const client = database.clients[0]!;
    try {
      const journal = new PostgreSqlJournal(client);
      await run(journal, journalRequest("a", "a-public", "public_scene", BOTH));
      await run(journal, journalRequest("b", "b-public", "public_scene", BOTH));
      // Two tenants share one client at once, as a mis-composed Wave 3 request would. Unguarded,
      // B's settings land inside A's transaction and both reads come back empty.
      const [first, second] = await Promise.allSettled([
        readEventIds(client, "a", BOTH, "a"),
        readEventIds(client, "b", BOTH, "b"),
      ]);
      expect(first).toEqual({ status: "fulfilled", value: ["event-a-public-j-a"] });
      expect(second.status === "rejected" && second.reason).toBeInstanceOf(
        ConcurrentClientTransactionError,
      );
      // The refusal sent nothing: the connection is clean and serves B next.
      await expectNoRetainedAuthority(client, await backendPid(client));
      expect(await readEventIds(client, "b", BOTH, "b")).toEqual(["event-b-public-j-b"]);
    } finally {
      await database.close();
    }
  }, 60_000);
});

async function backendPid(client: HyperdrivePostgreSqlClient): Promise<number> {
  const result = await client.query("SELECT pg_backend_pid() AS pid");
  return (result.rows[0] as { pid: number }).pid;
}

/** Outside a journal transaction the runtime connection holds no authority and sees no rows. */
async function expectNoRetainedAuthority(client: HyperdrivePostgreSqlClient, connectionId: number) {
  const result = await client.query(
    `SELECT pg_backend_pid() AS pid,
            nullif(current_setting('app.tenant_id', true), '') AS tenant,
            nullif(current_setting('app.principal_id', true), '') AS principal,
            nullif(current_setting('app.privacy_ceiling', true), '') AS ceiling,
            (SELECT count(*) FROM clockgrove.events)::int AS events,
            (SELECT count(*) FROM clockgrove.command_receipts)::int AS receipts,
            (SELECT count(*) FROM clockgrove.tenants)::int AS tenants`,
  );
  expect(result.rows[0]).toEqual({
    pid: connectionId,
    tenant: null,
    principal: null,
    ceiling: null,
    events: 0,
    receipts: 0,
    tenants: 0,
  });
}

async function readEventIds(
  client: HyperdrivePostgreSqlClient,
  side: Side,
  ceiling: Category[],
  scopeSide: Side,
): Promise<string[]> {
  const reader = new PostgreSqlJournalEventReader(client, authorization(side, ceiling) as never);
  const ids: string[] = [];
  for await (const bytes of reader.readEventBytes({
    tenantId: `tenant-j-${scopeSide}`,
    timelineId: `timeline-j-${scopeSide}`,
  } as never)) {
    ids.push((JSON.parse(new TextDecoder().decode(bytes)) as { eventId: string }).eventId);
  }
  return ids.sort();
}

async function countsFor(
  truth: (sql: string) => Promise<string>,
  tenant: string,
  commandId: string,
): Promise<string> {
  return truth(
    `SELECT (SELECT count(*) FROM clockgrove.command_receipts WHERE tenant_id = '${tenant}' AND command_id = '${commandId}')
       || '|' || (SELECT count(*) FROM clockgrove.events WHERE tenant_id = '${tenant}' AND command_id = '${commandId}')
       || '|' || (SELECT count(*) FROM clockgrove.event_dispatches AS dispatch
            JOIN clockgrove.events AS event USING (tenant_id, event_id)
           WHERE event.tenant_id = '${tenant}' AND event.command_id = '${commandId}')`,
  );
}

async function caught(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error("operation unexpectedly succeeded");
}

async function expectRefusal(operation: Promise<unknown>): Promise<void> {
  const error = await caught(operation);
  // Nothing about the other tenant may appear in what the caller sees.
  const rendered = `${error.name} ${error.message} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
  expect(rendered).not.toMatch(/event-b-|command-b-|principal-j-b|Journal B|hash-/u);
}
