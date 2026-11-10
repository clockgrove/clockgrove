import type {
  AttributionEnvelope,
  ObjectId,
  PartitionId,
  PolicyVersionSet,
  SimTimeMs,
  SpaceId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";
import { decodeAttributionEnvelope } from "@clockgrove/contracts";
import { DomainValidationError } from "./actor-process.js";
import {
  type ContainmentState,
  containmentSchema,
  type LifecycleState as LifecycleComponentState,
  lifecycleSchema,
  type PortalState,
  type ResourceState,
  resourceSchema,
} from "./components/catalog/index.js";
import {
  type EcologyEventData,
  type EcologyPolicy,
  type EcologyState,
  settleArrivals,
  validateEcologyPolicy,
  validateEcologyState,
} from "./ecology/ecology.js";
import {
  classifyRainChange,
  type EnvironmentEventData,
  type EnvironmentPolicy,
  type EnvironmentState,
  validateEnvironmentPolicy,
  validateEnvironmentState,
} from "./environment/environment.js";
import type { ContainmentEventData } from "./events/containment-events.js";
import type { MovementEventData } from "./events/movement-events.js";
import type { PortalEventData } from "./events/portal-events.js";
import { upcastEventRecord, worldEventVersion } from "./events/world-events.js";
import {
  type LifecycleEntry,
  type LifecycleEventData,
  type LifecyclePolicy,
  type LifecycleState,
  validateLifecyclePolicy,
  validateLifecycleState,
} from "./lifecycle/lifecycle.js";
import type { RandomDrawMetadata } from "./random.js";
import { type AnchorGraph, parseAnchorGraph } from "./spatial/anchors.js";
import { validateSemanticHierarchy } from "./spatial/hierarchy.js";
import type { MovementRecord } from "./spatial/movement.js";
import { reducePortalEvent, validatePortals } from "./spatial/portal.js";
import {
  reduceMovementEvent,
  validateEntityMovement,
  validateSpatialCollections,
} from "./spatial/reduce.js";
import { parseSpatialRegion, type SpatialRegion } from "./spatial/region.js";
import {
  type SemanticPose,
  type SpatialFrame,
  validateSpatialBinding,
  validateSpatialFrame,
} from "./spatial.js";
import {
  type ScriptedCognitionState,
  type UtilityEventData,
  type UtilityPolicy,
  validateScriptedCognition,
  validateUtilityPolicy,
} from "./utility/utility.js";
import {
  validateWellbeingPolicy,
  validateWellbeingState,
  type WellbeingEntry,
  type WellbeingEventData,
  type WellbeingPolicy,
  type WellbeingState,
} from "./wellbeing/wellbeing.js";
import {
  type ProcessCommandEventData,
  validateWorldProcesses,
  validateWorldProcessState,
  type WorldProcess,
  type WorldProcessState,
} from "./world-process.js";

/** First physical-behavior capability; this is not the complete World Pack manifest. */
export interface WorldBehaviorPack {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly packVersion: string;
  readonly contentHash: string;
  readonly archetypes: readonly string[];
  readonly policy: WorldBehaviorPolicy;
}

/** Need/exposure values and policy weights use integer basis points (0..10,000). */
export interface WorldBehaviorPolicy {
  readonly processes?: readonly WorldProcess[];
  readonly schemaVersion: 1;
  readonly version: string;
  readonly decisionIntervalMs: bigint;
  readonly hungerPerInterval: number;
  readonly wetnessPerInterval: number;
  readonly dryingPerInterval: number;
  readonly hungerWeight: number;
  readonly shelterWeight: number;
  /** Optional so policies without a day/night and weather cycle keep their canonical encoding. */
  readonly environment?: EnvironmentPolicy;
  /** Optional, versioned and allowed only with `environment`; absent keeps the canonical encoding. */
  readonly ecology?: EcologyPolicy;
  /** Optional, versioned and allowed only with `environment`; absent keeps the canonical encoding. */
  readonly wellbeing?: WellbeingPolicy;
  /** Optional, versioned and allowed only with `wellbeing`; absent keeps the canonical encoding. */
  readonly utility?: UtilityPolicy;
  /** Optional, versioned and allowed only with `wellbeing`; absent keeps the canonical encoding. */
  readonly lifecycle?: LifecyclePolicy;
}

export interface RoutineAction {
  readonly kind: "stay" | "seek-food" | "seek-shelter" | "seek-water";
  readonly targetObjectId?: ObjectId;
}

export interface WorldEntity {
  readonly objectId: ObjectId;
  readonly spaceId: SpaceId;
  /** Includes the pinned archetype version, such as reference.actor@1. */
  readonly archetypeId: string;
  readonly pose: SemanticPose;
  readonly containment?: ContainmentState;
  readonly resource?: ResourceState;
  readonly lifecycle?: LifecycleComponentState;
  readonly needs?: WorldNeeds;
  readonly shelter?: Readonly<{ rainProtection: number }>;
  /** Current physical location; choosing a target never changes this field or the pose. */
  readonly locationId?: ObjectId;
  readonly selectedAction?: RoutineAction;
  /** Canonical movement lineage of the object; absent for objects that never moved. */
  readonly movement?: MovementRecord;
  /** Present only on an object carrying the Portal component. */
  readonly portal?: PortalState;
}

export interface WorldNeeds {
  readonly hunger: number;
  readonly wetness: number;
  readonly integratedAt: SimTimeMs;
  readonly hungerRemainder: bigint;
  readonly wetnessRemainder: bigint;
}

export interface WorldState {
  readonly processes?: readonly WorldProcessState[];
  readonly schemaVersion: 1;
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  readonly revision: bigint;
  readonly simulationTime: SimTimeMs;
  readonly weather: Readonly<{ rainIntensity: number }>;
  /** Present exactly when the policy declares an environment. */
  readonly environment?: EnvironmentState;
  /** Present exactly when the policy declares an ecology. */
  readonly ecology?: EcologyState;
  /** Present exactly when the policy declares a wellbeing. */
  readonly wellbeing?: WellbeingState;
  /** Present only with a `utility` policy; scripted beliefs and memories. */
  readonly scriptedCognition?: ScriptedCognitionState;
  /** Present exactly when the policy declares a lifecycle. */
  readonly lifecycle?: LifecycleState;
  readonly spatialFrames: readonly SpatialFrame[];
  /** Optional so states without spatial regions keep their canonical encoding unchanged. */
  readonly spatialRegions?: readonly SpatialRegion[];
  readonly anchorGraphs?: readonly AnchorGraph[];
  readonly entities: readonly WorldEntity[];
}

export interface RoutineCandidate {
  readonly action: RoutineAction;
  readonly features: Readonly<Record<string, bigint>>;
  readonly score: bigint;
  readonly excludedReason?: string;
}

/** Structured Why data captured when choosing, before any future explanatory rendering. */
export interface DecisionTrace {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly inputRevision: bigint;
  readonly simulationTime: SimTimeMs;
  readonly policyVersion: string;
  readonly selectionTier: "reflex" | "utility";
  readonly candidates: readonly RoutineCandidate[];
  readonly selectedAction: RoutineAction;
  readonly perceptionRefs: readonly string[];
  readonly beliefRefs: readonly string[];
  readonly memoryRefs: readonly string[];
  readonly randomDraws: readonly RandomDrawMetadata[];
  readonly outcomeLinks: readonly string[];
}

interface WorldEventScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  readonly simulationTime: SimTimeMs;
  readonly attribution: AttributionEnvelope;
  readonly policyVersions: PolicyVersionSet;
}

