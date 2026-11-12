import type {
  ActionId,
  AuthorityDecisionId,
  CommandId,
  CorrelationId,
  EventId,
  ObjectId,
  SpaceId,
  SpatialFrameId,
  TenantId,
  TimelineId,
  WorldId,
} from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import { decodeFeedSummary, type FeedSummary } from "./scene-interactions.js";
import {
  array,
  bigintValue,
  ContractDecodeError,
  exactKeys,
  literal,
  literalVersion,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

export interface BrowserScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly spaceId: SpaceId;
}
/** Public intent only: authority is resolved by the server. Decimal epochs are JSON safe. */
export interface RuntimeNoOpRequest extends BrowserScope {
  readonly commandId: CommandId;
  readonly actionId: ActionId;
  readonly eventId: EventId;
  readonly authorityDecisionId: AuthorityDecisionId;
  readonly routingEpoch: string;
  readonly authorityEpoch: string;
  readonly expectedProjectionRevision: string;
  readonly issuedAt: string;
}
export function decodeRuntimeNoOpRequest(value: unknown): RuntimeNoOpRequest {
  const v = record(value, "request");
  exactKeys(
    v,
    [
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "commandId",
      "actionId",
      "eventId",
      "authorityDecisionId",
      "routingEpoch",
      "authorityEpoch",
      "expectedProjectionRevision",
      "issuedAt",
    ],
    [],
    "request",
  );
  function decimal(value: unknown, field: string): string {
    const result = string(value, field);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(result))
      throw new TypeError(`${field} must be a non-negative decimal string`);
    return result;
  }
  return {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    commandId: decodeOpaqueId(v.commandId, "CommandId"),
    actionId: decodeOpaqueId(v.actionId, "ActionId"),
    eventId: decodeOpaqueId(v.eventId, "EventId"),
    authorityDecisionId: decodeOpaqueId(v.authorityDecisionId, "AuthorityDecisionId"),
    routingEpoch: decimal(v.routingEpoch, "routingEpoch"),
    authorityEpoch: decimal(v.authorityEpoch, "authorityEpoch"),
    expectedProjectionRevision: decimal(v.expectedProjectionRevision, "expectedProjectionRevision"),
    issuedAt: string(v.issuedAt, "issuedAt"),
  };
}
export interface RuntimeNoOpResponse {
  readonly accepted: true;
  readonly correlationId: CorrelationId;
  readonly disposition: "rehydrated" | "reconciled" | "unchanged";
}
export function decodeRuntimeNoOpResponse(value: unknown): RuntimeNoOpResponse {
  const v = record(value, "response");
  exactKeys(v, ["accepted", "correlationId", "disposition"], [], "response");
  if (
    v.accepted !== true ||
    !["rehydrated", "reconciled", "unchanged"].includes(String(v.disposition))
  )
    throw new TypeError("invalid no-op response");
  return {
    accepted: true,
    correlationId: decodeOpaqueId(v.correlationId, "CorrelationId"),
    disposition: v.disposition as RuntimeNoOpResponse["disposition"],
  };
}
/** Closed public scene vocabulary. No arbitrary payload or authority-bearing context. */
export interface SceneEntity {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}
export interface DiagnosticSceneProjection extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly revision: number;
  readonly title: string;
  readonly entities: readonly SceneEntity[];
}
export interface ProjectionConnect extends BrowserScope {
  readonly version: 1;
  readonly type: "connect";
  readonly correlationId: CorrelationId;
  readonly resumeRevision: number | null;
}
export type ProjectionMessage =
  | {
      readonly version: 1;
      readonly type: "snapshot";
      readonly correlationId: CorrelationId;
      readonly scene: DiagnosticSceneProjection;
    }
  | {
      readonly version: 1;
      readonly type: "patch";
      readonly correlationId: CorrelationId;
      readonly scope: BrowserScope;
      readonly fromRevision: number;
      readonly revision: number;
      readonly entities: readonly SceneEntity[];
    }
  | { readonly version: 1; readonly type: "unavailable"; readonly correlationId: CorrelationId };
/** The observer world directory read names no scope: the authenticated principal is its key. */
export interface WorldDirectoryRequest {
  readonly version: 1;
}
/** One observable scope with its world and space labels. */
export interface WorldDirectoryEntry extends BrowserScope {
  readonly worldLabel: string;
  readonly spaceLabel: string;
}
export interface WorldDirectory {
  readonly version: 1;
  readonly entries: readonly WorldDirectoryEntry[];
}
export function decodeWorldDirectoryRequest(value: unknown): WorldDirectoryRequest {
  const v = record(value, "directoryRequest");
  exactKeys(v, ["version"], [], "directoryRequest");
  literalVersion(v.version, 1, "directoryRequest.version");
  return { version: 1 };
}
export function decodeWorldDirectory(value: unknown): WorldDirectory {
  const v = record(value, "directory");
  exactKeys(v, ["version", "entries"], [], "directory");
  literalVersion(v.version, 1, "directory.version");
  return {
    version: 1,
    entries: array(v.entries, "directory.entries", (item, path) => {
      const e = record(item, path);
      exactKeys(
        e,
        ["tenantId", "worldId", "timelineId", "spaceId", "worldLabel", "spaceLabel"],
        [],
        path,
      );
      return {
        ...decodeBrowserScope({
          tenantId: e.tenantId,
          worldId: e.worldId,
          timelineId: e.timelineId,
          spaceId: e.spaceId,
        }),
        worldLabel: string(e.worldLabel, `${path}.worldLabel`),
        spaceLabel: string(e.spaceLabel, `${path}.spaceLabel`),
      };
    }),
  };
}
/** A world's arrival readiness for an observer (`POST /v1/runtime/world-readiness`). */
export type WorldReadiness =
  | { readonly version: 1; readonly readiness: "ready" }
  | { readonly error: "world_not_ready"; readonly readiness: "provisioning" | "failed" };
