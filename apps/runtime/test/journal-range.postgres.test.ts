import { readFile } from "node:fs/promises";

import {
  JournalDraftRefusedError,
  type JournalExecuteRequest,
  JournalRangeReader,
  type RuntimeAuthorizationContext,
  VerifiedJournal,
} from "@clockgrove/application";
import {
  createEventTypeRegistry,
  decodeOpaqueId,
  decodePrivacyCeiling,
  upcastEventBytes,
} from "@clockgrove/contracts";
import { PostgreSqlJournal, PostgreSqlJournalRangeSource } from "@clockgrove/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURE_EVENT_TYPE,
  type FixtureScope,
  fixtureDraft,
  fixtureRequest,
} from "../../../packages/application/test/journal-request-fixture.js";
import {
  applyMigrations,
  applySqlFile,
  psql,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import type { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import { connect, type DatabaseFixture, holdCluster, truthOf } from "./world-fixture.js";

const GOLDEN_DIRECTORY = new URL(
  "../../../packages/contracts/test/fixtures/journal-events/",
  import.meta.url,
);
const WEATHER_REGISTRY = createEventTypeRegistry([{ type: "WeatherChanged", schemaVersion: 2 }]);
const TENANT_A = decodeOpaqueId("tenant-a", "TenantId");
const TIMELINE_MAIN = decodeOpaqueId("timeline-main", "TimelineId");
const GOLDEN_STREAM = {
  tenantId: TENANT_A,
  timelineId: TIMELINE_MAIN,
  streamId: decodeOpaqueId("stream-weather", "StreamId"),
};
const GOLDEN_PARTITION = {
  tenantId: TENANT_A,
  timelineId: TIMELINE_MAIN,
  partitionId: decodeOpaqueId("partition-weather", "PartitionId"),
};
const JOURNAL_SCOPE: FixtureScope = {
  tenantId: "tenant-j-a",
  principalId: "principal-j-a",
  worldId: "world-j-a",
  timelineId: "timeline-j-a",
  partitionId: "partition-j-a",
  spaceId: "space-j-a",
  streamId: "stream-j-a",
};
const RECORDED_REGISTRY = createEventTypeRegistry([{ type: FIXTURE_EVENT_TYPE, schemaVersion: 2 }]);

function authorization(
  tenantId: string,
  principalId: string,
  categories: readonly ("public_scene" | "operator_evidence")[],
): RuntimeAuthorizationContext {
  return {
    tenantId: decodeOpaqueId(tenantId, "TenantId"),
    principalId: decodeOpaqueId(principalId, "PrincipalId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: categories }),
  };
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function insertGolden(
  fixture: DatabaseFixture,
  text: string,
  commandId: string,
): Promise<void> {
  const golden = JSON.parse(text);
  const policyVersions = golden.policyVersions ?? { default: golden.policyVersion };
  await psql(
    fixture.tools,
    fixture.environment,
    `INSERT INTO clockgrove.command_receipts (
       tenant_id, command_id, request_hash, command_bytes, target_address, status, canonical_event_ids,
       provenance, committed_at
     ) VALUES ('tenant-a', ${literal(commandId)}, 'hash', convert_to('c', 'UTF8'), '{}', 'committed',
               ARRAY[${literal(golden.eventId)}], 'legacy-wave0', statement_timestamp());
     INSERT INTO clockgrove.events (
       event_id, tenant_id, world_id, timeline_id, partition_id, space_id, stream_id,
       stream_sequence, partition_sequence, event_type, schema_version, simulation_time,
       command_id, correlation_id, privacy_class, payload_hash, attribution,
       policy_versions, payload, event_bytes
     ) VALUES (
       ${literal(golden.eventId)}, 'tenant-a', 'world-a', 'timeline-main', 'partition-weather',
       'space-weather', 'stream-weather', ${golden.streamSequence}, ${golden.partitionSequence},
       ${literal(golden.type)}, ${golden.schemaVersion}, ${golden.simulationTime}, ${literal(commandId)},
       ${literal(golden.correlationId)}, ${literal(golden.privacyClass)}, ${literal(golden.payloadHash)},
       ${literal(JSON.stringify(golden.attribution))}::jsonb, ${literal(JSON.stringify(policyVersions))}::jsonb,
       ${literal(JSON.stringify(golden.payload))}::jsonb, convert_to(${literal(text)}, 'UTF8')
     );`,
  );
}

async function counts(fixture: DatabaseFixture, commandId: string): Promise<string> {
  return truthOf(fixture)(
    `SELECT (SELECT count(*) FROM clockgrove.command_receipts WHERE command_id = ${literal(commandId)})
       || '|' || (SELECT count(*) FROM clockgrove.events WHERE command_id = ${literal(commandId)})
       || '|' || (SELECT count(*) FROM clockgrove.event_dispatches AS dispatch
            JOIN clockgrove.events AS event USING (tenant_id, event_id)
           WHERE event.command_id = ${literal(commandId)})`,
  );
}

async function refusalOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

// One database for both tests: the weather goldens in tenant-a, the drafts in the journal fixture.
let cluster: Awaited<ReturnType<typeof holdCluster>>;
let fixture: DatabaseFixture;
let client: HyperdrivePostgreSqlClient;
beforeAll(async () => {
  cluster = await holdCluster(async ({ tools, environment }: DatabaseFixture) => {
    await applyMigrations(tools, environment);
    await applySqlFile(tools, environment, "tests/database/journal-fixture.sql");
    await psql(
      tools,
      environment,
      `INSERT INTO clockgrove.tenants (tenant_id, display_name)
       VALUES ('tenant-a', 'Tenant A'), ('tenant-b', 'Tenant B');
       INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
       VALUES ('tenant-a', 'principal-a'), ('tenant-b', 'principal-b');
       INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
       VALUES ('tenant-a', 'world-a', 'ready');
       INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
       VALUES ('tenant-a', 'world-a', 'timeline-main');
       INSERT INTO clockgrove.timeline_partitions (
         tenant_id, world_id, timeline_id, partition_id, space_id, head_sequence
       ) VALUES ('tenant-a', 'world-a', 'timeline-main', 'partition-weather', 'space-weather', 12);
       INSERT INTO clockgrove.streams (
         tenant_id, world_id, timeline_id, partition_id, space_id, stream_id, current_sequence
       ) VALUES ('tenant-a', 'world-a', 'timeline-main', 'partition-weather', 'space-weather',
                 'stream-weather', 8);`,
    );
  });
  fixture = cluster.fixture;
  client = connect(fixture.environment);
}, 60_000);
afterAll(async () => {
  await client?.close();
  await cluster?.close();
});

describe("journal range reads over real PostgreSQL", () => {
  it("returns hash-correct v1 and v2 goldens byte-identically and upcast, and fails closed elsewhere", async () => {
    const goldens = await Promise.all(
      ["event-v1.json", "event-v2.json"].map((name) =>
        readFile(new URL(name, GOLDEN_DIRECTORY), "utf8"),
      ),
    );
    await insertGolden(fixture, goldens[0]!, "command-weather-1");
    await insertGolden(fixture, goldens[1]!, "command-weather-2");
    const asOwner = authorization("tenant-a", "principal-a", ["public_scene"]);
    const source = new PostgreSqlJournalRangeSource(client, asOwner);
    const reader = new JournalRangeReader(source, WEATHER_REGISTRY);
    const expected = goldens.map((text) => upcastEventBytes(text));

    const streamRange = { from: 7n, to: 8n };
    const partitionRange = { from: 11n, to: 12n };
    expect(await reader.readStream(GOLDEN_STREAM, streamRange)).toEqual(expected);
    expect(await reader.readPartition(GOLDEN_PARTITION, partitionRange)).toEqual(expected);
    expect(await reader.readStream(GOLDEN_STREAM, { from: 8n })).toEqual([expected[1]]);

    const rows = await source.readStreamRows(GOLDEN_STREAM, streamRange);
    expect(rows.head).toBe(8n);
    expect(rows.eventBytes.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual(goldens);

    // The whole stream starts at sequence 1, which these rows do not contain.
    expect(await refusalOf(reader.readStream(GOLDEN_STREAM))).toMatchObject({
      reason: "sequence-gap",
    });

    // Another tenant's authority never sees these events.
    const asOther = new JournalRangeReader(
      new PostgreSqlJournalRangeSource(
        client,
        authorization("tenant-b", "principal-b", ["public_scene"]),
      ),
      WEATHER_REGISTRY,
    );
    expect(await asOther.readStream(GOLDEN_STREAM, streamRange)).toEqual([]);
    expect(await asOther.readPartition(GOLDEN_PARTITION, partitionRange)).toEqual([]);

    // Events hidden by the privacy ceiling fail the range instead of being skipped.
    const hidden = new JournalRangeReader(
      new PostgreSqlJournalRangeSource(
        client,
        authorization("tenant-a", "principal-a", ["operator_evidence"]),
      ),
      WEATHER_REGISTRY,
    );
    expect(await refusalOf(hidden.readStream(GOLDEN_STREAM, streamRange))).toMatchObject({
      reason: "sequence-gap",
    });
    expect(await refusalOf(hidden.readPartition(GOLDEN_PARTITION, partitionRange))).toMatchObject({
      reason: "sequence-gap",
    });

    // The reader's registry decides which stored events are acceptable.
    const strict = new JournalRangeReader(source, RECORDED_REGISTRY);
    expect(await refusalOf(strict.readStream(GOLDEN_STREAM, streamRange))).toMatchObject({
      reason: "unknown-event-type",
    });
  }, 60_000);

  it("stores only verified drafts, and every stored draft reads back verified", async () => {
    const journal = new VerifiedJournal(new PostgreSqlJournal(client), RECORDED_REGISTRY);
    const draft = (eventId: string, overrides = {}) =>
      fixtureDraft(JOURNAL_SCOPE, eventId, overrides);
    const attempt = (commandId: string, events: JournalExecuteRequest["events"]) =>
      refusalOf(journal.execute(fixtureRequest(JOURNAL_SCOPE, commandId, events)));

    const refusals: readonly [string, JournalExecuteRequest["events"], string][] = [
      [
        "hash",
        [draft("event-hash", { payloadHash: "sha256:placeholder" })],
        "payload-hash-mismatch",
      ],
      ["type", [draft("event-type", { type: "Unregistered" })], "unknown-event-type"],
      [
        "mixed",
        [draft("event-ok"), draft("event-bad", { payloadHash: "sha256:placeholder" })],
        "payload-hash-mismatch",
      ],
      ["bigint", [draft("event-bigint", { payload: { count: 1n } })], "payload-not-json-stable"],
    ];
    for (const [name, events, reason] of refusals) {
      const error = await attempt(`command-${name}`, events);
      expect(error).toBeInstanceOf(JournalDraftRefusedError);
      expect(error).toMatchObject({ reason });
      expect(await counts(fixture, `command-${name}`)).toBe("0|0|0");
    }

    const olderOnly = new VerifiedJournal(
      new PostgreSqlJournal(client),
      createEventTypeRegistry([{ type: FIXTURE_EVENT_TYPE, schemaVersion: 1 }]),
    );
    const versionError = await refusalOf(
      olderOnly.execute(fixtureRequest(JOURNAL_SCOPE, "command-version", [draft("event-version")])),
    );
    expect(versionError).toMatchObject({ reason: "unknown-event-version" });
    expect(await counts(fixture, "command-version")).toBe("0|0|0");

    const valid = [
      draft("event-1", { payload: { n: 1 } }),
      draft("event-2", { payload: { text: "two" } }),
    ];
    await journal.execute(fixtureRequest(JOURNAL_SCOPE, "command-valid", valid));
    expect(await counts(fixture, "command-valid")).toBe("1|2|0");

    const reader = new JournalRangeReader(
      new PostgreSqlJournalRangeSource(
        client,
        authorization(JOURNAL_SCOPE.tenantId, JOURNAL_SCOPE.principalId, ["public_scene"]),
      ),
      RECORDED_REGISTRY,
    );
    const stored = await reader.readStream({
      tenantId: decodeOpaqueId(JOURNAL_SCOPE.tenantId, "TenantId"),
      timelineId: decodeOpaqueId(JOURNAL_SCOPE.timelineId, "TimelineId"),
      streamId: decodeOpaqueId(JOURNAL_SCOPE.streamId, "StreamId"),
    });
    expect(stored.map((event) => [event.eventId, event.streamSequence, event.payloadHash])).toEqual(
      valid.map((event, index) => [event.eventId, BigInt(index + 1), event.payloadHash]),
    );
    expect(stored.map((event) => event.payload)).toEqual([{ n: 1 }, { text: "two" }]);
  }, 60_000);
});
