import {
  AuthorizationRefusedError,
  CanonicalNodeError,
  type CausalCommandView,
  type CausalEventView,
  type CausalInspectorPorts,
  type CausalScheduleView,
  decodeCanonicalNode,
  InspectedCommandNotFoundError,
  InspectedEventNotFoundError,
  InspectedScheduleNotFoundError,
  InspectionIntegrityError,
  type InspectorEvidenceClass,
  inspectCommand,
  inspectEvent,
  inspectEventCommand,
  inspectSchedule,
  inspectScheduleCommand,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  JournalRouteNotFoundError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationContext,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import {
  type CommandId,
  ContractDecodeError,
  decodeBrowserScope,
  decodeOpaqueId,
  decodePublicRoutineDraft,
  type EventId,
  type PrincipalId,
  type PublicCausalEntry,
  type PublicResourceCause,
  type PublicScheduledAction,
  type QueueEnvelope,
  RECORDED_WHY_EVIDENCE,
  type RecordedWhy,
  type SceneConnectionMetadata,
} from "@clockgrove/contracts";
import {
  narrowTrustedExecutionContext,
  type TrustedExecutionContext,
} from "@clockgrove/contracts/trusted";
import {
  type InspectorAccess,
  type PostgreSqlClient,
  PostgreSqlInspectorAudit,
  PostgreSqlJournalRangeSource,
  PostgreSqlPersistenceTransactionPort,
  PostgreSqlRuntimeOperatorActions,
  PostgreSqlRuntimeStateReader,
  type RuntimeOperatorAction,
  type RuntimeOperatorActionOutcome,
  type RuntimeOperatorActionTarget,
  type RuntimeStateRecord,
  type WorldReactionBacklog,
} from "@clockgrove/persistence";
import type { OwnerMailboxEntryKind, OwnerMailboxState } from "./mailbox.js";
import { ROUTE_NAME_PREFIX, ROUTE_VERSION } from "./routing.js";
import type { RuntimeInitializationDisposition, RuntimeLocalState, RuntimeScope } from "./types.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

export type { RuntimeOperatorActionOutcome } from "@clockgrove/persistence";

/** Reading a causal chain needs its own grant; `runtime:world-command` never implies it. */
export const INSPECT_GRANT = "runtime:world-inspect";
/** Public observation is independent of operator inspection and mutation. */
export const OBSERVE_GRANT = "runtime:world-observe";
/**
 * Runtime operator actions (publication repair, message replay) need their own grant (the maintainer
 * 2026-10-27, issue 852): `runtime:world-inspect` stays read-only and implies no action, and no other
 * grant implies this one. issue 815 reuses it for any later operator action.
 */
export const OPERATE_GRANT = "runtime:world-operate";

export interface CausalChainInput {
  readonly scope: RuntimeScope;
  readonly commandId: CommandId;
}

/** Where a traversal starts: a command, one event, or one schedule row of the scope. */
export type CausalEntryInput = (
  | CausalChainInput
  | { readonly scope: RuntimeScope; readonly eventId: EventId }
  | { readonly scope: RuntimeScope; readonly scheduleId: string; readonly idempotencyKey: string }
) & { readonly includeResourceCauses?: true };

export type CausalEntryView = CausalCommandView | CausalEventView | CausalScheduleView;

/** The entry's audit identity: its command, event ID, or `[scheduleId, idempotencyKey]` (0033). */
export function entryIdentity(input: CausalEntryInput): string {
  return "commandId" in input
    ? input.commandId
    : "eventId" in input
      ? input.eventId
      : JSON.stringify([input.scheduleId, input.idempotencyKey]);
}

export interface RuntimeStateInput {
  readonly scope: RuntimeScope;
}

export type RuntimeActionInput = RuntimeOperatorActionTarget & { readonly scope: RuntimeScope };

// Matches the audit tables' ID bound (migrations 0022, 0031): an oversized ID is refused before any row.
const MAX_ID_OCTETS = 1024;
// Matches `inspector_accesses.entry_id` (migration 0033): an encoded schedule identity over it,
// which JSON escaping can produce from two IDs within 1024 octets each, is refused before any row.
const MAX_ENTRY_ID_OCTETS = 2100;
const SCOPE_KEYS = ["schemaVersion", "tenantId", "worldId", "timelineId", "spaceId"] as const;
const OPERATOR_ACTIONS: readonly RuntimeOperatorAction[] = ["repair-publication", "replay-message"];

/** A strict version-1 envelope of exactly the scope keys plus `extra`; IDs 1 to 1024 octets. */
function decodeScopedRequest(
  value: unknown,
  extra: readonly string[],
): { readonly scope: RuntimeScope; readonly input: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractDecodeError("request", "object required");
  const input = value as Record<string, unknown>;
  const keys = [...SCOPE_KEYS, ...extra];
  if (
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => key in input) ||
    input.schemaVersion !== 1
  )
    throw new ContractDecodeError("request", "invalid envelope");
  const scope = decodeBrowserScope({
    tenantId: input.tenantId,
    worldId: input.worldId,
    timelineId: input.timelineId,
    spaceId: input.spaceId,
  });
  return { scope, input };
}

