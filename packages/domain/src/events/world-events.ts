import type { WorldFeedCategory } from "@clockgrove/contracts";
import type { WorldEvent } from "../world.js";

export interface VersionedDefinition {
  readonly type: string;
  readonly version: number;
}

/**
 * Exhaustive by construction: adding a WorldEvent type without a version here fails to compile.
 * Each entry is the type's current version, the only one the reducers accept; a historic version
 * reaches them through `upcastWorldEvent`.
 */
const WORLD_EVENT_VERSIONS: Readonly<Record<WorldEvent["type"], WorldEvent["schemaVersion"]>> = {
  "boundary.departed": 1,
  "boundary.returned": 1,
  "resource.boundary-exchanged": 1,
  "process.command-attempted": 1,
  "needs.changed": 1,
  /** Version 2: emitted only for a material decision; version 1 was emitted for every one. */
  "routine.selected": 2,
  "time.advanced": 1,
  "weather.changed": 1,
  "object.created": 1,
  "object.retired": 1,
  "containment.put": 1,
  "containment.removed": 1,
  "containment.transferred": 1,
  "resource.offered": 1,
  "resource.consumed": 1,
  "resource.transferred": 1,
  "movement.started": 1,
  "movement.region-entered": 1,
  "movement.region-exited": 1,
  "movement.region-remained": 1,
  "movement.portal-crossed": 1,
  "movement.interrupted": 1,
  "movement.replanned": 1,
  "movement.completed": 1,
  "portal.opened": 1,
  "portal.closed": 1,
  "environment.phase-changed": 1,
  "weather.transitioned": 1,
  "exposure.threshold-crossed": 1,
  "resource.appeared": 1,
  "resource.weather-integrated": 1,
  "resource.spoiled": 1,
  "growth.stage-changed": 1,
  "growth.integrated": 1,
  "wellbeing.integrated": 1,
  "needs.threshold-crossed": 1,
  "comfort.changed": 1,
  "health.threshold-crossed": 1,
  "location.changed": 1,
  "needs.relieved": 1,
  "lifecycle.conceived": 1,
  "lifecycle.gestation-milestone": 1,
  "lifecycle.born": 1,
  "lifecycle.stage-changed": 1,
  "lifecycle.died": 1,
  "lifecycle.successor-intended": 1,
};

/**
 * Exhaustive by construction: each world event type's feed category, or null when it is not
 * feed-worthy. The world, not the observer, decides what appears in the material feed.
 */
const WORLD_EVENT_FEED: Readonly<Record<WorldEvent["type"], WorldFeedCategory | null>> = {
  "boundary.departed": null,
  "boundary.returned": null,
  "resource.boundary-exchanged": "resource",
  "process.command-attempted": null,
  "needs.changed": null,
  "routine.selected": "routine",
  "time.advanced": null,
  "weather.changed": "weather",
  "object.created": "object",
  "object.retired": null,
  "containment.put": null,
  "containment.removed": null,
  "containment.transferred": null,
  "resource.offered": "resource",
  "resource.consumed": "resource",
  "resource.transferred": "resource",
  "movement.started": null,
  "movement.region-entered": null,
  "movement.region-exited": null,
  "movement.region-remained": null,
  "movement.portal-crossed": "movement",
  "movement.interrupted": null,
  "movement.replanned": null,
  "movement.completed": "movement",
  "portal.opened": "portal",
  "portal.closed": "portal",
  "environment.phase-changed": "weather",
  "weather.transitioned": "weather",
  "exposure.threshold-crossed": "wellbeing",
  "resource.appeared": null,
  "resource.weather-integrated": "resource",
  "resource.spoiled": "resource",
  "growth.stage-changed": "growth",
  "growth.integrated": null,
  "wellbeing.integrated": null,
  "needs.threshold-crossed": "wellbeing",
  "comfort.changed": null,
  "health.threshold-crossed": "wellbeing",
  "location.changed": null,
  "needs.relieved": null,
  "lifecycle.conceived": "lifecycle",
  "lifecycle.gestation-milestone": null,
  "lifecycle.born": "lifecycle",
  "lifecycle.stage-changed": "lifecycle",
  "lifecycle.died": "lifecycle",
  "lifecycle.successor-intended": null,
};