type RoutineSelectedData = Readonly<{
  type: "routine.selected";
  payload: Readonly<{ objectId: ObjectId; action: RoutineAction }>;
}>;

/**
 * Intersects the existing kernel SemanticEventDraft; journal sequence assignment is external.
 * `schemaVersion` is the event type's current version (`WORLD_EVENT_DEFINITIONS`).
 */
export type WorldEvent = WorldEventScope &
  (
    | (Readonly<{ schemaVersion: 1 }> &
        (
          | Readonly<{ type: "weather.changed"; payload: Readonly<{ rainIntensity: number }> }>
          | Readonly<{
              type: "needs.changed";
              payload: Readonly<{ objectId: ObjectId }> & WorldNeeds;
            }>
          | Readonly<{ type: "time.advanced"; payload: Readonly<Record<string, never>> }>
          | ProcessCommandEventData
          | ContainmentEventData
          | MovementEventData
          | PortalEventData
          | EnvironmentEventData
          | EcologyEventData
          | WellbeingEventData
          | UtilityEventData
          | LifecycleEventData
        ))
    | (Readonly<{ schemaVersion: 2 }> & RoutineSelectedData)
  );

/**
 * A journaled world event at any supported version: a current `WorldEvent` or a historic
 * `routine.selected@1` (emitted for every decision, changed or not), which `upcastWorldEvent` reads.
 */
export type HistoricWorldEvent =
  | WorldEvent
  | (WorldEventScope & Readonly<{ schemaVersion: 1 }> & RoutineSelectedData);

/**
 * The pure upcast from a supported historic event to its current version. `routine.selected@1`
 * becomes `@2` with the same payload: a version 1 stream also holds the unchanged re-selections
 * that version 2 omits, and each of those sets the action the actor already has, so the reduced
 * state differs only in `revision`. Current events are returned as they are. It reads the same
 * table (`upcastEventRecord`) that rule evaluation does.
 */
export function upcastWorldEvent(event: HistoricWorldEvent): WorldEvent {
  return upcastEventRecord(event) as WorldEvent;
}

const MAX_SIM_TIME = (1n << 63n) - 1n;

/** Every field a world behaviour policy may carry; anything else is refused before it can be hashed. */
const POLICY_SECTIONS: readonly string[] = [
  "schemaVersion",
  "version",
  "decisionIntervalMs",
  "hungerPerInterval",
  "wetnessPerInterval",
  "dryingPerInterval",
  "hungerWeight",
  "shelterWeight",
  "environment",
  "ecology",
  "wellbeing",
  "utility",
  "lifecycle",
  "processes",
] satisfies readonly (keyof WorldBehaviorPolicy)[];

export function validateWorldBehaviorPack(pack: WorldBehaviorPack): void {
  requireVersion(pack.schemaVersion, "pack.schemaVersion");
  requireName(pack.packId, "pack.packId");
  requireName(pack.packVersion, "pack.packVersion");
  if (!/^[a-f0-9]{64}$/u.test(pack.contentHash)) {
    throw new DomainValidationError("pack.contentHash", "must be a lowercase SHA-256 digest");
  }
  if (pack.archetypes.length === 0) {
    throw new DomainValidationError(
      "pack.archetypes",
      "must declare at least one pinned archetype",
    );
  }
  uniqueNames(pack.archetypes, "pack.archetypes");
  const policy = pack.policy;
  for (const key of Object.keys(policy).sort()) {
    if (!POLICY_SECTIONS.includes(key)) {
      throw new DomainValidationError(`policy.${key}`, "unknown policy section");
    }
  }
  requireVersion(policy.schemaVersion, "policy.schemaVersion");
  requireName(policy.version, "policy.version");
  requireTime(policy.decisionIntervalMs, "policy.decisionIntervalMs");
  if (policy.decisionIntervalMs === 0n) {
    throw new DomainValidationError("policy.decisionIntervalMs", "must be positive");
  }
  for (const key of [
    "hungerPerInterval",
    "wetnessPerInterval",
    "dryingPerInterval",
    "hungerWeight",
    "shelterWeight",
  ] as const) {
    requireBasisPoints(policy[key], `policy.${key}`);
  }
  if (Object.hasOwn(policy, "processes")) validateWorldProcesses(policy.processes);
  if (Object.hasOwn(policy, "environment")) validateEnvironmentPolicy(policy.environment);
  if (Object.hasOwn(policy, "ecology")) validateEcologyPolicy(policy.ecology, policy.environment);
  if (Object.hasOwn(policy, "wellbeing"))
    validateWellbeingPolicy(policy.wellbeing, policy.environment);
  if (Object.hasOwn(policy, "utility")) validateUtilityPolicy(policy.utility, policy.wellbeing);
  if (Object.hasOwn(policy, "lifecycle"))
    validateLifecyclePolicy(policy.lifecycle, policy.wellbeing);
}