export function decodeWorldReadiness(value: unknown): WorldReadiness {
  const v = record(value, "readiness");
  if ("error" in v) {
    exactKeys(v, ["error", "readiness"], [], "readiness");
    if (
      v.error !== "world_not_ready" ||
      (v.readiness !== "provisioning" && v.readiness !== "failed")
    )
      throw new ContractDecodeError("readiness", "unsupported readiness refusal");
    return { error: "world_not_ready", readiness: v.readiness };
  }
  exactKeys(v, ["version", "readiness"], [], "readiness");
  literalVersion(v.version, 1, "readiness.version");
  if (v.readiness !== "ready")
    throw new ContractDecodeError("readiness.readiness", "expected ready");
  return { version: 1, readiness: "ready" };
}
export function decodeBrowserScope(value: unknown): BrowserScope {
  const v = record(value, "scope");
  exactKeys(v, ["tenantId", "worldId", "timelineId", "spaceId"], [], "scope");
  return {
    tenantId: decodeOpaqueId(v.tenantId, "TenantId"),
    worldId: decodeOpaqueId(v.worldId, "WorldId"),
    timelineId: decodeOpaqueId(v.timelineId, "TimelineId"),
    spaceId: decodeOpaqueId(v.spaceId, "SpaceId"),
  };
}
function decodeEntity(value: unknown): SceneEntity {
  const v = record(value, "entity");
  exactKeys(v, ["id", "label", "description"], [], "entity");
  return {
    id: string(v.id, "id"),
    label: string(v.label, "label"),
    description: string(v.description, "description"),
  };
}
export function decodeDiagnosticSceneProjection(value: unknown): DiagnosticSceneProjection {
  const v = record(value, "scene");
  exactKeys(
    v,
    [
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "version",
      "privacyClass",
      "revision",
      "title",
      "entities",
    ],
    [],
    "scene",
  );
  literalVersion(v.version, 1, "version");
  if (v.privacyClass !== "public_scene") throw new TypeError("scene must be public");
  return {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    version: 1,
    privacyClass: "public_scene",
    revision: nonNegativeInteger(v.revision, "revision"),
    title: string(v.title, "title"),
    entities: array(v.entities, "entities", decodeEntity),
  };
}
export function decodeProjectionMessage(value: unknown): ProjectionMessage {
  const v = record(value, "message");
  literalVersion(v.version, 1, "version");
  const correlationId = decodeOpaqueId(v.correlationId, "CorrelationId");
  const common = ["version", "type", "correlationId"];
  if (v.type === "snapshot") {
    exactKeys(v, [...common, "scene"], [], "message");
    return {
      version: 1,
      type: "snapshot",
      correlationId,
      scene: decodeDiagnosticSceneProjection(v.scene),
    };
  }
  if (v.type === "patch") {
    exactKeys(v, [...common, "scope", "fromRevision", "revision", "entities"], [], "message");
    const fromRevision = nonNegativeInteger(v.fromRevision, "fromRevision");
    const revision = nonNegativeInteger(v.revision, "revision");
    if (revision <= fromRevision) throw new TypeError("patch must advance revision");
    return {
      version: 1,
      type: "patch",
      correlationId,
      scope: decodeBrowserScope(v.scope),
      fromRevision,
      revision,
      entities: array(v.entities, "entities", decodeEntity),
    };
  }
  exactKeys(v, common, [], "message");
  if (v.type !== "unavailable") throw new TypeError("unknown projection message");
  return { version: 1, type: "unavailable", correlationId };
}

/** HTTP observation has its own version; diagnostic socket messages remain unchanged. */
export interface ObservationRequest extends BrowserScope {
  readonly version: 1;
}
export interface LivingWeather {
  readonly rainIntensity: number;
}
export interface LivingUnit {
  readonly name: string;
  readonly fractionalDigits: number;
}
export interface LivingAxis {
  readonly name: string;
  readonly positiveDirection: string;
}
export interface LivingAxes {
  readonly axes: readonly LivingAxis[];
}
export interface LivingGravity {
  readonly kind: "constant-vector";
  readonly vector: readonly string[];
}
export interface LivingTransform {
  readonly version: number;
  readonly translation: readonly string[];
  readonly basis: readonly (readonly string[])[];
}
export interface LivingSpatialFrame {
  readonly frameId: SpatialFrameId;
  readonly version: number;
  readonly dimensions: 2 | 3;
  readonly unit: LivingUnit;
  readonly axes: LivingAxes;
  readonly origin: readonly string[];
  readonly gravity: LivingGravity;
  readonly parentFrameId?: SpatialFrameId;
  readonly parentTransform?: LivingTransform;
}
export interface LivingPose {
  readonly frameId: SpatialFrameId;
  readonly frameVersion: number;
  readonly coordinates: readonly string[];
}
export interface PlaceholderPresentation {
  readonly kind: "placeholder";
  readonly label: string;
}
export interface LivingEntity {
  readonly objectId: ObjectId;
  readonly archetypeId: string;
  readonly pose: LivingPose;
  readonly presentation: PlaceholderPresentation;
}
export interface LivingScene extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly revision: string;
  readonly simulationTime: string;
  readonly weather: LivingWeather;
  readonly frames: readonly LivingSpatialFrame[];
  readonly entities: readonly LivingEntity[];
}

