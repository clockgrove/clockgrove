import {
  placeOf,
  regionAncestors,
  regionsContaining,
  type SpatialRegion,
  semanticHierarchyIssues,
} from "@clockgrove/domain";
import { canonicalBytes } from "../canonical.js";
import {
  isRefusalSignal,
  type Refusal,
  type RefusalCode,
  RefusalSignal,
  refusal,
} from "../execute/refusal.js";
import { parseSpatialRegionAtBoundary } from "../spatial/boundary.js";
import type { SpatialIndexFactory } from "../spatial/index-port.js";
import { createQuadtreeSpatialIndex } from "../spatial/quadtree.js";
import { sha256Hex } from "./sha256.js";

/** Bumped whenever any rule, code, field or hash input of the resolver changes. */
export const RESOLVER_VERSION = "clockgrove-audience-resolver@2";

export const PERCEPTION_MODALITIES = Object.freeze([
  "sight",
  "sound",
  "smell",
  "touch",
  "social",
  "system",
  "interpreted",
] as const);
export type PerceptionModality = (typeof PERCEPTION_MODALITIES)[number];

/** Semantic event types (version 1) the resolver knows how to place in space. */
export const PERCEIVABLE_EVENT_TYPES = Object.freeze([
  "containment.put",
  "containment.removed",
  "containment.transferred",
  "movement.completed",
  "movement.interrupted",
  "movement.region-entered",
  "movement.region-exited",
  "movement.replanned",
  "movement.started",
  "object.created",
  "object.retired",
  "resource.consumed",
  "resource.offered",
  "resource.transferred",
] as const);
export const PERCEPTION_EVENT_VERSION = 1;
/** Version 2 drops `spaces`: ancestor places come from the state's declared semantic hierarchy. */
export const PERCEPTION_POLICY_VERSION = 2;

/** Candidate sources, in reason priority order; each is also the reason code of an inclusion. */
export const CANDIDATE_SOURCES = Object.freeze([
  "direct-target",
  "event-actor",
  "containing-space",
  "space-contents",
  "nearby-peer",
  "ancestor-space",
  "explicit-subscriber",
] as const);
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** Exclusion rules, each a distinct reason code. */
export const EXCLUSION_CODES = Object.freeze([
  "modality-range",
  "declared-occlusion",
  "privacy-excluded",
  "viewer-unsubscribed",
] as const);
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];
/** Detail reduction by access/privacy policy: the observer stays included at reduced detail. */
export const REDUCTION_CODE = "privacy-reduced";

export const PERCEPTION_CHECKS = Object.freeze({
  sourceRevision: "perception.source-revision@1",
  observer: "perception.observer@1",
  space: "perception.space@1",
  region: "perception.region@1",
  resolver: "perception.resolver@1",
} as const);

/** Fixed refusal catalogue: [code, path pattern, check]. Shared with docs/perception.md and the evidence schema. */
export const PERCEPTION_REFUSALS = Object.freeze([
  ["invalid-input", "event | sourceState | policy and the offending field path", undefined],
  [
    "unsupported-input",
    "event.type | event.modality | policy.modalities[i].modality | policy.occlusions[i].modality",
    undefined,
  ],
  ["unknown-event-version", "event.version | policy.version", undefined],
  ["revision-conflict", "event.sourceRevision", PERCEPTION_CHECKS.sourceRevision],
  [
    "precondition-failed",
    "event.actorId | event.targetId | policy.subscribers[i].observerId | policy.occlusions | policy.access",
    PERCEPTION_CHECKS.observer,
  ],
  ["precondition-failed", "event.spaceId", PERCEPTION_CHECKS.space],
  ["precondition-failed", "event.regionIds[i]", PERCEPTION_CHECKS.region],
  ["handler-failed", "resolver", PERCEPTION_CHECKS.resolver],
] as const);

export type DetailLevel = "full" | "reduced";
export type ObserverKind = "actor" | "viewer";

