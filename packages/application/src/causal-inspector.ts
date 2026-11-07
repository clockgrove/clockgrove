import type {
  AuthorityDecision,
  CommandId,
  CommandReceipt,
  EventId,
  SpaceId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";
import {
  ContractDecodeError,
  decodeOpaqueId,
  type InspectorEvidenceClass,
} from "@clockgrove/contracts";

import { canonicalBytes, canonicalSerialize, sha256Hex } from "@clockgrove/kernel";

import {
  type CanonicalNode,
  CanonicalNodeError,
  decodeCanonicalNode,
  encodeCanonicalNode,
} from "./canonical-node.js";
import type { JournalRangeReader, StoredEvent } from "./journal-reader.js";
import { type PartitionReplayPorts, replayToSequence } from "./partition-replay.js";
import type {
  InspectedDispatch,
  InspectedSchedule,
  PersistenceTransactionPort,
  RuntimeAuthorizationContext,
} from "./persistence.js";
import type { PartitionSnapshotPorts } from "./snapshots.js";
import type { WorldPartitionScope } from "./world-command.js";

/** The receipt without its event IDs; `result` only when the ceiling admits `public_scene`. */
export type CommandReceiptView = Omit<CommandReceipt, "committedEventIds">;

/** One command on its causal chain. Walk it by inspecting `links.parents` and `links.children`. */
export interface CausalCommandView {
  /** The evidence class of each part; `COMMAND_VIEW_EVIDENCE`. */
  readonly evidence: typeof COMMAND_VIEW_EVIDENCE;
  readonly receipt: CommandReceiptView;
  readonly decision?: AuthorityDecision;
  /** Verified by the Journal range reader; only the events the principal may read. */
  readonly events: readonly StoredEvent[];
  /** Original routine drafts as a canonical node, only under public_scene. Index within the
   * receipt identifies a draft; its objectId, inputRevision and simulationTime are original.
   * Canonical encoding preserves bigint scores and features. Absence means privacy redaction;
   * unavailable means no retained record, rather than an empty set of decisions. */
  readonly decisionTraces?:
    | Readonly<{ status: "available"; drafts: CanonicalNode }>
    | Readonly<{ status: "unavailable" }>;
  /** Rows the command scheduled or consumed; only under `public_scene`, the kernel state's class. */
  readonly schedules: readonly InspectedSchedule[];
  readonly dispatches: readonly InspectedDispatch[];
  /** The state the command recorded at its last event; only under `public_scene`. */
  readonly projection?: ProjectionLink;
  readonly links: {
    /** The declared immediate cause, and the commands that scheduled the rows this one consumed. */
    readonly parents: readonly CommandId[];
    /** The commands that consumed rows this one scheduled, and its continuation chunks. */
    readonly children: readonly CommandId[];
  };
}

export interface ProjectionLink {
  readonly revision: string;
  readonly stateHash: string;
  readonly coveredPartitionSequence: bigint;
  /** Present when verification was asked for; `verified` is false when the replayed hash differs. */
  readonly replay?: {
    readonly stateHash: string;
    /** `birth`, or the snapshot ID the replay started from. */
    readonly start: string;
    readonly eventsApplied: number;
    readonly verified: boolean;
  };
}

export interface CausalInspectorPorts {
  readonly transactions: PersistenceTransactionPort;
  /** A range reader whose source reads under exactly `authorization`. */
  readonly events: (authorization: RuntimeAuthorizationContext) => JournalRangeReader;
}

/** What `verifyProjection` replays from: the stored birth and the partition's snapshots. */
export type ProjectionReplayPorts = Omit<PartitionReplayPorts, "events"> & PartitionSnapshotPorts;

export interface InspectionScope {
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
}

/** One error for an unknown ID and for another tenant's command, so neither is distinguishable. */
export class InspectedCommandNotFoundError extends Error {
  constructor(readonly commandId: CommandId) {
    super("command not found");
    this.name = "InspectedCommandNotFoundError";
  }
}

/** The principal used up its inspector accesses in this tenant for now; nothing was read. */
export class InspectorRateLimitedError extends Error {
  constructor() {
    super("inspector rate limit reached");
    this.name = "InspectorRateLimitedError";
  }
}

/** The closed evidence-class vocabulary, owned by the contracts so browser views share it. */
export { INSPECTOR_EVIDENCE_CLASSES, type InspectorEvidenceClass } from "@clockgrove/contracts";

/**
 * The evidence class of each part of a command view: journal rows as read are canonical; the links
 * and a replay comparison are computed from them; dispatch delivery status is runtime state.
 */
export const COMMAND_VIEW_EVIDENCE = Object.freeze({
  receipt: "canonical",
  decision: "canonical",
  events: "canonical",
  decisionTraces: "canonical",
  schedules: "canonical",
  dispatches: "operational",
  projection: "canonical",
  replay: "derived",
  links: "derived",
} as const satisfies Record<string, InspectorEvidenceClass>);

/** The readable events of one command linked to an entry. */
export interface LinkedEvents {
  readonly commandId: CommandId;
  readonly eventIds: readonly EventId[];
}

/**
 * Event entry (§11.1): the event, its command, the readable events of the command's parent and child
 * commands, and the projection the command recorded at its last event.
 */
export interface CausalEventView {
  readonly entry: "event";
  readonly evidence: typeof EVENT_VIEW_EVIDENCE;
  readonly event: StoredEvent;
  readonly command: CausalCommandView;
  readonly parentEvents: readonly LinkedEvents[];
  readonly childEvents: readonly LinkedEvents[];
  readonly projections: readonly ProjectionLink[];
}
export const EVENT_VIEW_EVIDENCE = Object.freeze({
  event: "canonical",
  command: "canonical",
  parentEvents: "derived",
  childEvents: "derived",
  projections: "canonical",
} as const satisfies Record<string, InspectorEvidenceClass>);

/**
 * Scheduled-action entry (§11.1): the schedule row's trigger (the command that scheduled it) and
 * deadline (`dueAt`), then the command that consumed it with its events; null while pending.
 */
export interface CausalScheduleView {
  readonly entry: "scheduled-action";
  readonly evidence: typeof SCHEDULE_VIEW_EVIDENCE;
  readonly schedule: InspectedSchedule;
  readonly trigger: CausalCommandView;
  readonly completion: CausalCommandView | null;
}
export const SCHEDULE_VIEW_EVIDENCE = Object.freeze({
  schedule: "canonical",
  trigger: "canonical",
  completion: "canonical",
} as const satisfies Record<string, InspectorEvidenceClass>);

/** One error for an unknown event, another tenant's, another scope's and a withheld class's. */
export class InspectedEventNotFoundError extends Error {
  constructor(readonly eventId: EventId) {
    super("event not found");
    this.name = "InspectedEventNotFoundError";
  }
}

/** One error for an unknown schedule row and one the principal may not read in the scope. */
export class InspectedScheduleNotFoundError extends Error {
  constructor(readonly scheduleId: string) {
    super("schedule not found");
    this.name = "InspectedScheduleNotFoundError";
  }
}

/** The principal used up its runtime operator actions in this tenant for now; nothing changed. */
export class RuntimeActionRateLimitedError extends Error {
  constructor() {
    super("runtime operator action rate limit reached");
    this.name = "RuntimeActionRateLimitedError";
  }
}

/** The stored chain disagrees with its receipt: its events or its authority decision. */
export class InspectionIntegrityError extends Error {
  constructor(
    readonly commandId: CommandId,
    readonly reason: "events" | "decision" | "traces",
  ) {
    super(`command chain failed verification: ${reason}`);
    this.name = "InspectionIntegrityError";
  }
}

/**
 * Reads one command's causal chain under the caller's authorization: receipt and authority decision,
 * events through the verified range reader, schedules, dispatches, and the commands linked to it.
 * Every read installs `authorization` in its own transaction; nothing is written or cached.
 * `verifyProjection` replays the partition to the command's last event, from the latest snapshot at or
 * before it, and compares the result with the state hash the command recorded.
 */
export async function inspectCommand(
  authorization: RuntimeAuthorizationContext,
  commandId: CommandId,
  ports: CausalInspectorPorts,
  options: {
    readonly verifyProjection?: ProjectionReplayPorts;
    /**
     * Only a command of this world, timeline and space is found; any other answers as unknown. The
     * space is the one the command was routed to, else (older receipts) the one its readable events
     * were committed in. Checked in the first transaction, before any event is read.
     */
    readonly scope?: InspectionScope;
  } = {},
): Promise<CausalCommandView> {
  const { scope } = options;
  const stored = await ports.transactions.withAuthorization(authorization, async (transaction) => {
    const receipt = await transaction.getCommandReceipt(commandId);
    if (receipt === undefined) return undefined;
    if (
      scope !== undefined &&
      (receipt.target.worldId !== scope.worldId || receipt.target.timelineId !== scope.timelineId)
    )
      return undefined;
    const decisionId = receipt.authorityDecisionId;
    const decision =
      decisionId === undefined ? undefined : await transaction.getAuthorityDecision(decisionId);
    if (decisionId !== undefined && decision === undefined) {
      throw new InspectionIntegrityError(commandId, "decision");
    }
    const links = await transaction.getCommandLinks(commandId, receipt.target.timelineId);
    // The routed space alone never authorizes events committed in another space.
    const { routedSpaceId, eventSpan } = links;
    if (
      routedSpaceId !== undefined &&
      eventSpan !== undefined &&
      eventSpan.spaceId !== routedSpaceId
    )
      return undefined;
    if (scope !== undefined && (routedSpaceId ?? eventSpan?.spaceId) !== scope.spaceId)
      return undefined;
    return { receipt, decision, links };
  });
  if (stored === undefined) throw new InspectedCommandNotFoundError(commandId);
  const { receipt, decision, links } = stored;
  const scene = authorization.privacyCeiling.allowedCategories.includes("public_scene");

  const span = links.eventSpan;
  const events =
    span === undefined
      ? []
      : await ports.events(authorization).readPartition(
          {
            tenantId: authorization.tenantId,
            timelineId: span.timelineId,
            partitionId: span.partitionId,
          },
          { from: span.from, to: span.to },
        );
  const eventIds = events.map((event) => event.eventId);
  if (scene && eventIds.join("\n") !== receipt.committedEventIds.join("\n")) {
    throw new InspectionIntegrityError(commandId, "events");
  }

  const schedules = scene ? links.schedules : [];
  const linked = (ids: readonly (string | undefined)[]) => [
    ...new Set(
      ids
        .filter((id): id is string => id !== undefined && id !== commandId)
        .map((id) => decodeOpaqueId(id, "CommandId")),
    ),
  ];
  const recorded = scene && span !== undefined ? recordedProjection(receipt.result) : undefined;
  const projection =
    recorded === undefined || span === undefined
      ? undefined
      : {
          ...recorded,
          coveredPartitionSequence: span.to,
          ...(options.verifyProjection === undefined
            ? {}
            : {
                replay: await verifyLink(
                  authorization,
                  {
                    tenantId: receipt.target.tenantId,
                    worldId: receipt.target.worldId,
                    timelineId: span.timelineId,
                    partitionId: span.partitionId,
                  },
                  span.to,
                  recorded.stateHash,
                  { ...options.verifyProjection, events: ports.events(authorization) },
                ),
              }),
        };
  const { committedEventIds: _eventIds, result, ...identity } = receipt;
  return {
    evidence: COMMAND_VIEW_EVIDENCE,
    receipt: scene && result !== undefined ? { ...identity, result } : identity,
    ...(decision === undefined ? {} : { decision }),
    events,
    ...(scene ? { decisionTraces: retainedTraces(commandId, receipt.result) } : {}),
    schedules,
    dispatches: links.dispatches,
    ...(projection === undefined ? {} : { projection }),
    links: {
      parents: linked([
        declaredCause(receipt.attribution?.immediateCauseId),
        ...schedules.filter((row) => row.completedBy === commandId).map((row) => row.scheduledBy),
      ]),
      children: linked([
        ...schedules.filter((row) => row.scheduledBy === commandId).map((row) => row.completedBy),
        ...(scene ? links.chunkChildren : []),
      ]),
    },
  };
}

type InspectOptions = NonNullable<Parameters<typeof inspectCommand>[3]>;

/** The command, or undefined when it is not readable in the scope. */
async function inspectReadable(
  authorization: RuntimeAuthorizationContext,
  commandId: CommandId,
  ports: CausalInspectorPorts,
  options: InspectOptions,
): Promise<CausalCommandView | undefined> {
  try {
    return await inspectCommand(authorization, commandId, ports, options);
  } catch (error) {
    if (error instanceof InspectedCommandNotFoundError) return undefined;
    throw error;
  }
}

/**
 * Reads the causal chain from one event under the caller's authorization: an event the principal
 * cannot read, or one outside `scope`, answers as unknown. Parent and child events are the readable
 * events of the command's linked commands, each read in the same scope; a linked command not
 * readable there is omitted. The work is bounded by the immutable receipt's link set.
 */
export async function inspectEvent(
  authorization: RuntimeAuthorizationContext,
  eventId: EventId,
  ports: CausalInspectorPorts,
  options: InspectOptions & { readonly scope: InspectionScope },
): Promise<CausalEventView> {
  const { scope } = options;
  const { event, command } = await inspectEventCommand(authorization, eventId, ports, options);
  const linked = async (ids: readonly CommandId[]) => {
    const found: LinkedEvents[] = [];
    for (const commandId of ids) {
      const view = await inspectReadable(authorization, commandId, ports, { scope });
      if (view !== undefined)
        found.push({ commandId, eventIds: view.events.map((linkedEvent) => linkedEvent.eventId) });
    }
    return found;
  };
  return {
    entry: "event",
    evidence: EVENT_VIEW_EVIDENCE,
    event,
    command,
    parentEvents: await linked(command.links.parents),
    childEvents: await linked(command.links.children),
    projections: command.projection === undefined ? [] : [command.projection],
  };
}

/**
 * One event and the one command that committed it, read as `inspectEvent` reads them but without
 * its linked commands: one keyed event lookup and one command read (the public Why's entry read).
 */
export async function inspectEventCommand(
  authorization: RuntimeAuthorizationContext,
  eventId: EventId,
  ports: CausalInspectorPorts,
  options: InspectOptions & { readonly scope: InspectionScope },
): Promise<{
  readonly event: CausalCommandView["events"][number];
  readonly command: CausalCommandView;
}> {
  const { scope } = options;
  const origin = await ports.transactions.withAuthorization(authorization, (transaction) =>
    transaction.getEventCommand(eventId),
  );
  if (
    origin === undefined ||
    origin.worldId !== scope.worldId ||
    origin.timelineId !== scope.timelineId ||
    origin.spaceId !== scope.spaceId
  )
    throw new InspectedEventNotFoundError(eventId);
  const command = await inspectReadable(authorization, origin.commandId, ports, options);
  const event = command?.events.find((candidate) => candidate.eventId === eventId);
  if (command === undefined || event === undefined) throw new InspectedEventNotFoundError(eventId);
  return { event, command };
}

/**
 * Reads the causal chain from one schedule row of the scope's space: its trigger command and
 * deadline, then the command that consumed it. Schedule rows are the kernel state's class, so the
 * entry needs `public_scene`, as the schedules of a command view do; a row whose trigger is not
 * readable in the scope answers as unknown.
 */
export async function inspectSchedule(
  authorization: RuntimeAuthorizationContext,
  entry: { readonly scheduleId: string; readonly idempotencyKey: string },
  ports: CausalInspectorPorts,
  options: InspectOptions & { readonly scope: InspectionScope },
): Promise<CausalScheduleView> {
  const { scope } = options;
  const missing = () => new InspectedScheduleNotFoundError(entry.scheduleId);
  const schedule = await readSchedule(authorization, entry, ports, scope);
  const trigger = await inspectReadable(authorization, schedule.scheduledBy, ports, { scope });
  if (trigger === undefined) throw missing();
  const completion =
    schedule.completedBy === undefined
      ? undefined
      : await inspectReadable(authorization, schedule.completedBy, ports, options);
  if (schedule.completedBy !== undefined && completion === undefined) throw missing();
  return {
    entry: "scheduled-action",
    evidence: SCHEDULE_VIEW_EVIDENCE,
    schedule,
    trigger,
    completion: completion ?? null,
  };
}

/**
 * One schedule row of the scope's space and the one command whose Why it answers: the command that
 * consumed it, else (pending) the one that scheduled it. The public Why's entry read; its trigger
 * appears there only as an admitted parent link of the consuming command.
 */
export async function inspectScheduleCommand(
  authorization: RuntimeAuthorizationContext,
  entry: { readonly scheduleId: string; readonly idempotencyKey: string },
  ports: CausalInspectorPorts,
  options: InspectOptions & { readonly scope: InspectionScope },
): Promise<{ readonly schedule: InspectedSchedule; readonly command: CausalCommandView }> {
  const schedule = await readSchedule(authorization, entry, ports, options.scope);
  const command = await inspectReadable(
    authorization,
    schedule.completedBy ?? schedule.scheduledBy,
    ports,
    options,
  );
  if (command === undefined) throw new InspectedScheduleNotFoundError(entry.scheduleId);
  return { schedule, command };
}

/** Schedule rows are the kernel state's class: without `public_scene` the row answers as unknown. */
async function readSchedule(
  authorization: RuntimeAuthorizationContext,
  entry: { readonly scheduleId: string; readonly idempotencyKey: string },
  ports: CausalInspectorPorts,
  scope: InspectionScope,
): Promise<InspectedSchedule> {
  const missing = () => new InspectedScheduleNotFoundError(entry.scheduleId);
  if (!authorization.privacyCeiling.allowedCategories.includes("public_scene")) throw missing();
  const schedule = await ports.transactions.withAuthorization(authorization, (transaction) =>
    transaction.getSchedule(scope, entry.scheduleId, entry.idempotencyKey),
  );
  if (schedule === undefined) throw missing();
  return schedule;
}

/** A declared cause is client-chosen: one that is not a command ID is no parent link, not an error. */
function declaredCause(cause: string | undefined): string | undefined {
  try {
    return cause === undefined ? undefined : decodeOpaqueId(cause, "CommandId");
  } catch (error) {
    if (error instanceof ContractDecodeError) return undefined;
    throw error;
  }
}

/** The revision and state hash a committed world command recorded in its result. */
function recordedProjection(
  result: CommandReceipt["result"],
): { readonly revision: string; readonly stateHash: string } | undefined {
  const value =
    typeof result === "object" && result !== null
      ? (result as { value?: unknown }).value
      : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const { revision, stateHash } = value as { revision?: unknown; stateHash?: unknown };
  return typeof revision === "string" && typeof stateHash === "string"
    ? { revision, stateHash }
    : undefined;
}

async function verifyLink(
  authorization: RuntimeAuthorizationContext,
  scope: WorldPartitionScope,
  to: bigint,
  recorded: string,
  ports: PartitionReplayPorts & PartitionSnapshotPorts,
): Promise<NonNullable<ProjectionLink["replay"]>> {
  const committed = await ports.snapshots.readCommitted(authorization, scope);
  if (committed === undefined) throw new RangeError("the partition has no committed state");
  const replayed = await replayToSequence(
    authorization,
    scope,
    to,
    committed.packContentHash,
    ports,
  );
  return {
    stateHash: replayed.stateHash,
    start: replayed.start,
    eventsApplied: replayed.eventsApplied,
    verified: replayed.stateHash === recorded,
  };
}

/** Decode once at the durable boundary; malformed storage is not a malformed HTTP request. */
function retainedTraces(
  commandId: CommandId,
  result: CommandReceipt["result"],
): NonNullable<CausalCommandView["decisionTraces"]> {
  const wrapper =
    typeof result === "object" && result !== null && "projectionDelta" in result
      ? result.projectionDelta
      : undefined;
  if (typeof wrapper !== "object" || wrapper === null || !("decisionTraces" in wrapper))
    return { status: "unavailable" };
  const stored = wrapper.decisionTraces;
  if (typeof stored !== "object" || stored === null || !("drafts" in stored) || !("hash" in stored))
    throw new InspectionIntegrityError(commandId, "traces");
  try {
    const decoded = decodeCanonicalNode(stored.drafts);
    const drafts = encodeCanonicalNode(decoded);
    if (
      !Array.isArray(decoded) ||
      sha256Hex(canonicalBytes(decoded)) !== stored.hash ||
      canonicalSerialize(drafts) !== canonicalSerialize(stored.drafts)
    )
      throw new InspectionIntegrityError(commandId, "traces");
    return { status: "available", drafts };
  } catch (error) {
    if (error instanceof CanonicalNodeError)
      throw new InspectionIntegrityError(commandId, "traces");
    throw error;
  }
}
