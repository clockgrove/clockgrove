import {
  AuthenticationRefusedError,
  AuthorizationRefusedError,
  CanonicalNodeError,
  encodeCanonicalNode,
  InspectedCommandNotFoundError,
  InspectedEventNotFoundError,
  InspectedScheduleNotFoundError,
  InspectorRateLimitedError,
  isTrustedId,
  type Journal,
  JournalRevisionConflictError,
  JournalRouteNotFoundError,
  PartitionStateIntegrityError,
  RuntimeActionRateLimitedError,
  type RuntimeAuthorizationDenial,
  type RuntimeAuthorizationResult,
  type RuntimeFailureClass,
  type RuntimeLogEvent,
  type RuntimeLogger,
  type RuntimeLogIds,
  type RuntimeLogOutcome,
  type RuntimeResponseCode,
  runtimeLogRecord,
  type WorldCommandResult,
  WorldContinuationPendingError,
} from "@clockgrove/application";
import {
  type BrowserScope,
  type ChangeViewedSpace,
  type ClientViewTrace,
  CommandIdempotencyInvariantError,
  ContractDecodeError,
  decodeBrowserScope,
  decodeChangeViewedSpace,
  decodeClientViewTraceRequest,
  decodeEntitySelectionRequest,
  decodeInfluenceRequest,
  decodeObservationRequest,
  decodeOpaqueId,
  decodeRecordedWhyRequest,
  decodeRunInspectRequest,
  decodeRunSearchRequest,
  decodeRuntimeNoOpRequest,
  decodeSayRequest,
  decodeSceneInterest,
  decodeWorldDirectoryRequest,
  type EntitySelection,
  type EntitySelectionRequest,
  encodeWorldStatus,
  type FollowDisposition,
  type InfluenceRequest,
  type LivingScene,
  type PrincipalId,
  type RecordedWhy,
  type RunInspectRequest,
  type RunSearch,
  type RunSearchRequest,
  type RunWalk,
  SCENE_CREDENTIAL_PREFIX,
  SCENE_PROTOCOL,
  type SceneInterest,
  type WorldDirectory,
  type WorldPersonaId,
  type WorldStatus,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext as TrustedContext } from "@clockgrove/contracts/trusted";
import type { CanonicalRuntimeStateSource } from "./canonical-state.js";
import { consoleRuntimeLogger } from "./cloudflare-logs.js";
import {
  CONVERSATION_REFUSAL_STATUS,
  CONVERSATION_ROUTES,
  ConversationRefusedError,
  type ConversationRoute,
  type ConversationStores,
  conversationCall,
} from "./conversations.js";
import {
  type CausalEntryInput,
  type CausalEntryView,
  decodeCausalChainInput,
  decodeRuntimeActionInput,
  decodeRuntimeStateInput,
  entryIdentity,
  INSPECT_GRANT,
  OBSERVE_GRANT,
  OPERATE_GRANT,
  type RuntimeActionInput,
  type RuntimeOperatorActionOutcome,
  type RuntimeStateInput,
  type RuntimeStateView,
} from "./inspector.js";
import {
  influenceCommand,
  influenceCommandId,
  influenceReceipt,
  scriptedSay,
} from "./interactions.js";
import { MemoryRuntimeLocalStorage } from "./local-storage.js";
import { OwnerMailboxError } from "./mailbox.js";
import { EntitySelectionUnavailableError } from "./observation.js";
import {
  AUTHORIZATION_REFUSED_RESULT,
  type NoOpRequestMetadata,
  recordNoOpDenial,
  SpaceDO,
  StoredRejectionError,
  storedNoOpOutcome,
} from "./owners.js";
import { runtimeRouteName } from "./routing.js";
import { RunNotFoundError } from "./runs.js";
import type {
  IdentifiedRuntimeRequest,
  TrustedRuntimeRequestAuthenticator,
} from "./trusted-composition.js";
import {
  type NoOpResponse,
  RuntimeEpochConflictError,
  type RuntimeInstanceId,
  RuntimeRouteNotFoundError,
  type RuntimeScope,
} from "./types.js";
import type { ClientViewInput } from "./view-trace.js";
import {
  type BuiltCommandFields,
  decodeWorldCommandInput,
  type PreparedBuiltCommand,
  runtimeFailureClass,
  WorldCatchingUpError,
  type WorldCommandInput,
  WorldOwnerFailedError,
  WorldOwnerUnavailableError,
  worldCommandGrant,
} from "./world-commands.js";

export interface RuntimeRequestAuthenticator {
  /** Returns a context established by the trusted composition boundary. */
  authenticate(request: Request): Promise<TrustedContext>;
}

export interface RuntimeOwnerBindings {
  readonly sceneConnection?: (
    scope: RuntimeScope,
    context: TrustedContext,
    interest: SceneInterest,
  ) => Promise<Response>;
  readonly observation?: {
    observe(scope: BrowserScope, context: TrustedContext): Promise<LivingScene>;
    select?(input: EntitySelectionRequest, context: TrustedContext): Promise<EntitySelection>;
    /** The canonical clock and recent material feed, under the scene's authority. */
    status?(scope: BrowserScope, context: TrustedContext): Promise<WorldStatus>;
  };
  /** Decides a viewed-space change; null answers success without a selection. */
  readonly changeViewedSpace?: (
    request: ChangeViewedSpace,
    authorize: (scope: BrowserScope) => Promise<TrustedContext>,
  ) => Promise<FollowDisposition | null>;
  /** The scope's arrival readiness, or undefined when the principal may not observe it. */
  readonly worldReadiness?: (
    principalId: PrincipalId,
    scope: BrowserScope,
  ) => Promise<"ready" | "provisioning" | "failed" | undefined>;
  /** The authenticated principal's observable scopes, under `runtime:world-observe` per row. */
  readonly worldDirectory?: (
    principalId: import("@clockgrove/contracts").PrincipalId,
  ) => Promise<WorldDirectory>;
  getSpace(routeName: string, scope: RuntimeScope): SpaceDO;
  /**
   * The canonical journal, when the bindings expose it. The Worker uses it, without creating an
   * owner, to answer exact retries of decided commands before authorization and to record
   * authorization denials.
   */
  readonly journal?: Journal;
  readonly worldCommands?: {
    prepare(
      input: WorldCommandInput,
      principalId: import("@clockgrove/contracts").PrincipalId,
    ): Promise<{
      readonly ready: boolean;
      readonly tenantMember: boolean;
      readonly stored?: WorldCommandResult;
    }>;
    submit(input: WorldCommandInput, context: TrustedContext): Promise<WorldCommandResult>;
    /** Prepares a command the server builds, in one connection (`PostgreSqlCommandOwner`). */
    prepareBuilt?(
      scope: RuntimeScope,
      principalId: import("@clockgrove/contracts").PrincipalId,
      commandId: import("@clockgrove/contracts").CommandId,
      build: (fields: BuiltCommandFields) => WorldCommandInput,
    ): Promise<PreparedBuiltCommand>;
    deny(
      input: WorldCommandInput,
      principalId: import("@clockgrove/contracts").PrincipalId,
      denial: RuntimeAuthorizationDenial,
    ): Promise<WorldCommandResult>;
  };
  /**
   * The audited causal-chain inspector; every authorized or refused access writes one audit row. It
   * checks each read's grant and ceiling itself: `recordedWhy` is the only observation read.
   */
  readonly inspector?: AuditedPort<CausalEntryInput, CausalEntryView> & {
    recordedWhy(input: CausalEntryInput, context: TrustedContext): Promise<RecordedWhy>;
  };
  /** Private conversations; absent when no artifact keyring is bound, so they fail closed. */
  readonly conversations?: ConversationStores;
  /** The viewer's own client view traced, under the observe grant and the inspector audit. */
  readonly viewTrace?: AuditedPort<ClientViewInput, ClientViewTrace>;
  /** Run walks and metadata search, under the inspector's grant, limit and audit (0036). */
  readonly runs?: {
    readonly walk: AuditedPort<RunInspectRequest, RunWalk>;
    readonly search: AuditedPort<RunSearchRequest, RunSearch>;
  };
  /** The audited runtime-state inspector, under the same grant, limit and audit. */
  readonly runtimeState?: AuditedPort<RuntimeStateInput, RuntimeStateView>;
  /** The audited operator actions under `runtime:world-operate`. */
  readonly operator?: AuditedPort<RuntimeActionInput, RuntimeOperatorActionOutcome>;
}