export interface AudiencePerception {
  readonly observerId: string;
  readonly eventId: string;
  readonly modality: PerceptionModality;
  readonly detailLevel: DetailLevel;
  readonly hash: string;
}
export interface ClientInterestInput {
  readonly viewerId: string;
  readonly eventId: string;
  readonly sourceRevision: bigint;
  readonly spaceId: string;
  readonly modality: PerceptionModality;
  readonly detailLevel: DetailLevel;
}
export interface AudienceReason {
  readonly observerId: string;
  readonly observerKind: ObserverKind;
  readonly outcome: "included" | "excluded";
  readonly code: CandidateSource | ExclusionCode;
  /** Every candidate source that named the observer (empty for an unsubscribed viewer). */
  readonly sources: readonly CandidateSource[];
  readonly detailLevel: DetailLevel | "none";
  readonly reduction: typeof REDUCTION_CODE | null;
}
export interface AudienceResolution {
  readonly resolverVersion: string;
  readonly eventId: string;
  readonly sourceRevision: bigint;
  readonly perceptions: readonly AudiencePerception[];
  readonly clientInterest: Readonly<{ inputs: readonly ClientInterestInput[]; hash: string }>;
  readonly reasons: readonly AudienceReason[];
}
export type AudienceOutcome =
  | Readonly<{ ok: true; value: AudienceResolution }>
  | Readonly<{ ok: false; error: Refusal }>;

/** Optional, never hashed and never part of the canonical input (like `spatialIndexFactory`). */
export interface ResolveAudienceOptions {
  readonly spatialIndexFactory?: SpatialIndexFactory;
}

type Rec = Record<string, unknown>;
interface Pose {
  readonly frameId: string;
  readonly frameVersion: number;
  readonly coordinates: readonly bigint[];
}
interface Observer {
  readonly id: string;
  readonly spaceId: string;
  readonly pose: Pose;
  readonly containerId: string | undefined;
  readonly active: boolean;
}
interface EventInput {
  readonly eventId: string;
  readonly type: string;
  readonly modality: PerceptionModality;
  readonly sourceRevision: bigint;
  readonly spaceId: string;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly regionIds: readonly string[];
}
interface PolicyInput {
  readonly ranges: ReadonlyMap<string, number>;
  readonly occluded: ReadonlySet<string>;
  readonly access: ReadonlyMap<string, "deny" | "reduce">;
  readonly subscribers: readonly string[];
  readonly viewers: readonly Readonly<{ viewerId: string; subscribed: boolean }>[];
}
interface StateInput {
  readonly revision: bigint;
  readonly observers: readonly Observer[];
  readonly regions: readonly SpatialRegion[];
}

function stop(code: RefusalCode, path: string, check?: string): never {
  throw new RefusalSignal(refusal(code, path, check));
}
const isRecord = (value: unknown): value is Rec => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const SAFE_KEY = /^[A-Za-z0-9_$]+$/u;

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Rec {
  if (!isRecord(value)) return stop("invalid-input", path);
  const own = Reflect.ownKeys(value);
  for (const key of own)
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      stop(
        "invalid-input",
        typeof key === "string" && SAFE_KEY.test(key) ? `${path}.${key}` : path,
      );
  for (const key of required) if (!own.includes(key)) stop("invalid-input", `${path}.${key}`);
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    return stop("invalid-input", path);
  return value;
}
function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}
function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4096) return stop("invalid-input", path);
  return value;
}
function unique(seen: Set<string>, id: string, path: string): void {
  if (seen.has(id)) stop("invalid-input", path);
  seen.add(id);
}

function parseModality(value: unknown, path: string): PerceptionModality {
  const modality = text(value, path);
  if (!(PERCEPTION_MODALITIES as readonly string[]).includes(modality))
    return stop("unsupported-input", path);
  return modality as PerceptionModality;
}

