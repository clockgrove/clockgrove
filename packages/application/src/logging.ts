/**
 * Structured server logs (Wave 0 §14, Wave 3 §20). A record names its event from a closed,
 * versioned set and carries only opaque IDs, closed codes and numbers, never payloads, headers,
 * credentials, display names or caller text. Logs are not canonical: a lost record changes nothing.
 */

/**
 * Version of the record shape and event set below. Bump it when an event or field is added,
 * removed or changes meaning, so a Workers Logs query can tell the shapes apart.
 * 1: the four server-failure events. 2: answered requests, Queue and Workflow envelopes, adapter
 * calls, failure classes and release identity. 3: the scheduled snapshot sweep's two events, with
 * `partitionId` and `integrityCheck`. 4 was assigned twice, on parallel branches, to different sets
 * (answered scene observations and their server failures; the runtime-state inspection and operator
 * action routes' events, the two world-reactions alert events, and `messageId`). 5: the union of
 * both, so a version-5 record's shape is unambiguous. 6: `activation_hint_failed` and its
 * `recovered-by-poll` disposition.
 */
export const RUNTIME_LOG_SCHEMA_VERSION = 6;

export type RuntimeLogEvent =
  // A server failure, written once by the component that caught its cause.
  | "world_command_failed"
  | "noop_command_failed"
  | "world_owner_failed"
  | "causal_chain_inspection_failed"
  | "runtime_state_inspection_failed"
  | "runtime_action_failed"
  | "scene_observation_failed"
  // One record per answered runtime request, written by the Worker.
  | "world_command_answered"
  | "noop_command_answered"
  | "causal_chain_inspection_answered"
  | "runtime_state_inspection_answered"
  | "runtime_action_answered"
  | "scene_observation_answered"
  // Queue deliveries and scheduled Queue and Workflow recovery.
  | "world_reactions_delivery_failed"
  | "world_reactions_sweep_failed"
  // A post-commit activation hint pass failed; the actors' quiet polls still read its events.
  | "activation_hint_failed"
  // Alert signals: a terminal failure no retry recovers, which waits for an operator action.
  | "world_reactions_dead_lettered"
  | "world_reactions_publication_failed"
  | "world_provisioning_reconcile_failed"
  | "world_catch_up_reconcile_failed"
  // The scheduled snapshot sweep: a partition whose replay does not reproduce its live state, and
  // any other failure of one partition's verification or snapshot.
  | "partition_replay_verification_failed"
  | "partition_snapshot_failed"
  // A model, tool or MCP adapter call exercised by a fixture.
  | "capability_adapter_called";

export type RuntimeLogLevel = "info" | "warn" | "error";

/** The canonical environments (`PROVIDER_ENVIRONMENT`); anything else is `unconfigured`. */
export type RuntimeLogEnvironment =
  | "local"
  | "ci"
  | "development"
  | "staging"
  | "production"
  | "unconfigured";

/** How a request's authorization ended. `not_evaluated`: answered before authorization. */
export type RuntimeAuthorizationResult =
  | "authorized"
  | "denied"
  | "unauthenticated"
  | "not_evaluated";

/**
 * What became of a request, delivery or adapter call. `committed`: a new receipt; `rejected`: a
 * new rejected receipt (a domain refusal or a recorded denial); `replayed`: the stored outcome of an
 * exact retry; `conflict`: a revision, epoch or idempotency conflict, nothing written; `refused`:
 * answered before any command ran; `unavailable`: try again later; `failed`: a server failure;
 * `read`: an inspection answered; `succeeded`: an adapter call returned an accepted output.
 */
export type RuntimeLogOutcome =
  | "committed"
  | "rejected"
  | "replayed"
  | "conflict"
  | "refused"
  | "unavailable"
  | "failed"
  | "read"
  | "succeeded";

/** The stable error code a runtime response returned. */
export type RuntimeResponseCode =
  | "authentication_refused"
  | "authorization_refused"
  | "invalid_noop_command"
  | "invalid_world_command"
  | "invalid_inspection_request"
  | "stale_epoch"
  | "noop_command_conflict"
  | "world_command_conflict"
  | "command_id_reused"
  | "world_continuation_pending"
  | "world_not_ready"
  | "space_not_found"
  | "command_not_found"
  | "event_not_found"
  | "schedule_not_found"
  | "run_not_found"
  | "manifest_not_found"
  | "document_not_found"
  | "inspection_rate_limited"
  | "world_catching_up"
  | "owner_unavailable"
  | "owner_mailbox_full"
  | "owner_mailbox_expired"
  | "owner_mailbox_timeout"
  | "inspector_unavailable"
  | "durable_state_corrupt"
  | "noop_command_failed"
  | "world_command_failed"
  | "inspection_failed"
  | "invalid_runtime_action"
  | "message_not_found"
  | "publication_not_failed"
  | "message_not_published"
  | "runtime_action_rate_limited"
  | "runtime_action_unavailable"
  | "runtime_action_failed";

