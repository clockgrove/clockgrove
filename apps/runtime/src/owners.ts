import type {
  Journal,
  JournalExecuteRequest,
  RuntimeAuthorizationDenial,
  StoredJournalOutcome,
} from "@clockgrove/application";
import {
  allowDecision,
  computePayloadHash,
  denyDecision,
  JOURNAL_EVENT_REGISTRY,
  JournalRouteNotFoundError,
  NO_PRIVACY_CEILING,
  RUNTIME_NO_OP_ACCEPTED,
  readsStoredOutcomes,
  VerifiedJournal,
} from "@clockgrove/application";
import type {
  ActionId,
  AuthorityDecisionId,
  CommandEnvelope,
  CommandId,
  CorrelationId,
  EventId,
  PrincipalId,
  SimTimeMs,
  SubjectId,
} from "@clockgrove/contracts";
import { CommandIdempotencyInvariantError, constructActorAddress } from "@clockgrove/contracts";
import {
  referenceTrustedExecutionContext,
  type TrustedExecutionContext,
} from "@clockgrove/contracts/trusted";

import type { CanonicalRuntimeStateSource } from "./canonical-state.js";
import type { RuntimeLocalStorage } from "./local-storage.js";
import { type RuntimeOwnerKind, runtimeRouteName } from "./routing.js";
import type {
  CanonicalRuntimeState,
  NoOpResponse,
  RuntimeEpochs,
  RuntimeInitializationResult,
  RuntimeInstanceId,
  RuntimeLocalState,
  RuntimeScope,
} from "./types.js";
import { RuntimeEpochConflictError, RuntimeRouteKeyMismatchError } from "./types.js";

interface RuntimeOwnerOptions {
  readonly kind: RuntimeOwnerKind;
  readonly scope: RuntimeScope;
  readonly routeName: string;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly storage: RuntimeLocalStorage;
  readonly canonical: CanonicalRuntimeStateSource;
  readonly subjectId?: SubjectId;
}

abstract class RuntimeOwner {
  private canonicalState?: CanonicalRuntimeState;

  protected constructor(private readonly options: RuntimeOwnerOptions) {}

  async initialize(context: TrustedExecutionContext): Promise<RuntimeInitializationResult> {
    const expectedRoute = await this.expectedRouteName();
    if (expectedRoute !== this.options.routeName) throw new RuntimeRouteKeyMismatchError();

    // This is a read-only lookup. Absence fails closed and cannot create a world.
    const canonical = await this.options.canonical.loadReadyRuntimeState(
      context,
      this.options.scope,
    );
    const state: RuntimeLocalState = {
      schemaVersion: 1,
      owner: this.options.kind,
      routeName: expectedRoute,
      placement: {
        worldId: canonical.worldId,
        timelineId: canonical.timelineId,
        spaceId: canonical.spaceId,
        runtimeCellId: canonical.runtimeCellId,
        runtimeInstanceId: this.options.runtimeInstanceId,
        routingEpoch: canonical.routingEpoch,
        authorityEpoch: canonical.authorityEpoch,
        fidelity: canonical.fidelity,
      },
      projectionRevision: canonical.projectionRevision,
      partitionId: canonical.partitionId,
      primaryStreamId: canonical.primaryStreamId,
      ...(this.options.subjectId === undefined ? {} : { subjectId: this.options.subjectId }),
    };
    const previous = await this.options.storage.read();
    const disposition =
      previous === undefined
        ? "rehydrated"
        : sameLocalState(previous, state)
          ? "unchanged"
          : "reconciled";
    if (disposition !== "unchanged") await this.options.storage.replace(state);
    this.canonicalState = canonical;
    return { disposition, state };
  }

  protected canonicalAfterInitialization(): CanonicalRuntimeState {
    if (this.canonicalState === undefined) throw new Error("runtime owner is not initialized");
    return this.canonicalState;
  }

  protected validateEpochs(request: RuntimeEpochs): void {
    const canonical = this.canonicalAfterInitialization();
    if (request.routingEpoch !== canonical.routingEpoch) {
      throw new RuntimeEpochConflictError("routing", request.routingEpoch, canonical.routingEpoch);
    }
    if (request.authorityEpoch !== canonical.authorityEpoch) {
      throw new RuntimeEpochConflictError(
        "authority",
        request.authorityEpoch,
        canonical.authorityEpoch,
      );
    }
  }

