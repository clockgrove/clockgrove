import type { ObjectId } from "@clockgrove/contracts";
import {
  type Anchor,
  type AnchorGraph,
  type CrossingRecord,
  currentInside,
  expectedCrossings,
  type FixedPoint,
  findAnchor,
  isRegionCrossing,
  type MovementDestination,
  type MovementInterruptPayload,
  type MovementRecord,
  type MovementReplanPayload,
  type MovementStartPayload,
  movementCompletionTime,
  type PortalStep,
  parseMovementRecord,
  portalEdges,
  portalSides,
  positionAt,
  regionsContaining,
  type SemanticPose,
  type SpatialRegion,
  sameCoordinates,
  shapeBounds,
  shapeDimensions,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import type { SpatialIndexFactory } from "./index-port.js";
import { type AnchorRoute, routeAnchors } from "./router.js";

export interface MovementRuntime {
  /** State the command was submitted against. */
  readonly state: WorldState;
  readonly command: Readonly<{ type: string; commandId: string }>;
  readonly payload: unknown;
  readonly emit: (type: string, payload: unknown, time: bigint) => void;
  readonly indexFactory: SpatialIndexFactory;
}

export type Plan =
  | Readonly<{ ok: true; record: MovementRecord }>
  | Readonly<{ ok: false; path: string }>;

export interface Lineage {
  readonly priorMovementId?: string;
  readonly initialInside: readonly string[];
  readonly exitedAtStart: readonly string[];
}

function find(state: WorldState, objectId: string): WorldEntity | undefined {
  return state.entities.find((entity) => entity.objectId === objectId);
}

export function movementIdFor(commandId: string): string {
  return `movement-${commandId}`;
}

/**
 * The anchor route a move between two points must take through `graph` when portals separate
 * them (graph 3): both attach to anchors (`portalSides`) on different anchor-edge sides, at
 * least one of them guarded. Undefined when the move may go straight; null when no route through
 * open portals joins the two sides.
 */
function separatedRoute(
  state: WorldState,
  graph: AnchorGraph,
  from: readonly bigint[],
  to: readonly bigint[] | Anchor,
): AnchorRoute | null | undefined {
  const sides = portalSides(state, graph);
  if (sides === undefined) return undefined;
  const first = sides.attach(from);
  const last = "anchorId" in to ? to : sides.attach(to);
  const [near, far] = [sides.side(first.anchorId), sides.side(last.anchorId)];
  if (near === far || (!sides.guarded.has(near) && !sides.guarded.has(far))) return undefined;
  return routeAnchors(graph, first.anchorId, last.anchorId, portalEdges(state, graph)) ?? null;
}

function coordinatesOf(graph: AnchorGraph, anchors: readonly string[]): (readonly bigint[])[] {
  return anchors.map(
    (id) => graph.anchors.find((candidate) => candidate.anchorId === id)!.coordinates,
  );
}

/**
 * Routes and builds the movement record for a destination. A start that coincides with an anchor
 * is routed to an anchor destination over the anchor graph joined with the open portals (A*).
 * Any other move travels straight, unless portals separate its start and destination
 * (`separatedRoute`): it then goes straight to the start's anchor, over that graph to the
 * destination's, and on to a pose destination, or is refused when no open portal joins them.
 * Failures carry the offending payload path.
 */
export function planMovement(
  state: WorldState,
  entity: WorldEntity,
  start: readonly bigint[],
  destination: MovementDestination,
  unitsPerSecond: bigint,
  startTime: bigint,
  commandId: string,
  lineage: Lineage,
): Plan {
  let anchorPath: string[] = [];
  let waypoints: (readonly bigint[])[];
  let via: readonly (string | null)[] = [];
  let anchorOffset = 0;
  if (destination.kind === "pose") {
    const pose = destination.pose;
    const frame = state.spatialFrames.find((candidate) => candidate.frameId === pose.frameId);
    if (frame === undefined || pose.frameId !== entity.pose.frameId)
      return { ok: false, path: "payload.destination.pose.frameId" };
    if (frame.version !== pose.frameVersion || entity.pose.frameVersion !== pose.frameVersion)
      return { ok: false, path: "payload.destination.pose.frameVersion" };
    if (pose.coordinates.length !== start.length)
      return { ok: false, path: "payload.destination.pose.coordinates" };
    waypoints = [start, pose.coordinates];
    for (const graph of state.anchorGraphs ?? []) {
      if (
        graph.frameId !== pose.frameId ||
        graph.frameVersion !== pose.frameVersion ||
        graph.anchors[0]!.coordinates.length !== start.length
      )
        continue;
      const route = separatedRoute(state, graph, start, pose.coordinates);
      if (route === null) return { ok: false, path: "payload.destination" };
      if (route === undefined) continue;
      anchorPath = [...route.anchors];
      via = route.via;
      anchorOffset = 1;
      waypoints = [start, ...coordinatesOf(graph, route.anchors), pose.coordinates];
      break;
    }
  } else {
    const found = findAnchor(state.anchorGraphs ?? [], destination.anchorId);
    if (found === undefined) return { ok: false, path: "payload.destination.anchorId" };
    const { graph, anchor } = found;
    if (graph.version !== destination.graphVersion)
      return { ok: false, path: "payload.destination.graphVersion" };
    if (
      graph.frameId !== entity.pose.frameId ||
      graph.frameVersion !== entity.pose.frameVersion ||
      anchor.coordinates.length !== start.length
    )
      return { ok: false, path: "payload.destination.anchorId" };
    const origin = graph.anchors.find((candidate) => sameCoordinates(candidate.coordinates, start));
    if (origin === undefined) {
      const route = separatedRoute(state, graph, start, anchor);
      if (route === null) return { ok: false, path: "payload.destination" };
      if (route === undefined) {
        anchorPath = [anchor.anchorId];
        waypoints = [start, anchor.coordinates];
      } else {
        anchorPath = [...route.anchors];
        via = route.via;
        anchorOffset = 1;
        waypoints = [start, ...coordinatesOf(graph, route.anchors)];
      }
    } else {
      const route = routeAnchors(
        graph,
        origin.anchorId,
        anchor.anchorId,
        portalEdges(state, graph),
      );
      if (route === undefined) return { ok: false, path: "payload.destination" };
      anchorPath = [...route.anchors];
      via = route.via;
      waypoints = coordinatesOf(graph, route.anchors);
    }
  }
  return buildRecord(
    state,
    entity,
    waypoints,
    anchorPath,
    via,
    destination,
    unitsPerSecond,
    startTime,
    commandId,
    lineage,
    anchorOffset,
  );
}

/**
 * The movement record of a planned route: consecutive equal waypoints collapse, and every hop
 * taken through a portal (`via`) becomes a portal step pointing at the waypoint it arrives at.
 * `anchorPath[0]` is `waypoints[anchorOffset]`, and the anchors follow in order.
 */
export function buildRecord(
  state: WorldState,
  entity: WorldEntity,
  waypoints: readonly (readonly bigint[])[],
  anchorPath: readonly string[],
  via: readonly (string | null)[],
  destination: MovementDestination,
  unitsPerSecond: bigint,
  startTime: bigint,
  commandId: string,
  lineage: Lineage,
  anchorOffset = 0,
): Plan {
  const collapsed: (readonly bigint[])[] = [];
  const at: number[] = [];
  for (const point of waypoints) {
    if (collapsed.length === 0 || !sameCoordinates(point, collapsed[collapsed.length - 1]!))
      collapsed.push(point);
    at.push(collapsed.length - 1);
  }
  const portalSteps: PortalStep[] = [];
  via.forEach((portalId, hop) => {
    if (portalId !== null)
      portalSteps.push({
        portalId,
        from: anchorPath[hop]!,
        to: anchorPath[hop + 1]!,
        waypoint: at[anchorOffset + hop + 1]!,
      });
  });
  const record = {
    movementId: movementIdFor(commandId),
    ...(lineage.priorMovementId === undefined ? {} : { priorMovementId: lineage.priorMovementId }),
    status: "active",
    frameId: entity.pose.frameId,
    frameVersion: entity.pose.frameVersion,
    destination,
    anchorPath,
    ...(portalSteps.length === 0 ? {} : { portalSteps }),
    segment: {
      waypoints: collapsed,
      startTime,
      speed: { kind: "constant-units-per-second", unitsPerSecond },
    },
    initialInside: lineage.initialInside,
    exitedAtStart: lineage.exitedAtStart,
    emitted: [],
  } as unknown as MovementRecord;
  try {
    const frame = state.spatialFrames.find(
      (candidate) => candidate.frameId === entity.pose.frameId,
    );
    parseMovementRecord(record, frame!.dimensions, "movement");
  } catch {
    return { ok: false, path: "payload.destination" };
  }
  return { ok: true, record };
}

function regionsOfFrame(state: WorldState, entity: WorldEntity): readonly SpatialRegion[] {
  return (state.spatialRegions ?? []).filter(
    (region) =>
      region.frameId === entity.pose.frameId &&
      region.frameVersion === entity.pose.frameVersion &&
      shapeDimensions(region.shape) === entity.pose.coordinates.length,
  );
}

/** Narrows the regions to those whose bounds meet the route's bounds, via the spatial index. */
function candidateRegions(
  rt: MovementRuntime,
  entity: WorldEntity,
  movement: MovementRecord,
): readonly SpatialRegion[] {
  const regions = regionsOfFrame(rt.state, entity);
  if (regions.length === 0) return regions;
  const epoch = rt.state.revision > 0x7fffffffn ? 0 : Number(rt.state.revision);
  const index = rt.indexFactory(epoch);
  // Each region is bound at the centre of its bounds; a region meets the route's bounds only if
  // its centre lies within the route bounds widened by the largest half-extent of any region.
  const axes = entity.pose.coordinates.length;
  let reach = 0n;
  for (const region of regions) {
    const [low, high] = shapeBounds(region.shape);
    const center = low.map((value, axis) => (value + high[axis]!) / 2n);
    for (let axis = 0; axis < axes; axis += 1) {
      const half = high[axis]! - center[axis]! + 1n;
      if (half > reach) reach = half;
    }
    index.update(epoch, {
      op: "insert",
      binding: {
        objectId: region.regionId as ObjectId,
        pose: {
          frameId: region.frameId,
          frameVersion: region.frameVersion,
          coordinates: center as unknown as FixedPoint[],
        } as unknown as SemanticPose,
      },
    });
  }
  const points = movement.segment.waypoints;
  const min: bigint[] = [];
  const max: bigint[] = [];
  for (let axis = 0; axis < axes; axis += 1) {
    min.push(
      points.reduce((low, point) => (point[axis]! < low ? point[axis]! : low), points[0]![axis]!) -
        reach,
    );
    max.push(
      points.reduce(
        (high, point) => (point[axis]! > high ? point[axis]! : high),
        points[0]![axis]!,
      ) + reach,
    );
  }
  const area = {
    regionId: "route-bounds",
    version: 1,
    frameId: entity.pose.frameId,
    frameVersion: entity.pose.frameVersion,
    shape: axes === 3 ? { kind: "box", min, max } : { kind: "rectangle", min, max },
  } as unknown as SpatialRegion;
  const ids = new Set(index.query(epoch, area));
  return regions.filter((region) => ids.has(region.regionId));
}

/** Emits the not-yet-reported crossings up to `upTo`; returns the record with them appended. */
function flush(
  rt: MovementRuntime,
  entity: WorldEntity,
  movement: MovementRecord,
  upTo: bigint,
): MovementRecord {
  const pending = expectedCrossings(movement, candidateRegions(rt, entity, movement))
    .slice(movement.emitted.length)
    .filter((crossing) => crossing.time <= upTo);
  for (const crossing of pending) {
    const [type, payload] = crossingEvent(entity.objectId, movement.movementId, crossing);
    rt.emit(type, payload, crossing.time);
  }
  return { ...movement, emitted: [...movement.emitted, ...pending] };
}

/** The semantic event type and payload of one region or portal crossing. */
export function crossingEvent(
  objectId: string,
  movementId: string,
  crossing: CrossingRecord,
): readonly [string, Readonly<Record<string, unknown>>] {
  if (crossing.kind === "portal")
    return ["movement.portal-crossed", { objectId, movementId, portalId: crossing.portalId }];
  return [
    crossing.kind === "entered" ? "movement.region-entered" : "movement.region-exited",
    { objectId, movementId, regionId: crossing.regionId, regionVersion: crossing.regionVersion },
  ];
}

export function observe(
  rt: MovementRuntime,
  entity: WorldEntity,
  record: MovementRecord,
  observeUntil: bigint | undefined,
): void {
  const completion = movementCompletionTime(record.segment);
  const limit = observeUntil ?? completion;
  flush(rt, entity, record, limit < completion ? limit : completion);
  if (completion <= limit)
    rt.emit(
      "movement.completed",
      { objectId: entity.objectId, movementId: record.movementId },
      completion,
    );
}

export function runMovementHandler(rt: MovementRuntime): void {
  const { state } = rt;
  switch (rt.command.type) {
    case "movement.start": {
      const payload = rt.payload as MovementStartPayload;
      const entity = find(state, payload.objectId)!;
      const plan = planMovement(
        state,
        entity,
        entity.pose.coordinates,
        payload.destination,
        payload.unitsPerSecond,
        state.simulationTime,
        rt.command.commandId,
        {
          initialInside: regionsContaining(
            state.spatialRegions ?? [],
            entity.pose.frameId,
            entity.pose.frameVersion,
            entity.pose.coordinates,
          ),
          exitedAtStart: [],
        },
      );
      if (!plan.ok) throw new RangeError("route is not plannable");
      rt.emit(
        "movement.started",
        { objectId: entity.objectId, movement: plan.record },
        state.simulationTime,
      );
      observe(rt, entity, plan.record, payload.observeUntil);
      return;
    }
    case "movement.interrupt": {
      const payload = rt.payload as MovementInterruptPayload;
      const entity = find(state, payload.objectId)!;
      const movement = flush(rt, entity, entity.movement!, payload.at);
      rt.emit(
        "movement.interrupted",
        {
          objectId: entity.objectId,
          movementId: movement.movementId,
          position: positionAt(movement.segment, payload.at),
        },
        payload.at,
      );
      return;
    }
    case "movement.replan": {
      const payload = rt.payload as MovementReplanPayload;
      const entity = find(state, payload.objectId)!;
      let prior = entity.movement!;
      let position: readonly FixedPoint[];
      if (prior.status === "active") {
        prior = flush(rt, entity, prior, payload.at);
        position = positionAt(prior.segment, payload.at);
      } else {
        position = entity.pose.coordinates;
      }
      const exitedAtStart = [
        ...new Set(
          prior.emitted
            .filter(isRegionCrossing)
            .filter((crossing) => crossing.kind === "exited" && crossing.time === payload.at)
            .map((crossing) => crossing.regionId),
        ),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const plan = planMovement(
        state,
        entity,
        position,
        payload.destination,
        payload.unitsPerSecond,
        payload.at,
        rt.command.commandId,
        {
          priorMovementId: prior.movementId,
          initialInside: currentInside(prior),
          exitedAtStart,
        },
      );
      if (!plan.ok) throw new RangeError("route is not plannable");
      rt.emit(
        "movement.replanned",
        {
          objectId: entity.objectId,
          priorMovementId: prior.movementId,
          position,
          movement: plan.record,
        },
        payload.at,
      );
      observe(
        rt,
        { ...entity, pose: { ...entity.pose, coordinates: position as never } },
        plan.record,
        payload.observeUntil,
      );
      return;
    }
  }
}

/** Offending payload path of the first violated movement precondition, or undefined. */
export function movementPreconditionPath(
  check: "active-object" | "route" | "timing",
  state: WorldState,
  commandType: string,
  commandId: string,
  payload: unknown,
): string | undefined {
  const p = payload as MovementStartPayload & MovementInterruptPayload & MovementReplanPayload;
  const entity = find(state, p.objectId);
  if (check === "active-object") {
    if (entity === undefined) return "payload.objectId";
    if (entity.lifecycle !== undefined && entity.lifecycle.status !== "active")
      return "payload.objectId";
    const movement = entity.movement;
    if (commandType === "movement.start")
      return movement?.status === "active" ? "payload.objectId" : undefined;
    if (commandType === "movement.interrupt")
      return movement?.status === "active" ? undefined : "payload.objectId";
    return movement === undefined || movement.status === "completed"
      ? "payload.objectId"
      : undefined;
  }
  if (entity === undefined) return undefined;
  const movement = entity.movement;
  const at = commandType === "movement.start" ? state.simulationTime : p.at;
  if (check === "timing") {
    if (commandType !== "movement.start") {
      if (at < state.simulationTime) return "payload.at";
      if (movement === undefined) return undefined;
      if (movement.status === "active") {
        if (at < movement.segment.startTime || at >= movementCompletionTime(movement.segment))
          return "payload.at";
      } else if (movement.endedAt !== undefined && at < movement.endedAt) {
        return "payload.at";
      }
    }
    if (commandType !== "movement.interrupt" && p.observeUntil !== undefined && p.observeUntil < at)
      return "payload.observeUntil";
    return undefined;
  }
  if (commandType === "movement.interrupt") return undefined;
  let start: readonly bigint[] = entity.pose.coordinates;
  if (commandType === "movement.replan") {
    if (movement === undefined || movement.status === "completed") return undefined;
    if (movement.status === "active") {
      if (at < movement.segment.startTime || at >= movementCompletionTime(movement.segment))
        return undefined;
      start = positionAt(movement.segment, at);
    }
  } else if (movement?.status === "active") {
    return undefined;
  }
  const plan = planMovement(state, entity, start, p.destination, p.unitsPerSecond, at, commandId, {
    initialInside: [],
    exitedAtStart: [],
  });
  return plan.ok ? undefined : plan.path;
}