export function decodeObservationRequest(value: unknown): ObservationRequest {
  const v = record(value, "observation");
  exactKeys(v, ["version", "tenantId", "worldId", "timelineId", "spaceId"], [], "observation");
  literalVersion(v.version, 1, "observation.version");
  return {
    version: 1,
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
  };
}
function observationDecimal(value: unknown, path: string): string {
  const text = string(value, path);
  if (bigintValue(text, path).toString() !== text)
    throw new ContractDecodeError(path, "expected a canonical decimal string");
  return text;
}
function observationUnsigned(value: unknown, path: string): string {
  const text = observationDecimal(value, path);
  if (text.startsWith("-"))
    throw new ContractDecodeError(path, "expected a non-negative decimal string");
  return text;
}
function observationPositive(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result === 0) throw new ContractDecodeError(path, "expected a positive integer");
  return result;
}
function observationVector(value: unknown, path: string): readonly string[] {
  return array(value, path, observationDecimal);
}
export function decodeLivingFrame(value: unknown, path: string): LivingSpatialFrame {
  const v = record(value, path);
  exactKeys(
    v,
    ["frameId", "version", "dimensions", "unit", "axes", "origin", "gravity"],
    ["parentFrameId", "parentTransform"],
    path,
  );
  const dimensions = v.dimensions;
  if (dimensions !== 2 && dimensions !== 3)
    throw new ContractDecodeError(path, "expected two or three dimensions");
  const unit = record(v.unit, `${path}.unit`);
  exactKeys(unit, ["name", "fractionalDigits"], [], `${path}.unit`);
  const fractionalDigits = nonNegativeInteger(
    unit.fractionalDigits,
    `${path}.unit.fractionalDigits`,
  );
  // The canonical domain spatial encoding limits fixed-point scale to eighteen digits.
  if (fractionalDigits > 18)
    throw new ContractDecodeError(`${path}.unit.fractionalDigits`, "scale exceeds eighteen");
  const axes = record(v.axes, `${path}.axes`);
  exactKeys(axes, ["axes"], [], `${path}.axes`);
  const decodedAxes = array(axes.axes, `${path}.axes.axes`, (value, path) => {
    const axis = record(value, path);
    exactKeys(axis, ["name", "positiveDirection"], [], path);
    return {
      name: string(axis.name, `${path}.name`),
      positiveDirection: string(axis.positiveDirection, `${path}.positiveDirection`),
    };
  });
  const gravity = record(v.gravity, `${path}.gravity`);
  exactKeys(gravity, ["kind", "vector"], [], `${path}.gravity`);
  if (gravity.kind !== "constant-vector")
    throw new ContractDecodeError(`${path}.gravity.kind`, "unknown gravity");
  const origin = observationVector(v.origin, `${path}.origin`);
  const vector = observationVector(gravity.vector, `${path}.gravity.vector`);
  if (
    origin.length !== dimensions ||
    vector.length !== dimensions ||
    decodedAxes.length !== dimensions ||
    new Set(decodedAxes.map((axis) => axis.name)).size !== dimensions
  )
    throw new ContractDecodeError(path, "inconsistent frame dimensions or axes");
  const frameId = decodeOpaqueId(v.frameId, "SpatialFrameId");
  const frame: LivingSpatialFrame = {
    frameId,
    version: observationPositive(v.version, `${path}.version`),
    dimensions,
    unit: { name: string(unit.name, `${path}.unit.name`), fractionalDigits },
    axes: { axes: decodedAxes },
    origin,
    gravity: { kind: "constant-vector", vector },
  };
  if ((v.parentFrameId === undefined) !== (v.parentTransform === undefined))
    throw new ContractDecodeError(path, "parent frame and transform must be paired");
  if (v.parentFrameId === undefined) return frame;
  const parentFrameId = decodeOpaqueId(v.parentFrameId, "SpatialFrameId");
  if (parentFrameId === frameId) throw new ContractDecodeError(path, "frame cannot parent itself");
  const transform = record(v.parentTransform, `${path}.parentTransform`);
  exactKeys(transform, ["version", "translation", "basis"], [], `${path}.parentTransform`);
  const translation = observationVector(
    transform.translation,
    `${path}.parentTransform.translation`,
  );
  const basis = array(transform.basis, `${path}.parentTransform.basis`, observationVector);
  if (
    translation.length !== dimensions ||
    basis.length !== dimensions ||
    basis.some((row) => row.length !== dimensions)
  )
    throw new ContractDecodeError(path, "inconsistent transform dimensions");
  return {
    ...frame,
    parentFrameId,
    parentTransform: {
      version: observationPositive(transform.version, `${path}.parentTransform.version`),
      translation,
      basis,
    },
  };
}
export function decodeLivingPose(value: unknown, path: string): LivingPose {
  const pose = record(value, path);
  exactKeys(pose, ["frameId", "frameVersion", "coordinates"], [], path);
  return {
    frameId: decodeOpaqueId(pose.frameId, "SpatialFrameId"),
    frameVersion: observationPositive(pose.frameVersion, `${path}.frameVersion`),
    coordinates: observationVector(pose.coordinates, `${path}.coordinates`),
  };
}
export function decodeLivingEntity(value: unknown, path: string): LivingEntity {
  const v = record(value, path);
  exactKeys(v, ["objectId", "archetypeId", "pose", "presentation"], [], path);
  const pose = decodeLivingPose(v.pose, `${path}.pose`);
  const presentation = record(v.presentation, `${path}.presentation`);
  exactKeys(presentation, ["kind", "label"], [], `${path}.presentation`);
  if (presentation.kind !== "placeholder")
    throw new ContractDecodeError(path, "unknown presentation binding");
  return {
    objectId: decodeOpaqueId(v.objectId, "ObjectId"),
    archetypeId: string(v.archetypeId, `${path}.archetypeId`),
    pose,
    presentation: {
      kind: "placeholder",
      label: string(presentation.label, `${path}.presentation.label`),
    },
  };
}
export function decodeLivingWeather(value: unknown, path = "weather"): LivingWeather {
  const weather = record(value, path);
  exactKeys(weather, ["rainIntensity"], [], path);
  const rainIntensity = nonNegativeInteger(weather.rainIntensity, `${path}.rainIntensity`);
  // Canonical weather uses basis points from zero through 10000 (domain world contract).
  if (rainIntensity > 10_000)
    throw new ContractDecodeError(`${path}.rainIntensity`, "exceeds basis-point range");
  return { rainIntensity };
}
export function decodeLivingScene(value: unknown): LivingScene {
  const v = record(value, "scene");
  exactKeys(
    v,
    [
      "version",
      "privacyClass",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "revision",
      "simulationTime",
      "weather",
      "frames",
      "entities",
    ],
    [],
    "scene",
  );
  literalVersion(v.version, 1, "scene.version");
  if (v.privacyClass !== "public_scene")
    throw new ContractDecodeError("scene.privacyClass", "expected public_scene");
  const weather = decodeLivingWeather(v.weather, "scene.weather");
  const frames = array(v.frames, "scene.frames", decodeLivingFrame);
  const entities = array(v.entities, "scene.entities", decodeLivingEntity);
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  if (
    frameById.size !== frames.length ||
    new Set(entities.map((entity) => entity.objectId)).size !== entities.length
  )
    throw new ContractDecodeError("scene", "duplicate identity");
  for (const entity of entities) {
    const frame = frameById.get(entity.pose.frameId);
    if (
      !frame ||
      frame.version !== entity.pose.frameVersion ||
      frame.dimensions !== entity.pose.coordinates.length
    )
      throw new ContractDecodeError("scene.entities", "pose must reference a supplied frame");
  }
  return {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    version: 1,
    privacyClass: "public_scene",
    revision: observationUnsigned(v.revision, "scene.revision"),
    simulationTime: observationUnsigned(v.simulationTime, "scene.simulationTime"),
    weather,
    frames,
    entities,
  };
}

/** The closed semantic categories of material feed items. */
export type WorldFeedCategory =
  | "weather"
  | "routine"
  | "wellbeing"
  | "growth"
  | "movement"
  | "portal"
  | "resource";
const WORLD_FEED_CATEGORIES: readonly WorldFeedCategory[] = [
  "weather",
  "routine",
  "wellbeing",
  "growth",
  "movement",
  "portal",
  "resource",
];
/**
 * The canonical timeline clock. `speed` is simulation ms per wall ms. `dayLengthMs` is the installed
 * pack's environment day length; `day` is floor(simulationTime / dayLengthMs) + 1 and `timeOfDayMs`
 * is simulationTime mod dayLengthMs. All three are null when the pack declares no day length.
 */
