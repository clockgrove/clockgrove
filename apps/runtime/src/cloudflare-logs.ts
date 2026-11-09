import {
  type RuntimeLogFields,
  type RuntimeLogger,
  type RuntimeLogRecord,
  runtimeLogRecord,
} from "@clockgrove/application";

/**
 * Writes each record as one object to `console`, which Workers Logs indexes field by field
 * ("Logging structured JSON objects",
 * https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and Logpush exports
 * in `workers_trace_events` `Logs`. Enabled by `observability` in `infra/wrangler/*.json`.
 */
export const consoleRuntimeLogger: RuntimeLogger = Object.freeze({
  log(record: RuntimeLogRecord) {
    try {
      if (record.level === "error") console.error(record);
      else if (record.level === "warn") console.warn(record);
      else console.log(record);
    } catch {
      /* Dropped: logs are not canonical. */
    }
  },
});

type QueueFailureClass = "malformed" | "inconsistent" | "transient" | "internal";

/** Queue failures carry transport metadata only; private envelopes remain in the physical DLQ. */
export function logQueueDeliveryFailure(
  logger: RuntimeLogger,
  channel: NonNullable<RuntimeLogFields["channel"]>,
  transportMessageId: string,
  attempt: number,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("warn", "world_reactions_delivery_failed", {
      channel,
      transportMessageId,
      failureClass,
      attempt,
      disposition: "retry-or-dlq",
    }),
  );
}

/**
 * Alert: a message's last delivery attempt failed, so the Queue moves it to its physical DLQ. Only
 * transport identity is logged, as for every delivery failure; the runtime-state inspection shows the
 * message's semantic ID where its identity resolves.
 */
export function logQueueDeadLetter(
  logger: RuntimeLogger,
  channel: NonNullable<RuntimeLogFields["channel"]>,
  transportMessageId: string,
  attempt: number,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("error", "world_reactions_dead_lettered", {
      channel,
      transportMessageId,
      failureClass,
      attempt,
      disposition: "awaiting-replay",
    }),
  );
}

/**
 * Alert: a world-reactions publication used its whole attempt budget and stays `failed` until an
 * operator repairs it. Its IDs are canonical (the dispatch row), so its message ID is logged.
 */
export function logPublicationFailure(
  logger: RuntimeLogger,
  ids: Pick<RuntimeLogFields, "tenantId" | "worldId" | "timelineId" | "messageId">,
  attempt: number,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("error", "world_reactions_publication_failed", {
      ...ids,
      channel: "world-reactions",
      attempt,
      failureClass,
      disposition: "awaiting-repair",
    }),
  );
}

/** One principal's publication sweep failed; its rows stay due. Only the error class is logged. */
export function logWorldReactionSweepFailure(
  logger: RuntimeLogger,
  trigger: "hint" | "cron",
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("warn", "world_reactions_sweep_failed", {
      channel: "world-reactions",
      trigger,
      failureClass,
      disposition: "recovered-by-cron",
    }),
  );
}

/**
 * One post-commit activation hint pass for a world timeline failed. The actors it would have woken
 * still read the events at their quiet poll. Only the timeline's opaque IDs and the error class are
 * logged.
 */
export function logActivationHintFailure(
  logger: RuntimeLogger,
  ids: Pick<RuntimeLogFields, "tenantId" | "worldId" | "timelineId">,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("warn", "activation_hint_failed", {
      ...ids,
      failureClass,
      disposition: "recovered-by-poll",
    }),
  );
}

/**
 * One partition's scheduled verification or snapshot failed for a reason other than integrity; it
 * stays due and the next cron retries it. Only its opaque IDs and the error class are logged.
 */
export function logPartitionSnapshotFailure(
  logger: RuntimeLogger,
  ids: Pick<RuntimeLogFields, "tenantId" | "worldId" | "timelineId" | "partitionId">,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord("warn", "partition_snapshot_failed", {
      ...ids,
      failureClass,
      disposition: "retried-by-cron",
    }),
  );
}

/**
 * One open Workflow case could not be reconciled by cron; it stays open. Only its accepted
 * operation's opaque identity and the error class are logged.
 */
export function logWorkflowReconcileFailure(
  logger: RuntimeLogger,
  event: "world_provisioning_reconcile_failed" | "world_catch_up_reconcile_failed",
  ids: Pick<RuntimeLogFields, "tenantId" | "worldId" | "timelineId" | "spaceId" | "runId">,
  failureClass: QueueFailureClass,
): void {
  logger.log(
    runtimeLogRecord(event === "world_provisioning_reconcile_failed" ? "warn" : "error", event, {
      ...ids,
      failureClass,
      disposition: "retried-by-cron",
    }),
  );
}
