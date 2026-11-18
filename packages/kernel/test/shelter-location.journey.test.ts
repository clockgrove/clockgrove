import { replayWorldEvents, type WorldEvent } from "@clockgrove/domain";
import { expect, it } from "vitest";
import { composeComponentFixture } from "./component-fixtures/index.js";
import {
  DEFAULT_UTILITY,
  food,
  needs,
  RAIN,
  shelter,
  tracesOf,
  utilityWorld,
  WITH,
} from "./decisions.scenario.js";
import { CEDAR_SPEC, ecologyWorld } from "./ecology.scenario.js";
import {
  advanceInput,
  applyCommand,
  commandInput,
  type EnvironmentWorld,
  runChain,
} from "./environment.scenario.js";
import { COINCIDE_SPEC, lifeChain, lifeLive, lifeWorld } from "./lifecycle.scenario.js";
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
    replayWorldEvents(lazy.state, [...runs[0]!.events, ...fast.events, ...returned.events]),
  ).toEqual(returned.world.state);
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
  expect(replayWorldEvents(settled.state, created.events)).toEqual(created.world.state);
  const crate = execute(
    created.world,
    "object.create",
    {
      schemaVersion: 1,
      object: {
        objectId: "walking-crate",
        archetypeId: den.archetypeId,
        spatial: { spaceId: den.spaceId, pose: den.pose },
      },
    },
    "create-crate",
  );
  const walking = execute(
    crate.world,
    "movement.start",
    {
      schemaVersion: 1,
      objectId: "walking-crate",
      unitsPerSecond: 1000n,
      observeUntil: 1500n,
      destination: { kind: "pose", pose: { ...den.pose, coordinates: [2000n, 0n] } },
    },
    "walk-before-create",
  );
  const second = execute(
    walking.world,
    "object.create",
    {
      schemaVersion: 1,
      object: {
        objectId: "second-den",
        archetypeId: den.archetypeId,
        spatial: { spaceId: den.spaceId, pose: den.pose },
        shelter: { rainProtection: 10000 },
      },
    },
    "create-behind-walker",
  );
  expect(
    second.world.state.entities.find((entity) => entity.objectId === "walking-crate")!.locationId,
  ).toBeUndefined();
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
  expect(replayWorldEvents(settled.state, [...moved.events, ...fast.events])).toEqual(
    fast.world.state,
  );
});

it("rebuilds exposure when a routine shelter moves after its occupant decided", async () => {
  const base = await utilityWorld(
    WITH({
      ...RAIN,
      actors: [
        ["a-occupant", null],
        ["z-shelter", null],
      ],
      initial: [needs(0, 2999, 0), needs(9000, 0, 0)],
      starts: [
        [0, 0],
        [0, 0],
      ],
      hungerPerInterval: 0,
      items: [food("bin", [2000, 0])],
    }),
  );
  const world = {
    ...base,
    state: {
      ...base.state,
      spatialRegions: [
        {
          regionId: "arrival-edge",
          version: 1,
          frameId: base.state.entities[0]!.pose.frameId,
          frameVersion: 1,
          shape: { kind: "rectangle", min: [1500n, -100n], max: [2000n, 100n] },
        },
      ] as never,
      entities: base.state.entities.map((entity) =>
        entity.objectId === "z-shelter"
          ? { ...entity, shelter: { rainProtection: 10000 } }
          : entity.objectId === "a-occupant"
            ? { ...entity, locationId: "z-shelter" as typeof entity.objectId }
            : entity,
      ),
    },
  };
  const fast = runChain(world, "routine-fast", 500n);
  const live = runLiveSteps(world, "routine-live", 500n, [300, 200]);
  expect(live.world.state.entities).toEqual(fast.world.state.entities);
  expect(live.world.state.wellbeing).toEqual(fast.world.state.wellbeing);
  const bounded = runChain(world, "routine-bounded", 500n, 1, 8);
  expect(bounded.world.state.entities).toEqual(fast.world.state.entities);
  expect(bounded.world.state.wellbeing).toEqual(fast.world.state.wellbeing);
  expect(
    fast.world.state.entities.find((entity) => entity.objectId === "a-occupant")!.needs!.wetness,
  ).toBe(3749);
  expect(changes(fast.events)).toContainEqual([0n, "a-occupant", null]);
  const arrived = runChain(world, "arrival-fast", 1500n);
  const stepped = runLiveSteps(world, "arrival-live", 1500n, [300, 200]);
  expect(stepped.world.state.entities).toEqual(arrived.world.state.entities);
  expect(stepped.world.state.wellbeing).toEqual(arrived.world.state.wellbeing);
  expect(
    arrived.events
      .filter((event) => event.type === "movement.completed")
      .map((event) => [event.simulationTime, event.payload.objectId]),
  ).toContainEqual([1000n, "z-shelter"]);
  expect(
    fast.events
      .filter((event) => event.type === "exposure.threshold-crossed")
      .map((event) => [event.simulationTime, event.payload.objectId]),
  ).toContainEqual([1n, "a-occupant"]);
});