export interface WorldClock {
  readonly simulationTime: string;
  readonly runState: "running" | "paused";
  readonly speed: number;
  readonly dayLengthMs: string | null;
  readonly day: string | null;
  readonly timeOfDayMs: string | null;
}
/** One material public journal event; `objectId` is null when no single entity applies. */
export interface WorldFeedItem extends FeedSummary {
  readonly category: WorldFeedCategory;
  readonly objectId: ObjectId | null;
}
/** The observer clock-and-feed read's answer to an `ObservationRequest`; `feed` is newest first. */
export interface WorldStatus extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly revision: string;
  readonly clock: WorldClock;
  readonly feed: readonly WorldFeedItem[];
}
function decodeWorldClock(value: unknown): WorldClock {
  const path = "status.clock";
  const v = record(value, path);
  exactKeys(
    v,
    ["simulationTime", "runState", "speed", "dayLengthMs", "day", "timeOfDayMs"],
    [],
    path,
  );
  const simulationTime = observationUnsigned(v.simulationTime, `${path}.simulationTime`);
  const calendar =
    v.dayLengthMs === null
      ? null
      : BigInt(observationUnsigned(v.dayLengthMs, `${path}.dayLengthMs`));
  if (calendar === 0n)
    throw new ContractDecodeError(`${path}.dayLengthMs`, "expected a positive day length");
  const day = calendar === null ? null : (BigInt(simulationTime) / calendar + 1n).toString();
  const timeOfDayMs = calendar === null ? null : (BigInt(simulationTime) % calendar).toString();
  if (v.day !== day || v.timeOfDayMs !== timeOfDayMs)
    throw new ContractDecodeError(path, "day and time of day must follow the day length");
  return {
    simulationTime,
    runState: literal(v.runState, ["running", "paused"], `${path}.runState`),
    speed: observationPositive(v.speed, `${path}.speed`),
    dayLengthMs: calendar === null ? null : calendar.toString(),
    day,
    timeOfDayMs,
  };
}
export function decodeWorldStatus(value: unknown): WorldStatus {
  const v = record(value, "status");
  exactKeys(
    v,
    [
      "version",
      "privacyClass",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "revision",
      "clock",
      "feed",
    ],
    [],
    "status",
  );
  literalVersion(v.version, 1, "status.version");
  if (v.privacyClass !== "public_scene")
    throw new ContractDecodeError("status.privacyClass", "expected public_scene");
  return {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    version: 1,
    privacyClass: "public_scene",
    revision: observationUnsigned(v.revision, "status.revision"),
    clock: decodeWorldClock(v.clock),
    feed: array(v.feed, "status.feed", (item, path) => {
      const { category, objectId, ...summary } = record(item, path);
      return {
        ...decodeFeedSummary(summary, path),
        category: literal(category, WORLD_FEED_CATEGORIES, `${path}.category`),
        objectId:
          objectId === null ? null : decodeOpaqueId(objectId, "ObjectId", `${path}.objectId`),
      };
    }),
  };
}
/** The JSON form of a `WorldStatus`: each feed item's simulation time as a decimal string. */
export function encodeWorldStatus(value: WorldStatus): Record<string, unknown> {
  return {
    ...value,
    feed: value.feed.map((item) => ({ ...item, simTimeMs: item.simTimeMs.toString() })),
  };
}

/** Public physical selection vocabulary; no arbitrary component or cognition payloads. */
export interface SelectionCursor {
  readonly observedRevision: string;
  readonly beforeSequence: string;
}
export interface EntitySelectionRequest extends BrowserScope {
  readonly version: 1;
  readonly objectId: ObjectId;
  readonly cursor?: SelectionCursor;
}
export interface SelectionNeeds {
  readonly hunger: number;
  readonly wetness: number;
  readonly integratedAt: string;
  readonly hungerRemainder: string;
  readonly wetnessRemainder: string;
}
export interface SelectionWellbeing {
  readonly thirst: number;
  readonly health: number;
  readonly comfort: "comfortable" | "uncomfortable";
  readonly integratedAt: string;
  readonly thirstRemainder: string;
  readonly healthRemainder: string;
}
export interface SelectionPlant {
  readonly stage: number;
  readonly growingMs: string;
  readonly wetness: number;
  readonly wetnessRemainder: string;
  readonly integratedAt: string;
}
export interface SelectionValues {
  readonly needs: SelectionNeeds | null;
  readonly wellbeing: SelectionWellbeing | null;
  readonly plant: SelectionPlant | null;
}
export interface SelectionResource {
  readonly kind: "food" | "water";
  readonly quantity: number;
}
export interface SelectionShelter {
  readonly rainProtection: number;
}
export interface SelectionAction {
  readonly kind: "stay" | "seek-food" | "seek-shelter" | "seek-water";
  readonly targetObjectId: ObjectId | null;
}
export interface SelectionPhysical extends SelectionValues {
  readonly resource: SelectionResource | null;
  readonly shelter: SelectionShelter | null;
  readonly locationId: ObjectId | null;
  readonly selectedAction: SelectionAction | null;
  readonly lifecycle: "active" | "retired" | "dead" | null;
}
export interface SelectionCurrentWellbeing {
  readonly thirst: number;
  readonly health: number;
  readonly thirstRemainder: string;
  readonly healthRemainder: string;
}
export interface SelectionCurrentPlant {
  readonly growingMs: string;
  readonly wetness: number;
  readonly wetnessRemainder: string;
}
export interface SelectionDerived {
  readonly needs: SelectionNeeds | null;
  readonly wellbeing: SelectionCurrentWellbeing | null;
  readonly plant: SelectionCurrentPlant | null;
  readonly canonical: false;
  readonly simulationTime: string;
}
export interface PublicActionSummary {
  readonly eventId: EventId;
  readonly actionId: ActionId;
  readonly commandId: CommandId;
  readonly type: string;
  readonly partitionSequence: string;
  readonly simulationTime: string;
  readonly recordedAt: string;
}
export interface SelectionHistory {
  readonly observedRevision: string;
  readonly actions: readonly PublicActionSummary[];
  readonly beforeSequence: string | null;
}
export interface EntitySelection extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly objectId: ObjectId;
  readonly evidence: typeof SELECTION_EVIDENCE;
  readonly revision: string;
  readonly simulationTime: string;
  readonly entity: LivingEntity;
  readonly physical: SelectionPhysical;
  readonly derived: SelectionDerived;
  readonly history: SelectionHistory;
}

