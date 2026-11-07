import type {
  AttributionEnvelope,
  CommandEnvelope,
  CommandId,
  EventEnvelope,
  PartitionId,
  SimTimeMs,
  SpaceId,
  StreamId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";
import {
  decodeAttributionEnvelope,
  decodeOpaqueId,
  decodePrivacyCategory,
} from "@clockgrove/contracts";
import type { WorldBehaviorPack, WorldState } from "@clockgrove/domain";
import { createWorldState } from "@clockgrove/domain";
import type { WorldKernelInput, WorldKernelOutcome, WorldSemanticEvent } from "@clockgrove/kernel";
import {
  canonicalBytes,
  createDeterministicIdSource,
  executeWorldKernel,
  restoreNamedRandomState,
  serializeNamedRandomState,
  sha256Hex,
} from "@clockgrove/kernel";

import { allowDecision, isTrustedId, TRUSTED_ID_PREFIX } from "./authority-decision.js";
import { CanonicalNodeError, decodeCanonicalNode, encodeCanonicalNode } from "./canonical-node.js";
import { CLOCK_POLICY_CHANGED, JOURNAL_EVENT_REGISTRY } from "./event-registry.js";
import type {
  JournalAuthorityDecision,
  JournalDispatchIntent,
  JournalEventDraft,
  JournalExecuteRequest,
  JournalExecuteResult,
} from "./journal.js";
import { JournalRevisionConflictError } from "./journal.js";
import { computePayloadHash, verifyJournalRequest } from "./journal-verification.js";
import { type RuntimeMetrics, recordMetric } from "./metrics.js";
import type {
  EncodedPartitionState,
  EncodedScheduleItem,
  PartitionStateDocument,
  ScheduleChanges,
} from "./partition-state.js";
import {
  encodePartitionState,
  PartitionStateIntegrityError,
  scheduleChanges,
} from "./partition-state.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type { ClockCommand, TimelineClockPolicy } from "./timeline-clock.js";
import {
  decodeClockCommand,
  decodeTimelineClockPolicy,
  isClockCommand,
  transitionTimelineClockPolicy,
} from "./timeline-clock.js";
import type { EncodedWorldContinuation, WorldContinuationRecord } from "./world-continuation.js";
import { continuationCommandId, encodeWorldContinuation } from "./world-continuation.js";

/**
 * The deterministic-ID stream of a world command's kernel call. It is the Wave 1 simulator's scenario
 * stream, so a command through the Journal derives the same IDs as the same pure kernel call.
 */
export const WORLD_COMMAND_ID_STREAM = "scenario";

/** Every Wave 1 kernel event is journaled with this privacy class. */
export const KERNEL_EVENT_PRIVACY_CLASS = decodePrivacyCategory("public_scene");

/**
 * The kernel budget of one trusted `world.advance` call. It bounds how long one kernel call (and so
 * one transaction holding the partition lock) runs; a call that reaches it stops with a continuation
 * and the rest runs as further chunks, each in its own transaction. `maxEvents` is the kernel's
 * per-call maximum (`@clockgrove/kernel` `world.advance` validation); `maxInputs` 16 is issue 931's
 * decision (the kernel admits up to 1024). The Wave 3 load curves saw at most 646
 * events per due-work advance. On the recorded host an advance of 64 inputs took a median of about
 * 2.0 s, 8 times `OWNER_ACTIVATION_BUDGET.startWithinMs`, which is checked only between commands;
 * one of 16 took about 0.36 s, but only in a world of 16 keepers. The time per input grows with
 * the keepers in the world, so 16 inputs of 96 keepers should take about 1 s by issue 900's figures.
 * 16 shortens each lock hold at the cost of more continuation chunks
 * (docs/runbooks/runtime.md#runtime-budgets-and-load-curves).
 */
export const DUE_WORK_ADVANCE_BUDGET = Object.freeze({ maxInputs: 16, maxEvents: 4096 });

/** Trusted commands derive every byte from their identity, so a retry sends identical bytes. */
export const TRUSTED_COMMAND_ISSUED_AT = "1970-01-01T00:00:00.000Z";

/** The partition state `begin` locked for this command, decoded and verified. */
export interface LockedPartitionState {
  readonly clockPolicy?: TimelineClockPolicy;
  readonly revision: bigint;
  /** The journal head the stored state covers. */
  readonly coveredHeadSequence: bigint;
  /** The content hash of the world's installed pack, when the world has an installation. */
  readonly packContentHash: string | undefined;
  readonly document: PartitionStateDocument;
  /** The pending schedule rows the document was rebuilt from, in queue order. */
  readonly schedules: readonly EncodedScheduleItem[];
  /** The open continuation of an incomplete kernel result, and the ID of its next chunk. */
  readonly continuation?: Readonly<{ commandId: CommandId; record: WorldContinuationRecord }>;
}

/** What the one kernel call decided: append its events and new state, or commit a rejected receipt. */
export interface WorldCommandAppend {
  readonly clockPolicy?: TimelineClockPolicy;
  readonly outcome: "committed" | "rejected";
  readonly events: readonly JournalEventDraft[];
  /** Outbox intent written with the events; absent means none. A rejected outcome carries none. */
  readonly dispatches?: readonly JournalDispatchIntent[];
  readonly stableResult: unknown;
  readonly projectionDelta: unknown;
  /** The new partition state; present exactly when the outcome is `committed`. */
  readonly state?: EncodedPartitionState;
  /** The schedule mutations; present exactly when `state` is. */
  readonly schedules?: ScheduleChanges;
  /** The continuation the new state carries (`null` when the kernel call completed). */
  readonly continuation?: EncodedWorldContinuation | null;
  /** The kernel inputs (scheduled decisions) a committed kernel call dispatched; absent without one. */
  readonly inputs?: number;
}

/** Runs while the command's locks are held. It must be synchronous and pure: no I/O, no awaiting. */
export type WorldCommandStep = (locked: LockedPartitionState) => WorldCommandAppend;

/**
 * Canonical journal transaction for a world command: begin (receipt, decision, sorted head locks,
 * expected revisions, the locked partition state and schedules), `step`, append, commit. A command
 * that is already decided, or denied, returns its stored outcome and `step` is not called.
 */
export interface WorldCommandJournal {
  executeWorldCommand(
    request: JournalExecuteRequest,
    step: WorldCommandStep,
  ): Promise<JournalExecuteResult>;
}

/** The installed pack's behavior for a world. Read before the transaction begins. */
export interface WorldBehaviorSource {
  behaviorFor(scope: {
    readonly tenantId: TenantId;
    readonly worldId: WorldId;
    readonly timelineId: TimelineId;
  }): Promise<WorldBehaviorPack>;
}

export type WorldKernel = (input: WorldKernelInput) => WorldKernelOutcome;

export interface WorldCommandPorts {
  readonly journal: WorldCommandJournal;
  readonly behavior: WorldBehaviorSource;
  /** The pure kernel; `executeWorldKernel` unless a test supplies a counting double. */
  readonly kernel?: WorldKernel;
}

export type WorldRoute = Readonly<{
  partitionId: PartitionId;
  spaceId: SpaceId;
  streamId: StreamId;
}>;

export interface WorldCommandRequest {
  readonly clockCommand?: ClockCommand;
  /** Trusted server time sampled once after command locks are acquired. */
  readonly trustedWallTime?: () => bigint;
  readonly authorization: RuntimeAuthorizationContext;
  /** A Wave 1 kernel command (`world.*`, containment or movement), targeted at the world. */
  readonly command: CommandEnvelope<string, unknown>;
  /** Exact accepted bytes. Their SHA-256 and bytes form the receipt identity. */
  readonly commandBytes: Uint8Array;
  /** The partition and stream that hold the world's kernel state. */
  readonly route: WorldRoute;
  readonly authorityDecision: JournalAuthorityDecision;
  /**
   * The time a client command runs at (earned time), when ahead of the stored state. Canonical time
   * moves there with the command's own events; no integration of actors or plants is written.
   * Unprocessed environment boundaries up to `runAt` refuse with `WorldTimeWorkPendingError`.
   */
  readonly runAt?: bigint;
}

/**
 * Environment boundaries (or an unusable probe) lie between the stored time and `runAt`: only an
 * advance emits them, so they run as their own trusted step first. Nothing is written.
 */
export class WorldTimeWorkPendingError extends Error {
  constructor(readonly runAt: bigint) {
    super(`work is pending before ${runAt}`);
    this.name = "WorldTimeWorkPendingError";
  }
}

export type WorldCommandValue =
  | Readonly<{
      status: "committed";
      /** The kernel revision after the command: the partition revision the client sees. */
      revision: string;
      simulationTime: string;
      complete: boolean;
      eventCount: number;
      stateHash: string;
      clockPolicy?: TimelineClockPolicy;
    }>
  | Readonly<{
      status: "refused";
      refusal: Readonly<{ code: string; path: string; check?: string }>;
    }>
  | Readonly<{ status: "denied"; reasonCode: string }>;

export interface WorldCommandResult {
  readonly commandId: CommandId;
  readonly outcome: "committed" | "rejected";
  readonly value: WorldCommandValue;
  readonly events: readonly EventEnvelope<string, unknown>[];
}

/** The behavior source names a different pack than the one the world has installed. Nothing is written. */
export class WorldBehaviorMismatchError extends Error {
  constructor(
    readonly installed: string | undefined,
    readonly supplied: string,
  ) {
    super(`world behavior ${supplied} is not the installed pack ${installed ?? "(none)"}`);
    this.name = "WorldBehaviorMismatchError";
  }
}

/**
 * A client command named an ID in the trusted namespace. Only trusted code mints those IDs (due-work
 * advances, continuation chunks), so a client can never take over their receipts or event IDs.
 * Nothing is written.
 */
export class TrustedCommandIdRefusedError extends Error {
  constructor(readonly commandId: string) {
    super(`command ID ${commandId} is reserved for trusted commands`);
    this.name = "TrustedCommandIdRefusedError";
  }
}

/**
 * The partition has an open continuation and this command is not its next chunk (or a chunk found no
 * open continuation). The chain runs to completion first, as in the simulator. Nothing is written;
 * the command is retryable once the continuation completes.
 */
export class WorldContinuationPendingError extends Error {
  constructor(
    readonly commandId: string,
    readonly openCommandId: string | undefined,
  ) {
    super(
      openCommandId === undefined
        ? `continuation chunk ${commandId} has no open continuation`
        : `partition has an open continuation; its next chunk is ${openCommandId}`,
    );
    this.name = "WorldContinuationPendingError";
  }
}

/**
 * Executes one client world command through the Wave 1 kernel inside the canonical journal
 * transaction: exactly one synchronous pure kernel call between begin and append, no I/O while the
 * locks are held. A trusted command ID is refused before anything is read or written. A kernel
 * refusal commits a rejected receipt under the allow decision; a stale expected revision is a
 * retryable `JournalRevisionConflictError` with no receipt; an exact retry returns the stored outcome
 * without running the kernel. An incomplete kernel result persists its continuation; the partition
 * then accepts its chunks (`continueWorldCommand`, `advanceDueWork`) and clock controls until it completes.
 */
export async function executeWorldCommand(
  request: WorldCommandRequest,
  ports: WorldCommandPorts,
): Promise<WorldCommandResult> {
  if (isTrustedId(request.command.commandId)) {
    throw new TrustedCommandIdRefusedError(request.command.commandId);
  }
  const clockCommand =
    request.clockCommand ??
    (isClockCommand(request.command.type)
      ? decodeClockCommand(request.command.type, request.command.payload)
      : undefined);
  return runWorldCommand(
    { ...request, ...(clockCommand === undefined ? {} : { clockCommand }) },
    ports,
  );
}

/** Runs a client or trusted world command. Callers decide which command IDs they may use. */
async function runWorldCommand(
  request: WorldCommandRequest,
  ports: WorldCommandPorts,
): Promise<WorldCommandResult> {
  const { authorization, command, commandBytes, route, authorityDecision } = request;
  const kernel = ports.kernel ?? executeWorldKernel;
  const behavior =
    authorityDecision.outcome === "allow" && request.clockCommand === undefined
      ? await ports.behavior.behaviorFor({
          tenantId: command.target.tenantId,
          worldId: command.target.worldId,
          timelineId: command.target.timelineId,
        })
      : undefined;
  const journalRequest: JournalExecuteRequest = {
    authorization,
    command,
    commandBytes,
    route,
    authorityDecision,
    events: [],
    dispatches: [],
    stableResult:
      authorityDecision.reasonCode === undefined
        ? null
        : { status: "denied", reasonCode: authorityDecision.reasonCode },
    projectionDelta: null,
  };
  const result = await ports.journal.executeWorldCommand(journalRequest, (locked) => {
    if (request.clockCommand !== undefined) {
      if (request.trustedWallTime === undefined)
        throw new TypeError("trusted clock wall time required");
      return runClock(journalRequest, request.clockCommand, request.trustedWallTime(), locked);
    }
    if (behavior === undefined) throw new TypeError("a denied command never runs the kernel");
    return runKernel(journalRequest, behavior, kernel, locked, request.runAt);
  });
  return {
    commandId: command.commandId,
    outcome: result.outcome === "rejected" ? "rejected" : "committed",
    value: restoreWorldCommandValue(result.value),
    events: result.events,
  };
}

/** Restores typed clock metadata from the journal's JSON result without losing bigint values. */
export function restoreWorldCommandValue(value: unknown): WorldCommandValue {
  const result = value as WorldCommandValue;
  if (result.status !== "committed" || result.clockPolicy === undefined) return result;
  try {
    return {
      ...result,
      clockPolicy: decodeTimelineClockPolicy(decodeCanonicalNode(result.clockPolicy)),
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof CanonicalNodeError)
      throw new PartitionStateIntegrityError("malformed-document");
    throw error;
  }
}

function runClock(
  request: JournalExecuteRequest,
  control: ClockCommand,
  wallTime: bigint,
  locked: LockedPartitionState,
): WorldCommandAppend {
  if (locked.clockPolicy === undefined)
    throw new PartitionStateIntegrityError("malformed-document");
  const clockPolicy = transitionTimelineClockPolicy(
    locked.clockPolicy,
    control,
    locked.document.state.simulationTime,
    wallTime,
  );
  const route = request.route;
  if (route === undefined) throw new TypeError("clock command route required");
  const payload = {
    reason: request.command.type,
    previousVersion: locked.clockPolicy.version.toString(),
    clockPolicy: encodeCanonicalNode(clockPolicy),
  };
  const event: JournalEventDraft = {
    schemaVersion: 2,
    eventId: decodeOpaqueId(`${request.command.commandId}:event:0`, "EventId"),
    type: CLOCK_POLICY_CHANGED,
    ...route,
    simulationTime: locked.document.state.simulationTime,
    correlationId: request.command.context.correlationId,
    attribution: {
      ...request.command.attribution,
      authorityDecisionId: request.authorityDecision.authorityDecisionId,
    },
    policyVersions: { clock: clockPolicy.version.toString() },
    privacyClass: KERNEL_EVENT_PRIVACY_CLASS,
    payloadHash: computePayloadHash(payload),
    payload,
  };
  verifyJournalRequest({ ...request, events: [event] }, JOURNAL_EVENT_REGISTRY);
  const state = encodePartitionState(locked.document);
  return {
    outcome: "committed",
    events: [event],
    clockPolicy,
    state,
    schedules: { done: [], put: [] },
    continuation:
      locked.continuation === undefined
        ? null
        : encodeWorldContinuation(locked.continuation.record),
    stableResult: {
      status: "committed",
      revision: state.revision.toString(),
      simulationTime: state.simulationTime.toString(),
      complete: locked.continuation === undefined,
      eventCount: 1,
      stateHash: state.stateHash,
      clockPolicy: encodeCanonicalNode(clockPolicy),
    },
    projectionDelta: null,
  };
}

function runKernel(
  request: JournalExecuteRequest,
  behavior: WorldBehaviorPack,
  kernel: WorldKernel,
  locked: LockedPartitionState,
  runAt?: bigint,
): WorldCommandAppend {
  if (locked.packContentHash !== behavior.contentHash) {
    throw new WorldBehaviorMismatchError(locked.packContentHash, behavior.contentHash);
  }
  const { command, authorityDecision } = request;
  // The journal attribution of this command's events: its own, sealed with its own decision.
  const attribution = decodeAttributionEnvelope({
    ...command.attribution,
    authorityDecisionId: authorityDecision.authorityDecisionId,
  });
  // A chunk resumes the origin call: the kernel binds the continuation to that call's command,
  // attribution, ID seed and kept random state, so the chunk passes exactly those.
  const open = locked.continuation;
  if (open !== undefined && open.commandId !== command.commandId) {
    throw new WorldContinuationPendingError(command.commandId, open.commandId);
  }
  if (open === undefined && isContinuationCommand(command)) {
    throw new WorldContinuationPendingError(command.commandId, undefined);
  }
  const kernelCommand = open?.record.originCommand ?? command;
  const kernelAttribution = open?.record.attribution ?? attribution;
  const { schedules, randomState } = locked.document;
  const inputOf = (
    kernelCommand: CommandEnvelope<string, unknown>,
    state: WorldState,
  ): WorldKernelInput =>
    ({
      partition: {
        schemaVersion: 1,
        partitionId: state.partitionId,
        revision: state.revision,
        state,
      },
      input: { kind: "command", command: kernelCommand },
      simulationTime: state.simulationTime,
      attribution: kernelAttribution,
      policies: {
        schemaVersion: 1,
        policyVersions: { routine: behavior.policy.version },
        policy: behavior.policy,
      },
      pack: {
        schemaVersion: 1,
        packId: behavior.packId,
        packVersion: behavior.packVersion,
        pack: behavior,
      },
      randomState: restoreNamedRandomState(randomState),
      ids: createDeterministicIdSource({
        commandId: kernelCommand.commandId,
        eventIndex: 0,
        randomStream: WORLD_COMMAND_ID_STREAM,
      }),
      schedules,
      ...(open === undefined ? {} : { continuation: open.record.continuation }),
    }) as unknown as WorldKernelInput;
  let state = locked.document.state;
  let moved = false;
  if (open === undefined && runAt !== undefined && runAt > state.simulationTime) {
    // A pure lazy advance probes the span: with only `time.advanced` in it, no boundary lies there
    // and the command's own events carry canonical time to `runAt`.
    const probe = kernel(
      inputOf(
        {
          ...command,
          commandId: decodeOpaqueId(`${command.commandId}:time`, "CommandId"),
          type: "world.advance",
          expected: { partitionRevision: state.revision },
          payload: { schemaVersion: 1, targetTime: runAt, ...DUE_WORK_ADVANCE_BUDGET, lazy: true },
        } as CommandEnvelope<string, unknown>,
        state,
      ),
    );
    if (!probe.ok || probe.result.events.some((event) => event.type !== "time.advanced"))
      throw new WorldTimeWorkPendingError(runAt);
    state = createWorldState({ ...state, simulationTime: runAt as SimTimeMs });
    moved = true;
  }
  const input = inputOf(kernelCommand, state);
  const outcome = kernel(input);
  if (!outcome.ok) {
    const { code, path, check } = outcome.error;
    return {
      outcome: "rejected",
      events: [],
      stableResult: {
        status: "refused",
        refusal: {
          code: String(code),
          path: String(path),
          ...(check === undefined ? {} : { check: String(check) }),
        },
      },
      projectionDelta: null,
    };
  }
  const result = outcome.result;
  // Receipt-owned evidence is committed atomically with this chunk, never rebuilt on inspection.
  const drafts = result.decisionDrafts.filter((draft) => draft.kind === "routine");
  const events = result.events.map((event, index) => draftOf(request, attribution, event, index));
  verifyJournalRequest({ ...request, events }, JOURNAL_EVENT_REGISTRY);
  // Time moves only with an event: a command that wrote none leaves the stored time alone.
  const next = encodePartitionState({
    state: moved && events.length === 0 ? locked.document.state : result.state,
    schedules: result.schedules,
    randomState: serializeNamedRandomState(result.updatedRandomState),
  });
  if (!result.complete && result.continuation === undefined) {
    throw new TypeError("an incomplete kernel result omitted its continuation");
  }
  const continuation =
    result.complete || result.continuation === undefined
      ? null
      : encodeWorldContinuation({
          originCommand: kernelCommand,
          attribution: kernelAttribution,
          chunk: (open?.record.chunk ?? 0) + 1,
          continuation: result.continuation,
        });
  return {
    outcome: "committed",
    events,
    dispatches: worldReactionDispatches(request, events),
    stableResult: {
      status: "committed",
      revision: next.revision.toString(),
      simulationTime: next.simulationTime.toString(),
      complete: result.complete,
      eventCount: events.length,
      stateHash: next.stateHash,
    },
    projectionDelta: {
      fromRevision: locked.revision.toString(),
      toRevision: next.revision.toString(),
      decisionTraces: {
        drafts: encodeCanonicalNode(drafts),
        hash: sha256Hex(canonicalBytes(drafts)),
      },
    },
    state: next,
    schedules: scheduleChanges(locked.schedules, next.schedules),
    continuation,
    // The kernel keeps one routine draft per dispatched input, the quantity `maxInputs` bounds.
    inputs: drafts.length,
  };
}

/**
 * The outbox intent of a committed world command: one `world-reactions` dispatch for the whole
 * command (the semantic action), anchored on its first event, with an ID derived from the journal
 * command ID like its event IDs. A command without events dispatches nothing.
 */
function worldReactionDispatches(
  request: JournalExecuteRequest,
  events: readonly JournalEventDraft[],
): readonly JournalDispatchIntent[] {
  const first = events[0];
  if (first === undefined) return [];
  return [
    {
      dispatchId: `${request.command.commandId}:dispatch:world-reactions`,
      eventId: first.eventId,
      channel: "world-reactions",
      privacyClass: KERNEL_EVENT_PRIVACY_CLASS,
      payload: { eventId: first.eventId, eventCount: events.length },
    },
  ];
}

function isContinuationCommand(command: CommandEnvelope<string, unknown>): boolean {
  return command.commandId.startsWith(`${TRUSTED_ID_PREFIX}continue:`);
}

/**
 * One kernel event as a journal draft on the command's route. The complete kernel event is the
 * payload (typed-node encoded, so bigints survive storage); its journal event ID derives from the
 * journal command ID and the event's position in the result.
 */
function draftOf(
  request: JournalExecuteRequest,
  attribution: AttributionEnvelope,
  event: WorldSemanticEvent,
  index: number,
): JournalEventDraft {
  const { command, route } = request;
  if (route === undefined) throw new TypeError("a world command always has a route");
  const payload = { kernelEvent: encodeCanonicalNode(event) };
  return {
    schemaVersion: 2,
    eventId: decodeOpaqueId(`${command.commandId}:event:${index}`, "EventId"),
    type: event.type,
    ...route,
    simulationTime: event.simulationTime,
    correlationId: command.context.correlationId,
    attribution,
    ...(command.attribution.principalId === undefined
      ? {}
      : { principalId: command.attribution.principalId }),
    policyVersions: event.policyVersions,
    privacyClass: KERNEL_EVENT_PRIVACY_CLASS,
    payloadHash: computePayloadHash(payload),
    payload,
  };
}

// ---------------------------------------------------------------------------------------------------
// Due work and continuations
// ---------------------------------------------------------------------------------------------------

export interface WorldPartitionScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
}