/**
 * A failure's class, from typed errors and structured driver codes, never exception text. The
 * first group classifies commands and SQL transactions; the second, Queue deliveries.
 */
export type RuntimeFailureClass =
  | "revision_conflict"
  | "epoch_conflict"
  | "idempotency_conflict"
  | "continuation_pending"
  | "catching_up"
  | "lock_timeout"
  | "statement_timeout"
  | "idle_timeout"
  | "serialization_failure"
  | "database_unavailable"
  | "owner_unavailable"
  | "owner_mailbox"
  | "integrity"
  | "internal"
  | "malformed"
  | "inconsistent"
  | "transient";

/**
 * Whether a later attempt of the same work may succeed. Conflicts, timeouts and unavailability
 * wrote nothing (or, for an unavailable owner, an exact retry returns the stored outcome); a reused
 * command ID, corrupt state, a defect, or a malformed or inconsistent envelope never will.
 */
export const RUNTIME_FAILURE_RETRYABLE: Readonly<Record<RuntimeFailureClass, boolean>> = {
  revision_conflict: true,
  epoch_conflict: true,
  idempotency_conflict: false,
  continuation_pending: true,
  catching_up: true,
  lock_timeout: true,
  statement_timeout: true,
  idle_timeout: true,
  serialization_failure: true,
  database_unavailable: true,
  owner_unavailable: true,
  owner_mailbox: true,
  integrity: false,
  internal: false,
  malformed: false,
  inconsistent: false,
  transient: true,
};

/**
 * `full-vs-live` and `snapshot-vs-live` are `verifyPartitionReplay` mismatches; the rest name the
 * typed error that stopped verification: the stored birth or the event fold (`replay`), a snapshot
 * (`snapshot`, also an incompatible one), its artifact bytes (`artifact`) or an event read (`journal`).
 */
export type PartitionIntegrityCheck =
  | "full-vs-live"
  | "snapshot-vs-live"
  | "replay"
  | "snapshot"
  | "artifact"
  | "journal";

/** The record's identity, each field where known. Opaque IDs only. */
export interface RuntimeLogIds {
  readonly tenantId?: string | undefined;
  readonly worldId?: string | undefined;
  readonly timelineId?: string | undefined;
  readonly spaceId?: string | undefined;
  readonly partitionId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly commandId?: string | undefined;
  /** An application run: a capability run or a Workflow's accepted operation. */
  readonly runId?: string | undefined;
  /** The Queue's own message ID; untrusted envelope IDs are never logged. */
  readonly transportMessageId?: string | undefined;
  /** A world-reactions message's semantic ID (its dispatch ID): canonical, or an operator's target. */
  readonly messageId?: string | undefined;
}

/** Every field a record may carry besides its event, level and time. Closed values only. */
export interface RuntimeLogFields extends RuntimeLogIds {
  readonly authorization?: RuntimeAuthorizationResult | undefined;
  readonly outcome?: RuntimeLogOutcome | undefined;
  readonly code?: RuntimeResponseCode | undefined;
  readonly status?: number | undefined;
  /** The request's routing epoch; its authority epoch is equal. */
  readonly routingEpoch?: number | undefined;
  /** The partition revision a committed or replayed world command left. */
  readonly revision?: number | undefined;
  readonly failureClass?: RuntimeFailureClass | undefined;
  readonly channel?: "world-reactions" | "cognitive-indexing" | "external-effects" | undefined;
  readonly attempt?: number | undefined;
  readonly trigger?: "hint" | "cron" | undefined;
  readonly disposition?:
    | "retry-or-dlq"
    | "recovered-by-cron"
    | "recovered-by-poll"
    | "retried-by-cron"
    | "reported-not-repaired"
    | "awaiting-replay"
    | "awaiting-repair"
    | undefined;
  /** Which replay verification failed: a hash comparison, or the source of a typed integrity error. */
  readonly integrityCheck?: PartitionIntegrityCheck | undefined;
  readonly port?: "model" | "tool" | "mcp" | undefined;
  readonly step?: number | undefined;
}