export function decodeEntitySelectionRequest(value: unknown): EntitySelectionRequest {
  const v = record(value, "selection");
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId", "objectId"],
    ["cursor"],
    "selection",
  );
  const scope = decodeObservationRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
  });
  let cursor: SelectionCursor | undefined;
  if (v.cursor !== undefined) {
    const c = record(v.cursor, "selection.cursor");
    exactKeys(c, ["observedRevision", "beforeSequence"], [], "selection.cursor");
    cursor = {
      observedRevision: observationUnsigned(
        c.observedRevision,
        "selection.cursor.observedRevision",
      ),
      beforeSequence: observationUnsigned(c.beforeSequence, "selection.cursor.beforeSequence"),
    };
  }
  return {
    ...scope,
    objectId: decodeOpaqueId(v.objectId, "ObjectId"),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
function decodeSelectionNeeds(value: unknown, path: string): SelectionNeeds | null {
  if (value === null) return null;
  const v = record(value, path);
  exactKeys(
    v,
    ["hunger", "wetness", "integratedAt", "hungerRemainder", "wetnessRemainder"],
    [],
    path,
  );
  return {
    hunger: nonNegativeInteger(v.hunger, `${path}.hunger`),
    wetness: nonNegativeInteger(v.wetness, `${path}.wetness`),
    integratedAt: observationUnsigned(v.integratedAt, `${path}.integratedAt`),
    hungerRemainder: observationUnsigned(v.hungerRemainder, `${path}.hungerRemainder`),
    wetnessRemainder: observationUnsigned(v.wetnessRemainder, `${path}.wetnessRemainder`),
  };
}
function decodeSelectionWellbeing(value: unknown, path: string): SelectionWellbeing | null {
  if (value === null) return null;
  const v = record(value, path);
  exactKeys(
    v,
    ["thirst", "health", "comfort", "integratedAt", "thirstRemainder", "healthRemainder"],
    [],
    path,
  );
  if (v.comfort !== "comfortable" && v.comfort !== "uncomfortable")
    throw new ContractDecodeError(path, "unknown comfort");
  return {
    thirst: nonNegativeInteger(v.thirst, `${path}.thirst`),
    health: nonNegativeInteger(v.health, `${path}.health`),
    comfort: v.comfort,
    integratedAt: observationUnsigned(v.integratedAt, `${path}.integratedAt`),
    thirstRemainder: observationUnsigned(v.thirstRemainder, `${path}.thirstRemainder`),
    healthRemainder: observationUnsigned(v.healthRemainder, `${path}.healthRemainder`),
  };
}
function decodeSelectionPlant(value: unknown, path: string): SelectionPlant | null {
  if (value === null) return null;
  const v = record(value, path);
  exactKeys(v, ["stage", "growingMs", "wetness", "wetnessRemainder", "integratedAt"], [], path);
  return {
    stage: nonNegativeInteger(v.stage, `${path}.stage`),
    growingMs: observationUnsigned(v.growingMs, `${path}.growingMs`),
    wetness: nonNegativeInteger(v.wetness, `${path}.wetness`),
    wetnessRemainder: observationUnsigned(v.wetnessRemainder, `${path}.wetnessRemainder`),
    integratedAt: observationUnsigned(v.integratedAt, `${path}.integratedAt`),
  };
}
function decodeSelectionValues(v: Record<string, unknown>, path: string): SelectionValues {
  return {
    needs: decodeSelectionNeeds(v.needs, `${path}.needs`),
    wellbeing: decodeSelectionWellbeing(v.wellbeing, `${path}.wellbeing`),
    plant: decodeSelectionPlant(v.plant, `${path}.plant`),
  };
}
export function decodeEntitySelection(value: unknown): EntitySelection {
  const v = record(value, "selection");
  exactKeys(
    v,
    [
      "version",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "privacyClass",
      "objectId",
      "evidence",
      "revision",
      "simulationTime",
      "entity",
      "physical",
      "derived",
      "history",
    ],
    [],
    "selection",
  );
  const evidence = decodeEvidenceLabels(v.evidence, SELECTION_EVIDENCE, "selection.evidence");
  const request = decodeEntitySelectionRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
    objectId: v.objectId,
  });
  if (v.privacyClass !== "public_scene")
    throw new ContractDecodeError("selection.privacyClass", "expected public_scene");
  const entity = decodeLivingEntity(v.entity, "selection.entity");
  if (entity.objectId !== request.objectId)
    throw new ContractDecodeError("selection.entity", "identity mismatch");
  const physical = record(v.physical, "selection.physical");
  exactKeys(
    physical,
    [
      "needs",
      "wellbeing",
      "plant",
      "resource",
      "shelter",
      "locationId",
      "selectedAction",
      "lifecycle",
    ],
    [],
    "selection.physical",
  );
  let resource: SelectionResource | null = null;
  if (physical.resource !== null) {
    const r = record(physical.resource, "selection.physical.resource");
    exactKeys(r, ["kind", "quantity"], [], "selection.physical.resource");
    if (r.kind !== "food" && r.kind !== "water")
      throw new ContractDecodeError("selection.physical.resource", "unknown resource kind");
    resource = {
      kind: r.kind,
      quantity: nonNegativeInteger(r.quantity, "selection.physical.resource.quantity"),
    };
  }
  let shelter: SelectionShelter | null = null;
  if (physical.shelter !== null) {
    const s = record(physical.shelter, "selection.physical.shelter");
    exactKeys(s, ["rainProtection"], [], "selection.physical.shelter");
    shelter = {
      rainProtection: nonNegativeInteger(
        s.rainProtection,
        "selection.physical.shelter.rainProtection",
      ),
    };
  }
  const selectedAction =
    physical.selectedAction === null
      ? null
      : decodeSelectionAction(physical.selectedAction, "selection.physical.selectedAction");
  const lifecycle = physical.lifecycle;
  if (
    lifecycle !== null &&
    lifecycle !== "active" &&
    lifecycle !== "retired" &&
    lifecycle !== "dead"
  )
    throw new ContractDecodeError("selection.physical.lifecycle", "unknown lifecycle");
  const derived = record(v.derived, "selection.derived");
  exactKeys(
    derived,
    ["canonical", "simulationTime", "needs", "wellbeing", "plant"],
    [],
    "selection.derived",
  );
  if (derived.canonical !== false)
    throw new ContractDecodeError(
      "selection.derived.canonical",
      "derived values must be non-canonical",
    );
  let currentWellbeing: SelectionCurrentWellbeing | null = null;
  if (derived.wellbeing !== null) {
    const w = record(derived.wellbeing, "selection.derived.wellbeing");
    exactKeys(
      w,
      ["thirst", "health", "thirstRemainder", "healthRemainder"],
      [],
      "selection.derived.wellbeing",
    );
    currentWellbeing = {
      thirst: nonNegativeInteger(w.thirst, "selection.derived.wellbeing.thirst"),
      health: nonNegativeInteger(w.health, "selection.derived.wellbeing.health"),
      thirstRemainder: observationUnsigned(
        w.thirstRemainder,
        "selection.derived.wellbeing.thirstRemainder",
      ),
      healthRemainder: observationUnsigned(
        w.healthRemainder,
        "selection.derived.wellbeing.healthRemainder",
      ),
    };
  }
  let currentPlant: SelectionCurrentPlant | null = null;
  if (derived.plant !== null) {
    const p = record(derived.plant, "selection.derived.plant");
    exactKeys(p, ["growingMs", "wetness", "wetnessRemainder"], [], "selection.derived.plant");
    currentPlant = {
      growingMs: observationUnsigned(p.growingMs, "selection.derived.plant.growingMs"),
      wetness: nonNegativeInteger(p.wetness, "selection.derived.plant.wetness"),
      wetnessRemainder: observationUnsigned(
        p.wetnessRemainder,
        "selection.derived.plant.wetnessRemainder",
      ),
    };
  }
  const history = record(v.history, "selection.history");
  exactKeys(history, ["observedRevision", "actions", "beforeSequence"], [], "selection.history");
  const actions = array(
    history.actions,
    "selection.history.actions",
    (value, path): PublicActionSummary => {
      const a = record(value, path);
      exactKeys(
        a,
        [
          "eventId",
          "actionId",
          "commandId",
          "type",
          "partitionSequence",
          "simulationTime",
          "recordedAt",
        ],
        [],
        path,
      );
      return {
        eventId: decodeOpaqueId(a.eventId, "EventId"),
        actionId: decodeOpaqueId(a.actionId, "ActionId"),
        commandId: decodeOpaqueId(a.commandId, "CommandId"),
        type: string(a.type, `${path}.type`),
        partitionSequence: observationUnsigned(a.partitionSequence, `${path}.partitionSequence`),
        simulationTime: observationUnsigned(a.simulationTime, `${path}.simulationTime`),
        recordedAt: string(a.recordedAt, `${path}.recordedAt`),
      };
    },
  );
  const revision = observationUnsigned(v.revision, "selection.revision");
  const simulationTime = observationUnsigned(v.simulationTime, "selection.simulationTime");
  const derivedTime = observationUnsigned(
    derived.simulationTime,
    "selection.derived.simulationTime",
  );
  const observedRevision = observationUnsigned(
    history.observedRevision,
    "selection.history.observedRevision",
  );
  const beforeSequence =
    history.beforeSequence === null
      ? null
      : observationUnsigned(history.beforeSequence, "selection.history.beforeSequence");
  if (
    observedRevision !== revision ||
    BigInt(derivedTime) < BigInt(simulationTime) ||
    actions.some(
      (action, index) =>
        BigInt(action.partitionSequence) === 0n ||
        (index > 0 &&
          BigInt(actions[index - 1]?.partitionSequence ?? "0") <= BigInt(action.partitionSequence)),
    ) ||
    (beforeSequence !== null &&
      actions.some((action) => BigInt(beforeSequence) > BigInt(action.partitionSequence)))
  )
    throw new ContractDecodeError("selection", "inconsistent time or history ordering");
  return {
    ...request,
    privacyClass: "public_scene",
    evidence,
    revision,
    simulationTime,
    entity,
    physical: {
      ...decodeSelectionValues(physical, "selection.physical"),
      resource,
      shelter,
      locationId:
        physical.locationId === null ? null : decodeOpaqueId(physical.locationId, "ObjectId"),
      selectedAction,
      lifecycle,
    },
    derived: {
      needs: decodeSelectionNeeds(derived.needs, "selection.derived.needs"),
      wellbeing: currentWellbeing,
      plant: currentPlant,
      canonical: false,
      simulationTime: derivedTime,
    },
    history: { observedRevision, actions, beforeSequence },
  };
}