it("does not locate occupants in a shelter stopped by death, including bounded lifecycle advances", async () => {
  const base = await lifeWorld(COINCIDE_SPEC);
  const resident = base.state.entities.find((entity) => entity.objectId === "a-resident")!;
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: [
        ...base.state.entities.map((entity) =>
          entity === resident ? { ...entity, shelter: { rainProtection: 10000 } } : entity,
        ),
        {
          objectId: "occupant" as typeof resident.objectId,
          archetypeId: resident.archetypeId,
          spaceId: resident.spaceId,
          pose: { ...resident.pose, coordinates: [1n, 0n] as never },
        },
      ],
    },
  };
  const started = execute(
    world,
    "movement.start",
    {
      schemaVersion: 1,
      objectId: resident.objectId,
      destination: { kind: "pose", pose: { ...resident.pose, coordinates: [500n, 0n] } },
      unitsPerSecond: 1000n,
      observeUntil: 0n,
    },
    "terminal-start",
  );
  const moving = { ...started.world, random: base.random };
  const fast = lifeChain(moving, "terminal-fast", 2n);
  const live = lifeLive(moving, "terminal-live", 2n, 1n);
  for (const maxEvents of [6, 7, 9]) {
    const bounded = lifeChain(moving, `terminal-bounded-${maxEvents}`, 2n, 1024, maxEvents);
    if (maxEvents === 6) expect(bounded.calls.length).toBeGreaterThan(1);
    expect(bounded.world.state.entities).toEqual(fast.world.state.entities);
    expect(bounded.world.state.wellbeing).toEqual(fast.world.state.wellbeing);
    expect(
      bounded.calls.every(
        (call) => call.outcome.ok && call.outcome.result.events.length <= maxEvents,
      ),
    ).toBe(true);
  }
  expect(live.world.state.entities).toEqual(fast.world.state.entities);
  expect(live.world.state.wellbeing).toEqual(fast.world.state.wellbeing);
  expect(changes(fast.events)).toEqual([]);
  expect(
    fast.world.state.entities.find((entity) => entity.objectId === "occupant")!.locationId,
  ).toBeUndefined();
  expect(
    fast.events
      .filter((event) => ["movement.interrupted", "lifecycle.died"].includes(event.type))
      .map((event) => [event.type, event.simulationTime]),
  ).toEqual([
    ["movement.interrupted", 1n],
    ["lifecycle.died", 1n],
  ]);
  expect(replayWorldEvents(moving.state, fast.events)).toEqual(fast.world.state);
});

