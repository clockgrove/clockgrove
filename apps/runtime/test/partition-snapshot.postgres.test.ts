import type {
  PartitionSnapshotPorts,
  RuntimeAuthorizationContext,
  SnapshotRef,
  WorldPartitionScope,
} from "@clockgrove/application";
import {
  ArtifactNotFoundError,
  createPartitionSnapshot,
  decodePartitionState,
  executeWorldCommand,
  InMemoryRuntimeLogger,
  InMemoryRuntimeMetrics,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  loadPartitionSnapshot,
  maintainPartitionSnapshot,
  SnapshotConflictError,
  SnapshotNotQuiescentError,
  verifyPartitionReplay,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { applyMigrations } from "../../../scripts/database/lib.mjs";
import {
  advanceCommand,
  commandRequest,
  connect,
  type DatabaseFixture,
  holdCluster,
  type ProvisionedPartition,
  provisionTestWorld,
  testWorld,
  truthOf,
} from "./world-fixture.js";

// One runtime connection serves every call, tenant and ceiling; tampering is admin SQL.
let cluster: Awaited<ReturnType<typeof holdCluster>>;
let client: ReturnType<typeof connect>;
let provisioned: ProvisionedPartition;
let ports: PartitionSnapshotPorts;
let auth: RuntimeAuthorizationContext;
let scope: WorldPartitionScope;
let truth: (sql: string) => Promise<string>;
const execute = (key: string, after: bigint, budget?: { maxInputs: number; maxEvents: number }) =>
  executeWorldCommand(
    commandRequest(
      provisioned,
      advanceCommand(
        provisioned.world,
        key,
        provisioned.world.birth.state.simulationTime + after,
        null,
        budget,
      ),
    ),
    { journal: new PostgreSqlWorldCommandJournal(client), behavior: provisioned.behavior },
  );
const counts = () =>
  truth(
    "SELECT (SELECT count(*) FROM clockgrove.snapshots) || '|' || (SELECT count(*) FROM clockgrove.artifact_references)",
  );
/** A digest of every canonical row a snapshot must not touch. */
const canonical = () =>
  truth(
    `SELECT md5(string_agg(row, '' ORDER BY row)) FROM (${[
      "partition_states",
      "partition_schedules",
      "events",
      "command_receipts",
      "timeline_partitions",
      "streams",
    ]
      .map((table) => `SELECT to_jsonb(r)::text AS row FROM clockgrove.${table} AS r`)
      .join(" UNION ALL ")}) AS rows`,
  );

beforeAll(async () => {
  cluster = await holdCluster((fixture: DatabaseFixture) =>
    applyMigrations(fixture.tools, fixture.environment),
  );
  truth = truthOf(cluster.fixture);
  provisioned = await provisionTestWorld(cluster.fixture, await testWorld(), "principal-snapshot");
  client = connect(cluster.fixture.environment);
  ports = {
    snapshots: new PostgreSqlSnapshotStore(client),
    artifacts: new PostgreSqlArtifactStore(client),
  };
  auth = provisioned.authorization;
  scope = { ...provisioned.partition.target, partitionId: provisioned.partition.route.partitionId };
  await execute("command-1", 60_000n);
  await execute("command-2", 120_000n);
}, 120_000);

afterAll(() => client?.close().then(() => cluster?.close()));

let ref: SnapshotRef;
const live = async () => (await ports.snapshots.readCommitted(auth, scope))!;
const coverage =
  "SELECT covered_head_sequence || '|' || (SELECT max(stream_sequence) FROM clockgrove.events) || '|' || state_hash";

describe("partition snapshots", () => {
  it("creates one snapshot per committed head idempotently, also after a crash before its row, and changes no canonical row", async () => {
    const before = await canonical();
    ref = await createPartitionSnapshot(auth, scope, ports);
    expect(await createPartitionSnapshot(auth, scope, ports)).toEqual(ref);
    await truth("DELETE FROM clockgrove.snapshots");
    expect(await createPartitionSnapshot(auth, scope, ports)).toEqual(ref);
    // Another snapshot ID at the same covered head fails on the head index and is a conflict.
    await expect(
      ports.snapshots.record(auth, { ...ref, snapshotId: "snapshot:other" }),
    ).rejects.toBeInstanceOf(SnapshotConflictError);
    expect(await counts()).toBe("1|1");
    expect(await canonical()).toBe(before);
    const head = await truth(`${coverage} FROM clockgrove.partition_states`);
    expect(`${ref.coveredPartitionSequence}|${ref.coveredStreamSequence}|${ref.stateHash}`).toBe(
      head,
    );
  });

  it("restores a verified document equal to the live one", async () => {
    const { packContentHash, stored } = await live();
    expect((await loadPartitionSnapshot(auth, ref, packContentHash, ports)).document).toEqual(
      decodePartitionState(stored),
    );
  });

  it("refuses a tampered artifact, a tampered document hash, a row that differs from its content and an incompatible version", async () => {
    const { packContentHash, stored } = await live();
    const artifact = `artifact_id = '${ref.artifactId}'`;
    await truth(
      `CREATE TABLE public.original AS SELECT inline_content FROM clockgrove.artifact_references WHERE ${artifact}`,
    );
    /** Rewrites the stored bytes, and their length and hash, which migration 0012 requires to match. */
    const rewrite = (from: string, to: string) =>
      truth(`UPDATE clockgrove.artifact_references AS a SET inline_content = n.bytes, byte_length = octet_length(n.bytes),
               content_hash = 'sha256:' || encode(sha256(n.bytes), 'hex')
               FROM (SELECT convert_to(replace(convert_from(inline_content, 'UTF8'), '${from}', '${to}'), 'UTF8') AS bytes
                       FROM public.original) AS n WHERE a.${artifact}`);
    const refusal = (target = ref, pack = packContentHash) =>
      loadPartitionSnapshot(auth, target, pack, ports).catch((error: unknown) => error);
    for (const [from, to, reason] of [
      ["clockgrove.partition-state", "clockgrove.partition-statf", "malformed-document"],
      [stored.documentHash, "0".repeat(64), "document-hash-mismatch"],
    ]) {
      await rewrite(from!, to!);
      expect(await refusal()).toMatchObject({ name: "SnapshotIntegrityError", reason });
    }
    await rewrite("", "");
    // The database lets a row claim another head or hash than its bytes; restore refuses either.
    for (const forgery of [
      "state_hash = repeat('f', 64)",
      "covered_partition_sequence = covered_partition_sequence + 1",
    ]) {
      await truth(`UPDATE clockgrove.snapshots SET ${forgery}`);
      const [forged] = await ports.snapshots.list(auth, scope);
      expect(await refusal(forged)).toMatchObject({
        name: "SnapshotIntegrityError",
        reason: "row-mismatch",
      });
      await truth(
        `UPDATE clockgrove.snapshots SET state_hash = '${ref.stateHash}', covered_partition_sequence = ${ref.coveredPartitionSequence}`,
      );
    }
    expect(await refusal(ref, "1".repeat(64))).toMatchObject({
      name: "SnapshotIncompatibleError",
      field: "packContentHash",
    });
    expect((await loadPartitionSnapshot(auth, ref, packContentHash, ports)).ref).toBe(ref);
  });

  it("is invisible to another tenant and to a ceiling without public_scene", async () => {
    const other = { ...auth, tenantId: decodeOpaqueId("tenant-other", "TenantId") };
    const lower = {
      ...auth,
      privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["conversation"] }),
    };
    for (const denied of [other, lower]) {
      expect(await ports.snapshots.list(auth, scope)).toEqual([ref]);
      expect(await ports.snapshots.list(denied, scope)).toEqual([]);
      await expect(loadPartitionSnapshot(denied, ref, "", ports)).rejects.toBeInstanceOf(
        ArtifactNotFoundError,
      );
    }
  });

  it("records snapshot age, verification, size and creation time, and replay mismatches", async () => {
    const metrics = new InMemoryRuntimeMetrics();
    const replay = {
      ...ports,
      metrics,
      artifacts: new PostgreSqlArtifactStore(client, { metrics }),
      events: new JournalRangeReader(
        new PostgreSqlJournalRangeSource(client, auth),
        JOURNAL_EVENT_REGISTRY,
      ),
      birth: new PostgreSqlWorldProvisioningStore(client),
      decodeResource,
    };
    await execute("command-3", 180_000n);
    const logger = new InMemoryRuntimeLogger();
    expect(await maintainPartitionSnapshot(auth, scope, replay, logger)).toBe("written");
    // A forged live hash: the full replay and the snapshot replay both disagree with it.
    const read = await live();
    const forged = { ...read, stored: { ...read.stored, stateHash: "0".repeat(64) } };
    expect((await verifyPartitionReplay(auth, scope, "exact", replay, forged)).mismatches).toEqual([
      "full-vs-live",
      "snapshot-vs-live",
    ]);
    const [head, bytes] = (
      await truth(`SELECT covered_head_sequence || '|' || (SELECT byte_length FROM clockgrove.artifact_references
                     WHERE artifact_id LIKE 'snapshot:%:' || covered_head_sequence || ':artifact:%')
                     FROM clockgrove.partition_states`)
    )
      .split("|")
      .map(Number);
    const replays = [
      ["replay_events_per_second", "birth", expect.any(Number), expect.any(Number)],
      ["replay_events_per_second", "snapshot", expect.any(Number), expect.any(Number)],
    ];
    expect(
      metrics.points.map(({ name, label, value, count }) => [name, label, value, count]),
    ).toEqual([
      ...replays,
      ["snapshot_age_events", "snapshot", head! - Number(ref.coveredPartitionSequence), undefined],
      ["replay_mismatches", "exact", 0, 0],
      ["snapshot_verification", "verified", 1, undefined],
      ["artifact_bytes", "inline", bytes, undefined],
      ["snapshot_bytes", "written", bytes, head],
      ["snapshot_create_ms", "written", expect.any(Number), undefined],
      ...replays,
      ["snapshot_age_events", "snapshot", 0, undefined],
      ["replay_mismatches", "exact", 2, 0],
    ]);
  });

  it("refuses to snapshot while a continuation is open, and writes nothing", async () => {
    expect(
      (await execute("command-long", 900_000n, { maxInputs: 1, maxEvents: 256 })).value,
    ).toMatchObject({ complete: false });
    const before = await counts();
    await expect(createPartitionSnapshot(auth, scope, ports)).rejects.toBeInstanceOf(
      SnapshotNotQuiescentError,
    );
    expect(await counts()).toBe(before);
  });
});