export interface RuntimeLogRecord extends RuntimeLogFields {
  readonly schemaVersion: typeof RUNTIME_LOG_SCHEMA_VERSION;
  readonly level: RuntimeLogLevel;
  readonly event: RuntimeLogEvent;
  /** ISO 8601 wall time of the record. */
  readonly timestamp: string;
  /** Derived from `failureClass` by `RUNTIME_FAILURE_RETRYABLE`. */
  readonly retryable?: boolean;
  /** The release the runtime is composed with, stamped by `releaseRuntimeLogger`. */
  readonly codeVersion?: string;
  readonly environment?: RuntimeLogEnvironment;
  /** A server failure's class name and redacted, capped message and stack. */
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string };
}

/** Provider-neutral logging port. `log` is synchronous and must never throw into its caller. */
export interface RuntimeLogger {
  log(record: RuntimeLogRecord): void;
}

/** Keeps every record; for local runs and tests. */
export class InMemoryRuntimeLogger implements RuntimeLogger {
  readonly records: RuntimeLogRecord[] = [];
  log(record: RuntimeLogRecord): void {
    this.records.push(record);
  }
}

const RUNTIME_ENVIRONMENTS: readonly string[] = [
  "local",
  "ci",
  "development",
  "staging",
  "production",
];

/**
 * Stamps every record with the release and environment the runtime is composed with. Composition
 * roots wrap their sink in it once, so no writer can omit or vary the identity.
 */
export function releaseRuntimeLogger(
  sink: RuntimeLogger,
  release: { readonly codeVersion: string; readonly environment: string | undefined },
): RuntimeLogger {
  const environment = (
    RUNTIME_ENVIRONMENTS.includes(release.environment ?? "") ? release.environment : "unconfigured"
  ) as RuntimeLogEnvironment;
  const codeVersion = release.codeVersion;
  return Object.freeze({
    log(record: RuntimeLogRecord) {
      try {
        sink.log({ ...record, codeVersion, environment });
      } catch {
        /* Dropped: logs are not canonical. */
      }
    },
  });
}

const STRING_FIELDS = [
  "tenantId",
  "worldId",
  "timelineId",
  "spaceId",
  "partitionId",
  "correlationId",
  "requestId",
  "commandId",
  "runId",
  "transportMessageId",
  "messageId",
  "authorization",
  "outcome",
  "code",
  "channel",
  "trigger",
  "port",
  "failureClass",
  "disposition",
  "integrityCheck",
] as const;
const NUMBER_FIELDS = ["status", "routingEpoch", "revision", "attempt", "step"] as const;

// Decision: well under Workers Logs' 256 KB per log and Logpush's 16,384-character combined
// `logs` and `exceptions` limit, so one failure never truncates the trace event around it.
const MESSAGE_CHARACTERS = 1024;
const STACK_CHARACTERS = 4096;

/**
 * Builds one record. Only the named fields are copied, strings as strings and numbers as finite
 * numbers, so passing a wider object (a scope or an execution context) never leaks its other
 * fields; error text is redacted and capped.
 */
export function runtimeLogRecord(
  level: RuntimeLogLevel,
  event: RuntimeLogEvent,
  fields: RuntimeLogFields,
  error?: unknown,
): RuntimeLogRecord {
  const record: Record<string, unknown> = {
    schemaVersion: RUNTIME_LOG_SCHEMA_VERSION,
    level,
    event,
    timestamp: new Date().toISOString(),
  };
  for (const field of STRING_FIELDS)
    if (typeof fields[field] === "string") record[field] = fields[field];
  for (const field of NUMBER_FIELDS)
    if (Number.isFinite(fields[field])) record[field] = fields[field];
  if (fields.failureClass !== undefined)
    record.retryable = RUNTIME_FAILURE_RETRYABLE[fields.failureClass];
  if (error !== undefined) record.error = logError(error);
  return record as unknown as RuntimeLogRecord;
}

function logError(error: unknown): RuntimeLogRecord["error"] {
  if (!(error instanceof Error)) return { name: "NonError", message: "" };
  return {
    name: error.name,
    message: redact(error.message, MESSAGE_CHARACTERS),
    ...(error.stack === undefined ? {} : { stack: redact(error.stack, STACK_CHARACTERS) }),
  };
}

/** URLs (connection strings carry credentials), bearer tokens and `key=value` secrets go. */
function redact(text: string, limit: number): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[url]")
    .replace(/\bbearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(password|passwd|secret|token|key|sslkey)\s*=\s*\S+/giu, "$1=[redacted]")
    .slice(0, limit);
}
