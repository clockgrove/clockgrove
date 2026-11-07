import type {
  BrowserScope,
  LivingEntity,
  LivingPose,
  LivingSpatialFrame,
  LivingWeather,
} from "./browser-protocol.js";
import {
  decodeBrowserScope,
  decodeLivingEntity,
  decodeLivingFrame,
  decodeLivingPose,
  decodeLivingScene,
  decodeLivingWeather,
} from "./browser-protocol.js";
import type { EventId, ObjectId, PrincipalId, SpaceId } from "./ids.js";
import { decodeOpaqueId } from "./ids.js";
import type { InteractionSummary } from "./scene-interactions.js";
import { decodeInteractionSummary } from "./scene-interactions.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
  utcInstantKey,
  utcTimestamp,
  w3cTraceparent,
} from "./validation.js";

/** Successor freeze versions are independent of diagnostic v1 and HTTP LivingScene v1. */
export const SCENE_PROTOCOL_VERSION = 1;
export const SCENE_PROJECTION_VERSION = 1;
export const SCENE_ASSET_MANIFEST_VERSION = 1;
export const SCENE_CLIENT_VERSION = 1;
export type SceneLane = "projection" | "transient" | "operator";
export interface SceneEnvelope<T> extends BrowserScope {
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly lane: SceneLane;
  readonly type: string;
  readonly projectionRevision?: bigint;
  readonly sentAt: string;
  readonly traceparent?: string;
  readonly payload: T;
}
export interface SceneCompatibility {
  readonly projectionVersion: 1;
  readonly assetManifestVersion: 1;
  readonly clientVersion: 1;
}
export type SceneCompatibilityCode =
  | "unsupported_protocol_version"
  | "unsupported_projection_version"
  | "unsupported_asset_manifest_version"
  | "unsupported_client_version";
