import {
  type BrowserScope,
  type ClientViewTrace,
  type ClientViewTraceRequest,
  COMMAND_RECEIPT_STATUSES,
  type CommandId,
  decodeClientViewTrace,
  decodeConversationList,
  decodeConversationSession,
  decodeConversationTranscript,
  decodeEntitySelection,
  decodeFollowDisposition,
  decodeInfluenceReceipt,
  decodeRecordedWhy,
  decodeSayReceipt,
  decodeTalkReceipt,
  decodeTalkStreamFrame,
  decodeTurnStatus,
  decodeWorldDirectory,
  decodeWorldReadiness,
  decodeWorldStatus,
  type EntitySelection,
  type EntitySelectionRequest,
  type EventId,
  type FollowDisposition,
  type InfluenceReceipt,
  type ObjectId,
  type RecordedWhy,
  type RecordedWhyEntry,
  type RecordedWhyRequest,
  type SayReceipt,
  type SpaceId,
  type TalkReceipt,
  TERMINAL_TURN_PHASES,
  type WorldDirectory,
  type WorldDirectoryEntry,
  type WorldReadiness,
  type WorldStatus,
} from "@clockgrove/contracts";
import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import {
  ApiRefusal,
  type BrowserAuthenticationPort,
  type BrowserSession,
  localSessionAuthentication,
} from "./api.js";
import { clientMeasurements, measure } from "./measurements.js";
import { SceneProjectionClient } from "./projection.js";
import {
  emptyScene,
  reduceSceneState,
  type SceneStateProjection,
  type SceneStateProjectionEvent,
  sameSceneScope,
} from "./scene-projection.js";
import {
  type DirectoryQueryKey,
  type EntityQueryKey,
  sceneProjectionKey,
  selectionProjection,
  type ViewTraceQueryKey,
  viewTraceProjection,
  type WhyQueryKey,
  whyProjection,
} from "./scene-queries.js";
import { browserSceneSocket, type SceneSocketFactory } from "./socket.js";

export type { SelectionProjection, ViewTraceProjection, WhyProjection } from "./scene-queries.js";

function answers(request: RecordedWhyRequest, value: RecordedWhy): boolean {
  const { entry } = value;
  if ("eventId" in request) return entry.kind === "event" && entry.eventId === request.eventId;
  if ("scheduleId" in request)
    return (
      entry.kind === "scheduled-action" &&
      entry.scheduleId === request.scheduleId &&
      entry.idempotencyKey === request.idempotencyKey
    );
  return entry.kind === "command" && value.commandId === request.commandId;
}

/** A transport or server failure decided nothing; a refusal is the server's answer. */
function outcomeOf(status: number, accepted: boolean): "accepted" | "refused" | "failed" {
  if (accepted) return "accepted";
  return status === 0 || status >= 500 ? "failed" : "refused";
}

type ConversationEndpoint =
  | "/v1/runtime/conversations/archive"
  | "/v1/runtime/conversations/create"
  | "/v1/runtime/conversations/delete"
  | "/v1/runtime/conversations/list"
  | "/v1/runtime/conversations/read"
  | "/v1/runtime/conversations/title"
  | "/v1/runtime/turns/status";

/**
 * Decision: up to 3 resends (4 attempts) of an interrupted Talk. An interruption means the owner was
 * lost, and a Durable Object's next incarnation takes the turn over at once, so the first resend
 * normally settles it; each attempt moves the turn past at least one checkpoint, so 3 covers losses
 * at successive phases. Only `503 turn_interrupted` or a stream without a final frame is resent;
 * after the last, the turn is left to the reopen path, which settles it from its durable status.
 */
const MAX_TALK_RESENDS = 3;

interface PendingTurn {
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
}
export type TurnSettled = { readonly reloaded: true };
/** Presentation callbacks of a turn; provisional text is never kept as truth. */
export interface TurnHooks {
  readonly onProvisional?: (text: string) => void;
  readonly onPhase?: (phase: string) => void;
}

const pendingKey = (sessionId: string) => `clockgrove.pending-turn.${sessionId}`;
function rememberPendingTurn(sessionId: string, turn: PendingTurn): void {
  try {
    sessionStorage.setItem(pendingKey(sessionId), JSON.stringify(turn));
  } catch {
    // Storage is a convenience for reconnecting; the durable turn does not depend on it.
  }
}
function forgetPendingTurn(sessionId: string): void {
  try {
    sessionStorage.removeItem(pendingKey(sessionId));
  } catch {
    // See rememberPendingTurn.
  }
}
function readPendingTurn(sessionId: string): PendingTurn | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(pendingKey(sessionId)) ?? "null",
    ) as Partial<PendingTurn> | null;
    return typeof value?.messageId === "string" && typeof value.text === "string"
      ? { sessionId, messageId: value.messageId, text: value.text }
      : undefined;
  } catch {
    return undefined;
  }
}

