import { parseAnchorGraph, parseSpatialRegion } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { createQuadtreeSpatialIndex, routeAnchors } from "../src/index.js";
import { anchorGraph, createLinearTestIndex, regions } from "./spatial.scenario.js";

const pose = (x: bigint, y: bigint) => ({
  frameId: "ground-frame" as never,
  frameVersion: 1,
  coordinates: [x, y] as never,
});

describe("anchor routing", () => {
  const graph = parseAnchorGraph(anchorGraph());
  it("finds the cheapest route with ascending-id tie breaks", () => {
    const route = routeAnchors(graph, "den-mouth", "trash-front");
    expect(route?.anchors).toEqual(["den-mouth", "porch-step", "trash-front"]);
    expect(route?.cost).toBe(8000n);
    expect(routeAnchors(graph, "den-mouth", "den-mouth")?.anchors).toEqual(["den-mouth"]);
    expect(routeAnchors(graph, "den-mouth", "garden-edge")?.anchors).toEqual([
      "den-mouth",
      "porch-step",
      "fence-gap",
      "garden-edge",
    ]);
  });
  it("breaks equal-cost ties by ascending anchor id", () => {
    const tie = parseAnchorGraph({
      graphId: "t",
      version: 1,
      frameId: "ground-frame",
      frameVersion: 1,
      anchors: [
        ["a", 0n, 0n],
        ["b", 1000n, 0n],
        ["c", 0n, 1000n],
        ["d", 1000n, 1000n],
      ].map(([id, x, y]) => ({ anchorId: id, coordinates: [x, y] })),
      edges: [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
      ].map(([from, to]) => ({ from, to, cost: 1000n })),
    });
    expect(routeAnchors(tie, "a", "d")?.anchors).toEqual(["a", "b", "d"]);
  });
});

describe("spatial index port", () => {
  const bind = (objectId: string, x: bigint, y: bigint) => ({
    op: "insert" as const,
    binding: { objectId: objectId as never, pose: pose(x, y) as never },
  });
  const garden = parseSpatialRegion(regions()[0]);
  it("matches the alternate implementation for updates and inclusive queries", () => {
    const [a, b] = [createQuadtreeSpatialIndex(3), createLinearTestIndex(3)];
    const points: [string, bigint, bigint][] = [
      ["in", 7000n, 6000n],
      ["edge", 6000n, 5000n],
      ["corner", 10000n, 8000n],
      ["out", 5999n, 6000n],
      ["far", -(1n << 40n), 1n << 40n],
    ];
    for (const [id, x, y] of points)
      expect(a.update(3, bind(id, x, y))).toEqual(b.update(3, bind(id, x, y)));
    expect(a.update(3, bind("in", 7000n, 6000n))).toEqual([]);
    expect(a.query(3, garden)).toEqual(["corner", "edge", "in"]);
    expect(b.query(3, garden)).toEqual(a.query(3, garden));
    expect(a.update(3, { op: "remove", binding: bind("in", 0n, 0n).binding })).toEqual(["in"]);
    expect(b.update(3, { op: "remove", binding: bind("in", 0n, 0n).binding })).toEqual(["in"]);
    expect(a.update(3, { op: "remove", binding: bind("in", 0n, 0n).binding })).toEqual([]);
    expect(a.query(3, garden)).toEqual(b.query(3, garden));
  });
});
