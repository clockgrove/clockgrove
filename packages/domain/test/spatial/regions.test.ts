import type { ActorProcessId, OpaqueId, RunId, SimTimeMs, SubjectId } from "@clockgrove/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ACTOR_PROCESS_MODES,
  ACTOR_PROCESS_STATUSES,
  type ActorProcess,
  type ActorProcessSegment,
  DomainValidationError,
  parseAnchorGraph,
  parseSpatialRegion,
  regionContains,
  semanticHierarchyIssues,
  validateActorProcess,
  validateActorProcessSegment,
} from "../../src/index.js";

// Integer geometry that decides placement and region crossings. Goldens rarely land on a boundary, so
// this keeps the boundary-inclusive containment and the polygon and anchor-graph validity rules.

const frame = { frameId: "ground", frameVersion: 1 };
const region = (shape: unknown) =>
  parseSpatialRegion({ regionId: "r", version: 1, ...frame, shape });
const at = (...c: bigint[]) => c as never;

describe("spatial regions", () => {
  it("include their boundary exactly", () => {
    const circle = region({ kind: "circle", center: [0n, 0n], radius: 5000n });
    expect(regionContains(circle, at(3000n, 4000n))).toBe(true);
    expect(regionContains(circle, at(3000n, 4001n))).toBe(false);
    const polygon = region({
      kind: "polygon",
      vertices: [
        [0n, 0n],
        [4000n, 0n],
        [4000n, 4000n],
        [0n, 4000n],
      ],
    });
    expect(regionContains(polygon, at(4000n, 2000n))).toBe(true);
    expect(regionContains(polygon, at(-1n, 2000n))).toBe(false);
    const box = region({ kind: "box", min: [0n, 0n, 0n], max: [1000n, 1000n, 1000n] });
    expect(regionContains(box, at(1000n, 1000n, 1000n))).toBe(true);
    expect(regionContains(box, at(1000n, 1000n, 1001n))).toBe(false);
  });

  it("refuse clockwise and self-intersecting polygons and anchor edges cheaper than the straight line", () => {
    expect(() =>
      region({
        kind: "polygon",
        vertices: [
          [0n, 0n],
          [0n, 4000n],
          [4000n, 4000n],
          [4000n, 0n],
        ],
      }),
    ).toThrow();
    expect(() =>
      region({
        kind: "polygon",
        vertices: [
          [0n, 0n],
          [4000n, 4000n],
          [4000n, 0n],
          [0n, 4000n],
        ],
      }),
    ).toThrow();
    const graph = (cost: bigint) =>
      parseAnchorGraph({
        graphId: "g",
        version: 1,
        ...frame,
        anchors: [
          { anchorId: "a", coordinates: [0n, 0n] },
          { anchorId: "b", coordinates: [3000n, 4000n] },
        ],
        edges: [{ from: "b", to: "a", cost }],
      });
    expect(() => graph(4999n)).toThrow();
    expect(graph(5000n).edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("refuse semantic parents that are unknown, cyclic or in another world or timeline", () => {
    const place = (regionId: string, parent?: Record<string, unknown>) =>
      parseSpatialRegion({
        regionId,
        version: 1,
        ...frame,
        shape: { kind: "rectangle", min: [0n, 0n], max: [10n, 10n] },
        ...(parent === undefined ? {} : { parent }),
      });
    const issues = semanticHierarchyIssues(
      [
        place("a", { regionId: "b", version: 1 }),
        place("b", { regionId: "a", version: 1, worldId: "world-2", timelineId: "timeline-2" }),
        place("c", { regionId: "nowhere", version: 1 }),
        place("d", { regionId: "c", version: 2 }),
        place("e", { regionId: "c", version: 1 }),
      ],
      { worldId: "world-1", timelineId: "timeline-1" },
      "state.spatialRegions",
    ).map((issue) => [issue.code, issue.path]);
    expect(issues).toEqual([
      ["parent-cycle", "state.spatialRegions[0].parent"],
      ["parent-cycle", "state.spatialRegions[1].parent"],
      ["cross-timeline", "state.spatialRegions[1].parent.timelineId"],
      ["cross-world", "state.spatialRegions[1].parent.worldId"],
      ["unknown-parent", "state.spatialRegions[2].parent.regionId"],
      ["unknown-parent", "state.spatialRegions[3].parent.version"],
    ]);
    // Region indexes order as numbers, so the SDK names regions[2], the first region on the cycle.
    const many = Array.from({ length: 11 }, (_, index) => place(`r${index}`));
    many[2] = place("r2", { regionId: "r10", version: 1 });
    many[10] = place("r10", { regionId: "r2", version: 1 });
    expect(semanticHierarchyIssues(many, undefined, "regions").map((issue) => issue.path)).toEqual([
      "regions[2].parent",
      "regions[10].parent",
    ]);
  });
});

// The other Wave 0 §8 extension-pressure fixture: a durable ActorProcess holds reactive, scheduled and
// continuously eligible responsibilities as state alone, with no resident-worker or provider-session
// field. packages/domain is not a unit-test area, so it shares the spatial fixture's file.

const durable = (
  mode: ActorProcess["mode"],
  status: ActorProcess["status"],
  leaseEpoch: bigint,
): ActorProcess => ({
  processId: `process-${mode}` as ActorProcessId,
  subject: { subjectId: "subject" as SubjectId },
  mode,
  status,
  objectiveRef: "objective" as OpaqueId<"ObjectiveRef">,
  subscriptionCursorRefs: [],
  leaseEpoch,
  budgetPolicyRef: "budget-policy" as OpaqueId<"BudgetPolicyRef">,
});
const segment = (
  owner: ActorProcess,
  [startedAt, endedAt]: [bigint, bigint],
  [budgetLimit, budgetConsumed]: [bigint, bigint],
): ActorProcessSegment => ({
  processId: owner.processId,
  runSegmentId: "run-segment" as RunId,
  leaseEpoch: owner.leaseEpoch,
  startedAt: startedAt as SimTimeMs,
  endedAt: endedAt as SimTimeMs,
  budgetLimit,
  budgetConsumed,
});
function refuses(action: () => void, path: string, message: string) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DomainValidationError);
  expect({
    path: (error as DomainValidationError).path,
    message: (error as Error).message,
  }).toEqual({ path, message });
}

describe("durable actor process", () => {
  it("accepts every responsibility with a bounded segment and refuses each forbidden state", () => {
    // Compile time (pnpm check): the interface's literal unions equal the exported constants both ways.
    expectTypeOf<ActorProcess["mode"]>().toEqualTypeOf<(typeof ACTOR_PROCESS_MODES)[number]>();
    expectTypeOf<ActorProcess["status"]>().toEqualTypeOf<(typeof ACTOR_PROCESS_STATUSES)[number]>();

    // Boundaries: lease epoch 0, an instantaneous segment, a fully consumed budget.
    const reactive = durable("reactive", "waiting", 0n);
    const scheduled = durable("scheduled", "paused", 3n);
    const eligible = durable("continuously_eligible", "running", 7n);
    expect(() => validateActorProcess(reactive)).not.toThrow();
    expect(() =>
      validateActorProcessSegment(reactive, segment(reactive, [10n, 10n], [0n, 0n])),
    ).not.toThrow();
    expect(() =>
      validateActorProcessSegment(scheduled, segment(scheduled, [10n, 250n], [20n, 20n])),
    ).not.toThrow();
    const bounded = segment(eligible, [10n, 260n], [20n, 7n]);
    expect(() => validateActorProcessSegment(eligible, bounded)).not.toThrow();

    refuses(
      // @ts-expect-error an unknown mode does not type-check; the runtime check still refuses it.
      () => validateActorProcess({ ...eligible, mode: "resident" }),
      "actorProcess.mode",
      "actorProcess.mode: unsupported mode",
    );
    refuses(
      // @ts-expect-error an unknown status does not type-check; the runtime check still refuses it.
      () => validateActorProcess({ ...eligible, status: "sleeping" }),
      "actorProcess.status",
      "actorProcess.status: unsupported status",
    );
    refuses(
      () => validateActorProcess({ ...eligible, leaseEpoch: -1n }),
      "actorProcess.leaseEpoch",
      "actorProcess.leaseEpoch: must not be negative",
    );
    refuses(
      () =>
        validateActorProcessSegment(eligible, { ...bounded, processId: "other" as ActorProcessId }),
      "segment.processId",
      "segment.processId: does not match durable process",
    );
    refuses(
      () => validateActorProcessSegment(eligible, { ...bounded, leaseEpoch: 6n }),
      "segment.leaseEpoch",
      "segment.leaseEpoch: does not match durable process lease",
    );
    refuses(
      () => validateActorProcessSegment(eligible, segment(eligible, [260n, 259n], [20n, 7n])),
      "segment.endedAt",
      "segment.endedAt: must not precede segment start",
    );
    refuses(
      () => validateActorProcessSegment(eligible, segment(eligible, [10n, 260n], [-1n, 0n])),
      "segment.budget",
      "segment.budget: must not be negative",
    );
    refuses(
      () => validateActorProcessSegment(eligible, segment(eligible, [10n, 260n], [20n, -1n])),
      "segment.budget",
      "segment.budget: must not be negative",
    );
    refuses(
      () => validateActorProcessSegment(eligible, segment(eligible, [10n, 260n], [20n, 21n])),
      "segment.budgetConsumed",
      "segment.budgetConsumed: exceeds the bounded segment budget",
    );
  });
});
