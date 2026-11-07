import { QUEUE_CHANNELS, type SceneRecoveryReason } from "@clockgrove/contracts";

import type { ArtifactIntegrityFailure } from "./artifacts.js";
import { isTrustedId } from "./authority-decision.js";
import type { JournalRevisionConflictKind } from "./journal.js";
import type { PartitionIntegrityCheck, RuntimeFailureClass } from "./logging.js";
import { isClockCommand } from "./timeline-clock.js";

const COMMAND_FAMILIES = ["world", "clock", "autonomous"] as const;
const CONFLICT_KINDS = [
  "stream",
  "partition",
  "routing-epoch",
  "clock-policy",
  "owner-generation",
] as const satisfies readonly JournalRevisionConflictKind[];
/** The kinds of work a physical owner admits through its mailbox (`OwnerMailboxEntryKind`). */
const OWNER_ENTRY_KINDS = [
  "command",
  "resume",
  "inspect",
  "alarm",
  "reconcile-alarm",
  "catch-up",
] as const;

/**
 * The live service metrics: the Wave 2 §16 signals that no `*_answered` log record carries (issue 701,
 * issue 846; Wave 3 §20), the Wave 3 §20 runtime signals and the Wave 4 §17 scene-delivery
 * signals, each with its closed label set. The scene signals carry opaque tenant and world
 * IDs and action categories only, never principals, payloads or text.
 * Telemetry is not canonical: a lost or refused point changes nothing, and the inspector stays
 * useful without it.
 */
export const RUNTIME_METRIC_LABELS = {
  journal_latency_ms: COMMAND_FAMILIES,
  lock_wait_ms: COMMAND_FAMILIES,
  command_events_written: COMMAND_FAMILIES,
  command_projection_rows_written: COMMAND_FAMILIES,
  command_schedules_written: COMMAND_FAMILIES,
  command_dispatches_written: COMMAND_FAMILIES,
  transaction_retries: [
    "revision_conflict",
    "continuation_pending",
    "catching_up",
  ] as const satisfies readonly RuntimeFailureClass[],
  autonomous_conflicts: CONFLICT_KINDS,
  dispatch_backlog_age_ms: QUEUE_CHANNELS,
  replay_events_per_second: ["birth", "snapshot"],
  replay_mismatches: ["exact", "diagnostic"],
  snapshot_age_events: ["snapshot", "none"],
  snapshot_verification: [
    "verified",
    "mismatch",
    "replay",
    "snapshot",
    "artifact",
    "journal",
  ] as const satisfies readonly ("verified" | "mismatch" | PartitionIntegrityCheck)[],
  snapshot_bytes: ["written"],
  snapshot_create_ms: ["written"],
  artifact_bytes: ["inline", "spill"],
  artifact_integrity_failures: [
    "missing",
    "size",
    "hash",
    "decrypt",
  ] as const satisfies readonly ArtifactIntegrityFailure[],
  rls_denials: ["artifact_read", "artifact_write"],
  projection_lag_ms: ["partition-state"],
  alarm_lateness_ms: ["planned", "recovery"],
  alarm_batch_ms: ["drained", "refused", "continued", "catch-up"],
  catch_up_step_ms: ["continue", "complete", "superseded", "failed"],
  owner_initializations: ["rehydrated", "reconciled", "unchanged"],
  mailbox_wait_ms: OWNER_ENTRY_KINDS,
  mailbox_service_ms: OWNER_ENTRY_KINDS,
  activation_commands: OWNER_ENTRY_KINDS,
  activation_journal_ms: OWNER_ENTRY_KINDS,
  activation_db_transactions: OWNER_ENTRY_KINDS,
  scene_admissions: ["admitted", "refused"],
  /** Milliseconds from admission to the socket's first projection frame; the label is its type. */
  scene_handshake_ms: ["snapshot", "patch"],
  scene_revision: ["current", "acknowledged"],
  /** Wire bytes (string length) of the frames of that type in one fanout turn; count is frames. */
  scene_patch_bytes: ["snapshot", "patch"],
  /** Sockets sent a frame in one fanout turn, per lane. */
  scene_fanout_recipients: ["projection", "operator"],
  /** Deliveries in one fanout turn, by the privacy category their decided audience includes. */
  scene_audience_decisions: ["public_scene", "private_cognition"],
  scene_recovery: [
    "snapshot_required",
    "revision_unavailable",
    "asset_manifest_changed",
    "backpressure",
    "runtime_restarted",
  ] as const satisfies readonly SceneRecoveryReason[],
} as const;

export type RuntimeMetricName = keyof typeof RUNTIME_METRIC_LABELS;

/**
 * One measurement. `label` is from its metric's closed set (`RUNTIME_METRIC_LABELS`), never caller
 * text, so dimension cardinality stays bounded by tenants and worlds.
 */
export type RuntimeMetricPoint = {
  readonly [Name in RuntimeMetricName]: {
    readonly name: Name;
    readonly tenantId: string;
    readonly worldId: string;
    readonly label: (typeof RUNTIME_METRIC_LABELS)[Name][number];
    readonly value: number;
    /** The quantity behind the value (events, rows, dispatches, simulated ms), when it has one. */
    readonly count?: number;
  };
}[RuntimeMetricName];

/** Provider-neutral metrics port. `record` is synchronous and must never throw into its caller. */
export interface RuntimeMetrics {
  record(point: RuntimeMetricPoint): void;
}

export const NO_METRICS: RuntimeMetrics = Object.freeze({ record: () => undefined });

/** Keeps every point; for local runs and tests. */
export class InMemoryRuntimeMetrics implements RuntimeMetrics {
  readonly points: RuntimeMetricPoint[] = [];
  record(point: RuntimeMetricPoint): void {
    this.points.push(point);
  }
}

/** Records one point when a sink is given. A sink that throws loses the point, never the work. */
export function recordMetric(metrics: RuntimeMetrics | undefined, point: RuntimeMetricPoint): void {
  try {
    metrics?.record(point);
  } catch {
    /* Telemetry is not canonical. */
  }
}

/** The closed command-family label: clock controls, trusted owner work, or world commands. */
export function commandFamily(command: {
  readonly type: string;
  readonly commandId: string;
}): (typeof COMMAND_FAMILIES)[number] {
  if (isClockCommand(command.type)) return "clock";
  return isTrustedId(command.commandId) ? "autonomous" : "world";
}
