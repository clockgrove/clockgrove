/// <reference path="./cloudflare-adapter-types.d.ts" />
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type ActivationAddress,
  type ActivationConfiguration,
  type ActivationInspection,
  type ActivationPolicy,
  type ActivationWake,
  type ActorActivation,
  type ActorCommandPolicy,
  type ActorReplyShadowRecord,
  AuthenticationRefusedError,
  AuthorizationRefusedError,
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
  type CapabilityGrants,
  type CatchUpWorkflowEnvelope,
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponder,
  type ConversationStore,
  catchUpWorkflowReference,
  decodeCatchUpWorkflowEnvelope,
  decodeLifecycleWorkflowEnvelope,
  type InternalGrantView,
  JOURNAL_EVENT_TYPES,
  type JournalPostCommitNotifier,
  JournalRevisionConflictError,
  type LifecycleWorkflowEnvelope,
  MAX_ACTOR_ACTIVATIONS,
  type ModerationShadowPolicy,
  operationRefusal,
  ProvisioningCaseConflictError,
  type ProvisioningRefusal,
  ProvisioningStageError,
  type ProvisionWorldRequest,
  type RuntimeLogger,
  recordMetric,
  runtimeLogRecord,
  type ShadowDecider,
  type StoredCommandProposal,
  type TurnCommandRecord,
  type TurnFiber,
  type WakeTriagePolicy,
  type WorldCommandResult,
  WorldGenesisDefectError,
  type WorldProvisioningPorts,
  WorldProvisioningRefusedError,
  type WorldProvisioningStore,
} from "@clockgrove/application";
import {
  type ActorProcess,
  type ActorProcessBudget,
  type ActorProcessMode,
  type BrowserScope,
  ContractDecodeError,
  type ConversationSessionParticipant,
  decodeOpaqueId,
  decodeSceneConnectionAttachment,
  encodeOperatorSceneMessage,
  encodeSceneConnectionControl,
  parseSceneClientControl,
  SCENE_PROTOCOL,
  SceneCompatibilityError,
  type SceneConnectionAttachment,
  type SceneDisconnectReason,
  type SubjectId,
  type TalkRequest,
  type TalkStreamFrame,
  type TurnRequest,
  type TurnStatus,
  type UsageAdmissionSource,
} from "@clockgrove/contracts";
import {
  constructTrustedExecutionContext,
  type TrustedExecutionContext,
} from "@clockgrove/contracts/trusted";
import type { ModelGateway } from "@clockgrove/model-gateway";
import {
  PostgreSqlActorDocuments,
  type PostgreSqlClient,
  PostgreSqlLifecycleWorkflowStore,
  PostgreSqlModerationShadow,
  PostgreSqlRunRecorder,
  PostgreSqlWakeTriage,
  PostgreSqlWorldProvisioningStore,
  withClientTransaction,
} from "@clockgrove/persistence";
import {
  decodeResource,
  parseWorldPackLimits,
  type WorldPackLimits,
} from "@clockgrove/world-pack-sdk";
import { Agent, type FiberRecoveryContext } from "agents";
import {
  ActivationGateBlockedError,
  type ActorAgentRecovery,
  type DirectMessageActivation,
  PerceptionInbox,
  type SelfOutcome,
  TurnFibers,
  type TurnResearchHost,
} from "./actor-agent.js";
import {
  type ActorModelDeps,
  type ActorWorldCommand,
  actorCommandId,
  actorContextSettings,
  actorGateway,
  actorModelConfiguration,
  actorPreparedResponder,
  actorResponder,
  actorWorldCommand,
  type PerceptionFocus,
  type PreparedResponder,
  standingOf,
} from "./actor-model.js";
import {
  activationHintNotifier,
  composeConversations,
  composeRuntime,
  perceiveListing,
  perceiveScene,
  type RuntimeEnvironment,
  readSelfResults,
  reconcileWorldCatchUp,
  reconcileWorldProvisioning,
  runtimeLogger,
  withActivations,
  withActorCapabilityClient,
  withActorProcesses,
  withCommandOwner,
  withGovernedDelivery,
  withLifecycleWorkflowClient,
  withWakeTriageClient,
  worldReactionNotifier,
} from "./cloudflare-entry.js";
import { analyticsEngineMetrics } from "./cloudflare-metrics.js";
import {
  CONVERSATION_REFUSAL_STATUS,
  type ConversationStores,
  encodeTalkFrame,
  scriptedConversationReply,
  type TurnOwnerAnswer,
} from "./conversations.js";
import {
  INSPECT_GRANT,
  OBSERVE_GRANT,
  OPERATE_GRANT,
  type OwnerRuntimeState,
} from "./inspector.js";
import type { RuntimeLocalStorage } from "./local-storage.js";
import {
  OwnerMailbox,
  type OwnerMailboxBounds,
  type OwnerMailboxEntry,
  OwnerMailboxError,
  type OwnerMailboxRequest,
  type OwnerMailboxState,
  SPACE_MAILBOX_BOUNDS,
} from "./mailbox.js";
import {
  readActorCommandPolicy,
  readActorMcpCapabilities,
  resolveActorCapabilities,
} from "./mcp-actor-capabilities.js";
import {
  actorReplyShadowPolicy,
  moderationShadowDecider,
  moderationShadowPolicy,
  shadowActorMessage,
  shadowActorReply,
} from "./moderation-shadow.js";
import { PostgreSqlSceneStreamReader } from "./observation.js";
import {
  OWNER_ACTIVATION_BUDGET,
  OwnerActivation,
  type OwnerActivationBudget,
} from "./owner-activation.js";
import * as owners from "./owners.js";
import { runtimeRouteName } from "./routing.js";
import { type SceneAuthorityFacts, sceneAuthorityFacts } from "./scene-audience.js";
import { SCENE_JOIN_HEADER, verifySceneJoin } from "./scene-connections.js";
import { SCENE_SOCKET_BOUNDS, SceneDelivery, sceneReads } from "./scene-delivery.js";
import { decodeScenePresentations } from "./scene-presentation.js";
import type {
  RuntimeEpochs,
  RuntimeInitializationDisposition,
  RuntimeInitializationResult,
  RuntimeInstanceId,
  RuntimeLocalState,
  RuntimeScope,
} from "./types.js";
import { RuntimeRouteKeyMismatchError } from "./types.js";
import { admitSpend, admittedShadowDecider } from "./usage-admission.js";
import { shadowActorWake, wakeTriageDecider, wakeTriagePolicy } from "./wake-triage.js";
import * as workflows from "./workflows.js";
import {
  assertWorldCommandContext,
  callWorldOwner,
  ownerLogIds,
  type PostgreSqlCommandOwner,
  runtimeFailureClass,
  unwrapWorldCommandRpc,
  type WorldCommandInput,
  WorldOwnerFailedError,
  worldAuthorization,
  worldCommandGrant,
  worldCommandRpc,
} from "./world-commands.js";

type AlarmPlan = Awaited<ReturnType<PostgreSqlCommandOwner["clockAlarmPlan"]>>;

export interface DurableObjectState {
  readonly id: { readonly name?: string; toString(): string };
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    transaction<T>(
      operation: (
        transaction: Pick<
          DurableObjectState["storage"],
          "get" | "put" | "setAlarm" | "deleteAlarm"
        >,
      ) => Promise<T>,
    ): Promise<T>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  abort(reason?: string): void;
  acceptWebSocket?(socket: WebSocket): void;
  getWebSockets?(): WebSocket[];
}

abstract class OwnerAdapter extends DurableObject<RuntimeEnvironment> {
  protected readonly local: RuntimeLocalStorage;
  protected readonly instanceId: RuntimeInstanceId;
  constructor(
    protected readonly state: DurableObjectState,
    protected readonly environment: RuntimeEnvironment,
  ) {
    super(state, environment);
    this.instanceId = `cloudflare:${crypto.randomUUID()}` as RuntimeInstanceId;
    this.local = {
      read: () => state.storage.get<RuntimeLocalState>("runtime-local-state"),
      replace: (value) => state.storage.put("runtime-local-state", value),
    };
  }
  protected async assertCommandRoute(
    kind: "world" | "space",
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    grant?: string,
  ): Promise<void> {
    assertWorldCommandContext(context, scope, grant);
    const route = await runtimeRouteName(kind, scope);
    if (this.state.id.name !== route) throw new RuntimeRouteKeyMismatchError();
  }
  protected get metrics() {
    return analyticsEngineMetrics(this.environment.METRICS);
  }
  /** This incarnation's start, and how it found its local storage: runtime state for the inspector. */
  protected readonly startedAt = Date.now();
  protected initialization:
    | { readonly disposition: RuntimeInitializationDisposition; readonly at: number }
    | undefined;
  /**
   * Records how this incarnation found its local storage, once: at its first initialization, or a
   * `SpaceDO`'s first clock-owner claim, whichever settles first. Later requests check that state
   * again, but they are not another rehydration or reconcile.
   */
  protected initialized(scope: RuntimeScope, disposition: RuntimeInitializationDisposition): void {
    if (this.initialization !== undefined) return;
    this.initialization = { disposition, at: Date.now() };
    recordMetric(this.metrics, {
      name: "owner_initializations",
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      label: disposition,
      value: 1,
    });
  }
  /** Initializes a request's owner shell; the incarnation's first initialization is recorded. */
  protected async initializeShell(
    shell: { initialize(context: TrustedExecutionContext): Promise<RuntimeInitializationResult> },
    scope: RuntimeScope,
    context: TrustedExecutionContext,
  ): Promise<RuntimeInitializationResult> {
    const result = await shell.initialize(context);
    this.initialized(scope, result.disposition);
    return result;
  }
  #logger: RuntimeLogger | undefined;
  /** Composed once per isolate instance: the release and environment are fixed for its life. */
  protected get logger(): RuntimeLogger {
    this.#logger ??= runtimeLogger(this.environment);
    return this.#logger;
  }
  protected options(scope: RuntimeScope) {
    if (this.state.id.name === undefined) throw new Error("named runtime route required");
    const dependencies = composeRuntime(this.environment);
    return {
      journal: dependencies.journal,
      scope,
      routeName: this.state.id.name,
      runtimeInstanceId: this.instanceId,
      storage: this.local,
      canonical: dependencies.canonical,
    };
  }
}

export class WorldDO extends OwnerAdapter {
  async submitWorldCommand(input: WorldCommandInput, context: TrustedExecutionContext) {
    const ids = ownerLogIds(input.scope, context, input.command.commandId);
    return worldCommandRpc(this.logger, ids, async () => {
      await this.assertCommandRoute("world", input.scope, context, worldCommandGrant(input));
      const canonical = await withCommandOwner(
        this.environment.HYPERDRIVE?.connectionString ?? "",
        (owner) => owner.reader.route(worldAuthorization(context), input.scope),
      );
      const scope = { ...input.scope, spaceId: canonical.spaceId };
      const route = await runtimeRouteName("space", scope);
      const result = await callWorldOwner(() =>
        this.environment.SPACE_DO.get(
          this.environment.SPACE_DO.idFromName(route),
        ).submitWorldCommand({ ...input, scope }, context),
      );
      return unwrapWorldCommandRpc(result);
    });
  }
  async resumeWorldCommand(scope: RuntimeScope, context: TrustedExecutionContext) {
    const ids = ownerLogIds(scope, context);
    return worldCommandRpc(this.logger, ids, async () => {
      await this.assertCommandRoute("world", scope, context);
      const canonical = await withCommandOwner(
        this.environment.HYPERDRIVE?.connectionString ?? "",
        (owner) => owner.reader.route(worldAuthorization(context), scope),
      );
      const canonicalScope = { ...scope, spaceId: canonical.spaceId };
      const route = await runtimeRouteName("space", canonicalScope);
      const result = await callWorldOwner(() =>
        this.environment.SPACE_DO.get(
          this.environment.SPACE_DO.idFromName(route),
        ).resumeWorldCommand(canonicalScope, context),
      );
      return unwrapWorldCommandRpc(result);
    });
  }

  async initialize(scope: RuntimeScope, context: TrustedExecutionContext) {
    return this.state.blockConcurrencyWhile(() =>
      this.initializeShell(new owners.WorldDO(this.options(scope)), scope, context),
    );
  }
  async validateRequestEpochs(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    epochs: RuntimeEpochs,
  ) {
    return this.state.blockConcurrencyWhile(async () => {
      const shell = new owners.WorldDO(this.options(scope));
      await this.initializeShell(shell, scope, context);
      shell.validateRequestEpochs(epochs);
    });
  }
}
type AlarmActivation = Readonly<{ id: string; policyVersion: bigint; ownerGeneration: bigint }>;
/**
 * The native alarm's wall time and why it was set: from the durable plan, or the recovery alarm
 * installed before work. Kept beside the alarm, for its lateness when delivered.
 */