function assertIdLengths(ids: readonly string[]): void {
  for (const id of ids)
    if (id === "" || new TextEncoder().encode(id).length > MAX_ID_OCTETS)
      throw new ContractDecodeError("request", "ID length out of range");
}

/**
 * Strict `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }` plus exactly one entry:
 * `commandId`, `eventId`, or `scheduleId` with `idempotencyKey`.
 */
export function decodeCausalChainInput(value: unknown): CausalEntryInput {
  const keys =
    typeof value === "object" && value !== null && "eventId" in value
      ? ["eventId"]
      : typeof value === "object" && value !== null && "scheduleId" in value
        ? ["scheduleId", "idempotencyKey"]
        : ["commandId"];
  const { scope, input } = decodeScopedRequest(value, keys);
  if (keys[0] === "eventId") {
    const eventId = decodeOpaqueId(input.eventId, "EventId");
    assertIdLengths([...Object.values(scope), eventId]);
    return { scope, eventId };
  }
  if (keys[0] === "scheduleId") {
    const { scheduleId, idempotencyKey } = input;
    if (typeof scheduleId !== "string" || typeof idempotencyKey !== "string")
      throw new ContractDecodeError("request", "schedule identity required");
    assertIdLengths([...Object.values(scope), scheduleId, idempotencyKey]);
    const entry = { scope, scheduleId, idempotencyKey };
    if (new TextEncoder().encode(entryIdentity(entry)).length > MAX_ENTRY_ID_OCTETS)
      throw new ContractDecodeError("request", "ID length out of range");
    return entry;
  }
  const commandId = decodeOpaqueId(input.commandId, "CommandId");
  assertIdLengths([...Object.values(scope), commandId]);
  return { scope, commandId };
}

/** Strict `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }`. */
export function decodeRuntimeStateInput(value: unknown): RuntimeStateInput {
  const { scope } = decodeScopedRequest(value, []);
  assertIdLengths(Object.values(scope));
  return { scope };
}

/**
 * Strict `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId, action, messageId }`, where
 * `action` is `repair-publication` or `replay-message` and `messageId` a world-reactions message's
 * semantic ID (its dispatch ID).
 */
export function decodeRuntimeActionInput(value: unknown): RuntimeActionInput {
  const { scope, input } = decodeScopedRequest(value, ["action", "messageId"]);
  const action = OPERATOR_ACTIONS.find((candidate) => candidate === input.action);
  if (action === undefined) throw new ContractDecodeError("request.action", "unknown action");
  if (typeof input.messageId !== "string" || input.messageId.trim() !== input.messageId)
    throw new ContractDecodeError("request.messageId", "message ID required");
  assertIdLengths([...Object.values(scope), input.messageId]);
  return { scope, action, messageId: input.messageId };
}

/**
 * One runtime connection: chain reads under the caller's authority and their audit rows. Each read
 * checks its own grant and ceiling, whatever its caller checked: no grant implies another,
 * and a refusal is audited before it is thrown.
 */
