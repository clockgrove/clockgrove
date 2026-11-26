import type { WorldFeedCategory } from "@clockgrove/contracts";
import type { WorldEvent } from "../world.js";

export interface VersionedDefinition {
  readonly type: string;
  readonly version: number;
}

/** Where an event names an object playing a role: a path into its payload, or its attribution's actor. */
export type WorldEventRolePath =
  | readonly ["payload", ...string[]]
  | readonly ["attribution", "effectiveActorId"];

/**
 * What a world event type declares about itself beyond its version. `actor` performed the event and
 * `target` is what it was done to; either is null when the type names none. `integration` marks
 * integration bookkeeping, which advances a continuous quantity by however many steps the run took
 * (a live and a fast-forwarded run journal different numbers of it); its `quantities` are the payload
 * counts that, when any is non-zero, make one such event a material change all the same.
 */
export interface WorldEventDeclaration {
  readonly type: string;
  /** The type's current version, the only one the reducers accept. */
  readonly version: number;
  readonly actor: WorldEventRolePath | null;
  readonly target: WorldEventRolePath | null;
  readonly integration: Readonly<{ quantities: readonly string[] }> | null;
}

/** The performer named only by the event's attribution (the command's effective actor). */
const BY_ATTRIBUTION = ["attribution", "effectiveActorId"] as const;

function declare(
  version: number,
  actor: WorldEventRolePath | null,
  target: WorldEventRolePath | null,
  integration: WorldEventDeclaration["integration"],
): Omit<WorldEventDeclaration, "type"> {
  return { version, actor, target, integration };
}

/**
 * The world event vocabulary. Exhaustive by construction: adding a WorldEvent type without its
 * declaration here fails to compile. Each version is the type's current version, the only one the
 * reducers accept; a historic version reaches them through `upcastWorldEvent`. Every check that asks
 * who acted, what was acted on or whether an event is bookkeeping reads this table.
 */
const WORLD_EVENT_VOCABULARY: Readonly<
  Record<WorldEvent["type"], Omit<WorldEventDeclaration, "type">>
> = {
  "boundary.departed": declare(1, ["payload", "actorId"], null, null),
  "boundary.returned": declare(1, ["payload", "actorId"], null, null),
  "resource.boundary-exchanged": declare(1, ["payload", "actorId"], ["payload", "objectId"], null),
  "resource.purchase-granted": declare(1, null, ["payload", "objectId"], null),
  "resource.purchase-refunded": declare(1, null, ["payload", "objectId"], null),
  "process.command-attempted": declare(1, BY_ATTRIBUTION, null, null),
  "surface.interacted": declare(1, ["payload", "actorId"], null, null),
  "surface.band-crossed": declare(1, null, null, null),
  "surface.carried-drained": declare(1, null, ["payload", "actorId"], null),
  "surface.repaired": declare(1, BY_ATTRIBUTION, null, null),
  "needs.changed": declare(1, null, ["payload", "objectId"], { quantities: [] }),
  /** Version 2: emitted only for a material decision; version 1 was emitted for every one. */
  "routine.selected": declare(
    2,
    ["payload", "objectId"],
    ["payload", "action", "targetObjectId"],
    null,
  ),
  "time.advanced": declare(1, null, null, { quantities: [] }),
  "weather.changed": declare(1, null, null, null),
  "object.created": declare(1, BY_ATTRIBUTION, ["payload", "object", "objectId"], null),
  "object.retired": declare(1, BY_ATTRIBUTION, ["payload", "objectId"], null),
  /** The contained object and its container (the destination of a transfer), as before #365. */
  "containment.put": declare(1, ["payload", "objectId"], ["payload", "containerId"], null),
  "containment.removed": declare(1, ["payload", "objectId"], ["payload", "containerId"], null),
  "containment.transferred": declare(
    1,
    ["payload", "objectId"],
    ["payload", "toContainerId"],
    null,
  ),
  "resource.offered": declare(1, BY_ATTRIBUTION, ["payload", "objectId"], null),
  /** The eater is the optional `consumerId`; a consumption that names none has no actor. */
  "resource.consumed": declare(1, ["payload", "consumerId"], ["payload", "objectId"], null),
  "resource.transferred": declare(1, ["payload", "fromObjectId"], ["payload", "toObjectId"], null),
  "movement.started": declare(1, ["payload", "objectId"], null, null),
  "movement.region-entered": declare(1, ["payload", "objectId"], null, null),
  "movement.region-exited": declare(1, ["payload", "objectId"], null, null),
  "movement.region-remained": declare(1, ["payload", "objectId"], null, null),
  "movement.portal-crossed": declare(1, ["payload", "objectId"], ["payload", "portalId"], null),
  "movement.interrupted": declare(1, ["payload", "objectId"], null, null),
  "movement.replanned": declare(1, ["payload", "objectId"], null, null),
  "movement.completed": declare(1, ["payload", "objectId"], null, null),
  "portal.opened": declare(1, BY_ATTRIBUTION, ["payload", "portalId"], null),
  "portal.closed": declare(1, BY_ATTRIBUTION, ["payload", "portalId"], null),
  "environment.phase-changed": declare(1, null, null, null),
  "weather.transitioned": declare(1, null, null, null),
  "exposure.threshold-crossed": declare(1, null, ["payload", "objectId"], null),
  "resource.appeared": declare(1, null, ["payload", "objectId"], null),
  "resource.weather-integrated": declare(1, null, ["payload", "objectId"], {
    quantities: ["collected", "evaporated"],
  }),
  "resource.spoiled": declare(1, null, ["payload", "objectId"], null),
  "growth.stage-changed": declare(1, null, ["payload", "objectId"], null),
  "growth.integrated": declare(1, null, ["payload", "objectId"], { quantities: [] }),
  "wellbeing.integrated": declare(1, null, ["payload", "objectId"], { quantities: [] }),
  "needs.threshold-crossed": declare(1, null, ["payload", "objectId"], null),
  "comfort.changed": declare(1, null, ["payload", "objectId"], null),
  "health.threshold-crossed": declare(1, null, ["payload", "objectId"], null),
  "location.changed": declare(1, ["payload", "objectId"], ["payload", "locationId"], null),
  "needs.relieved": declare(1, ["payload", "objectId"], ["payload", "sourceObjectId"], null),
  "lifecycle.conceived": declare(1, ["payload", "objectId"], ["payload", "childId"], null),
  "lifecycle.gestation-milestone": declare(1, null, ["payload", "objectId"], null),
  "lifecycle.born": declare(1, ["payload", "gestatingParentId"], ["payload", "childId"], null),
  "lifecycle.stage-changed": declare(1, null, ["payload", "objectId"], null),
  "lifecycle.died": declare(1, null, ["payload", "objectId"], null),
  "lifecycle.successor-intended": declare(
    1,
    ["payload", "objectId"],
    ["payload", "successorId"],
    null,
  ),
};