/** What a partition has pending: read outside any command transaction, so it is only a hint. */
export interface PendingWorldWork {
  readonly revision: bigint;
  readonly simulationTime: bigint;
  /** The next deadline: the earliest pending schedule's due time, or `null` when nothing is queued. */
  readonly nextDueAt: bigint | null;
  /** The open continuation, verified, and the trusted ID of its next chunk. */
  readonly continuation?: Readonly<{ commandId: CommandId; record: WorldContinuationRecord }>;
}

/** A pending schedule occurrence as the due query returns it. */
export interface DueSchedule {
  readonly scheduleId: string;
  readonly idempotencyKey: string;
  readonly dueAt: bigint;
}

/** Reads due work from the durable schedule rows (the due index). */
export interface DueWorkReader {
  /** The next-deadline query, with the partition's revision and open continuation. */
  pendingWork(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
  ): Promise<PendingWorldWork | undefined>;
  /** Pending occurrences due at or before `through`, in the kernel queue's order. */
  dueSchedules(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
    through: bigint,
  ): Promise<readonly DueSchedule[]>;
}

export interface DueWorkPorts extends WorldCommandPorts {
  readonly dueWork: DueWorkReader;
  /** Receives one `transaction_retries` point per command transaction this call runs again. */
  readonly metrics?: RuntimeMetrics;
}