export function validateWorldState(state: WorldState): void {
  requireVersion(state.schemaVersion, "state.schemaVersion");
  for (const key of ["tenantId", "worldId", "timelineId", "partitionId"] as const) {
    requireName(state[key], `state.${key}`);
  }
  if (typeof state.revision !== "bigint" || state.revision < 0n) {
    throw new DomainValidationError("state.revision", "must be a nonnegative bigint");
  }
  requireTime(state.simulationTime, "state.simulationTime");
  requireBasisPoints(state.weather.rainIntensity, "state.weather.rainIntensity");
  if (Object.hasOwn(state, "processes")) validateWorldProcessState(state.processes);
  if (Object.hasOwn(state, "environment")) validateEnvironmentState(state.environment);
  if (Object.hasOwn(state, "ecology")) validateEcologyState(state.ecology);
  if (Object.hasOwn(state, "wellbeing")) validateWellbeingState(state.wellbeing);
  if (Object.hasOwn(state, "scriptedCognition")) validateScriptedCognition(state.scriptedCognition);
  if (Object.hasOwn(state, "lifecycle")) validateLifecycleState(state.lifecycle);
  uniqueNames(
    state.spatialFrames.map((frame) => frame.frameId),
    "state.spatialFrames",
  );
  uniqueNames(
    state.entities.map((entity) => entity.objectId),
    "state.entities",
  );
  for (const frame of state.spatialFrames) {
    if (
      (frame.dimensions !== 2 && frame.dimensions !== 3) ||
      frame.gravity.kind !== "constant-vector"
    ) {
      throw new DomainValidationError(
        "spatialFrame",
        "must declare supported dimensions and constant-vector gravity",
      );
    }
    validateSpatialFrame(frame);
    for (const coordinate of [
      ...frame.origin,
      ...frame.gravity.vector,
      ...(frame.parentTransform?.translation ?? []),
      ...(frame.parentTransform?.basis.flat() ?? []),
    ]) {
      if (typeof coordinate !== "bigint") {
        throw new DomainValidationError("spatialFrame.coordinates", "must use bigint fixed point");
      }
    }
    if (
      frame.parentFrameId !== undefined &&
      !state.spatialFrames.some((candidate) => candidate.frameId === frame.parentFrameId)
    ) {
      throw new DomainValidationError(
        "spatialFrame.parentFrameId",
        "does not reference a declared frame",
      );
    }
    let ancestor = frame;
    const ancestors = new Set<string>();
    while (ancestor.parentFrameId !== undefined) {
      if (ancestors.has(ancestor.frameId)) {
        throw new DomainValidationError(
          "spatialFrame.parentFrameId",
          "parent frames must be acyclic",
        );
      }
      ancestors.add(ancestor.frameId);
      const parent = state.spatialFrames.find(
        (candidate) => candidate.frameId === ancestor.parentFrameId,
      );
      if (parent === undefined) {
        throw new DomainValidationError(
          "spatialFrame.parentFrameId",
          "does not reference a declared frame",
        );
      }
      ancestor = parent;
    }
  }
  validateSpatialCollections(state);
  validateSemanticHierarchy(state);
  for (const [entityIndex, entity] of state.entities.entries()) {
    if (entity.containment !== undefined) containmentSchema.parse(entity.containment);
    if (entity.resource !== undefined) resourceSchema.parse(entity.resource);
    if (entity.lifecycle !== undefined) lifecycleSchema.parse(entity.lifecycle);
    requireName(entity.spaceId, "entity.spaceId");
    requireName(entity.archetypeId, "entity.archetypeId");
    const frame = state.spatialFrames.find(
      (candidate) => candidate.frameId === entity.pose.frameId,
    );
    if (frame === undefined) {
      throw new DomainValidationError("entity.pose.frameId", "does not reference a declared frame");
    }
    validateSpatialBinding(frame, { identity: { objectId: entity.objectId }, pose: entity.pose });
    if (entity.pose.coordinates.some((coordinate) => typeof coordinate !== "bigint")) {
      throw new DomainValidationError("entity.pose.coordinates", "must use bigint fixed point");
    }
    if (entity.needs !== undefined) {
      requireBasisPoints(entity.needs.hunger, "entity.needs.hunger");
      requireBasisPoints(entity.needs.wetness, "entity.needs.wetness");
      requireTime(entity.needs.integratedAt, "entity.needs.integratedAt");
      if (entity.needs.integratedAt > state.simulationTime)
        throw new DomainValidationError(
          "entity.needs.integratedAt",
          "must not exceed the state simulation time",
        );
      for (const name of ["hungerRemainder", "wetnessRemainder"] as const) {
        if (typeof entity.needs[name] !== "bigint" || entity.needs[name] < 0n) {
          throw new DomainValidationError(`entity.needs.${name}`, "must be a nonnegative bigint");
        }
      }
      if (
        entity.needs.hungerRemainder >= MAX_SIM_TIME ||
        entity.needs.wetnessRemainder >= MAX_SIM_TIME * 100_000_000n
      ) {
        throw new DomainValidationError(
          "entity.needs.remainder",
          "exceeds any supported integration denominator",
        );
      }
    }
    if (entity.shelter !== undefined)
      requireBasisPoints(entity.shelter.rainProtection, "entity.shelter.rainProtection");
    if (entity.locationId !== undefined) requireShelter(state, entity, entity.locationId);
    if (entity.selectedAction !== undefined) validateAction(state, entity, entity.selectedAction);
    validateEntityMovement(state, entity, `state.entities[${entityIndex}]`);
  }
  validatePortals(state);
}

/** Copies and canonicalizes owned collections without mutating or freezing the caller's input. */
export function createWorldState(state: WorldState): WorldState {
  validateWorldState(state);
  return frozenCopy({
    ...state,
    spatialFrames: [...state.spatialFrames].sort((left, right) =>
      compareNames(left.frameId, right.frameId),
    ),
    ...(state.spatialRegions === undefined
      ? {}
      : {
          spatialRegions: state.spatialRegions
            .map((region) => parseSpatialRegion(region))
            .sort((left, right) => compareNames(left.regionId, right.regionId)),
        }),
    ...(state.anchorGraphs === undefined
      ? {}
      : {
          anchorGraphs: state.anchorGraphs
            .map((graph) => parseAnchorGraph(graph))
            .sort((left, right) => compareNames(left.graphId, right.graphId)),
        }),
    entities: [...state.entities].sort((left, right) =>
      compareNames(left.objectId, right.objectId),
    ),
  });
}

