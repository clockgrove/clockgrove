import { spawnSync } from "node:child_process";
import type { ActivationAddress } from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  executeJournalStatement,
  PostgreSqlActivations,
  type PostgreSqlClient,
  PostgreSqlJournal,
  withClientTransaction,
} from "@clockgrove/persistence";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type FixtureScope,
  fixtureDraft,
  fixtureRequest,
} from "../../../packages/application/test/journal-request-fixture.js";
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { applyMigrations } from "../../../scripts/database/lib.mjs";
import { connect, holdCluster, truthOf } from "./world-fixture.js";

// Issue 128: two partitions of one timeline commit in parallel under separate head locks, so a
// lower journal position can become visible after a higher one. A subscription must still read each
// committed event exactly once.
const BASE = { tenantId: "tenant-c", principalId: "principal-c", worldId: "world-c" };
const scope = (space: string): FixtureScope => ({
  ...BASE,
  timelineId: "timeline-c",
  partitionId: `partition-${space}`,
  spaceId: `space-${space}`,
  streamId: `stream-${space}`,
});
const [A, B] = [scope("a"), scope("b")];
const address = {
  scope: { ...BASE, timelineId: "timeline-c", spaceId: "space-a" },
  actorId: "keeper",
  participant: {
    tenantId: decodeOpaqueId(BASE.tenantId, "TenantId"),
    principalId: decodeOpaqueId(BASE.principalId, "PrincipalId"),
    personaId: "persona-c",
    privacyCeiling: decodePrivacyCeiling({
      version: 1,
      allowedCategories: ["public_scene", "conversation"],
    }),
  },
} as unknown as ActivationAddress;
const warden = { ...address, actorId: "warden" } as ActivationAddress;
const TIMELINE = "tenant_id='tenant-c' AND world_id='world-c' AND timeline_id='timeline-c'";

/** A subscription to every `Recorded` event for the actor of `a`, through its conversation. */
const subscribe = (activations: PostgreSqlActivations, a: ActivationAddress, id: string) =>
  activations.configure(
    a,
    {
      id,
      sessionId: `session-${a.actorId}`,
      kind: "subscription",
      nextWakeAt: null,
      intervalMs: null,
      eventType: "Recorded",
      input: "",
      priority: 1,
      enabled: true,
      compiledRoutine: "noop",
    },
    { allowModel: false, modelBudget: 0 },
  );
/** One subscription check as the owner runs it: read the page, acknowledge each event. */
const check = async (activations: PostgreSqlActivations, a = address) => {
  const { events, more } = await activations.events(a);
  for (const event of events) await activations.acknowledgeEvent(a, event.eventId);
  return { seen: events.map((e) => e.eventId), more };
};
const request = (s: FixtureScope, id: string) =>
  fixtureRequest(s, `command-${id}`, [fixtureDraft(s, id)]);

let cluster: Awaited<ReturnType<typeof holdCluster>>;
beforeAll(async () => {
  cluster = await holdCluster(async (fixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await truthOf(fixture)(`
      INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('tenant-c', 'C');
      INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-c', 'principal-c');
      INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('tenant-c', 'world-c', 'ready');
      INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('tenant-c', 'world-c', 'timeline-c');
      INSERT INTO clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id)
        SELECT 'tenant-c', 'world-c', 'timeline-c', 'partition-' || s, 'space-' || s FROM unnest(ARRAY['a','b']) s;
      INSERT INTO clockgrove.streams (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
        SELECT 'tenant-c', 'world-c', 'timeline-c', 'partition-' || s, 'space-' || s, 'stream-' || s FROM unnest(ARRAY['a','b']) s;
      INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id,
        membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
        VALUES ('tenant-c', 'world-c', 'timeline-c', 'space-a', 'principal-c', 'membership-c', 'persona-c',
        ARRAY['member'], ARRAY['runtime:world-command'],
        '{"version":1,"allowedCategories":["public_scene","conversation"]}', statement_timestamp());
      INSERT INTO clockgrove.conversation_participants (tenant_id, session_id, principal_id, persona_id)
        SELECT 'tenant-c', 'session-' || a, 'principal-c', 'persona-c' FROM unnest(ARRAY['keeper','warden']) a;
      INSERT INTO clockgrove.conversation_sessions (tenant_id, session_id, world_id, timeline_id,
        partition_id, space_id, actor_id, voice_mode)
        SELECT 'tenant-c', 'session-' || a, 'world-c', 'timeline-c', 'partition-a', 'space-a', a, 'cognitive'
        FROM unnest(ARRAY['keeper','warden']) a`);
  });
}, 60_000);
afterAll(() => cluster?.close());

