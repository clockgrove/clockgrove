import { replayWorldEvents, type WorldEvent } from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UTILITY,
  food,
  needs,
  RAIN,
  shelter,
  type UtilitySpec,
  utilityWorld,
  WITH,
} from "./decisions.scenario.js";
import { CEDAR_SPEC, ecologyWorld } from "./ecology.scenario.js";
import {
  advanceInput,
  applyCommand,
  commandInput,
  type EnvironmentWorld,
  type Run,
  runChain,
} from "./environment.scenario.js";
import { movementInput } from "./spatial.scenario.js";
import { runLiveSteps } from "./wellbeing.scenario.js";

// Issue 204: every way a move or stop ends applies one location rule, and a retired shelter
// protects no one. Each case runs live (small steps) and fast-forward and must agree.

const ACTOR = "t-weather";
const at = (x: bigint) => ({
  kind: "pose",
  pose: { frameId: "zone-ground", frameVersion: 1, coordinates: [x, 0n] },
});
const command = (world: EnvironmentWorld, type: string, payload: object, id: string): Run =>
  applyCommand(
    world,
    movementInput(advanceInput(world, id, world.state.simulationTime), type, payload, id) as never,
  );
const locations = (events: readonly WorldEvent[]) =>
  events
    .filter((event) => event.type === "location.changed")
    .map((event) => {
      const { objectId, locationId, planId } = event.payload as Record<string, string | null>;
      return [event.simulationTime, objectId, locationId, planId];
    });
const relief = (events: readonly WorldEvent[]) =>
  events.filter((event) => event.type === "needs.relieved").map((event) => event.payload);
const objectOf = (run: Run, id: string) =>
  run.world.state.entities.find((entity) => entity.objectId === id)!;

/** Live hourly-style steps and one fast-forward agree, and the journal replays to the state. */
function both(world: EnvironmentWorld, target: bigint): Run {
  const fast = runChain(world, "fast", target);
  const live = runLiveSteps(world, "live", target, [700, 300]);
  expect(locations(live.events)).toEqual(locations(fast.events));
  expect(live.world.state.entities).toEqual(fast.world.state.entities);
  const replayed = replayWorldEvents(world.state, fast.events);
  expect(replayed.entities).toEqual(fast.world.state.entities);
  return fast;
}

/** The actor walks east at 2 units/ms toward `bin` (8000, 0); a shelter stands at (4000, 0). */
const WALK = (over: Partial<UtilitySpec>) =>
  WITH({
    items: [food("bin", [8000, 0]), shelter("porch", [4000, 0], 0)],
    utility: { ...DEFAULT_UTILITY, perceptionRange: 1500n },
    scripted: [
      {
        ref: "scripted:belief:bin",
        kind: "belief",
        actorId: ACTOR,
        targetObjectId: "bin",
        value: 10000,
        effectiveAt: 0n,
      },
    ],
    ...over,
  });

describe("decision stops (item 1)", () => {
  it("enters the shelter where a decision stops the walk to eat at its pose", async () => {
    // At 2000 the walk passes the porch, where a stash becomes known: the decision stops it there.
    const spec = WALK({});
    const world = await utilityWorld({
      ...spec,
      items: [...spec.items, food("stash", [4000, 0])],
      scripted: [
        ...spec.scripted!,
        { ...spec.scripted![0]!, ref: "scripted:belief:stash", targetObjectId: "stash" },
      ].map((entry, index) => (index === 1 ? { ...entry, effectiveAt: 2000n } : entry)),
    });
    const run = both(world, 3000n);
    expect(locations(run.events)).toEqual([[2000n, ACTOR, "porch", `plan:${ACTOR}@2000`]]);
    expect(relief(run.events)[0]).toMatchObject({ sourceObjectId: "stash" });
  });

  it("enters the shelter where a decision to stay stops the walk", async () => {
    // A second actor empties the bin first, so the walker's decision at 1000 (at 2000, 0) stays.
    const world = await utilityWorld(
      WITH({
        actors: [
          ["a-weather", null],
          ["b-weather", null],
        ],
        starts: [
          [0, 0],
          [3000, 0],
        ],
        items: [food("bin", [4000, 0], 2), shelter("porch", [2000, 0], 0)],
        utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
      }),
    );
    const run = both(world, 2500n);
    expect(run.events.find((event) => event.type === "movement.interrupted")?.simulationTime).toBe(
      1000n,
    );
    expect(locations(run.events)).toEqual([[1000n, "a-weather", "porch", "plan:a-weather@1000"]]);
  });
});