export function reduceWorldEvent(state: WorldState, event: WorldEvent): WorldState {
  validateWorldState(state);
  if (event.schemaVersion !== worldEventVersion(event.type))
    throw new DomainValidationError("event.schemaVersion", "unsupported schema version");
  for (const key of ["tenantId", "worldId", "timelineId", "partitionId"] as const) {
    if (event[key] !== state[key]) {
      throw new DomainValidationError(`event.${key}`, "does not match the supplied state");
    }
  }
  requireTime(event.simulationTime, "event.simulationTime");
  if (event.simulationTime < state.simulationTime) {
    throw new DomainValidationError("event.simulationTime", "must not move backwards");
  }
  decodeAttributionEnvelope(event.attribution);
  for (const [name, version] of Object.entries(event.policyVersions)) {
    requireName(name, "event.policyVersions.key");
    requireName(version, `event.policyVersions.${name}`);
  }
  const advanced = {
    ...state,
    revision: state.revision + 1n,
    simulationTime: event.simulationTime,
  };
  switch (event.type) {
    case "process.command-attempted": {
      const index =
        state.processes?.findIndex((entry) => entry.processId === event.payload.processId) ?? -1;
      if (index < 0 || state.processes![index]!.nextAt !== event.simulationTime)
        throw new DomainValidationError("event.processId", "process occurrence is not due");
      return createWorldState({
        ...advanced,
        processes: state.processes!.map((entry, at) =>
          at === index ? { ...entry, nextAt: event.payload.nextAt } : entry,
        ),
      });
    }
    case "weather.changed":
      requireBasisPoints(event.payload.rainIntensity, "event.rainIntensity");
      return createWorldState({
        ...advanced,
        weather: { rainIntensity: event.payload.rainIntensity },
      });
    case "needs.changed": {
      const entity = requireEntity(state, event.payload.objectId);
      if (entity.needs === undefined)
        throw new DomainValidationError("event.objectId", "entity has no needs component");
      requireBasisPoints(event.payload.hunger, "event.hunger");
      requireBasisPoints(event.payload.wetness, "event.wetness");
      if (
        event.payload.integratedAt !== event.simulationTime ||
        event.payload.integratedAt < entity.needs.integratedAt
      ) {
        throw new DomainValidationError(
          "event.integratedAt",
          "must integrate forward through the event simulation time",
        );
      }
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) =>
          candidate.objectId === entity.objectId
            ? {
                ...candidate,
                needs: {
                  hunger: event.payload.hunger,
                  wetness: event.payload.wetness,
                  integratedAt: event.payload.integratedAt,
                  hungerRemainder: event.payload.hungerRemainder,
                  wetnessRemainder: event.payload.wetnessRemainder,
                },
              }
            : candidate,
        ),
      });
    }
    case "routine.selected": {
      const entity = requireEntity(state, event.payload.objectId);
      validateAction(state, entity, event.payload.action);
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) =>
          candidate.objectId === entity.objectId
            ? {
                ...candidate,
                selectedAction: event.payload.action,
              }
            : candidate,
        ),
      });
    }
    case "time.advanced":
      if (Object.keys(event.payload).length !== 0)
        throw new DomainValidationError("event.payload", "time advance has no payload fields");
      return createWorldState(advanced);
    case "object.created":
      if (
        state.entities.some((entity) => entity.objectId === event.payload.object.objectId) ||
        event.payload.quantityAdded !== (event.payload.object.resource?.quantity ?? 0)
      )
        throw new DomainValidationError("event.object", "invalid creation");
      return createWorldState({ ...advanced, entities: [...state.entities, event.payload.object] });
    case "object.retired": {
      const entity = requireEntity(state, event.payload.objectId);
      if (
        event.payload.disposition !== "discard" ||
        event.payload.kind !== (entity.resource?.kind ?? null) ||
        event.payload.quantityRemoved !== (entity.resource?.quantity ?? 0)
      )
        throw new DomainValidationError("event.quantityRemoved", "invalid disposition");
      const retired = state.entities.map((candidate) =>
        candidate.objectId !== entity.objectId
          ? candidate
          : {
              ...candidate,
              lifecycle: { status: "retired" as const },
              ...(candidate.resource === undefined
                ? {}
                : { resource: { ...candidate.resource, quantity: 0 } }),
            },
      );
      return createWorldState({
        ...advanced,
        entities: retired,
        ...withEcology(
          settleArrivals(state.ecology, state.entities, retired, event.simulationTime),
        ),
      });
    }
    case "containment.put":
    case "containment.removed":
    case "containment.transferred": {
      const entity = requireEntity(state, event.payload.objectId);
      if (entity.containment === undefined)
        throw new DomainValidationError("event.objectId", "no containment");
      const { containerId: _old, ...uncontained } = entity.containment;
      const next =
        event.type === "containment.removed"
          ? uncontained
          : {
              ...uncontained,
              containerId:
                event.type === "containment.transferred"
                  ? event.payload.toContainerId
                  : event.payload.containerId,
            };
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) =>
          candidate.objectId === entity.objectId ? { ...candidate, containment: next } : candidate,
        ),
      });
    }
    case "resource.offered":
    case "resource.consumed":
    case "resource.transferred": {
      const payload = event.payload;
      if (!Number.isSafeInteger(payload.quantity) || payload.quantity <= 0)
        throw new DomainValidationError("event.quantity", "expected positive material units");
      const changes =
        event.type === "resource.transferred"
          ? ([
              [event.payload.fromObjectId, -payload.quantity],
              [event.payload.toObjectId, payload.quantity],
            ] as const)
          : ([
              [
                event.payload.objectId,
                event.type === "resource.offered" ? payload.quantity : -payload.quantity,
              ],
            ] as const);
      let entities = state.entities;
      for (const [id, amount] of changes) {
        const entity = requireEntity(state, id);
        if (entity.resource === undefined || entity.resource.kind !== payload.kind)
          throw new DomainValidationError("event.kind", "incompatible resource");
        entities = entities.map((candidate) =>
          candidate.objectId === id
            ? {
                ...candidate,
                resource: { ...entity.resource!, quantity: entity.resource!.quantity + amount },
              }
            : candidate,
        );
      }
      const fromId = event.type === "resource.transferred" ? event.payload.fromObjectId : undefined;
      const toId = event.type === "resource.transferred" ? event.payload.toObjectId : undefined;
      const inherited =
        fromId === undefined
          ? undefined
          : state.ecology?.perishables.find((entry) => entry.objectId === fromId)?.arrivedAt;
      return createWorldState({
        ...advanced,
        entities,
        ...withEcology(
          settleArrivals(
            state.ecology,
            state.entities,
            entities,
            event.simulationTime,
            toId === undefined || inherited === undefined || inherited === null
              ? undefined
              : { objectId: toId, arrivedAt: inherited },
          ),
        ),
      });
    }
    case "resource.weather-integrated": {
      const entity = requireEntity(state, event.payload.objectId);
      const ecology = requireEcology(state);
      const entry = ecology.waterHolders?.find(
        (candidate) => candidate.objectId === entity.objectId,
      );
      const { collected, evaporated, integratedAt, collectionRemainder, evaporationRemainder } =
        event.payload;
      if (
        entry === undefined ||
        entity.resource?.kind !== "water" ||
        integratedAt !== event.simulationTime ||
        integratedAt <= entry.integratedAt ||
        !Number.isSafeInteger(collected) ||
        collected < 0 ||
        !Number.isSafeInteger(evaporated) ||
        evaporated < 0
      )
        throw new DomainValidationError("event", "invalid weather integration");
      const quantity = BigInt(entity.resource.quantity) + BigInt(collected) - BigInt(evaporated);
      if (quantity < 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER))
        throw new DomainValidationError("event", "invalid weather inventory");
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) =>
          candidate.objectId !== entity.objectId
            ? candidate
            : { ...candidate, resource: { ...entity.resource!, quantity: Number(quantity) } },
        ),
        ecology: {
          ...ecology,
          waterHolders: ecology.waterHolders!.map((candidate) =>
            candidate.objectId !== entity.objectId
              ? candidate
              : { ...candidate, collectionRemainder, evaporationRemainder, integratedAt },
          ),
        },
      });
    }
    case "resource.appeared": {
      const entity = requireEntity(state, event.payload.objectId);
      if (!Number.isSafeInteger(event.payload.quantity) || event.payload.quantity <= 0)
        throw new DomainValidationError("event.quantity", "expected positive material units");
      if (entity.resource === undefined || entity.resource.kind !== event.payload.kind)
        throw new DomainValidationError("event.kind", "incompatible resource");
      if (entity.resource.quantity > Number.MAX_SAFE_INTEGER - event.payload.quantity)
        throw new DomainValidationError("event.quantity", "exceeds the material quantity range");
      const entities = state.entities.map((candidate) =>
        candidate.objectId !== entity.objectId
          ? candidate
          : {
              ...candidate,
              resource: {
                ...entity.resource!,
                quantity: entity.resource!.quantity + event.payload.quantity,
              },
            },
      );
      return createWorldState({
        ...advanced,
        entities,
        ...withEcology(
          settleArrivals(state.ecology, state.entities, entities, event.simulationTime),
        ),
      });
    }
    case "resource.spoiled": {
      const entity = requireEntity(state, event.payload.objectId);
      if (state.ecology?.perishables.some((entry) => entry.objectId === entity.objectId) !== true)
        throw new DomainValidationError("event.objectId", "not a perishable holder");
      if (
        event.payload.kind !== "food" ||
        entity.resource?.kind !== "food" ||
        entity.resource.quantity <= 0 ||
        event.payload.quantity !== entity.resource.quantity
      )
        throw new DomainValidationError(
          "event.quantity",
          "spoilage removes the whole food quantity",
        );
      const entities = state.entities.map((candidate) =>
        candidate.objectId !== entity.objectId
          ? candidate
          : {
              ...candidate,
              resource: { ...entity.resource!, quantity: 0 },
            },
      );
      return createWorldState({
        ...advanced,
        entities,
        ...withEcology(
          settleArrivals(state.ecology, state.entities, entities, event.simulationTime),
        ),
      });
    }
    case "growth.stage-changed": {
      const ecology = requireEcology(state);
      const plant = ecology.plants.find((entry) => entry.objectId === event.payload.objectId);
      if (plant === undefined) throw new DomainValidationError("event.objectId", "not a plant");
      if (
        !Number.isSafeInteger(event.payload.stageIndex) ||
        event.payload.stageIndex <= plant.stage ||
        event.payload.stageIndex > 15
      )
        throw new DomainValidationError("event.stageIndex", "must advance the plant stage");
      requireName(event.payload.stageName, "event.stageName");
      let entities = state.entities;
      if (event.payload.yield !== undefined) {
        if (event.payload.stageIndex !== plant.stage + 1)
          throw new DomainValidationError(
            "event.stageIndex",
            "yield must enter the next plant stage",
          );
        const quantity = event.payload.yield.quantity;
        const entity = requireEntity(state, plant.objectId);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || Object.is(quantity, -0))
          throw new DomainValidationError(
            "event.yield.quantity",
            "expected positive material units",
          );
        if (entity.resource?.kind !== "food")
          throw new DomainValidationError("event.objectId", "a yielding plant must hold food");
        if (entity.resource.quantity > Number.MAX_SAFE_INTEGER - quantity)
          throw new DomainValidationError(
            "event.yield.quantity",
            "exceeds the material quantity range",
          );
        entities = state.entities.map((candidate) =>
          candidate !== entity
            ? candidate
            : {
                ...entity,
                resource: { ...entity.resource!, quantity: entity.resource!.quantity + quantity },
              },
        );
      }
      return createWorldState({
        ...advanced,
        entities,
        ecology: {
          ...ecology,
          plants: ecology.plants.map((entry) =>
            entry === plant ? { ...entry, stage: event.payload.stageIndex } : entry,
          ),
        },
      });
    }
    case "growth.integrated": {
      const ecology = requireEcology(state);
      const plant = ecology.plants.find((entry) => entry.objectId === event.payload.objectId);
      if (plant === undefined) throw new DomainValidationError("event.objectId", "not a plant");
      requireBasisPoints(event.payload.wetness, "event.wetness");
      if (
        typeof event.payload.growingMs !== "bigint" ||
        event.payload.growingMs < plant.growingMs ||
        typeof event.payload.wetnessRemainder !== "bigint" ||
        event.payload.wetnessRemainder < 0n
      )
        throw new DomainValidationError("event.growingMs", "must integrate forward");
      if (
        event.payload.integratedAt !== event.simulationTime ||
        event.payload.integratedAt < plant.integratedAt
      )
        throw new DomainValidationError(
          "event.integratedAt",
          "must integrate forward through the event simulation time",
        );
      return createWorldState({
        ...advanced,
        ecology: {
          ...ecology,
          plants: ecology.plants.map((entry) =>
            entry === plant
              ? {
                  ...entry,
                  growingMs: event.payload.growingMs,
                  wetness: event.payload.wetness,
                  wetnessRemainder: event.payload.wetnessRemainder,
                  integratedAt: event.payload.integratedAt,
                }
              : entry,
          ),
        },
      });
    }
    case "movement.started":
    case "movement.region-entered":
    case "movement.region-exited":
    case "movement.region-remained":
    case "movement.portal-crossed":
    case "movement.interrupted":
    case "movement.replanned":
    case "movement.completed":
      return createWorldState({ ...advanced, entities: reduceMovementEvent(state, event) });
    case "portal.opened":
    case "portal.closed":
      return createWorldState({ ...advanced, entities: reducePortalEvent(state, event) });
    case "environment.phase-changed": {
      const record = requireEnvironment(state);
      if (event.simulationTime !== record.nextPhaseBoundary)
        throw new DomainValidationError(
          "event.simulationTime",
          "must equal the next phase boundary",
        );
      const next = {
        ...record,
        phase: event.payload.phase,
        lightBand: event.payload.lightBand,
        nextPhaseBoundary: event.payload.nextPhaseBoundary,
      };
      if (next.nextPhaseBoundary <= event.simulationTime)
        throw new DomainValidationError("event.nextPhaseBoundary", "must lie after the event time");
      validateEnvironmentState(next, "event.environment");
      return createWorldState({ ...advanced, environment: next });
    }
    case "weather.transitioned": {
      const record = requireEnvironment(state);
      if (event.simulationTime !== record.nextWeatherBoundary)
        throw new DomainValidationError(
          "event.simulationTime",
          "must equal the next weather boundary",
        );
      requireBasisPoints(event.payload.rainIntensity, "event.rainIntensity");
      if (
        event.payload.rainChange !==
        classifyRainChange(state.weather.rainIntensity, event.payload.rainIntensity)
      )
        throw new DomainValidationError("event.rainChange", "does not describe the rain change");
      const next = {
        ...record,
        segmentIndex: event.payload.segmentIndex,
        temperatureBand: event.payload.temperatureBand,
        nextWeatherBoundary: event.payload.nextWeatherBoundary,
      };
      if (next.nextWeatherBoundary <= event.simulationTime)
        throw new DomainValidationError(
          "event.nextWeatherBoundary",
          "must lie after the event time",
        );
      validateEnvironmentState(next, "event.environment");
      return createWorldState({
        ...advanced,
        weather: { rainIntensity: event.payload.rainIntensity },
        environment: next,
      });
    }
    case "exposure.threshold-crossed": {
      const entity = requireEntity(state, event.payload.objectId);
      if (entity.needs === undefined)
        throw new DomainValidationError("event.objectId", "entity has no needs component");
      if (!["wet", "uncomfortable"].includes(event.payload.threshold))
        throw new DomainValidationError("event.threshold", "unsupported exposure threshold");
      if (!["entered", "left"].includes(event.payload.direction))
        throw new DomainValidationError("event.direction", "unsupported crossing direction");
      requireBasisPoints(event.payload.wetness, "event.wetness");
      return createWorldState(advanced);
    }
    case "wellbeing.integrated": {
      const { wellbeing, entry } = requireWellbeingEntry(state, event.payload.objectId);
      requireBasisPoints(event.payload.thirst, "event.thirst");
      requireBasisPoints(event.payload.health, "event.health");
      for (const key of ["thirstRemainder", "healthRemainder"] as const)
        if (typeof event.payload[key] !== "bigint" || event.payload[key] < 0n)
          throw new DomainValidationError(`event.${key}`, "must be a nonnegative bigint");
      if (
        event.payload.integratedAt !== event.simulationTime ||
        event.payload.integratedAt < entry.integratedAt
      )
        throw new DomainValidationError(
          "event.integratedAt",
          "must integrate forward through the event simulation time",
        );
      return createWorldState({
        ...advanced,
        wellbeing: {
          entries: wellbeing.entries.map((candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  thirst: event.payload.thirst,
                  thirstRemainder: event.payload.thirstRemainder,
                  health: event.payload.health,
                  healthRemainder: event.payload.healthRemainder,
                  integratedAt: event.payload.integratedAt,
                }
              : candidate,
          ),
        },
      });
    }
    case "needs.threshold-crossed":
      requireWellbeingEntry(state, event.payload.objectId);
      if (!["hunger", "thirst"].includes(event.payload.need))
        throw new DomainValidationError("event.need", "unsupported need");
      requireBasisPoints(event.payload.value, "event.value");
      return createWorldState(advanced);
    case "comfort.changed": {
      const { wellbeing, entry } = requireWellbeingEntry(state, event.payload.objectId);
      if (!["comfortable", "uncomfortable"].includes(event.payload.comfort))
        throw new DomainValidationError("event.comfort", "unsupported comfort");
      const causes = event.payload.causes;
      if (
        !Array.isArray(causes) ||
        causes.some(
          (cause, index) =>
            !["hungry", "thirsty", "wet"].includes(cause) ||
            (index > 0 && !(causes[index - 1]! < cause)),
        )
      )
        throw new DomainValidationError("event.causes", "must be sorted unique comfort causes");
      if ((causes.length === 0) !== (event.payload.comfort === "comfortable"))
        throw new DomainValidationError("event.causes", "must be empty exactly when comfortable");
      return createWorldState({
        ...advanced,
        wellbeing: {
          entries: wellbeing.entries.map((candidate) =>
            candidate === entry ? { ...candidate, comfort: event.payload.comfort } : candidate,
          ),
        },
      });
    }
    case "health.threshold-crossed":
      requireWellbeingEntry(state, event.payload.objectId);
      if (event.payload.threshold !== "critical")
        throw new DomainValidationError("event.threshold", "unsupported health threshold");
      if (!["entered", "left"].includes(event.payload.direction))
        throw new DomainValidationError("event.direction", "unsupported crossing direction");
      requireBasisPoints(event.payload.health, "event.health");
      return createWorldState(advanced);
    case "location.changed": {
      // Any object may stand in a shelter (a sheltered plant, a carried object), so any may leave it.
      const entity = requireEntity(state, event.payload.objectId);
      const locationId = event.payload.locationId;
      if (locationId !== null) requireShelter(state, entity, locationId);
      requireName(event.payload.planId, "event.planId");
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) => {
          if (candidate.objectId !== entity.objectId) return candidate;
          const { locationId: _previous, ...rest } = candidate;
          return locationId === null ? rest : { ...rest, locationId };
        }),
      });
    }
    case "needs.relieved": {
      const entity = requireEntity(state, event.payload.objectId);
      if (entity.needs === undefined)
        throw new DomainValidationError("event.objectId", "entity has no needs component");
      if (!["hunger", "thirst"].includes(event.payload.need))
        throw new DomainValidationError("event.need", "unsupported need");
      requireEntity(state, event.payload.sourceObjectId);
      if (!Number.isSafeInteger(event.payload.quantity) || event.payload.quantity <= 0)
        throw new DomainValidationError("event.quantity", "expected positive material units");
      requireBasisPoints(event.payload.value, "event.value");
      requireName(event.payload.planId, "event.planId");
      if (event.payload.need === "hunger")
        return createWorldState({
          ...advanced,
          entities: state.entities.map((candidate) =>
            candidate === entity
              ? { ...candidate, needs: { ...entity.needs!, hunger: event.payload.value } }
              : candidate,
          ),
        });
      const { wellbeing, entry } = requireWellbeingEntry(state, event.payload.objectId);
      return createWorldState({
        ...advanced,
        wellbeing: {
          entries: wellbeing.entries.map((candidate) =>
            candidate === entry ? { ...candidate, thirst: event.payload.value } : candidate,
          ),
        },
      });
    }
    case "lifecycle.conceived": {
      const { lifecycle, entry } = requireLifecycleEntry(state, event.payload.objectId);
      requireName(event.payload.childId, "event.childId");
      if (entry.death !== null || entry.gestation !== null)
        throw new DomainValidationError(
          "event.objectId",
          "only a living, non-gestating actor conceives",
        );
      if (event.payload.coParentId !== null) {
        const coParent = requireLifecycleEntry(state, event.payload.coParentId).entry;
        if (coParent.death !== null || event.payload.coParentId === entry.objectId)
          throw new DomainValidationError("event.coParentId", "must be another living actor");
      }
      if (state.entities.some((candidate) => candidate.objectId === event.payload.childId))
        throw new DomainValidationError("event.childId", "the child id already names an entity");
      if (typeof event.payload.dueAt !== "bigint" || event.payload.dueAt <= event.simulationTime)
        throw new DomainValidationError("event.dueAt", "must lie after the conception");
      return createWorldState({
        ...advanced,
        lifecycle: {
          ...lifecycle,
          entries: lifecycle.entries.map((candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  conceptions: candidate.conceptions + 1,
                  gestation: {
                    conceivedAt: event.simulationTime,
                    dueAt: event.payload.dueAt,
                    coParentId: event.payload.coParentId,
                    childId: event.payload.childId,
                    milestoneIndex: 0,
                  },
                }
              : candidate,
          ),
        },
      });
    }
    case "lifecycle.gestation-milestone": {
      const { lifecycle, entry } = requireLifecycleEntry(state, event.payload.objectId);
      const gestation = entry.gestation;
      if (
        entry.death !== null ||
        gestation === null ||
        gestation.childId !== event.payload.childId ||
        gestation.milestoneIndex !== event.payload.milestoneIndex ||
        event.payload.milestoneIndex >= 8
      )
        throw new DomainValidationError(
          "event.milestoneIndex",
          "must be the next milestone of the gestation",
        );
      requireName(event.payload.milestoneName, "event.milestoneName");
      return createWorldState({
        ...advanced,
        lifecycle: {
          ...lifecycle,
          entries: lifecycle.entries.map((candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  gestation: { ...gestation, milestoneIndex: gestation.milestoneIndex + 1 },
                }
              : candidate,
          ),
        },
      });
    }
    case "lifecycle.born": {
      const { lifecycle, entry } = requireLifecycleEntry(state, event.payload.gestatingParentId);
      const parent = requireEntity(state, event.payload.gestatingParentId);
      const gestation = entry.gestation;
      const childId = event.payload.childId;
      requireName(childId, "event.childId");
      if (
        entry.death !== null ||
        gestation === null ||
        gestation.childId !== childId ||
        gestation.dueAt !== event.simulationTime ||
        gestation.coParentId !== event.payload.coParentId
      )
        throw new DomainValidationError("event.childId", "does not match the gestation due now");
      if (state.entities.some((candidate) => candidate.objectId === childId))
        throw new DomainValidationError("event.childId", "the child id already names an entity");
      if (lifecycle.entries.length >= 128)
        throw new DomainValidationError("event.childId", "the lifecycle record is full");
      if (state.wellbeing === undefined)
        throw new DomainValidationError("state.wellbeing", "the state has no wellbeing record");
      const coParent =
        event.payload.coParentId === null
          ? undefined
          : requireLifecycleEntry(state, event.payload.coParentId).entry;
      const parentIds = [
        entry.objectId,
        ...(coParent === undefined ? [] : [coParent.objectId]),
      ].sort(compareNames);
      const child: LifecycleEntry = {
        objectId: childId,
        householdId: entry.householdId,
        parentIds,
        generation: Math.max(entry.generation, coParent?.generation ?? 0) + 1,
        bornAt: event.simulationTime,
        stageIndex: 0,
        conceptions: 0,
        lastBirthAt: null,
        gestation: null,
        death: null,
      };
      const entry2 = { ...entry, lastBirthAt: event.simulationTime, gestation: null };
      return createWorldState({
        ...advanced,
        entities: [
          ...state.entities,
          {
            objectId: childId,
            spaceId: parent.spaceId,
            archetypeId: parent.archetypeId,
            pose: parent.pose,
            lifecycle: { status: "active" as const },
            needs: {
              hunger: 0,
              wetness: 0,
              integratedAt: event.simulationTime,
              hungerRemainder: 0n,
              wetnessRemainder: 0n,
            },
          },
        ],
        wellbeing: {
          entries: [
            ...state.wellbeing.entries,
            {
              objectId: childId,
              thirst: 0,
              thirstRemainder: 0n,
              health: 10_000,
              healthRemainder: 0n,
              comfort: "comfortable" as const,
              integratedAt: event.simulationTime,
            },
          ].sort((left, right) => compareNames(left.objectId, right.objectId)),
        },
        lifecycle: {
          ...lifecycle,
          entries: [
            ...lifecycle.entries.map((candidate) => (candidate === entry ? entry2 : candidate)),
            child,
          ].sort((left, right) => compareNames(left.objectId, right.objectId)),
        },
      });
    }
    case "lifecycle.stage-changed": {
      const { lifecycle, entry } = requireLifecycleEntry(state, event.payload.objectId);
      if (
        entry.death !== null ||
        event.payload.stageIndex !== entry.stageIndex + 1 ||
        event.payload.stageIndex > 15
      )
        throw new DomainValidationError("event.stageIndex", "must advance the stage by one");
      requireName(event.payload.stageName, "event.stageName");
      return createWorldState({
        ...advanced,
        lifecycle: {
          ...lifecycle,
          entries: lifecycle.entries.map((candidate) =>
            candidate === entry
              ? { ...candidate, stageIndex: event.payload.stageIndex }
              : candidate,
          ),
        },
      });
    }
    case "lifecycle.died": {
      const { lifecycle, entry } = requireLifecycleEntry(state, event.payload.objectId);
      const entity = requireEntity(state, event.payload.objectId);
      if (entry.death !== null || entity.lifecycle?.status === "dead" || entity.needs === undefined)
        throw new DomainValidationError("event.objectId", "only a living needs actor dies");
      if (event.payload.cause !== "lifespan" && event.payload.cause !== "health")
        throw new DomainValidationError("event.cause", "unsupported cause of death");
      requireBasisPoints(event.payload.health, "event.health");
      return createWorldState({
        ...advanced,
        entities: state.entities.map((candidate) =>
          candidate === entity
            ? { ...candidate, lifecycle: { status: "dead" as const } }
            : candidate,
        ),
        lifecycle: {
          ...lifecycle,
          entries: lifecycle.entries.map((candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  gestation: null,
                  death: { diedAt: event.simulationTime, cause: event.payload.cause },
                }
              : candidate,
          ),
        },
      });
    }
    case "lifecycle.successor-intended": {
      const { entry } = requireLifecycleEntry(state, event.payload.objectId);
      if (entry.death === null)
        throw new DomainValidationError(
          "event.objectId",
          "only a deceased actor has a successor intent",
        );
      requireName(event.payload.successorId, "event.successorId");
      requireName(event.payload.rule, "event.rule");
      return createWorldState(advanced);
    }
    default:
      return unsupportedEvent(event);
  }
}

