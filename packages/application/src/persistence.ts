import type {
  AuthorityDecision,
  AuthorityDecisionId,
  CommandId,
  CommandReceipt,
  EventId,
  PartitionId,
  PrincipalId,
  PrivacyCeiling,
  SpaceId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

/** Authority installed for exactly one database transaction. */
export interface RuntimeAuthorizationContext {
  readonly tenantId: TenantId;
  readonly principalId: PrincipalId;
  readonly privacyCeiling: PrivacyCeiling;
}

/**
 * Inward port for a short authorized persistence transaction. Implementations
 * own SQL/provider details and must not retain authorization after completion.
 */
export interface AuthorizedPersistenceTransaction {
  /** The stored receipt, decoded with `decodeCommandReceipt`. */
  getCommandReceipt(commandId: CommandId): Promise<CommandReceipt | undefined>;
  /** The stored decision, decoded with `decodeAuthorityDecision`. */
  getAuthorityDecision(
    authorityDecisionId: AuthorityDecisionId,
  ): Promise<AuthorityDecision | undefined>;
  /** The command's event span, schedules, dispatches and continuation chunks, as RLS lets the principal read them. */
  getCommandLinks(commandId: CommandId, timelineId: TimelineId): Promise<CommandLinkRows>;
  /** The command and place of one event, as RLS lets the principal read it. */
  getEventCommand(eventId: EventId): Promise<InspectedEventOrigin | undefined>;
  /** One schedule row of a space by its identity, `(scheduleId, idempotencyKey)`. */
  getSchedule(
    scope: {
      readonly worldId: WorldId;
      readonly timelineId: TimelineId;
      readonly spaceId: SpaceId;
    },
    scheduleId: string,
    idempotencyKey: string,
  ): Promise<InspectedSchedule | undefined>;
}

/** Where a readable event was committed, and by which command. */
export interface InspectedEventOrigin {
  readonly commandId: CommandId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
}

/** A schedule row a command scheduled (`scheduledBy`) or consumed (`completedBy`). */
export interface InspectedSchedule {
  readonly scheduleId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly dueAt: bigint;
  readonly status: "pending" | "done";
  readonly scheduledBy: CommandId;
  readonly completedBy?: CommandId;
}

export interface InspectedDispatch {
  readonly dispatchId: string;
  readonly eventId: EventId;
  readonly channel: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastErrorClass?: string;
  readonly settledAt?: string;
}

/** The partition sequences of a command's visible events (contiguous: the append holds the partition lock). */
export interface CommandEventSpan {
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  /** The space of the partition the events were committed in. */
  readonly spaceId: SpaceId;
  readonly from: bigint;
  readonly to: bigint;
}

export interface CommandLinkRows {
  /** The space the command was routed to; absent on receipts stored before it was recorded. */
  readonly routedSpaceId?: SpaceId;
  readonly eventSpan?: CommandEventSpan;
  readonly schedules: readonly InspectedSchedule[];
  readonly dispatches: readonly InspectedDispatch[];
  /** Continuation chunks whose immediate cause is the command, in commit order. */
  readonly chunkChildren: readonly CommandId[];
}

export interface PersistenceTransactionPort {
  withAuthorization<TResult>(
    authorization: RuntimeAuthorizationContext,
    operation: (transaction: AuthorizedPersistenceTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}