type AlarmMark = Readonly<{ at: number; label: "planned" | "recovery" }>;
/** The catch-up an alarm hands its remaining work to, and its batch: why it stopped, and its ms. */
type AlarmOutcome = readonly [
  Awaited<ReturnType<PostgreSqlCommandOwner["registerCatchUp"]>>,
  Readonly<{ label: "drained" | "refused" | "continued" | "catch-up"; ms: number }> | undefined,
];
/** A client request's mailbox identity: its scope, trusted trace context, command and route epoch. */
function requestEntry(
  kind: "command" | "resume" | "inspect",
  scope: RuntimeScope,
  context: TrustedExecutionContext,
  input?: WorldCommandInput,
): OwnerMailboxRequest {
  return {
    kind,
    scope,
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(input === undefined
      ? {}
      : { commandId: input.command.commandId, routeEpoch: input.epochs.routingEpoch }),
  };
}
function catchUpEntry(envelope: CatchUpWorkflowEnvelope): OwnerMailboxRequest {
  return { kind: "catch-up", requestId: envelope.applicationRunId };
}
function mailboxLogIds({ scope, correlationId, requestId, commandId }: OwnerMailboxEntry) {
  return { ...scope, correlationId, requestId, commandId };
}
interface SceneReadAuthority {
  readonly key: string;
  readonly scope: RuntimeScope;
  readonly context: TrustedExecutionContext;
  readonly facts: SceneAuthorityFacts;
}
export class SpaceDO extends OwnerAdapter {
  protected readonly sceneDelivery = new SceneDelivery<SceneReadAuthority>(
    (attachment) => this.authorizeScene(attachment),
    async (attachment, authority, from) => {
      return this.admit({ kind: "inspect", scope: authority.scope }, authority.scope, () =>
        this.readScene(attachment, authority, from),
      );
    },
    (error) =>
      this.logger.log(
        runtimeLogRecord("error", "world_owner_failed", { failureClass: "internal" }, error),
      ),
    () => this.metrics,
  );
  /** One membership lookup: the current grants and ceiling, never an attachment's stale copy. */
  protected async authorizeScene(
    attachment: SceneConnectionAttachment,
  ): Promise<SceneReadAuthority> {
    const { privacyClass: _privacyClass, interest, ...scope } = attachment.audience;
    // Attachments carry identity and scope, never a surviving authority grant.
    const authentication = composeRuntime(this.environment).authentication;
    const authority = await authentication.world.resolveWorld(attachment.principalId, scope);
    if (
      authority === undefined ||
      authority.principalId !== attachment.principalId ||
      authority.tenantId !== scope.tenantId ||
      authority.worldId !== scope.worldId ||
      authority.timelineId !== scope.timelineId ||
      authority.spaceId !== scope.spaceId ||
      !authority.grants.some((grant) => grant === OBSERVE_GRANT) ||
      !authority.privacyCeiling.allowedCategories.includes("public_scene")
    )
      throw new AuthorizationRefusedError("scene audience refused");
    const facts = sceneAuthorityFacts(authority.grants, authority.privacyCeiling);
    const context = constructTrustedExecutionContext({
      version: 1,
      ...scope,
      principalId: authority.principalId,
      worldMembershipId: authority.membershipId,
      personaId: authority.personaId,
      roles: authority.roles,
      grants: [OBSERVE_GRANT],
      privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
      correlationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      codeVersion: authentication.codeVersion,
      protocolVersion: 1,
    });
    return {
      key: JSON.stringify([scope, interest, facts]),
      scope,
      context,
      facts,
    };
  }
  protected async readScene(
    attachment: SceneConnectionAttachment,
    authority: SceneReadAuthority,
    from: bigint | null,
  ) {
    return withLifecycleWorkflowClient(this.environment, (client) =>
      new PostgreSqlSceneStreamReader(
        client,
        decodeScenePresentations(this.environment.WORLD_PRESENTATION),
      ).read(
        { ...attachment, principalId: authority.context.principalId },
        from,
        authority.context,
        authority.facts,
      ),
    );
  }
  private sceneFanout: Promise<void> | undefined;
  private sceneDirty = false;
  private notifyScene(): void {
    this.sceneDirty = true;
    if (this.sceneFanout !== undefined) return;
    const work = (async () => {
      while (this.sceneDirty) {
        this.sceneDirty = false;
        await this.fanoutScene();
      }
    })();
    this.sceneFanout = work;
    this.state.waitUntil(
      work.finally(() => {
        if (this.sceneFanout === work) {
          this.sceneFanout = undefined;
          if (this.sceneDirty) this.notifyScene();
        }
      }),
    );
  }
  private async fanoutScene(): Promise<void> {
    // One authority lookup per principal; one PostgreSQL read and encoding per decided audience.
    const reads = sceneReads();
    const sockets = this.state.getWebSockets?.() ?? [];
    for (const socket of sockets) {
      try {
        await this.sceneDelivery.publish(socket, reads);
      } catch (error) {
        // Projection delivery cannot undo a committed command. Recovery reads PostgreSQL again.
        this.logger.log(
          runtimeLogRecord("error", "world_owner_failed", { failureClass: "internal" }, error),
        );
      }
    }
    // The operator lane: safe connection metadata, encoded once, sent only to operator audiences.
    const attachments = sockets.map((socket) =>
      decodeSceneConnectionAttachment(socket.deserializeAttachment()),
    );
    const first = attachments[0];
    if (first === undefined) {
      this.sceneDelivery.measure(reads);
      return;
    }
    const { privacyClass: _privacyClass, interest: _interest, ...scope } = first.audience;
    const wire = encodeOperatorSceneMessage({
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      ...scope,
      lane: "operator",
      type: "connections",
      payload: {
        connections: attachments.map(
          ({ principalId, acknowledgedRevision, connectionVersion }) => ({
            principalId,
            acknowledgedRevision,
            connectionVersion,
          }),
        ),
      },
    });
    let operators = 0;
    for (const socket of sockets)
      if (this.sceneDelivery.operate(socket, wire, reads)) operators += 1;
    this.sceneDelivery.measure(reads, operators);
  }
  private sceneAdmission(
    scope: { tenantId: string; worldId: string } | undefined,
    label: "admitted" | "refused",
  ): void {
    if (scope === undefined) return;
    recordMetric(this.metrics, { name: "scene_admissions", ...scope, label, value: 1 });
  }
  /** Internal-only route: the gateway strips all external authority before forwarding its assertion. */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/projection" || request.method !== "GET")
      return new Response(null, { status: 404 });
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-protocol") !== SCENE_PROTOCOL
    )
      return Response.json({ error: "incompatible_protocol" }, { status: 426 });
    // Unverified claims have no trustworthy tenant or world, so a refusal there records nothing.
    let known: { tenantId: string; worldId: string } | undefined;
    try {
      const claims = await verifySceneJoin(
        this.environment.BETTER_AUTH_SECRET ?? "",
        request.headers.get(SCENE_JOIN_HEADER) ?? "",
      );
      const { privacyClass: _privacyClass, interest: _interest, ...scope } = claims.audience;
      known = { tenantId: scope.tenantId, worldId: scope.worldId };
      const route = await runtimeRouteName("space", scope);
      if (this.state.id.name !== route) throw new RuntimeRouteKeyMismatchError();
      return await this.admit(
        { kind: "inspect", scope, routeEpoch: claims.authorityEpoch },
        scope,
        async (_activation, entry) => {
          // Reconstruct only the assertion's narrow authority, and never retain this execution context.
          const context = constructTrustedExecutionContext({
            version: 1,
            ...scope,
            principalId: claims.principalId,
            roles: [],
            grants: [OBSERVE_GRANT],
            privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
            correlationId: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            codeVersion: "scene-join",
            protocolVersion: 1,
          });
          const canonical = await composeRuntime(this.environment).canonical.loadReadyRuntimeState(
            context,
            scope,
          );
          if (canonical.authorityEpoch !== claims.authorityEpoch) {
            this.sceneAdmission(known, "refused");
            return Response.json({ error: "stale_authority_epoch" }, { status: 409 });
          }
          if (Date.now() >= claims.expiresAt)
            throw new AuthenticationRefusedError("expired scene join assertion");
          // An active mailbox entry may outlive its caller. Never accept a socket after that deadline.
          if (entry.deadlineAt !== null && Date.now() >= entry.deadlineAt)
            throw new OwnerMailboxError(
              "owner_mailbox_timeout",
              this.mailboxBounds().retryAfterSeconds,
            );
          if (this.state.acceptWebSocket === undefined)
            throw new Error("native hibernation API required");
          const resident = (this.state.getWebSockets?.() ?? []).map(
            (socket) => decodeSceneConnectionAttachment(socket.deserializeAttachment()).principalId,
          );
          if (
            resident.length >= SCENE_SOCKET_BOUNDS.perSpace ||
            resident.filter((principalId) => principalId === claims.principalId).length >=
              SCENE_SOCKET_BOUNDS.perPrincipal
          ) {
            this.sceneAdmission(known, "refused");
            return Response.json(
              { error: "scene_connections_full" },
              {
                status: 503,
                headers: { "retry-after": String(this.mailboxBounds().retryAfterSeconds) },
              },
            );
          }
          const pair = new WebSocketPair();
          pair[1].serializeAttachment({
            principalId: claims.principalId,
            audience: claims.audience,
            acknowledgedRevision: null,
            connectionVersion: 1,
          });
          this.state.acceptWebSocket(pair[1]);
          this.sceneDelivery.admitted(pair[1], claims.authorityEpoch);
          this.sceneAdmission(known, "admitted");
          const init = {
            status: 101,
            webSocket: pair[0],
            headers: { "sec-websocket-protocol": SCENE_PROTOCOL },
          };
          return new Response(null, init);
        },
      );
    } catch (error) {
      if (error instanceof AuthenticationRefusedError || error instanceof AuthorizationRefusedError)
        this.sceneAdmission(known, "refused");
      if (error instanceof AuthenticationRefusedError)
        return Response.json({ error: "authentication_refused" }, { status: 401 });
      if (error instanceof OwnerMailboxError)
        return Response.json(
          { error: error.code },
          { status: 503, headers: { "retry-after": String(error.retryAfterSeconds) } },
        );
      throw error;
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let control;
    try {
      if (typeof message !== "string") throw new ContractDecodeError("control", "text required");
      control = parseSceneClientControl(message);
    } catch (error) {
      if (
        error instanceof SceneCompatibilityError &&
        error.code === "unsupported_asset_manifest_version"
      ) {
        socket.send(
          encodeSceneConnectionControl({
            protocolVersion: 1,
            type: "recovery",
            reason: "asset_manifest_changed",
          }),
        );
        return;
      }
      const reason: SceneDisconnectReason =
        error instanceof SceneCompatibilityError
          ? "unsupported_protocol"
          : error instanceof ContractDecodeError
            ? "malformed_control"
            : "internal_error";
      this.sceneDelivery.disconnect(socket, reason);
      if (reason === "internal_error") throw error;
      return;
    }
    try {
      if (control.type === "resume") await this.sceneDelivery.resume(socket, control);
      else await this.sceneDelivery.acknowledge(socket, control);
    } catch (error) {
      this.logger.log(
        runtimeLogRecord(
          "error",
          "world_owner_failed",
          { failureClass: runtimeFailureClass(error) ?? "internal" },
          error,
        ),
      );
      throw error;
    }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.sceneDelivery.forget(socket);
    socket.close(code, reason);
  }
  webSocketError(socket: WebSocket): void {
    this.sceneDelivery.disconnect(socket, "internal_error");
  }

  protected now(): bigint {
    return BigInt(Date.now());
  }
  /** Named configuration with documented defaults (`OWNER_ACTIVATION_BUDGET`). */
  protected activationBudget(): OwnerActivationBudget {
    return OWNER_ACTIVATION_BUDGET;
  }
  protected catchUpEnabled(): boolean {
    return this.environment.WORLD_CATCH_UP_WORKFLOW !== undefined;
  }

  /**
   * One physical owner activation, shared by alarms and durable catch-up. It answers why it stopped:
   * no admitted due work left (`drained`), a kernel refusal, or its `activationBudget()` with work
   * possibly remaining (`continued`).
   */
  private async activateClock(
    owner: PostgreSqlCommandOwner,
    scope: RuntimeScope,
    activation: AlarmActivation,
    wallTime: bigint,
    started: number,
  ): Promise<"drained" | "refused" | "continued"> {
    const { maxCommands, startWithinMs } = this.activationBudget();
    for (let attempt = 0; attempt < maxCommands; attempt += 1) {
      if (performance.now() - started >= startWithinMs) break;
      const result = await owner.advanceClock(scope, wallTime, {
        activationId: activation.id,
        policyVersion: activation.policyVersion,
        admit: attempt === 0,
        ownerGeneration: activation.ownerGeneration,
      });
      this.hydrated(result.commands);
      if (result.status === "idle") return "drained";
      if (result.status === "refused") return "refused";
    }
    return "continued";
  }
  private async assertAlarmRoute(scope: RuntimeScope): Promise<void> {
    const route = await runtimeRouteName("space", scope);
    if (this.state.id.name !== route) throw new RuntimeRouteKeyMismatchError();
  }
  private ownerClaim: Promise<bigint> | undefined;
  private observedGeneration: bigint | undefined;
  /**
   * Claims once per incarnation. The generation observed before the first attempt is kept for every
   * retry, so a lost-response retry recovers this incarnation's claim, and an incarnation that a
   * newer one superseded is refused at any delay. A fenced owner never claims again.
   *
   * The local generation tells how the incarnation found its local storage: none (`rehydrated`, a
   * new owner or lost storage), an older generation (`reconciled`) or its own (`unchanged`).
   */
  private async claimAlarmGeneration(scope: RuntimeScope): Promise<bigint> {
    if (this.ownerClaim === undefined) {
      this.ownerClaim = this.withOwner(async (owner) => {
        this.observedGeneration ??= await owner.clockOwnerGeneration(scope);
        return owner.claimClockOwner(scope, this.instanceId, this.observedGeneration);
      }).catch((error: unknown) => {
        this.ownerClaim = undefined;
        throw error;
      });
    }
    const generation = await this.ownerClaim;
    const disposition = await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<bigint>("clock-alarm-generation");
      if (current !== undefined && current > generation)
        throw new JournalRevisionConflictError("owner-generation", generation, current);
      if (current !== generation) await transaction.put("clock-alarm-generation", generation);
      return current === undefined
        ? "rehydrated"
        : current === generation
          ? "unchanged"
          : "reconciled";
    });
    this.initialized(scope, disposition);
    return generation;
  }
  /** Installs the recovery alarm and its mark. */
  private async retainAlarm(scope: RuntimeScope, generation: bigint): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<bigint>("clock-alarm-generation");
      if (current !== generation)
        throw new JournalRevisionConflictError("owner-generation", generation, current ?? 0n);
      await transaction.put("clock-alarm-scope", scope);
      // Install recovery before journal work; a committed response can be lost before reconciliation.
      // Decision (no external source): 1 s outlasts the 250 ms alarm work budget
      // (`OWNER_ACTIVATION_BUDGET.startWithinMs`), so a healthy
      // call reconciles over it first, and bounds a lost reconciliation to about 1 s of stalled
      // clock. Firing early is harmless: alarm() queues behind the call and replans from PostgreSQL.
      const at = Date.now() + 1_000;
      await transaction.setAlarm(at);
      await transaction.put("clock-alarm-at", { at, label: "recovery" } satisfies AlarmMark);
    });
  }
  /** Maps the durable plan to the native alarm; a plan read on the caller's connection is reused. */
  protected async reconcile(
    scope: RuntimeScope,
    capturedGeneration?: bigint,
    planned?: AlarmPlan,
    catchUpActive = false,
  ): Promise<void> {
    const generation = capturedGeneration ?? (await this.claimAlarmGeneration(scope));
    const plan =
      planned ??
      (await this.withOwner((owner) => owner.clockAlarmPlan(scope, this.now(), generation)));
    await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<bigint>("clock-alarm-generation");
      if (current !== generation)
        throw new JournalRevisionConflictError("owner-generation", generation, current ?? 0n);
      if (catchUpActive || plan.nextAlarmAt === null) await transaction.deleteAlarm();
      else {
        await transaction.setAlarm(plan.nextAlarmAt);
        const mark = { at: plan.nextAlarmAt, label: "planned" } satisfies AlarmMark;
        await transaction.put("clock-alarm-at", mark);
      }
    });
  }
  async reconcileAlarm(scope: RuntimeScope): Promise<void> {
    return this.admit({ kind: "reconcile-alarm" }, scope, async () => {
      await this.assertAlarmRoute(scope);
      const generation = await this.claimAlarmGeneration(scope);
      await this.retainAlarm(scope, generation);
      await this.reconcile(scope, generation);
    });
  }
  async alarm(): Promise<void> {
    const started = performance.now();
    const delivered = Date.now();
    // The delivered alarm's mark, read now: an entry this delivery queues behind may set the next
    // alarm and its mark first. Local storage operations run in order. A failed read loses only it.
    const due = this.state.storage.get<AlarmMark>("clock-alarm-at").catch(() => undefined);
    return this.admit({ kind: "alarm" }, undefined, async (measured) => {
      const scope = await this.state.storage.get<RuntimeScope>("clock-alarm-scope");
      if (scope === undefined) return;
      measured.scope = scope;
      const point = { tenantId: scope.tenantId, worldId: scope.worldId };
      await this.assertAlarmRoute(scope);
      const generation = await this.claimAlarmGeneration(scope);
      await this.retainAlarm(scope, generation);
      const mark = await due;
      if (mark !== undefined)
        recordMetric(this.metrics, {
          ...point,
          name: "alarm_lateness_ms",
          label: mark.label,
          value: delivered - mark.at,
        });
      const [catchUp, batch] = await this.withOwner(async (owner): Promise<AlarmOutcome> => {
        const wallTime = this.now();
        const plan = await owner.clockAlarmPlan(scope, wallTime, generation);
        if (plan.nextAlarmAt === null) return [undefined, undefined];
        if (this.catchUpEnabled()) {
          const current = await owner.currentCatchUp(scope, generation);
          if (current !== undefined) return [current, undefined];
        }
        const previous = await this.state.storage.get<AlarmActivation | null>(
          "clock-alarm-activation",
        );
        const activation =
          previous?.policyVersion === plan.policyVersion && previous.ownerGeneration === generation
            ? previous
            : {
                id: crypto.randomUUID(),
                policyVersion: plan.policyVersion,
                ownerGeneration: generation,
              };
        await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<bigint>("clock-alarm-generation");
          if (current !== generation)
            throw new JournalRevisionConflictError("owner-generation", generation, current ?? 0n);
          await transaction.put("clock-alarm-activation", activation);
        });
        const batchStarted = Date.now();
        const stopped = await this.activateClock(owner, scope, activation, wallTime, started);
        const ms = Date.now() - batchStarted;
        if (this.catchUpEnabled() && (await owner.catchUpPending(scope, wallTime, generation))) {
          const registered = await owner.registerCatchUp(
            scope,
            generation,
            wallTime,
            plan.policyVersion,
          );
          return [registered, { label: registered === undefined ? stopped : "catch-up", ms }];
        }
        return [undefined, { label: stopped, ms }];
      }, true);
      if (batch !== undefined)
        recordMetric(this.metrics, {
          ...point,
          name: "alarm_batch_ms",
          label: batch.label,
          value: batch.ms,
          count: measured.advances,
        });
      await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get<bigint>("clock-alarm-generation");
        if (current !== generation)
          throw new JournalRevisionConflictError("owner-generation", generation, current ?? 0n);
        await transaction.put("clock-alarm-activation", null);
      });
      // Launch before deleting the fallback alarm. A failed launch leaves a retriable alarm.
      if (catchUp !== undefined)
        await reconcileWorldCatchUp(
          this.environment,
          catchUpWorkflowReference(catchUp),
          generation,
        );
      await this.reconcile(scope, generation, undefined, catchUp !== undefined);
    });
  }
  private async catchUpOwner(envelope: CatchUpWorkflowEnvelope) {
    await this.assertAlarmRoute(envelope);
    const accepted = await this.withOwner((owner) => owner.readCatchUp(envelope));
    if (accepted === undefined) return undefined;
    const generation = await this.claimAlarmGeneration(envelope);
    return { accepted, generation };
  }

  /** Detect interrupted execution after replacement without acknowledging a new native step. */
  async prepareCatchUp(input: CatchUpWorkflowEnvelope) {
    const envelope = decodeCatchUpWorkflowEnvelope(input);
    return this.admit(catchUpEntry(envelope), envelope, async () => {
      const owner = await this.catchUpOwner(envelope);
      if (owner === undefined) return { disposition: "superseded", replacement: false } as const;
      // Only catchUp() rebinds the operation. A lost restart response therefore remains detectable.
      return {
        disposition: "ready",
        replacement: owner.accepted.ownerGeneration !== owner.generation,
      } as const;
    });
  }

  /** The envelope selects accepted PostgreSQL work; it carries no authority or continuation. */
  async catchUp(
    input: CatchUpWorkflowEnvelope,
  ): Promise<{ disposition: "continue" | "complete" | "superseded" }> {
    const envelope = decodeCatchUpWorkflowEnvelope(input);
    const started = performance.now();
    return this.admit(catchUpEntry(envelope), envelope, async (measured, entry) => {
      // One point per step: its disposition, or `failed` for a step its Workflow retries.
      let label: "continue" | "complete" | "superseded" | "failed" = "failed";
      try {
        label = await this.catchUpStep(envelope, started);
        return { disposition: label };
      } finally {
        recordMetric(this.metrics, {
          name: "catch_up_step_ms",
          tenantId: envelope.tenantId,
          worldId: envelope.worldId,
          label,
          value: Date.now() - entry.enqueuedAt,
          count: measured.advances,
        });
      }
    });
  }

  private async catchUpStep(envelope: CatchUpWorkflowEnvelope, started: number) {
    const captured = await this.catchUpOwner(envelope);
    if (captured === undefined) return "superseded" as const;
    const { accepted, generation } = captured;
    await this.retainAlarm(envelope, generation);
    const disposition = await this.withOwner(async (owner) => {
      const operation = await owner.registerCatchUp(
        envelope,
        generation,
        accepted.wallTime,
        accepted.policyVersion,
        accepted.applicationRunId,
      );
      if (operation === undefined || operation.applicationRunId !== envelope.applicationRunId)
        return "superseded" as const;
      await this.activateClock(
        owner,
        envelope,
        {
          id: `${operation.applicationRunId}:${operation.step}`,
          policyVersion: operation.policyVersion,
          ownerGeneration: generation,
        },
        operation.wallTime,
        started,
      );
      const complete = !(await owner.catchUpPending(envelope, operation.wallTime, generation));
      if (!(await owner.finishCatchUp(operation, false))) return "superseded" as const;
      if (complete) {
        // Keep the durable link until the next alarm is restored: interruption or local loss
        // before this reconciliation must remain discoverable by scheduled recovery.
        await this.reconcile(
          envelope,
          generation,
          await owner.clockAlarmPlan(envelope, this.now(), generation),
        );
        if (!(await owner.finishCatchUp({ ...operation, step: operation.step + 1n }, true)))
          return "superseded" as const;
      }
      return complete ? ("complete" as const) : ("continue" as const);
    }, true);
    // New policy/owner intent is fenced by the same serialized admission and generation checks.
    if (disposition === "continue")
      await this.reconcile(
        envelope,
        generation,
        { policyVersion: accepted.policyVersion, nextAlarmAt: null },
        true,
      );
    return disposition;
  }

  /** The active entry's activation, while its work runs: the mailbox runs one entry at a time. */
  private activation: OwnerActivation | undefined;
  /**
   * Admits `work` as one mailbox entry (§8) and records, once it settles, its mailbox wait and
   * service time and its resource counters (`OwnerActivation`) for `scope`, or for the scope the
   * work sets on the activation.
   */
  private admit<T>(
    request: OwnerMailboxRequest,
    scope: RuntimeScope | undefined,
    work: (activation: OwnerActivation, entry: OwnerMailboxEntry) => Promise<T>,
  ): Promise<T> {
    return this.mailbox.admit(request, async (entry) => {
      const activation = new OwnerActivation(this.metrics, scope);
      this.activation = activation;
      try {
        return await work(activation, entry);
      } finally {
        this.activation = undefined;
        activation.settle(entry);
      }
    });
  }
  /**
   * The partition owner over one connection, whose statements count toward the active entry. With
   * `journal` its world commands record their points there too and notify world reactions and the
   * actors subscribed to the events they wrote.
   */
  private withOwner<T>(
    operation: (owner: PostgreSqlCommandOwner) => Promise<T>,
    journal = false,
  ): Promise<T> {
    return withCommandOwner(
      this.environment.HYPERDRIVE?.connectionString ?? "",
      operation,
      journal ? (this.activation ?? this.metrics) : undefined,
      journal ? this.committed : undefined,
      this.activation,
    );
  }
  /** Each hint only schedules its work; one failing never skips the other. */
  private readonly committed: JournalPostCommitNotifier = {
    notify: async (result) => {
      const waitUntil = (work: Promise<unknown>) => this.state.waitUntil(work);
      await Promise.allSettled([
        worldReactionNotifier(this.environment, waitUntil).notify(result),
        activationHintNotifier(this.environment, waitUntil).notify(result),
      ]);
    },
  };

  /** The physical lane (§8): every SpaceDO operation that touches the partition is admitted here. */
  private readonly mailbox = new OwnerMailbox({
    bounds: () => this.mailboxBounds(),
    failed: (error, entry, abandoned) => {
      // A timed-out entry's caller was already answered, so its later failure is logged here.
      if (abandoned && !(error instanceof WorldOwnerFailedError))
        this.logger.log(
          runtimeLogRecord(
            "error",
            "world_owner_failed",
            { ...mailboxLogIds(entry), failureClass: runtimeFailureClass(error) ?? "internal" },
            error,
          ),
        );
      this.resetIfSuperseded(error);
    },
    retain: (work) => this.state.waitUntil(work),
  });
  /** Named configuration with documented defaults (`SPACE_MAILBOX_BOUNDS`). */
  protected mailboxBounds(): OwnerMailboxBounds {
    return SPACE_MAILBOX_BOUNDS;
  }
  /** Runtime state for tests and the runtime inspector: in memory only, never canonical (§7.2). */
  protected mailboxState(): OwnerMailboxState {
    return this.mailbox.state();
  }
  /**
   * A newer generation fenced this incarnation: a zombie or racing instance claimed after it. It
   * must not claim again in place (issue 699: runtime replacement supersedes ownership), yet resident
   * traffic and alarm retries would keep it alive and refused forever. So it resets: Cloudflare
   * builds a fresh incarnation that observes and claims legitimately. The reset waits for the next
   * macrotask, after this call's refusal has settled and reached its caller.
   */
  private resetIfSuperseded(error: unknown): void {
    if (
      error instanceof JournalRevisionConflictError &&
      error.kind === "owner-generation" &&
      BigInt(error.actual) > BigInt(error.expected)
    )
      setTimeout(() => this.state.abort("clock owner superseded by a newer generation"), 0);
  }
  async submitWorldCommand(input: WorldCommandInput, context: TrustedExecutionContext) {
    const ids = ownerLogIds(input.scope, context, input.command.commandId);
    return worldCommandRpc(this.logger, ids, async () => {
      // Authorization precedes enqueue (§8): a refused request never occupies the lane.
      await this.assertCommandRoute("space", input.scope, context, worldCommandGrant(input));
      const entry = requestEntry("command", input.scope, context, input);
      return this.admit(entry, input.scope, async () => {
        const generation = await this.claimAlarmGeneration(input.scope);
        await this.retainAlarm(input.scope, generation);
        const [result, plan] = await this.withOwner(async (owner) => {
          const result = await owner.submit(input, context, () => this.now(), generation);
          return [result, await owner.clockAlarmPlan(input.scope, this.now(), generation)] as const;
        }, true);
        this.hydrated([result]);
        await this.reconcile(input.scope, generation, plan);
        return result;
      });
    });
  }
  async resumeWorldCommand(scope: RuntimeScope, context: TrustedExecutionContext) {
    const ids = ownerLogIds(scope, context);
    return worldCommandRpc(this.logger, ids, async () => {
      await this.assertCommandRoute("space", scope, context);
      return this.admit(requestEntry("resume", scope, context), scope, async () => {
        const generation = await this.claimAlarmGeneration(scope);
        await this.retainAlarm(scope, generation);
        const [result, plan] = await this.withOwner(async (owner) => {
          const result = await owner.resume(scope, context, generation);
          return [result, await owner.clockAlarmPlan(scope, this.now(), generation)] as const;
        }, true);
        this.hydrated([result]);
        await this.reconcile(scope, generation, plan);
        return result;
      });
    });
  }
  async inspectWorld(scope: RuntimeScope, context: TrustedExecutionContext) {
    await this.assertCommandRoute("space", scope, context);
    return this.admit(requestEntry("inspect", scope, context), scope, () =>
      this.withOwner((owner) => owner.inspect(worldAuthorization(context), scope, this.now())),
    );
  }
  /** The inspector's hydration revision (`OwnerRuntimeState.hydration`): memory only, never canonical. */
  private hydration: { readonly revision: bigint; readonly at: number } | undefined;
  private hydrated(results: readonly (WorldCommandResult | undefined)[]): void {
    if (results.some((result) => result?.value.status === "committed")) this.notifyScene();
    for (const result of results) {
      if (result?.value.status !== "committed") continue;
      const revision = BigInt(result.value.revision);
      // A retry's stored outcome answers an older revision; the latest one stays.
      if (this.hydration === undefined || revision >= this.hydration.revision)
        this.hydration = { revision, at: Date.now() };
    }
  }
  /**
   * This incarnation's own state for the runtime-state inspector: memory and local storage
   * reads only, no PostgreSQL and no claim. It touches no partition, so it is not a mailbox entry
   * (§8): a full or stuck mailbox stays inspectable, and the reading does not count itself.
   */
  async runtimeState(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
  ): Promise<OwnerRuntimeState> {
    await this.assertCommandRoute("space", scope, context, INSPECT_GRANT);
    const generation = await this.state.storage.get<bigint>("clock-alarm-generation");
    const mapped = await this.state.storage.get<AlarmMark>("clock-alarm-at");
    const scheduledAt = await this.state.storage.getAlarm();
    const mailbox = this.mailboxState();
    const active = mailbox.active;
    return {
      observedAt: Date.now(),
      connections: (this.state.getWebSockets?.() ?? []).map((socket) => {
        const { principalId, acknowledgedRevision, connectionVersion } =
          decodeSceneConnectionAttachment(socket.deserializeAttachment());
        return { principalId, acknowledgedRevision, connectionVersion };
      }),
      incarnation: {
        runtimeInstanceId: this.instanceId,
        startedAt: this.startedAt,
        initialization: this.initialization ?? null,
      },
      hydration: this.hydration ?? null,
      // The mark is written with each alarm it describes; with no alarm set it describes none.
      alarm: {
        generation: generation ?? null,
        scheduledAt,
        mapped: scheduledAt === null ? null : (mapped ?? null),
      },
      mailbox: {
        depth: mailbox.depth,
        oldestEntryAgeMs: mailbox.oldestEntryAgeMs,
        admission: mailbox.admission,
        active:
          active === null
            ? null
            : {
                kind: active.kind,
                commandId: active.commandId ?? null,
                enqueuedAt: active.enqueuedAt,
                startedAt: active.startedAt,
                deadlineAt: active.deadlineAt,
              },
      },
    };
  }

  async initialize(scope: RuntimeScope, context: TrustedExecutionContext) {
    return this.state.blockConcurrencyWhile(() =>
      worldCommandRpc(this.logger, ownerLogIds(scope, context), () =>
        this.initializeShell(this.shell(scope), scope, context),
      ),
    );
  }
  async submitNoOp(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    input: Parameters<owners.SpaceDO["submitNoOp"]>[1],
    disposition: Parameters<owners.SpaceDO["submitNoOp"]>[2],
  ) {
    // A refusal is a reply, not a throw: a throw out of blockConcurrencyWhile resets the object.
    return this.state.blockConcurrencyWhile(() =>
      worldCommandRpc(this.logger, ownerLogIds(scope, context, input.commandId), async () => {
        const shell = this.shell(scope);
        await this.initializeShell(shell, scope, context);
        return shell.submitNoOp(context, input, disposition);
      }),
    );
  }
  private shell(scope: RuntimeScope) {
    return new owners.SpaceDO(this.options(scope));
  }
}
/** Where one actor's turn fiber is, for the Agents SDK's interrupted-work recovery. */
interface TurnFiberSnapshot {
  readonly participant: ConversationParticipant;
  readonly scope: RuntimeScope;
  readonly actorId: string;
  readonly sessionId: string;
  readonly messageId: string;
}