/**
 * The evidence class of an inspector value (Wave 3 §14, Wave 4 §11.1): `canonical` is PostgreSQL
 * journal truth as read; `derived` is computed from it (issue 740's earned-time values); `transient` is
 * request-local; `operational` is runtime or provider state observed at a time, possibly stale. The
 * one closed vocabulary for every inspector response (issue 852 the runtime-state view, issue 819 the rest).
 */
export const INSPECTOR_EVIDENCE_CLASSES = [
  "canonical",
  "derived",
  "transient",
  "operational",
] as const;
export type InspectorEvidenceClass = (typeof INSPECTOR_EVIDENCE_CLASSES)[number];

/** A response's evidence label map: exactly `expected`, so a relabelled part fails to decode. */
export function decodeEvidenceLabels<T extends Readonly<Record<string, InspectorEvidenceClass>>>(
  value: unknown,
  expected: T,
  path: string,
): T {
  const v = record(value, path);
  exactKeys(v, Object.keys(expected), [], path);
  for (const [key, label] of Object.entries(expected))
    if (literal(v[key], INSPECTOR_EVIDENCE_CLASSES, `${path}.${key}`) !== label)
      throw new ContractDecodeError(`${path}.${key}`, `expected ${label}`);
  return expected;
}

/** The selected-object view: journal state and history are canonical; issue 740's earned block derived. */
export const SELECTION_EVIDENCE = Object.freeze({
  entity: "canonical",
  physical: "canonical",
  derived: "derived",
  history: "canonical",
} as const satisfies Record<string, InspectorEvidenceClass>);

/** Recorded Why: the retained receipt, traces and schedule rows as read; links computed from them. */
export const RECORDED_WHY_EVIDENCE = Object.freeze({
  receipt: "canonical",
  traces: "canonical",
  schedules: "canonical",
  links: "derived",
} as const satisfies Record<string, InspectorEvidenceClass>);

/** Where a recorded Why traversal started: its command, one event, or one schedule row. */
export type RecordedWhyEntry =
  | { readonly commandId: CommandId }
  | { readonly eventId: EventId }
  | { readonly scheduleId: string; readonly idempotencyKey: string };

/** Recorded evidence only; no browser intent in this envelope can mutate world state. */
export type RecordedWhyRequest = BrowserScope & {
  readonly version: 1;
  readonly includeResourceCauses?: true;
} & RecordedWhyEntry;
export type PublicRoutineFeatureName =
  | "hunger"
  | "wetness"
  | "rain"
  | "protection"
  | "thirst"
  | "health"
  | "uncomfortable"
  | "U"
  | "travelMs"
  | "perceived"
  | "expectation"
  | "freshness";
export type PublicRoutineExclusion =
  | "outside-current-space-or-frame"
  | "no-rain-protection"
  | "not-perceived"
  | "unavailable"
  | "unreachable";
export interface PublicRoutineFeature {
  readonly name: PublicRoutineFeatureName;
  readonly value: string;
}
export interface PublicRoutineCandidate {
  readonly action: SelectionAction;
  readonly features: readonly PublicRoutineFeature[];
  readonly score: string;
  readonly excludedReason: PublicRoutineExclusion | null;
}
export interface PublicDecisionTrace {
  readonly draftIndex: number;
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
  readonly inputRevision: string;
  readonly simulationTime: string;
  readonly policyVersion: string;
  readonly selectionTier: "reflex" | "utility";
  readonly candidates: readonly PublicRoutineCandidate[];
  readonly selectedAction: SelectionAction;
}
export interface PublicDecisionEvidence {
  readonly status: "available" | "unavailable" | "redacted";
  readonly drafts: readonly PublicDecisionTrace[];
}
export interface PublicCausalLinks {
  readonly parents: readonly CommandId[];
  readonly children: readonly CommandId[];
}
/** A schedule row the recorded command scheduled or consumed: trigger and deadline (§11.1). */
export interface PublicScheduledAction {
  readonly scheduleId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly status: "pending" | "done";
  readonly scheduledBy: CommandId;
  readonly completedBy: CommandId | null;
}
export type PublicCausalEntry =
  | { readonly kind: "command" }
  | { readonly kind: "event"; readonly eventId: EventId }
  | {
      readonly kind: "scheduled-action";
      readonly scheduleId: string;
      readonly idempotencyKey: string;
    };
export interface PublicResourceCause {
  readonly eventId: EventId;
  readonly simulationTime: string;
  readonly cause: "rain" | "growth" | "transfer" | "boundary-exchange";
  readonly kind: "food" | "water";
  readonly quantity: number;
  readonly objectId: ObjectId;
  readonly fromObjectId?: ObjectId;
  readonly processId?: string;
  readonly boundaryId?: string;
  readonly boundaryName?: string;
  readonly actorId?: ObjectId;
  readonly direction?: "import" | "export";
}