/** An authorized read or action, and the record of its refusal. */
export interface AuditedPort<I, O> {
  inspect(input: I, context: TrustedContext): Promise<O>;
  deny(
    input: I,
    principalId: import("@clockgrove/contracts").PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void>;
}

export class LocalRuntimeOwnerBindings implements RuntimeOwnerBindings {
  private readonly owners = new Map<string, SpaceDO>();
  private readonly storage = new Map<string, MemoryRuntimeLocalStorage>();

  constructor(
    private readonly canonical: CanonicalRuntimeStateSource,
    readonly journal: Journal,
  ) {}

  getSpace(routeName: string, scope: RuntimeScope): SpaceDO {
    let owner = this.owners.get(routeName);
    if (owner === undefined) {
      const storage = this.storage.get(routeName) ?? new MemoryRuntimeLocalStorage();
      this.storage.set(routeName, storage);
      owner = new SpaceDO({
        scope,
        routeName,
        runtimeInstanceId: `local:${routeName}` as RuntimeInstanceId,
        storage,
        canonical: this.canonical,
        journal: this.journal,
      });
      this.owners.set(routeName, owner);
    }
    return owner;
  }

  destroyRuntimeLocalState(routeName: string): void {
    this.storage.get(routeName)?.destroy();
    this.owners.delete(routeName);
  }

