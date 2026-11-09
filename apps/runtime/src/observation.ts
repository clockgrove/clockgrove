import {
  AuthorizationRefusedError,
  decodeCanonicalNode,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  JournalReadIntegrityError,
  JournalRouteNotFoundError,
  PartitionStateIntegrityError,
  type RuntimeAuthorizationContext,
  type StoredEvent,
} from "@clockgrove/application";
import {
  type BrowserScope,
  type ChangeViewedSpace,
  decodeOpaqueId,
  decodeScenePatch,
  decodeSceneProjection,
  type EntitySelection,
  type EntitySelectionRequest,
  type FollowDisposition,
  isSharedSceneEligible,
  type LivingScene,
  type LivingSpatialFrame,
  type ObjectId,
  PRIVACY_CATEGORIES,
  type PrincipalId,
  SCENE_ASSET_MANIFEST_VERSION,
  SCENE_CLIENT_VERSION,
  SCENE_PROJECTION_VERSION,
  type SceneConnectionAttachment,
  SELECTION_EVIDENCE,
  type SelectionNeeds,
  type SelectionPlant,
  type SelectionWellbeing,
  type WorldDirectory,
  type WorldFeedCategory,
  type WorldStatus,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import type { WorldState } from "@clockgrove/domain";
import {
  type HydratedWorldOwner,
  type PostgreSqlClient,
  PostgreSqlJournalRangeSource,
  PostgreSqlObjectHistoryReader,
  PostgreSqlWorldDirectoryReader,
  PostgreSqlWorldOwnerReader,
} from "@clockgrove/persistence";
import { OBSERVE_GRANT } from "./inspector.js";
import { interactionsOf } from "./interactions.js";
import {
  decideSceneAudience,
  privateCognitionOf,
  type SceneAuthorityFacts,
} from "./scene-audience.js";
import { type SceneReadResult, scenePatchOperations } from "./scene-delivery.js";
import {
  connectionScopeOf,
  followDispositionOf,
  isNestedTarget,
  sceneHierarchyOf,
} from "./scene-navigation.js";
import {
  materialSceneLighting,
  type ScenePresentationInput,
  sceneEffects,
  scenePresentationBindings,
} from "./scene-presentation.js";
import { assertWorldCommandContext, PostgreSqlCommandOwner } from "./world-commands.js";

/** Request-owned current-state reads. This projection never copies a world document to the wire. */
export class PostgreSqlLivingSceneReader {
  constructor(private readonly reader: PostgreSqlWorldOwnerReader) {}

  async observe(scope: BrowserScope, context: TrustedExecutionContext): Promise<LivingScene> {
    return (await this.observeCanonical(scope, context)).scene;
  }

  async observeCanonical(
    scope: BrowserScope,
    context: TrustedExecutionContext,
  ): Promise<{
    scene: LivingScene;
    stored: HydratedWorldOwner;
    authorization: RuntimeAuthorizationContext;
  }> {
    const { stored, authorization } = await this.hydrateObserved(scope, context);
    return { scene: livingSceneOf(scope, stored.document.state), stored, authorization };
  }

  /** The scene's authority: the observe grant for `scope` and a public-scene privacy ceiling. */
  async hydrateObserved(
    scope: BrowserScope,
    context: TrustedExecutionContext,
  ): Promise<{ stored: HydratedWorldOwner; authorization: RuntimeAuthorizationContext }> {
    assertWorldCommandContext(context, scope, OBSERVE_GRANT);
    if (!context.privacyCeiling.allowedCategories.includes("public_scene"))
      throw new AuthorizationRefusedError("public scene refused");
    const authorization = {
      tenantId: context.tenantId,
      principalId: context.principalId,
      privacyCeiling: { version: 1 as const, allowedCategories: ["public_scene" as const] },
    };
    if (!(await this.reader.isReady(authorization, scope)))
      throw new JournalRouteNotFoundError(scope.spaceId);
    return { stored: await this.reader.hydrate(authorization, scope), authorization };
  }
}

/** Each material journal event type's feed category and plain-words text; no other type is fed. */
const MATERIAL_EVENTS: ReadonlyMap<string, readonly [WorldFeedCategory, string]> = new Map<
  string,
  readonly [WorldFeedCategory, string]
>([
  ["weather.changed", ["weather", "The weather changed."]],
  ["weather.transitioned", ["weather", "The weather turned."]],
  ["environment.phase-changed", ["weather", "The time of day changed."]],
  ["routine.selected", ["routine", "A new routine was chosen."]],
  ["needs.threshold-crossed", ["wellbeing", "A need crossed a threshold."]],
  ["exposure.threshold-crossed", ["wellbeing", "Exposure to the weather crossed a threshold."]],
  ["health.threshold-crossed", ["wellbeing", "Health crossed a threshold."]],
  ["growth.stage-changed", ["growth", "A plant reached a new growth stage."]],
  ["movement.portal-crossed", ["movement", "A journey passed through a portal."]],
  ["movement.completed", ["movement", "A journey ended."]],
  ["portal.opened", ["portal", "A portal opened."]],
  ["portal.closed", ["portal", "A portal closed."]],
  ["resource.offered", ["resource", "A resource was offered."]],
  ["resource.consumed", ["resource", "A resource was consumed."]],
  ["resource.transferred", ["resource", "A resource changed hands."]],
  ["resource.spoiled", ["resource", "Food spoiled."]],
]);

/** The kernel event's payload fields of a world-command journal event, when it has them. */
function kernelPayloadOf(event: StoredEvent): object | undefined {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    !("kernelEvent" in event.payload)
  )
    return undefined;
  const kernel = decodeCanonicalNode(event.payload.kernelEvent);
  if (typeof kernel !== "object" || kernel === null || !("payload" in kernel)) return undefined;
  const payload = kernel.payload;
  return typeof payload === "object" && payload !== null ? payload : undefined;
}

