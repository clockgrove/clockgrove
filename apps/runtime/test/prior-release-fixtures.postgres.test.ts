import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePayloadHash,
  createPartitionSnapshot,
  executeWorldCommand,
  exportReplayBundle,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  type RuntimeAuthorizationContext,
  verifyPartitionReplay,
  verifyReplayBundle,
  WORLD_KERNEL_EVENT_TYPES,
  type WorldPartitionScope,
} from "@clockgrove/application";
import { type CommandEnvelope, decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  PostgreSqlArtifactStore,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { describe, expect, it } from "vitest";
import {
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import {
  migratePriorRelease,
  priorReleaseFixtures,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/prior-fixtures.mjs";
import { PostgreSqlCommandOwner } from "../src/world-commands.js";
import type { PriorReleaseManifest } from "./prior-release.js";
import {
  commandRequest,
  type DatabaseFixture,
  type ProvisionedPartition,
  truthOf,
  withClient,
} from "./world-fixture.js";

// RW-0209: every prior-release fixture (db/fixtures/prior) migrates to head without
// losing a row or an event byte, and the head runtime replays it to the hashes its release recorded.
// Replay reads each kernel event through the upcast table and refuses a version it has no upcast for,
// so a fixture that replays holds only current or upcast versions. Migration 0029 retires the
// snapshots of the old kernel registry; the upgraded database then takes a snapshot under the current
// one, commits a command that appends kernel events above it, and replays from it plus that suffix.

/** The fixture world's partition, as its member principal sees it. */
function scopeOf(manifest: PriorReleaseManifest) {
  const { scope: ids } = manifest;
  const authorization: RuntimeAuthorizationContext = {
    tenantId: decodeOpaqueId(ids.tenantId, "TenantId"),
    principalId: decodeOpaqueId(manifest.principalId, "PrincipalId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
  };
  const scope: WorldPartitionScope = {
    tenantId: authorization.tenantId,
    worldId: decodeOpaqueId(ids.worldId, "WorldId"),
    timelineId: decodeOpaqueId(ids.timelineId, "TimelineId"),
    partitionId: decodeOpaqueId(ids.partitionId, "PartitionId"),
  };
  return { authorization, scope };
}

/** The command `snapshotBelowHead` commits. */
const SUFFIX_COMMAND = "prior-release-advance";

/**
 * As the runtime, under the current kernel registry: snapshots the committed head, then commits one
 * `world.advance` with the behavior installed in the upgraded database, as the command owner reads
 * it. The advance runs the kernel, so the snapshot lies below the new head with a suffix of kernel
 * events that replay from the snapshot must apply. Returns how many kernel events it appended.
 */
async function snapshotBelowHead(fixture: DatabaseFixture, manifest: PriorReleaseManifest) {
  const { authorization, scope } = scopeOf(manifest);
  const sql = truthOf(fixture);
  const [spaceId, streamId] = (
    await sql(`SELECT space_id || '|' || stream_id FROM clockgrove.streams
      WHERE tenant_id = '${scope.tenantId}' AND partition_id = '${scope.partitionId}'`)
  ).split("|");
  const { tenantId, worldId, timelineId } = manifest.scope;
  const target = { tenantId: scope.tenantId, worldId: scope.worldId, timelineId: scope.timelineId };
  const route = {
    partitionId: scope.partitionId,
    spaceId: decodeOpaqueId(spaceId!, "SpaceId"),
    streamId: decodeOpaqueId(streamId!, "StreamId"),
  };
  await withClient(fixture.environment, async (client) => {
    await createPartitionSnapshot(authorization, scope, {
      snapshots: new PostgreSqlSnapshotStore(client),
      artifacts: new PostgreSqlArtifactStore(client),
    });
    const owner = new PostgreSqlCommandOwner(client);
    const runtimeScope = { ...target, spaceId: route.spaceId };
    const behavior = await owner.behavior(authorization, runtimeScope);
    const { document } = await owner.reader.hydrate(authorization, runtimeScope);
    const command = {
      schemaVersion: 1,
      commandId: decodeOpaqueId(SUFFIX_COMMAND, "CommandId"),
      type: "world.advance",
      target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
      expected: {},
      issuedAt: "2026-10-27T00:00:00.000Z",
      context: { version: 1, correlationId: `correlation-${SUFFIX_COMMAND}`, requestId: "advance" },
      attribution: { effectiveActorId: "integration-test", causalRootActionId: "action-advance" },
      // One simulated hour past the fixture's head: the scenario's routines fall due within it.
      payload: {
        schemaVersion: 1,
        targetTime: document.state.simulationTime + 3_600_000n,
        maxInputs: 64,
        maxEvents: 256,
      },
    } as unknown as CommandEnvelope<string, unknown>;
    const outcome = await executeWorldCommand(
      commandRequest(
        { authorization, partition: { authorization, target, route } } as ProvisionedPartition,
        command,
      ),
      {
        journal: new PostgreSqlWorldCommandJournal(client),
        behavior: { behaviorFor: async () => behavior },
      },
    );
    expect(outcome.value).toMatchObject({ status: "committed", complete: true });
  });
  return Number(
    await sql(`SELECT count(*) FROM clockgrove.events WHERE command_id = '${SUFFIX_COMMAND}'
      AND event_type = ANY (ARRAY['${WORLD_KERNEL_EVENT_TYPES.join("','")}'])`),
  );
}

/** As the runtime: the replay's mismatches and its hashes, and the bundle's hash verified offline. */
async function replayOf(fixture: DatabaseFixture, manifest: PriorReleaseManifest) {
  const { authorization, scope } = scopeOf(manifest);
  const { replay, bundle } = await withClient(fixture.environment, async (client) => {
    const stores = {
      birth: new PostgreSqlWorldProvisioningStore(client),
      snapshots: new PostgreSqlSnapshotStore(client),
      events: new PostgreSqlJournalRangeSource(client, authorization),
    };
    const events = new JournalRangeReader(stores.events, JOURNAL_EVENT_REGISTRY);
    const artifacts = new PostgreSqlArtifactStore(client);
    const ports = { ...stores, events, artifacts, decodeResource };
    return {
      replay: await verifyPartitionReplay(authorization, scope, "diagnostic", ports),
      bundle: await exportReplayBundle(authorization, scope, stores),
    };
  });
  // The connection is closed: the bundle verifies with no database.
  const offline = await verifyReplayBundle(bundle.bytes, { decodeResource });
  return {
    mismatches: replay.mismatches,
    hashes: [replay.liveStateHash, replay.full.stateHash, replay.fromSnapshot?.stateHash],
    suffix: replay.fromSnapshot?.eventsApplied,
    checkpoints: replay.checkpoints.map((checkpoint) => checkpoint.replayed),
    bundle: offline.finalStateHash,
  };
}

/**
 * What `replayOf` returns when everything reaches `hash`: from birth only, or also from a snapshot
 * plus a suffix of `suffix` kernel events and at that snapshot's checkpoint (`checkpoint`).
 */
const reached = (hash: string, snapshot?: { suffix: number; checkpoint: string }) => ({
  mismatches: [],
  hashes: [hash, hash, snapshot === undefined ? undefined : hash],
  suffix: snapshot?.suffix,
  checkpoints: snapshot === undefined ? [] : [snapshot.checkpoint],
  bundle: hash,
});

describe("prior-release database fixtures", () => {
  it("migrate to head keeping every row and event byte, and replay to the recorded hashes", async () => {
    const tags: string[] = await priorReleaseFixtures();
    expect(tags).toContain("wave-2");
    for (const tag of tags) {
      await withDisposableDatabase(async (fixture: DatabaseFixture) => {
        const { manifest, changed, eventBytesDigest } = await migratePriorRelease(fixture, tag);
        expect({ changed, eventBytesDigest, ...(await replayOf(fixture, manifest)) }).toEqual({
          // Migration 0029 retires the snapshots of the old kernel registry; replay runs from birth.
          changed: ["clockgrove.snapshots"],
          eventBytesDigest: manifest.eventBytesDigest,
          ...reached(manifest.finalStateHash),
        });
        // Under the current registry the upgraded database regains a snapshot at the recorded head.
        // A command then appends kernel events above it: replay from the snapshot applies them and
        // reaches the live hash, as full replay and the bundle do, and the snapshot's checkpoint
        // still holds the recorded hash.
        const suffix = await snapshotBelowHead(fixture, manifest);
        expect(suffix).toBeGreaterThan(0);
        const upgraded = await replayOf(fixture, manifest);
        expect(upgraded.hashes[0]).not.toBe(manifest.finalStateHash);
        expect(upgraded).toEqual(
          reached(upgraded.hashes[0]!, { suffix, checkpoint: manifest.finalStateHash }),
        );
        // Migration 0017 backfills one system principal per existing world.
        expect(
          await truthOf(
            fixture,
          )(`SELECT count(*) FILTER (WHERE p.principal_id IS NULL) FROM clockgrove.worlds w
            LEFT JOIN clockgrove.tenant_principals p ON p.tenant_id = w.tenant_id AND p.system_world_id = w.world_id`),
        ).toBe("0");
      });
    }
  }, 120_000);

  it("replays a stored historic kernel event version through its upcaster and refuses an unsupported one", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const { manifest } = await migratePriorRelease(fixture, "wave-2");
      const sql = truthOf(fixture);
      const [id, text] = (
        await sql(`SELECT event_id || '|' || convert_from(event_bytes, 'UTF8') FROM clockgrove.events
                    WHERE event_type = 'routine.selected' ORDER BY journal_position LIMIT 1`)
      ).split(/\|(.*)/su);
      // The first routine.selected event at kernel version `version`, its payload hash resealed.
      const store = async (version: string) => {
        const event = JSON.parse(text!);
        const fields: [string, [string, string]][] = event.payload.kernelEvent[1];
        fields.find(([name]) => name === "schemaVersion")![1][1] = version;
        event.payloadHash = computePayloadHash(event.payload);
        await sql(`SET session_replication_role = replica; UPDATE clockgrove.events
          SET event_bytes = convert_to($e$${JSON.stringify(event)}$e$, 'UTF8') WHERE event_id = '${id}'`);
      };
      await store("1");
      expect(await replayOf(fixture, manifest)).toEqual(reached(manifest.finalStateHash));
      await store("9");
      await expect(replayOf(fixture, manifest)).rejects.toThrow("replay-threw");
    });
  }, 120_000);

  it("refuses an undeclared migration that rewrites a stored event and reports its table once declared", async () => {
    const migrations = await mkdtemp(join(tmpdir(), "clockgrove-lossy-"));
    const lossy = `RESET ROLE; SET LOCAL session_replication_role = replica;
       UPDATE clockgrove.events SET event_bytes = event_bytes || '\\x20'::bytea
        WHERE journal_position = (SELECT max(journal_position) FROM clockgrove.events);`;
    const destroys = [
      "SET LOCAL session_replication_role = replica",
      "UPDATE clockgrove.events SET event_bytes = event_bytes || ''::bytea WHERE journal_position = (SELECT max(journal_position) FROM clockgrove.events)",
    ];
    await writeFile(join(migrations, "9999_lossy.sql"), lossy);
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const options = { migrationDirectory: migrations };
      await expect(migratePriorRelease(fixture, "wave-2", options)).rejects.toThrow(
        `9999_lossy.sql is an undeclared contract step: ${destroys.join("; ")}`,
      );
      await writeFile(
        join(migrations, "contract-steps.json"),
        JSON.stringify({
          "9999_lossy.sql": {
            sha256: createHash("sha256").update(lossy).digest("hex"),
            destroys,
            restorePoint: "the captured wave-2 dump",
            releaseApproval: "#832",
          },
        }),
      );
      const migrated = await migratePriorRelease(fixture, "wave-2", options);
      expect(migrated.changed).toEqual(["clockgrove.events"]);
      expect(migrated.eventBytesDigest).not.toBe(migrated.manifest.eventBytesDigest);
    }).finally(() => rm(migrations, { recursive: true, force: true }));
  }, 120_000);
});
