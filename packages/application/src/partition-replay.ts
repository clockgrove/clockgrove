import { DomainValidationError, replayWorldEvents, type WorldState } from "@clockgrove/domain";

import { decodeCanonicalNode } from "./canonical-node.js";
import { WORLD_KERNEL_EVENT_TYPES } from "./event-registry.js";
import type { JournalRangeReader } from "./journal-reader.js";
import { type RuntimeMetrics, recordMetric } from "./metrics.js";
import { plainValue, worldStateHash } from "./partition-state.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type { CommittedPartitionState, PartitionSnapshotPorts, SnapshotRef } from "./snapshots.js";
import { isSnapshotCompatible, loadPartitionSnapshot, snapshotCompatibility } from "./snapshots.js";
import type { DecodeResource } from "./world-birth.js";
import { reconstructBirthState, reconstructSeedProjectionHash } from "./world-birth.js";
import type { WorldPartitionScope } from "./world-command.js";
import type { WorldProvisioningStore } from "./world-provisioning-ports.js";

const REPLAY_PAGE = 2_000n;
const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set(WORLD_KERNEL_EVENT_TYPES);

/**
 * What a replay reads. `events` reads under its own authorization, whose ceiling must cover every
 * class in the partition: a hidden row is a `sequence-gap`.
 */
export interface PartitionReplayPorts {
  readonly events: JournalRangeReader;
  readonly birth: Pick<WorldProvisioningStore, "readBirth">;
  readonly decodeResource: DecodeResource;
  /**
   * Receives one `replay_events_per_second` point per replay, and `snapshot_age_events` and
   * `replay_mismatches` once per verification.
   */
  readonly metrics?: RuntimeMetrics;
}

/** A verified state to replay from and the partition sequence it covers. */
export interface ReplayStart {
  readonly state: WorldState;
  readonly coveredPartitionSequence: bigint;
  readonly snapshotId?: string;
}

export interface PartitionReplayResult {
  readonly state: WorldState;
  readonly stateHash: string;
  readonly coveredPartitionSequence: bigint;
  readonly eventsApplied: number;
  /** `birth`, or the snapshot ID the replay started from. */
  readonly start: string;
}

export type ReplayIntegrityReason = "birth" | "replay-threw" | "truncated";

/**
 * The stored birth does not reproduce its seed projection hash, the kernel events do not reduce, or the
 * partition ends before the target sequence.
 */
export class ReplayIntegrityError extends Error {
  constructor(
    readonly reason: ReplayIntegrityReason,
    options?: ErrorOptions,
  ) {
    super(`partition replay failed integrity verification (${reason})`, options);
    this.name = "ReplayIntegrityError";
  }
}

/**
 * The world's stored birth as a replay start, verified against its seed projection hash first. The
 * birth state already holds the seed commands, so the replay starts before the first partition event
 * and skips the provisioning events by type.
 */
export async function replayBirth(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  ports: PartitionReplayPorts,
): Promise<ReplayStart> {
  const { birth, seedResources } = await ports.birth.readBirth({
    authorization,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
  });
  if (
    reconstructSeedProjectionHash(birth, seedResources, ports.decodeResource) !==
    birth.seedProjectionHash
  ) {
    throw new ReplayIntegrityError("birth");
  }
  return {
    state: reconstructBirthState(birth, seedResources, ports.decodeResource),
    coveredPartitionSequence: 0n,
  };
}

/**
 * Folds the partition's kernel events after `start` through `to` into the start state. A partition
 * whose head is below `to` throws `ReplayIntegrityError("truncated")`. It writes nothing, so a rerun
 * gives the identical result. Range-read integrity errors propagate unchanged.
 */
