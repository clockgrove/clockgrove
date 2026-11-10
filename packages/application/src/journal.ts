import type {
  ActorAddress,
  AttributionEnvelope,
  AttributionIntent,
  AuthorityDecision,
  CommandEnvelope,
  CommandId,
  CorrelationId,
  EventEnvelope,
  EventId,
  PartitionId,
  PrivacyClass,
  QueueChannel,
  SimTimeMs,
  SpaceId,
  StreamId,
} from "@clockgrove/contracts";

import type { RuntimeAuthorizationContext } from "./persistence.js";

/**
 * Application-owned append description. Sequence numbers, ingestion position,
 * recording time, and tenant/world/timeline scope are assigned by the journal.
 */
export interface JournalEventDraft<TType extends string = string, TPayload = unknown> {
  readonly schemaVersion: 2;
  readonly eventId: EventId;
  readonly type: TType;
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
  readonly streamId: StreamId;
  readonly simulationTime: SimTimeMs;
  readonly correlationId: CorrelationId;
  readonly causationId?: import("@clockgrove/contracts").CausationId;
  readonly attribution: AttributionEnvelope;
  readonly actor?: ActorAddress;
  readonly principalId?: import("@clockgrove/contracts").PrincipalId;
  readonly decisionTraceId?: import("@clockgrove/contracts").DecisionTraceId;
  readonly ruleFiringId?: import("@clockgrove/contracts").RuleFiringId;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly privacyClass: PrivacyClass;
  readonly payloadHash: string;
  readonly payload: TPayload;
}

export interface JournalDispatchIntent {
  readonly dispatchId: string;
  readonly eventId: EventId;
  readonly channel: QueueChannel;
  readonly privacyClass: PrivacyClass;
  readonly payload: unknown;
}

export interface JournalExecuteRequest<
  TCommandType extends string = string,
  TCommandPayload = unknown,
  TResult = unknown,
> {
  readonly authorization: RuntimeAuthorizationContext;
  readonly command: CommandEnvelope<TCommandType, TCommandPayload>;
  /** Exact accepted bytes. Their SHA-256 and bytes form the receipt identity. */
  readonly commandBytes: Uint8Array;
  /**
   * Primary stream/partition against which the command's expected values apply. Required for an
   * allow decision; a deny decision appends nothing and needs no route.
   */
  readonly route?: Readonly<{
    partitionId: PartitionId;
    spaceId: SpaceId;
    streamId: StreamId;
  }>;
  /**
   * The command's allow or deny decision, built by trusted composition code. The journal records it
   * once, with the receipt; every event draft must seal its `authorityDecisionId`. A deny decision
   * commits a rejected receipt and must carry no events or dispatches.
   */
  readonly authorityDecision: JournalAuthorityDecision;
  readonly events: readonly JournalEventDraft[];
  readonly dispatches: readonly JournalDispatchIntent[];
  readonly stableResult: TResult;
  readonly projectionDelta: unknown;
}

/** An AuthorityDecision before the journal assigns its `decidedAt`. */
export type JournalAuthorityDecision = Omit<AuthorityDecision, "decidedAt">;

export interface JournalExecuteResult<TResult = unknown> {
  readonly value: TResult;
  readonly events: readonly EventEnvelope<string, unknown>[];
  readonly projectionDelta: unknown;
  /** Present when the stored outcome is a rejected (denied) command. */
  readonly outcome?: "rejected";
}

/** Provider-neutral canonical mutation seam. */
export interface Journal {
  execute<TResult>(
    request: JournalExecuteRequest<string, unknown, TResult>,
  ): Promise<JournalExecuteResult<TResult>>;
}

/** The stored outcome of an already decided command. */
export interface StoredJournalOutcome<TResult = unknown> {
  readonly status: "committed" | "rejected";
  readonly attribution?: AttributionIntent;
  readonly result: JournalExecuteResult<TResult>;
}

/**
 * Optional journal capability: read the stored outcome of an exact retry (same tenant, command ID
 * and bytes) without deciding anything. Returns undefined when the command is not decided or its
 * stored bytes differ.
 */
export interface JournalOutcomeReader {
  storedOutcome<TResult>(
    authorization: RuntimeAuthorizationContext,
    commandId: CommandId,
    commandBytes: Uint8Array,
  ): Promise<StoredJournalOutcome<TResult> | undefined>;
}

export function readsStoredOutcomes(journal: Journal): journal is Journal & JournalOutcomeReader {
  return typeof (journal as Partial<JournalOutcomeReader>).storedOutcome === "function";
}

/** Best-effort notification after PostgreSQL truth is committed. */
export interface JournalPostCommitNotifier {
  notify(result: JournalExecuteResult): Promise<void>;
}

export type JournalRevisionConflictKind =
  | "stream"
  | "partition"
  | "routing-epoch"
  | "clock-policy"
  | "owner-generation";

export class JournalRevisionConflictError extends Error {
  constructor(
    readonly kind: JournalRevisionConflictKind,
    readonly expected: bigint | number,
    readonly actual: bigint | number,
  ) {
    super(`${kind} revision conflict: expected ${expected}, actual ${actual}`);
    this.name = "JournalRevisionConflictError";
  }
}

export class JournalRouteNotFoundError extends Error {
  constructor(readonly route: string) {
    super(`journal route was not found: ${route}`);
    this.name = "JournalRouteNotFoundError";
  }
}

/** An event draft sealed a different authority decision than the request's. Nothing was written. */
export class JournalAuthorityDecisionMismatchError extends Error {
  constructor(readonly authorityDecisionId: string) {
    super(`event drafts must seal authority decision ${authorityDecisionId}`);
    this.name = "JournalAuthorityDecisionMismatchError";
  }
}

/**
 * The command waited longer than the journal transaction allows: for a lock held by another command
 * (`lock`, PostgreSQL `lock_timeout`), for one statement (`statement`, `statement_timeout`), or with
 * the transaction idle while the kernel ran (`idle`, `idle_in_transaction_session_timeout`, which ends
 * the session). Nothing was written; the command is retryable.
 */
export type JournalTimeoutKind = "lock" | "statement" | "idle";

export class JournalTimeoutError extends Error {
  constructor(readonly kind: JournalTimeoutKind) {
    super(`journal ${kind} timeout`);
    this.name = "JournalTimeoutError";
  }
}

/**
 * A drafted event ID already exists for the tenant (or repeats in one batch). Event IDs derive from
 * the command ID, so this is a defect or a squatting attempt, never a retry. Nothing was written.
 */
export class JournalEventIdCollisionError extends Error {
  constructor(readonly commandId: string) {
    super(`an event ID of command ${commandId} already exists`);
    this.name = "JournalEventIdCollisionError";
  }
}

/**
 * The command records an external effect (an `external-effects` dispatch) on a timeline that is not
 * `live`. Preview timelines cannot record external effects; nothing of the command was written.
 */
export class JournalPreviewEffectRefusedError extends Error {
  constructor(readonly commandId: string) {
    super(`command ${commandId} records an external effect on a timeline that is not live`);
    this.name = "JournalPreviewEffectRefusedError";
  }
}