function parseEvent(value: unknown): EventInput {
  const raw = exact(value, "event", [
    "actorId",
    "eventId",
    "modality",
    "regionIds",
    "sourceRevision",
    "spaceId",
    "targetId",
    "type",
    "version",
  ]);
  const eventId = text(raw.eventId, "event.eventId");
  const type = text(raw.type, "event.type");
  if (typeof raw.version !== "number" || !Number.isSafeInteger(raw.version))
    return stop("invalid-input", "event.version");
  if (!(PERCEIVABLE_EVENT_TYPES as readonly string[]).includes(type))
    return stop("unsupported-input", "event.type");
  if (raw.version !== PERCEPTION_EVENT_VERSION)
    return stop("unknown-event-version", "event.version");
  const modality = parseModality(raw.modality, "event.modality");
  if (typeof raw.sourceRevision !== "bigint" || raw.sourceRevision < 0n)
    return stop("invalid-input", "event.sourceRevision");
  const actorId = nullableText(raw.actorId, "event.actorId");
  const targetId = nullableText(raw.targetId, "event.targetId");
  if (actorId === null && targetId === null) return stop("invalid-input", "event.actorId");
  const seen = new Set<string>();
  const regionIds = list(raw.regionIds, "event.regionIds").map((id, index) => {
    const regionId = text(id, `event.regionIds[${index}]`);
    unique(seen, regionId, `event.regionIds[${index}]`);
    return regionId;
  });
  return {
    eventId,
    type,
    modality,
    sourceRevision: raw.sourceRevision,
    spaceId: text(raw.spaceId, "event.spaceId"),
    actorId,
    targetId,
    regionIds,
  };
}

function parsePolicy(value: unknown): PolicyInput {
  const raw = exact(value, "policy", [
    "access",
    "modalities",
    "occlusions",
    "subscribers",
    "version",
    "viewers",
  ]);
  if (typeof raw.version !== "number" || !Number.isSafeInteger(raw.version))
    return stop("invalid-input", "policy.version");
  if (raw.version !== PERCEPTION_POLICY_VERSION)
    return stop("unknown-event-version", "policy.version");
  const ranges = new Map<string, number>();
  for (const [index, item] of list(raw.modalities, "policy.modalities").entries()) {
    const at = `policy.modalities[${index}]`;
    const entry = exact(item, at, ["modality", "range"]);
    const modality = parseModality(entry.modality, `${at}.modality`);
    if (
      typeof entry.range !== "number" ||
      !Number.isSafeInteger(entry.range) ||
      entry.range < 0 ||
      Object.is(entry.range, -0)
    )
      return stop("invalid-input", `${at}.range`);
    if (ranges.has(modality)) stop("invalid-input", `${at}.modality`);
    ranges.set(modality, entry.range);
  }
  const occluded = new Set<string>();
  const occlusionOrder = new Set<string>();
  for (const [index, item] of list(raw.occlusions, "policy.occlusions").entries()) {
    const at = `policy.occlusions[${index}]`;
    const entry = exact(item, at, ["modality", "observerId"]);
    const modality = parseModality(entry.modality, `${at}.modality`);
    const observerId = text(entry.observerId, `${at}.observerId`);
    unique(occlusionOrder, `${observerId}\u0000${modality}`, `${at}.observerId`);
    occluded.add(`${observerId}\u0000${modality}`);
  }
  const access = new Map<string, "deny" | "reduce">();
  for (const [index, item] of list(raw.access, "policy.access").entries()) {
    const at = `policy.access[${index}]`;
    const entry = exact(item, at, ["effect", "observerId"]);
    if (entry.effect !== "deny" && entry.effect !== "reduce")
      return stop("invalid-input", `${at}.effect`);
    const observerId = text(entry.observerId, `${at}.observerId`);
    if (access.has(observerId)) stop("invalid-input", `${at}.observerId`);
    access.set(observerId, entry.effect);
  }
  const subscriberSeen = new Set<string>();
  const subscribers = list(raw.subscribers, "policy.subscribers").map((item, index) => {
    const at = `policy.subscribers[${index}]`;
    const observerId = text(exact(item, at, ["observerId"]).observerId, `${at}.observerId`);
    unique(subscriberSeen, observerId, `${at}.observerId`);
    return observerId;
  });
  const viewerSeen = new Set<string>();
  const viewers = list(raw.viewers, "policy.viewers").map((item, index) => {
    const at = `policy.viewers[${index}]`;
    const entry = exact(item, at, ["subscribed", "viewerId"]);
    if (typeof entry.subscribed !== "boolean") return stop("invalid-input", `${at}.subscribed`);
    const viewerId = text(entry.viewerId, `${at}.viewerId`);
    unique(viewerSeen, viewerId, `${at}.viewerId`);
    return { viewerId, subscribed: entry.subscribed };
  });
  return { ranges, occluded, access, subscribers, viewers };
}