/**
 * A plain sentence from the event's public payload fields, naming each entity by `nameOf` (its
 * scene label); the fixed `fallback` when the fields lack what it needs.
 */
function feedSentence(
  type: string,
  payload: object | undefined,
  fallback: string,
  nameOf: (objectId: string) => string,
): string {
  const field = (name: string): unknown =>
    payload !== undefined && name in payload
      ? (payload as Record<string, unknown>)[name]
      : undefined;
  const str = (name: string): string | undefined => {
    const value = field(name);
    return typeof value === "string" ? value : undefined;
  };
  const named = (name: string): string | undefined => {
    const id = str(name);
    return id === undefined ? undefined : nameOf(id);
  };
  const who = named("objectId");
  const kind = str("kind");
  const Kind = kind === undefined ? undefined : kind.charAt(0).toUpperCase() + kind.slice(1);
  const entered = field("direction") === "entered";
  const sentence = ((): string | undefined => {
    switch (type) {
      case "weather.transitioned":
        return {
          began: "It started raining.",
          ended: "The rain stopped.",
          changed: "The rain changed.",
          unchanged: "The weather turned.",
        }[str("rainChange") ?? ""];
      case "weather.changed": {
        const rain = field("rainIntensity");
        return typeof rain === "number" ? (rain > 0 ? "It is raining." : "It is dry.") : undefined;
      }
      case "environment.phase-changed":
        return str("phase") === undefined ? undefined : `It is now ${str("phase")}.`;
      case "routine.selected": {
        const action = field("action");
        if (who === undefined || typeof action !== "object" || action === null) return undefined;
        const { kind: actionKind, targetObjectId } = action as Record<string, unknown>;
        const what = { "seek-food": "food", "seek-water": "water", "seek-shelter": "shelter" }[
          String(actionKind)
        ];
        if (actionKind === "stay") return `${who} is staying put.`;
        if (what === undefined) return undefined;
        return `${who} is looking for ${what}${typeof targetObjectId === "string" ? ` at ${nameOf(targetObjectId)}` : ""}.`;
      }
      case "needs.threshold-crossed": {
        const word = { hunger: "hungry", thirst: "thirsty" }[str("need") ?? ""];
        return who === undefined || word === undefined ? undefined : `${who} is ${word}.`;
      }
      case "exposure.threshold-crossed": {
        const threshold = str("threshold");
        if (who === undefined || (threshold !== "wet" && threshold !== "uncomfortable"))
          return undefined;
        if (threshold === "wet") return entered ? `${who} got wet.` : `${who} dried off.`;
        return entered ? `${who} is uncomfortable in the weather.` : `${who} is comfortable again.`;
      }
      case "health.threshold-crossed":
        return who === undefined
          ? undefined
          : entered
            ? `${who}'s health is critical.`
            : `${who} is recovering.`;
      case "growth.stage-changed":
        return who === undefined || str("stageName") === undefined
          ? undefined
          : `${who} reached its ${str("stageName")} stage.`;
      case "movement.completed":
        return who === undefined ? undefined : `${who} arrived.`;
      case "movement.portal-crossed":
        return who === undefined || named("portalId") === undefined
          ? undefined
          : `${who} went through ${named("portalId")}.`;
      case "portal.opened":
      case "portal.closed":
        return named("portalId") === undefined
          ? undefined
          : `${named("portalId")} ${type === "portal.opened" ? "opened" : "closed"}.`;
      case "resource.offered":
        return who === undefined || Kind === undefined
          ? undefined
          : `${Kind} was offered at ${who}.`;
      case "resource.consumed":
        return who === undefined || Kind === undefined ? undefined : `${Kind} at ${who} was used.`;
      case "resource.transferred":
        return named("fromObjectId") === undefined ||
          named("toObjectId") === undefined ||
          Kind === undefined
          ? undefined
          : `${Kind} moved from ${named("fromObjectId")} to ${named("toObjectId")}.`;
      case "resource.spoiled":
        return who === undefined ? undefined : `Food at ${who} spoiled.`;
      default:
        return undefined;
    }
  })();
  return sentence ?? fallback;
}

