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
        VALUES ('tenant-c', 'session-c', 'principal-c', 'persona-c');
      INSERT INTO clockgrove.conversation_sessions (tenant_id, session_id, world_id, timeline_id,
        partition_id, space_id, actor_id, voice_mode)
        VALUES ('tenant-c', 'session-c', 'world-c', 'timeline-c', 'partition-a', 'space-a', 'keeper', 'cognitive')`);
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
    try {
      await activations.configure(
        address,
        {
          id: `watch-${run}`,
          sessionId: "session-c",
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
      const check = async () => {
        const { events, more } = await activations.events(address);
        for (const event of events) await activations.acknowledgeEvent(address, event.eventId);
        return { seen: events.map((e) => e.eventId), more };
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
      const request = (s: FixtureScope, id: string) =>
        fixtureRequest(s, `command-${id}`, [fixtureDraft(s, id)]);
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
      const whileHeld = await check();
      release();
      await lowCommit;
      const afterCommit = await check();
      const again = await check();

      const positions = await truthOf(cluster.fixture)(
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