function tryDecode<T>(decode: (value: unknown) => T, value: unknown): T | undefined {
  try {
    return decode(value);
  } catch {
    return undefined;
  }
}

/** Coordinates authorized transport and transient intents; all read data/status live in Query. */
export class SceneSession {
  private intent = 0;
  private selectionIntent = 0;
  private whyIntent = 0;
  private signInIntent = 0;
  private navigationIntent = 0;
  // A followed entity to select again once the handed-over scene projects it.
  private following: { readonly intent: number; readonly objectId: ObjectId } | undefined;
  // The signed-in session, held only in memory after the runtime accepted its directory read.
  private account: BrowserSession | undefined;
  private directoryKey: DirectoryQueryKey = ["living-scene", "directory", 0];
  private directoryObserver: QueryObserver<WorldDirectory> | undefined;
  private credential: string | undefined;
  private selected: ObjectId | undefined;
  private entry: RecordedWhyEntry | undefined;
  private viewIntent = 0;
  private viewOpen = false;
  private viewKey: ViewTraceQueryKey = ["living-scene", "view-trace", 0, undefined, 0, false];
  private viewObserver: QueryObserver<ClientViewTrace> | undefined;
  private selectionKey: EntityQueryKey = [
    "living-scene",
    "entity",
    0,
    undefined,
    0,
    undefined,
    undefined,
  ];
  private whyKey: WhyQueryKey = ["living-scene", "why", 0, undefined, 0, undefined, 0, undefined];
  private observation: SceneProjectionClient | undefined;
  private retirement: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private publishing = false;
  readonly queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // Active observers retain only current queries, including for non-React consumers.
  private readonly projectionObserver = new QueryObserver(this.queries, {
    queryKey: sceneProjectionKey,
    queryFn: skipToken,
    initialData: emptyScene,
  });
  private selectionObserver: QueryObserver<EntitySelection> | undefined;
  private whyObserver: QueryObserver<RecordedWhy> | undefined;
  constructor(
    private readonly origin: string,
    private readonly resetView: () => void,
    private readonly openScene: SceneSocketFactory = (scope, credential) =>
      browserSceneSocket(scope, credential, origin),
    private readonly authentication: BrowserAuthenticationPort = localSessionAuthentication,
    private readonly reselectView: (objectId: ObjectId) => void = () => undefined,
    private readonly resetViewed: () => void = () => undefined,
  ) {
    this.projectionObserver.subscribe(() => this.notify());
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify(): void {
    if (this.publishing) return;
    for (const listener of this.listeners) listener();
  }
  readonly getSnapshot = (): SceneStateProjection =>
    this.queries.getQueryData<SceneStateProjection>(sceneProjectionKey) ?? emptyScene;
  readonly getDirectoryKey = (): DirectoryQueryKey => this.directoryKey;
  readonly getSelectionKey = (): EntityQueryKey => this.selectionKey;
  readonly getWhyKey = (): WhyQueryKey => this.whyKey;
  readonly getViewTraceKey = (): ViewTraceQueryKey => this.viewKey;
  /** The observation intent fences world-status results: a replaced observation changes it. */
  readonly getIntent = (): number => this.intent;
  /**
   * The observed space's canonical clock and material feed, under the scene's observe grant. A
   * refusal leaves the HUD unavailable; authorization loss is the scene socket's to report.
   */
  async readWorldStatus(
    intent: number,
    scope: BrowserScope,
    signal: AbortSignal,
  ): Promise<WorldStatus> {
    const credential = this.credential;
    if (intent !== this.intent || !credential) throw new ApiRefusal(409);
    return this.readObservation(
      "/v1/runtime/world-status",
      credential,
      scope,
      signal,
      decodeWorldStatus,
    );
  }
  /**
   * A routed world's readiness under the signed-in session. The runtime answers a world that is
   * not ready with 409 `world_not_ready` and its provisioning state; any other refusal is kept.
   */
  async readWorldReadiness(scope: BrowserScope, signal: AbortSignal): Promise<WorldReadiness> {
    const credential = this.account?.credential;
    if (!credential) throw new ApiRefusal(401);
    let response: Response;
    try {
      response = await fetch(new URL("/v1/runtime/world-readiness", this.origin), {
        method: "POST",
        signal,
        cache: "no-store",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, ...scope }),
      });
    } catch {
      measure("client_errors", "query");
      throw new ApiRefusal(503);
    }
    // A refusal (a world the principal may not observe, an expired session) is the arrival's
    // answer, not a client error: it is returned unmeasured, as the directory's refusal is.
    if (response.status !== 200 && response.status !== 409) throw new ApiRefusal(response.status);
    try {
      return decodeWorldReadiness(await response.json());
    } catch {
      measure("client_errors", "query");
      throw new ApiRefusal(503);
    }
  }
  /** Reads the directory again with the signed-in session, once a routed world became ready. */
  refreshDirectory(): void {
    const credential = this.account?.credential;
    if (!credential) return;
    void this.queries
      .fetchQuery({
        queryKey: this.directoryKey,
        queryFn: ({ signal }) =>
          this.readRuntime(
            "/v1/runtime/world-directory",
            credential,
            { version: 1 },
            signal,
            decodeWorldDirectory,
          ),
      })
      // A refusal is the directory query's displayed outcome.
      .catch(() => undefined);
  }
  readonly getSelectionSnapshot = () =>
    selectionProjection(
      this.selected,
      this.queries.getQueryState<EntitySelection>(this.selectionKey),
    );
  readonly getWhySnapshot = () =>
    whyProjection(this.entry, this.queries.getQueryState<RecordedWhy>(this.whyKey));
  readonly getViewTraceSnapshot = () =>
    viewTraceProjection(this.viewOpen, this.queries.getQueryState<ClientViewTrace>(this.viewKey));
  async inspectRecordedWhy(signal: AbortSignal): Promise<string> {
    const { scope } = this.getSnapshot();
    const credential = this.credential;
    const commandId = this.getWhySnapshot().value?.commandId;
    const intent = this.intent;
    const whyIntent = this.whyIntent;
    if (!scope || !credential || !commandId) return "Inspector unavailable.";
    const response = await fetch(new URL("/v1/runtime/causal-chain", this.origin), {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, ...scope, commandId }),
    });
    if (intent !== this.intent || whyIntent !== this.whyIntent) throw new ApiRefusal(409);
    if (response.status === 403)
      return "Inspector denied. This session lacks inspection authority.";
    if (!response.ok) return "Inspector unavailable.";
    const field = (node: unknown, key: string): unknown =>
      Array.isArray(node) && node.length === 2 && node[0] === "record" && Array.isArray(node[1])
        ? node[1].find(
            (pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair[0] === key,
          )?.[1]
        : undefined;
    const text = (node: unknown): string | undefined =>
      Array.isArray(node) &&
      node.length === 2 &&
      node[0] === "string" &&
      typeof node[1] === "string"
        ? node[1]
        : undefined;
    const receipt = field(await response.json(), "receipt");
    const id = text(field(receipt, "commandId"));
    const status = text(field(receipt, "status"));
    if (signal.aborted || intent !== this.intent || whyIntent !== this.whyIntent)
      throw new ApiRefusal(409);
    return id === commandId && COMMAND_RECEIPT_STATUSES.some((known) => known === status)
      ? `Inspector command ${id}: ${status}.`
      : "Inspector unavailable.";
  }

  explain(commandId: CommandId | undefined): void {
    const action = this.getSelectionSnapshot().value?.history.actions.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (commandId && action) measure("inspector_traversal", "command");
    this.trace(commandId && action ? { commandId } : undefined);
  }
  /**
   * Starts from a command the member's own conversation receipt names, whether or not the selected
   * entity's history lists it; the runtime still authorizes the read.
   */
  explainReceipt(commandId: CommandId): void {
    this.trace({ commandId });
  }
  /** Starts from an event the current world-status feed shows. */
  explainEvent(eventId: EventId): void {
    const feed = this.queries
      .getQueriesData<WorldStatus>({ queryKey: ["living-scene", "status", this.intent] })
      .flatMap(([, status]) => status?.feed ?? []);
    const listed = feed.some((item) => item.sourceEventIds.includes(eventId));
    if (listed) measure("inspector_traversal", "event");
    this.trace(listed ? { eventId } : undefined);
  }
  /** Starts from a schedule row the loaded Why lists. */
  explainSchedule(scheduleId: string, idempotencyKey: string): void {
    const listed = this.getWhySnapshot().value?.schedules.some(
      (row) => row.scheduleId === scheduleId && row.idempotencyKey === idempotencyKey,
    );
    if (listed) measure("inspector_traversal", "schedule");
    this.trace(listed ? { scheduleId, idempotencyKey } : undefined);
  }
  private trace(entry: RecordedWhyEntry | undefined): void {
    ++this.whyIntent;
    this.whyObserver?.destroy();
    this.whyObserver = undefined;
    void this.queries.cancelQueries({ queryKey: this.whyKey, exact: true });
    this.queries.removeQueries({ queryKey: this.whyKey, exact: true });
    const scope = this.getSnapshot().scope;
    this.entry = entry && this.credential && scope ? entry : undefined;
    this.whyKey = [
      "living-scene",
      "why",
      this.intent,
      scope,
      this.whyIntent,
      this.selected,
      this.selectionIntent,
      this.entry,
    ];
    if (this.entry && this.credential && scope) {
      this.whyObserver = new QueryObserver<RecordedWhy>(this.queries, {
        queryKey: this.whyKey,
        queryFn: skipToken,
      });
      this.whyObserver.subscribe(() => this.notify());
      void this.readWhy(this.whyIntent, this.intent, this.credential, {
        version: 1,
        ...scope,
        ...this.entry,
      });
    }
    this.notify();
  }
  /** The viewer's own view traced: the web joins with no interest beyond the viewed space. */
  traceView(open: boolean): void {
    if (open) measure("inspector_traversal", "view");
    ++this.viewIntent;
    this.viewObserver?.destroy();
    this.viewObserver = undefined;
    void this.queries.cancelQueries({ queryKey: this.viewKey, exact: true });
    this.queries.removeQueries({ queryKey: this.viewKey, exact: true });
    const scope = this.getSnapshot().scope;
    const credential = this.credential;
    this.viewOpen = open && credential !== undefined && scope !== undefined;
    this.viewKey = [
      "living-scene",
      "view-trace",
      this.intent,
      scope,
      this.viewIntent,
      this.viewOpen,
    ];
    if (this.viewOpen && credential && scope) {
      const { viewIntent, intent, viewKey } = this;
      const request: ClientViewTraceRequest = {
        version: 1,
        ...scope,
        interest: { selection: null, conversation: false, operator: false },
      };
      this.viewObserver = new QueryObserver<ClientViewTrace>(this.queries, {
        queryKey: viewKey,
        queryFn: skipToken,
      });
      this.viewObserver.subscribe(() => this.notify());
      void this.queries
        .fetchQuery({
          queryKey: viewKey,
          staleTime: 0,
          queryFn: ({ signal }) =>
            this.readObservation(
              "/v1/runtime/view-trace",
              credential,
              request,
              signal,
              decodeClientViewTrace,
            ),
        })
        .catch((error) => {
          if (viewIntent === this.viewIntent && intent === this.intent)
            this.refuseAuthorization(error);
        });
    }
    this.notify();
  }
  private async readRuntime<T>(
    endpoint:
      | "/v1/runtime/entity"
      | "/v1/runtime/view-trace"
      | "/v1/runtime/why"
      | "/v1/runtime/world-directory"
      | "/v1/runtime/world-status",
    credential: string,
    body: object,
    signal: AbortSignal,
    decode: (value: unknown) => T,
  ): Promise<T> {
    try {
      const response = await fetch(new URL(endpoint, this.origin), {
        method: "POST",
        signal,
        cache: "no-store",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new ApiRefusal(response.status);
      return decode(await response.json());
    } catch (error) {
      measure("client_errors", "query");
      // Query retains only public status, never transport or decoder diagnostics.
      throw new ApiRefusal(error instanceof ApiRefusal ? error.status : 503);
    }
  }
  private async readObservation<T extends BrowserScope>(
    endpoint:
      | "/v1/runtime/entity"
      | "/v1/runtime/view-trace"
      | "/v1/runtime/why"
      | "/v1/runtime/world-status",
    credential: string,
    request: BrowserScope,
    signal: AbortSignal,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const value = await this.readRuntime(
      endpoint,
      credential,
      { version: 1, ...request },
      signal,
      decode,
    );
    if (!sameSceneScope(request, value)) throw new ApiRefusal(403);
    return value;
  }
  /** Verifies the credential only through the runtime's directory read, once per sign-in. */
  async signIn(credential: string): Promise<void> {
    this.signOut();
    const intent = this.signInIntent;
    const queryKey = this.directoryKey;
    this.directoryObserver = new QueryObserver<WorldDirectory>(this.queries, {
      queryKey,
      queryFn: skipToken,
    });
    this.directoryObserver.subscribe(() => this.notify());
    try {
      await this.queries.fetchQuery({
        queryKey,
        staleTime: Number.POSITIVE_INFINITY,
        queryFn: async ({ signal }) => {
          const session = await this.authentication.signIn(credential);
          const directory = await this.readRuntime(
            "/v1/runtime/world-directory",
            session.credential,
            { version: 1 },
            signal,
            decodeWorldDirectory,
          );
          // Published with the directory, so an authorized entry always has its session.
          if (intent === this.signInIntent) this.account = session;
          return directory;
        },
      });
    } catch (error) {
      if (intent !== this.signInIntent) return;
      // A refusal is the directory query's displayed outcome; anything else propagates.
      if (!(error instanceof ApiRefusal)) throw error;
    }
  }
  private forget(): void {
    const intent = ++this.signInIntent;
    this.account = undefined;
    this.directoryObserver?.destroy();
    this.directoryObserver = undefined;
    void this.queries.cancelQueries({ queryKey: this.directoryKey, exact: true });
    this.queries.removeQueries({ queryKey: this.directoryKey, exact: true });
    this.directoryKey = ["living-scene", "directory", intent];
    this.notify();
  }
  /** Discards the session and its directory, retiring observation, selection and Why. */
  signOut(): void {
    this.forget();
    if (this.getSnapshot().status !== "signed out") this.replace(undefined, undefined);
  }
  /** Observes a directory entry with the signed-in session, or retires observation. */
  open(entry: WorldDirectoryEntry | undefined): void {
    const credential = this.account?.credential;
    if (entry && credential) {
      const { tenantId, worldId, timelineId, spaceId } = entry;
      this.replace(credential, { tenantId, worldId, timelineId, spaceId });
    } else if (this.getSnapshot().scope) this.replace(undefined, undefined);
  }
  private async readWhy(
    whyIntent: number,
    intent: number,
    credential: string,
    request: RecordedWhyRequest,
  ): Promise<void> {
    try {
      await this.queries.fetchQuery({
        queryKey: this.whyKey,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          const expandedRequest: RecordedWhyRequest = { ...request, includeResourceCauses: true };
          const value = await this.readObservation(
            "/v1/runtime/why",
            credential,
            expandedRequest,
            signal,
            decodeRecordedWhy,
          );
          if (!answers(request, value)) throw new ApiRefusal(403);
          return value;
        },
      });
    } catch (error) {
      if (whyIntent !== this.whyIntent || intent !== this.intent) return;
      this.refuseAuthorization(error);
    }
  }
  /**
   * Asks the runtime to change the viewed space; the answer is dropped once scope or navigation
   * moved on. A transport or server failure is "failed", not a disposition: the server decided
   * nothing, so the selection stays.
   */
  async changeViewedSpace(
    targetSpaceId: SpaceId,
  ): Promise<FollowDisposition | "changed" | "failed" | undefined> {
    const scope = this.getSnapshot().scope;
    const credential = this.credential;
    if (!scope || !credential) return undefined;
    const intent = this.intent;
    const navigation = ++this.navigationIntent;
    const selected = this.selected;
    const stale = () => intent !== this.intent || navigation !== this.navigationIntent;
    let response: Response;
    try {
      response = await fetch(new URL("/v1/runtime/viewed-space", this.origin), {
        method: "POST",
        cache: "no-store",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "change_viewed_space",
          requestId: crypto.randomUUID(),
          scope,
          targetSpaceId,
          ...(selected ? { selectedEntityId: selected } : {}),
        }),
      });
    } catch {
      return stale() ? undefined : "failed";
    }
    if (stale()) return undefined;
    if (response.status === 401 || response.status === 403) {
      this.refuseAuthorization(new ApiRefusal(response.status));
      return undefined;
    }
    if (response.status === 204) return "changed";
    let disposition: FollowDisposition;
    try {
      if (response.status !== 200) throw new ApiRefusal(response.status);
      disposition = decodeFollowDisposition(await response.json());
    } catch {
      return stale() ? undefined : "failed";
    }
    if (stale()) return undefined;
    if (
      disposition.disposition === "followed" ||
      disposition.disposition === "stayed_within_space"
    ) {
      if (disposition.disposition === "followed" && !sameSceneScope(disposition.scope, scope)) {
        this.replace(credential, disposition.scope);
        this.following = { intent: this.intent, objectId: disposition.selectedEntityId };
      }
      return disposition;
    }
    this.dropSelection();
    return disposition;
  }
  /**
   * Offers one unit of a resource as a typed Influence intent. The server resolves attribution; a
   * rejected receipt is still a receipt, while a body that is not one means refusal before intent.
   */
  async influence(
    objectId: ObjectId,
    resourceKind: string,
  ): Promise<InfluenceReceipt | { readonly refused: string }> {
    const answer = await this.postInteraction("/v1/runtime/influence", {
      intentId: crypto.randomUUID(),
      objectId,
      // The intent is proposed against the revision this observer saw.
      expectedRevision: this.getSnapshot().projection?.revision.toString(),
      resourceKind,
    });
    const receipt =
      answer.body === undefined ? undefined : tryDecode(decodeInfluenceReceipt, answer.body);
    measure("interaction_outcome", outcomeOf(answer.status, receipt?.status === "committed"));
    if (!receipt) return { refused: answer.refused };
    if (receipt.status === "committed") this.refreshSelection();
    return receipt;
  }
  /** An explicit public line: the only way an actor speaks aloud. */
  async say(actorId: ObjectId, text: string): Promise<SayReceipt | { readonly refused: string }> {
    const answer = await this.postInteraction("/v1/runtime/say", {
      messageId: crypto.randomUUID(),
      actorId,
      text,
    });
    const receipt =
      answer.status === 200 && answer.body !== undefined
        ? tryDecode(decodeSayReceipt, answer.body)
        : undefined;
    measure("interaction_outcome", outcomeOf(answer.status, receipt !== undefined));
    return receipt ?? { refused: answer.refused };
  }
  /**
   * A private message in a stored session; the answer is part of its durable transcript. Streamed
   * deltas are only shown through `hooks`; a stream that ends early is settled from the durable
   * turn status and resumed by resending the same message ID, never from the tokens.
   */
  talk(
    sessionId: string,
    text: string,
    hooks: TurnHooks = {},
  ): Promise<TalkReceipt | TurnSettled | { readonly refused: string }> {
    return this.runTurn({ sessionId, messageId: crypto.randomUUID(), text }, hooks, false);
  }
  /** Settles the turn this browser remembers for a session, if any (a reload mid-turn). */
  async resumeTurn(
    sessionId: string,
    hooks: TurnHooks = {},
  ): Promise<TurnSettled | { readonly refused: string } | undefined> {
    const pending = readPendingTurn(sessionId);
    if (!pending) return undefined;
    const status = await this.turnStatus(sessionId, pending.messageId);
    if ("refused" in status) {
      if (status.refused !== "turn_not_found") return status;
      // Status can overtake the initial send before its durable turn is accepted.
      const result = await this.runTurn(pending, hooks, true);
      return "refused" in result ? result : { reloaded: true };
    }
    if (status.phase === "completed") {
      forgetPendingTurn(sessionId);
      return { reloaded: true };
    }
    if (TERMINAL_TURN_PHASES.includes(status.phase)) {
      forgetPendingTurn(sessionId);
      return {
        refused: `Reply ${status.phase}${status.outcomeCode ? `: ${status.outcomeCode}` : ""}`,
      };
    }
    hooks.onPhase?.(status.phase);
    const result = await this.runTurn(pending, hooks, true);
    return "refused" in result ? result : { reloaded: true };
  }
  /** Whether this tab left a turn of the session in flight (a reload mid-turn). */
  hasPendingTurn(sessionId: string): boolean {
    return readPendingTurn(sessionId) !== undefined;
  }
  turnStatus(sessionId: string, messageId: string) {
    return this.conversationCall(
      "/v1/runtime/turns/status",
      { sessionId, messageId },
      decodeTurnStatus,
    );
  }
  private async runTurn(
    turn: PendingTurn,
    hooks: TurnHooks,
    recovered: boolean,
  ): Promise<TalkReceipt | TurnSettled | { readonly refused: string }> {
    rememberPendingTurn(turn.sessionId, turn);
    let resumed = recovered;
    for (let resend = 0; resend <= MAX_TALK_RESENDS; ++resend) {
      let provisional = "";
      const outcome = await this.streamTalk(turn, (delta) => {
        provisional += delta;
        hooks.onProvisional?.(provisional);
      });
      hooks.onProvisional?.("");
      if (outcome.kind !== "interrupted") {
        forgetPendingTurn(turn.sessionId);
        measure("interaction_outcome", outcomeOf(outcome.status, outcome.kind === "receipt"));
        if (outcome.kind === "refused") return { refused: outcome.error };
        return resumed ? { reloaded: true } : outcome.receipt;
      }
      resumed = true;
      const status = await this.turnStatus(turn.sessionId, turn.messageId);
      if (!("refused" in status)) {
        hooks.onPhase?.(status.phase);
        if (status.phase === "completed") {
          forgetPendingTurn(turn.sessionId);
          return { reloaded: true };
        }
        if (TERMINAL_TURN_PHASES.includes(status.phase)) {
          forgetPendingTurn(turn.sessionId);
          return { refused: status.outcomeCode ?? status.phase };
        }
      }
    }
    return { refused: "reply interrupted; it will resume when the conversation is reopened" };
  }
  private async streamTalk(
    turn: PendingTurn,
    onDelta: (text: string) => void,
  ): Promise<
    | { kind: "receipt"; status: number; receipt: TalkReceipt }
    | { kind: "refused"; status: number; error: string }
    | { kind: "interrupted" }
  > {
    const scope = this.getSnapshot().scope;
    const credential = this.credential;
    if (!scope || !credential) return { kind: "refused", status: 0, error: "not signed in" };
    const intent = this.intent;
    try {
      const response = await fetch(new URL("/v1/runtime/talk", this.origin), {
        method: "POST",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ version: 1, ...scope, ...turn }),
      });
      if (intent === this.intent && response.status === 401)
        this.refuseAuthorization(new ApiRefusal(401));
      if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
        const json: unknown = await response.json().catch(() => undefined);
        const receipt = response.status === 200 ? tryDecode(decodeTalkReceipt, json) : undefined;
        if (receipt) return { kind: "receipt", status: 200, receipt };
        const error = (json as { error?: unknown } | undefined)?.error;
        if (error === "turn_interrupted") return { kind: "interrupted" };
        return {
          kind: "refused",
          status: response.status,
          error: typeof error === "string" ? error : `status ${response.status}`,
        };
      }
      const reader = response.body?.getReader();
      if (!reader) return { kind: "interrupted" };
      const decoder = new TextDecoder();
      let buffered = "";
      const read = (line: string) => {
        const frame = tryDecode(
          (value) => decodeTalkStreamFrame(value),
          (() => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          })(),
        );
        if (frame?.type === "delta") onDelta(frame.text);
        return frame;
      };
      for (;;) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const frame = line.trim() ? read(line) : undefined;
          if (frame?.type === "receipt")
            return { kind: "receipt", status: 200, receipt: frame.receipt };
          if (frame?.type === "refused")
            return { kind: "refused", status: frame.status, error: frame.error };
        }
        if (done) return { kind: "interrupted" };
      }
    } catch {
      return { kind: "interrupted" };
    }
  }
  private async conversationCall<T>(
    endpoint: ConversationEndpoint,
    body: object,
    decode: (value: unknown) => T,
  ): Promise<T | { readonly refused: string }> {
    const answer = await this.postInteraction(endpoint, body);
    const value =
      answer.status === 200 && answer.body !== undefined
        ? tryDecode(decode, answer.body)
        : undefined;
    return value ?? { refused: answer.refused };
  }
  listConversations(actorId: ObjectId) {
    return this.conversationCall(
      "/v1/runtime/conversations/list",
      { actorId },
      decodeConversationList,
    );
  }
  createConversation(actorId: ObjectId, title?: string) {
    return this.conversationCall(
      "/v1/runtime/conversations/create",
      { actorId, ...(title ? { title } : {}) },
      decodeConversationSession,
    );
  }
  readConversation(sessionId: string, afterSequence?: number) {
    return this.conversationCall(
      "/v1/runtime/conversations/read",
      { sessionId, ...(afterSequence ? { afterSequence } : {}) },
      decodeConversationTranscript,
    );
  }
  titleConversation(sessionId: string, title: string) {
    return this.conversationCall(
      "/v1/runtime/conversations/title",
      { sessionId, title },
      decodeConversationSession,
    );
  }
  archiveConversation(sessionId: string, archived: boolean) {
    return this.conversationCall(
      "/v1/runtime/conversations/archive",
      { sessionId, archived },
      decodeConversationSession,
    );
  }
  async deleteConversation(sessionId: string): Promise<true | { readonly refused: string }> {
    const result = await this.conversationCall(
      "/v1/runtime/conversations/delete",
      { sessionId },
      (value) => {
        if ((value as { deleted?: unknown } | null)?.deleted !== true)
          throw new Error("not deleted");
        return true as const;
      },
    );
    return result;
  }
  private async postInteraction(
    endpoint:
      | "/v1/runtime/influence"
      | "/v1/runtime/say"
      | "/v1/runtime/talk"
      | ConversationEndpoint,
    body: object,
  ): Promise<{ status: number; body: unknown; refused: string }> {
    const scope = this.getSnapshot().scope;
    const credential = this.credential;
    if (!scope || !credential) return { status: 0, body: undefined, refused: "not signed in" };
    const intent = this.intent;
    try {
      const response = await fetch(new URL(endpoint, this.origin), {
        method: "POST",
        cache: "no-store",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, ...scope, ...body }),
      });
      const json: unknown = await response.json().catch(() => undefined);
      if (intent === this.intent && response.status === 401)
        this.refuseAuthorization(new ApiRefusal(401));
      const error = (json as { error?: unknown } | undefined)?.error;
      return {
        status: response.status,
        body: json,
        refused: typeof error === "string" ? error : `status ${response.status}`,
      };
    } catch {
      return { status: 0, body: undefined, refused: "runtime unavailable" };
    }
  }
  private dropSelection(): void {
    this.select(undefined);
    this.resetView();
  }
  private refuseAuthorization(error: unknown): void {
    // Other failures remain in the query that owns them for the panel to display.
    if (error instanceof ApiRefusal && (error.status === 401 || error.status === 403))
      this.revoke();
  }
  private revoke(): void {
    this.forget();
    this.replace(undefined, undefined, true);
  }
  select(objectId: ObjectId | undefined): void {
    this.startSelection(objectId);
  }
  private startSelection(
    objectId: ObjectId | undefined,
    cursor?: EntitySelectionRequest["cursor"],
  ): void {
    // A Why opened from the feed or a schedule row is not the selection's: choosing an entity keeps
    // it, while clearing the selection (retirement, world change, sign-out) discards every Why.
    if (objectId === undefined || this.entry === undefined || "commandId" in this.entry)
      this.explain(undefined);
    ++this.selectionIntent;
    this.selectionObserver?.destroy();
    this.selectionObserver = undefined;
    void this.queries.cancelQueries({ queryKey: this.selectionKey, exact: true });
    this.queries.removeQueries({ queryKey: this.selectionKey, exact: true });
    const state = this.getSnapshot();
    const projectable = state.scene?.entities.some((entity) => entity.objectId === objectId);
    this.selected =
      objectId && projectable && this.credential && state.scope ? objectId : undefined;
    this.selectionKey = [
      "living-scene",
      "entity",
      this.intent,
      state.scope,
      this.selectionIntent,
      this.selected,
      cursor,
    ];
    if (this.selected && this.credential && state.scope) {
      this.selectionObserver = new QueryObserver<EntitySelection>(this.queries, {
        queryKey: this.selectionKey,
        queryFn: skipToken,
      });
      this.selectionObserver.subscribe(() => this.notify());
      void this.readSelection(this.selectionIntent, this.intent, this.credential, {
        version: 1,
        ...state.scope,
        objectId: this.selected,
        ...(cursor ? { cursor } : {}),
      });
    }
    this.notify();
  }
  refreshSelection(): void {
    this.select(this.selected);
  }
  earlierActions(): void {
    const value = this.getSelectionSnapshot().value;
    if (!value || value.history.beforeSequence === null) return;
    this.startSelection(value.objectId, {
      observedRevision: value.history.observedRevision,
      beforeSequence: value.history.beforeSequence,
    });
  }
  /**
   * Opens Why on the entity's newest recorded `routine.selected`, paging back through its history
   * from the loaded page until one is found or the history ends. Answers whether one was found.
   */
  async explainNewestDecision(selection: EntitySelection): Promise<boolean> {
    const scope = this.getSnapshot().scope;
    const credential = this.credential;
    const intent = this.intent;
    const selectionIntent = this.selectionIntent;
    let page = selection;
    for (;;) {
      const decision = page.history.actions.find((action) => action.type === "routine.selected");
      if (decision) {
        // A superseded selection or world opens nothing.
        if (intent !== this.intent || selectionIntent !== this.selectionIntent) return false;
        this.trace({ commandId: decision.commandId });
        return true;
      }
      if (page.history.beforeSequence === null || !scope || !credential) return false;
      page = await this.readObservation(
        "/v1/runtime/entity",
        credential,
        {
          ...scope,
          objectId: selection.objectId,
          cursor: {
            observedRevision: page.history.observedRevision,
            beforeSequence: page.history.beforeSequence,
          },
        } as EntitySelectionRequest,
        new AbortController().signal,
        decodeEntitySelection,
      );
    }
  }
  private async readSelection(
    selectionIntent: number,
    intent: number,
    credential: string,
    request: EntitySelectionRequest,
  ): Promise<void> {
    try {
      await this.queries.fetchQuery({
        queryKey: this.selectionKey,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          const value = await this.readObservation(
            "/v1/runtime/entity",
            credential,
            request,
            signal,
            decodeEntitySelection,
          );
          if (value.objectId !== request.objectId) throw new ApiRefusal(403);
          return value;
        },
      });
    } catch (error) {
      if (selectionIntent !== this.selectionIntent || intent !== this.intent) return;
      this.refuseAuthorization(error);
    }
  }
  private dispatch(event: SceneStateProjectionEvent): void {
    const state = this.getSnapshot();
    const next = reduceSceneState(state, event);
    if (next === state) return;
    // Subscribers see projection invalidation together with dependent read retirement.
    this.publishing = true;
    try {
      if (
        this.selected &&
        !next.scene?.entities.some((entity) => entity.objectId === this.selected)
      ) {
        this.select(undefined);
        this.resetView();
      }
      this.queries.setQueryData(sceneProjectionKey, next);
    } finally {
      this.publishing = false;
    }
    this.notify();
    const following = this.following;
    if (
      following?.intent === this.intent &&
      next.scene?.entities.some((entity) => entity.objectId === following.objectId)
    ) {
      this.following = undefined;
      this.reselectView(following.objectId);
    }
  }
  replace(credential: string | undefined, scope: BrowserScope | undefined, denied = false): void {
    const intent = ++this.intent;
    this.following = undefined;
    this.credential = credential;
    this.traceView(false);
    this.select(undefined);
    const observation = this.observation;
    this.observation = undefined;
    if (observation) this.retirement = observation.disconnect();
    this.resetView();
    this.resetViewed();
    this.dispatch({ type: "replace", intent, scope: credential ? scope : undefined, denied });
    if (credential && scope) void this.observe(intent, credential, scope);
  }
  private async observe(intent: number, credential: string, scope: BrowserScope): Promise<void> {
    try {
      await this.retirement;
      if (intent !== this.intent) return;
      clientMeasurements.setWorld({ worldId: scope.worldId });
      const observation = new SceneProjectionClient(
        scope,
        () => this.openScene(scope, credential),
        (status, scene, projection) => {
          if (intent !== this.intent) return;
          if (status === "authorization_lost") this.revoke();
          else if (status === "ready" && scene)
            this.dispatch({ type: "snapshot", intent, scene, projection });
          else if (status === "recovering")
            this.dispatch({ type: "recovering", intent, scene, projection });
          else {
            this.select(undefined);
            this.resetView();
            this.resetViewed();
            this.dispatch(
              status === "connecting"
                ? { type: "connecting", intent }
                : status === "ready" || status === "unavailable"
                  ? { type: "failure", intent }
                  : { type: "incompatible", intent, code: status },
            );
          }
        },
      );
      this.observation = observation;
      await observation.connect();
    } catch {
      if (intent !== this.intent) return;
      this.select(undefined);
      this.resetView();
      this.resetViewed();
      this.dispatch({ type: "failure", intent });
    }
  }
}