export interface WorldPartitionRequest {
  readonly authorization: RuntimeAuthorizationContext;
  readonly target: Readonly<{ tenantId: TenantId; worldId: WorldId; timelineId: TimelineId }>;
  readonly route: WorldRoute;
}

export interface AdvanceDueWorkRequest extends WorldPartitionRequest {
  /** Advance through this simulation time: every schedule due at or before it runs. */
  readonly through: bigint;
  /** The kernel budget of each advance; defaults to `DUE_WORK_ADVANCE_BUDGET`. */
  readonly budget?: Readonly<{ maxInputs: number; maxEvents: number }>;
  /** At most this many commands (advances and chunks) per call; defaults to 64. */
  readonly maxCommands?: number;
  /** Also move time to `through` when nothing is due: a lazy advance (boundary events only). */
  readonly settle?: boolean;
}

export interface AdvanceDueWorkResult {
  /**
   * `idle`: nothing was due; `advanced`: due work ran and none is left; `pending`: the command bound
   * stopped it; `refused`: the kernel refused the last command (its rejected receipt is committed).
   */
  readonly status: "idle" | "advanced" | "pending" | "refused";
  readonly commands: readonly WorldCommandResult[];
}

function trustedRequest(
  request: WorldPartitionRequest,
  command: CommandEnvelope<string, unknown>,
): WorldCommandRequest {
  const { authorization, route } = request;
  return {
    authorization,
    command,
    commandBytes: canonicalBytes(command),
    route,
    authorityDecision: allowDecision({
      tenantId: command.target.tenantId,
      worldId: command.target.worldId,
      timelineId: command.target.timelineId,
      commandId: command.commandId,
      attribution: command.attribution,
      inputs: {
        principalId: authorization.principalId,
        roles: [],
        grants: [],
        privacyCeiling: authorization.privacyCeiling,
      },
    }),
  };
}

