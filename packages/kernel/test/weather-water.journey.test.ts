import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  fixedPoint,
  reduceWorldEvent,
} from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel, type WorldSemanticEvent } from "../src/world.js";
import { SNACK_SPEC, utilitySample } from "./decisions.scenario.js";
import { baseSpec, ecologySample, quantityOf, runResource } from "./ecology.scenario.js";
import {
  advanceInput,
  applyCommand,
  materialState,
  runChain,
  runLive,
  weatherInput,
} from "./environment.scenario.js";
import { movementInput, startPayload } from "./spatial.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

async function waterWorld(sample: ReturnType<typeof ecologySample>) {
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  const initialState = createWorldState({
    ...decoded.initialState,
    environment: deriveEnvironmentState(
      decoded.pack.policy.environment!,
      decoded.initialState.simulationTime,
    ),
  });
  const template = await scenarioInput(undefined, 0, 32, {}, 32, {
    pack: decoded.pack,
    initialState,
  });
  return { template, state: template.partition.state, schedules: template.schedules };
}

it("journals weather water at exact instants with bounded inventory and execution-shape parity", async () => {
  const sample = ecologySample(
    baseSpec({
      actors: [],
      phases: [["day", 0, "bright"]],
      segments: [
        [4000, 10000, "rain"],
        [6000, 0, "dry"],
      ],
      holders: [
        { objectId: "open", kind: "water", quantity: 0 },
        { objectId: "half", kind: "water", quantity: 0 },
        { objectId: "closed", kind: "water", quantity: 0 },
        { objectId: "evaporator", kind: "water", quantity: 2 },
      ],
    }),
  );
  const holder = sample.initialState.entities[0];
  sample.initialState.entities.push(
    { ...holder, objectId: "half-roof", resource: undefined, shelter: { rainProtection: 5000 } },
    { ...holder, objectId: "closed-roof", resource: undefined, shelter: { rainProtection: 10000 } },
  );
  delete sample.initialState.entities[4].resource;
  delete sample.initialState.entities[5].resource;
  sample.initialState.entities[1].locationId = "half-roof";
  sample.initialState.entities[2].locationId = "closed-roof";
  sample.pack.policy.ecology.waterHolders = [
    { objectId: "open", capacity: 2, catchment: 3600, evaporationPerHour: 0 },
    { objectId: "half", capacity: 4, catchment: 3600, evaporationPerHour: 0 },
    { objectId: "closed", capacity: 4, catchment: 3600, evaporationPerHour: 0 },
    { objectId: "evaporator", capacity: 2, catchment: 0, evaporationPerHour: 3600 },
  ];
  sample.initialState.ecology.waterHolders = sample.pack.policy.ecology.waterHolders.map(
    ({ objectId }: { objectId: string }) => ({
      objectId,
      collectionRemainder: "0",
      evaporationRemainder: "0",
      integratedAt: "0",
    }),
  );
  const world = await waterWorld(sample);
  const template = world.template;
  const decoded = { pack: template.pack.pack };
  const material = (events: readonly WorldSemanticEvent[]) =>
    events.flatMap((event) =>
      event.type === "resource.weather-integrated" &&
      (event.payload.collected !== 0 || event.payload.evaporated !== 0)
        ? [
            {
              time: event.simulationTime,
              objectId: event.payload.objectId,
              collected: event.payload.collected,
              evaporated: event.payload.evaporated,
            },
          ]
        : [],
    );
  const aggregate = runChain(world, "weather-aggregate", 8000n);
  const live = runLive(world, "weather-live", 8000n, 333n);
  const bounded = runChain(world, "weather-bounded", 8000n, 1, 8);
  expect(material(aggregate.events)).toEqual([
    { time: 1000n, objectId: "evaporator", collected: 0, evaporated: 1 },
    { time: 1000n, objectId: "open", collected: 1, evaporated: 0 },
    { time: 2000n, objectId: "evaporator", collected: 0, evaporated: 1 },
    { time: 2000n, objectId: "half", collected: 1, evaporated: 0 },
    { time: 2000n, objectId: "open", collected: 1, evaporated: 0 },
    { time: 4000n, objectId: "half", collected: 1, evaporated: 0 },
  ]);
  expect(
    aggregate.events
      .filter(
        (event) =>
          event.simulationTime === 4000n &&
          (event.type === "weather.transitioned" ||
            (event.type === "resource.weather-integrated" && event.payload.collected > 0)),
      )
      .map((event) => event.type),
  ).toEqual(["weather.transitioned", "resource.weather-integrated"]);
  expect(material(live.events)).toEqual(material(aggregate.events));
  expect(material(bounded.events)).toEqual(material(aggregate.events));
  expect(bounded.incomplete).toBeGreaterThan(0);
  for (const { outcome } of bounded.calls) {
    if (!outcome.ok) throw new Error("bounded weather call failed");
    expect(outcome.result.state.ecology!.waterHolders!.map((entry) => entry.integratedAt)).toEqual(
      Array(4).fill(outcome.result.state.simulationTime),
    );
  }
  expect(materialState(live.world.state)).toEqual(materialState(aggregate.world.state));
  expect(materialState(bounded.world.state)).toEqual(materialState(aggregate.world.state));
  expect(aggregate.events.reduce(reduceWorldEvent, world.state)).toEqual(aggregate.world.state);
  expect(
    ["open", "half", "closed", "evaporator"].map((id) => quantityOf(aggregate.world.state, id)),
  ).toEqual([2, 2, 0, 0]);
  expect(runChain(aggregate.world, "weather-again", 8000n).events).toEqual([]);

  const full = runChain(world, "weather-full", 2500n).world;
  const drained = runResource(
    full,
    "resource.consume",
    { objectId: "open", kind: "water", quantity: 2 },
    "weather-drain",
  ).world;
  const recollected = runChain(drained, "weather-recollect", 4000n);
  expect(material(recollected.events).filter((event) => event.objectId === "open")).toEqual([
    { time: 3500n, objectId: "open", collected: 1, evaporated: 0 },
  ]);
  const partial = runChain(world, "weather-partial", 1250n).world;
  const dry = applyCommand(partial, weatherInput(partial, "weather-stop", 0)).world;
  const paused = runChain(dry, "weather-paused", 3000n).world;
  expect(quantityOf(paused.state, "open")).toBe(1);
  const rainy = applyCommand(paused, weatherInput(paused, "weather-start", 10000)).world;
  expect(
    material(runChain(rainy, "weather-resume", 4000n).events).filter(
      (event) => event.objectId === "open",
    ),
  ).toEqual([{ time: 3750n, objectId: "open", collected: 1, evaporated: 0 }]);

  const { resource: _resource, ...carrier } = world.state.entities[0]!;
  const movement = executeWorldKernel(
    movementInput(
      {
        ...template,
        partition: {
          ...template.partition,
          state: createWorldState({
            ...world.state,
            entities: [
              ...world.state.entities,
              { ...carrier, objectId: "carrier" as typeof carrier.objectId },
            ],
          }),
        },
      },
      "movement.start",
      startPayload(
        "carrier",
        {
          kind: "pose",
          pose: { ...carrier.pose, coordinates: [fixedPoint(2000n), fixedPoint(0n)] },
        },
        { observeUntil: 1000n },
      ),
      "weather-movement",
    ),
    { mode: "test" },
  );
  if (!movement.ok) throw new Error(JSON.stringify(movement.error));
  expect(quantityOf(movement.result.state, "open")).toBe(1);
  expect(material(movement.result.events)).toEqual(material(aggregate.events).slice(0, 2));

  const invalid = advanceInput(world, "weather-invalid", 8000n);
  const badPolicy = { ...invalid, pack: structuredClone(invalid.pack) };
  Object.assign(badPolicy.pack.pack.policy.ecology!.waterHolders![0]!, { capacity: 0 });
  expect(executeWorldKernel(badPolicy, { mode: "test" })).toMatchObject({
    ok: false,
    error: { code: "invalid-input", path: "pack.pack.policy.ecology.waterHolders[0].capacity" },
  });
  const forged = aggregate.events.map((event) =>
    event.type === "resource.weather-integrated" && event.payload.collected > 0
      ? { ...event, payload: { ...event.payload, collected: event.payload.collected + 1 } }
      : event,
  );
  expect(
    checkWorldInvariants(
      world.state,
      aggregate.world.state,
      forged,
      "world.advance",
      decoded.pack.policy,
    ),
  ).toMatchObject({ code: "invariant-violated", check: "ecology.state-matches-policy@1" });

  const churn = ecologySample(
    baseSpec({
      actors: [],
      holders: [{ objectId: "churn", kind: "water", quantity: 0 }],
      phases: [["only", 0, "all"]],
      segments: [[10000, 10000, "rain"]],
    }),
  );
  churn.pack.policy.ecology.waterHolders = [
    { objectId: "churn", capacity: 1, catchment: 3600000, evaporationPerHour: 3600000 },
  ];
  churn.initialState.ecology.waterHolders = [
    { objectId: "churn", integratedAt: "0", collectionRemainder: "0", evaporationRemainder: "0" },
  ];
  const churnWorld = await waterWorld(churn);
  const churned = executeWorldKernel(advanceInput(churnWorld, "bounded-churn", 3600000n, 1, 2), {
    mode: "test",
  });
  if (!churned.ok) throw new Error(JSON.stringify(churned.error));
  expect(churned.result.complete).toBe(false);
  expect(churned.result.state.simulationTime).toBe(2n);
  expect(quantityOf(churned.result.state, "churn")).toBe(0);
  expect(material(churned.result.events)).toEqual([
    { time: 1n, objectId: "churn", collected: 1, evaporated: 0 },
    { time: 2n, objectId: "churn", collected: 0, evaporated: 1 },
  ]);

  const arriving = utilitySample({
    ...SNACK_SPEC,
    scripted: [],
    intervalMs: 10000,
    hungerPerInterval: 400,
    wetnessPerInterval: 0,
    segments: [[20000, 10000, "rain"]],
    items: [{ id: "collector", kind: "water", at: [2000, 0], quantity: 0 }],
  });
  arriving.pack.policy.ecology = {
    schemaVersion: 1,
    perishables: [],
    plants: [],
    waterHolders: [{ objectId: "collector", capacity: 1, catchment: 3600, evaporationPerHour: 0 }],
  };
  arriving.initialState.ecology = {
    perishables: [],
    plants: [],
    waterHolders: [
      {
        objectId: "collector",
        integratedAt: "0",
        collectionRemainder: "0",
        evaporationRemainder: "0",
      },
    ],
  };
  const arrivalWorld = await waterWorld(arriving);
  arrivalWorld.state = createWorldState({
    ...arrivalWorld.state,
    entities: arrivalWorld.state.entities.map((entity) =>
      entity.objectId === "resident-x"
        ? { ...entity, selectedAction: { kind: "seek-water", targetObjectId: "collector" } }
        : entity,
    ),
  } as never);
  arrivalWorld.template = {
    ...arrivalWorld.template,
    partition: { ...arrivalWorld.template.partition, state: arrivalWorld.state },
  };
  const moving = applyCommand(
    arrivalWorld,
    movementInput(
      arrivalWorld.template,
      "movement.start",
      startPayload(
        "resident-x",
        {
          kind: "pose",
          pose: {
            ...arrivalWorld.state.entities[0]!.pose,
            coordinates: [fixedPoint(2000n), fixedPoint(0n)],
          },
        },
        { observeUntil: 0n },
      ),
      "arrival-start",
    ) as never,
  ).world;
  const started = {
    ...moving,
    schedules: moving.schedules.map((item) => ({ ...item, dueAt: 10000n as typeof item.dueAt })),
  };
  for (const budget of [4, 5])
    expect(
      executeWorldKernel(advanceInput(started, `arrival-small-${budget}`, 1000n, 1, budget), {
        mode: "test",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-input", path: "payload.maxEvents" } });
  const arrived = executeWorldKernel(advanceInput(started, "arrival-fit", 1000n, 1, 6), {
    mode: "test",
  });
  if (!arrived.ok) throw new Error(JSON.stringify(arrived.error));
  expect(arrived.result.events.map((event) => [event.simulationTime, event.type])).toEqual([
    [1000n, "resource.weather-integrated"],
    [1000n, "needs.changed"],
    [1000n, "wellbeing.integrated"],
    [1000n, "movement.completed"],
    [1000n, "resource.consumed"],
    [1000n, "needs.relieved"],
  ]);
  expect(quantityOf(arrived.result.state, "collector")).toBe(0);
  expect(arrived.result.events.reduce(reduceWorldEvent, started.state)).toEqual(
    arrived.result.state,
  );
});