it("forces shelter at the pack's reflex threshold, 9000 when it declares none", async () => {
  const world = await utilityWorld(
    WITH({
      ...RAIN,
      initial: [needs(9000, 9500, 0)],
      items: [shelter("den", [4000, 0], 1000), food("bin", [1000, 0])],
      utility: { ...DEFAULT_UTILITY, perceptionRange: 5000n },
    }),
  );
  const tier = (declared: object) => {
    const { pack, policies } = world.template;
    const policy = {
      ...pack.pack.policy,
      environment: { ...pack.pack.policy.environment!, ...declared },
    };
    const template = {
      ...world.template,
      pack: { ...pack, pack: { ...pack.pack, policy } },
      policies: { ...policies, policy },
    } as typeof world.template;
    return tracesOf(runChain({ ...world, template }, "reflex", 1500n))[0]!.selectionTier;
  };
  expect(tier({})).toBe("reflex");
  expect(tier({ shelterReflexThreshold: 10000 })).toBe("utility");
});

it("treats a coat as the wearer's own protection and a shelter's cover radius as shelter for everyone inside it", async () => {
  const base = await utilityWorld(
    WITH({
      ...RAIN,
      intervalMs: 10000,
      hunger: 0,
      actors: [
        ["a-bare", null],
        ["b-dog", null],
        ["c-near", null],
        ["d-far", null],
      ],
      initial: [needs(0, 1000, 0), needs(0, 1000, 0), needs(0, 1000, 0), needs(0, 1000, 0)],
      starts: [
        [5000, 0],
        [5000, 0],
        [300, 0],
        [800, 0],
      ],
      items: [shelter("den", [9000, 0])],
    }),
  );
  // The dog's coat is pack data: `clockgrove.weather-exposure` projects to its own protection.
  const coated = composeComponentFixture("weather", false, false, 5000).scenario.initialState;
  const dog = coated.entities.find((entity) => entity.objectId === "subject")!;
  expect(dog.weatherProtection).toEqual({ rainProtection: 5000 });
  expect(dog.shelter).toBeUndefined();
  expect(coated.entities.filter((entity) => entity.shelter !== undefined).length).toBe(2);
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: base.state.entities.map((entity) =>
        entity.objectId === "b-dog"
          ? { ...entity, weatherProtection: dog.weatherProtection! }
          : entity,
      ),
    },
  };
  const wet = (w: EnvironmentWorld, id: string) =>
    w.state.entities.find((entity) => entity.objectId === id)!.needs!.wetness;
  const settled = runChain(world, "coat", 1500n);
  expect([wet(settled.world, "a-bare"), wet(settled.world, "b-dog")]).toEqual([1225, 1037]);
  const targets = tracesOf(settled)
    .flatMap((trace) => trace.candidates as { action: { kind: string; targetObjectId: string } }[])
    .filter((candidate) => candidate.action.kind === "seek-shelter")
    .map((candidate) => candidate.action.targetObjectId);
  expect(new Set(targets)).toEqual(new Set(["den"]));

  const den = settled.world.state.entities.find((entity) => entity.objectId === "den")!;
  const created = execute(
    settled.world,
    "object.create",
    {
      schemaVersion: 1,
      object: {
        objectId: "porch",
        archetypeId: den.archetypeId,
        spatial: {
          spaceId: den.spaceId,
          pose: { ...den.pose, coordinates: [0n, 0n] },
        },
        shelter: { rainProtection: 10000, coverRadius: 500n },
      },
    },
    "porch",
  );
  expect(changes(created.events)).toEqual([[1500n, "c-near", "porch"]]);
  const after = runChain(created.world, "porch-after", 2500n);
  expect(wet(created.world, "c-near")).toBe(1225);
  // Under the porch's cover c-near dries; d-far, outside it, keeps getting wetter.
  expect([wet(after.world, "c-near"), wet(after.world, "d-far")]).toEqual([1125, 1375]);

  // A walk that stays within the cover keeps c-near under the porch the whole way; one that leaves
  // it unlocates the walker where it crosses the boundary (500 units, 201 ms after it sets out).
  const within = move(created.world, "c-near", -400n, "walk-under-porch");
  expect(changes(within.events)).toEqual([]);
  const walked = runChain(within.world, "walk-under-after", 2500n);
  expect(changes(walked.events)).toEqual([]);
  expect(walked.world.state.entities.find((entity) => entity.objectId === "c-near")).toMatchObject({
    locationId: "porch",
    pose: { coordinates: [-400n, 0n] },
  });
  expect(wet(walked.world, "c-near")).toBe(1125);
  expect(replayWorldEvents(created.world.state, within.events)).toEqual(within.world.state);
  const out = move(created.world, "c-near", 900n, "walk-out-of-porch");
  expect(changes(out.events)).toEqual([[1701n, "c-near", null]]);
});