function requireLifecycleEntry(
  state: WorldState,
  objectId: ObjectId,
): { lifecycle: LifecycleState; entry: LifecycleEntry } {
  if (state.lifecycle === undefined)
    throw new DomainValidationError("state.lifecycle", "the state has no lifecycle record");
  const entry = state.lifecycle.entries.find((candidate) => candidate.objectId === objectId);
  if (entry === undefined)
    throw new DomainValidationError("event.objectId", "entity has no lifecycle entry");
  return { lifecycle: state.lifecycle, entry };
}

function requireWellbeingEntry(
  state: WorldState,
  objectId: ObjectId,
): { wellbeing: WellbeingState; entry: WellbeingEntry } {
  if (state.wellbeing === undefined)
    throw new DomainValidationError("state.wellbeing", "the state has no wellbeing record");
  const entry = state.wellbeing.entries.find((candidate) => candidate.objectId === objectId);
  if (entry === undefined)
    throw new DomainValidationError("event.objectId", "entity has no wellbeing entry");
  return { wellbeing: state.wellbeing, entry };
}

function withEcology(ecology: EcologyState | undefined): { ecology?: EcologyState } {
  return ecology === undefined ? {} : { ecology };
}

function requireEcology(state: WorldState): EcologyState {
  if (state.ecology === undefined)
    throw new DomainValidationError("state.ecology", "the state has no ecology record");
  return state.ecology;
}