/**
 * The trusted command of the next chunk of an open continuation. Every byte derives from the stored
 * record, so a retry of the chunk sends identical bytes under the same trusted ID.
 */
export function continuationCommand(
  commandId: CommandId,
  record: WorldContinuationRecord,
): CommandEnvelope<string, unknown> {
  const origin = record.originCommand;
  if (commandId !== continuationCommandId(origin.commandId, record.chunk)) {
    throw new TypeError("a continuation chunk ID derives from its origin and chunk number");
  }
  return {
    schemaVersion: 1,
    commandId,
    type: origin.type,
    target: origin.target,
    expected: { partitionRevision: record.continuation.expectedRevision },
    issuedAt: origin.issuedAt,
    context: origin.context,
    attribution: { ...origin.attribution, immediateCauseId: origin.commandId },
    payload: origin.payload,
  };
}

/**
 * The trusted `world.advance` of due work: `trusted:advance:<timeline>:<partition>:<revision>:<target>`.
 * The ID is unforgeable (clients may not use the trusted namespace) and every byte derives from it.
 */
export function dueWorkAdvanceCommand(
  request: WorldPartitionRequest,
  revision: bigint,
  targetTime: bigint,
  budget: Readonly<{ maxInputs: number; maxEvents: number }>,
  lazy = false,
): CommandEnvelope<string, unknown> {
  const { tenantId, worldId, timelineId } = request.target;
  const commandId = decodeOpaqueId(
    `${TRUSTED_ID_PREFIX}advance:${timelineId}:${request.route.partitionId}:${revision}:${targetTime}${lazy ? ":lazy" : ""}`,
    "CommandId",
  );
  return {
    schemaVersion: 1,
    commandId,
    type: "world.advance",
    target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
    expected: { partitionRevision: revision },
    issuedAt: TRUSTED_COMMAND_ISSUED_AT,
    context: {
      version: 1,
      correlationId: decodeOpaqueId(commandId, "CorrelationId"),
      requestId: commandId,
    },
    attribution: {
      effectiveActorId: "clockgrove:due-work",
      causalRootActionId: decodeOpaqueId(`action:${commandId}`, "ActionId"),
    },
    payload: {
      schemaVersion: 1,
      targetTime,
      maxInputs: budget.maxInputs,
      maxEvents: budget.maxEvents,
      ...(lazy ? { lazy: true } : {}),
    },
  } as CommandEnvelope<string, unknown>;
}