/** The single entity an event concerns: its actor or object, else the portal; null otherwise. */
function concernedObjectId(event: StoredEvent): ObjectId | null {
  const payload = kernelPayloadOf(event);
  const id =
    payload === undefined
      ? undefined
      : "objectId" in payload
        ? payload.objectId
        : "portalId" in payload
          ? payload.portalId
          : undefined;
  return typeof id === "string" ? decodeOpaqueId(id, "ObjectId") : null;
}

/**
 * The canonical clock and the recent material feed of one observed space, derived on read from
 * PostgreSQL under the scene's authority. Nothing is stored or cached.
 */
export class PostgreSqlWorldStatusReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async read(scope: BrowserScope, context: TrustedExecutionContext): Promise<WorldStatus> {
    const owner = new PostgreSqlCommandOwner(this.client);
    const { stored, authorization } = await new PostgreSqlLivingSceneReader(
      owner.reader,
    ).hydrateObserved(scope, context);
    const clock = stored.clockPolicy;
    if (clock === undefined) throw new PartitionStateIntegrityError("malformed-document");
    const { policy } = await owner.behavior(authorization, scope);
    const time = stored.document.state.simulationTime;
    const dayLength = policy.environment?.dayLengthMs;
    // Sentences name entities exactly as the scene labels them; an entity outside it by its id.
    const labels = new Map(
      livingSceneOf(scope, stored.document.state).entities.map((entity) => [
        entity.objectId as string,
        entity.presentation.label,
      ]),
    );
    const nameOf = (objectId: string): string => labels.get(objectId) ?? objectId;
    // The feed's bound is the history reader's own 100-sequence window before the covered head:
    // at most 100 items, newest first, with privacy-hidden sequences absent rather than refused.
    const recent = await new PostgreSqlObjectHistoryReader(this.client).read(
      authorization,
      { tenantId: scope.tenantId, timelineId: scope.timelineId, partitionId: stored.partitionId },
      stored.coveredHeadSequence + 1n,
    );
    return {
      version: 1,
      privacyClass: "public_scene",
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      spaceId: scope.spaceId,
      revision: stored.revision.toString(),
      clock: {
        simulationTime: time.toString(),
        runState: clock.running ? "running" : "paused",
        speed: clock.simulationMillisecondsPerWallMillisecond,
        dayLengthMs: dayLength === undefined ? null : dayLength.toString(),
        day: dayLength === undefined ? null : (time / dayLength + 1n).toString(),
        timeOfDayMs: dayLength === undefined ? null : (time % dayLength).toString(),
      },
      feed: recent.events.flatMap((event) => {
        const material = MATERIAL_EVENTS.get(event.type);
        if (material === undefined || !isSharedSceneEligible(event.privacyClass)) return [];
        return [
          {
            id: event.eventId,
            simTimeMs: event.simulationTime,
            kind: "material" as const,
            text: feedSentence(event.type, kernelPayloadOf(event), material[1], nameOf),
            sourceEventIds: [event.eventId],
            category: material[0],
            objectId: concernedObjectId(event),
          },
        ];
      }),
    };
  }
}