  seedRuntimeLocalState(
    routeName: string,
    state: Parameters<MemoryRuntimeLocalStorage["seedStale"]>[0],
  ): void {
    const storage = this.storage.get(routeName) ?? new MemoryRuntimeLocalStorage();
    storage.seedStale(state);
    this.storage.set(routeName, storage);
    this.owners.delete(routeName);
  }
}

/** What one request learned on its way, for its one answered record. Closed values only. */
interface RequestNote {
  ids: RuntimeLogIds;
  authorization: RuntimeAuthorizationResult;
  outcome?: RuntimeLogOutcome;
  code?: RuntimeResponseCode;
  routingEpoch?: bigint;
  revision?: string;
  failureClass?: RuntimeFailureClass;
}

/** The outcome each stable error code stands for, when no command outcome was set. */
const CODE_OUTCOMES: Readonly<Record<RuntimeResponseCode, RuntimeLogOutcome>> = {
  authentication_refused: "refused",
  authorization_refused: "refused",
  invalid_noop_command: "refused",
  invalid_world_command: "refused",
  invalid_inspection_request: "refused",
  world_not_ready: "refused",
  space_not_found: "refused",
  command_not_found: "refused",
  event_not_found: "refused",
  schedule_not_found: "refused",
  run_not_found: "refused",
  inspection_rate_limited: "refused",
  stale_epoch: "conflict",
  noop_command_conflict: "conflict",
  world_command_conflict: "conflict",
  command_id_reused: "conflict",
  world_continuation_pending: "conflict",
  world_catching_up: "unavailable",
  owner_unavailable: "unavailable",
  owner_mailbox_full: "unavailable",
  owner_mailbox_expired: "unavailable",
  owner_mailbox_timeout: "unavailable",
  inspector_unavailable: "unavailable",
  durable_state_corrupt: "failed",
  noop_command_failed: "failed",
  world_command_failed: "failed",
  inspection_failed: "failed",
  invalid_runtime_action: "refused",
  message_not_found: "refused",
  publication_not_failed: "refused",
  message_not_published: "refused",
  runtime_action_rate_limited: "refused",
  runtime_action_unavailable: "unavailable",
  runtime_action_failed: "failed",
};

/** The logged IDs of a traversal entry: its scope, and its command when it starts from one. */
function entryLogIds(input: CausalEntryInput): RuntimeLogIds {
  return { ...input.scope, ...("commandId" in input ? { commandId: input.commandId } : {}) };
}

/** An entry's stable refusals: each unknown entry kind has its own code. */
function entryRefusal(note: RequestNote, error: unknown): Response | undefined {
  if (error instanceof InspectedCommandNotFoundError)
    return refusal(note, "command_not_found", 404);
  if (error instanceof InspectedEventNotFoundError) return refusal(note, "event_not_found", 404);
  if (error instanceof InspectedScheduleNotFoundError)
    return refusal(note, "schedule_not_found", 404);
  if (error instanceof InspectorRateLimitedError)
    return refusal(note, "inspection_rate_limited", 429);
  return undefined;
}

/** An operator action's refusals by outcome; `repaired` and `replayed` answer 200. */
const ACTION_REFUSALS: Readonly<
  Partial<Record<RuntimeOperatorActionOutcome, readonly [RuntimeResponseCode, number]>>
> = {
  "not-found": ["message_not_found", 404],
  "not-failed": ["publication_not_failed", 409],
  "not-published": ["message_not_published", 409],
};

export class RuntimeWorker {
  constructor(
    private readonly authenticator: TrustedRuntimeRequestAuthenticator,
    private readonly bindings: RuntimeOwnerBindings,
    private readonly logger: RuntimeLogger = consoleRuntimeLogger,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/projection")
      return this.joinScene(request);
    if (request.method === "POST" && url.pathname === "/v1/runtime/why")
      return this.answer("causal_chain_inspection_answered", (note) =>
        this.recordedWhy(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/view-trace")
      return this.answer("scene_observation_answered", (note) => this.viewTrace(request, note));
    if (request.method === "POST" && url.pathname === "/v1/runtime/entity")
      return this.answer("scene_observation_answered", (note) =>
        this.observeScene(request, note, "entity"),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/scene")
      return this.answer("scene_observation_answered", (note) => this.observeScene(request, note));
    if (request.method === "POST" && url.pathname === "/v1/runtime/viewed-space")
      return this.answer("scene_observation_answered", (note) =>
        this.changeViewedSpace(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/world-status")
      return this.answer("scene_observation_answered", (note) =>
        this.observeScene(request, note, "status"),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/world-directory")
      return this.answer("scene_observation_answered", (note) =>
        this.worldDirectory(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/world-readiness")
      return this.answer("scene_observation_answered", (note) =>
        this.worldReadiness(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/commands")
      return this.answer("world_command_answered", (note) => this.worldCommand(request, note));
    if (request.method === "POST" && url.pathname === "/v1/runtime/influence")
      return this.answer("world_command_answered", (note) => this.influence(request, note));
    if (request.method === "POST" && isConversationRoute(url.pathname))
      return this.answer("scene_observation_answered", (note) =>
        this.conversation(request, note, url.pathname as ConversationRoute),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/say")
      return this.answer("scene_observation_answered", (note) => this.say(request, note));
    if (request.method === "POST" && url.pathname === "/v1/runtime/causal-chain")
      return this.answer("causal_chain_inspection_answered", (note) =>
        this.causalChain(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/runtime-state")
      return this.answer("runtime_state_inspection_answered", (note) =>
        this.runtimeState(request, note),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/runs/inspect")
      return this.answer("causal_chain_inspection_answered", (note) =>
        this.runRead(request, note, decodeRunInspectRequest, this.bindings.runs?.walk),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/runs/search")
      return this.answer("causal_chain_inspection_answered", (note) =>
        this.runRead(request, note, decodeRunSearchRequest, this.bindings.runs?.search),
      );
    if (request.method === "POST" && url.pathname === "/v1/runtime/actions")
      return this.answer("runtime_action_answered", (note) => this.runtimeAction(request, note));
    if (request.method !== "POST" || url.pathname !== "/v1/runtime/no-op") {
      return jsonResponse({ error: "not_found" }, 404);
    }
    return this.answer("noop_command_answered", (note) => this.noOpCommand(request, note));
  }

  private async joinScene(request: Request): Promise<Response> {
    try {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return jsonResponse({ error: "websocket_upgrade_required" }, 426);
      const url = new URL(request.url);
      const params = new URLSearchParams(url.searchParams);
      // Optional requested interest beyond the camera's space; the server decides what it allows.
      const flag = (key: string) => {
        const value = params.get(key);
        params.delete(key);
        if (value !== null && value !== "true")
          throw new ContractDecodeError(`interest.${key}`, "expected true");
        return value === "true";
      };
      const selection = params.get("selection");
      params.delete("selection");
      const interest = decodeSceneInterest({
        selection,
        conversation: flag("conversation"),
        operator: flag("operator"),
      });
      const scope = decodeBrowserScope(Object.fromEntries(params));
      if (
        Array.from(params.keys()).length !== Object.keys(scope).length ||
        url.searchParams.getAll("selection").length > 1 ||
        url.searchParams.getAll("conversation").length > 1 ||
        url.searchParams.getAll("operator").length > 1
      )
        return jsonResponse({ error: "invalid_scene_scope" }, 400);
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim());
      const credentials = protocols.filter((value) => value.startsWith(SCENE_CREDENTIAL_PREFIX));
      if (credentials.length !== 1 || credentials[0] === SCENE_CREDENTIAL_PREFIX)
        throw new AuthenticationRefusedError("scene credential required");
      if (protocols.length !== 2 || !protocols.includes(SCENE_PROTOCOL))
        return jsonResponse({ error: "unsupported_protocol" }, 426);
      const carrier = credentials[0];
      if (carrier === undefined) throw new AuthenticationRefusedError("scene credential required");
      const identified = await this.authenticator.identify(
        new Request(request.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${carrier.slice(SCENE_CREDENTIAL_PREFIX.length)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(scope),
        }),
      );
      const context = await this.authenticator.authorize(
        identified,
        {
          requestId: crypto.randomUUID(),
          correlationId: decodeOpaqueId(crypto.randomUUID(), "CorrelationId"),
        },
        OBSERVE_GRANT,
      );
      if (!context.privacyCeiling.allowedCategories.includes("public_scene"))
        throw new AuthorizationRefusedError("public scene required");
      // Requested interest is authorized here and again on every read; each refusal is stable.
      if (
        interest.conversation &&
        !context.privacyCeiling.allowedCategories.includes("conversation")
      )
        return jsonResponse({ error: "conversation_interest_refused" }, 403);
      if (interest.operator)
        try {
          await this.authenticator.authorize(
            identified,
            { requestId: context.requestId, correlationId: context.correlationId },
            INSPECT_GRANT,
          );
        } catch (error) {
          if (error instanceof AuthorizationRefusedError)
            return jsonResponse({ error: "operator_interest_refused" }, 403);
          throw error;
        }
      if (this.bindings.sceneConnection === undefined)
        return jsonResponse({ error: "scene_unavailable" }, 503);
      return await this.bindings.sceneConnection(scope, context, interest);
    } catch (error) {
      if (error instanceof AuthenticationRefusedError)
        return jsonResponse({ error: "authentication_refused" }, 401);
      if (error instanceof AuthorizationRefusedError)
        return jsonResponse({ error: "authorization_refused" }, 403);
      if (error instanceof ContractDecodeError)
        return jsonResponse({ error: "invalid_scene_scope" }, 400);
      if (error instanceof RuntimeRouteNotFoundError)
        return jsonResponse({ error: "space_not_found" }, 404);
      return jsonResponse({ error: "scene_admission_failed" }, 500);
    }
  }

  /**
   * Answers one request and writes its one record, whatever the outcome: on the success path that
   * is the request's only record and its only cost, one `console` call with no other I/O.
   */
  private async answer(
    event: RuntimeLogEvent,
    handle: (note: RequestNote) => Promise<Response>,
  ): Promise<Response> {
    const note: RequestNote = { ids: {}, authorization: "not_evaluated" };
    const response = await handle(note);
    this.logger.log(
      runtimeLogRecord(response.status < 400 ? "info" : "warn", event, {
        ...note.ids,
        authorization: note.authorization,
        outcome: note.outcome ?? (note.code === undefined ? undefined : CODE_OUTCOMES[note.code]),
        code: note.code,
        status: response.status,
        routingEpoch: note.routingEpoch === undefined ? undefined : Number(note.routingEpoch),
        revision: note.revision === undefined ? undefined : Number(note.revision),
        failureClass: note.failureClass,
      }),
    );
    return response;
  }

  private async noOpCommand(request: Request, note: RequestNote): Promise<Response> {
    let input: DecodedNoOpRequest | undefined;
    let metadata: NoOpRequestMetadata | undefined;
    try {
      // Authentication refusals (401) happen here and are never recorded.
      const identified = await this.authenticator.identify(request.clone());
      let undecodable: unknown;
      try {
        input = decodeNoOpRequest(await request.json());
      } catch (error) {
        undecodable = error;
      }
      if (input === undefined) {
        // Not a runtime command: authorization keeps its status and nothing is recorded.
        await this.authenticator.authorize(identified);
        throw undecodable;
      }
      metadata = this.authenticator.metadata(identified);
      note.ids = { ...input.scope, ...metadata, commandId: input.command.commandId };
      note.routingEpoch = input.command.epochs.routingEpoch;
      const journal = this.bindings.journal;
      // An exact retry of a decided command returns its stored outcome without deciding again.
      const stored =
        journal === undefined
          ? undefined
          : await storedNoOpOutcome(
              journal,
              input.scope,
              identified.principalId,
              metadata,
              input.command,
            );
      if (stored !== undefined) {
        note.outcome = "replayed";
        return stored.status === "rejected"
          ? jsonResponse(stored.result.value, 403)
          : jsonResponse(encodeNoOpResponse(stored.result.value as NoOpResponse));
      }
      let context: TrustedContext;
      try {
        context = await this.authenticator.authorize(identified, metadata);
      } catch (error) {
        if (
          error instanceof AuthorizationRefusedError &&
          error.denial !== undefined &&
          journal !== undefined
        ) {
          // A recorded denial is a new rejected receipt, as for world commands; else a refusal.
          const recorded = await recordNoOpDenial(
            journal,
            input.scope,
            identified.principalId,
            metadata,
            input.command,
            error.denial,
          );
          if (recorded) note.outcome = "rejected";
        }
        throw error;
      }
      note.authorization = "authorized";
      assertContextScope(context, input.scope);
      const routeName = await runtimeRouteName("space", input.scope);
      const owner = this.bindings.getSpace(routeName, input.scope);
      const initialized = await owner.initialize(context);
      const result = await owner.submitNoOp(context, input.command, initialized.disposition);
      note.outcome = "committed";
      return jsonResponse(encodeNoOpResponse(result));
    } catch (error) {
      if (error instanceof StoredRejectionError) {
        note.outcome = "replayed";
        return jsonResponse(error.value, 403);
      }
      if (error instanceof AuthenticationRefusedError) {
        note.authorization = "unauthenticated";
        return refusal(note, "authentication_refused", 401);
      }
      if (error instanceof AuthorizationRefusedError) {
        note.authorization = "denied";
        note.code = "authorization_refused";
        return jsonResponse(AUTHORIZATION_REFUSED_RESULT, 403);
      }
      if (
        input === undefined &&
        (error instanceof ContractDecodeError ||
          error instanceof CanonicalNodeError ||
          error instanceof SyntaxError)
      )
        return refusal(note, "invalid_noop_command", 400);
      if (error instanceof RuntimeEpochConflictError)
        return failure(note, error, "stale_epoch", 409, { kind: error.kind });
      if (error instanceof JournalRevisionConflictError)
        return failure(note, error, "noop_command_conflict", 409, { kind: error.kind });
      if (error instanceof CommandIdempotencyInvariantError)
        return failure(note, error, "command_id_reused", 409);
      if (error instanceof RuntimeRouteNotFoundError || error instanceof JournalRouteNotFoundError)
        return refusal(note, "space_not_found", 404);
      if (error instanceof PartitionStateIntegrityError)
        return failure(note, error, "durable_state_corrupt", 500);
      if (error instanceof WorldOwnerUnavailableError)
        return failure(note, error, "owner_unavailable", 503);
      // The cause stays in the server log; the response names only the stable code. A relayed
      // owner failure was logged by the owner that caught it.
      const response = failure(note, error, "noop_command_failed", 500);
      if (!(error instanceof WorldOwnerFailedError))
        this.logger.log(
          runtimeLogRecord(
            "error",
            "noop_command_failed",
            { ...note.ids, failureClass: note.failureClass },
            error,
          ),
        );
      return response;
    }
  }

  private worldCommand(request: Request, note: RequestNote): Promise<Response> {
    return this.submitWorldCommand(
      request,
      note,
      async () => ({ input: decodeWorldCommandInput(await request.json()) }),
      (result, replayed) => worldResult(note, result, replayed),
    );
  }

  /**
   * An Influence intent: the server builds the typed `resource.offer` command, so the
   * client chooses neither attribution nor epochs, and it runs the world-command path under
   * `runtime:world-command`. A denial is a recorded rejected receipt like any world command's, and
   * a retried intent replays its stored receipt.
   */
  private influence(request: Request, note: RequestNote): Promise<Response> {
    let influence: InfluenceRequest | undefined;
    let principalId: PrincipalId | undefined;
    return this.submitWorldCommand(
      request,
      note,
      async (identified) => {
        const decoded = decodeInfluenceRequest(await request.json());
        influence = decoded;
        principalId = identified.principalId;
        const prepareBuilt = this.bindings.worldCommands?.prepareBuilt;
        if (prepareBuilt === undefined) throw new WorldOwnerUnavailableError();
        const metadata = readMetadata(identified.correlationHeader);
        const issuedAt = new Date().toISOString();
        const prepared = await prepareBuilt(
          decoded.scope,
          identified.principalId,
          decodeOpaqueId(influenceCommandId(identified.principalId, decoded.intentId), "CommandId"),
          (fields) =>
            influenceCommand(decoded, identified.principalId, {
              epochs: fields.epochs,
              context: fields.context ?? metadata,
              issuedAt: fields.issuedAt ?? issuedAt,
            }),
        );
        if (prepared.input === undefined)
          throw new AuthorizationRefusedError("tenant membership required");
        return { input: prepared.input, prepared };
      },
      (result, replayed, personaId) => {
        note.outcome = replayed ?? result.outcome;
        if (result.value.status === "committed") note.revision = result.value.revision;
        const receipt = influenceReceipt(influence as InfluenceRequest, result, {
          principalId: principalId as PrincipalId,
          personaId:
            personaId ??
            (result.events[0]?.attribution as { personaId?: WorldPersonaId } | undefined)
              ?.personaId ??
            null,
        });
        return jsonResponse(receipt, worldResultStatus(result));
      },
    );
  }

  private async submitWorldCommand(
    request: Request,
    note: RequestNote,
    decode: (identified: IdentifiedRuntimeRequest) => Promise<{
      readonly input: WorldCommandInput;
      readonly prepared?: PreparedBuiltCommand;
    }>,
    answer: (
      result: WorldCommandResult,
      replayed: "replayed" | undefined,
      personaId?: WorldPersonaId,
    ) => Response,
  ): Promise<Response> {
    let input: WorldCommandInput | undefined;
    try {
      const identified = await this.authenticator.identify(request.clone());
      const decoded = await decode(identified);
      input = decoded.input;
      note.ids = {
        ...input.scope,
        correlationId: input.command.context.correlationId,
        requestId: input.command.context.requestId,
        commandId: input.command.commandId,
      };
      note.routingEpoch = input.epochs.routingEpoch;
      const bindings = this.bindings.worldCommands;
      if (bindings === undefined) throw new WorldOwnerUnavailableError();
      const prepared = decoded.prepared ?? (await bindings.prepare(input, identified.principalId));
      if (!prepared.tenantMember) throw new AuthorizationRefusedError("tenant membership required");
      if (prepared.stored !== undefined) return answer(prepared.stored, "replayed");
      if (!prepared.ready) return refusal(note, "world_not_ready", 409);
      let context: TrustedContext;
      try {
        context = await this.authenticator.authorize(
          { ...identified, commandId: input.command.commandId },
          {
            requestId: input.command.context.requestId,
            correlationId: input.command.context.correlationId,
          },
          worldCommandGrant(input),
        );
      } catch (error) {
        if (error instanceof AuthorizationRefusedError && error.denial !== undefined) {
          note.authorization = "denied";
          const result = await bindings.deny(input, identified.principalId, error.denial);
          return answer(result, undefined, error.denial.inputs.personaId);
        }
        throw error;
      }
      note.authorization = "authorized";
      return answer(await bindings.submit(input, context), undefined, context.personaId);
    } catch (error) {
      if (error instanceof AuthenticationRefusedError) {
        note.authorization = "unauthenticated";
        return refusal(note, "authentication_refused", 401);
      }
      if (error instanceof AuthorizationRefusedError) {
        note.authorization = "denied";
        return refusal(note, "authorization_refused", 403);
      }
      if (
        input === undefined &&
        (error instanceof ContractDecodeError ||
          error instanceof CanonicalNodeError ||
          error instanceof SyntaxError)
      )
        return refusal(note, "invalid_world_command", 400);
      if (error instanceof PartitionStateIntegrityError)
        return failure(note, error, "durable_state_corrupt", 500);
      if (error instanceof JournalRevisionConflictError)
        return failure(note, error, "world_command_conflict", 409, { kind: error.kind });
      if (error instanceof CommandIdempotencyInvariantError)
        return failure(note, error, "command_id_reused", 409);
      if (error instanceof WorldContinuationPendingError)
        return failure(note, error, "world_continuation_pending", 409);
      if (error instanceof WorldCatchingUpError)
        return failure(note, error, "world_catching_up", 503, {}, { "retry-after": "1" });
      if (error instanceof JournalRouteNotFoundError) return refusal(note, "space_not_found", 404);
      // The physical owner's mailbox answered for it: retry the same accepted bytes after the hint.
      if (error instanceof OwnerMailboxError)
        return failure(
          note,
          error,
          error.code,
          503,
          { retryAfterSeconds: error.retryAfterSeconds },
          { "retry-after": String(error.retryAfterSeconds) },
        );
      // Server failures: the commit outcome may be unknown, so retry with the same accepted bytes.
      if (error instanceof WorldOwnerUnavailableError)
        return failure(note, error, "owner_unavailable", 503);
      // The cause stays in the server log; the response names only the stable code. A relayed
      // owner failure was logged by the owner that caught it.
      const response = failure(note, error, "world_command_failed", 500);
      if (!(error instanceof WorldOwnerFailedError))
        this.logger.log(
          runtimeLogRecord(
            "error",
            "world_command_failed",
            { ...note.ids, failureClass: note.failureClass },
            error,
          ),
        );
      return response;
    }
  }

  /**
   * A scene, entity or clock-and-feed read under the observe grant. A read has request
   * correlation, never a synthetic canonical command identity.
   */
  private async observeScene(
    request: Request,
    note: RequestNote,
    kind: "scene" | "entity" | "status" = "scene",
  ): Promise<Response> {
    try {
      const identified = await this.authenticator.identify(request.clone());
      const value: unknown = await request.json();
      const selected = kind === "entity" ? decodeEntitySelectionRequest(value) : undefined;
      const scope = selected ?? decodeObservationRequest(value);
      const metadata = readMetadata(identified.correlationHeader);
      note.ids = { ...scope, ...metadata };
      const context = await this.authenticator.authorize(identified, metadata, OBSERVE_GRANT);
      note.authorization = "authorized";
      const reader = this.bindings.observation;
      if (reader === undefined) return refusal(note, "inspector_unavailable", 503);
      const scene =
        selected !== undefined
          ? await reader.select?.(selected, context)
          : kind === "status"
            ? await reader.status?.(scope, context).then(encodeWorldStatus)
            : await reader.observe(scope, context);
      if (scene === undefined) return refusal(note, "inspector_unavailable", 503);
      note.outcome = "read";
      return jsonResponse(scene);
    } catch (error) {
      return this.observationRefusal(note, error);
    }
  }

  /**
   * Private Caretaker Talk and its sessions, under the observe grant, a `conversation` ceiling and
   * a resolved persona, the policy the interaction card's Talk action reports. A new session
   * addresses only an actor (an entity with needs) projected in the request's space. Rows are the
   * participant's own (migration 0034); nothing here reaches the scene.
   */
  private async conversation(
    request: Request,
    note: RequestNote,
    route: ConversationRoute,
  ): Promise<Response> {
    try {
      const identified = await this.authenticator.identify(request.clone());
      const call = conversationCall(route, await request.json());
      const metadata = readMetadata(identified.correlationHeader);
      note.ids = { ...call.scope, ...metadata };
      const context = await this.authenticator.authorize(identified, metadata, OBSERVE_GRANT);
      const personaId = context.personaId;
      if (
        !context.privacyCeiling.allowedCategories.includes("conversation") ||
        personaId === undefined
      )
        throw new AuthorizationRefusedError("conversation refused");
      note.authorization = "authorized";
      const stores = this.bindings.conversations;
      if (stores === undefined) {
        note.outcome = "unavailable";
        return jsonResponse({ error: "conversation_unavailable" }, 503);
      }
      if (call.actorId !== undefined) {
        const refused = await this.unaddressable(call.scope, call.actorId, context, note);
        if (refused !== undefined) return refused;
      }
      const answer = await stores((store) => call.run(store, { ...context, personaId }));
      note.outcome = "read";
      return jsonResponse(answer);
    } catch (error) {
      if (error instanceof ConversationRefusedError) {
        note.outcome = error.code === "conversation_not_found" ? "refused" : "conflict";
        return jsonResponse({ error: error.code }, CONVERSATION_REFUSAL_STATUS[error.code]);
      }
      return this.observationRefusal(note, error);
    }
  }

  /**
   * Public Say: the addressed actor speaks a scripted line aloud, attributed to the caller whose
   * explicit action made it speak. Distinct from Talk: it needs no `conversation` category and is
   * never stored in a session.
   */
  private async say(request: Request, note: RequestNote): Promise<Response> {
    try {
      const identified = await this.authenticator.identify(request.clone());
      const say = decodeSayRequest(await request.json());
      const metadata = readMetadata(identified.correlationHeader);
      note.ids = { ...say.scope, ...metadata };
      const context = await this.authenticator.authorize(identified, metadata, OBSERVE_GRANT);
      const personaId = context.personaId;
      if (personaId === undefined) throw new AuthorizationRefusedError("say refused");
      note.authorization = "authorized";
      const refused = await this.unaddressable(say.scope, say.actorId, context, note);
      if (refused !== undefined) return refused;
      note.outcome = "read";
      return jsonResponse(scriptedSay(say, { ...context, personaId }, new Date().toISOString()));
    } catch (error) {
      return this.observationRefusal(note, error);
    }
  }

  /** The card's capability, enforced here too: only a projected actor (one with needs) is addressed. */
  private async unaddressable(
    scope: BrowserScope,
    actorId: string,
    context: TrustedContext,
    note: RequestNote,
  ): Promise<Response | undefined> {
    const select = this.bindings.observation?.select;
    if (select === undefined) return refusal(note, "inspector_unavailable", 503);
    const actor = await select(
      { version: 1, ...scope, objectId: actorId } as EntitySelectionRequest,
      context,
    );
    if (actor.physical.needs !== null) return undefined;
    note.outcome = "refused";
    return jsonResponse({ error: "talk_unavailable" }, 409);
  }

  /** Navigation decides what the observer sees next and changes no world fact. */
  private async changeViewedSpace(request: Request, note: RequestNote): Promise<Response> {
    try {
      const value: unknown = await request.clone().json();
      const change = decodeChangeViewedSpace(value);
      const decide = this.bindings.changeViewedSpace;
      const metadata = readMetadata(request.headers.get("x-correlation-id"));
      note.ids = { ...change.scope, ...metadata };
      const scopeHeaders = new Headers(request.headers);
      scopeHeaders.delete("content-length");
      const authorize = async (scope: BrowserScope) => {
        const identified = await this.authenticator.identify(
          new Request(request.url, {
            method: "POST",
            headers: scopeHeaders,
            body: JSON.stringify(scope),
          }),
        );
        const context = await this.authenticator.authorize(identified, metadata, OBSERVE_GRANT);
        if (!context.privacyCeiling.allowedCategories.includes("public_scene"))
          throw new AuthorizationRefusedError("public scene required");
        return context;
      };
      if (decide === undefined) return refusal(note, "inspector_unavailable", 503);
      const answer = await decide(change, authorize);
      // A refused navigation is answered as a disposition, and logged as the refusal it is.
      const refused = answer?.disposition === "permission_denied";
      note.authorization = refused ? "denied" : "authorized";
      note.outcome = refused || answer?.disposition === "unavailable" ? "refused" : "read";
      return answer === null ? new Response(null, { status: 204 }) : jsonResponse(answer);
    } catch (error) {
      return this.observationRefusal(note, error);
    }
  }

  /**
   * The observer world directory: authentication only, then the principal's observable scopes.
   * The body names no scope; the observe grant is applied per membership by the directory read.
   */
  private async worldDirectory(request: Request, note: RequestNote): Promise<Response> {
    try {
      const authenticated = await this.authenticator.authenticatePrincipal(request);
      decodeWorldDirectoryRequest(await request.json());
      note.ids = readMetadata(authenticated.correlationHeader);
      const read = this.bindings.worldDirectory;
      if (read === undefined) return refusal(note, "inspector_unavailable", 503);
      const directory = await read(authenticated.principalId);
      note.authorization = "authorized";
      note.outcome = "read";
      return jsonResponse(directory);
    } catch (error) {
      return this.observationRefusal(note, error);
    }
  }

  /** Whether the observer's world is ready: authentication, then the observe grant, then readiness. */
  private async worldReadiness(request: Request, note: RequestNote): Promise<Response> {
    try {
      const authenticated = await this.authenticator.authenticatePrincipal(request);
      const { version: _version, ...scope } = decodeObservationRequest(await request.json());
      note.ids = { ...scope, ...readMetadata(authenticated.correlationHeader) };
      const read = this.bindings.worldReadiness;
      if (read === undefined) return refusal(note, "inspector_unavailable", 503);
      const readiness = await read(authenticated.principalId, scope);
      if (readiness === undefined) {
        note.authorization = "denied";
        return refusal(note, "authorization_refused", 403);
      }
      note.authorization = "authorized";
      if (readiness === "ready") {
        note.outcome = "read";
        return jsonResponse({ version: 1, readiness });
      }
      note.outcome = "refused";
      return jsonResponse({ error: "world_not_ready", readiness }, 409);
    } catch (error) {
      return this.observationRefusal(note, error);
    }
  }

  /** An observation read's refusal or failure, answered with its stable code. */
  private observationRefusal(note: RequestNote, error: unknown): Response {
    if (error instanceof AuthenticationRefusedError) {
      note.authorization = "unauthenticated";
      return refusal(note, "authentication_refused", 401);
    }
    if (error instanceof AuthorizationRefusedError) {
      note.authorization = "denied";
      return refusal(note, "authorization_refused", 403);
    }
    if (error instanceof ContractDecodeError || error instanceof SyntaxError)
      return refusal(note, "invalid_inspection_request", 400);
    if (error instanceof EntitySelectionUnavailableError) {
      note.outcome = "refused";
      return jsonResponse({ error: "selection_unavailable" }, 409);
    }
    if (error instanceof JournalRouteNotFoundError) return refusal(note, "world_not_ready", 409);
    const response =
      runtimeFailureClass(error) === "database_unavailable"
        ? failure(note, error, "inspector_unavailable", 503)
        : failure(note, error, "inspection_failed", 500);
    this.logger.log(
      runtimeLogRecord(
        "error",
        "scene_observation_failed",
        { ...note.ids, failureClass: note.failureClass },
        error,
      ),
    );
    return response;
  }

  /** Shared-browser Why: the audited inspector narrows its ceiling and output to the public Why. */
  private recordedWhy(request: Request, note: RequestNote): Promise<Response> {
    const inspector = this.bindings.inspector;
    return this.audited(request, note, {
      decode: (value): CausalEntryInput => {
        const {
          version: _version,
          tenantId,
          worldId,
          timelineId,
          spaceId,
          ...entry
        } = decodeRecordedWhyRequest(value);
        return { scope: { tenantId, worldId, timelineId, spaceId }, ...entry };
      },
      invalid: "invalid_inspection_request",
      port:
        inspector === undefined
          ? undefined
          : {
              deny: (input, principalId, denial) => inspector.deny(input, principalId, denial),
              inspect: async (input, context) => {
                try {
                  return await inspector.recordedWhy(input, context);
                } catch (error) {
                  // Input decoding has already finished; producer defects are server failures.
                  if (
                    error instanceof ContractDecodeError ||
                    error instanceof CanonicalNodeError ||
                    error instanceof SyntaxError
                  )
                    throw new Error("recorded evidence decoding failed", { cause: error });
                  throw error;
                }
              },
            },
      grant: OBSERVE_GRANT,
      seed: entryIdentity,
      ids: entryLogIds,
      answer: (view) => {
        note.outcome = "read";
        return jsonResponse(view);
      },
      refuse: (error) => entryRefusal(note, error),
      unavailable: "inspector_unavailable",
      failed: ["inspection_failed", "causal_chain_inspection_failed"],
    });
  }

  /** Client view → audience decision → projection revision, for the caller's own view. */
  private viewTrace(request: Request, note: RequestNote): Promise<Response> {
    return this.audited(request, note, {
      decode: (value): ClientViewInput => {
        const decoded = decodeClientViewTraceRequest(value);
        const { tenantId, worldId, timelineId, spaceId } = decoded;
        return { scope: { tenantId, worldId, timelineId, spaceId }, request: decoded };
      },
      invalid: "invalid_inspection_request",
      port: this.bindings.viewTrace,
      grant: OBSERVE_GRANT,
      seed: () => crypto.randomUUID(),
      ids: (input) => ({ ...input.scope }),
      answer: (trace) => {
        note.outcome = "read";
        return jsonResponse(trace);
      },
      refuse: (error) =>
        error instanceof JournalRouteNotFoundError
          ? refusal(note, "world_not_ready", 409)
          : error instanceof InspectorRateLimitedError
            ? refusal(note, "inspection_rate_limited", 429)
            : undefined,
      unavailable: "inspector_unavailable",
      failed: ["inspection_failed", "scene_observation_failed"],
    });
  }

  /** Responses carry stable codes only: no exception class names, no other tenant's facts. */
  private causalChain(request: Request, note: RequestNote): Promise<Response> {
    return this.audited(request, note, {
      decode: decodeCausalChainInput,
      invalid: "invalid_inspection_request",
      port: this.bindings.inspector,
      grant: INSPECT_GRANT,
      seed: entryIdentity,
      ids: entryLogIds,
      answer: (view) => {
        note.outcome = "read";
        return jsonResponse(encodeCanonicalNode(view));
      },
      // An unknown ID, another tenant's and another world's entry are one answer.
      refuse: (error) => entryRefusal(note, error),
      unavailable: "inspector_unavailable",
      failed: ["inspection_failed", "causal_chain_inspection_failed"],
    });
  }

  /**
   * A run walk or metadata search: the causal chain's grant, codes and audit. A walk that reaches
   * no run of the scope answers 404 `run_not_found`, the same for another tenant's or world's.
   */
  private runRead<I extends { readonly scope: RuntimeScope }, O>(
    request: Request,
    note: RequestNote,
    decode: (value: unknown) => I,
    port: AuditedPort<I, O> | undefined,
  ): Promise<Response> {
    return this.audited(request, note, {
      decode,
      invalid: "invalid_inspection_request",
      port,
      grant: INSPECT_GRANT,
      // No command names this read: its request ID is its own.
      seed: () => crypto.randomUUID(),
      ids: (input) => ({ ...input.scope }),
      answer: (output) => {
        note.outcome = "read";
        return jsonResponse(output);
      },
      refuse: (error) =>
        error instanceof RunNotFoundError
          ? refusal(note, "run_not_found", 404)
          : error instanceof InspectorRateLimitedError
            ? refusal(note, "inspection_rate_limited", 429)
            : undefined,
      unavailable: "inspector_unavailable",
      failed: ["inspection_failed", "causal_chain_inspection_failed"],
    });
  }

  /** The runtime-state view: the causal chain's grant, codes and audit, and 404 for no partition. */
  private runtimeState(request: Request, note: RequestNote): Promise<Response> {
    return this.audited(request, note, {
      decode: decodeRuntimeStateInput,
      invalid: "invalid_inspection_request",
      port: this.bindings.runtimeState,
      grant: INSPECT_GRANT,
      // No command names this read: its request ID is its own.
      seed: () => crypto.randomUUID(),
      ids: (input) => ({ ...input.scope }),
      answer: (view) => {
        note.outcome = "read";
        return jsonResponse(encodeCanonicalNode(view));
      },
      refuse: (error) =>
        error instanceof JournalRouteNotFoundError
          ? refusal(note, "space_not_found", 404)
          : error instanceof InspectorRateLimitedError
            ? refusal(note, "inspection_rate_limited", 429)
            : undefined,
      unavailable: "inspector_unavailable",
      failed: ["inspection_failed", "runtime_state_inspection_failed"],
    });
  }

  /** Publication repair and message replay under `runtime:world-operate`. */
  private runtimeAction(request: Request, note: RequestNote): Promise<Response> {
    return this.audited(request, note, {
      decode: decodeRuntimeActionInput,
      invalid: "invalid_runtime_action",
      port: this.bindings.operator,
      grant: OPERATE_GRANT,
      seed: (input) => input.messageId,
      ids: (input) => ({ ...input.scope, messageId: input.messageId }),
      answer: (outcome, input) => {
        const refused = ACTION_REFUSALS[outcome];
        if (refused !== undefined) return refusal(note, refused[0], refused[1]);
        note.outcome = "committed";
        return jsonResponse({ action: input.action, messageId: input.messageId, outcome });
      },
      refuse: (error) =>
        error instanceof RuntimeActionRateLimitedError
          ? refusal(note, "runtime_action_rate_limited", 429)
          : undefined,
      unavailable: "runtime_action_unavailable",
      failed: ["runtime_action_failed", "runtime_action_failed"],
    });
  }

  /**
   * One audited inspector read or operator action. Authentication and malformed requests are refused
   * before anything is recorded; an authorization refusal is recorded by the port, then answered 403.
   */
  private async audited<I extends { readonly scope: RuntimeScope }, O>(
    request: Request,
    note: RequestNote,
    route: {
      readonly decode: (value: unknown) => I;
      readonly invalid: RuntimeResponseCode;
      readonly port: AuditedPort<I, O> | undefined;
      readonly grant: string;
      /** The ID the request's trusted metadata derives from. */
      readonly seed: (input: I) => string;
      readonly ids: (input: I) => RuntimeLogIds;
      readonly answer: (output: O, input: I) => Response;
      readonly refuse: (error: unknown) => Response | undefined;
      readonly unavailable: RuntimeResponseCode;
      readonly failed: readonly [RuntimeResponseCode, RuntimeLogEvent];
    },
  ): Promise<Response> {
    try {
      const identified = await this.authenticator.identify(request.clone());
      let input: I;
      try {
        input = route.decode(await request.json());
      } catch {
        return refusal(note, route.invalid, 400);
      }
      note.ids = route.ids(input);
      const port = route.port;
      if (port === undefined) return refusal(note, route.unavailable, 503);
      let context: TrustedContext;
      try {
        context = await this.authenticator.authorize(
          { ...identified, commandId: route.seed(input) },
          undefined,
          route.grant,
        );
      } catch (error) {
        if (error instanceof AuthorizationRefusedError)
          await port.deny(input, identified.principalId, error.denial);
        throw error;
      }
      note.authorization = "authorized";
      note.ids = {
        ...note.ids,
        correlationId: context.correlationId,
        requestId: context.requestId,
      };
      return route.answer(await port.inspect(input, context), input);
    } catch (error) {
      if (error instanceof AuthenticationRefusedError) {
        note.authorization = "unauthenticated";
        return refusal(note, "authentication_refused", 401);
      }
      if (error instanceof AuthorizationRefusedError) {
        note.authorization = "denied";
        return refusal(note, "authorization_refused", 403);
      }
      const refused = route.refuse(error);
      if (refused !== undefined) return refused;
      if (error instanceof ContractDecodeError || error instanceof SyntaxError)
        return refusal(note, route.invalid, 400);
      // PostgreSQL is unreachable: nothing was returned or changed and no audit row could be
      // written, so the request is refused as unavailable, retryable later, rather than failed
      //. Either way the Worker caught the cause, so it logs it.
      const [code, event] = route.failed;
      const response =
        runtimeFailureClass(error) === "database_unavailable"
          ? failure(note, error, route.unavailable, 503)
          : failure(note, error, code, 500);
      this.logger.log(
        runtimeLogRecord("error", event, { ...note.ids, failureClass: note.failureClass }, error),
      );
      return response;
    }
  }
}

interface DecodedNoOpRequest {
  readonly scope: RuntimeScope;
  readonly command: Parameters<SpaceDO["submitNoOp"]>[1];
}

function decodeNoOpRequest(value: unknown): DecodedNoOpRequest {
  const input = decodeRuntimeNoOpRequest(value);
  // Trusted IDs are minted only by application code; a client may not choose one, so it can never
  // take a trusted command's receipt or event ID. Such a request is not a runtime command.
  if (isTrustedId(input.commandId)) {
    throw new ContractDecodeError("request.commandId", "reserved for trusted commands");
  }
  if (isTrustedId(input.eventId)) {
    throw new ContractDecodeError("request.eventId", "reserved for trusted events");
  }
  return {
    scope: {
      tenantId: input.tenantId,
      worldId: input.worldId,
      timelineId: input.timelineId,
      spaceId: input.spaceId,
    },
    command: {
      commandId: input.commandId,
      actionId: input.actionId,
      eventId: input.eventId,
      authorityDecisionId: input.authorityDecisionId,
      epochs: {
        routingEpoch: BigInt(input.routingEpoch),
        authorityEpoch: BigInt(input.authorityEpoch),
      },
      expectedProjectionRevision: BigInt(input.expectedProjectionRevision),
      issuedAt: input.issuedAt,
    },
  };
}

function assertContextScope(context: TrustedContext, scope: RuntimeScope): void {
  if (
    context.tenantId !== scope.tenantId ||
    context.worldId !== scope.worldId ||
    context.timelineId !== scope.timelineId ||
    context.spaceId !== scope.spaceId
  ) {
    throw new Error("authenticated context scope does not match the requested route");
  }
}

function encodeNoOpResponse(result: NoOpResponse): Record<string, unknown> {
  return { ...result };
}

/** An observation read's own request ID and its caller's correlation, never a command identity. */
function readMetadata(correlationHeader: string | null) {
  return {
    requestId: crypto.randomUUID(),
    correlationId: decodeOpaqueId(correlationHeader ?? crypto.randomUUID(), "CorrelationId"),
  };
}

function isConversationRoute(path: string): path is ConversationRoute {
  return (CONVERSATION_ROUTES as readonly string[]).includes(path);
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A refusal answered with its stable code. */
function refusal(note: RequestNote, code: RuntimeResponseCode, status: number): Response {
  note.code = code;
  return jsonResponse({ error: code }, status);
}

/** A conflict, unavailability or server failure answered with its stable code and its class. */
function failure(
  note: RequestNote,
  error: unknown,
  code: RuntimeResponseCode,
  status: number,
  detail: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  note.code = code;
  note.failureClass = runtimeFailureClass(error) ?? "internal";
  return jsonResponse({ error: code, ...detail }, status, headers);
}

/** A world command's committed or rejected receipt, new or (`replayed`) stored. */
function worldResult(
  note: RequestNote,
  result: WorldCommandResult,
  replayed?: "replayed",
): Response {
  note.outcome = replayed ?? result.outcome;
  if (result.value.status === "committed") note.revision = result.value.revision;
  return jsonResponse(encodeCanonicalNode(result), worldResultStatus(result));
}

function worldResultStatus(result: WorldCommandResult): number {
  return result.outcome === "committed" ? 200 : result.value.status === "denied" ? 403 : 409;
}