const WORLD_EVENT_VERSIONS: Readonly<Record<WorldEvent["type"], WorldEvent["schemaVersion"]>> =
  Object.fromEntries(
    Object.entries(WORLD_EVENT_VOCABULARY).map(([type, entry]) => [type, entry.version]),
  ) as Record<WorldEvent["type"], WorldEvent["schemaVersion"]>;

/**
 * Exhaustive by construction: each world event type's feed category, or null when it is not
 * feed-worthy. The world, not the observer, decides what appears in the material feed.
 */
const WORLD_EVENT_FEED: Readonly<Record<WorldEvent["type"], WorldFeedCategory | null>> = {
  "boundary.departed": null,
  "boundary.returned": null,
  "resource.boundary-exchanged": "resource",
  "resource.purchase-granted": "resource",
  "resource.purchase-refunded": "resource",
  "process.command-attempted": null,
  "surface.interacted": null,
  "surface.band-crossed": null,
  "surface.carried-drained": null,
  "surface.repaired": null,
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

/** Every world event type's declaration: version, roles and whether it is integration bookkeeping. */
export const WORLD_EVENT_DECLARATIONS: readonly WorldEventDeclaration[] = Object.freeze(
  Object.entries(WORLD_EVENT_VOCABULARY).map(([type, entry]) => Object.freeze({ type, ...entry })),
);

/** The declaration of a world event type, or `undefined` for a type outside the vocabulary. */
export function worldEventDeclaration(type: string): WorldEventDeclaration | undefined {
  return Object.hasOwn(WORLD_EVENT_VOCABULARY, type)
    ? { type, ...WORLD_EVENT_VOCABULARY[type as WorldEvent["type"]] }
    : undefined;
}

/** Whether a type is declared integration bookkeeping; a type outside the vocabulary is not. */
export function isIntegrationEventType(type: string): boolean {
  return worldEventDeclaration(type)?.integration != null;
}

/**
 * Whether an event is a material change: anything but integration bookkeeping, and an integration
 * event whose declared quantities are not all zero. A type outside the vocabulary is material.
 */
export function materialWorldEvent(event: {
  readonly type: unknown;
  readonly payload: unknown;
}): boolean {
  if (typeof event.type !== "string") return true;
  const integration = worldEventDeclaration(event.type)?.integration;
  if (integration == null) return true;
  const payload = event.payload;
  const field = (key: string): unknown =>
    typeof payload === "object" && payload !== null
      ? (payload as Readonly<Record<string, unknown>>)[key]
      : undefined;
  return integration.quantities.some((key) => {
    const value = field(key);
    return value !== 0 && value !== 0n;
  });
}

/**
 * The object id playing `role` in an event, read through its type's declaration: null when the type
 * declares no such role or the event does not carry a non-empty string there.
 */
export function worldEventRole(
  event: { readonly type: unknown; readonly payload: unknown; readonly attribution?: unknown },
  role: "actor" | "target",
): string | null {
  if (typeof event.type !== "string") return null;
  const path = worldEventDeclaration(event.type)?.[role];
  if (path == null) return null;
  let value: unknown = path[0] === "payload" ? event.payload : event.attribution;
  for (const key of path.slice(1))
    value =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)[key]
        : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}