/**
 * The principal's observable scopes, labelled. No canonical record names a world or a space, so
 * each label is its identifier, as in the scene hierarchy.
 */
export async function readWorldDirectory(
  client: PostgreSqlClient,
  principalId: PrincipalId,
): Promise<WorldDirectory> {
  const scopes = await new PostgreSqlWorldDirectoryReader(client).observableScopes(principalId);
  return {
    version: 1,
    entries: scopes.map((scope) => ({
      ...scope,
      worldLabel: scope.worldId,
      spaceLabel: scope.spaceId,
    })),
  };
}

/** The scope's arrival readiness for the principal; undefined when the principal may not observe it. */
export function readWorldReadiness(
  client: PostgreSqlClient,
  principalId: PrincipalId,
  scope: BrowserScope,
) {
  return new PostgreSqlWorldDirectoryReader(client).readiness(principalId, scope);
}

/** The same public physical fields are used by HTTP observation and the scene stream. */
export function livingSceneOf(scope: BrowserScope, state: WorldState): LivingScene {
  const entities = state.entities.filter((entity) => entity.spaceId === scope.spaceId);
  // Include only referenced frames and their ancestors. Iteration is bounded by this snapshot.
  const needed = new Set(entities.map((entity) => entity.pose.frameId));
  const framesById = new Map(state.spatialFrames.map((frame) => [frame.frameId, frame]));
  for (const id of needed) {
    const parent = framesById.get(id)?.parentFrameId;
    if (parent !== undefined) needed.add(parent);
  }
  const frames: LivingSpatialFrame[] = state.spatialFrames
    .filter((frame) => needed.has(frame.frameId))
    .map((frame) => ({
      frameId: frame.frameId,
      version: frame.version,
      dimensions: frame.dimensions,
      unit: { name: frame.unit.name, fractionalDigits: frame.unit.fractionalDigits },
      axes: {
        axes: frame.axes.axes.map((axis) => ({
          name: axis.name,
          positiveDirection: axis.positiveDirection,
        })),
      },
      origin: frame.origin.map(String),
      gravity: { kind: "constant-vector", vector: frame.gravity.vector.map(String) },
      ...(frame.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
      ...(frame.parentTransform === undefined
        ? {}
        : {
            parentTransform: {
              version: frame.parentTransform.version,
              translation: frame.parentTransform.translation.map(String),
              basis: frame.parentTransform.basis.map((row) => row.map(String)),
            },
          }),
    }));
  return {
    version: 1,
    privacyClass: "public_scene",
    tenantId: scope.tenantId,
    worldId: scope.worldId,
    timelineId: scope.timelineId,
    spaceId: scope.spaceId,
    revision: state.revision.toString(),
    simulationTime: state.simulationTime.toString(),
    weather: { rainIntensity: state.weather.rainIntensity },
    frames,
    entities: entities.map((entity) => ({
      objectId: entity.objectId,
      archetypeId: entity.archetypeId,
      pose: {
        frameId: entity.pose.frameId,
        frameVersion: entity.pose.frameVersion,
        coordinates: entity.pose.coordinates.map(String),
      },
      presentation: { kind: "placeholder", label: entity.objectId },
    })),
  };
}

/** These events retain public entity/frame identities; replacement fields can safely backfill. */
const SCENE_BACKFILL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "time.advanced",
  "needs.changed",
  "weather.changed",
  "routine.selected",
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "wellbeing.integrated",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
  "needs.relieved",
  "growth.stage-changed",
  "growth.integrated",
  "location.changed",
  "movement.started",
  "movement.region-entered",
  "movement.region-exited",
  "movement.region-remained",
  "movement.portal-crossed",
  "movement.interrupted",
  "movement.replanned",
  "movement.completed",
  "portal.opened",
  "portal.closed",
  "resource.offered",
  "resource.consumed",
  "resource.transferred",
  "resource.spoiled",
]);