export class PostgreSqlCausalInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  constructor(private readonly client: PostgreSqlClient) {
    this.audit = new PostgreSqlInspectorAudit(client);
  }

  /**
   * The operator causal-chain view from any entry, under `runtime:world-inspect` and an
   * `operator_evidence` ceiling. An entry outside the requested world, timeline and space answers
   * like an unknown ID.
   */
  async inspect(
    input: CausalEntryInput,
    context: TrustedExecutionContext,
  ): Promise<CausalEntryView> {
    await this.authorize(input, context, INSPECT_GRANT, "operator_evidence");
    return this.read<CausalEntryView>(
      input,
      worldAuthorization(context),
      (authorization, ports, options) =>
        "commandId" in input
          ? inspectCommand(authorization, input.commandId, ports, options)
          : "eventId" in input
            ? inspectEvent(authorization, input.eventId, ports, options)
            : inspectSchedule(authorization, input, ports, options),
    );
  }

  /**
   * Public Why under `runtime:world-observe`: the closed `RecordedWhy` only, never the causal-chain
   * view, read with the ceiling narrowed to `public_scene` here, so a broader one never expands it.
   * An event entry answers its command's Why; a scheduled action the Why of the command that
   * consumed it, else (pending) of the one that scheduled it.
   */
  async recordedWhy(
    input: CausalEntryInput,
    context: TrustedExecutionContext,
  ): Promise<RecordedWhy> {
    await this.authorize(input, context, OBSERVE_GRANT);
    const narrowed = narrowTrustedExecutionContext(context, {
      ...context,
      privacyCeiling: {
        version: 1,
        allowedCategories: context.privacyCeiling.allowedCategories.includes("public_scene")
          ? ["public_scene"]
          : [],
      },
    });
    const authorization = worldAuthorization(narrowed);
    // The entry access reads one command; each link is then its own access, as from a command.
    const linked = (target: CausalChainInput) =>
      this.read(target, authorization, (reader, ports, options) =>
        inspectCommand(reader, target.commandId, ports, options),
      );
    let command: CausalCommandView;
    let entry: PublicCausalEntry;
    if ("eventId" in input) {
      command = (
        await this.read(input, authorization, (reader, ports, options) =>
          inspectEventCommand(reader, input.eventId, ports, options),
        )
      ).command;
      entry = { kind: "event", eventId: input.eventId };
    } else if ("scheduleId" in input) {
      command = (
        await this.read(input, authorization, (reader, ports, options) =>
          inspectScheduleCommand(reader, input, ports, options),
        )
      ).command;
      entry = {
        kind: "scheduled-action",
        scheduleId: input.scheduleId,
        idempotencyKey: input.idempotencyKey,
      };
    } else {
      command = await linked(input);
      entry = { kind: "command" };
    }
    const commandInput = { scope: input.scope, commandId: command.receipt.commandId };
    return {
      ...(await publicRecordedWhy(
        commandInput,
        command,
        linked,
        input.includeResourceCauses === true,
      )),
      entry,
    };
  }

  /** Records a refused access under the requested tenant, whether or not the principal is a member. */
  deny(
    input: CausalEntryInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }

  private async authorize(
    input: CausalEntryInput,
    context: TrustedExecutionContext,
    grant: typeof INSPECT_GRANT | typeof OBSERVE_GRANT,
    category?: "operator_evidence",
  ): Promise<void> {
    try {
      assertWorldCommandContext(context, input.scope, grant);
      if (category !== undefined && !context.privacyCeiling.allowedCategories.includes(category))
        throw new AuthorizationRefusedError("inspection ceiling refused");
      // Schedule rows are the kernel state's class: a ceiling without it refuses the entry.
      if (
        "scheduleId" in input &&
        !context.privacyCeiling.allowedCategories.includes("public_scene")
      )
        throw new AuthorizationRefusedError("inspection ceiling refused");
    } catch (error) {
      await this.deny(input, context.principalId, undefined);
      throw error;
    }
  }

  /**
   * Admits the access under the rate limit, reads the chain from its entry with the application
   * inspector, then records the access before anything is returned. Linked reads inside an event or
   * schedule traversal are part of this one access.
   */
  private async read<T>(
    input: CausalEntryInput,
    authorization: RuntimeAuthorizationContext,
    run: (
      authorization: RuntimeAuthorizationContext,
      ports: CausalInspectorPorts,
      options: { readonly scope: RuntimeScope },
    ) => Promise<T>,
  ): Promise<T> {
    await this.audit.admit(authorization);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const ports = {
        transactions: new PostgreSqlPersistenceTransactionPort(this.client),
        events: (reader: RuntimeAuthorizationContext) =>
          new JournalRangeReader(
            new PostgreSqlJournalRangeSource(this.client, reader),
            JOURNAL_EVENT_REGISTRY,
          ),
      };
      const view = await run(authorization, ports, { scope: input.scope });
      reasonCode = "served";
      return view;
    } catch (error) {
      if (
        error instanceof InspectedCommandNotFoundError ||
        error instanceof InspectedEventNotFoundError ||
        error instanceof InspectedScheduleNotFoundError
      )
        reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, access(input, "allow", reasonCode));
    }
  }
}