it("keeps a walker under a shelter's cover until its walk crosses the cover's boundary", async () => {
  const base = await rainy(true);
  // The den, where the actor stands in the rain, declares a cover of 500 units around it.
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: base.state.entities.map((entity) =>
        entity.objectId === "den"
          ? { ...entity, shelter: { ...entity.shelter!, coverRadius: 500n } }
          : entity,
      ),
    },
  };
  const wetness = (events: readonly WorldEvent[]) =>
    events
      .filter((event) => event.type === "needs.changed")
      .map((event) => [event.simulationTime, event.payload.wetness]);
  const walk = (x: bigint, id: string) => {
    const started = move(world, actor, x, id);
    const finished = runChain(started.world, `${id}-after`, 3000n);
    expect(replayWorldEvents(world.state, started.events)).toEqual(started.world.state);
    expect(replayWorldEvents(started.world.state, finished.events)).toEqual(finished.world.state);
    return [...started.events, ...finished.events];
  };

  // From the den's centre to (400, 0), inside the cover: it stays in the den and dries all the way.
  const within = walk(400n, "walk-within");
  expect(changes(within)).toEqual([]);
  expect(wetness(within).every(([, value]) => (value as number) < 1000)).toBe(true);

  // To (900, 0) at 1 unit/ms: under the den, drying, until it passes 500 units at 501 ms; from
  // there it is on open ground and gets wetter. Its decision walks it back, and it is in the den
  // again where it re-enters the cover (2 units/ms: 200 ms after 900).
  const out = walk(900n, "walk-out");
  expect(changes(out)).toEqual([
    [501n, actor, null],
    [1100n, actor, "den"],
  ]);
  expect(wetness(out).slice(0, 3)).toEqual([
    [501n, 949],
    [900n, 1009],
    [1100n, 1039],
  ]);
});

it("enters the cover a walk starts under, even from open ground", async () => {
  // The actor stands unlocated at the den's centre in the rain; the den declares a 500-unit cover.
  const base = await rainy(false);
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: base.state.entities.map((entity) =>
        entity.objectId === "den"
          ? { ...entity, shelter: { ...entity.shelter!, coverRadius: 500n } }
          : entity,
      ),
    },
  };
  const started = move(world, actor, 900n, "walk-from-open");
  const finished = runChain(started.world, "walk-from-open-after", 3000n);
  expect(replayWorldEvents(world.state, started.events)).toEqual(started.world.state);
  expect(replayWorldEvents(started.world.state, finished.events)).toEqual(finished.world.state);
  // Its first millisecond is under the den's cover: it is in the den as it sets out, and on open
  // ground from the boundary (501 ms) on.
  expect(changes([...started.events, ...finished.events]).slice(0, 2)).toEqual([
    [world.state.simulationTime, actor, "den"],
    [501n, actor, null],
  ]);
});