it.each([
  ["the lower position's transaction began first", false],
  ["the higher position's transaction began first", true],
])(
  "reads each committed event once when partitions commit out of position order: %s",
  async (_case, higherBeganFirst) => {
    const environment = cluster.fixture.environment;
    const clients = [connect(environment), connect(environment), connect(environment)];
    const [low, high, reader] = clients as [
      ReturnType<typeof connect>,
      ReturnType<typeof connect>,
      ReturnType<typeof connect>,
    ];
    const activations = new PostgreSqlActivations(reader);
    const run = higherBeganFirst ? "began-high" : "began-low";
    const sql = truthOf(cluster.fixture);
    try {
      await subscribe(activations, address, `watch-${run}`);
      // The reader before #132, adapted to this test (issue 138): a position cursor that moves to
      // the highest position read. The interleaving must defeat it, or this test proves nothing.
      let position = await sql(
        `SELECT coalesce(max(journal_position), 0) FROM clockgrove.events WHERE ${TIMELINE}`,
      );
      const positionCheck = async () => {
        const rows = await sql(`SELECT event_id, journal_position FROM clockgrove.events
          WHERE ${TIMELINE} AND journal_position > ${position} ORDER BY journal_position`);
        const read = rows ? rows.split("\n").map((row) => row.split("|")) : [];
        for (const [, at] of read) position = String(Math.max(Number(position), Number(at)));
        return read.map(([id]) => id);
      };
      // Partition A draws the lower position and holds its transaction open before COMMIT.
      let drawn!: () => void;
      let release!: () => void;
      const lowDrawn = new Promise<void>((resolve) => (drawn = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const lowHeld: PostgreSqlClient = {
        query: async (text, values) => {
          if (text === "COMMIT") {
            drawn();
            await released;
          }
          return low.query(text, values);
        },
      };
      const lowId = `${run}-low`;
      const highId = `${run}-high`;
      let highBegun!: () => void;
      const highHasXid = new Promise<void>((resolve) => (highBegun = resolve));
      // Partition B commits the higher position; in the second case its transaction ID is older.
      const highCommit = withClientTransaction(
        high,
        { authorization: request(B, highId).authorization },
        async () => {
          if (higherBeganFirst) await high.query("SELECT pg_current_xact_id()");
          highBegun();
          await lowDrawn;
          return executeJournalStatement(high, request(B, highId));
        },
      );
      if (higherBeganFirst) await highHasXid;
      const lowCommit = highHasXid.then(() =>
        new PostgreSqlJournal(lowHeld).execute(request(A, lowId)),
      );
      await highCommit;
      const whileHeld = await check(activations);
      const positionWhileHeld = await positionCheck();
      release();
      await lowCommit;
      const afterCommit = await check(activations);
      const again = await check(activations);

      expect([...positionWhileHeld, ...(await positionCheck())]).toEqual([highId]);

      const positions = await sql(
        `SELECT string_agg(event_id, ',' ORDER BY journal_position) FROM clockgrove.events
          WHERE event_id IN ('${lowId}', '${highId}')`,
      );
      expect(positions).toBe(`${lowId},${highId}`);
      expect([...whileHeld.seen, ...afterCommit.seen].sort()).toEqual([highId, lowId].sort());
      expect(again).toEqual({ seen: [], more: false });
      // An event behind an older open transaction waits, and asks for a prompt re-check.
      expect(whileHeld).toEqual(
        higherBeganFirst ? { seen: [highId], more: false } : { seen: [], more: true },
      );
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  },
);

/** `dump` with `column` of `table` one transaction ID epoch ahead, as a busier cluster wrote it. */
function ahead(dump: string, table: string, column: string): string {
  let field = -1;
  return dump
    .split("\n")
    .map((line) => {
      const copy = /^COPY clockgrove\.(\w+) \((.*)\) FROM stdin;$/u.exec(line);
      if (copy) field = copy[1] === table ? (copy[2] ?? "").split(", ").indexOf(column) : -1;
      if (line === "\\.") field = -1;
      if (copy || field < 0) return line;
      const values = line.split("\t");
      values[field] = String(BigInt(values[field] ?? "") + 2n ** 32n);
      return values.join("\t");
    })
    .join("\n");
}

it("refuses a restore whose transaction IDs are ahead of the cluster, and a rebased dump keeps every cursor exact", async () => {
  const { tools, environment } = cluster.fixture as {
    tools: { psql: string; pg_dump: string };
    environment: Record<string, string>;
  };
  const sql = truthOf(cluster.fixture);
  const tool = (name: string, args: string[], database: string, input?: string) =>
    spawnSync(name, args, {
      env: { ...environment, PGDATABASE: database },
      input,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  const dump = () => tool(tools.pg_dump, ["--format=plain"], "clockgrove").stdout;
  /** Restores `text` into a new `database` as psql does; returns psql's errors. */
  const restore = async (database: string, text: string) => {
    await truthOf(
      cluster.fixture,
      "postgres",
    )(`CREATE DATABASE ${database} OWNER clockgrove_migrator TEMPLATE template0 ENCODING 'UTF8'`);
    const psql = ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--output=/dev/null", "--file=-"];
    return tool(tools.psql, psql, database, text).stderr;
  };
  const [source, target] = [connect(environment), connect(environment, "clockgrove_rebased")];
  try {
    const before = new PostgreSqlActivations(source);
    await subscribe(before, address, "watch-restore");
    await check(before);
    await subscribe(before, warden, "watch-restore");
    await new PostgreSqlJournal(source).execute(request(A, "restore-read"));
    expect(await check(before)).toEqual({ seen: ["restore-read"], more: false });
    await new PostgreSqlJournal(source).execute(request(A, "restore-unread"));

    // A cluster whose counter is behind the dump's IDs refuses the rows, before anything reads them.
    const original = dump();
    for (const [table, column, constraint] of [
      ["actor_activation_policies", "event_cursor_transaction", "cursor_not_ahead"],
      ["events", "transaction_id", "transaction_not_ahead"],
    ] as const)
      expect(await restore(`clockgrove_${table}_ahead`, ahead(original, table, column))).toContain(
        `violates check constraint "${table}_${constraint}"`,
      );

    // The repair: two distinct cursors, so every ID becomes 0, 1 or 2, below any cluster's counter.
    await sql("SELECT clockgrove.rebase_activation_order()");
    expect(
      await sql(`SELECT string_agg(event_id || '=' || transaction_id, ',' ORDER BY journal_position)
        FROM clockgrove.events WHERE event_id LIKE 'restore-%'`),
    ).toBe("restore-read=1,restore-unread=2");
    expect(
      await sql(`SELECT string_agg(actor_id || '=' || event_cursor_transaction, ',' ORDER BY actor_id)
        FROM clockgrove.actor_activation_policies`),
    ).toBe("keeper=1,warden=0");
    expect(await restore("clockgrove_rebased", dump())).toBe("");

    // After the restore, each cursor reads its unread events and every new one, each once.
    const after = new PostgreSqlActivations(target);
    await new PostgreSqlJournal(target).execute(request(A, "restore-after"));
    expect(await check(after)).toEqual({ seen: ["restore-unread", "restore-after"], more: false });
    expect(await check(after, warden)).toEqual({
      seen: ["restore-read", "restore-unread", "restore-after"],
      more: false,
    });
    expect([await check(after), await check(after, warden)]).toEqual([
      { seen: [], more: false },
      { seen: [], more: false },
    ]);
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
});
