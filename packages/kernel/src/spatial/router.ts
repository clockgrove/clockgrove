import { type AnchorGraph, distanceFloor, type PortalEdge } from "@clockgrove/domain";

export interface AnchorRoute {
  /** Anchor ids from start to goal, inclusive. */
  readonly anchors: readonly string[];
  /** Per hop (`anchors[i]` to `anchors[i + 1]`), the portal taken, or null for an anchor edge. */
  readonly via: readonly (string | null)[];
  /** Sum of the fixed-point edge costs. */
  readonly cost: bigint;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Link {
  readonly id: string;
  readonly cost: bigint;
  readonly portalId: string | null;
}

/** Anchor edges before portals, then portals by ascending id. */
function compareLinks(left: Link, right: Link): number {
  if (left.portalId === right.portalId) return 0;
  if (left.portalId === null) return -1;
  if (right.portalId === null) return 1;
  return compareText(left.portalId, right.portalId);
}

/**
 * A* over the anchor graph joined with the open-portal graph (`portals`, from `portalEdges`),
 * with exact fixed-point (bigint) costs. The search runs from the goal with the admissible
 * straight-line heuristic toward the start, expanding every anchor whose estimate does not exceed
 * the optimum, which yields exact goal distances for every anchor on any optimal route. The route
 * is then walked forward from the start, choosing at each step, among the links that stay optimal,
 * the neighbor with the smallest anchor id, then an anchor edge over a portal, then the smallest
 * portal id, so ties between equal-cost routes always resolve canonically. A closed portal is not
 * in `portals` and is never traversed. Returns undefined when unreachable.
 */
export function routeAnchors(
  graph: AnchorGraph,
  startId: string,
  goalId: string,
  portals: readonly PortalEdge[] = [],
): AnchorRoute | undefined {
  const coordinates = new Map(graph.anchors.map((anchor) => [anchor.anchorId, anchor.coordinates]));
  const start = coordinates.get(startId);
  const goal = coordinates.get(goalId);
  if (start === undefined || goal === undefined) return undefined;
  const neighbors = new Map<string, Link[]>();
  for (const anchor of graph.anchors) neighbors.set(anchor.anchorId, []);
  for (const edge of graph.edges) {
    neighbors.get(edge.from)!.push({ id: edge.to, cost: edge.cost, portalId: null });
    neighbors.get(edge.to)!.push({ id: edge.from, cost: edge.cost, portalId: null });
  }
  for (const portal of portals) {
    if (!coordinates.has(portal.from) || !coordinates.has(portal.to)) continue;
    neighbors
      .get(portal.from)!
      .push({ id: portal.to, cost: portal.cost, portalId: portal.portalId });
    neighbors
      .get(portal.to)!
      .push({ id: portal.from, cost: portal.cost, portalId: portal.portalId });
  }
  const heuristic = (id: string) => distanceFloor(coordinates.get(id)!, start);
  const distance = new Map<string, bigint>([[goalId, 0n]]);
  const open = new Set<string>([goalId]);
  const estimate = (id: string) => distance.get(id)! + heuristic(id);
  while (open.size > 0) {
    let best: string | undefined;
    for (const id of open) {
      if (
        best === undefined ||
        estimate(id) < estimate(best) ||
        (estimate(id) === estimate(best) && compareText(id, best) < 0)
      )
        best = id;
    }
    const current = best!;
    const known = distance.get(startId);
    if (known !== undefined && estimate(current) > known) break;
    open.delete(current);
    const here = distance.get(current)!;
    for (const next of neighbors.get(current)!) {
      const candidate = here + next.cost;
      const previous = distance.get(next.id);
      if (previous === undefined || candidate < previous) {
        distance.set(next.id, candidate);
        open.add(next.id);
      }
    }
  }
  const total = distance.get(startId);
  if (total === undefined) return undefined;
  const anchors = [startId];
  const via: (string | null)[] = [];
  let current = startId;
  while (current !== goalId) {
    const remaining = distance.get(current)!;
    const next = [...neighbors.get(current)!]
      .filter((candidate) => {
        const onward = distance.get(candidate.id);
        return onward !== undefined && candidate.cost + onward === remaining;
      })
      .sort((left, right) => compareText(left.id, right.id) || compareLinks(left, right))[0];
    if (next === undefined) return undefined;
    anchors.push(next.id);
    via.push(next.portalId);
    current = next.id;
  }
  return Object.freeze({ anchors: Object.freeze(anchors), via: Object.freeze(via), cost: total });
}