function access(
  input: CausalEntryInput,
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  const place = { worldId, timelineId, spaceId, decision, reasonCode };
  return "commandId" in input
    ? { ...place, commandId: input.commandId }
    : {
        ...place,
        subject: "eventId" in input ? "event" : "scheduled-action",
        entryId: entryIdentity(input),
      };
}

function publicResourceCauses(view: CausalCommandView): readonly PublicResourceCause[] {
  const events = (view.events ?? []).flatMap((event) => {
    if (
      event.privacyClass !== "public_scene" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      !("kernelEvent" in event.payload)
    )
      return [];
    const kernel = decodeCanonicalNode(event.payload.kernelEvent);
    if (
      typeof kernel !== "object" ||
      kernel === null ||
      !("payload" in kernel) ||
      typeof kernel.payload !== "object" ||
      kernel.payload === null
    )
      return [];
    return [{ event, kernel, payload: kernel.payload as Record<string, unknown> }];
  });
  return events.flatMap(({ event, kernel, payload }, index): PublicResourceCause[] => {
    let cause: PublicResourceCause["cause"];
    let kind: PublicResourceCause["kind"];
    let quantity: unknown;
    let objectId: unknown;
    if (event.type === "resource.weather-integrated") {
      cause = "rain";
      kind = "water";
      quantity = payload.collected;
      objectId = payload.objectId;
    } else if (event.type === "growth.stage-changed") {
      cause = "growth";
      kind = "food";
      quantity =
        typeof payload.yield === "object" && payload.yield !== null && "quantity" in payload.yield
          ? payload.yield.quantity
          : 0;
      objectId = payload.objectId;
    } else if (event.type === "resource.transferred") {
      cause = "transfer";
      kind = payload.kind as PublicResourceCause["kind"];
      quantity = payload.quantity;
      objectId = payload.toObjectId;
    } else if (event.type === "resource.boundary-exchanged") {
      cause = "boundary-exchange";
      kind = payload.kind as PublicResourceCause["kind"];
      quantity = payload.quantity;
      objectId = payload.objectId;
      if (
        typeof payload.boundaryId !== "string" ||
        typeof payload.boundaryName !== "string" ||
        typeof payload.actorId !== "string" ||
        (payload.direction !== "import" && payload.direction !== "export")
      )
        throw new InspectionIntegrityError(view.receipt.commandId, "events");
    } else return [];
    if (quantity === 0 || quantity === undefined) return [];
    if (
      !Number.isSafeInteger(quantity) ||
      Number(quantity) < 1 ||
      typeof objectId !== "string" ||
      (kind !== "food" && kind !== "water")
    )
      throw new InspectionIntegrityError(view.receipt.commandId, "events");
    const prior = events[index - 1];
    const attribution = "attribution" in kernel ? kernel.attribution : undefined;
    const process =
      cause === "transfer" &&
      prior?.event.type === "process.command-attempted" &&
      prior.payload.refusal === null &&
      typeof prior.payload.processId === "string" &&
      typeof attribution === "object" &&
      attribution !== null &&
      "immediateCauseId" in attribution &&
      attribution.immediateCauseId === prior.payload.commandId
        ? prior.payload.processId
        : undefined;
    return [
      {
        eventId: event.eventId,
        simulationTime: event.simulationTime.toString(),
        cause,
        kind,
        quantity: Number(quantity),
        objectId: decodeOpaqueId(objectId, "ObjectId"),
        ...(cause === "transfer"
          ? { fromObjectId: decodeOpaqueId(payload.fromObjectId, "ObjectId") }
          : {}),
        ...(process === undefined ? {} : { processId: process }),
        ...(cause === "boundary-exchange"
          ? {
              boundaryId: payload.boundaryId as string,
              boundaryName: payload.boundaryName as string,
              actorId: decodeOpaqueId(payload.actorId, "ObjectId"),
              direction: payload.direction as "import" | "export",
            }
          : {}),
      },
    ];
  });
}