export async function replayPartition(
  scope: WorldPartitionScope,
  start: ReplayStart,
  to: bigint,
  ports: PartitionReplayPorts,
): Promise<PartitionReplayResult> {
  const partition = {
    tenantId: scope.tenantId,
    timelineId: scope.timelineId,
    partitionId: scope.partitionId,
  };
  let state = start.state;
  let covered = start.coveredPartitionSequence;
  let eventsApplied = 0;
  const started = Date.now();
  while (covered < to) {
    const last = covered + REPLAY_PAGE < to ? covered + REPLAY_PAGE : to;
    const page = await ports.events.readPartition(partition, { from: covered + 1n, to: last });
    const kernelEvents = page
      .filter((event) => KERNEL_EVENT_TYPES.has(event.type))
      .map((event) =>
        plainValue(decodeCanonicalNode((event.payload as { kernelEvent: never }).kernelEvent)),
      );
    if (kernelEvents.length > 0) {
      try {
        state = replayWorldEvents(state, kernelEvents as never);
      } catch (error) {
        if (error instanceof DomainValidationError)
          throw new ReplayIntegrityError("replay-threw", { cause: error });
        throw error;
      }
    }
    covered += BigInt(page.length);
    eventsApplied += kernelEvents.length;
    if (covered < last) break;
  }
  if (covered < to) throw new ReplayIntegrityError("truncated");
  // Elapsed time spans the page reads (Workers clocks advance only across I/O); floor 1 ms.
  const elapsedMs = Math.max(Date.now() - started, 1);
  recordMetric(ports.metrics, {
    name: "replay_events_per_second",
    tenantId: scope.tenantId,
    worldId: scope.worldId,
    label: start.snapshotId === undefined ? "birth" : "snapshot",
    value: (eventsApplied * 1000) / elapsedMs,
    count: eventsApplied,
  });
  return {
    state,
    stateHash: worldStateHash(state),
    coveredPartitionSequence: covered,
    eventsApplied,
    start: start.snapshotId ?? "birth",
  };
}

/**
 * The latest listed snapshot written under the current compatibility set and below `before` when given.
 * One written under another (by the previous runtime after a registry or pack change) is no replay
 * start, so it is passed over, not refused.
 */
function latestCompatible(
  listed: readonly SnapshotRef[],
  packContentHash: string,
  before?: bigint,
): SnapshotRef | undefined {
  const current = snapshotCompatibility(packContentHash);
  return listed.findLast(
    (ref) =>
      (before === undefined || ref.coveredPartitionSequence < before) &&
      isSnapshotCompatible(ref.compatibility, current),
  );
}

/**
 * Replays a partition to the head `to`: from the latest compatible snapshot covering at most `to`, or
 * else from the stored birth. `packContentHash` is the installed pack's, from `readCommitted`. It writes
 * nothing; a corrupt birth, event or snapshot throws its typed error and no other start is tried.
 */
export async function replayToSequence(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  to: bigint,
  packContentHash: string,
  ports: PartitionReplayPorts & PartitionSnapshotPorts,
): Promise<PartitionReplayResult> {
  const latest = latestCompatible(
    await ports.snapshots.list(authorization, scope, to),
    packContentHash,
  );
  let start: ReplayStart;
  if (latest === undefined) {
    start = await replayBirth(authorization, scope, ports);
  } else {
    const { document } = await loadPartitionSnapshot(authorization, latest, packContentHash, ports);
    start = {
      state: document.state,
      coveredPartitionSequence: latest.coveredPartitionSequence,
      snapshotId: latest.snapshotId,
    };
  }
  return replayPartition(scope, start, to, ports);
}

/** `exact` compares full replay, snapshot replay and the live hash; `diagnostic` also every snapshot. */
export type ReplayMode = "exact" | "diagnostic";

/** A listed snapshot's recorded state hash beside the full replay's at its covered head. */
export interface ReplayCheckpoint {
  readonly snapshotId: string;
  readonly coveredPartitionSequence: bigint;
  readonly expected: string;
  readonly replayed: string;
}

export interface PartitionReplayVerification {
  readonly verified: boolean;
  readonly liveStateHash: string;
  readonly coveredPartitionSequence: bigint;
  readonly full: PartitionReplayResult;
  /** From the latest compatible snapshot below the live head, when there is one. */
  readonly fromSnapshot?: PartitionReplayResult;
  readonly checkpoints: readonly ReplayCheckpoint[];
  /** `full-vs-live`, `snapshot-vs-live` and `checkpoint:<snapshotId>`. */
  readonly mismatches: readonly string[];
}

