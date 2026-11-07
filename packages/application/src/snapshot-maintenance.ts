import { ArtifactIntegrityError } from "./artifacts.js";
import { JournalReadIntegrityError } from "./journal-reader.js";
import { type PartitionIntegrityCheck, type RuntimeLogger, runtimeLogRecord } from "./logging.js";
import { recordMetric } from "./metrics.js";
import {
  type PartitionReplayPorts,
  ReplayIntegrityError,
  verifyPartitionReplay,
} from "./partition-replay.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import {
  createPartitionSnapshot,
  type PartitionSnapshotPorts,
  SnapshotIncompatibleError,
  SnapshotIntegrityError,
} from "./snapshots.js";
import type { WorldPartitionScope } from "./world-command.js";

export type PartitionMaintenance = "written" | "not-quiescent" | "verification-failed";

/** The typed error that stopped verification (the hash mismatches are reported, not thrown). */
type IntegrityFailure = Exclude<PartitionIntegrityCheck, "full-vs-live" | "snapshot-vs-live">;

function integrityCheck(error: unknown): IntegrityFailure | undefined {
  if (error instanceof ReplayIntegrityError) return "replay";
  if (error instanceof SnapshotIntegrityError || error instanceof SnapshotIncompatibleError)
    return "snapshot";
  if (error instanceof ArtifactIntegrityError) return "artifact";
  if (error instanceof JournalReadIntegrityError) return "journal";
  return undefined;
}

/**
 * One partition's scheduled maintenance, never inside a journal transaction and never writing
 * canonical state. It reads the committed partition once. An open continuation is `not-quiescent`
 * before any replay, retried on a later run. Otherwise that read is verified by `exact` replay (full
 * replay from birth, and the latest compatible snapshot below the head plus its suffix, against the
 * live hash), and only a verified read is snapshotted, at exactly the head it verified; commands
 * committed meanwhile wait for a later snapshot. A hash mismatch or a typed integrity error is logged
 * as `partition_replay_verification_failed` with the partition's opaque IDs and writes no snapshot:
 * nothing is repaired, and the partition stays due, so a later run reports it again. Any other error
 * propagates to the caller. Each verification's result goes to `snapshot_verification`.
 */
export async function maintainPartitionSnapshot(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  ports: PartitionReplayPorts & PartitionSnapshotPorts,
  logger: RuntimeLogger,
): Promise<PartitionMaintenance> {
  const verification = (label: "verified" | "mismatch" | IntegrityFailure) =>
    recordMetric(ports.metrics, {
      name: "snapshot_verification",
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      label,
      value: 1,
    });
  const report = (check: PartitionIntegrityCheck, error?: unknown) =>
    logger.log(
      runtimeLogRecord(
        "error",
        "partition_replay_verification_failed",
        {
          tenantId: scope.tenantId,
          worldId: scope.worldId,
          timelineId: scope.timelineId,
          partitionId: scope.partitionId,
          failureClass: "integrity",
          integrityCheck: check,
          disposition: "reported-not-repaired",
        },
        error,
      ),
    );
  let verified = false;
  try {
    const committed = await ports.snapshots.readCommitted(authorization, scope);
    if (committed === undefined) throw new RangeError("the partition has no committed state");
    if (committed.continuationOpen) return "not-quiescent";
    const replay = await verifyPartitionReplay(authorization, scope, "exact", ports, committed);
    if (!replay.verified) {
      verification("mismatch");
      // `exact` reports only these two; checkpoints belong to `diagnostic`.
      for (const mismatch of replay.mismatches) report(mismatch as PartitionIntegrityCheck);
      return "verification-failed";
    }
    verification("verified");
    verified = true;
    await createPartitionSnapshot(authorization, scope, ports, committed);
    return "written";
  } catch (error) {
    const check = integrityCheck(error);
    if (check === undefined) throw error;
    // One point per verification: a snapshot that fails its own check after a verified replay is
    // reported in the log record only.
    if (!verified) verification(check);
    report(check, error);
    return "verification-failed";
  }
}
