import {
  type PortalEndpoint,
  portalSchema,
  portalScopeIssues,
} from "../components/catalog/index.js";
import { CompositionError, type DomainIssue } from "../components/registry/index.js";
import type { PortalEventData } from "../events/portal-events.js";
import type { WorldEntity, WorldState } from "../world.js";
import { type Anchor, type AnchorGraph, distanceFloor, findAnchor } from "./anchors.js";
import type { MovementRecord, PortalStep } from "./movement.js";
import { compareText, fail } from "./parse.js";
import { regionContains, type SpatialRegion, shapeDimensions } from "./region.js";

/**
 * One traversable link of the portal navigation graph (graph 3 of the Wave 1 spatial model),
 * kept apart from the anchor graph's own edges: an open portal joining anchor `from` to anchor
 * `to` (`from` sorts first; it is walkable both ways). Its cost is the floor of the straight-line
 * distance, so the router's straight-line heuristic stays admissible.
 */
export interface PortalEdge {
  readonly portalId: string;
  readonly from: string;
  readonly to: string;
  readonly cost: bigint;
}

function isActive(entity: WorldEntity): boolean {
  return entity.lifecycle === undefined || entity.lifecycle.status === "active";
}

function sameCoordinates(left: readonly bigint[], right: readonly bigint[]): boolean {
  return left.length === right.length && left.every((value, axis) => value === right[axis]);
}

/**
 * The anchors of `graph` an endpoint stands for, in ascending id order: the named anchor, or
 * every anchor of the graph inside the named region (same frame and dimensions).
 */
export function endpointAnchors(
  regions: readonly SpatialRegion[],
  graph: AnchorGraph,
  endpoint: PortalEndpoint,
): readonly Anchor[] {
  if (endpoint.kind === "anchor")
    return graph.anchors.filter((anchor) => anchor.anchorId === endpoint.anchorId);
  const region = regions.find((candidate) => candidate.regionId === endpoint.regionId);
  if (
    region === undefined ||
    region.frameId !== graph.frameId ||
    region.frameVersion !== graph.frameVersion
  )
    return [];
  return graph.anchors.filter(
    (anchor) =>
      shapeDimensions(region.shape) === anchor.coordinates.length &&
      regionContains(region, anchor.coordinates),
  );
}

/**
 * The open portals of active objects over one anchor graph, sorted by portal id, then `from`,
 * then `to`. A closed portal, a retired or dead portal object and a pair of anchors at the same
 * coordinates contribute nothing, so every portal hop is a leg of its own.
 */