function requireEnvironment(state: WorldState): EnvironmentState {
  if (state.environment === undefined)
    throw new DomainValidationError("state.environment", "the state has no environment record");
  return state.environment;
}

/** Reduces a journaled stream, upcasting each historic event to its current version first. */
export function replayWorldEvents(
  state: WorldState,
  events: readonly HistoricWorldEvent[],
): WorldState {
  return events.reduce(
    (reduced, event) => reduceWorldEvent(reduced, upcastWorldEvent(event)),
    createWorldState(state),
  );
}

function requireEntity(state: WorldState, objectId: ObjectId): WorldEntity {
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  if (entity === undefined)
    throw new DomainValidationError("objectId", "does not reference a declared entity");
  return entity;
}

function requireShelter(state: WorldState, entity: WorldEntity, objectId: ObjectId): void {
  const shelter = requireEntity(state, objectId);
  if (
    shelter.shelter === undefined ||
    shelter.spaceId !== entity.spaceId ||
    shelter.pose.frameId !== entity.pose.frameId ||
    shelter.pose.frameVersion !== entity.pose.frameVersion
  ) {
    throw new DomainValidationError(
      "shelter",
      "must reference a shelter in the entity's space and semantic frame",
    );
  }
}

function validateAction(state: WorldState, entity: WorldEntity, action: RoutineAction): void {
  if (entity.needs === undefined)
    throw new DomainValidationError("action", "routine decisions require a needs component");
  if (action.kind === "seek-shelter") {
    if (action.targetObjectId === undefined)
      throw new DomainValidationError("action.targetObjectId", "shelter intent requires a target");
    requireShelter(state, entity, action.targetObjectId);
  } else if (action.kind === "seek-water" || action.kind === "seek-food") {
    if (action.targetObjectId === undefined) {
      if (action.kind === "seek-water")
        throw new DomainValidationError("action.targetObjectId", "water intent requires a target");
    } else {
      const holder = requireEntity(state, action.targetObjectId);
      if (holder.resource?.kind !== (action.kind === "seek-water" ? "water" : "food"))
        throw new DomainValidationError(
          "action.targetObjectId",
          `${action.kind} must reference a ${action.kind === "seek-water" ? "water" : "food"} holder`,
        );
    }
  } else if (action.kind === "stay") {
    if (action.targetObjectId !== undefined)
      throw new DomainValidationError(
        "action.targetObjectId",
        "this capability does not supply a destination for stay intent",
      );
  } else {
    throw new DomainValidationError("action.kind", "unsupported routine action");
  }
}

function requireVersion(version: number, path: string): void {
  if (version !== 1) throw new DomainValidationError(path, "unsupported schema version");
}

function requireName(name: string, path: string): void {
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name)
    throw new DomainValidationError(path, "must be a nonempty name without outer whitespace");
}

function requireBasisPoints(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000)
    throw new DomainValidationError(path, "must be integer basis points from zero through 10000");
}

function requireTime(value: bigint, path: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SIM_TIME)
    throw new DomainValidationError(
      path,
      "must be nonnegative signed-64-bit simulation milliseconds",
    );
}

function uniqueNames(names: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    requireName(name, path);
    if (seen.has(name)) throw new DomainValidationError(path, "names must be unique");
    seen.add(name);
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function frozenCopy<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value))
      throw new DomainValidationError("state", "must not contain cyclic values");
    ancestors.add(value);
    const copy = Array.isArray(value)
      ? Object.freeze(value.map((item: unknown) => frozenCopy(item, ancestors)))
      : Object.freeze(
          Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, frozenCopy(item, ancestors)]),
          ),
        );
    ancestors.delete(value);
    return copy as T;
  }
  return value;
}

function unsupportedEvent(_event: never): never {
  throw new DomainValidationError("event.type", "unsupported semantic event type");
}