function parsePose(value: unknown, path: string): Pose {
  const raw = isRecord(value) ? value : stop("invalid-input", path);
  const coordinates = raw.coordinates;
  if (
    !Array.isArray(coordinates) ||
    (coordinates.length !== 2 && coordinates.length !== 3) ||
    !coordinates.every((item) => typeof item === "bigint")
  )
    return stop("invalid-input", `${path}.coordinates`);
  if (typeof raw.frameVersion !== "number" || !Number.isSafeInteger(raw.frameVersion))
    return stop("invalid-input", `${path}.frameVersion`);
  return {
    frameId: text(raw.frameId, `${path}.frameId`),
    frameVersion: raw.frameVersion,
    coordinates: coordinates as readonly bigint[],
  };
}

function parseState(value: unknown): StateInput {
  if (!isRecord(value)) return stop("invalid-input", "sourceState");
  if (typeof value.revision !== "bigint" || value.revision < 0n)
    return stop("invalid-input", "sourceState.revision");
  const seen = new Set<string>();
  const observers = list(value.entities, "sourceState.entities").map((item, index): Observer => {
    const at = `sourceState.entities[${index}]`;
    if (!isRecord(item)) return stop("invalid-input", at);
    const id = text(item.objectId, `${at}.objectId`);
    unique(seen, id, `${at}.objectId`);
    const containment = item.containment;
    if (containment !== undefined && !isRecord(containment))
      return stop("invalid-input", `${at}.containment`);
    const containerId = containment?.containerId;
    if (containerId !== undefined && typeof containerId !== "string")
      return stop("invalid-input", `${at}.containment.containerId`);
    const lifecycle = item.lifecycle;
    if (lifecycle !== undefined && (!isRecord(lifecycle) || typeof lifecycle.status !== "string"))
      return stop("invalid-input", `${at}.lifecycle`);
    return {
      id,
      spaceId: text(item.spaceId, `${at}.spaceId`),
      pose: parsePose(item.pose, `${at}.pose`),
      containerId,
      active: lifecycle === undefined || lifecycle.status === "active",
    };
  });
  const regions =
    value.spatialRegions === undefined
      ? []
      : list(value.spatialRegions, "sourceState.spatialRegions").map((item, index) => {
          const parsed = parseSpatialRegionAtBoundary(item);
          return parsed.ok
            ? parsed.value
            : stop("invalid-input", `sourceState.spatialRegions[${index}]`);
        });
  // The semantic hierarchy the ancestor places come from must be a valid graph of known regions.
  const issue = semanticHierarchyIssues(regions, undefined, "sourceState.spatialRegions")[0];
  if (issue !== undefined) stop("invalid-input", issue.path);
  return { revision: value.revision, observers, regions };
}