function decodePublicResourceCause(value: unknown, path: string): PublicResourceCause {
  const v = record(value, path);
  exactKeys(
    v,
    ["eventId", "simulationTime", "cause", "kind", "quantity", "objectId"],
    ["fromObjectId", "processId", "boundaryId", "boundaryName", "actorId", "direction"],
    path,
  );
  const cause = literal(
    v.cause,
    ["rain", "growth", "transfer", "boundary-exchange"],
    `${path}.cause`,
  );
  const kind = literal(v.kind, ["food", "water"], `${path}.kind`);
  if (
    (cause === "transfer") !== (v.fromObjectId !== undefined) ||
    (cause !== "transfer" && v.processId !== undefined) ||
    (cause === "rain" && kind !== "water") ||
    (cause === "growth" && kind !== "food") ||
    ["boundaryId", "boundaryName", "actorId", "direction"].some(
      (key) => (cause === "boundary-exchange") !== (v[key] !== undefined),
    )
  )
    throw new ContractDecodeError(path, "incompatible physical resource cause");
  return {
    eventId: decodeOpaqueId(v.eventId, "EventId", `${path}.eventId`),
    simulationTime: observationUnsigned(v.simulationTime, `${path}.simulationTime`),
    cause,
    kind,
    quantity: observationPositive(v.quantity, `${path}.quantity`),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    ...(v.fromObjectId === undefined
      ? {}
      : { fromObjectId: decodeOpaqueId(v.fromObjectId, "ObjectId", `${path}.fromObjectId`) }),
    ...(v.processId === undefined ? {} : { processId: string(v.processId, `${path}.processId`) }),
    ...(cause === "boundary-exchange"
      ? {
          boundaryId: string(v.boundaryId, `${path}.boundaryId`),
          boundaryName: string(v.boundaryName, `${path}.boundaryName`),
          actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
          direction: literal(v.direction, ["import", "export"], `${path}.direction`),
        }
      : {}),
  };
}

export interface RecordedWhy extends BrowserScope {
  readonly version: 1;
  readonly privacyClass: "public_scene";
  readonly evidence: typeof RECORDED_WHY_EVIDENCE;
  readonly entry: PublicCausalEntry;
  readonly commandId: CommandId;
  readonly actionId: ActionId | null;
  readonly channel?: string;
  readonly receiptStatus: "pending" | "committed" | "rejected" | "failed";
  readonly traces: PublicDecisionEvidence;
  readonly resourceCauses?: readonly PublicResourceCause[];
  readonly schedules: readonly PublicScheduledAction[];
  readonly links: PublicCausalLinks;
}
const WHY_SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"];
/** Exactly one entry: `commandId`, `eventId`, or `scheduleId` with `idempotencyKey`. */
export function decodeRecordedWhyRequest(value: unknown): RecordedWhyRequest {
  const v = record(value, "why");
  const entryKeys =
    "eventId" in v
      ? ["eventId"]
      : "scheduleId" in v
        ? ["scheduleId", "idempotencyKey"]
        : ["commandId"];
  exactKeys(v, [...WHY_SCOPE_KEYS, ...entryKeys], ["includeResourceCauses"], "why");
  if (v.includeResourceCauses !== undefined && v.includeResourceCauses !== true)
    throw new ContractDecodeError("why.includeResourceCauses", "expected true");
  const scope = decodeObservationRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
  });
  const entry: RecordedWhyEntry =
    "eventId" in v
      ? { eventId: decodeOpaqueId(v.eventId, "EventId") }
      : "scheduleId" in v
        ? {
            scheduleId: string(v.scheduleId, "why.scheduleId"),
            idempotencyKey: string(v.idempotencyKey, "why.idempotencyKey"),
          }
        : { commandId: decodeOpaqueId(v.commandId, "CommandId") };
  // Inspector audit ID bound, shared with apps/runtime/src/inspector.ts (migration 0022).
  for (const id of [
    scope.tenantId,
    scope.worldId,
    scope.timelineId,
    scope.spaceId,
    ...Object.values(entry),
  ])
    if (id === "" || new TextEncoder().encode(id).length > 1024)
      throw new ContractDecodeError("why", "inspector ID length out of range");
  return {
    ...scope,
    ...entry,
    ...(v.includeResourceCauses === true ? { includeResourceCauses: true as const } : {}),
  };
}
function decodePublicScheduledAction(value: unknown, path: string): PublicScheduledAction {
  const v = record(value, path);
  exactKeys(
    v,
    ["scheduleId", "idempotencyKey", "kind", "dueAt", "status", "scheduledBy", "completedBy"],
    [],
    path,
  );
  const status = literal(v.status, ["pending", "done"], `${path}.status`);
  const completedBy =
    v.completedBy === null
      ? null
      : decodeOpaqueId(v.completedBy, "CommandId", `${path}.completedBy`);
  if ((status === "done") !== (completedBy !== null))
    throw new ContractDecodeError(`${path}.completedBy`, "a done row names its completing command");
  return {
    scheduleId: string(v.scheduleId, `${path}.scheduleId`),
    idempotencyKey: string(v.idempotencyKey, `${path}.idempotencyKey`),
    kind: string(v.kind, `${path}.kind`),
    dueAt: observationUnsigned(v.dueAt, `${path}.dueAt`),
    status,
    scheduledBy: decodeOpaqueId(v.scheduledBy, "CommandId", `${path}.scheduledBy`),
    completedBy,
  };
}
function decodePublicCausalEntry(value: unknown): PublicCausalEntry {
  const v = record(value, "why.entry");
  const kind = literal(v.kind, ["command", "event", "scheduled-action"], "why.entry.kind");
  if (kind === "command") {
    exactKeys(v, ["kind"], [], "why.entry");
    return { kind };
  }
  if (kind === "event") {
    exactKeys(v, ["kind", "eventId"], [], "why.entry");
    return { kind, eventId: decodeOpaqueId(v.eventId, "EventId", "why.entry.eventId") };
  }
  exactKeys(v, ["kind", "scheduleId", "idempotencyKey"], [], "why.entry");
  return {
    kind,
    scheduleId: string(v.scheduleId, "why.entry.scheduleId"),
    idempotencyKey: string(v.idempotencyKey, "why.entry.idempotencyKey"),
  };
}
export function decodeSelectionAction(value: unknown, path: string): SelectionAction {
  const a = record(value, path);
  exactKeys(a, ["kind", "targetObjectId"], [], path);
  if (
    a.kind !== "stay" &&
    a.kind !== "seek-food" &&
    a.kind !== "seek-shelter" &&
    a.kind !== "seek-water"
  )
    throw new ContractDecodeError(path, "unknown action kind");
  return {
    kind: a.kind,
    targetObjectId: a.targetObjectId === null ? null : decodeOpaqueId(a.targetObjectId, "ObjectId"),
  };
}
export function decodePublicRoutineFeatureName(
  value: unknown,
  path: string,
): PublicRoutineFeatureName {
  if (
    value !== "hunger" &&
    value !== "wetness" &&
    value !== "rain" &&
    value !== "protection" &&
    value !== "thirst" &&
    value !== "health" &&
    value !== "uncomfortable" &&
    value !== "U" &&
    value !== "travelMs" &&
    value !== "perceived" &&
    value !== "expectation" &&
    value !== "freshness"
  )
    throw new ContractDecodeError(path, "unknown public routine feature");
  return value;
}
export function decodePublicRoutineExclusion(
  value: unknown,
  path: string,
): PublicRoutineExclusion | null {
  if (
    value !== null &&
    value !== "outside-current-space-or-frame" &&
    value !== "no-rain-protection" &&
    value !== "not-perceived" &&
    value !== "unavailable" &&
    value !== "unreachable"
  )
    throw new ContractDecodeError(path, "unknown public routine exclusion");
  return value;
}
function decodePublicRoutineCandidate(value: unknown, path: string): PublicRoutineCandidate {
  const v = record(value, path);
  exactKeys(v, ["action", "features", "score", "excludedReason"], [], path);
  const features = array(v.features, `${path}.features`, (value, path): PublicRoutineFeature => {
    const f = record(value, path);
    exactKeys(f, ["name", "value"], [], path);
    return {
      name: decodePublicRoutineFeatureName(f.name, `${path}.name`),
      value: observationDecimal(f.value, `${path}.value`),
    };
  });
  if (new Set(features.map((feature) => feature.name)).size !== features.length)
    throw new ContractDecodeError(path, "duplicate routine feature");
  return {
    action: decodeSelectionAction(v.action, `${path}.action`),
    features,
    score: observationDecimal(v.score, `${path}.score`),
    excludedReason: decodePublicRoutineExclusion(v.excludedReason, `${path}.excludedReason`),
  };
}
function decodePublicDecisionTrace(value: unknown, path: string): PublicDecisionTrace {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "draftIndex",
      "schemaVersion",
      "objectId",
      "inputRevision",
      "simulationTime",
      "policyVersion",
      "selectionTier",
      "candidates",
      "selectedAction",
    ],
    [],
    path,
  );
  literalVersion(v.schemaVersion, 1, `${path}.schemaVersion`);
  if (v.selectionTier !== "reflex" && v.selectionTier !== "utility")
    throw new ContractDecodeError(path, "unknown selection tier");
  return {
    draftIndex: nonNegativeInteger(v.draftIndex, `${path}.draftIndex`),
    schemaVersion: 1,
    objectId: decodeOpaqueId(v.objectId, "ObjectId"),
    inputRevision: observationUnsigned(v.inputRevision, `${path}.inputRevision`),
    simulationTime: observationUnsigned(v.simulationTime, `${path}.simulationTime`),
    policyVersion: string(v.policyVersion, `${path}.policyVersion`),
    selectionTier: v.selectionTier,
    candidates: array(v.candidates, `${path}.candidates`, decodePublicRoutineCandidate),
    selectedAction: decodeSelectionAction(v.selectedAction, `${path}.selectedAction`),
  };
}
export function decodeRecordedWhy(value: unknown): RecordedWhy {
  const v = record(value, "why");
  exactKeys(
    v,
    [
      "version",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "privacyClass",
      "evidence",
      "entry",
      "commandId",
      "actionId",
      "receiptStatus",
      "traces",
      "schedules",
      "links",
    ],
    ["resourceCauses", "channel"],
    "why",
  );
  const evidence = decodeEvidenceLabels(v.evidence, RECORDED_WHY_EVIDENCE, "why.evidence");
  const entry = decodePublicCausalEntry(v.entry);
  const schedules = array(v.schedules, "why.schedules", decodePublicScheduledAction);
  if (
    entry.kind === "scheduled-action" &&
    !schedules.some(
      (row) => row.scheduleId === entry.scheduleId && row.idempotencyKey === entry.idempotencyKey,
    )
  )
    throw new ContractDecodeError("why.entry", "the entry's schedule row is not listed");
  const request = decodeRecordedWhyRequest({
    version: v.version,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
    commandId: v.commandId,
  });
  if (v.privacyClass !== "public_scene")
    throw new ContractDecodeError("why.privacyClass", "expected public_scene");
  if (
    v.receiptStatus !== "pending" &&
    v.receiptStatus !== "committed" &&
    v.receiptStatus !== "rejected" &&
    v.receiptStatus !== "failed"
  )
    throw new ContractDecodeError("why.receiptStatus", "unknown receipt status");
  const t = record(v.traces, "why.traces");
  exactKeys(t, ["status", "drafts"], [], "why.traces");
  if (t.status !== "available" && t.status !== "unavailable" && t.status !== "redacted")
    throw new ContractDecodeError("why.traces.status", "unknown evidence status");
  const drafts = array(t.drafts, "why.traces.drafts", decodePublicDecisionTrace);
  if (t.status !== "available" && drafts.length !== 0)
    throw new ContractDecodeError("why.traces.drafts", "unavailable evidence cannot carry drafts");
  const links = record(v.links, "why.links");
  exactKeys(links, ["parents", "children"], [], "why.links");
  return {
    ...request,
    privacyClass: "public_scene",
    evidence,
    entry,
    commandId: decodeOpaqueId(v.commandId, "CommandId"),
    schedules,
    ...(v.resourceCauses === undefined
      ? {}
      : {
          resourceCauses: array(v.resourceCauses, "why.resourceCauses", decodePublicResourceCause),
        }),
    actionId: v.actionId === null ? null : decodeOpaqueId(v.actionId, "ActionId"),
    receiptStatus: v.receiptStatus,
    ...(v.channel === undefined ? {} : { channel: string(v.channel, "why.channel") }),
    traces: { status: t.status, drafts },
    links: {
      parents: array(links.parents, "why.links.parents", (value) =>
        decodeOpaqueId(value, "CommandId"),
      ),
      children: array(links.children, "why.links.children", (value) =>
        decodeOpaqueId(value, "CommandId"),
      ),
    },
  };
}

