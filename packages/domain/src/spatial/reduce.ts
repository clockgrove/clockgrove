import { DomainValidationError } from "../actor-process.js";
import type { MovementEventData } from "../events/movement-events.js";
import type { FixedPoint } from "../spatial.js";
import type { WorldEntity, WorldState } from "../world.js";
import { parseAnchorGraph } from "./anchors.js";
import {
  type CrossingRecord,
  currentInside,
  expectedCrossings,
  isRegionCrossing,
  type MovementRecord,
  movementCompletionTime,
  parseMovementRecord,
  positionAt,
} from "./movement.js";
import { compareText } from "./parse.js";
import { portalIsOpen, validatePortalSteps } from "./portal.js";
import {
  parseSpatialRegion,
  regionContains,
  type SpatialRegion,
  shapeDimensions,
} from "./region.js";

function fail(path: string, message: string): never {
  throw new DomainValidationError(path, message);
}

export function sameCoordinates(left: readonly bigint[], right: readonly bigint[]): boolean {
  return left.length === right.length && left.every((value, axis) => value === right[axis]);
}

function sameCrossing(left: CrossingRecord, right: CrossingRecord): boolean {
  if (left.kind === "portal" || right.kind === "portal")
    return (
      left.kind === "portal" &&
      right.kind === "portal" &&
      left.portalId === right.portalId &&
      left.time === right.time
    );
  return (
    left.regionId === right.regionId &&
    left.regionVersion === right.regionVersion &&
    left.kind === right.kind &&
    left.time === right.time
  );
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Region ids (sorted) in the pose's frame whose closed shape contains the point. */
export function regionsContaining(
  regions: readonly SpatialRegion[],
  frameId: string,
  frameVersion: number,
  coordinates: readonly bigint[],
): readonly string[] {
  return regions
    .filter(
      (region) =>
        region.frameId === frameId &&
        region.frameVersion === frameVersion &&
        shapeDimensions(region.shape) === coordinates.length &&
        regionContains(region, coordinates),
    )
    .map((region) => region.regionId)
    .sort(compareText);
}

/**
 * Whether an object has stayed inside a region from `enteredAt` through `at`, as remain-in-region
 * scheduling reads it from the movement record, not from how far the movement was observed. The
 * crossings by `at` are those an active movement's route implies (journaled or not), else those
 * journaled. The last entry into the region among them is at `enteredAt` (with none, the object was
 * already inside when the movement started), and the object is inside at `at`: by those crossings
 * while an active movement is under way, else by where it stands (the route's end or its pose).
 * An object that never moved has never entered a region.
 */
export function remainsInside(
  state: WorldState,
  entity: WorldEntity,
  regionId: string,
  enteredAt: bigint,
  at: bigint,
): boolean {
  const movement = entity.movement;
  if (movement === undefined) return false;
  const regions = state.spatialRegions ?? [];
  const active = movement.status === "active";
  const crossings = active
    ? expectedCrossings(movement, regions).filter((crossing) => crossing.time <= at)
    : movement.emitted;
  const entries = crossings.filter(
    (crossing) => crossing.kind === "entered" && crossing.regionId === regionId,
  );
  const entry = entries[entries.length - 1];
  if (entry === undefined ? enteredAt > movement.segment.startTime : entry.time !== enteredAt)
    return false;
  if (active && at < movementCompletionTime(movement.segment))
    return currentInside({ ...movement, emitted: crossings }).includes(regionId);
  const where = active ? positionAt(movement.segment, at) : entity.pose.coordinates;
  return regionsContaining(regions, entity.pose.frameId, entity.pose.frameVersion, where).includes(
    regionId,
  );
}

/**
 * Whether a region exit at `time` only closes the crossing stream of a movement that ends inside
 * that region (the stream reports every region exited at the segment's end): an arrival, not a
 * departure.
 */
export function isArrivalExit(
  state: WorldState,
  movement: MovementRecord,
  regionId: string,
  time: bigint,
): boolean {
  if (time !== movementCompletionTime(movement.segment)) return false;
  const waypoints = movement.segment.waypoints;
  return regionsContaining(
    state.spatialRegions ?? [],
    movement.frameId,
    movement.frameVersion,
    waypoints[waypoints.length - 1]!,
  ).includes(regionId);
}

/** Validates regions and anchor graphs against the declared frames; throws DomainValidationError. */
export function validateSpatialCollections(state: WorldState): void {
  const frames = state.spatialFrames;
  const regionIds = new Set<string>();
  for (const [index, region] of (state.spatialRegions ?? []).entries()) {
    parseSpatialRegion(region, `state.spatialRegions[${index}]`);
    if (regionIds.has(region.regionId)) fail("state.spatialRegions", "region ids must be unique");
    regionIds.add(region.regionId);
    const frame = frames.find((candidate) => candidate.frameId === region.frameId);
    if (frame === undefined || frame.version !== region.frameVersion)
      fail(`state.spatialRegions[${index}].frameId`, "does not reference a declared frame version");
    if (frame.dimensions !== shapeDimensions(region.shape))
      fail(`state.spatialRegions[${index}].shape`, "does not match the frame dimensions");
  }
  const graphIds = new Set<string>();
  for (const [index, graph] of (state.anchorGraphs ?? []).entries()) {
    parseAnchorGraph(graph, `state.anchorGraphs[${index}]`);
    if (graphIds.has(graph.graphId)) fail("state.anchorGraphs", "graph ids must be unique");
    graphIds.add(graph.graphId);
    const frame = frames.find((candidate) => candidate.frameId === graph.frameId);
    if (frame === undefined || frame.version !== graph.frameVersion)
      fail(`state.anchorGraphs[${index}].frameId`, "does not reference a declared frame version");
    if (graph.anchors[0]!.coordinates.length !== frame.dimensions)
      fail(`state.anchorGraphs[${index}].anchors`, "do not match the frame dimensions");
  }
  const anchorOwner = new Map<string, string>();
  for (const graph of state.anchorGraphs ?? [])
    for (const anchor of graph.anchors) {
      if (anchorOwner.has(anchor.anchorId))
        fail("state.anchorGraphs", "anchor ids must be unique across graphs");
      anchorOwner.set(anchor.anchorId, graph.graphId);
    }
}

/** Validates the movement record of an entity against the state's frames, regions and pose. */
export function validateEntityMovement(state: WorldState, entity: WorldEntity, path: string): void {
  const movement = entity.movement;
  if (movement === undefined) return;
  const frame = state.spatialFrames.find((candidate) => candidate.frameId === entity.pose.frameId);
  if (frame === undefined) fail(`${path}.pose.frameId`, "does not reference a declared frame");
  const record = parseMovementRecord(movement, frame.dimensions, `${path}.movement`);
  if (record.frameId !== entity.pose.frameId || record.frameVersion !== entity.pose.frameVersion)
    fail(`${path}.movement.frameId`, "must match the entity pose frame");
  if (record.segment.startTime > state.simulationTime)
    fail(`${path}.movement.segment.startTime`, "must not exceed the state simulation time");
  if (record.endedAt !== undefined && record.endedAt > state.simulationTime)
    fail(`${path}.movement.endedAt`, "must not exceed the state simulation time");
  const expected = expectedCrossings(record, state.spatialRegions ?? []);
  const limit =
    record.status === "completed"
      ? record.endedAt!
      : record.status === "interrupted"
        ? record.endedAt!
        : undefined;
  const due =
    limit === undefined ? expected : expected.filter((crossing) => crossing.time <= limit);
  const prefixOnly = record.status === "active";
  if (
    record.emitted.length > due.length ||
    (!prefixOnly && record.emitted.length !== due.length) ||
    record.emitted.some((crossing, index) => !sameCrossing(crossing, due[index]!))
  )
    fail(`${path}.movement.emitted`, "must match the crossings implied by the route");
  const pose = entity.pose.coordinates;
  const where =
    record.status === "active"
      ? record.segment.waypoints[0]!
      : positionAt(record.segment, record.endedAt!);
  if (!sameCoordinates(pose, where))
    fail(`${path}.pose.coordinates`, "must match the movement record");
}

function requireEntity(state: WorldState, objectId: string): WorldEntity {
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  if (entity === undefined) fail("event.objectId", "does not reference a declared entity");
  if (entity.lifecycle !== undefined && entity.lifecycle.status !== "active")
    fail("event.objectId", "entity is not active");
  return entity;
}

function replace(state: WorldState, entity: WorldEntity): readonly WorldEntity[] {
  return state.entities.map((candidate) =>
    candidate.objectId === entity.objectId ? entity : candidate,
  );
}

function withPose(entity: WorldEntity, coordinates: readonly FixedPoint[]): WorldEntity["pose"] {
  return { ...entity.pose, coordinates } as WorldEntity["pose"];
}

function activeOf(entity: WorldEntity, movementId: string): MovementRecord {
  const movement = entity.movement;
  if (movement === undefined || movement.movementId !== movementId || movement.status !== "active")
    return fail("event.movementId", "does not reference the active movement of the entity");
  return movement;
}

function requireAllDue(
  movement: MovementRecord,
  regions: readonly SpatialRegion[],
  at: bigint,
): void {
  const due = expectedCrossings(movement, regions).filter((crossing) => crossing.time <= at);
  if (due.length !== movement.emitted.length)
    fail("event.crossings", "every crossing up to the event time must be reported first");
}

function checkNewRecord(
  state: WorldState,
  entity: WorldEntity,
  record: MovementRecord,
  start: readonly bigint[],
  at: bigint,
): void {
  const frame = state.spatialFrames.find((candidate) => candidate.frameId === entity.pose.frameId);
  if (frame === undefined) fail("event.movement.frameId", "does not reference a declared frame");
  const parsed = parseMovementRecord(record, frame.dimensions, "event.movement");
  if (
    parsed.status !== "active" ||
    parsed.endedAt !== undefined ||
    parsed.successorId !== undefined
  )
    fail("event.movement.status", "a new movement must be active");
  if (parsed.frameId !== entity.pose.frameId || parsed.frameVersion !== entity.pose.frameVersion)
    fail("event.movement.frameId", "must match the entity pose frame");
  if (parsed.segment.startTime !== at)
    fail("event.movement.segment.startTime", "must equal the event time");
  if (!sameCoordinates(parsed.segment.waypoints[0]!, start))
    fail("event.movement.segment.waypoints", "must start at the current position");
  if (parsed.emitted.length !== 0) fail("event.movement.emitted", "must start empty");
  validatePortalSteps(state, parsed, "event.movement");
  const last = parsed.segment.waypoints[parsed.segment.waypoints.length - 1]!;
  if (parsed.destination.kind === "pose") {
    const pose = parsed.destination.pose;
    if (pose.frameId !== parsed.frameId || pose.frameVersion !== parsed.frameVersion)
      fail("event.movement.destination", "must stay in the movement frame");
    if (!sameCoordinates(pose.coordinates, last))
      fail("event.movement.destination", "must be the last waypoint");
  } else {
    const destination = parsed.destination;
    const graph = (state.anchorGraphs ?? []).find((candidate) =>
      candidate.anchors.some((anchor) => anchor.anchorId === destination.anchorId),
    );
    const anchor = graph?.anchors.find((candidate) => candidate.anchorId === destination.anchorId);
    if (graph === undefined || anchor === undefined || graph.version !== destination.graphVersion)
      fail("event.movement.destination", "does not reference a declared anchor");
    if (!sameCoordinates(anchor.coordinates, last))
      fail("event.movement.destination", "must be the last waypoint");
  }
}

/**
 * Applies one movement event and returns the updated entities. The caller has already validated
 * the state and advanced revision and simulation time.
 */
export function reduceMovementEvent(
  state: WorldState,
  event: MovementEventData & { readonly simulationTime: bigint },
): readonly WorldEntity[] {
  const regions = state.spatialRegions ?? [];
  const at = event.simulationTime;
  switch (event.type) {
    case "movement.started": {
      const entity = requireEntity(state, event.payload.objectId);
      if (entity.movement?.status === "active")
        fail("event.objectId", "entity already has an active movement");
      const record = event.payload.movement;
      checkNewRecord(state, entity, record, entity.pose.coordinates, at);
      if (record.priorMovementId !== undefined)
        fail("event.movement.priorMovementId", "a started movement has no predecessor");
      if (record.exitedAtStart.length !== 0)
        fail("event.movement.exitedAtStart", "a started movement has no predecessor exits");
      const inside = regionsContaining(
        regions,
        entity.pose.frameId,
        entity.pose.frameVersion,
        entity.pose.coordinates,
      );
      if (!sameList(inside, record.initialInside))
        fail("event.movement.initialInside", "must list the regions containing the start");
      return replace(state, { ...entity, movement: record });
    }
    case "movement.region-entered":
    case "movement.region-exited": {
      const entity = requireEntity(state, event.payload.objectId);
      const movement = activeOf(entity, event.payload.movementId);
      const next = expectedCrossings(movement, regions)[movement.emitted.length];
      const kind = event.type === "movement.region-entered" ? "entered" : "exited";
      if (
        next === undefined ||
        next.kind === "portal" ||
        next.kind !== kind ||
        next.regionId !== event.payload.regionId ||
        next.regionVersion !== event.payload.regionVersion ||
        next.time !== at
      )
        fail("event.payload", "is not the next crossing implied by the route");
      return replace(state, {
        ...entity,
        movement: { ...movement, emitted: [...movement.emitted, next] },
      });
    }
    case "movement.region-remained": {
      // Changes nothing but revision and time: the object has stayed inside the region a whole
      // dwell since the entry its movement lineage last made (`remainsInside`).
      const entity = requireEntity(state, event.payload.objectId);
      const { regionId, regionVersion, enteredAt } = event.payload;
      const region = regions.find((candidate) => candidate.regionId === regionId);
      if (region?.dwell === undefined || region.version !== regionVersion)
        fail("event.regionId", "does not reference a declared region with a dwell");
      if (typeof enteredAt !== "bigint" || enteredAt + region.dwell.durationMs !== at)
        fail("event.enteredAt", "must lie one dwell before the event time");
      if (!remainsInside(state, entity, regionId, enteredAt, at))
        fail("event.objectId", "has not stayed inside the region since it last entered it");
      return state.entities;
    }
    case "movement.portal-crossed": {
      const entity = requireEntity(state, event.payload.objectId);
      const movement = activeOf(entity, event.payload.movementId);
      const next = expectedCrossings(movement, regions)[movement.emitted.length];
      if (
        next === undefined ||
        next.kind !== "portal" ||
        next.portalId !== event.payload.portalId ||
        next.time !== at
      )
        fail("event.payload", "is not the next crossing implied by the route");
      // Actors cross only through an open portal: the portal must still be open when crossed.
      if (!portalIsOpen(state, next.portalId))
        fail("event.portalId", "does not reference an open portal");
      return replace(state, {
        ...entity,
        movement: { ...movement, emitted: [...movement.emitted, next] },
      });
    }
    case "movement.interrupted": {
      const entity = requireEntity(state, event.payload.objectId);
      const movement = activeOf(entity, event.payload.movementId);
      if (at < movement.segment.startTime || at >= movementCompletionTime(movement.segment))
        fail("event.simulationTime", "must fall within the movement");
      requireAllDue(movement, regions, at);
      const position = positionAt(movement.segment, at);
      if (!sameCoordinates(position, event.payload.position))
        fail("event.position", "must be the interpolated position");
      return replace(state, {
        ...entity,
        pose: withPose(entity, position),
        movement: { ...movement, status: "interrupted", endedAt: at },
      });
    }
    case "movement.completed": {
      const entity = requireEntity(state, event.payload.objectId);
      const movement = activeOf(entity, event.payload.movementId);
      if (at !== movementCompletionTime(movement.segment))
        fail("event.simulationTime", "must equal the completion time");
      requireAllDue(movement, regions, at);
      return replace(state, {
        ...entity,
        pose: withPose(entity, positionAt(movement.segment, at)),
        movement: { ...movement, status: "completed", endedAt: at },
      });
    }
    case "movement.replanned": {
      const entity = requireEntity(state, event.payload.objectId);
      const prior = entity.movement;
      if (
        prior === undefined ||
        prior.movementId !== event.payload.priorMovementId ||
        prior.status === "completed"
      )
        fail("event.priorMovementId", "does not reference a replannable movement");
      let position: readonly FixedPoint[];
      if (prior.status === "active") {
        if (at < prior.segment.startTime || at >= movementCompletionTime(prior.segment))
          fail("event.simulationTime", "must fall within the movement");
        requireAllDue(prior, regions, at);
        position = positionAt(prior.segment, at);
      } else {
        if (at < prior.endedAt!) fail("event.simulationTime", "must not precede the interruption");
        position = entity.pose.coordinates;
      }
      if (!sameCoordinates(position, event.payload.position))
        fail("event.position", "must be the current position");
      const record = event.payload.movement;
      checkNewRecord(state, entity, record, position, at);
      if (record.priorMovementId !== prior.movementId || record.movementId === prior.movementId)
        fail("event.movement.priorMovementId", "must name the replanned movement");
      if (!sameList(record.initialInside, currentInside(prior)))
        fail("event.movement.initialInside", "must inherit the regions the prior movement is in");
      const exited = [
        ...new Set(
          prior.emitted
            .filter(isRegionCrossing)
            .filter((crossing) => crossing.kind === "exited" && crossing.time === at)
            .map((crossing) => crossing.regionId),
        ),
      ].sort(compareText);
      if (!sameList(record.exitedAtStart, exited))
        fail("event.movement.exitedAtStart", "must list the regions exited at the replan time");
      return replace(state, { ...entity, pose: withPose(entity, position), movement: record });
    }
  }
}
