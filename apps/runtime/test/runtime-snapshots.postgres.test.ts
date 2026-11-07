import { createHash } from "node:crypto";
import { RUNTIME_METRIC_LABELS, WORLD_KERNEL_EVENT_TYPES } from "@clockgrove/application";
import { describe, expect, it } from "vitest";
import { runtimeBindingManifest } from "../src/cloudflare-entry.js";
import { advanceCommand } from "./world-fixture.js";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/runtime-snapshots.postgres.test.ts";

// issue 843: the runtime composes the R2-backed artifact store, and its snapshot Cron Trigger verifies each
// due partition by exact replay, then snapshots it, in the native workerd/PostgreSQL harness.
describe("runtime snapshots over the R2 artifact store", () => {
  it.skipIf(isNativeWorldOwnerChild())(
    "owns the native runtime and PostgreSQL",
    async () => {
      // Queues are bound so the whole scheduled handler, world-reaction sweep included, succeeds.
      await runNativeWorldOwnerProcess(FILE, "fixture", { queues: true });
    },
    210_000,
  );

  it.skipIf(!isNativeWorldOwnerChild())(
    "spills to R2, and writes and verifies snapshots on the cron sweep",
    async () => {
      await withNativeWorldOwner(async (owner) => {
        const { world, scope, sql } = owner;
        const partitionId = await sql("SELECT partition_id FROM clockgrove.timeline_partitions");
        // Every Analytics Engine point the composed metrics write, drained as the test goes.
        type Point = Record<"blobs" | "doubles" | "indexes", readonly (string | number)[]>;
        const seen: Point[] = [];
        const recorded = async () => {
          const points = (await owner.request("/snapshots/metrics", {})).body as Point[];
          seen.push(...points);
          return points;
        };
        const named = (points: readonly Point[], name?: string) =>
          points
            .filter(({ blobs }) => name === undefined || blobs[0] === name)
            .map(({ blobs }) => `${blobs[0]}:${blobs[3]}`);
        const artifact = async (body: Readonly<Record<string, string>>) =>
          (
            await owner.request("/artifacts", {
              ...scope,
              partitionId,
              artifactId: "r2-spill",
              privacyClass: "public_scene",
              ...body,
            })
          ).body;
        // One byte over the 128 KiB inline limit (migration 0012).
        const text = JSON.stringify({ pad: "x".repeat(131_063) });
        expect(text.length).toBe(131_073);
        const hash = createHash("sha256").update(text).digest("hex");
        const key = `durable/${Buffer.from(scope.tenantId).toString("hex")}/sha256/${hash}`;
        expect(await artifact({ op: "put", text })).toMatchObject({
          result: { contentHash: `sha256:${hash}`, byteLength: 131_073, encryption: "none" },
        });
        expect(
          await sql(
            "SELECT storage_key || '|' || (inline_content IS NULL) FROM clockgrove.artifact_references WHERE artifact_id = 'r2-spill'",
          ),
        ).toBe(`${key}|true`);
        expect(await artifact({ op: "get" })).toEqual({ result: text });
        expect(await artifact({ op: "get", reader: "tenant-other" })).toEqual({
          error: "ArtifactNotFoundError",
          reason: null,
        });
        // No keyring is bound: a private class is refused, never stored unencrypted.
        expect(
          await artifact({ op: "put", artifactId: "private", privacyClass: "conversation", text }),
        ).toEqual({ error: "ArtifactKeyUnavailableError", reason: null });
        await artifact({ op: "corrupt", key, text: text.replace("x", "y") });
        expect(await artifact({ op: "get" })).toEqual({
          error: "ArtifactIntegrityError",
          reason: "hash",
        });
        expect(await sql("SELECT count(*) FROM clockgrove.artifact_references")).toBe("1");
        // The composed store records the spill's size, the other tenant's refused read and the corrupt object.
        expect(
          (await recorded()).map(({ blobs, doubles }) => [blobs[0], blobs[3], doubles[0]]),
        ).toEqual([
          ["artifact_bytes", "spill", 131_073],
          ["rls_denials", "artifact_read", 1],
          ["artifact_integrity_failures", "hash", 1],
        ]);

        const command = async (key: string, after: bigint) =>
          expect(
            (
              await owner.submit(
                advanceCommand(world, key, world.birth.state.simulationTime + after, null),
              )
            ).status,
          ).toBe(200);
        const counts = (written: number, verificationFailures = 0, partitionFailures = 0) => ({
          written,
          notQuiescent: 0,
          verificationFailures,
          partitionFailures,
          deferred: 0,
        });
        const cron = async () => {
          expect(await owner.reconcileDispatches(runtimeBindingManifest.crons.snapshots)).toEqual({
            outcome: "ok",
            noRetry: false,
          });
          const status = await owner.request("/catch-up/reconciliation-status", {});
          return (status.body as { readonly result: { readonly snapshots: unknown } }).result
            .snapshots;
        };
        // The same sweep the cron runs, due as soon as the head moves at all.
        const sweep = async () => (await owner.request("/snapshots/sweep", { interval: "1" })).body;
        const covered = () =>
          sql(
            "SELECT string_agg(covered_partition_sequence || '|' || state_hash, ',' ORDER BY covered_partition_sequence) FROM clockgrove.snapshots",
          );
        const live = () =>
          sql("SELECT covered_head_sequence || '|' || state_hash FROM clockgrove.partition_states");
        const kernelEvents = (above: string) =>
          sql(
            `SELECT count(*) FROM clockgrove.events WHERE partition_sequence > ${above} AND event_type = ANY (ARRAY['${WORLD_KERNEL_EVENT_TYPES.join("','")}'])`,
          );
        const replaysOf = (points: readonly Point[]) =>
          points
            .filter(({ blobs }) => blobs[0] === "replay_events_per_second")
            .map(({ blobs, doubles }) => `${blobs[3]}:${doubles[1]}`);
        const replays = async () => replaysOf(await recorded());
        const verification = async () => named(await recorded(), "snapshot_verification").at(-1);

        await command("snapshot-1", 60_000n);
        await command("snapshot-2", 120_000n);
        // No snapshot yet: the cron sweep replays from birth, then snapshots the live head. The one
        // sweep records replay, snapshot and artifact metrics through the composed METRICS.
        expect(await cron()).toEqual(counts(1));
        const first = await live();
        expect(await covered()).toBe(first);
        const swept = await recorded();
        expect(replaysOf(swept)).toEqual([`birth:${await kernelEvents("0")}`]);
        expect(named(swept)).toEqual([
          "replay_events_per_second:birth",
          "snapshot_age_events:none",
          "replay_mismatches:exact",
          "snapshot_verification:verified",
          "artifact_bytes:inline",
          "snapshot_bytes:written",
          "snapshot_create_ms:written",
        ]);
        // At the same head the next sweep writes nothing.
        expect(await cron()).toEqual(counts(0));
        expect(await covered()).toBe(first);
        // Snapshot plus suffix reproduces the live hash (any mismatch would fail verification).
        await command("snapshot-3", 180_000n);
        expect(await sweep()).toEqual(counts(1));
        expect(await replays()).toEqual([
          `birth:${await kernelEvents("0")}`,
          `snapshot:${await kernelEvents(first.split("|")[0]!)}`,
        ]);
        const second = await live();
        expect(await covered()).toBe(`${first},${second}`);
        // Emptied as migration 0029 does, the index regains a snapshot on the next cron.
        await sql("DELETE FROM clockgrove.snapshots");
        expect(await cron()).toEqual(counts(1));
        expect(await covered()).toBe(second);
        const rewrite = (from: string, to: string) =>
          sql(`UPDATE clockgrove.artifact_references AS a SET inline_content = t.bytes,
                 content_hash = 'sha256:' || encode(sha256(t.bytes), 'hex')
                 FROM (SELECT artifact_id, convert_to(replace(convert_from(inline_content, 'UTF8'), '${from}', '${to}'), 'UTF8') AS bytes
                         FROM clockgrove.artifact_references WHERE artifact_id LIKE 'snapshot:%') AS t
                WHERE a.artifact_id = t.artifact_id`);

        // A snapshot under another kernel registry, as the previous runtime writes before the deploy,
        // is passed over, not reported: once the head moves past it, the next run snapshots again.
        const registry = await sql(
          "SELECT compatibility->>'kernelRegistryHash' FROM clockgrove.snapshots",
        );
        await rewrite(registry, "0".repeat(64));
        await sql(`SET session_replication_role = replica; UPDATE clockgrove.snapshots
          SET compatibility = jsonb_set(compatibility, '{kernelRegistryHash}', '"${"0".repeat(64)}"')`);
        await command("snapshot-4", 240_000n);
        await replays();
        expect(await sweep()).toEqual(counts(1));
        expect(await replays()).toEqual([`birth:${await kernelEvents("0")}`]);
        const third = await live();
        expect(await covered()).toBe(`${second},${third}`);

        // An open continuation is not due: no replay runs at its head.
        await command("snapshot-5", 300_000n);
        const continuation = (value: string, hash: string, id: string) =>
          sql(`UPDATE clockgrove.partition_states
                 SET continuation = ${value}, continuation_hash = ${hash}, continuation_command_id = ${id}`);
        await continuation("'[]'", `'${"0".repeat(64)}'`, "'open'");
        expect(await sweep()).toEqual(counts(0));
        expect(await replays()).toEqual([]);
        await continuation("NULL", "NULL", "NULL");

        // Four partitions that fail on every run (no route stream) and are far more behind take turns:
        // each pick is stamped, so the next run reaches this partition, attempted longer ago.
        await sql(`SET session_replication_role = replica;
          CREATE TEMP TABLE stuck AS SELECT state.*, n FROM clockgrove.partition_states AS state,
            generate_series(1, 4) AS n;
          UPDATE stuck SET partition_id = partition_id || '-stuck-' || n, space_id = space_id || '-stuck-' || n,
            covered_head_sequence = covered_head_sequence + 100000, snapshot_attempted_at = NULL;
          ALTER TABLE stuck DROP COLUMN n;
          INSERT INTO clockgrove.partition_states SELECT * FROM stuck`);
        expect(await sweep()).toEqual(counts(0, 0, 4));
        expect(await sweep()).toEqual(counts(1, 0, 3));
        await sql(`SET session_replication_role = replica;
          DELETE FROM clockgrove.partition_states WHERE partition_id LIKE '%-stuck-%'`);
        const before = `${second},${third},${await live()}`;
        expect(await covered()).toBe(before);

        // A tampered snapshot, then a tampered event, fails verification: reported, nothing written.
        await command("snapshot-6", 360_000n);
        await rewrite("clockgrove.partition-state", "clockgrove.partition-statf");
        expect(await sweep()).toEqual(counts(0, 1));
        expect(await verification()).toBe("snapshot_verification:snapshot");
        await rewrite("clockgrove.partition-statf", "clockgrove.partition-state");
        // The latest event's payload changes under its recorded payload hash.
        await sql(`SET session_replication_role = replica; UPDATE clockgrove.events
          SET event_bytes = convert_to(replace(convert_from(event_bytes, 'UTF8'),
            'action-snapshot-6', 'action-snapshot-x'), 'UTF8')
          WHERE journal_position = (SELECT max(journal_position) FROM clockgrove.events)`);
        expect(await sweep()).toEqual(counts(0, 1));
        expect(await verification()).toBe("snapshot_verification:journal");
        expect(await covered()).toBe(before);
        // Every point has the shape analyticsEngineMetrics writes and a label from its closed set.
        const labels: Readonly<Record<string, readonly string[]>> = RUNTIME_METRIC_LABELS;
        expect(seen.length).toBeGreaterThan(20);
        expect(
          seen.filter(
            ({ blobs, doubles, indexes }) =>
              blobs.length !== 4 ||
              doubles.length !== 2 ||
              indexes.join() !== blobs[1] ||
              !labels[String(blobs[0])]?.includes(String(blobs[3])),
          ),
        ).toEqual([]);
        const reports = () =>
          owner.logs().filter((log) => log.includes("partition_replay_verification_failed"));
        for (let attempt = 0; attempt < 300 && reports().length < 2; attempt++)
          await sql("SELECT pg_sleep(0.01)");
        expect(
          reports().map((log) => [
            log.match(/integrityCheck: '(\w+)'/u)?.[1],
            log.includes(`partitionId: '${partitionId}'`),
            log.includes("disposition: 'reported-not-repaired'"),
          ]),
        ).toEqual([
          ["snapshot", true, true],
          ["journal", true, true],
        ]);
      });
    },
    120_000,
  );
});