/** Closed public projection of an audited, retained command view, never of current world state. */
export async function publicRecordedWhy(
  input: CausalChainInput,
  view: CausalCommandView,
  inspectLinked: (input: CausalChainInput) => Promise<CausalCommandView>,
  includeResourceCauses = false,
): Promise<RecordedWhy> {
  let traces: RecordedWhy["traces"];
  try {
    const retained = view.decisionTraces;
    if (retained === undefined) traces = { status: "redacted", drafts: [] };
    else if (retained.status === "unavailable") traces = { status: "unavailable", drafts: [] };
    else {
      const decoded = decodeCanonicalNode(retained.drafts);
      if (!Array.isArray(decoded)) throw new InspectionIntegrityError(input.commandId, "traces");
      traces = { status: "available", drafts: decoded.map(decodePublicRoutineDraft) };
    }
  } catch (error) {
    // Durable corruption is a server defect, never malformed observer input.
    if (error instanceof ContractDecodeError || error instanceof CanonicalNodeError)
      throw new InspectionIntegrityError(input.commandId, "traces");
    throw error;
  }
  const links: {
    parents: RecordedWhy["links"]["parents"];
    children: RecordedWhy["links"]["children"];
  } = {
    parents: [],
    children: [],
  };
  // Declared causes can name foreign commands. Only expose identities readable in this scope.
  // Work is bounded by the immutable receipt's existing link set and existing inspector admission.
  for (const direction of ["parents", "children"] as const) {
    const admitted = [];
    for (const commandId of view.links[direction]) {
      try {
        await inspectLinked({ scope: input.scope, commandId });
        admitted.push(commandId);
      } catch (error) {
        if (!(error instanceof InspectedCommandNotFoundError)) throw error;
      }
    }
    links[direction] = admitted;
  }
  // A schedule row is shown only when each command it names is this one or an admitted link.
  const shown = new Set<string>([view.receipt.commandId, ...links.parents, ...links.children]);
  const schedules: PublicScheduledAction[] = view.schedules
    .filter(
      (row) =>
        shown.has(row.scheduledBy) && (row.completedBy === undefined || shown.has(row.completedBy)),
    )
    .map((row) => ({
      scheduleId: row.scheduleId,
      idempotencyKey: row.idempotencyKey,
      kind: row.kind,
      dueAt: row.dueAt.toString(),
      status: row.status,
      scheduledBy: row.scheduledBy,
      completedBy: row.completedBy ?? null,
    }));
  return {
    version: 1,
    ...input.scope,
    privacyClass: "public_scene",
    evidence: RECORDED_WHY_EVIDENCE,
    entry: { kind: "command" },
    commandId: view.receipt.commandId,
    actionId: view.receipt.actionId ?? null,
    receiptStatus: view.receipt.status,
    traces,
    ...(includeResourceCauses ? { resourceCauses: publicResourceCauses(view) } : {}),
    schedules,
    links,
  };
}

/** A value read from PostgreSQL: journal truth at the read, superseded only by the journal itself. */
export interface CanonicalValue<T> {
  readonly evidence: Extract<InspectorEvidenceClass, "canonical">;
  readonly value: T;
}