function scopeOf(request: WorldPartitionRequest): WorldPartitionScope {
  return { ...request.target, partitionId: request.route.partitionId };
}

/**
 * Runs the next chunk of the partition's open continuation as its own transaction under its trusted
 * ID. Returns `undefined` when no continuation is open. A retry of a committed chunk returns its
 * stored outcome without running the kernel.
 */
export async function continueWorldCommand(
  request: WorldPartitionRequest,
  ports: DueWorkPorts,
): Promise<WorldCommandResult | undefined> {
  const pending = await ports.dueWork.pendingWork(request.authorization, scopeOf(request));
  const open = pending?.continuation;
  if (open === undefined) return undefined;
  return runWorldCommand(
    trustedRequest(request, continuationCommand(open.commandId, open.record)),
    ports,
  );
}

/**
 * Advances a partition through its due work: first the chunks of an open continuation, then, while a
 * schedule is due at or before `through`, one trusted `world.advance` to `through` (each kernel call
 * bounded by `budget`, each chunk its own transaction). A stale revision re-reads and retries; the
 * expected revision and trusted IDs make a retry of the whole call append nothing twice.
 * Only a `partition` conflict is transient: due work sets no stream expectation, and a stale routing
 * epoch, clock policy or owner generation refuses every retry alike, so those propagate.
 */