const RECOVERY_KEY = "actor-agent-recovery";
const INBOX_KEY = "actor-agent-inbox";
const ACTIVATION_ADDRESS_KEY = "activation-address";
/** Prefix of the activation alarm keys, one per principal that armed this actor. */
const ACTIVATION_ALARM_KEY = "activation-alarm";
const DELIVERY_CURSOR_KEY = "delivery-cursor";

/** Why an activation arming runs, which decides how soon it plans the next check. */
export interface ActivationArming {
  /** A configuration changed: check within one second. */
  readonly initial?: boolean;
  /** The SDK callback consuming the current alarm: always replace it. */
  readonly fromCallback?: boolean;
  /** Admitted work may be interrupted: keep a recovery check one second out. */
  readonly forceRecovery?: boolean;
  /** Unread journal events may match a subscription: check within one second. */
  readonly prompt?: boolean;
}

/** Where one arming is: requested, inside the serialized arming section, or out of it again. */
export type ActivationArmingStep = "requested" | "started" | "settled";

/**
 * The per-actor cognitive owner (Wave 5 §7, RW-0503 with RW-0307), on the pinned Agents SDK. It runs
 * each Caretaker message as a turn fiber checkpointed in PostgreSQL, streams its reply, and resumes
 * open turns after eviction: through the SDK's fiber recovery when its local storage survives, and
 * from PostgreSQL at the participant's next call when it does not. Local storage holds only the
 * runtime state, the inbox, recovery metadata and the SDK's fiber rows, all rebuildable.
 */