/** Projects a decoded retained kernel draft into the closed shared-browser vocabulary. */
export function decodePublicRoutineDraft(value: unknown, draftIndex: number): PublicDecisionTrace {
  const draft = record(value, "draft");
  if (draft.kind !== "routine") throw new ContractDecodeError("draft.kind", "expected routine");
  const d = record(draft.decision, "draft.decision");
  const action = (value: unknown, path: string): SelectionAction => {
    const a = record(value, path);
    return decodeSelectionAction({ kind: a.kind, targetObjectId: a.targetObjectId ?? null }, path);
  };
  const candidates = array(d.candidates, "draft.decision.candidates", (value, path) => {
    const c = record(value, path);
    const features = record(c.features, `${path}.features`);
    return {
      action: action(c.action, `${path}.action`),
      features: Object.entries(features).map(([name, value]) => ({
        name,
        value: bigintValue(value, `${path}.features.${name}`).toString(),
      })),
      score: bigintValue(c.score, `${path}.score`).toString(),
      excludedReason: c.excludedReason ?? null,
    };
  });
  return decodePublicDecisionTrace(
    {
      draftIndex,
      schemaVersion: d.schemaVersion,
      objectId: d.objectId,
      inputRevision: bigintValue(d.inputRevision, "draft.decision.inputRevision").toString(),
      simulationTime: bigintValue(d.simulationTime, "draft.decision.simulationTime").toString(),
      policyVersion: d.policyVersion,
      selectionTier: d.selectionTier,
      candidates,
      selectedAction: action(d.selectedAction, "draft.decision.selectedAction"),
    },
    "draft.decision",
  );
}
