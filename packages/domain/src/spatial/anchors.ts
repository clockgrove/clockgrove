import type { SpatialFrameId } from "@clockgrove/contracts";

import type { FixedPoint } from "../spatial.js";
import {
  compareText,
  exactRecord,
  fail,
  fixed,
  integerSqrt,
  list,
  point,
  positiveFixed,
  text,
  version,
} from "./parse.js";

export interface Anchor {
  readonly anchorId: string;
  readonly coordinates: readonly FixedPoint[];
}

/** An undirected edge; `from` sorts before `to` in canonical form. */
export interface AnchorEdge {
  readonly from: string;
  readonly to: string;
  readonly cost: FixedPoint;
}

export interface AnchorGraph {
  readonly graphId: string;
  readonly version: number;
  readonly frameId: SpatialFrameId;
  readonly frameVersion: number;
  readonly anchors: readonly Anchor[];
  readonly edges: readonly AnchorEdge[];
}

export const MAX_ANCHORS = 128;
export const MAX_EDGES = 512;

/** Floor of the Euclidean distance between two fixed-point points. */
export function distanceFloor(left: readonly bigint[], right: readonly bigint[]): bigint {
  let total = 0n;
  for (let axis = 0; axis < left.length; axis += 1) {
    const delta = left[axis]! - right[axis]!;
    total += delta * delta;
  }
  return integerSqrt(total);
}

/**
 * Validates untrusted input and returns the canonical graph: anchors sorted by id, edges
 * normalized to from < to and sorted. Edge costs are positive and at least the straight-line
 * distance, which keeps the straight-line A* heuristic admissible.
 */
export function parseAnchorGraph(value: unknown, path = "anchorGraph"): AnchorGraph {
  const record = exactRecord(value, path, [
    "graphId",
    "version",
    "frameId",
    "frameVersion",
    "anchors",
    "edges",
  ]);
  const anchors = list(record.anchors, `${path}.anchors`, 1, MAX_ANCHORS).map((item, index) => {
    const at = `${path}.anchors[${index}]`;
    const body = exactRecord(item, at, ["anchorId", "coordinates"]);
    const coordinates = Array.isArray(body.coordinates) ? body.coordinates : [];
    return {
      anchorId: text(body.anchorId, `${at}.anchorId`),
      coordinates: point(body.coordinates, `${at}.coordinates`, coordinates.length === 3 ? 3 : 2),
    };
  });
  anchors.sort((left, right) => compareText(left.anchorId, right.anchorId));
  const byId = new Map<string, Anchor>();
  for (const [index, anchor] of anchors.entries()) {
    if (byId.has(anchor.anchorId)) fail(`${path}.anchors[${index}].anchorId`, "must be unique");
    if (anchor.coordinates.length !== anchors[0]!.coordinates.length)
      fail(`${path}.anchors[${index}].coordinates`, "must share one dimension count");
    byId.set(anchor.anchorId, anchor);
  }
  const seen = new Set<string>();
  const edges = list(record.edges, `${path}.edges`, 0, MAX_EDGES).map((item, index) => {
    const at = `${path}.edges[${index}]`;
    const body = exactRecord(item, at, ["from", "to", "cost"]);
    const first = text(body.from, `${at}.from`);
    const second = text(body.to, `${at}.to`);
    const cost = positiveFixed(body.cost, `${at}.cost`);
    const from = byId.get(first);
    const to = byId.get(second);
    if (from === undefined) fail(`${at}.from`, "does not reference a declared anchor");
    if (to === undefined) fail(`${at}.to`, "does not reference a declared anchor");
    if (first === second) fail(at, "an edge must connect two distinct anchors");
    if (cost < distanceFloor(from.coordinates, to.coordinates))
      fail(`${at}.cost`, "must be at least the straight-line distance");
    const [low, high] = compareText(first, second) < 0 ? [first, second] : [second, first];
    const key = `${low}\u0000${high}`;
    if (seen.has(key)) fail(at, "duplicate edge");
    seen.add(key);
    return { from: low, to: high, cost: fixed(cost, `${at}.cost`) };
  });
  edges.sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
  return Object.freeze({
    graphId: text(record.graphId, `${path}.graphId`),
    version: version(record.version, `${path}.version`),
    frameId: text(record.frameId, `${path}.frameId`) as SpatialFrameId,
    frameVersion: version(record.frameVersion, `${path}.frameVersion`),
    anchors: Object.freeze(anchors.map((anchor) => Object.freeze(anchor))),
    edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
  });
}

export function findAnchor(
  graphs: readonly AnchorGraph[],
  anchorId: string,
): { readonly graph: AnchorGraph; readonly anchor: Anchor } | undefined {
  for (const graph of graphs) {
    const anchor = graph.anchors.find((candidate) => candidate.anchorId === anchorId);
    if (anchor !== undefined) return { graph, anchor };
  }
  return undefined;
}