/** A value the runtime or a provider held when observed (epoch ms); it may be stale already. */
export interface OperationalValue<T> {
  readonly evidence: Extract<InspectorEvidenceClass, "operational">;
  readonly observedAt: number;
  readonly mayBeStale: true;
  readonly value: T;
}

/**
 * What one `SpaceDO` incarnation holds about itself, in memory and local storage: never canonical
 * (Wave 3 plan §7.2), and gone with the incarnation. Times are epoch milliseconds.
 */
export interface OwnerRuntimeState {
  readonly observedAt: number;
  readonly connections?: readonly SceneConnectionMetadata[];
  readonly incarnation: {
    readonly runtimeInstanceId: string;
    readonly startedAt: number;
    /**
     * How this incarnation found its local storage, at its first initialization or clock-owner claim:
     * `rehydrated` (none: a new owner, a restart that lost storage, or a rename), `reconciled` (an
     * earlier incarnation's generation or placement) or `unchanged`. Null until it did either.
     */
    readonly initialization: {
      readonly disposition: RuntimeInitializationDisposition;
      readonly at: number;
    } | null;
  };
  /**
   * The hydration revision: the partition revision this incarnation's last committed world command,
   * resume, alarm or catch-up step returned, and when, to compare with the canonical
   * `placement.projectionRevision`. Each command hydrates the partition from PostgreSQL in its own
   * transaction, so a lower value means the partition has advanced since, not that a cache is stale.
   * Null before its first commit.
   */
  readonly hydration: { readonly revision: bigint; readonly at: number } | null;
  readonly alarm: {
    /** The owner generation this storage last claimed. */
    readonly generation: bigint | null;
    /** The native alarm's time, and the wall time it was mapped to with why (`planned`, `recovery`). */
    readonly scheduledAt: number | null;
    readonly mapped: { readonly at: number; readonly label: "planned" | "recovery" } | null;
  };
  readonly mailbox: {
    readonly depth: number;
    readonly oldestEntryAgeMs: number;
    readonly admission: OwnerMailboxState["admission"];
    readonly active: {
      readonly kind: OwnerMailboxEntryKind;
      readonly commandId: string | null;
      readonly enqueuedAt: number;
      readonly startedAt: number | null;
      readonly deadlineAt: number | null;
    } | null;
  };
}

/** The §14 runtime state of one scope that exists in Wave 3, each value labelled by evidence class. */
export interface RuntimeStateView {
  readonly schemaVersion: 1;
  readonly scope: RuntimeScope;
  /** Journal inspection (the causal chain) is the authority; nothing here supersedes it. */
  readonly authority: "journal";
  readonly placement: CanonicalValue<RuntimeStateRecord["placement"]>;
  readonly clock: CanonicalValue<{
    readonly policyVersion: bigint;
    readonly running: boolean;
    readonly simulationMillisecondsPerWallMillisecond: number;
    readonly simulationTime: bigint;
    readonly admittedHorizon: bigint;
    readonly ownerGeneration: bigint;
    readonly nextDeadline: bigint | null;
    readonly continuationOpen: boolean;
  }>;
  readonly catchUp: CanonicalValue<RuntimeStateRecord["catchUp"]>;
  readonly worldReactions: CanonicalValue<WorldReactionBacklog>;
  readonly runtime: OperationalValue<{
    readonly codeVersion: string;
    /** The runtime local-storage schema this code reads and writes (`RuntimeLocalState`). */
    readonly localSchemaVersion: RuntimeLocalState["schemaVersion"];
    readonly routeVersion: string;
    readonly routeNamePrefix: string;
  }>;
  readonly owner: OperationalValue<Omit<OwnerRuntimeState, "observedAt">>;
  /** The native catch-up Workflow instance of the open operation, as the provider answered. */
  readonly catchUpWorkflow: OperationalValue<{
    readonly instanceId: string;
    readonly status: string;
  } | null>;
}

/** The runtime state the inspector reads from owners and providers, besides PostgreSQL. */
export interface RuntimeStatePorts {
  owner(scope: RuntimeScope, context: TrustedExecutionContext): Promise<OwnerRuntimeState>;
  /** The native status of the catch-up Workflow of `applicationRunId`; `unavailable` if unknown. */
  catchUpWorkflow(applicationRunId: string): Promise<{
    readonly instanceId: string;
    readonly status: string;
    readonly observedAt: number;
  }>;
}