/** Request-owned PostgreSQL recovery; no patch cache or additional durable projection. */
export class PostgreSqlSceneStreamReader {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly presentations: readonly ScenePresentationInput[] = [],
  ) {}

  async read(
    attachment: SceneConnectionAttachment,
    fromRevision: bigint | null,
    context: TrustedExecutionContext,
    facts: SceneAuthorityFacts,
  ): Promise<SceneReadResult> {
    if (attachment.principalId !== context.principalId)
      throw new AuthorizationRefusedError("scene principal refused");
    const { scene, stored, authorization } = await new PostgreSqlLivingSceneReader(
      new PostgreSqlWorldOwnerReader(this.client),
    ).observeCanonical(attachment.audience, context);
    // Decided before serialization: the projection holds only what this audience allows.
    const decision = decideSceneAudience(stored.document.state, attachment.audience, facts);
    const audienceHash = decision.hash;
    const projected = new Set(scene.entities.map((entity) => entity.objectId));
    const privateCognition = privateCognitionOf(stored.document.state, decision, projected);
    const effects = sceneEffects(
      stored,
      stored.document.state,
      scene.frames,
      projected,
      this.presentations,
    );
    const lighting = materialSceneLighting(
      stored,
      this.presentations,
      BigInt(scene.simulationTime),
      scene.weather,
      effects,
    );
    const projection = decodeSceneProjection({
      tenantId: scene.tenantId,
      worldId: scene.worldId,
      timelineId: scene.timelineId,
      spaceId: scene.spaceId,
      privacyClass: scene.privacyClass,
      compatibility: {
        projectionVersion: SCENE_PROJECTION_VERSION,
        assetManifestVersion: SCENE_ASSET_MANIFEST_VERSION,
        clientVersion: SCENE_CLIENT_VERSION,
      },
      revision: BigInt(scene.revision),
      simulationTime: BigInt(scene.simulationTime),
      weather: scene.weather,
      ...(lighting === undefined ? {} : { lighting }),
      hierarchy: sceneHierarchyOf(scene.spaceId, stored.document.state),
      frames: scene.frames,
      entities: scene.entities,
      presentationBindings: scenePresentationBindings(
        stored,
        stored.document.state.entities,
        projected,
        this.presentations,
      ),
      interactions: interactionsOf(
        stored.document.state,
        projected,
        decision.descriptor.actions ?? { talk: false, influence: false },
      ),
      feedCursor: stored.coveredHeadSequence.toString(),
      audienceHash,
      ...(privateCognition === undefined ? {} : { privateCognition }),
      ...(effects.length === 0 ? {} : { effects }),
    });
    const snapshot = { projection, patch: null, authorityEpoch: stored.routingEpoch, decision };
    if (fromRevision === null || fromRevision < 0n || fromRevision >= projection.revision)
      return snapshot;
    const count = projection.revision - fromRevision;
    // Engineering decision: reuse issue 651's 64-item due-work input window (DUE_WORK_ADVANCE_BUDGET
    // was 64 until issue 931 lowered it to 16) as a conservative event recovery count. Larger lag uses
    // a snapshot, bounding indexed reads without imposing a durable retention cutoff or claiming a
    // measured network capacity.
    if (count > 64n) return snapshot;
    const fromSequence = stored.coveredHeadSequence - count + 1n;
    if (fromSequence < 1n) return snapshot;
    let events: StoredEvent[];
    try {
      events = await new JournalRangeReader(
        new PostgreSqlJournalRangeSource(this.client, authorization),
        JOURNAL_EVENT_REGISTRY,
      ).readPartition(
        {
          tenantId: scene.tenantId,
          timelineId: scene.timelineId,
          partitionId: stored.partitionId,
        },
        { from: fromSequence, to: stored.coveredHeadSequence },
      );
    } catch (error) {
      if (error instanceof JournalReadIntegrityError && error.reason === "sequence-gap")
        return snapshot;
      throw error;
    }
    // Replacement upserts cannot remove old topology. Unknown or topology-changing history
    // therefore requires a snapshot rather than guessing what that connection previously saw.
    if (
      BigInt(events.length) !== count ||
      events.some((event) => !SCENE_BACKFILL_EVENT_TYPES.has(event.type))
    )
      return snapshot;
    return {
      ...snapshot,
      patch: decodeScenePatch({
        fromRevision,
        toRevision: projection.revision,
        operations: scenePatchOperations(projection),
        sourceEventIds: events.map((event) => event.eventId),
        audienceHash,
      }),
    };
  }
}