  private expectedRouteName(): Promise<string> {
    return runtimeRouteName(this.options.kind, this.options.scope, this.options.subjectId);
  }
}

export class WorldDO extends RuntimeOwner {
  constructor(options: Omit<RuntimeOwnerOptions, "kind" | "subjectId">) {
    super({ ...options, kind: "world" });
  }

  validateRequestEpochs(epochs: RuntimeEpochs): void {
    this.validateEpochs(epochs);
  }
}

export type NoOpCommandInput = Readonly<{
  commandId: CommandId;
  actionId: ActionId;
  eventId: EventId;
  /** Client-supplied and ignored: trusted code mints the command's decision ID. */
  authorityDecisionId: AuthorityDecisionId;
  epochs: RuntimeEpochs;
  issuedAt: string;
  expectedProjectionRevision: bigint;
}>;

/** Trusted request metadata that the command envelope references. */
export interface NoOpRequestMetadata {
  readonly requestId: string;
  readonly correlationId: CorrelationId;
}

/** A command whose stored outcome is a rejection; the gateway answers it as a refusal. */
export class StoredRejectionError extends Error {
  constructor(readonly value: unknown) {
    super("command was rejected");
    this.name = "StoredRejectionError";
  }
}

/** The stable rejection a recorded authorization denial stores and returns. */
export const AUTHORIZATION_REFUSED_RESULT = Object.freeze({ error: "authorization_refused" });

export class SpaceDO extends RuntimeOwner {
  constructor(
    options: Omit<RuntimeOwnerOptions, "kind" | "subjectId"> & { readonly journal: Journal },
  ) {
    super({ ...options, kind: "space" });
    this.journal = new VerifiedJournal(options.journal, JOURNAL_EVENT_REGISTRY);
    this.scope = options.scope;
  }

  private readonly journal: Journal;
  private readonly scope: RuntimeScope;

  async submitNoOp(
    context: TrustedExecutionContext,
    input: NoOpCommandInput,
    disposition: RuntimeInitializationResult["disposition"],
  ): Promise<NoOpResponse> {
    this.validateEpochs(input.epochs);
    const canonical = this.canonicalAfterInitialization();
    const command = noOpCommand(
      this.scope,
      context.principalId,
      referenceTrustedExecutionContext(context),
      input,
    );
    const authorityDecision = allowDecision({
      tenantId: canonical.tenantId,
      worldId: canonical.worldId,
      timelineId: canonical.timelineId,
      commandId: command.commandId,
      attribution: command.attribution,
      inputs: {
        principalId: context.principalId,
        ...(context.worldMembershipId === undefined
          ? {}
          : { worldMembershipId: context.worldMembershipId }),
        ...(context.personaId === undefined ? {} : { personaId: context.personaId }),
        roles: context.roles,
        grants: context.grants,
        privacyCeiling: context.privacyCeiling,
      },
    });
    const noOpPayload = {};
    const stableResult: NoOpResponse = {
      accepted: true,
      correlationId: context.correlationId,
      disposition,
    };
    const request: JournalExecuteRequest<string, unknown, NoOpResponse> = {
      authorization: {
        tenantId: context.tenantId,
        principalId: context.principalId,
        privacyCeiling: context.privacyCeiling,
      },
      command,
      commandBytes: encodeCommand(command),
      route: {
        partitionId: canonical.partitionId,
        spaceId: canonical.spaceId,
        streamId: canonical.primaryStreamId,
      },
      authorityDecision,
      events: [
        {
          schemaVersion: 2,
          eventId: input.eventId,
          type: RUNTIME_NO_OP_ACCEPTED,
          partitionId: canonical.partitionId,
          spaceId: canonical.spaceId,
          streamId: canonical.primaryStreamId,
          simulationTime: 0n as SimTimeMs,
          correlationId: context.correlationId,
          attribution: {
            ...command.attribution,
            authorityDecisionId: authorityDecision.authorityDecisionId,
          },
          actor: command.target,
          principalId: context.principalId,
          policyVersions: { runtime: "1" },
          privacyClass: "operator_evidence",
          payloadHash: computePayloadHash(noOpPayload),
          payload: noOpPayload,
        },
      ],
      dispatches: [
        {
          dispatchId: `runtime-no-op:${input.commandId}`,
          eventId: input.eventId,
          channel: "world-reactions",
          privacyClass: "operator_evidence",
          payload: { eventId: input.eventId },
        },
      ],
      stableResult,
      projectionDelta: null,
    };
    const result = await this.journal.execute(request);
    if (result.outcome === "rejected") throw new StoredRejectionError(result.value);
    return result.value;
  }
}