/**
 * The runtime-state inspector: the causal-chain inspector's grant, scope check, rate limit
 * and audit, with subject `runtime-state`. It reads PostgreSQL under the caller's authority (no write
 * but the audit row) and the space owner's own state, which no mailbox entry carries: reading it
 * touches no partition, so a full or stuck mailbox stays inspectable.
 */
export class PostgreSqlRuntimeStateInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly ports: RuntimeStatePorts,
  ) {
    this.audit = new PostgreSqlInspectorAudit(client);
  }

  async inspect(
    input: RuntimeStateInput,
    context: TrustedExecutionContext,
  ): Promise<RuntimeStateView> {
    assertWorldCommandContext(context, input.scope, INSPECT_GRANT);
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const canonical = await new PostgreSqlRuntimeStateReader(this.client).read(
        authorization,
        input.scope,
      );
      const { observedAt, ...owner } = await this.ports.owner(input.scope, context);
      const workflow =
        canonical.catchUp === null
          ? undefined
          : await this.ports.catchUpWorkflow(canonical.catchUp.applicationRunId);
      const { policy, ...clock } = canonical.clock;
      reasonCode = "served";
      return {
        schemaVersion: 1,
        scope: input.scope,
        authority: "journal",
        placement: { evidence: "canonical", value: canonical.placement },
        clock: {
          evidence: "canonical",
          value: {
            policyVersion: policy.version,
            running: policy.running,
            simulationMillisecondsPerWallMillisecond:
              policy.simulationMillisecondsPerWallMillisecond,
            ...clock,
          },
        },
        catchUp: { evidence: "canonical", value: canonical.catchUp },
        worldReactions: { evidence: "canonical", value: canonical.worldReactions },
        runtime: operational(Date.now(), {
          codeVersion: context.codeVersion,
          localSchemaVersion: 1,
          routeVersion: ROUTE_VERSION,
          routeNamePrefix: ROUTE_NAME_PREFIX,
        }),
        owner: operational(observedAt, owner),
        catchUpWorkflow:
          workflow === undefined
            ? operational(Date.now(), null)
            : operational(workflow.observedAt, {
                instanceId: workflow.instanceId,
                status: workflow.status,
              }),
      };
    } catch (error) {
      if (error instanceof JournalRouteNotFoundError) reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, stateAccess(input, "allow", reasonCode));
    }
  }

  deny(
    input: RuntimeStateInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      stateAccess(input, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }
}

function operational<T>(observedAt: number, value: T): OperationalValue<T> {
  return { evidence: "operational", observedAt, mayBeStale: true, value };
}

function stateAccess(
  input: RuntimeStateInput,
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = input.scope;
  return { subject: "runtime-state", worldId, timelineId, spaceId, decision, reasonCode };
}

/**
 * The two runtime operator actions (2026-10-27) under `runtime:world-operate`. Each is
 * audited in `runtime_operator_actions` in the transaction that performs it; refusals are audited too.
 */
export class PostgreSqlRuntimeOperator {
  private readonly actions: PostgreSqlRuntimeOperatorActions;
  constructor(
    client: PostgreSqlClient,
    /** The world-reactions source Queue. */
    private readonly publish: (message: QueueEnvelope<unknown>) => Promise<void>,
  ) {
    this.actions = new PostgreSqlRuntimeOperatorActions(client);
  }

  async act(
    input: RuntimeActionInput,
    context: TrustedExecutionContext,
  ): Promise<RuntimeOperatorActionOutcome> {
    assertWorldCommandContext(context, input.scope, OPERATE_GRANT);
    const authorization = worldAuthorization(context);
    await this.actions.admit(authorization);
    return input.action === "repair-publication"
      ? this.actions.repair(authorization, input)
      : this.actions.replay(authorization, input, this.publish);
  }

  deny(
    input: RuntimeActionInput,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.actions.deny(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      input,
      denial?.reasonCode ?? "authority-mismatch",
    );
  }
}