it("unlocates a mover the world time does not follow as it sets out, even under a cover", async () => {
  // A plant is no needs actor, so the world time does not follow its walk past the command's
  // events: walking out of its shelter's cover, it leaves the shelter as it sets out.
  const base = await ecologyWorld(CEDAR_SPEC);
  const home = base.state.entities.find((entity) => entity.objectId === "sheltered-cedar")!
    .locationId!;
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: base.state.entities.map((entity) =>
        entity.objectId === home
          ? { ...entity, shelter: { ...entity.shelter!, coverRadius: 500n } }
          : entity,
      ),
    },
  };
  const settled = applyCommand(
    world,
    commandInput(world, "world.advance", "cover-plant-before", {
      targetTime: 3500n,
      maxInputs: 1024,
      maxEvents: 4096,
      lazy: true,
    }),
  ).world;
  const pose = settled.state.entities.find((entity) => entity.objectId === "sheltered-cedar")!.pose;
  const moved = execute(
    settled,
    "movement.start",
    {
      schemaVersion: 1,
      objectId: "sheltered-cedar",
      destination: { kind: "pose", pose: { ...pose, coordinates: [2000n, 0n] } },
      unitsPerSecond: 1000n,
      observeUntil: 3500n,
    },
    "cover-plant-move",
  );
  const after = runChain(moved.world, "cover-plant-after", 9000n);
  expect(changes([...moved.events, ...after.events])).toEqual([[3500n, "sheltered-cedar", null]]);
  expect(
    after.world.state.ecology!.plants.find((entry) => entry.objectId === "sheltered-cedar")!
      .wetness,
  ).toBeGreaterThan(0);
  expect(replayWorldEvents(settled.state, [...moved.events, ...after.events])).toEqual(
    after.world.state,
  );
});

it("locates a walker under a cover created over it, and unlocates it when that shelter sets out or is retired", async () => {
  const base = await rainy(true);
  // The den, where the actor stands in the rain, declares a cover of 500 units around it.
  const world = {
    ...base,
    state: {
      ...base.state,
      entities: base.state.entities.map((entity) =>
        entity.objectId === "den"
          ? { ...entity, shelter: { ...entity.shelter!, coverRadius: 500n } }
          : entity,
      ),
    },
  };
  // It walks out to (900, 0); its decision walks it back toward the den at 2 units/ms from 900 ms.
  const out = move(world, actor, 900n, "walk-past-porch");
  const midway = runChain(out.world, "walk-past-porch-mid", 1000n);
  const walker = midway.world.state.entities.find((entity) => entity.objectId === actor)!;
  expect([walker.movement?.status, walker.locationId ?? null]).toEqual(["active", null]);
  const den = midway.world.state.entities.find((entity) => entity.objectId === "den")!;
  const created = execute(
    midway.world,
    "object.create",
    {
      schemaVersion: 1,
      object: {
        objectId: "porch",
        archetypeId: den.archetypeId,
        spatial: {
          spaceId: den.spaceId,
          pose: { ...den.pose, coordinates: [700n, 0n] },
        },
        shelter: { rainProtection: 10000, coverRadius: 100n },
      },
    },
    "porch-over-walker",
  );
  // At (700, 0) the walker is inside the new porch's cover: it is under the porch from its
  // creation, on open ground where its walk leaves that cover (600 units, 1051 ms), and in the den
  // where it enters the den's (1100 ms).
  expect(changes(created.events)).toEqual([[1000n, actor, "porch"]]);
  const after = runChain(created.world, "porch-over-walker-after", 1200n);
  expect(changes(after.events)).toEqual([
    [1051n, actor, null],
    [1100n, actor, "den"],
  ]);
  expect(replayWorldEvents(midway.world.state, [...created.events, ...after.events])).toEqual(
    after.world.state,
  );

  // A walker under the porch leaves it the moment the porch sets out, or is retired.
  const porch = created.world.state.entities.find((entity) => entity.objectId === "porch")!;
  const departed = execute(
    created.world,
    "movement.start",
    {
      schemaVersion: 1,
      objectId: "porch",
      destination: {
        kind: "pose",
        pose: { ...porch.pose, coordinates: [700n, 2000n] },
      },
      unitsPerSecond: 1000n,
    },
    "porch-sets-out",
  );
  expect(changes(departed.events)[0]).toEqual([1000n, actor, null]);
  expect(replayWorldEvents(created.world.state, departed.events)).toEqual(departed.world.state);
  const retired = execute(
    created.world,
    "object.retire",
    { schemaVersion: 1, objectId: "porch", disposition: "discard" },
    "porch-retired",
  );
  expect(changes(retired.events)).toEqual([[1000n, actor, null]]);
  expect(replayWorldEvents(created.world.state, retired.events)).toEqual(retired.world.state);
});