export class ActorAgentDO extends Agent<RuntimeEnvironment> {
  protected readonly instanceId = `cloudflare:${crypto.randomUUID()}` as RuntimeInstanceId;
  private recovery: ActorAgentRecovery | undefined;
  private capabilityReconciliation: Promise<unknown> = Promise.resolve();
  private inbox: PerceptionInbox | undefined;
  private readonly recoveredFor = new Set<string>();
  #fibers: TurnFibers | undefined;
  /** Trusted contexts by principal and persona: each member's grants bound only their own turns. */
  readonly #talkContexts = new Map<string, TrustedExecutionContext>();
  /** Each member's read of the world's actor-command declaration (issue 359), by world and principal. */
  readonly #actorCommands = new Map<string, Promise<ActorCommandPolicy | undefined>>();

  #talkContext(who: { readonly principalId: string; readonly personaId: string }) {
    return this.#talkContexts.get(`${who.principalId}:${who.personaId}`);
  }
  #arming: Promise<unknown> = Promise.resolve();
  /** Journal hints this incarnation received; a callback compares it across its scan. */
  #journalHints = 0;

  /** The SDK's `ctx` and `env`, typed by this module's portable declarations. */
  protected get objectState(): DurableObjectState {
    return (this as unknown as { readonly ctx: DurableObjectState }).ctx;
  }
  private get environment(): RuntimeEnvironment {
    return (this as unknown as { readonly env: RuntimeEnvironment }).env;
  }

  private get local(): RuntimeLocalStorage {
    return {
      read: () => this.objectState.storage.get<RuntimeLocalState>("runtime-local-state"),
      replace: (value) => this.objectState.storage.put("runtime-local-state", value),
    };
  }

  private shell(scope: RuntimeScope, subjectId: SubjectId) {
    const route = this.objectState.id.name;
    if (route === undefined) throw new Error("named runtime route required");
    const dependencies = composeRuntime(this.environment);
    return new owners.ActorAgentDO({
      scope,
      routeName: route,
      runtimeInstanceId: this.instanceId,
      storage: this.local,
      canonical: dependencies.canonical,
      subjectId,
    });
  }

  async initialize(scope: RuntimeScope, context: TrustedExecutionContext, subjectId: SubjectId) {
    return this.objectState.blockConcurrencyWhile(async () => {
      const result = await this.shell(scope, subjectId).initialize(context);
      await this.loadRecovery();
      return result;
    });
  }

  async validateRequestEpochs(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    subjectId: SubjectId,
    epochs: RuntimeEpochs,
  ) {
    return this.objectState.blockConcurrencyWhile(async () => {
      const shell = this.shell(scope, subjectId);
      await shell.initialize(context);
      shell.validateRequestEpochs(epochs);
    });
  }

  async moderationShadowReport(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ) {
    assertWorldCommandContext(context, scope);
    if (!context.privacyCeiling.allowedCategories.includes("conversation"))
      throw new AuthorizationRefusedError("moderation report refused");
    await this.ready(scope, context, actorId);
    return withWakeTriageClient(this.environment, (client) =>
      new PostgreSqlModerationShadow(client).report(participant, scope as BrowserScope, actorId),
    );
  }
  protected moderationDecider(
    policy: ModerationShadowPolicy,
    fiber: TurnFiber,
  ): ShadowDecider | undefined {
    return moderationShadowDecider(this.environment, policy, fiber);
  }
  protected actorReplyDecider(
    policy: ModerationShadowPolicy,
    fiber: TurnFiber,
  ): ShadowDecider | undefined {
    return moderationShadowDecider(this.environment, policy, fiber);
  }
  /** Contentless telemetry: one structured log line per judged reply, never its text. */
  protected recordActorReply(record: ActorReplyShadowRecord): void | Promise<void> {
    console.log(JSON.stringify({ event: "actor-reply-shadow", ...record }));
  }
  /** Judges a committed reply beside the turn; the platform keeps the object alive for it. */
  private judgeActorReply(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    reply: string,
  ): void {
    let policy: ModerationShadowPolicy | undefined;
    try {
      policy = actorReplyShadowPolicy(this.environment.ACTOR_REPLY_SHADOW_CONFIG);
    } catch {
      console.warn(JSON.stringify({ event: "actor-reply-shadow-config-invalid" }));
      return;
    }
    if (policy === undefined) return;
    this.objectState.waitUntil(
      shadowActorReply(
        fiber,
        reply,
        policy,
        this.admittedShadow(
          participant,
          fiber,
          "actor_reply_shadow",
          this.actorReplyDecider(policy, fiber),
        ),
        (record) => this.recordActorReply(record),
      ).catch(() => {
        console.warn(
          JSON.stringify({
            event: "actor-reply-shadow-failed",
            actorId: fiber.actorId,
            sessionId: fiber.sessionId,
            messageId: fiber.messageId,
          }),
        );
      }),
    );
  }

  async wakeTriageReport(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ) {
    assertWorldCommandContext(context, scope);
    if (!context.privacyCeiling.allowedCategories.includes("operator_evidence"))
      throw new AuthorizationRefusedError("triage report refused");
    await this.ready(scope, context, actorId);
    return withWakeTriageClient(this.environment, (client) =>
      new PostgreSqlWakeTriage(client).report(participant, scope as BrowserScope),
    );
  }
  protected triageDecider(policy: WakeTriagePolicy, fiber: TurnFiber): ShadowDecider | undefined {
    return wakeTriageDecider(this.environment, policy, fiber);
  }

  async configureActivation(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    configuration: ActivationConfiguration | undefined,
    policy: ActivationPolicy,
  ): Promise<ActivationInspection> {
    assertWorldCommandContext(context, scope);
    // A policy-only request (issue 323) skips the conversation check a configuration carries, and
    // its revocations apply to every member: only an operator may make one.
    // The refusal is an activation message: RPC keeps messages, not error prototypes.
    if (configuration === undefined && !context.grants.map(String).includes(OPERATE_GRANT))
      throw new Error("activation operator required");
    await this.ready(scope, context, actorId);
    const address = { scope: scope as ActivationAddress["scope"], participant, actorId };
    const result = await withActivations(this.environment, (store) =>
      store.configure(address, configuration, policy),
    );
    await this.armActivations(address, { initial: true });
    return result;
  }

  async inspectActivations(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ): Promise<ActivationInspection> {
    await this.ready(scope, context, actorId);
    const address = { scope: scope as ActivationAddress["scope"], participant, actorId };
    // Only an operator sees the actor's internal grants (issue 323), with its canonical revocations.
    const memberGrants = context.grants.map(String);
    if (!memberGrants.includes(OPERATE_GRANT))
      return withActivations(this.environment, (store) => store.inspect(address));
    const [inspection, canonical] = await withActivations(this.environment, async (store) => [
      await store.inspect(address),
      await store.capabilityPolicyOf({
        ...address,
        participant: { ...worldAuthorization(context), personaId: participant.personaId },
      }),
    ]);
    const revoked = new Set(canonical?.revoked ?? []);
    const actorCommands = await this.actorCommands(context, scope);
    const grants: InternalGrantView[] = CAPABILITY_REGISTRY.grantsFor(
      memberGrants,
      actorCommands,
    ).grants.map((grant) => ({
      capability: grant.capability,
      effect: CAPABILITY_REGISTRY.get(grant.capability)?.effect ?? "read",
      callsPerTurn: grant.callsPerTurn,
      ...(grant.commandTypes === undefined ? {} : { commandTypes: grant.commandTypes }),
      revoked: revoked.has(grant.capability),
    }));
    // The policy and its budget read under the caller's row security: when another member owns
    // the actor's policy, they are this caller's defaults, not the actor's, and its configure would
    // be refused. Without a policy, this caller's configure creates one it owns.
    return { ...inspection, grants, policyOwned: canonical?.owned ?? true };
  }

  async wakeActivation(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    wake: ActivationWake,
  ): Promise<ActorActivation> {
    assertWorldCommandContext(context, scope);
    await this.ready(scope, context, actorId);
    const address = { scope: scope as ActivationAddress["scope"], participant, actorId };
    // Persist a fallback before admitting canonical work, including unscheduled operator wakes. It
    // is this principal's own alarm, so a wake refused for a policy it cannot see changes no other.
    await this.armActivations(address, { forceRecovery: true });
    return this.admitActivation(address, wake);
  }

  private async admitActivation(
    address: ActivationAddress,
    wake: ActivationWake,
  ): Promise<ActorActivation> {
    const admitted = await withActivations(this.environment, (store) => store.admit(address, wake));
    if (admitted.status !== "pending") return admitted;
    return this.runActivation(address, admitted);
  }

  private async runActivation(
    address: ActivationAddress,
    admitted: ActorActivation,
  ): Promise<ActorActivation> {
    try {
      const result = await this.fibers(address.scope, address.actorId)
        .talk(
          address.participant,
          {
            scope: address.scope,
            sessionId: admitted.sessionId,
            messageId: admitted.messageId,
            text: admitted.input,
          },
          () => undefined,
          false,
        )
        .catch((error: unknown) => {
          // A muted actor or conversation starts no turn: the wake settles with that refusal. A
          // read-only or paused world (0085) starts none either, but the wake is held, not lost.
          if (
            error instanceof ConversationRefusedError &&
            (error.code === "conversation_muted" || error.code === "world_mode_refused")
          )
            return { refused: error.code, receipt: undefined };
          throw error;
        });
      // A durable approval/tool wait is unfinished work; its alarm must retain admission. So is a
      // wake a world mode holds: it stays pending and runs at the first alarm once the mode allows.
      if (
        result.receipt === undefined &&
        (result.refused === "conversation_busy" || result.refused === "world_mode_refused")
      )
        return admitted;
      if (result.receipt !== undefined && admitted.delivery !== undefined)
        await withActivations(this.environment, (store) =>
          store.deliver(address, admitted.activationId),
        );
      await withActivations(this.environment, (store) =>
        store.settle(
          address,
          admitted.activationId,
          result.receipt === undefined ? result.refused : "completed",
        ),
      );
      return {
        ...admitted,
        status: "completed",
        outcome: result.receipt === undefined ? result.refused : "completed",
      };
    } catch (error) {
      if (!(error instanceof ActivationGateBlockedError)) throw error;
      const state = await withActivations(this.environment, (store) => store.inspect(address));
      return (
        state.activations.find((a) => a.causalRoot === admitted.causalRoot) ?? {
          ...admitted,
          status: error.status,
          outcome: "policy_denied",
        }
      );
    }
  }

  /**
   * A world commit wrote an event that one of this actor's enabled subscriptions or thresholds
   * names (`activationHintNotifier`). Plans a prompt check of the journal instead of the quiet
   * poll, for the address its last arming stored. Hints coalesce into that principal's alarm.
   */
  async hintActivations(): Promise<void> {
    const address = await this.objectState.storage.get<ActivationAddress>(ACTIVATION_ADDRESS_KEY);
    if (address === undefined) return;
    this.#journalHints += 1;
    await this.armActivations(address, { prompt: true });
  }

  /** SDK scheduler callback: bounded journal scan and due configurations, ordered by priority. */
  async runScheduledActivations(address: ActivationAddress): Promise<void> {
    // A hint from here on may name an event the scan below has already passed, or not yet reached.
    const hints = this.#journalHints;
    let more = false;
    let limited = 0;
    // The current one-shot is being consumed. Persist its successor before any turn can abort
    // this incarnation; a finally block cannot create the only recovery alarm after owner loss.
    const inspection = await this.armActivations(address, {
      fromCallback: true,
      forceRecovery: true,
    });
    try {
      const cursorKey = `${DELIVERY_CURSOR_KEY}:${address.participant.principalId}`;
      const cursor = await this.objectState.storage.get<string | null>(cursorKey);
      const nextCursor = await withGovernedDelivery(this.environment, (store) =>
        store.resumePending(address, cursor ?? null),
      );
      await this.objectState.storage.put(cursorKey, nextCursor);
      for (const deferred of inspection.activations.filter((a) => a.status === "deferred")) {
        try {
          await this.admitActivation(address, {
            configurationId: deferred.configurationId,
            causalRoot: deferred.causalRoot,
            reason: deferred.reason,
            evidence: deferred.evidence,
          });
        } catch {
          /* Other due configurations still get their opportunity. */
        }
      }
      for (const pending of inspection.activations.filter((a) => a.status === "pending")) {
        try {
          await this.runActivation(address, pending);
        } catch {
          /* PostgreSQL checkpoints retain interrupted work. */
        }
      }
      // No configuration means no policy this principal can see, and so no journal cursor.
      const page =
        inspection.configurations.length === 0
          ? { events: [], more: false }
          : await withActivations(this.environment, (store) => store.events(address));
      more = page.more;
      events: for (const event of page.events) {
        for (const configuration of inspection.configurations
          .filter((c) => c.enabled && c.eventType === event.eventType)
          .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
          if (configuration.kind !== "subscription" && configuration.kind !== "threshold") continue;
          // A threshold is the actor's own: another actor's crossing, or one in another space, is not.
          // One that names a need matches only a crossing of that need.
          if (
            configuration.kind === "threshold" &&
            (!event.own || (configuration.need !== undefined && configuration.need !== event.need))
          )
            continue;
          try {
            await this.admitActivation(address, {
              configurationId: configuration.id,
              causalRoot: event.causalRoot,
              evidence: `journal:${event.eventId}`,
              reason:
                configuration.kind === "subscription"
                  ? {
                      kind: "subscription",
                      subscriptionId: configuration.id,
                      eventId: event.eventId,
                    }
                  : { kind: "threshold", conditionId: configuration.id },
            });
          } catch (error) {
            if (!isWakeLimit(error)) throw error;
            // Unacknowledged, the event is read again once the period renews.
            limited += 1;
            break events;
          }
        }
        await withActivations(this.environment, (store) =>
          store.acknowledgeEvent(address, event.eventId),
        );
      }
      for (const configuration of inspection.configurations
        .filter((c) => c.enabled && c.nextWakeAt !== null && c.nextWakeAt <= Date.now())
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
        if (configuration.kind !== "heartbeat" && configuration.kind !== "scheduled_intention")
          continue;
        try {
          await this.admitActivation(address, {
            configurationId: configuration.id,
            causalRoot: `schedule:${configuration.id}:${configuration.nextWakeAt}`,
            evidence: `due:${configuration.nextWakeAt}`,
            reason:
              configuration.kind === "heartbeat"
                ? { kind: "heartbeat", heartbeatId: configuration.id }
                : { kind: "scheduled_intention", scheduleId: configuration.id },
          });
        } catch (error) {
          if (!isWakeLimit(error)) throw error;
          limited += 1;
        }
      }
    } finally {
      if (limited > 0)
        console.warn(
          JSON.stringify({
            event: "activation_limit_reached",
            actorId: address.actorId,
            principalId: address.participant.principalId,
            refused: limited,
          }),
        );
      await this.armActivations(address, {
        fromCallback: true,
        prompt: more || this.#journalHints !== hints,
      });
    }
  }

  /**
   * Plans the principal's activation alarm from an inspection read inside this incarnation's
   * single arming section, and answers that inspection. Configure, wake and the callback run
   * concurrently between PostgreSQL round trips: a callback planning from an inspection taken
   * before a configuration committed would cancel the alarm that configuration relied on, and its
   * wake would wait for the next quiet poll, or forever with none. Every change commits before its
   * own arming, so the last arming always reads it. An arming that shows the actor's
   * configurations stores its address for journal hints.
   */
  private armActivations(
    address: ActivationAddress,
    arming: ActivationArming,
  ): Promise<ActivationInspection> {
    this.activationArmingStep(arming, "requested");
    const armed = this.#arming.then(async () => {
      this.activationArmingStep(arming, "started");
      try {
        const inspection = await withActivations(this.environment, (store) =>
          store.inspect(address),
        );
        if (inspection.configurations.length > 0)
          await this.objectState.storage.put(ACTIVATION_ADDRESS_KEY, address);
        await this.activationPlanning(arming);
        const delayed = await withGovernedDelivery(this.environment, (store) =>
          store.pending(address),
        );
        await this.planActivationAlarm(address, inspection, arming, delayed);
        return inspection;
      } finally {
        this.activationArmingStep(arming, "settled");
      }
    });
    this.#arming = armed.catch(() => undefined);
    return armed;
  }

  /**
   * Called as an arming is requested, as it enters the arming section and as it leaves it.
   * Production does nothing. The native test owner counts the steps: an arming requested but not
   * started waits for the section, and one started but not settled is inside it.
   */
  protected activationArmingStep(_arming: ActivationArming, _step: ActivationArmingStep): void {}

  /**
   * Called inside the arming section, after its inspection is read and before it plans. Production
   * does nothing more. The native test owner holds a callback's arming here to order a
   * configuration's commit between the two.
   */
  protected async activationPlanning(_arming: ActivationArming): Promise<void> {}

  private async planActivationAlarm(
    address: ActivationAddress,
    inspection: ActivationInspection,
    {
      initial = false,
      fromCallback = false,
      forceRecovery = false,
      prompt = false,
    }: ActivationArming,
    delayed: boolean,
  ): Promise<void> {
    // Each principal's arming plans only that principal's alarm: activation policies are private
    // to their principal, so another principal's arming reads none of them and must not cancel or
    // replace the wakes they need.
    const key = `${ACTIVATION_ALARM_KEY}:${address.participant.principalId}`;
    const stored = await this.objectState.storage.get<{ id: string; at: number }>(key);
    // Decision: unfinished turns retry after one second so an owner loss does not strand their
    // receipts behind quiet polling. A journal hint, a full page of unread events or an event
    // whose transaction had not settled checks again after one second too. Quiet subscription
    // checks remain one minute apart; model retries still require a budget reservation at the
    // model boundary.
    const poll = inspection.configurations.some((c) => c.enabled && c.eventType !== undefined);
    const pending = forceRecovery || inspection.activations.some((a) => a.status === "pending");
    const blocked = new Set(
      inspection.activations.filter((a) => a.status === "deferred").map((a) => a.causalRoot),
    );
    const renews = inspection.activations.some(
      (a) => a.status === "deferred" && a.outcome === "budget_exhausted",
    );
    const full = inspection.period.wakes >= inspection.period.wakeLimit;
    const times = inspection.configurations
      .filter(
        (c) =>
          c.enabled && c.nextWakeAt !== null && !blocked.has(`schedule:${c.id}:${c.nextWakeAt}`),
      )
      .map((c) => c.nextWakeAt as number);
    const next = times.length ? Math.min(...times) : null;
    // With the period's wakes spent and nothing pending, no wake is admitted before it renews.
    const spent = full && !pending;
    const floor = spent ? inspection.period.endsAt : 0;
    const candidates = [
      // A budget renews with its period: wait for it instead of retrying a refused wake.
      renews ? inspection.period.endsAt : null,
      next === null ? null : Math.max(next, floor),
      // Decision: delayed recipient contacts reuse the one-minute quiet subscription cadence.
      delayed ? Date.now() + 60000 : null,
      poll || pending || (initial && inspection.activations.some((a) => a.status === "deferred"))
        ? Math.max(floor, Date.now() + (initial || pending || (poll && prompt) ? 1000 : 60000))
        : null,
    ].filter((value): value is number => value !== null);
    if (candidates.length === 0) {
      await this.objectState.storage.put(key, null);
      if (stored) await this.cancelSchedule(stored.id);
      return;
    }
    const plannedAt = Math.max(Date.now() + 1000, Math.min(...candidates));
    if (!fromCallback && stored && stored.at > Date.now() && stored.at <= plannedAt) return;
    const scheduled = await this.schedule(
      new Date(plannedAt),
      "runScheduledActivations",
      { ...address, wakeAt: plannedAt },
      { idempotent: true },
    );
    await this.objectState.storage.put(key, { id: scheduled.id, at: plannedAt });
    if (stored && stored.id !== scheduled.id) await this.cancelSchedule(stored.id);
  }

  /** Talk: accepts the message as a turn and answers its NDJSON stream of `TalkStreamFrame`s. */
  async talk(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    request: TalkRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    await this.ready(scope, context, actorId);
    this.#talkContexts.set(`${participant.principalId}:${participant.personaId}`, context);
    await this.recoverOnce(scope, participant, actorId);
    const { admitted } = await this.receivePerception({ kind: "direct_message", ...request });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const write = (frame: TalkStreamFrame) =>
      void writer.write(encodeTalkFrame(frame)).catch(() => undefined);
    const done = this.fibers(scope, actorId)
      .talk(participant, request, write, admitted)
      .then(async (outcome) => {
        if (outcome.refused === "conversation_busy") {
          const status = await this.stores()((store) => store.turnStatus(participant, request));
          if (status.phase === "tool_waiting" || status.phase === "approval_waiting") {
            // No terminal frame: callers retain the message ID and resume its durable wait.
            await writer.close();
            return;
          }
        }
        write(
          outcome.receipt !== undefined
            ? { type: "receipt", receipt: outcome.receipt }
            : {
                type: "refused",
                status: CONVERSATION_REFUSAL_STATUS[outcome.refused],
                error: outcome.refused,
              },
        );
        await writer.close();
      })
      .catch(async (error: unknown) => {
        if (error instanceof ConversationRefusedError) {
          write({
            type: "refused",
            status: CONVERSATION_REFUSAL_STATUS[error.code],
            error: error.code,
          });
          await writer.close();
        } else await writer.abort(error);
      });
    this.objectState.waitUntil(done);
    return readable;
  }

  /** Queue completion carries identity only; every resumption reloads canonical membership. */
  async toolCompleted(target: {
    readonly scope: BrowserScope;
    readonly actorId: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly principalId: string;
    readonly personaId: string;
  }): Promise<void> {
    const { scope } = target;
    const authentication = composeRuntime(this.environment).authentication;
    const authority = await authentication.world.resolveWorld(
      decodeOpaqueId(target.principalId, "PrincipalId"),
      scope,
    );
    if (
      authority === undefined ||
      authority.tenantId !== scope.tenantId ||
      authority.worldId !== scope.worldId ||
      authority.timelineId !== scope.timelineId ||
      authority.spaceId !== scope.spaceId ||
      authority.principalId !== target.principalId ||
      authority.personaId !== target.personaId ||
      !authority.privacyCeiling.allowedCategories.includes("conversation")
    )
      return;
    const context = constructTrustedExecutionContext({
      version: 1,
      ...scope,
      principalId: authority.principalId,
      worldMembershipId: authority.membershipId,
      personaId: authority.personaId,
      roles: authority.roles,
      grants: authority.grants,
      privacyCeiling: authority.privacyCeiling,
      correlationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      codeVersion: authentication.codeVersion,
      protocolVersion: 1,
    });
    const participant: ConversationParticipant = {
      tenantId: authority.tenantId,
      principalId: authority.principalId,
      personaId: authority.personaId,
      privacyCeiling: authority.privacyCeiling,
    };
    await this.ready(scope, context, target.actorId);
    this.#talkContexts.set(`${participant.principalId}:${participant.personaId}`, context);
    // Queue acknowledgement cannot wait for cognition that may queue another call on that same
    // serial consumer. The effect is already durable; SDK recovery and the sweep retain the wake.
    const resume = async () => {
      // Completion can arrive before the publishing turn has returned its pending state. An
      // activation can join that turn; after it settles, re-read its wait and activate once more.
      for (let round = 0; round < 2; round++) {
        const open = await this.stores()((store) =>
          store.openTurns(participant, scope, target.actorId),
        );
        const fiber = open.find(
          (candidate) =>
            candidate.sessionId === target.sessionId &&
            candidate.messageId === target.messageId &&
            (candidate.phase === "tool_waiting" || candidate.phase === "approval_waiting"),
        );
        if (fiber === undefined) return;
        await this.fibers(scope, target.actorId).activate(participant, fiber);
      }
    };
    // TurnFibers records failed attempts; background failure remains resumable from canonical state.
    this.objectState.waitUntil(resume().catch(() => undefined));
  }

  /** A turn's durable status; reading it also resumes the turn if this owner is not running it. */
  async turnStatus(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    request: TurnRequest,
  ): Promise<TurnOwnerAnswer<TurnStatus>> {
    return this.answer(scope, context, participant, actorId, (store) =>
      store.turnStatus(participant, request),
    );
  }

  async cancelTurn(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    request: TurnRequest,
  ): Promise<TurnOwnerAnswer<TurnStatus>> {
    return this.answer(scope, context, participant, actorId, (store) =>
      store.cancelTurn(participant, request),
    );
  }

  /**
   * The perception inbox: whether the activation is new to this owner. A duplicate is not admitted
   * again; the turn's key in PostgreSQL still decides, so a forgotten key is harmless.
   */
  async receivePerception(
    activation: DirectMessageActivation,
  ): Promise<{ readonly admitted: boolean }> {
    this.inbox ??= new PerceptionInbox(
      (await this.objectState.storage.get<string[]>(INBOX_KEY)) ?? [],
    );
    const admitted = this.inbox.admit(activation);
    if (admitted) await this.objectState.storage.put(INBOX_KEY, this.inbox.snapshot());
    return { admitted };
  }

  /**
   * The capability revision hook for canonical installation and binding changes. The revision only
   * moves forward; each later claim of a turn records the revision it ran under.
   */
  reconcileCapabilities(revision: number): Promise<ActorAgentRecovery> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      return Promise.reject(new Error("capability revision unavailable"));
    const reconciled = this.capabilityReconciliation
      .catch(() => undefined)
      .then(async () => {
        const recovery = await this.loadRecovery();
        if (revision > recovery.capabilityRevision)
          await this.saveRecovery({ ...recovery, capabilityRevision: revision });
        return this.loadRecovery();
      });
    this.capabilityReconciliation = reconciled;
    return reconciled;
  }

  /** The owner's rebuildable state, for inspection. */
  async inspectAgent(): Promise<{
    readonly recovery: ActorAgentRecovery;
    readonly inbox: readonly string[];
    readonly running: number;
  }> {
    this.inbox ??= new PerceptionInbox(
      (await this.objectState.storage.get<string[]>(INBOX_KEY)) ?? [],
    );
    return {
      recovery: await this.loadRecovery(),
      inbox: this.inbox.snapshot(),
      running: this.#fibers?.active ?? 0,
    };
  }

  /**
   * One bounded segment of an `ActorProcess`: a new lease epoch, then one checkpoint at most `steps`
   * further, and never past the process's step budget. The process ID is stable across segments,
   * incarnations and deployments: everything the next segment needs is in PostgreSQL, so nothing
   * stays resident between segments. A process whose segment budget is spent runs no segment and is
   * answered with `process_budget_exhausted`.
   */
  async advanceProcess(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    input: {
      readonly processId: string;
      readonly actorId: string;
      readonly target: number;
      readonly steps: number;
      readonly mode: ActorProcessMode;
      readonly budget?: ActorProcessBudget;
    },
  ): Promise<ActorProcess> {
    assertWorldCommandContext(context, scope);
    const authorization = worldAuthorization(context);
    return withActorProcesses(this.environment, async (processes) => {
      await processes.start(authorization, scope, input);
      const lease = await processes.claim(authorization, input.processId, this.instanceId);
      if (lease !== undefined) {
        const steps = Math.min(input.steps, lease.stepLimit);
        await processes.segment(
          authorization,
          input.processId,
          { leaseEpoch: lease.leaseEpoch, holder: this.instanceId },
          lease.checkpoint,
          Math.min(lease.target, lease.checkpoint + steps),
        );
      }
      const process = await processes.read(authorization, input.processId);
      return lease === undefined &&
        process.state === "active" &&
        process.segments.length >= process.budget.segments
        ? Object.freeze({ ...process, refusal: "process_budget_exhausted" as const })
        : process;
    });
  }

  /** The SDK found a turn fiber this owner's last incarnation did not finish: resume its turns. */
  override async onFiberRecovered(context: FiberRecoveryContext): Promise<void> {
    const snapshot = context.snapshot as TurnFiberSnapshot | null;
    if (!context.name.startsWith("turn:") || snapshot === null) return;
    await this.fibers(snapshot.scope, snapshot.actorId).recover(
      snapshot.participant,
      snapshot.scope,
      snapshot.actorId,
    );
  }

  /**
   * Called after each durable checkpoint of a turn. Production records nothing more: the checkpoint
   * is already in PostgreSQL. The native test owner ends its incarnation here to inject a crash.
   */
  protected async turnCheckpointed(_fiber: TurnFiber, _phase: string): Promise<void> {}

  private async answer(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    operation: (store: ConversationStore) => Promise<TurnStatus>,
  ): Promise<TurnOwnerAnswer<TurnStatus>> {
    await this.ready(scope, context, actorId);
    this.#talkContexts.set(`${participant.principalId}:${participant.personaId}`, context);
    try {
      return { value: await this.stores()(operation) };
    } catch (error) {
      if (error instanceof ConversationRefusedError) return { refused: error.code };
      throw error;
    } finally {
      // After the answer, so a cancel stops the turn before this owner would resume it.
      await this.recoverOnce(scope, participant, actorId);
    }
  }

  /** Initializes this incarnation once: its route, canonical readiness and recovery metadata. */
  private async ready(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    actorId: string,
  ): Promise<void> {
    if (this.recovery?.incarnation !== this.instanceId)
      await this.initialize(scope, context, decodeOpaqueId(actorId, "SubjectId"));
  }

  /**
   * Resumes the participant's open turns with this actor, once an incarnation: what an owner that
   * lost its local storage, and so the SDK's fiber rows, still owes.
   */
  private async recoverOnce(
    scope: RuntimeScope,
    participant: ConversationParticipant,
    actorId: string,
  ): Promise<void> {
    const key = `${participant.tenantId}:${participant.principalId}`;
    if (this.recoveredFor.has(key)) return;
    this.recoveredFor.add(key);
    const recovered = await this.fibers(scope, actorId).recover(participant, scope, actorId);
    if (recovered > 0) {
      const recovery = await this.loadRecovery();
      await this.saveRecovery({ ...recovery, recoveredTurns: recovery.recoveredTurns + recovered });
    }
  }

  private async loadRecovery(): Promise<ActorAgentRecovery> {
    if (this.recovery?.incarnation === this.instanceId) return this.recovery;
    const stored = await this.objectState.storage.get<ActorAgentRecovery>(RECOVERY_KEY);
    await this.saveRecovery({
      schemaVersion: 1,
      incarnation: this.instanceId,
      incarnations: (stored?.incarnations ?? 0) + 1,
      capabilityRevision: stored?.capabilityRevision ?? 0,
      recoveredTurns: 0,
    });
    return this.recovery as unknown as ActorAgentRecovery;
  }

  private async saveRecovery(recovery: ActorAgentRecovery): Promise<void> {
    this.recovery = recovery;
    await this.objectState.storage.put(RECOVERY_KEY, recovery);
  }

  private stores(): ConversationStores {
    // The world's context settings apply on the scripted path too; only a route lowers the budget.
    const routed = actorGateway(this.environment) !== undefined;
    const configuration = actorModelConfiguration(this.environment.WORLD_MODEL_CONFIG);
    const context = actorContextSettings(configuration, routed);
    const stores = composeConversations(
      this.environment,
      routed ? configuration.modelName : undefined,
      context.tokenBudget,
      context.historyWindow,
    );
    if (stores === undefined) throw new Error("conversation keyring required");
    return stores;
  }

  /**
   * The installed pack's actor-command declaration, read under the member's row security once per
   * member and world in this incarnation. A world's installation and its artifact's resources are
   * immutable rows (`clockgrove_birth.reject_mutation`), so a later read could not differ; a failed
   * read is not kept, and the member's own context is still checked on every resolution.
   */
  private actorCommands(
    context: TrustedExecutionContext,
    scope: { readonly tenantId: string; readonly worldId: string },
  ): Promise<ActorCommandPolicy | undefined> {
    const key = `${scope.tenantId}:${scope.worldId}:${context.principalId}`;
    const known = this.#actorCommands.get(key);
    if (known !== undefined) return known;
    const read = withActorCapabilityClient(this.environment, (client) =>
      readActorCommandPolicy(client, worldAuthorization(context), scope),
    );
    this.#actorCommands.set(key, read);
    read.catch(() => this.#actorCommands.delete(key));
    return read;
  }

  /** The actor's grants: the registry's, bounded by the grants of the participating member. */
  private async grants(
    participant: ConversationSessionParticipant,
    scope: BrowserScope,
    actorId: string,
    sessionId: string,
  ): Promise<CapabilityGrants | undefined> {
    const context = this.#talkContext(participant);
    if (context === undefined) return undefined;
    // The world's own declaration of what its actors may propose (issue 359).
    const actorCommands = await this.actorCommands(context, scope);
    const admitted = await resolveActorCapabilities(
      this.environment.PROVIDER_ENVIRONMENT,
      context.grants.map(String),
      () =>
        withActorCapabilityClient(this.environment, (client) =>
          readActorMcpCapabilities(client, worldAuthorization(context), {
            tenantId: scope.tenantId,
            worldId: scope.worldId,
            timelineId: scope.timelineId,
            actorId,
            sessionId,
            runtimeGrants: context.grants.map(String),
            ...(actorCommands === undefined ? {} : { actorCommands }),
          }),
        ),
      actorCommands,
    );
    await this.reconcileCapabilities(admitted.revision);
    // Canonical per-actor revocation (issue 322): the operator's policy names them.
    const revoked = await withActivations(this.environment, (store) =>
      store.revokedCapabilities({
        scope: scope as ActivationAddress["scope"],
        participant: { ...worldAuthorization(context), personaId: participant.personaId },
        actorId,
      }),
    );
    return revoked.reduce((grants, name) => grants.revoke(name), admitted.grants);
  }

  /**
   * Executes one of the actor's accepted self capabilities (issue 322) under the turn's
   * participant: its own activation configurations (re-arming this owner's alarm), its perception
   * listing, its self-inspection, or the check of a document write that commits with the turn.
   */
  private async executeSelf(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    definition: CapabilityDefinition,
    input: unknown,
  ): Promise<SelfOutcome> {
    const context = this.#talkContext(participant);
    if (context === undefined) throw new Error("capability context unavailable");
    const address: ActivationAddress = {
      scope: fiber.scope as ActivationAddress["scope"],
      participant,
      actorId: fiber.actorId,
    };
    const refused = (code: string, result: unknown = { refused: code }): SelfOutcome => ({
      status: "refused",
      code,
      summary: `Refused: ${code}`,
      result,
    });
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${fiber.sessionId}\n${fiber.messageId}`),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24);
    const value = input as Record<string, unknown>;
    // Hosted execution of the actor's reads stays guarded until issue 3: outside local composition
    // they are refused and recorded, as `inspect` and `why` are without research composition.
    const hostedReadsAllowed = this.environment.PROVIDER_ENVIRONMENT === "local";
    switch (definition.name) {
      case "subscription.create":
      case "intention.schedule": {
        const subscription = definition.name === "subscription.create";
        // Issue 354: an actor follows only an event type the journal can hold, and is shown them.
        if (subscription && !JOURNAL_EVENT_TYPES.includes(String(value.eventType)))
          return refused("unknown_event_type", {
            refused: "unknown_event_type",
            eventType: value.eventType,
            validEventTypes: JOURNAL_EVENT_TYPES,
          });
        const id = `${subscription ? "self-subscription" : "self-intention"}-${digest}`;
        // The proposal's checkpointed issue time fixes the due time, so a retry rewrites the same.
        const dueAt = subscription
          ? null
          : Date.parse(proposal.issuedAt) + Number(value.delaySeconds) * 1000;
        const configured = await withActivations(this.environment, (store) =>
          store.actorConfigure(address, {
            id,
            sessionId: fiber.sessionId,
            kind: subscription ? "subscription" : "scheduled_intention",
            nextWakeAt: dueAt,
            intervalMs: null,
            ...(subscription ? { eventType: String(value.eventType) } : {}),
            input: String(value.input),
            priority: 1,
            enabled: true,
            compiledRoutine: "escalate",
            origin: "actor",
          }),
        );
        if (configured === "not_owned") return refused("policy_not_owned");
        if (configured === "limit")
          return refused("budget_exhausted", {
            refused: "budget_exhausted",
            standingLimit: MAX_ACTOR_ACTIVATIONS,
          });
        await this.armActivations(address, { initial: true });
        return subscription
          ? {
              status: "committed",
              code: null,
              summary: `Subscribed ${id} to ${String(value.eventType)}`,
              result: { subscriptionId: id, eventType: value.eventType },
            }
          : {
              status: "committed",
              code: null,
              summary: `Scheduled ${id} for ${new Date(dueAt as number).toISOString()}`,
              result: { intentionId: id, dueAt },
            };
      }
      case "subscription.revoke":
      case "intention.cancel": {
        const subscription = definition.name === "subscription.revoke";
        const id = String(subscription ? value.subscriptionId : value.intentionId);
        const removed = await withActivations(this.environment, (store) =>
          store.actorRemove(address, id, subscription ? "subscription" : "scheduled_intention"),
        );
        if (removed === "not_owned") return refused("policy_not_owned");
        // Removal is idempotent for the actor's own IDs: a retried turn whose first attempt
        // removed it before its step was recorded finds it gone, and that is the committed outcome.
        const own = id.startsWith(subscription ? "self-subscription-" : "self-intention-");
        if (removed === "not_found" || (removed === "absent" && !own))
          return refused("activation_not_found");
        if (removed === "removed") await this.armActivations(address, { initial: true });
        return {
          status: "committed",
          code: null,
          summary: `${subscription ? "Revoked" : "Cancelled"} ${id}`,
          result: subscription ? { subscriptionId: id } : { intentionId: id },
        };
      }
      case "perception.list": {
        if (!hostedReadsAllowed) return refused("not_executable");
        const listing = await perceiveListing(
          this.environment,
          fiber.scope,
          context,
          fiber.actorId,
        );
        // Decision: 64 entities and 128 routes keep the result inside the evidence bound.
        return {
          status: "committed",
          code: null,
          summary: `Perceived ${listing.entities.length} entities and ${listing.routes.length} routes at revision ${listing.revision}`,
          result: {
            revision: listing.revision,
            entityCount: listing.entities.length,
            routeCount: listing.routes.length,
            entities: listing.entities.slice(0, 64),
            routes: listing.routes.slice(0, 128),
          },
        };
      }
      case "self.inspect": {
        if (!hostedReadsAllowed) return refused("not_executable");
        const authorization = { ...worldAuthorization(context), personaId: participant.personaId };
        const goals = await withActorCapabilityClient(this.environment, (client) =>
          withClientTransaction(client, { authorization }, async () =>
            (
              await new PostgreSqlActorDocuments(client).candidates(
                fiber.scope.tenantId,
                fiber.sessionId,
              )
            )
              .filter((document) => document.kind === "goals" && document.state === "active")
              .map((document) => ({
                path: document.path,
                version: document.version,
                sourceHash: document.sourceHash,
              })),
          ),
        );
        const activation = await withActivations(this.environment, (store) =>
          store.inspect(address),
        );
        const grants = await this.grants(participant, fiber.scope, fiber.actorId, fiber.sessionId);
        const available = new Set(grants?.available() ?? []);
        return {
          status: "committed",
          code: null,
          summary: `Inspected ${goals.length} goals documents, budgets and run ${fiber.runId ?? "none"}`,
          result: {
            actorId: fiber.actorId,
            sessionId: fiber.sessionId,
            goals,
            budgets: {
              activation: {
                allowModel: activation.policy.allowModel,
                modelBudget: activation.policy.modelBudget,
                modelCallsReserved: activation.modelCallsReserved,
                remaining: Math.max(
                  0,
                  activation.policy.modelBudget - activation.modelCallsReserved,
                ),
                standingActorActivations: activation.configurations.filter(
                  (c) => c.origin === "actor",
                ).length,
                standingActorActivationLimit: MAX_ACTOR_ACTIVATIONS,
              },
              turn: (grants?.grants ?? [])
                .filter((grant) => available.has(grant.capability))
                .map((grant) => ({
                  capability: grant.capability,
                  callsPerTurn: grant.callsPerTurn,
                  remaining: grant.callsPerTurn - (grant.capability === "self.inspect" ? 1 : 0),
                })),
            },
            run: {
              runId: fiber.runId,
              messageId: fiber.messageId,
              phase: fiber.phase,
              attempt: fiber.attempt,
            },
          },
        };
      }
      case "document.write": {
        const code = operationRefusal(
          { op: "create", path: String(value.path), content: String(value.content) },
          { kind: "model", sessionId: fiber.sessionId },
        );
        if (code !== undefined) return refused(code);
        return {
          status: "committed",
          code: null,
          summary: `Document write of ${String(value.path)} accepted; it commits with the turn`,
          result: { path: value.path, commitsWithTurn: true },
        };
      }
      default:
        return refused("not_executable");
    }
  }

  private perceive = async (
    scope: BrowserScope,
    participant: ConversationSessionParticipant,
    focus?: PerceptionFocus,
  ) => {
    const context = this.#talkContext(participant);
    return context === undefined
      ? undefined
      : perceiveScene(this.environment, scope, context, focus);
  };

  /** The production route when a key is bound, else the scripted fixture; both perceive the scene. */
  protected actorModelDeps(
    gateway: ModelGateway | undefined = actorGateway(this.environment),
  ): ActorModelDeps | undefined {
    if (gateway === undefined) return undefined;
    return {
      researchEnabled: this.research() !== undefined,
      configuration: actorModelConfiguration(this.environment.WORLD_MODEL_CONFIG),
      gateway,
      grants: (participant, session) =>
        this.grants(participant, session.scope, session.actorId, session.sessionId),
      perceive: this.perceive,
      breakerTransitions: async (participant, session, runId, record) => {
        const context = this.#talkContext(participant);
        if (context === undefined) return;
        const authorization = { ...worldAuthorization(context), personaId: participant.personaId };
        const transitions = record.attempts.flatMap((a) => a.breakerTransitions ?? []);
        await withActorCapabilityClient(this.environment, (client) =>
          withClientTransaction(client, { authorization }, () =>
            new PostgreSqlRunRecorder(client).breakerTransitions(
              session.scope.tenantId,
              session.scope.worldId,
              session.sessionId,
              runId,
              record,
              transitions,
            ),
          ),
        );
      },
      // Issue 354: the actor's own standing subscriptions and intentions, read from its activation
      // policy's configurations under the member's authorization, whichever turn or session made
      // them. One read of the policy row's configurations column per model step.
      standing: async (participant, session) => {
        const context = this.#talkContext(participant);
        if (context === undefined) return [];
        const address: ActivationAddress = {
          scope: session.scope as ActivationAddress["scope"],
          participant: { ...worldAuthorization(context), personaId: participant.personaId },
          actorId: session.actorId,
        };
        // A failed read fails the step, as selfResults does: the prompt never omits the section
        // for an actor whose configurations could not be read.
        return standingOf(
          await withActivations(this.environment, (store) => store.configurations(address)),
        );
      },
      selfResults: async (participant, session) => {
        const context = this.#talkContext(participant);
        if (context === undefined) return [];
        return readSelfResults(this.environment, worldAuthorization(context), session.sessionId);
      },
    };
  }

  /** The production actor's step, measured before it is sent; undefined on the scripted fixture. */
  protected preparer(): PreparedResponder | undefined {
    const deps = this.actorModelDeps();
    return deps === undefined ? undefined : actorPreparedResponder(deps);
  }

  protected responder(): ConversationResponder {
    const deps = this.actorModelDeps();
    if (deps !== undefined) return actorResponder(deps);
    return async (session, caretakerMessages, input) => {
      const reply = scriptedConversationReply(session, caretakerMessages, input);
      if (reply.command === undefined) return reply;
      const scene = await this.perceive(
        session.scope,
        session.participants[0] as ConversationSessionParticipant,
      );
      return {
        ...reply,
        command: {
          ...reply.command,
          ...(scene === undefined ? {} : { expectedRevision: scene.revision }),
        },
      };
    };
  }

  /**
   * Submits the actor's authorized proposal as the ordinary command it declares, sealed with the member's
   * principal, membership and persona like the member's own Influence. The world decides it; the
   * outcome is returned as the turn's recorded command step.
   */
  private async submitCommand(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: ActorWorldCommand,
  ): Promise<TurnCommandRecord> {
    const context = this.#talkContext(participant);
    if (context === undefined || proposal.expectedRevision === undefined)
      throw new Error("command context unavailable");
    // Initiation is the conversation's participant; a context for anyone else never submits.
    if (
      context.principalId !== participant.principalId ||
      context.personaId !== participant.personaId
    )
      throw new Error("command context unavailable");
    const scope = {
      tenantId: fiber.scope.tenantId,
      worldId: fiber.scope.worldId,
      timelineId: fiber.scope.timelineId,
      spaceId: fiber.scope.spaceId,
    } as RuntimeScope;
    const commandId = decodeOpaqueId(
      actorCommandId(
        participant.principalId,
        fiber.sessionId,
        fiber.messageId,
        actorModelConfiguration(this.environment.WORLD_MODEL_CONFIG).commandPrefix,
      ),
      "CommandId",
    );
    const expectedRevision = proposal.expectedRevision;
    const metadata = {
      correlationId: `${fiber.sessionId}:${fiber.messageId}`,
      requestId: commandId,
    };
    const prepared = await withCommandOwner(
      this.environment.HYPERDRIVE?.connectionString ?? "",
      (owner) =>
        owner.prepareBuilt(scope, participant.principalId, commandId, (fields) =>
          actorWorldCommand(scope, fiber.actorId, commandId, call, expectedRevision, {
            epochs: fields.epochs,
            context: fields.context ?? metadata,
            issuedAt: fields.issuedAt ?? proposal.issuedAt,
          }),
        ),
    );
    if (!prepared.tenantMember) throw new Error("command context unavailable");
    let result = prepared.stored;
    if (result === undefined) {
      if (!prepared.ready || prepared.input === undefined) throw new Error("world not ready");
      const input = prepared.input;
      const route = await runtimeRouteName("world", input.scope);
      try {
        result = unwrapWorldCommandRpc(
          await callWorldOwner(() =>
            this.environment.WORLD_DO.get(
              this.environment.WORLD_DO.idFromName(route),
            ).submitWorldCommand(input, context),
          ),
        );
      } catch (error) {
        // The world moved past the revision the turn perceived: nothing was recorded, so the turn
        // ends with a stale-world refusal the person can retry, instead of abandoning the turn.
        if (!(error instanceof JournalRevisionConflictError) || error.kind !== "partition")
          throw error;
        return {
          capability: proposal.capability,
          commandId: null,
          status: "refused",
          code: "revision_conflict",
          summary: "World command refused: revision_conflict",
        };
      }
    }
    const value = result.value;
    const committed = value.status === "committed";
    const code = committed
      ? null
      : (value.status === "denied" ? value.reasonCode : value.refusal.code)
          .toLowerCase()
          .replace(/[^a-z]+/gu, "_")
          .slice(0, 64);
    return {
      capability: proposal.capability,
      commandId: result.commandId,
      status: committed ? "committed" : "refused",
      code,
      summary: committed ? "World command committed" : `World command refused: ${code}`,
    };
  }

  protected research(): TurnResearchHost | undefined {
    // A production actor step reserves its own measured worst case (`preparer`); the policy's
    // fixed reserve covers the scripted fixture.
    return composeRuntime(this.environment).research;
  }

  /** The fetch that asks a space's admission hook; a test worker overrides it. */
  protected admissionFetch(): typeof fetch {
    return globalThis.fetch;
  }

  private admit(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    category: "model_call" | "tool_call",
    resource?: string,
    source: UsageAdmissionSource = "run_step",
  ): Promise<{ readonly admitted: true } | { readonly admitted: false; readonly cause: string }> {
    return admitSpend(
      this.stores(),
      this.admissionFetch(),
      this.environment.USAGE_WEBHOOK_SECRET,
      participant,
      fiber,
      category,
      resource,
      source,
    );
  }

  /** A shadow's decider asks admission before its model call, as the turn's own calls do. */
  private admittedShadow(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    source: Exclude<UsageAdmissionSource, "run_step">,
    decider: ShadowDecider | undefined,
  ): ShadowDecider | undefined {
    return admittedShadowDecider(decider, () =>
      this.admit(participant, fiber, "model_call", undefined, source),
    );
  }

  private fibers(scope: RuntimeScope, actorId: string): TurnFibers {
    this.#fibers ??= new TurnFibers({
      holder: this.instanceId,
      actorId,
      stores: this.stores(),
      respond: this.responder(),
      prepare: this.preparer(),
      research: this.research(),
      grants: (participant, fiber) =>
        this.grants(participant, fiber.scope, fiber.actorId, fiber.sessionId),
      submitCommand: (participant, fiber, proposal, call) =>
        this.submitCommand(participant, fiber, proposal, call),
      executeSelf: (participant, fiber, proposal, definition, input) =>
        this.executeSelf(participant, fiber, proposal, definition, input),
      capabilityRevision: () => this.recovery?.capabilityRevision ?? 0,
      admit: (participant, fiber, category, resource) =>
        this.admit(participant, fiber, category, resource),
      checkpointed: (fiber, phase) => this.turnCheckpointed(fiber, phase),
      afterReply: (participant, fiber, reply) => this.judgeActorReply(participant, fiber, reply),
      beforeModel: async (participant, fiber, input) => {
        let autonomous = false;
        if (fiber.messageId.startsWith("activation:")) {
          const result = await withActivations(this.environment, (store) =>
            store.beforeModel(
              { scope: scope as ActivationAddress["scope"], participant, actorId },
              fiber,
            ),
          );
          autonomous = result !== undefined;
          if (result === "deferred" || result === "noop" || result === "completed")
            throw new ActivationGateBlockedError(result === "completed" ? "noop" : result);
        }
        if (!autonomous) {
          try {
            const policy = moderationShadowPolicy(this.environment.MODERATION_SHADOW_CONFIG);
            if (policy !== undefined)
              await withWakeTriageClient(this.environment, (client) =>
                shadowActorMessage(
                  client,
                  participant,
                  fiber,
                  input,
                  policy,
                  this.admittedShadow(
                    participant,
                    fiber,
                    "moderation_shadow",
                    this.moderationDecider(policy, fiber),
                  ),
                ),
              );
          } catch {
            console.warn(
              JSON.stringify({
                event: "moderation-shadow-evidence-failed",
                actorId: fiber.actorId,
                sessionId: fiber.sessionId,
                messageId: fiber.messageId,
              }),
            );
          }
        }
        try {
          const policy = wakeTriagePolicy(this.environment.WAKE_TRIAGE_CONFIG);
          if (policy !== undefined)
            await withWakeTriageClient(this.environment, (client) =>
              shadowActorWake(
                client,
                participant,
                fiber,
                input,
                policy,
                this.admittedShadow(
                  participant,
                  fiber,
                  "wake_triage",
                  this.triageDecider(policy, fiber),
                ),
              ),
            );
        } catch {
          // Shadow evidence must never prevent the existing full turn, including database outages.
          console.warn(
            JSON.stringify({
              event: "wake-triage-evidence-failed",
              actorId: fiber.actorId,
              sessionId: fiber.sessionId,
              messageId: fiber.messageId,
            }),
          );
        }
      },
      durable: (fiber, participant, run) =>
        this.runFiber(`turn:${fiber.sessionId}:${fiber.messageId}`, async (fiberContext) => {
          fiberContext.stash({
            participant,
            scope,
            actorId,
            sessionId: fiber.sessionId,
            messageId: fiber.messageId,
          } satisfies TurnFiberSnapshot);
          return run();
        }),
    });
    return this.#fibers;
  }
}

export interface WorkflowEvent {
  readonly payload: workflows.WorkflowShellInput;
}
export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: BirthWorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}
export interface BirthWorkflowStepConfig {
  readonly retries: {
    readonly limit: number;
    readonly delay: number;
    readonly backoff: "exponential";
  };
  readonly timeout: string;
}
// Explicitly pin Cloudflare's documented defaults, rather than inheriting future provider changes:
// https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
const birthWorkflowStepConfig: BirthWorkflowStepConfig = {
  retries: { limit: 5, delay: 10_000, backoff: "exponential" },
  timeout: "10 minutes",
};
abstract class WorkflowAdapter extends WorkflowEntrypoint<
  RuntimeEnvironment,
  workflows.WorkflowShellInput
> {
  protected abstract readonly shell: {
    run(input: workflows.WorkflowShellInput): Promise<workflows.WorkflowShellResult>;
  };
  override run(event: WorkflowEvent, step: WorkflowStep): Promise<workflows.WorkflowShellResult> {
    return step.do("portable-runtime-shell", () => this.shell.run(event.payload));
  }
}
const isWakeLimit = (error: unknown) =>
  error instanceof Error && error.message === "activation wake limit reached";

/** Failures that every retry repeats: the pack's own defect, or a stage fenced by a terminal case. */
function deterministicBirthFailure(error: unknown): error is Error {
  return (
    error instanceof WorldGenesisDefectError ||
    (error instanceof ProvisioningStageError && error.status === "failed")
  );
}

function conflictRefusal(error: ProvisioningCaseConflictError): ProvisioningRefusal {
  return { code: "PROVISIONING_CASE_CONFLICT", path: "workflow", message: error.message };
}

abstract class BirthWorkflowAdapter extends WorkflowEntrypoint<
  RuntimeEnvironment,
  LifecycleWorkflowEnvelope
> {
  protected stepConfig(): BirthWorkflowStepConfig {
    return birthWorkflowStepConfig;
  }

  /** The world owner's raises of the pack size limits, from the optional `WORLD_PACK_LIMITS` binding. */
  protected packLimits(): Partial<WorldPackLimits> | undefined {
    const raises = this.env.WORLD_PACK_LIMITS;
    return raises === undefined ? undefined : parseWorldPackLimits(raises);
  }

  protected createProvisioningStore(
    client: PostgreSqlClient,
    _envelope: LifecycleWorkflowEnvelope,
  ): WorldProvisioningStore {
    return new PostgreSqlWorldProvisioningStore(client);
  }

  protected withProvisioningPorts<T>(
    operation: (ports: WorldProvisioningPorts, request: ProvisionWorldRequest) => Promise<T>,
    envelope: LifecycleWorkflowEnvelope,
  ): Promise<T> {
    return withLifecycleWorkflowClient(this.env, async (client) => {
      const request = await new PostgreSqlLifecycleWorkflowStore(client).read(envelope);
      try {
        return await operation(
          {
            store: this.createProvisioningStore(client, envelope),
            genesis: {
              seed: ({ artifact, source }) =>
                workflows.seedProvisioningBirth(artifact, source, this.packLimits()),
            },
            decodeResource,
          },
          request,
        );
      } catch (error) {
        // The envelope matched this run's registration, so a conflict refuses this case for good.
        if (error instanceof ProvisioningCaseConflictError) {
          await new PostgreSqlWorldProvisioningStore(client).recordFailure({
            authorization: request.authorization,
            caseId: request.caseId,
            refusal: conflictRefusal(error),
          });
        }
        throw error;
      }
    });
  }

  protected async execute<T>(
    input: unknown,
    operation: (ports: WorldProvisioningPorts, request: ProvisionWorldRequest) => Promise<T>,
  ) {
    const envelope = decodeLifecycleWorkflowEnvelope(input);
    try {
      return await this.withProvisioningPorts(operation, envelope);
    } catch (error) {
      if (error instanceof WorldProvisioningRefusedError) {
        return { version: 1, disposition: "refused", refusal: error.refusal };
      }
      if (error instanceof ProvisioningCaseConflictError) {
        return { version: 1, disposition: "refused", refusal: conflictRefusal(error) };
      }
      if (deterministicBirthFailure(error)) {
        // Workflows fails the step without retrying it.
        // https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#force-a-workflow-instance-to-fail
        throw new NonRetryableError(`${error.name}: ${error.message}`);
      }
      throw error;
    }
  }
}

export class WorldCatchUpWorkflow extends WorkflowEntrypoint<
  RuntimeEnvironment,
  CatchUpWorkflowEnvelope
> {
  protected stepConfig(): BirthWorkflowStepConfig {
    return birthWorkflowStepConfig;
  }

  override async run(event: { readonly payload: CatchUpWorkflowEnvelope }, step: WorkflowStep) {
    const envelope = decodeCatchUpWorkflowEnvelope(event.payload);
    const name = await runtimeRouteName("space", envelope);
    // Native step history is recoverable execution state; each callback reads canonical progress.
    for (let index = 0; ; index += 1) {
      const result = await step.do(
        `catch-up-owner-activation-v1-${index}`,
        this.stepConfig(),
        async () => {
          const owner = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(name));
          if (owner.catchUp === undefined) throw new Error("physical catch-up owner required");
          return owner.catchUp(envelope);
        },
      );
      if (result.disposition !== "continue") return result;
    }
  }
}

export class WorldProvisioningWorkflow extends BirthWorkflowAdapter {
  override async run(event: { readonly payload: LifecycleWorkflowEnvelope }, step: WorkflowStep) {
    const envelope = decodeLifecycleWorkflowEnvelope(event.payload);
    const outcome = await step.do("provision-world-to-verified-v1", this.stepConfig(), () =>
      this.execute(envelope, async (ports, request) => {
        await new workflows.WorldProvisioningWorkflow().run(request, ports);
        return { version: 1, disposition: "verified" };
      }),
    );
    if (outcome.disposition === "refused") return outcome;
    const handoff = await step.do("launch-world-readiness-v1", this.stepConfig(), () =>
      reconcileWorldProvisioning(this.env, envelope),
    );
    return { ...outcome, envelope, readinessInstanceId: handoff.readinessInstanceId };
  }
}

export class WorldReadinessWorkflow extends BirthWorkflowAdapter {
  override run(event: { readonly payload: LifecycleWorkflowEnvelope }, step: WorkflowStep) {
    const envelope = decodeLifecycleWorkflowEnvelope(event.payload);
    return step.do("verified-birth-to-ready-v1", this.stepConfig(), () =>
      this.execute(envelope, async (ports, request) => {
        const world = await new workflows.WorldReadinessWorkflow().run(request, ports);
        return { version: 1, disposition: "ready", world };
      }),
    );
  }
}
export class WorldPackUpgradeWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.WorldPackUpgradeWorkflow();
}
export class IngestionWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.IngestionWorkflow();
}
export class ConsolidationWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.ConsolidationWorkflow();
}
export class AuthoringWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.AuthoringWorkflow();
}
export class AgentJobWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.AgentJobWorkflow();
}
export class TransferRecoveryWorkflow extends WorkflowAdapter {
  protected readonly shell = new workflows.TransferRecoveryWorkflow();
}