/**
 * Request-owned decision of one viewed-space change. It reads canonical state and writes nothing;
 * a refusal never names the destination it refused. `authorize` authenticates a scope for the
 * observe grant and rejects with `AuthorizationRefusedError`; the request's own scope is asked first
 * and the target's only for another authority space. Null means success without a selection.
 */
export class PostgreSqlViewedSpaceReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async change(
    request: ChangeViewedSpace,
    authorize: (scope: BrowserScope) => Promise<TrustedExecutionContext>,
  ): Promise<FollowDisposition | null> {
    const refused = (disposition: "permission_denied" | "unavailable"): FollowDisposition => ({
      requestId: request.requestId,
      disposition,
      selectedEntityId: null,
    });
    const reader = new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(this.client));
    try {
      const context = await authorize(request.scope);
      const current = await reader.observeCanonical(request.scope, context);
      const nested = isNestedTarget(request, current.stored.document.state);
      const scope = connectionScopeOf(request, current.stored.document.state);
      const target = nested
        ? current
        : await reader.observeCanonical(scope, await authorize(scope));
      return followDispositionOf({
        request,
        scope,
        state: target.stored.document.state,
        ...(nested ? {} : { currentState: current.stored.document.state }),
        categories: PRIVACY_CATEGORIES.filter((category) =>
          context.privacyCeiling.allowedCategories.includes(category),
        ),
      });
    } catch (error) {
      if (error instanceof AuthorizationRefusedError) return refused("permission_denied");
      if (error instanceof JournalRouteNotFoundError) return refused("unavailable");
      throw error;
    }
  }
}

/** A selection may disappear or a continuation may cease to identify the current revision. */
export class EntitySelectionUnavailableError extends Error {}