/**
 * The no-op command envelope. It depends only on the request scope and input, the authenticated
 * principal and the request metadata (after epoch validation the request epochs equal the canonical
 * ones), so an allowed command, a denied one and a retry lookup derive the same bytes.
 */
export function noOpCommand(
  scope: RuntimeScope,
  principalId: PrincipalId,
  metadata: NoOpRequestMetadata,
  input: NoOpCommandInput,
): CommandEnvelope<"RuntimeNoOp", Record<string, never>> {
  const { tenantId, worldId, timelineId, spaceId } = scope;
  return {
    schemaVersion: 2,
    commandId: input.commandId,
    type: "RuntimeNoOp",
    target: constructActorAddress({ tenantId, worldId, timelineId, kind: "space", id: spaceId }),
    expected: {
      partitionRevision: input.expectedProjectionRevision,
      routingEpoch: Number(input.epochs.routingEpoch),
    },
    issuedAt: input.issuedAt,
    context: { version: 1, correlationId: metadata.correlationId, requestId: metadata.requestId },
    attribution: { principalId, effectiveActorId: spaceId, causalRootActionId: input.actionId },
    payload: {},
  };
}

/**
 * The stored outcome of an exact retry of a decided no-op, read before any authorization and
 * without creating a runtime owner. The command bytes include the principal, so only that
 * principal's own command matches, and row-level security admits only a member of the tenant.
 */
export async function storedNoOpOutcome(
  journal: Journal,
  scope: RuntimeScope,
  principalId: PrincipalId,
  metadata: NoOpRequestMetadata,
  input: NoOpCommandInput,
): Promise<StoredJournalOutcome<unknown> | undefined> {
  if (!readsStoredOutcomes(journal)) return undefined;
  const command = noOpCommand(scope, principalId, metadata, input);
  return await journal.storedOutcome(
    { tenantId: scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
    command.commandId,
    encodeCommand(command),
  );
}

/**
 * Records an authorization denial as a rejected receipt and a deny decision. Returns false, and
 * writes nothing, when the scope names no world and timeline of the authenticated tenant, or when
 * the command ID already belongs to different command bytes; the refusal itself stands.
 */
export async function recordNoOpDenial(
  journal: Journal,
  scope: RuntimeScope,
  principalId: PrincipalId,
  metadata: NoOpRequestMetadata,
  input: NoOpCommandInput,
  denial: RuntimeAuthorizationDenial,
): Promise<boolean> {
  const command = noOpCommand(scope, principalId, metadata, input);
  const request: JournalExecuteRequest<string, unknown, unknown> = {
    authorization: { tenantId: scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
    command,
    commandBytes: encodeCommand(command),
    authorityDecision: denyDecision(
      {
        tenantId: scope.tenantId,
        worldId: scope.worldId,
        timelineId: scope.timelineId,
        commandId: command.commandId,
        attribution: command.attribution,
        inputs: denial.inputs,
      },
      denial.reasonCode,
    ),
    events: [],
    dispatches: [],
    stableResult: AUTHORIZATION_REFUSED_RESULT,
    projectionDelta: null,
  };
  try {
    await new VerifiedJournal(journal, JOURNAL_EVENT_REGISTRY).execute(request);
    return true;
  } catch (error) {
    if (
      error instanceof JournalRouteNotFoundError ||
      error instanceof CommandIdempotencyInvariantError
    )
      return false;
    throw error;
  }
}

export class ActorAgentDO extends RuntimeOwner {
  constructor(options: Omit<RuntimeOwnerOptions, "kind"> & { readonly subjectId: SubjectId }) {
    super({ ...options, kind: "actor-agent" });
  }

  validateRequestEpochs(epochs: RuntimeEpochs): void {
    this.validateEpochs(epochs);
  }
}

function sameLocalState(left: RuntimeLocalState, right: RuntimeLocalState): boolean {
  return JSON.stringify(left, bigintJson) === JSON.stringify(right, bigintJson);
}

function encodeCommand(command: CommandEnvelope<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(command, bigintJson));
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
