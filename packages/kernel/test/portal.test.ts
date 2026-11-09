import {
  CompositionError,
  createWorldState,
  fixedPoint,
  parseAnchorGraph,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { routeAnchors } from "../src/index.js";
import { checkWorldInvariants, executeWorldKernel, type WorldKernelInput } from "../src/world.js";
import {
  anchorGraph,
  movementInput,
  mover,
  spatialFixture,
  startPayload,
  toAnchor,
  toPose,
} from "./spatial.scenario.js";

/** A gate joining `den-mouth` to the `garden` region (which holds `garden-edge`). */
function gate(extra: Record<string, unknown> = {}, status = "open"): WorldEntity {
  return mover("gate", [4000n, 6000n], {
    portal: {
      status,
      endpoints: [
        { kind: "anchor", anchorId: "den-mouth" },
        { kind: "region", regionId: "garden", ...extra },
      ],
    },
  } as never);
}

function withState(base: WorldKernelInput, state: WorldState): WorldKernelInput {
  return {
    ...base,
    partition: { ...base.partition, state, revision: state.revision },
    simulationTime: state.simulationTime,
  };
}

function run(base: WorldKernelInput, type: string, payload: unknown, id: string) {
  const outcome = executeWorldKernel(movementInput(base, type, payload, id), { mode: "test" });
  if (!outcome.ok) return { refusal: outcome.error, events: [], state: base.partition.state };
  const t0 = base.partition.state.simulationTime;
  return {
    refusal: undefined,
    state: outcome.result.state,
    events: outcome.result.events.map((event) => [
      event.type,
      event.simulationTime - t0,
      (event.payload as { portalId?: string; regionId?: string }).portalId ??
        (event.payload as { regionId?: string }).regionId ??
        null,
    ]),
  };
}

const THROUGH_GATE = [
  ["movement.started", 0n, null],
  ["movement.portal-crossed", 1n, "gate"],
  ["movement.region-entered", 4167n, "garden"],
  ["movement.region-exited", 5000n, "garden"],
  ["movement.completed", 5000n, null],
];

/** The fixture without anchor edges, so the gate alone joins `den-mouth` and `garden-edge`. */
async function separated(status: string, at: readonly [bigint, bigint]) {
  const base = await spatialFixture([gate({}, status), mover("mover", at)]);
  const graph = parseAnchorGraph({ ...anchorGraph(), edges: [] });
  return withState(
    base,
    createWorldState({ ...base.partition.state, anchorGraphs: [graph] } as never),
  );
}

const UNREACHABLE = {
  code: "precondition-failed",
  path: "payload.destination",
  check: "movement.route@1",
};

describe("portal navigation (graph 3)", () => {
  it("routes through an open portal, crossing it on leaving the near anchor, and reroutes once it is closed", async () => {
    const base = await spatialFixture([gate(), mover("mover", [0n, 0n])]);
    const open = run(base, "movement.start", startPayload("mover", toAnchor("garden-edge")), "m1");
    expect(open.events).toEqual(THROUGH_GATE);
    const started = open.state.entities.find((entity) => entity.objectId === "mover")!.movement!;
    expect(started.portalSteps).toEqual([
      { portalId: "gate", from: "den-mouth", to: "garden-edge", waypoint: 1 },
    ]);

    const closed = run(base, "portal.close", { schemaVersion: 1, portalId: "gate" }, "c1");
    expect(closed.events).toEqual([["portal.closed", 0n, "gate"]]);
    const rerouted = run(
      withState(base, closed.state),
      "movement.start",
      startPayload("mover", toAnchor("garden-edge")),
      "m2",
    );
    const record = rerouted.state.entities.find((entity) => entity.objectId === "mover")!.movement!;
    expect(record.anchorPath).toEqual(["den-mouth", "porch-step", "fence-gap", "garden-edge"]);
    expect(record.portalSteps).toBeUndefined();
    expect(rerouted.events.some(([type]) => type === "movement.portal-crossed")).toBe(false);
  });

  it("keeps the crossing of a mover interrupted on the hop, so the portal may close behind it", async () => {
    const base = await spatialFixture([gate(), mover("mover", [0n, 0n])]);
    const t0 = base.simulationTime;
    const start = startPayload("mover", toAnchor("garden-edge"), { observeUntil: t0 });
    const moving = run(base, "movement.start", start, "m1");
    const stop = { schemaVersion: 1, objectId: "mover", at: t0 + 4500n };
    const stopped = run(withState(base, moving.state), "movement.interrupt", stop, "i1");
    expect(stopped.events).toEqual([
      ["movement.portal-crossed", 1n, "gate"],
      ["movement.region-entered", 4167n, "garden"],
      ["movement.interrupted", 4500n, null],
    ]);
    const close = { schemaVersion: 1, portalId: "gate" };
    expect(
      run(withState(base, stopped.state), "portal.close", close, "c1").refusal,
    ).toBeUndefined();
  });

  it("routes a start off the anchor graph through a portal that separates it, or refuses", async () => {
    const open = await separated("open", [100n, 0n]);
    const through = run(
      open,
      "movement.start",
      startPayload("mover", toAnchor("garden-edge")),
      "m1",
    );
    expect(through.events).toEqual([
      ["movement.started", 0n, null],
      ["movement.portal-crossed", 51n, "gate"],
      ["movement.region-entered", 4217n, "garden"],
      ["movement.region-exited", 5050n, "garden"],
      ["movement.completed", 5050n, null],
    ]);
    const record = through.state.entities.find((entity) => entity.objectId === "mover")!.movement!;
    expect(record.anchorPath).toEqual(["den-mouth", "garden-edge"]);
    expect(record.portalSteps).toEqual([
      { portalId: "gate", from: "den-mouth", to: "garden-edge", waypoint: 2 },
    ]);
    const closed = await separated("closed", [100n, 0n]);
    const toGarden = startPayload("mover", toAnchor("garden-edge"));
    expect(run(closed, "movement.start", toGarden, "m2").refusal).toEqual(UNREACHABLE);
    const intoGarden = startPayload("mover", toPose(7000n, 6000n));
    expect(run(closed, "movement.start", intoGarden, "m3").refusal).toEqual(UNREACHABLE);
    const onAnchor = await separated("closed", [0n, 0n]);
    expect(run(onAnchor, "movement.start", intoGarden, "m4").refusal).toEqual(UNREACHABLE);
  });

  it("passes an actor through with portal.use and refuses with stable codes", async () => {
    const base = await spatialFixture([gate(), mover("mover", [0n, 0n])]);
    const use = {
      schemaVersion: 1,
      objectId: "mover",
      portalId: "gate",
      unitsPerSecond: fixedPoint(2000n),
    };
    expect(run(base, "portal.use", use, "u1").events).toEqual(THROUGH_GATE);

    const moving = run(base, "portal.use", { ...use, observeUntil: base.simulationTime }, "u2");
    const closeInTransit = run(
      withState(base, moving.state),
      "portal.close",
      { schemaVersion: 1, portalId: "gate" },
      "c2",
    );
    expect(closeInTransit.refusal).toEqual({
      code: "precondition-failed",
      path: "payload.portalId",
      check: "portal.transit@1",
    });
    expect(run(withState(base, moving.state), "portal.use", use, "u3").refusal).toEqual({
      code: "precondition-failed",
      path: "payload.objectId",
      check: "portal.active-object@1",
    });
    expect(run(base, "portal.open", { schemaVersion: 1, portalId: "gate" }, "o1").refusal).toEqual({
      code: "precondition-failed",
      path: "payload.portalId",
      check: "portal.state@1",
    });
    expect(
      run(base, "portal.close", { schemaVersion: 1, portalId: "mover" }, "c3").refusal,
    ).toEqual({
      code: "precondition-failed",
      path: "payload.portalId",
      check: "portal.known@1",
    });
    const elsewhere = await spatialFixture([gate(), mover("mover", [4000n, 0n])]);
    expect(run(elsewhere, "portal.use", use, "u4").refusal).toEqual({
      code: "precondition-failed",
      path: "payload.portalId",
      check: "portal.reachable@1",
    });
    const retired = await spatialFixture([
      gate(),
      mover("mover", [0n, 0n], { lifecycle: { status: "retired" } }),
    ]);
    expect(run(retired, "portal.use", use, "u5").refusal).toEqual({
      code: "precondition-failed",
      path: "payload.objectId",
      check: "portal.active-object@1",
    });
  });

  it("refuses portals that leave the partition, link to themselves or name unknown places", async () => {
    const { partition } = await spatialFixture([gate()]);
    const refusal = (portal: WorldEntity) => {
      try {
        createWorldState({ ...partition.state, entities: [portal] });
      } catch (error) {
        if (error instanceof CompositionError) return [error.code, error.path];
        throw error;
      }
      return undefined;
    };
    const at = "state.entities[0].portal.endpoints[1]";
    expect(refusal(gate({ worldId: "other-world" }))).toEqual(["cross-world", `${at}.worldId`]);
    expect(refusal(gate({ partitionId: "other-partition" }))).toEqual([
      "cross-partition",
      `${at}.partitionId`,
    ]);
    expect(refusal(gate({ worldId: partition.state.worldId }))).toBeUndefined();
    const place = (endpoint: unknown) =>
      mover("gate", [0n, 0n], {
        portal: {
          status: "open",
          endpoints: [{ kind: "anchor", anchorId: "den-mouth" }, endpoint],
        },
      } as never);
    expect(refusal(place({ kind: "anchor", anchorId: "den-mouth" }))).toEqual(["self-link", at]);
    expect(refusal(place({ kind: "anchor", anchorId: "nowhere" }))).toEqual([
      "unknown-endpoint",
      `${at}.anchorId`,
    ]);
    expect(refusal(place({ kind: "region", regionId: "nowhere" }))).toEqual([
      "unknown-endpoint",
      `${at}.regionId`,
    ]);
  });

  it("prefers an anchor edge, then the smaller portal id, between equal-cost links", () => {
    const graph = parseAnchorGraph({
      graphId: "pair",
      version: 1,
      frameId: "ground-frame",
      frameVersion: 1,
      anchors: [
        { anchorId: "a", coordinates: [0n, 0n] },
        { anchorId: "b", coordinates: [1000n, 0n] },
      ],
      edges: [],
    });
    const portal = (portalId: string) => ({ portalId, from: "a", to: "b", cost: 1000n });
    expect(routeAnchors(graph, "a", "b", [portal("q"), portal("p")])?.via).toEqual(["p"]);
    const linked = { ...graph, edges: [{ from: "a", to: "b", cost: fixedPoint(1000n) }] };
    expect(routeAnchors(linked, "a", "b", [portal("p")])?.via).toEqual([null]);
    expect(routeAnchors(graph, "a", "b")).toBeUndefined();
  });
});

describe("movement event authority", () => {
  const fake = (type: string, objectId: string, time = 5n) =>
    ({ type, simulationTime: time, payload: { objectId } }) as never;
  const check = async (command: string, events: readonly unknown[]) => {
    const base = await spatialFixture([mover("mover", [0n, 0n]), mover("other", [1n, 1n])]);
    const state = base.partition.state;
    const refused = checkWorldInvariants(
      state,
      state,
      events as never,
      command as never,
      undefined,
      { objectId: "mover" },
    );
    // The fabricated events trip other invariants; only the event authority is under test.
    return refused?.check?.includes("event-authority") ? refused.path : undefined;
  };

  it("keeps the mover's movement events to the command that owns them", async () => {
    expect(await check("movement.start", [fake("movement.started", "mover")])).toBeUndefined();
    expect(await check("movement.start", [fake("movement.replanned", "mover")])).toBe(
      "events[0].type",
    );
    expect(await check("movement.start", [fake("movement.interrupted", "mover")])).toBe(
      "events[0].type",
    );
    expect(await check("movement.interrupt", [fake("movement.completed", "mover")])).toBe(
      "events[0].type",
    );
    expect(await check("movement.interrupt", [fake("movement.started", "mover")])).toBe(
      "events[0].type",
    );
  });

  it("takes other objects' movement events from the world time", async () => {
    expect(
      await check("movement.interrupt", [fake("movement.completed", "other")]),
    ).toBeUndefined();
  });

  it("accepts the mover's death interruption only with its death at the same time", async () => {
    const died = fake("lifecycle.died", "mover");
    expect(
      await check("movement.start", [fake("movement.interrupted", "mover"), died]),
    ).toBeUndefined();
    expect(await check("movement.start", [fake("movement.interrupted", "mover")])).toBe(
      "events[0].type",
    );
    expect(
      await check("movement.start", [
        fake("movement.interrupted", "mover"),
        fake("lifecycle.died", "mover", 6n),
      ]),
    ).toBe("events[0].type");
    expect(
      await check("movement.start", [
        fake("movement.interrupted", "mover"),
        fake("lifecycle.died", "other"),
      ]),
    ).toBe("events[0].type");
  });
});
