import { replayWorldEvents, type WorldEvent } from "@clockgrove/domain";
import { expect, it } from "vitest";
import { needs, RAIN, shelter, utilityWorld, WITH } from "./decisions.scenario.js";
import { CEDAR_SPEC, ecologyWorld } from "./ecology.scenario.js";
import {
  advanceInput,
  applyCommand,
  commandInput,
  type EnvironmentWorld,
  runChain,
} from "./environment.scenario.js";
import { movementInput } from "./spatial.scenario.js";
import { runLiveSteps } from "./wellbeing.scenario.js";

const actor = "t-weather";
const changes = (events: readonly WorldEvent[]) =>
  events
    .filter((event) => event.type === "location.changed")
    .map((event) => [event.simulationTime, event.payload.objectId, event.payload.locationId]);
const execute = (world: EnvironmentWorld, type: string, payload: object, id: string) =>
  applyCommand(
    world,
    movementInput(advanceInput(world, id, world.state.simulationTime), type, payload, id) as never,
  );
const move = (world: EnvironmentWorld, objectId: string, x: bigint, id: string) =>
  execute(
    world,
    "movement.start",
    {
      schemaVersion: 1,
      objectId,
      destination: {
        kind: "pose",
        pose: {
          ...world.state.entities.find((entity) => entity.objectId === objectId)!.pose,
          coordinates: [x, 0n],
        },
      },
      unitsPerSecond: 1000n,
    },
    id,
  );
const rainy = (located: boolean) =>
  utilityWorld(
    WITH({
      ...RAIN,
      intervalMs: 10000,
      hunger: 0,
      initial: [needs(0, 1000, 0)],
      items: [shelter("den", [0, 0])],
      located: [located ? "den" : null],
    }),
  );

it("integrates occupants under old protection when a shelter leaves and locates them when it returns, with live/aggregate/replay parity", async () => {
  const world = await rainy(true);
  const lazy = applyCommand(
    world,
    commandInput(world, "world.advance", "lazy", {
      targetTime: 1500n,
      maxInputs: 1024,
      maxEvents: 4096,
      lazy: true,
    }),
  ).world;
  const eager = runLiveSteps(world, "eager", 1500n, [700, 300]).world;
  const runs = [lazy, eager].map((settled) => move(settled, "den", 500n, "leave"));
  for (const run of runs) {
    expect(changes(run.events)).toEqual([[1500n, actor, null]]);
    expect(run.events.findIndex((event) => event.type === "location.changed")).toBeLessThan(
      run.events.findIndex((event) => event.type === "movement.started"),
    );
  }
  expect(runs[0]!.events.map((event) => event.type)).toContain("needs.changed");
  expect(runs[0]!.world.state.entities).toEqual(runs[1]!.world.state.entities);
  expect(runs[0]!.world.state.wellbeing).toEqual(runs[1]!.world.state.wellbeing);
  const fast = runChain(runs[0]!.world, "fast", 2500n);
  const live = runLiveSteps(runs[1]!.world, "live", 2500n, [700, 300]);
  expect(live.world.state.entities).toEqual(fast.world.state.entities);
  expect(live.world.state.wellbeing).toEqual(fast.world.state.wellbeing);
  const returned = move(fast.world, "den", 0n, "return");
  expect(changes(returned.events)).toEqual([[3000n, actor, "den"]]);
  expect(
    returned.world.state.entities.find((entity) => entity.objectId === actor)!.needs!.wetness,
  ).toBe(1075);
  expect(runs[0]!.events.map((event) => event.type)).toEqual([
    "needs.changed",
    "wellbeing.integrated",
    "location.changed",
    "movement.started",
    "movement.completed",
  ]);
  expect(
    replayWorldEvents(lazy.state, [...runs[0]!.events, ...fast.events, ...returned.events])
      .entities,
  ).toEqual(returned.world.state.entities);
});

it("creates a shelter at an occupant's pose after integrating its previous exposure", async () => {
  const base = await rainy(false);
  const den = base.state.entities.find((entity) => entity.objectId === "den")!;
  const world = {
    ...base,
    state: { ...base.state, entities: base.state.entities.filter((entity) => entity !== den) },
  };
  const settled = applyCommand(
    world,
    commandInput(world, "world.advance", "lazy-create", {
      targetTime: 1500n,
      maxInputs: 1024,
      maxEvents: 4096,
      lazy: true,
    }),
  ).world;
  const created = execute(
    settled,
    "object.create",
    {
      schemaVersion: 1,
      object: {
        objectId: "new-den",
        archetypeId: den.archetypeId,
        spatial: { spaceId: den.spaceId, pose: den.pose },
        shelter: { rainProtection: 10000 },
      },
    },
    "create",
  );
  expect(changes(created.events)).toEqual([[1500n, actor, "new-den"]]);
  expect(created.events.map((event) => event.type)).toContain("needs.changed");
  expect(
    created.world.state.entities.find((entity) => entity.objectId === actor)!.needs!.wetness,
  ).toBe(1225);
  expect(created.events.map((event) => event.type)).toEqual([
    "object.created",
    "needs.changed",
    "wellbeing.integrated",
    "location.changed",
  ]);
  const after = runChain(created.world, "create-after", 2500n);
  expect(
    after.world.state.entities.find((entity) => entity.objectId === actor)!.needs!.wetness,
  ).toBe(1125);
  expect(replayWorldEvents(settled.state, created.events).entities).toEqual(
    created.world.state.entities,
  );
});

it("moves a shelter that is itself a sheltered plant without losing its old growth integration or protecting itself", async () => {
  const base = await ecologyWorld(CEDAR_SPEC);
  const cedar = base.state.entities.find((entity) => entity.objectId === "sheltered-cedar")!;
  const crate = {
    ...cedar,
    objectId: "crate" as typeof cedar.objectId,
    locationId: cedar.objectId,
  };
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: [
        crate,
        ...base.state.entities.map((entity) =>
          entity === cedar ? { ...entity, shelter: { rainProtection: 10000 } } : entity,
        ),
      ],
    },
  };
  const settled = applyCommand(
    world,
    commandInput(world, "world.advance", "plant-before", {
      targetTime: 3500n,
      maxInputs: 1024,
      maxEvents: 4096,
      lazy: true,
    }),
  ).world;
  const moved = move(settled, "sheltered-cedar", 2000n, "plant-move");
  expect(changes(moved.events).filter(([, id]) => id === "sheltered-cedar")).toEqual([
    [3500n, "sheltered-cedar", null],
  ]);
  const growthIndex = moved.events.findIndex(
    (event) => event.type === "growth.integrated" && event.payload.objectId === "sheltered-cedar",
  );
  expect(growthIndex).toBeGreaterThanOrEqual(0);
  expect(growthIndex).toBeLessThan(
    moved.events.findIndex((event) => event.type === "location.changed"),
  );
  const fast = runChain(moved.world, "plant-fast", 9000n);
  const live = runLiveSteps(moved.world, "plant-live", 9000n, [700, 300]);
  expect(live.world.state.ecology).toEqual(fast.world.state.ecology);
  expect(changes(moved.events)).toContainEqual([3500n, "crate", "shelter-10000"]);
  expect(
    fast.world.state.ecology!.plants.find((entry) => entry.objectId === "sheltered-cedar"),
  ).toMatchObject({ growingMs: 2300n, wetness: 3250, integratedAt: 9000n });
  expect(replayWorldEvents(settled.state, [...moved.events, ...fast.events]).ecology).toEqual(
    fast.world.state.ecology,
  );
});