export async function advanceDueWork(
  request: AdvanceDueWorkRequest,
  ports: DueWorkPorts,
): Promise<AdvanceDueWorkResult> {
  const budget = request.budget ?? DUE_WORK_ADVANCE_BUDGET;
  const maxCommands = request.maxCommands ?? 64;
  const commands: WorldCommandResult[] = [];
  for (let attempt = 0; attempt < maxCommands; attempt += 1) {
    const pending = await ports.dueWork.pendingWork(request.authorization, scopeOf(request));
    if (pending === undefined)
      return { status: commands.length === 0 ? "idle" : "advanced", commands };
    let command: CommandEnvelope<string, unknown>;
    if (pending.continuation !== undefined) {
      command = continuationCommand(pending.continuation.commandId, pending.continuation.record);
    } else if (
      (pending.nextDueAt !== null && pending.nextDueAt <= request.through) ||
      (request.settle === true && pending.simulationTime < request.through)
    ) {
      const target =
        request.through > pending.simulationTime ? request.through : pending.simulationTime;
      const lazy = pending.nextDueAt === null || pending.nextDueAt > request.through;
      command = dueWorkAdvanceCommand(request, pending.revision, target, budget, lazy);
    } else {
      return { status: commands.length === 0 ? "idle" : "advanced", commands };
    }
    try {
      const result = await runWorldCommand(trustedRequest(request, command), ports);
      commands.push(result);
      if (result.outcome === "rejected") return { status: "refused", commands };
    } catch (error) {
      if (
        (error instanceof JournalRevisionConflictError && error.kind === "partition") ||
        error instanceof WorldContinuationPendingError
      ) {
        // Only a retry this call runs: at `maxCommands` it returns `pending` to its caller instead.
        if (attempt + 1 < maxCommands)
          recordMetric(ports.metrics, {
            name: "transaction_retries",
            tenantId: request.target.tenantId,
            worldId: request.target.worldId,
            label:
              error instanceof WorldContinuationPendingError
                ? "continuation_pending"
                : "revision_conflict",
            value: 1,
          });
        continue;
      }
      throw error;
    }
  }
  return { status: "pending", commands };
}