export class SceneCompatibilityError extends ContractDecodeError {
  constructor(
    readonly code: SceneCompatibilityCode,
    readonly actual: unknown,
    readonly expected: number,
    path: string,
  ) {
    super(
      path,
      `${code}; actual=${JSON.stringify(actual, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item))}; expected=${expected}`,
    );
    this.name = "SceneCompatibilityError";
  }
}
export function decodeSceneCompatibility(
  value: unknown,
  path = "compatibility",
): SceneCompatibility {
  const v = record(value, path);
  // Versions are checked before shape, so a newer peer that also adds or drops fields still
  // receives its stable compatibility code. An absent version is malformed, not newer, and
  // falls through to the generic missing-field error.
  if ("projectionVersion" in v && v.projectionVersion !== SCENE_PROJECTION_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_projection_version",
      v.projectionVersion,
      SCENE_PROJECTION_VERSION,
      `${path}.projectionVersion`,
    );
  if ("assetManifestVersion" in v && v.assetManifestVersion !== SCENE_ASSET_MANIFEST_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_asset_manifest_version",
      v.assetManifestVersion,
      SCENE_ASSET_MANIFEST_VERSION,
      `${path}.assetManifestVersion`,
    );
  if ("clientVersion" in v && v.clientVersion !== SCENE_CLIENT_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_client_version",
      v.clientVersion,
      SCENE_CLIENT_VERSION,
      `${path}.clientVersion`,
    );
  exactKeys(v, ["projectionVersion", "assetManifestVersion", "clientVersion"], [], path);
  return { projectionVersion: 1, assetManifestVersion: 1, clientVersion: 1 };
}
export interface SceneAudience {
  readonly kind: "observer";
  readonly hash: string;
  readonly spaceIds: readonly SpaceId[];
}
export function decodeSceneAudience(value: unknown, path = "audience"): SceneAudience {
  const v = record(value, path);
  exactKeys(v, ["kind", "hash", "spaceIds"], [], path);
  return {
    kind: literal(v.kind, ["observer"], `${path}.kind`),
    hash: string(v.hash, `${path}.hash`),
    spaceIds: array(v.spaceIds, `${path}.spaceIds`, (item, p) =>
      decodeOpaqueId(item, "SpaceId", p),
    ),
  };
}
export interface VisibleSpace {
  readonly spaceId: SpaceId;
  readonly label: string;
  readonly parentSpaceId?: SpaceId;
}
export interface ScenePresentationBinding {
  readonly objectId: ObjectId;
  readonly assetId: string;
  readonly animationFamily: string;
  readonly accessibilityLabel: string;
}
export type SceneProjectedEntity = LivingEntity;
/** The placed presentation effects the live yard may show; the client decides from weather and clock. */
export type SceneEffectRole = "puddle" | "lantern" | "window";
/** One placed effect of the installed pack's presentation, at a pose in a projected frame. */
export interface SceneEffect {
  readonly role: SceneEffectRole;
  readonly assetId: string;
  readonly animationFamily: string;
  readonly pose: LivingPose;
}
export function decodeSceneEffect(value: unknown, path = "effect"): SceneEffect {
  const v = record(value, path);
  exactKeys(v, ["role", "assetId", "animationFamily", "pose"], [], path);
  return {
    role: literal(v.role, ["puddle", "lantern", "window"], `${path}.role`),
    assetId: string(v.assetId, `${path}.assetId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    pose: decodeLivingPose(v.pose, `${path}.pose`),
  };
}
/**
 * A projected actor's scripted belief or memory about another object: relationship-private, so it is
 * present only in an audience whose ceiling allows `private_cognition`.
 */
export interface ScenePrivateCognition {
  readonly ref: string;
  readonly kind: "belief" | "memory";
  readonly actorId: ObjectId;
  readonly targetObjectId: ObjectId;
  readonly value: number;
}
export function decodeScenePrivateCognition(
  value: unknown,
  path = "cognition",
): ScenePrivateCognition {
  const v = record(value, path);
  exactKeys(v, ["ref", "kind", "actorId", "targetObjectId", "value"], [], path);
  return {
    ref: string(v.ref, `${path}.ref`),
    kind: literal(v.kind, ["belief", "memory"], `${path}.kind`),
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    targetObjectId: decodeOpaqueId(v.targetObjectId, "ObjectId", `${path}.targetObjectId`),
    value: integer(v.value, `${path}.value`),
  };
}
/** Distinct references, each held by a projected actor; never a hidden actor's cognition. */
function decodePrivateCognition(
  value: unknown,
  entities: readonly SceneProjectedEntity[],
  path: string,
): readonly ScenePrivateCognition[] {
  const projected = new Set(entities.map((entity) => entity.objectId));
  const refs = new Set<string>();
  return array(value, path, (item, p) => {
    const entry = decodeScenePrivateCognition(item, p);
    if (!projected.has(entry.actorId))
      throw new ContractDecodeError(`${p}.actorId`, "entity is not projected");
    if (refs.has(entry.ref)) throw new ContractDecodeError(`${p}.ref`, "duplicate reference");
    refs.add(entry.ref);
    return entry;
  });
}
export interface SceneProjection extends BrowserScope {
  readonly privacyClass: "public_scene";
  readonly compatibility: SceneCompatibility;
  readonly revision: bigint;
  readonly simulationTime: bigint;
  readonly weather: LivingWeather;
  readonly hierarchy: readonly VisibleSpace[];
  readonly frames: readonly LivingSpatialFrame[];
  readonly entities: readonly SceneProjectedEntity[];
  readonly presentationBindings: readonly ScenePresentationBinding[];
  readonly interactions: readonly InteractionSummary[];
  readonly feedCursor: string;
  readonly audienceHash: string;
  /** Absent unless the decided audience allows `private_cognition`. */
  readonly privateCognition?: readonly ScenePrivateCognition[];
  /** Absent when the installed pack places no effect in this scene. */
  readonly effects?: readonly SceneEffect[];
}
export function decodeVisibleSpace(value: unknown, path = "space"): VisibleSpace {
  const v = record(value, path);
  exactKeys(v, ["spaceId", "label"], ["parentSpaceId"], path);
  return {
    spaceId: decodeOpaqueId(v.spaceId, "SpaceId", `${path}.spaceId`),
    label: string(v.label, `${path}.label`),
    ...(v.parentSpaceId === undefined
      ? {}
      : { parentSpaceId: decodeOpaqueId(v.parentSpaceId, "SpaceId", `${path}.parentSpaceId`) }),
  };
}
/** Distinct spaces whose parents all lead, without a cycle, to a root, including the projected one. */
function decodeHierarchy(value: unknown, spaceId: SpaceId, path: string): readonly VisibleSpace[] {
  const hierarchy = array(value, path, decodeVisibleSpace);
  const parents = new Map<SpaceId, SpaceId | undefined>();
  hierarchy.forEach((space, index) => {
    if (parents.has(space.spaceId))
      throw new ContractDecodeError(`${path}[${index}].spaceId`, "duplicate space");
    parents.set(space.spaceId, space.parentSpaceId);
  });
  if (!parents.has(spaceId)) throw new ContractDecodeError(path, "missing the projected space");
  const rooted = new Set<SpaceId>();
  hierarchy.forEach((space, index) => {
    const chain = new Set<SpaceId>();
    for (let id: SpaceId | undefined = space.spaceId; id !== undefined && !rooted.has(id); ) {
      if (!parents.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "unknown parent");
      if (chain.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "cyclic hierarchy");
      chain.add(id);
      id = parents.get(id);
    }
    for (const id of chain) rooted.add(id);
  });
  return hierarchy;
}
/** Each binding or interaction names a distinct projected entity, never a hidden one. */
function projectedOnce<T>(
  items: readonly T[],
  entityId: (item: T) => ObjectId,
  entities: readonly SceneProjectedEntity[],
  path: string,
): readonly T[] {
  const projected = new Set(entities.map((entity) => entity.objectId));
  const seen = new Set<ObjectId>();
  items.forEach((item, index) => {
    const id = entityId(item);
    if (!projected.has(id))
      throw new ContractDecodeError(`${path}[${index}]`, "entity is not projected");
    if (seen.has(id)) throw new ContractDecodeError(`${path}[${index}]`, "duplicate entity");
    seen.add(id);
  });
  return items;
}
export function decodeScenePresentationBinding(
  value: unknown,
  path = "binding",
): ScenePresentationBinding {
  const v = record(value, path);
  exactKeys(v, ["objectId", "assetId", "animationFamily", "accessibilityLabel"], [], path);
  return {
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    assetId: string(v.assetId, `${path}.assetId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
  };
}
export function decodeSceneProjection(value: unknown, path = "projection"): SceneProjection {
  const v = record(value, path);
  const compatibility = decodeSceneCompatibility(v.compatibility, `${path}.compatibility`);
  exactKeys(
    v,
    [
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "privacyClass",
      "compatibility",
      "revision",
      "simulationTime",
      "weather",
      "hierarchy",
      "frames",
      "entities",
      "presentationBindings",
      "interactions",
      "feedCursor",
      "audienceHash",
    ],
    ["privateCognition", "effects"],
    path,
  );
  const revision = unsignedDecimal(v.revision, `${path}.revision`);
  const simulationTime = unsignedDecimal(v.simulationTime, `${path}.simulationTime`);
  const living = decodeLivingScene({
    version: 1,
    privacyClass: v.privacyClass,
    tenantId: v.tenantId,
    worldId: v.worldId,
    timelineId: v.timelineId,
    spaceId: v.spaceId,
    revision: revision.toString(),
    simulationTime: simulationTime.toString(),
    weather: v.weather,
    frames: v.frames,
    entities: v.entities,
  });
  return {
    tenantId: living.tenantId,
    worldId: living.worldId,
    timelineId: living.timelineId,
    spaceId: living.spaceId,
    privacyClass: "public_scene",
    compatibility,
    revision,
    simulationTime,
    weather: living.weather,
    hierarchy: decodeHierarchy(v.hierarchy, living.spaceId, `${path}.hierarchy`),
    frames: living.frames,
    entities: living.entities,
    presentationBindings: projectedOnce(
      array(v.presentationBindings, `${path}.presentationBindings`, decodeScenePresentationBinding),
      (binding) => binding.objectId,
      living.entities,
      `${path}.presentationBindings`,
    ),
    interactions: projectedOnce(
      array(v.interactions, `${path}.interactions`, decodeInteractionSummary),
      (interaction) => interaction.entityId,
      living.entities,
      `${path}.interactions`,
    ),
    feedCursor: string(v.feedCursor, `${path}.feedCursor`),
    audienceHash: string(v.audienceHash, `${path}.audienceHash`),
    ...(v.privateCognition === undefined
      ? {}
      : {
          privateCognition: decodePrivateCognition(
            v.privateCognition,
            living.entities,
            `${path}.privateCognition`,
          ),
        }),
    ...(v.effects === undefined
      ? {}
      : { effects: array(v.effects, `${path}.effects`, decodeSceneEffect) }),
  };
}
export type ScenePatchOperation =
  | { readonly op: "upsert_entity"; readonly entity: SceneProjectedEntity }
  | { readonly op: "remove_entity"; readonly objectId: ObjectId }
  | { readonly op: "upsert_frame"; readonly frame: LivingSpatialFrame }
  | { readonly op: "remove_frame"; readonly frameId: LivingSpatialFrame["frameId"] }
  | { readonly op: "set_clock"; readonly simulationTime: bigint }
  | { readonly op: "set_weather"; readonly weather: LivingWeather }
  | { readonly op: "upsert_space"; readonly space: VisibleSpace }
  | { readonly op: "remove_space"; readonly spaceId: SpaceId }
  | { readonly op: "upsert_presentation"; readonly binding: ScenePresentationBinding }
  | { readonly op: "remove_presentation"; readonly objectId: ObjectId }
  | { readonly op: "upsert_interaction"; readonly interaction: InteractionSummary }
  | { readonly op: "remove_interaction"; readonly objectId: ObjectId }
  | { readonly op: "set_feed_cursor"; readonly feedCursor: string }
  | { readonly op: "set_compatibility"; readonly compatibility: SceneCompatibility }
  | {
      readonly op: "set_private_cognition";
      readonly entries: readonly ScenePrivateCognition[];
    }
  | { readonly op: "set_effects"; readonly effects: readonly SceneEffect[] };
export interface ScenePatch {
  readonly fromRevision: bigint;
  readonly toRevision: bigint;
  readonly operations: readonly ScenePatchOperation[];
  readonly sourceEventIds: readonly EventId[];
  readonly audienceHash: string;
}
export function decodeScenePatchOperation(value: unknown, path = "operation"): ScenePatchOperation {
  const v = record(value, path);
  switch (v.op) {
    case "upsert_entity":
      exactKeys(v, ["op", "entity"], [], path);
      return { op: v.op, entity: decodeLivingEntity(v.entity, `${path}.entity`) };
    case "remove_entity":
    case "remove_presentation":
    case "remove_interaction":
      exactKeys(v, ["op", "objectId"], [], path);
      return { op: v.op, objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`) };
    case "upsert_frame":
      exactKeys(v, ["op", "frame"], [], path);
      return { op: v.op, frame: decodeLivingFrame(v.frame, `${path}.frame`) };
    case "remove_frame":
      exactKeys(v, ["op", "frameId"], [], path);
      return { op: v.op, frameId: decodeOpaqueId(v.frameId, "SpatialFrameId", `${path}.frameId`) };
    case "set_clock":
      exactKeys(v, ["op", "simulationTime"], [], path);
      return {
        op: v.op,
        simulationTime: unsignedDecimal(v.simulationTime, `${path}.simulationTime`),
      };
    case "set_weather": {
      exactKeys(v, ["op", "weather"], [], path);
      return { op: v.op, weather: decodeLivingWeather(v.weather, `${path}.weather`) };
    }
    case "upsert_space":
      exactKeys(v, ["op", "space"], [], path);
      return { op: v.op, space: decodeVisibleSpace(v.space, `${path}.space`) };
    case "remove_space":
      exactKeys(v, ["op", "spaceId"], [], path);
      return { op: v.op, spaceId: decodeOpaqueId(v.spaceId, "SpaceId", `${path}.spaceId`) };
    case "upsert_presentation":
      exactKeys(v, ["op", "binding"], [], path);
      return { op: v.op, binding: decodeScenePresentationBinding(v.binding, `${path}.binding`) };
    case "upsert_interaction":
      exactKeys(v, ["op", "interaction"], [], path);
      return {
        op: v.op,
        interaction: decodeInteractionSummary(v.interaction, `${path}.interaction`),
      };
    case "set_feed_cursor":
      exactKeys(v, ["op", "feedCursor"], [], path);
      return { op: v.op, feedCursor: string(v.feedCursor, `${path}.feedCursor`) };
    case "set_compatibility": {
      const compatibility = decodeSceneCompatibility(v.compatibility, `${path}.compatibility`);
      exactKeys(v, ["op", "compatibility"], [], path);
      return { op: v.op, compatibility };
    }
    case "set_private_cognition":
      exactKeys(v, ["op", "entries"], [], path);
      return {
        op: v.op,
        entries: array(v.entries, `${path}.entries`, decodeScenePrivateCognition),
      };
    case "set_effects":
      exactKeys(v, ["op", "effects"], [], path);
      return { op: v.op, effects: array(v.effects, `${path}.effects`, decodeSceneEffect) };
    default:
      throw new ContractDecodeError(`${path}.op`, "unknown operation");
  }
}
export function decodeScenePatch(value: unknown, path = "patch"): ScenePatch {
  const v = record(value, path);
  // A patch's declared compatibility is checked before the patch or any operation's shape, so a
  // newer peer that also changes shape still receives its stable compatibility code.
  if (Array.isArray(v.operations))
    v.operations.forEach((operation: unknown, index) => {
      if (
        typeof operation === "object" &&
        operation !== null &&
        "op" in operation &&
        operation.op === "set_compatibility" &&
        "compatibility" in operation
      )
        decodeSceneCompatibility(
          operation.compatibility,
          `${path}.operations[${index}].compatibility`,
        );
    });
  exactKeys(
    v,
    ["fromRevision", "toRevision", "operations", "sourceEventIds", "audienceHash"],
    [],
    path,
  );
  const fromRevision = unsignedDecimal(v.fromRevision, `${path}.fromRevision`),
    toRevision = unsignedDecimal(v.toRevision, `${path}.toRevision`);
  if (toRevision <= fromRevision)
    throw new ContractDecodeError(`${path}.toRevision`, "revision must advance");
  return {
    fromRevision,
    toRevision,
    operations: array(v.operations, `${path}.operations`, decodeScenePatchOperation),
    sourceEventIds: array(v.sourceEventIds, `${path}.sourceEventIds`, (id, p) =>
      decodeOpaqueId(id, "EventId", p),
    ),
    audienceHash: string(v.audienceHash, `${path}.audienceHash`),
  };
}
export type SceneCueKind =
  | "footstep"
  | "splash"
  | "particle"
  | "sound"
  | "emote"
  | "hover_hint"
  | "animation_transition";
export interface SceneTransientCue {
  readonly kind: SceneCueKind;
  readonly objectId: ObjectId;
  readonly reference: string;
  readonly expiresAt: string;
  readonly dedupeKey: string;
}
export function decodeSceneTransientCue(value: unknown, path = "cue"): SceneTransientCue {
  const v = record(value, path);
  exactKeys(v, ["kind", "objectId", "reference", "expiresAt", "dedupeKey"], [], path);
  return {
    kind: literal(
      v.kind,
      ["footstep", "splash", "particle", "sound", "emote", "hover_hint", "animation_transition"],
      `${path}.kind`,
    ),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    reference: string(v.reference, `${path}.reference`),
    expiresAt: utcTimestamp(v.expiresAt, `${path}.expiresAt`),
    dedupeKey: string(v.dedupeKey, `${path}.dedupeKey`),
  };
}
export type ObserverSceneMessage =
  | (SceneEnvelope<SceneProjection> & { readonly lane: "projection"; readonly type: "snapshot" })
  | (SceneEnvelope<ScenePatch> & { readonly lane: "projection"; readonly type: "patch" })
  | (SceneEnvelope<SceneTransientCue> & { readonly lane: "transient"; readonly type: "cue" });
/** The safe connection metadata an operator inspector shows, and nothing else. */
export interface SceneConnectionMetadata {
  readonly principalId: PrincipalId;
  readonly acknowledgedRevision: bigint | null;
  readonly connectionVersion: number;
}
export interface SceneOperatorConnections {
  readonly connections: readonly SceneConnectionMetadata[];
}
/** Operator-lane diagnostics require the inspection grant and never enter an observer stream. */
export type OperatorSceneMessage = SceneEnvelope<SceneOperatorConnections> & {
  readonly lane: "operator";
  readonly type: "connections";
};
export function decodeSceneConnectionMetadata(
  value: unknown,
  path = "connection",
): SceneConnectionMetadata {
  const v = record(value, path);
  exactKeys(v, ["principalId", "acknowledgedRevision", "connectionVersion"], [], path);
  return {
    principalId: decodeOpaqueId(v.principalId, "PrincipalId", `${path}.principalId`),
    acknowledgedRevision:
      v.acknowledgedRevision === null
        ? null
        : unsignedDecimal(v.acknowledgedRevision, `${path}.acknowledgedRevision`),
    connectionVersion: nonNegativeInteger(v.connectionVersion, `${path}.connectionVersion`),
  };
}
/** Every lane's envelope, version first; the caller decodes and cross-checks the lane payload. */
function decodeSceneEnvelope(value: unknown) {
  const v = record(value, "message");
  if ("protocolVersion" in v && v.protocolVersion !== SCENE_PROTOCOL_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_protocol_version",
      v.protocolVersion,
      SCENE_PROTOCOL_VERSION,
      "message.protocolVersion",
    );
  exactKeys(
    v,
    [
      "protocolVersion",
      "messageId",
      "lane",
      "type",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "sentAt",
      "payload",
    ],
    ["projectionRevision", "traceparent"],
    "message",
  );
  const common = {
    ...decodeBrowserScope({
      tenantId: v.tenantId,
      worldId: v.worldId,
      timelineId: v.timelineId,
      spaceId: v.spaceId,
    }),
    protocolVersion: SCENE_PROTOCOL_VERSION,
    messageId: string(v.messageId, "message.messageId"),
    sentAt: utcTimestamp(v.sentAt, "message.sentAt"),
    ...(v.traceparent === undefined
      ? {}
      : { traceparent: w3cTraceparent(v.traceparent, "message.traceparent") }),
    ...(v.projectionRevision === undefined
      ? {}
      : {
          projectionRevision: unsignedDecimal(v.projectionRevision, "message.projectionRevision"),
        }),
  };
  return { v, common };
}
export function decodeObserverSceneMessage(value: unknown): ObserverSceneMessage {
  const { v, common } = decodeSceneEnvelope(value);
  if (v.lane === "projection" && v.type === "snapshot") {
    const payload = decodeSceneProjection(v.payload);
    if (
      payload.tenantId !== common.tenantId ||
      payload.worldId !== common.worldId ||
      payload.timelineId !== common.timelineId ||
      payload.spaceId !== common.spaceId ||
      common.projectionRevision !== payload.revision
    )
      throw new ContractDecodeError("message", "snapshot identity or revision mismatch");
    return { ...common, lane: "projection", type: "snapshot", payload };
  }
  if (v.lane === "projection" && v.type === "patch") {
    const payload = decodeScenePatch(v.payload);
    if (common.projectionRevision !== payload.toRevision)
      throw new ContractDecodeError("message.projectionRevision", "patch revision mismatch");
    return { ...common, lane: "projection", type: "patch", payload };
  }
  if (v.lane === "transient" && v.type === "cue") {
    const payload = decodeSceneTransientCue(v.payload);
    if (utcInstantKey(payload.expiresAt) <= utcInstantKey(common.sentAt))
      throw new ContractDecodeError("cue.expiresAt", "cue must expire after it is sent");
    return { ...common, lane: "transient", type: "cue", payload };
  }
  throw new ContractDecodeError(
    "message.lane",
    "message is not an observer projection or transient cue",
  );
}
const decimalBigints = (_key: string, item: unknown) =>
  typeof item === "bigint" ? item.toString() : item;
export function encodeObserverSceneMessage(value: ObserverSceneMessage): string {
  return JSON.stringify(decodeObserverSceneMessage(value), decimalBigints);
}
/** Strict operator-lane decoding; it describes, and never grants, the inspection authority. */
export function decodeOperatorSceneMessage(value: unknown): OperatorSceneMessage {
  const { v, common } = decodeSceneEnvelope(value);
  if (v.lane !== "operator" || v.type !== "connections")
    throw new ContractDecodeError("message.lane", "message is not an operator diagnostic");
  const payload = record(v.payload, "connections");
  exactKeys(payload, ["connections"], [], "connections");
  return {
    ...common,
    lane: "operator",
    type: "connections",
    payload: {
      connections: array(payload.connections, "connections", decodeSceneConnectionMetadata),
    },
  };
}
export function encodeOperatorSceneMessage(value: OperatorSceneMessage): string {
  return JSON.stringify(decodeOperatorSceneMessage(value), decimalBigints);
}
export interface SceneAssetProvenance {
  readonly source: string;
  readonly creator: string;
  readonly tool?: string;
  readonly license: string;
  readonly generated?: { readonly prompt: string; readonly references: readonly string[] };
}
export interface SceneAsset {
  readonly assetId: string;
  readonly provenance: SceneAssetProvenance;
  readonly reviewStatus: "pending" | "approved" | "rejected";
  readonly semanticEntityId?: ObjectId;
  readonly semanticArchetypeId: string;
  readonly animationFamily: string;
  readonly anchor: readonly string[];
  readonly footprint: readonly string[];
  readonly bounds: readonly string[];
  readonly palette: readonly string[];
  readonly contentHash: string;
  readonly atlasLocation: string;
  readonly accessibilityLabel: string;
}
export interface SceneAssetManifest {
  readonly version: 1;
  readonly contentHash: string;
  readonly assets: readonly SceneAsset[];
}
export function decodeSceneAsset(value: unknown, path = "asset"): SceneAsset {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "assetId",
      "provenance",
      "reviewStatus",
      "semanticArchetypeId",
      "animationFamily",
      "anchor",
      "footprint",
      "bounds",
      "palette",
      "contentHash",
      "atlasLocation",
      "accessibilityLabel",
    ],
    ["semanticEntityId"],
    path,
  );
  const p = record(v.provenance, `${path}.provenance`);
  exactKeys(p, ["source", "creator", "license"], ["tool", "generated"], `${path}.provenance`);
  let generated: SceneAssetProvenance["generated"];
  if (p.generated !== undefined) {
    const g = record(p.generated, `${path}.provenance.generated`);
    exactKeys(g, ["prompt", "references"], [], `${path}.provenance.generated`);
    generated = {
      prompt: string(g.prompt, `${path}.provenance.generated.prompt`),
      references: array(g.references, `${path}.provenance.generated.references`, string),
    };
  }
  return {
    assetId: string(v.assetId, `${path}.assetId`),
    provenance: {
      source: string(p.source, `${path}.provenance.source`),
      creator: string(p.creator, `${path}.provenance.creator`),
      license: string(p.license, `${path}.provenance.license`),
      ...(p.tool === undefined ? {} : { tool: string(p.tool, `${path}.provenance.tool`) }),
      ...(generated === undefined ? {} : { generated }),
    },
    reviewStatus: literal(
      v.reviewStatus,
      ["pending", "approved", "rejected"],
      `${path}.reviewStatus`,
    ),
    ...(v.semanticEntityId === undefined
      ? {}
      : {
          semanticEntityId: decodeOpaqueId(
            v.semanticEntityId,
            "ObjectId",
            `${path}.semanticEntityId`,
          ),
        }),
    semanticArchetypeId: string(v.semanticArchetypeId, `${path}.semanticArchetypeId`),
    animationFamily: string(v.animationFamily, `${path}.animationFamily`),
    anchor: array(v.anchor, `${path}.anchor`, string),
    footprint: array(v.footprint, `${path}.footprint`, string),
    bounds: array(v.bounds, `${path}.bounds`, string),
    palette: array(v.palette, `${path}.palette`, string),
    contentHash: string(v.contentHash, `${path}.contentHash`),
    atlasLocation: string(v.atlasLocation, `${path}.atlasLocation`),
    accessibilityLabel: string(v.accessibilityLabel, `${path}.accessibilityLabel`),
  };
}
export function decodeSceneAssetManifest(value: unknown, path = "manifest"): SceneAssetManifest {
  const v = record(value, path);
  if ("version" in v && v.version !== SCENE_ASSET_MANIFEST_VERSION)
    throw new SceneCompatibilityError(
      "unsupported_asset_manifest_version",
      v.version,
      SCENE_ASSET_MANIFEST_VERSION,
      `${path}.version`,
    );
  exactKeys(v, ["version", "contentHash", "assets"], [], path);
  return {
    version: 1,
    contentHash: string(v.contentHash, `${path}.contentHash`),
    assets: array(v.assets, `${path}.assets`, decodeSceneAsset),
  };
}