function withinRange(origin: Pose, other: Pose, range: number): boolean {
  if (
    origin.frameId !== other.frameId ||
    origin.frameVersion !== other.frameVersion ||
    origin.coordinates.length !== other.coordinates.length
  )
    return false;
  let squared = 0n;
  for (const [axis, value] of origin.coordinates.entries()) {
    const delta = value - other.coordinates[axis]!;
    squared += delta * delta;
  }
  return squared <= BigInt(range) * BigInt(range);
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function resolve(
  eventValue: unknown,
  stateValue: unknown,
  policyValue: unknown,
  options: ResolveAudienceOptions,
): AudienceResolution {
  const event = parseEvent(eventValue);
  const state = parseState(stateValue);
  const policy = parsePolicy(policyValue);
  if (event.sourceRevision !== state.revision)
    return stop("revision-conflict", "event.sourceRevision", PERCEPTION_CHECKS.sourceRevision);

  const byId = new Map(state.observers.map((observer) => [observer.id, observer]));
  const viewerIds = new Set(policy.viewers.map((viewer) => viewer.viewerId));
  const knownSpaces = new Set<string>(state.observers.map((observer) => observer.spaceId));
  const known = (id: string, path: string, viewers = false): void => {
    if (!byId.has(id) && !(viewers && viewerIds.has(id)))
      stop("precondition-failed", path, PERCEPTION_CHECKS.observer);
  };
  if (event.actorId !== null) known(event.actorId, "event.actorId");
  if (event.targetId !== null) known(event.targetId, "event.targetId");
  if (!knownSpaces.has(event.spaceId))
    stop("precondition-failed", "event.spaceId", PERCEPTION_CHECKS.space);
  for (const [index, observerId] of policy.subscribers.entries())
    known(observerId, `policy.subscribers[${index}].observerId`);
  for (const key of policy.occluded)
    known(key.slice(0, key.indexOf("\u0000")), "policy.occlusions", true);
  for (const id of policy.access.keys()) known(id, "policy.access", true);
  const regionById = new Map(state.regions.map((region) => [region.regionId, region]));
  for (const [index, regionId] of event.regionIds.entries())
    if (!regionById.has(regionId))
      stop("precondition-failed", `event.regionIds[${index}]`, PERCEPTION_CHECKS.region);

  // Candidate sources: only active objects of the source-revision state are ever considered.
  const sources = new Map<string, Set<CandidateSource>>();
  const add = (id: string, source: CandidateSource): void => {
    if (byId.get(id)?.active !== true) return;
    sources.set(id, (sources.get(id) ?? new Set()).add(source));
  };
  if (event.targetId !== null) add(event.targetId, "direct-target");
  if (event.actorId !== null) add(event.actorId, "event-actor");
  const subject = byId.get(event.actorId ?? event.targetId ?? "")!;
  if (subject.containerId !== undefined) add(subject.containerId, "containing-space");
  for (const observer of state.observers)
    if (observer.spaceId === event.spaceId) add(observer.id, "space-contents");
  // Ancestor places (graph 5): observers standing in a place that the declared semantic hierarchy
  // makes an ancestor of the subject's place. A place is where a pose stands (`placeOf`).
  const placeAt = (pose: Pose) =>
    placeOf(state.regions, pose.frameId, pose.frameVersion, pose.coordinates);
  const place = placeAt(subject.pose);
  const ancestors = new Set(place === undefined ? [] : regionAncestors(state.regions, place));
  for (const observer of state.observers) {
    const at = ancestors.size === 0 ? undefined : placeAt(observer.pose);
    if (at !== undefined && ancestors.has(at)) add(observer.id, "ancestor-space");
  }
  const factory = options.spatialIndexFactory ?? createQuadtreeSpatialIndex;
  const epoch = Number(state.revision);
  for (const regionId of event.regionIds) {
    const region = regionById.get(regionId)!;
    const index = factory(epoch);
    for (const observer of state.observers)
      if (
        observer.active &&
        observer.pose.frameId === region.frameId &&
        observer.pose.frameVersion === region.frameVersion &&
        observer.pose.coordinates.length === (region.shape.kind === "box" ? 3 : 2)
      )
        index.update(epoch, {
          op: "insert",
          binding: { objectId: observer.id as never, pose: observer.pose as never },
        });
    for (const id of index.query(epoch, region)) {
      const observer = byId.get(id);
      if (
        observer !== undefined &&
        regionsContaining(
          state.regions,
          observer.pose.frameId,
          observer.pose.frameVersion,
          observer.pose.coordinates,
        ).includes(regionId)
      )
        add(id, "nearby-peer");
    }
  }
  for (const id of policy.subscribers) add(id, "explicit-subscriber");

  const range = policy.ranges.get(event.modality);
  const reasons: AudienceReason[] = [];
  const perceptions: AudiencePerception[] = [];
  const hashOf = (observerId: string, detailLevel: DetailLevel, code: string): string =>
    sha256Hex(
      canonicalBytes({
        resolverVersion: RESOLVER_VERSION,
        eventType: event.type,
        eventId: event.eventId,
        sourceRevision: event.sourceRevision,
        observerId,
        modality: event.modality,
        detailLevel,
        reason: code,
      }),
    );
  for (const id of [...sources.keys()].sort(compareText)) {
    const found = [...sources.get(id)!];
    const named = CANDIDATE_SOURCES.filter((source) => found.includes(source));
    const primary = named[0]!;
    const observer = byId.get(id)!;
    const exclude = (code: ExclusionCode): void => {
      reasons.push({
        observerId: id,
        observerKind: "actor",
        outcome: "excluded",
        code,
        sources: named,
        detailLevel: "none",
        reduction: null,
      });
    };
    const participant = named.includes("direct-target") || named.includes("event-actor");
    if (!participant) {
      if (range === undefined) {
        exclude("modality-range");
        continue;
      }
      // Sources derived from where the observer stands are range-checked; the others are not.
      const distanceFree = named.some(
        (source) =>
          source !== "space-contents" && source !== "nearby-peer" && source !== "ancestor-space",
      );
      if (!distanceFree && !withinRange(subject.pose, observer.pose, range)) {
        exclude("modality-range");
        continue;
      }
    }
    if (policy.occluded.has(`${id}\u0000${event.modality}`)) {
      exclude("declared-occlusion");
      continue;
    }
    const effect = policy.access.get(id);
    if (effect === "deny") {
      exclude("privacy-excluded");
      continue;
    }
    const detailLevel: DetailLevel = effect === "reduce" ? "reduced" : "full";
    reasons.push({
      observerId: id,
      observerKind: "actor",
      outcome: "included",
      code: primary,
      sources: named,
      detailLevel,
      reduction: effect === "reduce" ? REDUCTION_CODE : null,
    });
    perceptions.push({
      observerId: id,
      eventId: event.eventId,
      modality: event.modality,
      detailLevel,
      hash: hashOf(id, detailLevel, primary),
    });
  }
  // Viewers never become world observers: they only yield client-interest inputs, and only when subscribed.
  const inputs: ClientInterestInput[] = [];
  for (const viewer of policy.viewers) {
    const id = viewer.viewerId;
    const base = { observerId: id, observerKind: "viewer" as const };
    if (!viewer.subscribed) {
      reasons.push({
        ...base,
        outcome: "excluded",
        code: "viewer-unsubscribed",
        sources: [],
        detailLevel: "none",
        reduction: null,
      });
      continue;
    }
    const effect = policy.access.get(id);
    if (effect === "deny") {
      reasons.push({
        ...base,
        outcome: "excluded",
        code: "privacy-excluded",
        sources: ["explicit-subscriber"],
        detailLevel: "none",
        reduction: null,
      });
      continue;
    }
    const detailLevel: DetailLevel = effect === "reduce" ? "reduced" : "full";
    reasons.push({
      ...base,
      outcome: "included",
      code: "explicit-subscriber",
      sources: ["explicit-subscriber"],
      detailLevel,
      reduction: effect === "reduce" ? REDUCTION_CODE : null,
    });
    inputs.push({
      viewerId: id,
      eventId: event.eventId,
      sourceRevision: event.sourceRevision,
      spaceId: event.spaceId,
      modality: event.modality,
      detailLevel,
    });
  }
  reasons.sort(
    (left, right) =>
      compareText(left.observerId, right.observerId) ||
      compareText(left.observerKind, right.observerKind),
  );
  perceptions.sort((left, right) => compareText(left.observerId, right.observerId));
  inputs.sort((left, right) => compareText(left.viewerId, right.viewerId));
  return {
    resolverVersion: RESOLVER_VERSION,
    eventId: event.eventId,
    sourceRevision: event.sourceRevision,
    perceptions,
    clientInterest: {
      inputs,
      hash: sha256Hex(canonicalBytes({ resolverVersion: RESOLVER_VERSION, inputs })),
    },
    reasons,
  };
}

/**
 * Pure, synchronous and total: a committed semantic event plus the state at its source revision becomes
 * private actor perceptions, client-interest inputs and one reason per candidate observer. Failures are
 * returned as frozen `{ code, path, check? }` refusals; nothing is thrown.
 */
export function resolveAudience(
  event: unknown,
  sourceState: unknown,
  policy: unknown,
  options: ResolveAudienceOptions = {},
): AudienceOutcome {
  try {
    return Object.freeze({
      ok: true,
      value: deepFreeze(resolve(event, sourceState, policy, options)),
    });
  } catch (error) {
    try {
      if (isRefusalSignal(error)) return Object.freeze({ ok: false, error: error.refusal });
    } catch {
      // fall through to the generic refusal
    }
    return Object.freeze({
      ok: false,
      error: refusal("handler-failed", "resolver", PERCEPTION_CHECKS.resolver),
    });
  }
}