/** The feed category of a world event type, or `undefined` when it is unknown or not feed-worthy. */
export function worldEventFeedCategory(type: string): WorldFeedCategory | undefined {
  if (!Object.hasOwn(WORLD_EVENT_FEED, type)) return undefined;
  return WORLD_EVENT_FEED[type as WorldEvent["type"]] ?? undefined;
}

/** The feed-worthy world event types, in UTF-16 order. */
export const WORLD_FEED_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(WORLD_EVENT_FEED)
    .filter((type) => worldEventFeedCategory(type) !== undefined)
    .sort(),
);

/**
 * The world event types that record an actor's own decision (`payload.objectId` is the actor):
 * `routine.selected` carries the choice of utility, compiled policy or a decision point alike.
 */
const WORLD_DECISION_EVENTS: ReadonlySet<WorldEvent["type"]> = new Set(["routine.selected"]);

/** Whether a world event type records an actor's own decision. */
export function isWorldDecisionEvent(type: string): boolean {
  return (WORLD_DECISION_EVENTS as ReadonlySet<string>).has(type);
}

/** An event as the upcast sees it: any record with a type, a schema version and a payload. */
export interface VersionedEventRecord {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/**
 * The one upcast table: per event type, per historic version, the payload at the type's current
 * version. The target version is always `WORLD_EVENT_VERSIONS[type]`, so a version change here
 * cannot disagree with it. `routine.selected@1` keeps its payload as `@2`.
 */
const WORLD_EVENT_UPCASTS: Readonly<
  Partial<Record<WorldEvent["type"], Readonly<Record<number, (payload: unknown) => unknown>>>>
> = {
  "routine.selected": { 1: (payload) => payload },
};

function historicUpcast(
  type: string,
  version: number,
): ((payload: unknown) => unknown) | undefined {
  if (!Object.hasOwn(WORLD_EVENT_UPCASTS, type)) return undefined;
  const byVersion = WORLD_EVENT_UPCASTS[type as WorldEvent["type"]];
  return byVersion !== undefined && Object.hasOwn(byVersion, version)
    ? byVersion[version]
    : undefined;
}

/** The current schema version of a world event type, or `undefined` for an unknown type. */
export function worldEventVersion(type: string): number | undefined {
  return Object.hasOwn(WORLD_EVENT_VERSIONS, type)
    ? WORLD_EVENT_VERSIONS[type as WorldEvent["type"]]
    : undefined;
}

/**
 * The current version an event `type@version` reads as: the version itself when current, the
 * current version when `version` is a historic version that upcasts to it, else `undefined`.
 */
export function currentWorldEventVersion(type: string, version: number): number | undefined {
  const current = worldEventVersion(type);
  if (current === undefined) return undefined;
  if (version === current) return current;
  return historicUpcast(type, version) === undefined ? undefined : current;
}

/**
 * Reads an event at its current version through the upcast table: a historic version of a known
 * type is rewritten, anything else (current, unknown type or unsupported version) is returned as it
 * is. Replay and rule evaluation both read events through this, so they cannot disagree.
 */
export function upcastEventRecord<E extends VersionedEventRecord>(event: E): E {
  const upcast = historicUpcast(event.type, event.schemaVersion);
  const current = worldEventVersion(event.type);
  if (upcast === undefined || current === undefined || event.schemaVersion === current)
    return event;
  return { ...event, schemaVersion: current, payload: upcast(event.payload) };
}

/** Registered semantic world events at their current schema versions. */
export const WORLD_EVENT_DEFINITIONS: readonly VersionedDefinition[] = Object.freeze(
  Object.entries(WORLD_EVENT_VERSIONS).map(([type, version]) => Object.freeze({ type, version })),
);