/**
 * Verifies the live projection by replay and writes nothing. The committed row, read once (or given by
 * a caller that read it), fixes the target head, the live hash and the current pack hash, so concurrent
 * commands cannot race it. Full replay runs from the stored birth; snapshot replay from the latest
 * compatible snapshot below the head plus its suffix. `diagnostic` pauses the full replay at every
 * listed snapshot to compare its recorded hash, which localizes the first divergence. A corrupt birth,
 * event or snapshot throws its typed error; hash disagreements are reported in `mismatches`.
 */
export async function verifyPartitionReplay(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  mode: ReplayMode,
  ports: PartitionReplayPorts & PartitionSnapshotPorts,
  read?: CommittedPartitionState,
): Promise<PartitionReplayVerification> {
  const committed = read ?? (await ports.snapshots.readCommitted(authorization, scope));
  if (committed === undefined) throw new RangeError("the partition has no committed state");
  const target = committed.coveredPartitionSequence;
  const live = committed.stored.stateHash;
  const listed = await ports.snapshots.list(authorization, scope, target);
  const birth = await replayBirth(authorization, scope, ports);
  const checkpoints: ReplayCheckpoint[] = [];
  let reached: PartitionReplayResult | undefined;
  let applied = 0;
  const advance = async (to: bigint): Promise<PartitionReplayResult> => {
    reached = await replayPartition(scope, reached ?? birth, to, ports);
    applied += reached.eventsApplied;
    return reached;
  };
  for (const ref of mode === "diagnostic" ? listed : []) {
    const { stateHash } = await advance(ref.coveredPartitionSequence);
    checkpoints.push({
      snapshotId: ref.snapshotId,
      coveredPartitionSequence: ref.coveredPartitionSequence,
      expected: ref.stateHash,
      replayed: stateHash,
    });
  }
  const full: PartitionReplayResult = {
    ...(await advance(target)),
    eventsApplied: applied,
    start: "birth",
  };
  const latest = latestCompatible(listed, committed.packContentHash, target);
  let fromSnapshot: PartitionReplayResult | undefined;
  if (latest !== undefined) {
    const { document } = await loadPartitionSnapshot(
      authorization,
      latest,
      committed.packContentHash,
      ports,
    );
    const start = {
      state: document.state,
      coveredPartitionSequence: latest.coveredPartitionSequence,
      snapshotId: latest.snapshotId,
    };
    fromSnapshot = await replayPartition(scope, start, target, ports);
  }
  const mismatches = [
    ...(full.stateHash === live ? [] : ["full-vs-live"]),
    ...(fromSnapshot === undefined || fromSnapshot.stateHash === live ? [] : ["snapshot-vs-live"]),
    ...checkpoints
      .filter((entry) => entry.expected !== entry.replayed)
      .map((entry) => `checkpoint:${entry.snapshotId}`),
  ];
  // Snapshot age: how many partition events the latest compatible snapshot trails the head by.
  const newest = latestCompatible(listed, committed.packContentHash);
  const point = { tenantId: scope.tenantId, worldId: scope.worldId } as const;
  recordMetric(ports.metrics, {
    ...point,
    name: "snapshot_age_events",
    label: newest === undefined ? "none" : "snapshot",
    value: Number(target - (newest?.coveredPartitionSequence ?? 0n)),
  });
  recordMetric(ports.metrics, {
    ...point,
    name: "replay_mismatches",
    label: mode,
    value: mismatches.length,
    count: checkpoints.length,
  });
  return {
    verified: mismatches.length === 0,
    liveStateHash: live,
    coveredPartitionSequence: target,
    full,
    ...(fromSnapshot === undefined ? {} : { fromSnapshot }),
    checkpoints,
    mismatches,
  };
}