export function portalEdges(
  state: Pick<WorldState, "entities" | "spatialRegions">,
  graph: AnchorGraph,
): readonly PortalEdge[] {
  const regions = state.spatialRegions ?? [];
  const edges: PortalEdge[] = [];
  const seen = new Set<string>();
  for (const entity of state.entities) {
    const portal = entity.portal;
    if (portal === undefined || portal.status !== "open" || !isActive(entity)) continue;
    const near = endpointAnchors(regions, graph, portal.endpoints[0]);
    const far = endpointAnchors(regions, graph, portal.endpoints[1]);
    for (const left of near)
      for (const right of far) {
        if (sameCoordinates(left.coordinates, right.coordinates)) continue;
        const [from, to] =
          compareText(left.anchorId, right.anchorId) < 0 ? [left, right] : [right, left];
        const key = `${entity.objectId}\u0000${from.anchorId}\u0000${to.anchorId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          portalId: entity.objectId,
          from: from.anchorId,
          to: to.anchorId,
          cost: distanceFloor(from.coordinates, to.coordinates),
        });
      }
  }
  return edges.sort(
    (left, right) =>
      compareText(left.portalId, right.portalId) ||
      compareText(left.from, right.from) ||
      compareText(left.to, right.to),
  );
}

/**
 * The sides portals separate in one anchor graph. `side` names an anchor's component of the
 * anchor-edge graph (its smallest anchor id); a side is `guarded` when some portal, open or
 * closed and whatever its object's lifecycle, joins it to another side, so the portal graph is
 * the only way between them. `attach` is the anchor a point stands for: the anchor at its
 * coordinates; else, inside regions that are portal endpoints, the nearest of their anchors;
 * else the nearest anchor outside those regions (ties by ascending id). A point inside a portal's
 * region so stands for that region's anchors, and a point outside it for the ground around it.
 */
export interface PortalSides {
  readonly side: (anchorId: string) => string;
  readonly guarded: ReadonlySet<string>;
  readonly attach: (point: readonly bigint[]) => Anchor;
}

/** The sides portals separate in `graph`, or undefined when no portal separates any. */
export function portalSides(
  state: Pick<WorldState, "entities" | "spatialRegions">,
  graph: AnchorGraph,
): PortalSides | undefined {
  const regions = state.spatialRegions ?? [];
  const root = new Map(graph.anchors.map((anchor) => [anchor.anchorId, anchor.anchorId]));
  const side = (anchorId: string): string => {
    let id = anchorId;
    while (root.get(id) !== id) id = root.get(id)!;
    return id;
  };
  for (const edge of graph.edges) {
    const [left, right] = [side(edge.from), side(edge.to)];
    const order = compareText(left, right);
    if (order < 0) root.set(right, left);
    else if (order > 0) root.set(left, right);
  }
  const guarded = new Set<string>();
  const portalRegions = new Map<string, readonly Anchor[]>();
  for (const entity of state.entities) {
    if (entity.portal === undefined) continue;
    const sides = new Set<string>();
    for (const endpoint of entity.portal.endpoints) {
      const anchors = endpointAnchors(regions, graph, endpoint);
      if (endpoint.kind === "region" && anchors.length > 0)
        portalRegions.set(endpoint.regionId, anchors);
      for (const anchor of anchors) sides.add(side(anchor.anchorId));
    }
    if (sides.size > 1) for (const id of sides) guarded.add(id);
  }
  if (guarded.size === 0) return undefined;
  const nearest = (point: readonly bigint[], anchors: readonly Anchor[]): Anchor | undefined => {
    let best: Anchor | undefined;
    let distance = 0n;
    for (const anchor of anchors) {
      const candidate = distanceFloor(anchor.coordinates, point);
      if (
        best === undefined ||
        candidate < distance ||
        (candidate === distance && compareText(anchor.anchorId, best.anchorId) < 0)
      ) {
        best = anchor;
        distance = candidate;
      }
    }
    return best;
  };
  const enclosed = new Set([...portalRegions.values()].flat().map((anchor) => anchor.anchorId));
  const open = graph.anchors.filter((anchor) => !enclosed.has(anchor.anchorId));
  const attach = (point: readonly bigint[]): Anchor => {
    const exact = graph.anchors.find((anchor) => sameCoordinates(anchor.coordinates, point));
    if (exact !== undefined) return exact;
    const inside = regions
      .filter(
        (region) =>
          portalRegions.has(region.regionId) &&
          shapeDimensions(region.shape) === point.length &&
          regionContains(region, point),
      )
      .flatMap((region) => portalRegions.get(region.regionId)!);
    return nearest(point, inside) ?? nearest(point, open) ?? nearest(point, graph.anchors)!;
  };
  return { side, guarded, attach };
}

/**
 * Validates every Portal component against its partition. Each failure is a `CompositionError`
 * with a stable code and path under `state.entities[i].portal`: `cross-world`,
 * `cross-partition` and `self-link` (from `portalScopeIssues`) and `unknown-endpoint` at
 * `.endpoints[j].anchorId` or `.endpoints[j].regionId`.
 */
export function validatePortals(state: WorldState): void {
  for (const [index, entity] of state.entities.entries()) {
    if (entity.portal === undefined) continue;
    const path = `state.entities[${index}].portal`;
    const portal = portalSchema.parse(entity.portal);
    const issues: DomainIssue[] = portalScopeIssues(portal, state, path);
    portal.endpoints.forEach((endpoint, at) => {
      const known =
        endpoint.kind === "anchor"
          ? findAnchor(state.anchorGraphs ?? [], endpoint.anchorId) !== undefined
          : (state.spatialRegions ?? []).some((region) => region.regionId === endpoint.regionId);
      if (!known)
        issues.push({
          code: "unknown-endpoint",
          path: `${path}.endpoints[${at}].${endpoint.kind === "anchor" ? "anchorId" : "regionId"}`,
          message: "does not reference a declared anchor or region of the partition",
        });
    });
    const first = issues.sort(
      (left, right) => compareText(left.path, right.path) || compareText(left.code, right.code),
    )[0];
    if (first !== undefined) throw new CompositionError(first.code, first.path, first.message);
  }
}

/** The open portal edge joining two anchors through `portalId`, or undefined. */
function openEdge(
  state: WorldState,
  graph: AnchorGraph,
  portalId: string,
  first: string,
  second: string,
): PortalEdge | undefined {
  const [from, to] = compareText(first, second) < 0 ? [first, second] : [second, first];
  return portalEdges(state, graph).find(
    (edge) => edge.portalId === portalId && edge.from === from && edge.to === to,
  );
}

/**
 * Checks a new movement record's portal steps against the state it starts in: each step is a
 * consecutive pair of its anchor path, in route order, joined by a portal that is open now, and
 * its waypoint leads from the step's first anchor to its second. Throws DomainValidationError.
 */
export function validatePortalSteps(state: WorldState, record: MovementRecord, path: string): void {
  const steps = record.portalSteps ?? [];
  if (steps.length === 0) return;
  const graph = (state.anchorGraphs ?? []).find((candidate) =>
    candidate.anchors.some((anchor) => anchor.anchorId === record.anchorPath[0]),
  );
  if (graph === undefined || record.anchorPath.length < 2)
    fail(`${path}.portalSteps`, "only an anchor route takes portals");
  const coordinates = new Map(graph.anchors.map((anchor) => [anchor.anchorId, anchor.coordinates]));
  const waypoints = record.segment.waypoints;
  let hop = 1;
  for (const [index, step] of steps.entries()) {
    const at = `${path}.portalSteps[${index}]`;
    while (
      hop < record.anchorPath.length &&
      !(record.anchorPath[hop - 1] === step.from && record.anchorPath[hop] === step.to)
    )
      hop += 1;
    if (hop >= record.anchorPath.length) fail(at, "must be a hop of the anchor path");
    hop += 1;
    if (openEdge(state, graph, step.portalId, step.from, step.to) === undefined)
      fail(`${at}.portalId`, "does not reference an open portal joining the step's anchors");
    const from = coordinates.get(step.from)!;
    const to = coordinates.get(step.to)!;
    if (
      !sameCoordinates(waypoints[step.waypoint - 1]!, from) ||
      !sameCoordinates(waypoints[step.waypoint]!, to)
    )
      fail(`${at}.waypoint`, "must be the waypoint the portal leads to");
  }
}

/** Applies `portal.opened` or `portal.closed`; returns the updated entities. */
export function reducePortalEvent(
  state: WorldState,
  event: PortalEventData,
): readonly WorldEntity[] {
  const entity = state.entities.find((candidate) => candidate.objectId === event.payload.portalId);
  if (entity?.portal === undefined)
    fail("event.portalId", "does not reference an object with a Portal component");
  if (!isActive(entity)) fail("event.portalId", "the portal object is not active");
  const status = event.type === "portal.opened" ? "open" : "closed";
  if (entity.portal.status === status) fail("event.portalId", `the portal is already ${status}`);
  if (status === "closed" && portalInTransit(state, entity.objectId) !== undefined)
    fail("event.portalId", "an active movement still has to cross the portal");
  return state.entities.map((candidate) =>
    candidate === entity ? { ...entity, portal: { ...entity.portal!, status } } : candidate,
  );
}

/** The portal steps of an active movement that it has not crossed yet. */
export function pendingPortalSteps(movement: MovementRecord): readonly PortalStep[] {
  const steps = movement.portalSteps ?? [];
  if (movement.status !== "active" || steps.length === 0) return [];
  const crossed = movement.emitted.filter((crossing) => crossing.kind === "portal").length;
  return steps.slice(crossed);
}

/** The index of the first entity whose active movement still has to cross `portalId`, if any. */
export function portalInTransit(state: WorldState, portalId: string): number | undefined {
  const index = state.entities.findIndex(
    (entity) =>
      entity.movement !== undefined &&
      pendingPortalSteps(entity.movement).some((step) => step.portalId === portalId),
  );
  return index < 0 ? undefined : index;
}

/** Whether `portalId` names an active object whose Portal is open in `state`. */
export function portalIsOpen(state: WorldState, portalId: string): boolean {
  const entity = state.entities.find((candidate) => candidate.objectId === portalId);
  return entity?.portal?.status === "open" && isActive(entity);
}