/** Request-owned selected state, earned view and bounded authorized action windows. */
export class PostgreSqlEntitySelectionReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async select(
    input: EntitySelectionRequest,
    context: TrustedExecutionContext,
    wallTime: bigint,
  ): Promise<EntitySelection> {
    assertWorldCommandContext(context, input, OBSERVE_GRANT);
    if (!context.privacyCeiling.allowedCategories.includes("public_scene"))
      throw new AuthorizationRefusedError("public scene refused");
    const authorization = {
      tenantId: context.tenantId,
      principalId: context.principalId,
      privacyCeiling: { version: 1 as const, allowedCategories: ["public_scene" as const] },
    };
    const owner = new PostgreSqlCommandOwner(this.client);
    if (!(await owner.reader.isReady(authorization, input)))
      throw new EntitySelectionUnavailableError();
    const stored = await owner.inspect(authorization, input, wallTime);
    const state = stored.document.state;
    const entity = state.entities.find(
      (candidate) => candidate.objectId === input.objectId && candidate.spaceId === input.spaceId,
    );
    if (
      entity === undefined ||
      (input.cursor !== undefined && input.cursor.observedRevision !== state.revision.toString())
    )
      throw new EntitySelectionUnavailableError();
    const canonicalWellbeing = state.wellbeing?.entries.find(
      (entry) => entry.objectId === input.objectId,
    );
    const canonicalPlant = state.ecology?.plants.find((entry) => entry.objectId === input.objectId);
    const needs = (value: typeof entity.needs): SelectionNeeds | null =>
      value === undefined
        ? null
        : {
            hunger: value.hunger,
            wetness: value.wetness,
            integratedAt: value.integratedAt.toString(),
            hungerRemainder: value.hungerRemainder.toString(),
            wetnessRemainder: value.wetnessRemainder.toString(),
          };
    const wellbeing = (value: typeof canonicalWellbeing): SelectionWellbeing | null =>
      value === undefined
        ? null
        : {
            thirst: value.thirst,
            health: value.health,
            comfort: value.comfort,
            integratedAt: value.integratedAt.toString(),
            thirstRemainder: value.thirstRemainder.toString(),
            healthRemainder: value.healthRemainder.toString(),
          };
    const plant = (value: typeof canonicalPlant): SelectionPlant | null =>
      value === undefined
        ? null
        : {
            stage: value.stage,
            growingMs: value.growingMs.toString(),
            wetness: value.wetness,
            wetnessRemainder: value.wetnessRemainder.toString(),
            integratedAt: value.integratedAt.toString(),
          };
    const earned = stored.earned;
    const currentNeeds =
      earned.needs.find((entry) => entry.objectId === input.objectId)?.needs ?? entity.needs;
    const currentWellbeing =
      earned.wellbeing.find((entry) => entry.objectId === input.objectId) ?? canonicalWellbeing;
    const currentPlant =
      earned.plants.find((entry) => entry.objectId === input.objectId) ?? canonicalPlant;
    const before =
      input.cursor === undefined
        ? stored.coveredHeadSequence + 1n
        : BigInt(input.cursor.beforeSequence);
    if (before > stored.coveredHeadSequence + 1n) throw new EntitySelectionUnavailableError();
    const history = await new PostgreSqlObjectHistoryReader(this.client).read(
      authorization,
      {
        tenantId: input.tenantId,
        timelineId: input.timelineId,
        partitionId: stored.partitionId,
      },
      before,
    );
    const actions = history.events.flatMap((event) => {
      const payload = kernelPayloadOf(event);
      if (payload === undefined) return [];
      const touches =
        ("objectId" in payload && payload.objectId === input.objectId) ||
        ("fromObjectId" in payload && payload.fromObjectId === input.objectId) ||
        ("toObjectId" in payload && payload.toObjectId === input.objectId) ||
        ("containerId" in payload && payload.containerId === input.objectId) ||
        ("fromContainerId" in payload && payload.fromContainerId === input.objectId) ||
        ("toContainerId" in payload && payload.toContainerId === input.objectId) ||
        ("object" in payload &&
          typeof payload.object === "object" &&
          payload.object !== null &&
          "objectId" in payload.object &&
          payload.object.objectId === input.objectId);
      if (!touches) return [];
      return [
        {
          eventId: event.eventId,
          actionId: event.attribution.causalRootActionId,
          commandId: event.commandId,
          type: event.type,
          partitionSequence: event.partitionSequence.toString(),
          simulationTime: event.simulationTime.toString(),
          recordedAt: event.recordedAt,
        },
      ];
    });
    return {
      version: 1,
      privacyClass: "public_scene",
      tenantId: input.tenantId,
      worldId: input.worldId,
      timelineId: input.timelineId,
      spaceId: input.spaceId,
      objectId: input.objectId,
      evidence: SELECTION_EVIDENCE,
      revision: state.revision.toString(),
      simulationTime: state.simulationTime.toString(),
      entity: {
        objectId: entity.objectId,
        archetypeId: entity.archetypeId,
        pose: {
          frameId: entity.pose.frameId,
          frameVersion: entity.pose.frameVersion,
          coordinates: entity.pose.coordinates.map(String),
        },
        presentation: { kind: "placeholder", label: entity.objectId },
      },
      physical: {
        needs: needs(entity.needs),
        wellbeing: wellbeing(canonicalWellbeing),
        plant: plant(canonicalPlant),
        resource: entity.resource ?? null,
        shelter: entity.shelter ?? null,
        locationId: entity.locationId ?? null,
        selectedAction:
          entity.selectedAction === undefined
            ? null
            : {
                kind: entity.selectedAction.kind,
                targetObjectId: entity.selectedAction.targetObjectId ?? null,
              },
        lifecycle: entity.lifecycle?.status ?? null,
      },
      derived: {
        canonical: false,
        simulationTime: earned.simulationTime.toString(),
        needs: needs(currentNeeds),
        wellbeing:
          currentWellbeing === undefined
            ? null
            : {
                thirst: currentWellbeing.thirst,
                health: currentWellbeing.health,
                thirstRemainder: currentWellbeing.thirstRemainder.toString(),
                healthRemainder: currentWellbeing.healthRemainder.toString(),
              },
        plant:
          currentPlant === undefined
            ? null
            : {
                growingMs: currentPlant.growingMs.toString(),
                wetness: currentPlant.wetness,
                wetnessRemainder: currentPlant.wetnessRemainder.toString(),
              },
      },
      history: {
        observedRevision: state.revision.toString(),
        actions,
        beforeSequence: history.beforeSequence?.toString() ?? null,
      },
    };
  }
}