describe("moving commands (items 2 and 4)", () => {
  it("enters on movement.interrupted, leaves on movement.replanned and names the movement as the plan of a walk advance finishes", async () => {
    const world = await utilityWorld(WALK({}));
    const walking = runChain(world, "walk", 1500n).world;
    const decided = walking.state.entities.find((entity) => entity.objectId === ACTOR)!.movement!;
    const interrupt = { schemaVersion: 1, objectId: ACTOR, at: 2000n };
    const stopped = command(walking, "movement.interrupt", interrupt, "stop");
    expect(locations(stopped.events)).toEqual([[2000n, ACTOR, "porch", decided.movementId]]);
    const replan = {
      ...interrupt,
      destination: at(8000n),
      unitsPerSecond: 2000n,
      observeUntil: 2000n,
    };
    const moving = command(stopped.world, "movement.replan", replan, "replan");
    const types = moving.events.map((event) => event.type);
    expect(types.indexOf("location.changed")).toBe(types.indexOf("movement.replanned") - 1);
    const movementId = objectOf(moving, ACTOR).movement!.movementId;
    expect(locations(moving.events)).toEqual([[2000n, ACTOR, null, movementId]]);
    // The walk the replan started is finished by the world time: its plan is that movement.
    const done = both(moving.world, 4000n);
    expect(done.events.some((event) => event.type === "movement.completed")).toBe(true);
    expect(relief(done.events)[0]).toMatchObject({ sourceObjectId: "bin", planId: movementId });
  });
});

describe("retired shelters and objects without needs (item 5)", () => {
  it("evicts whatever is in a shelter when it is retired, integrated first, so lazy and eager runs agree", async () => {
    // In rain, the actor sits in a fully protecting den with a crate (no needs) beside it.
    const spec = WITH({
      ...RAIN,
      hunger: 0,
      initial: [needs(0, 1000, 0)],
      items: [shelter("den", [0, 0]), food("crate", [0, 0], 0)],
      located: ["den"],
    });
    const base = await utilityWorld(spec);
    const crate = (entity: (typeof base.state.entities)[number]) =>
      entity.objectId === "crate" ? { ...entity, locationId: "den" as never } : entity;
    const world = { ...base, state: { ...base.state, entities: base.state.entities.map(crate) } };
    const lazy = { targetTime: 1500n, maxInputs: 1024, maxEvents: 4096, lazy: true };
    const retire = { schemaVersion: 1, objectId: "den", disposition: "discard" };
    const [eager, unintegrated] = [
      runLiveSteps(world, "settle", 1500n, [700, 300]).world,
      applyCommand(world, commandInput(world, "world.advance", "lazy", lazy)).world,
    ].map((settled) => command(settled, "object.retire", retire, "retire"));
    for (const retired of [eager!, unintegrated!]) {
      expect(locations(retired.events)).toEqual([
        [1500n, "crate", null, "retire"],
        [1500n, ACTOR, null, "retire"],
      ]);
      expect(retired.events.at(-1)?.type).toBe("object.retired");
    }
    expect(unintegrated!.events.map((event) => event.type)).toContain("needs.changed");
    expect(unintegrated!.world.state.entities).toEqual(eager!.world.state.entities);
    // On open ground the rain wets the actor from the retirement on.
    const after = both(eager!.world, 2500n);
    expect(objectOf(after, ACTOR).needs!.wetness).toBeGreaterThan(
      objectOf(eager!, ACTOR).needs!.wetness,
    );
  });

  it("clears a sheltered plant's location when a command moves it out, live as fast-forward", async () => {
    const world = await ecologyWorld(CEDAR_SPEC);
    const walk = {
      schemaVersion: 1,
      objectId: "sheltered-cedar",
      destination: at(2000n),
      unitsPerSecond: 1000n,
    };
    const runs = [runChain(world, "fast", 3000n), runLiveSteps(world, "live", 3000n, [700, 300])]
      .map((run) => command(run.world, "movement.start", walk, "walk"))
      .map((run) => [run, both(run.world, 9000n)] as const);
    for (const [moved] of runs)
      expect(locations(moved.events)).toEqual([[3000n, "sheltered-cedar", null, "movement-walk"]]);
    // Out of its shelter the cedar gets wet, and the plant records agree.
    const plant = (run: Run) =>
      run.world.state.ecology!.plants.find((entry) => entry.objectId === "sheltered-cedar")!;
    expect(plant(runs[0]![1]).wetness).toBeGreaterThan(0);
    expect(plant(runs[1]![1])).toEqual(plant(runs[0]![1]));
  });
});
