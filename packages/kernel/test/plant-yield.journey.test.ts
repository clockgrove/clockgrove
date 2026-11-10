import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  fixedPoint,
  reduceWorldEvent,
} from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel } from "../src/world.js";
import {
  baseSpec,
  ecologyMaterial,
  ecologyMaterialState,
  ecologySample,
  quantityOf,
} from "./ecology.scenario.js";
import { advanceInput, runChain, runLive } from "./environment.scenario.js";
import { movementInput, startPayload } from "./spatial.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

it("journals finite plant-stage food yield at its growth instant across live, aggregate and replay", async () => {
  const sample = ecologySample(
    baseSpec({
      actors: [],
      phases: [["day", 0, "bright"]],
      segments: [[10000, 10000, "mild"]],
      plants: [
        {
          objectId: "fruit-plant",
          bands: ["bright"],
          stages: [
            ["growing", 0],
            ["fruiting", 1000],
            ["ripe", 2000],
          ],
          protection: null,
        },
      ],
    }),
  );
  sample.pack.policy.ecology.plants[0].stages[1].yield = { quantity: 3 };
  sample.pack.policy.ecology.plants[0].stages[2].yield = { quantity: 5 };
  sample.initialState.entities[0].resource = { kind: "food", quantity: 2 };
  sample.initialState.ecology.plants[0].wetness = 10000;
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
  const world = { template, state: template.partition.state, schedules: template.schedules };
  const aggregate = runChain(world, "yield-aggregate", 3000n);
  const live = runLive(world, "yield-live", 3000n, 250n);
  const bounded = runChain(world, "yield-bounded", 3000n, 1, 3);
  expect(ecologyMaterial(aggregate.events)).toEqual([
    {
      type: "growth.stage-changed",
      time: 1000n,
      payload: {
        objectId: "fruit-plant",
        stageIndex: 1,
        stageName: "fruiting",
        yield: { quantity: 3 },
      },
    },
    {
      type: "growth.stage-changed",
      time: 2000n,
      payload: {
        objectId: "fruit-plant",
        stageIndex: 2,
        stageName: "ripe",
        yield: { quantity: 5 },
      },
    },
  ]);
  expect(ecologyMaterial(live.events)).toEqual(ecologyMaterial(aggregate.events));
  expect(ecologyMaterial(bounded.events)).toEqual(ecologyMaterial(aggregate.events));
  expect(aggregate.world.state.entities[0]!.resource).toEqual({ kind: "food", quantity: 10 });
  expect(ecologyMaterialState(live.world.state)).toEqual(
    ecologyMaterialState(aggregate.world.state),
  );
  expect(ecologyMaterialState(bounded.world.state)).toEqual(
    ecologyMaterialState(aggregate.world.state),
  );
  expect(aggregate.events.reduce(reduceWorldEvent, world.state)).toEqual(aggregate.world.state);
  expect(runChain(aggregate.world, "yield-again", 3000n).events).toEqual([]);
  expect(
    runChain(aggregate.world, "yield-no-refill", 5000n).world.state.entities[0]!.resource!.quantity,
  ).toBe(10);

  const { resource: _resource, ...carrier } = world.state.entities[0]!;
  const movementWorld = {
    ...world,
    state: createWorldState({
      ...world.state,
      entities: [
        ...world.state.entities,
        { ...carrier, objectId: "carrier" as typeof carrier.objectId },
      ],
    }),
  };
  const movement = executeWorldKernel(
    movementInput(
      {
        ...template,
        partition: {
          ...template.partition,
          state: movementWorld.state,
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
      "yield-movement",
    ),
    { mode: "test" },
  );
  if (!movement.ok) throw new Error(JSON.stringify(movement.error));
  expect(quantityOf(movement.result.state, "fruit-plant")).toBe(5);
  expect(ecologyMaterial(movement.result.events)).toEqual(
    ecologyMaterial(aggregate.events).slice(0, 1),
  );

  const badInput = advanceInput(world, "invalid-yield", 3000n);
  const badQuantity = { ...badInput, pack: structuredClone(badInput.pack) };
  Object.assign(badQuantity.pack.pack.policy.ecology!.plants[0]!.stages[1]!, {
    yield: { quantity: 0 },
  });
  expect(executeWorldKernel(badQuantity, { mode: "test" })).toMatchObject({
    ok: false,
    error: {
      code: "invalid-input",
      path: "pack.pack.policy.ecology.plants[0].stages[1].yield.quantity",
    },
  });
  Object.assign(badQuantity.pack.pack.policy.ecology!.plants[0]!.stages[1]!, {
    yield: { quantity: Number.MAX_SAFE_INTEGER },
  });
  expect(executeWorldKernel(badQuantity, { mode: "test" })).toMatchObject({
    ok: false,
    error: {
      code: "invalid-input",
      path: "pack.pack.policy.ecology.plants[0].stages[2].yield.quantity",
    },
  });
  const overflow = {
    ...world,
    state: createWorldState({
      ...world.state,
      entities: world.state.entities.map((entity) => ({
        ...entity,
        resource: { kind: "food", quantity: Number.MAX_SAFE_INTEGER },
      })),
    }),
  };
  expect(
    executeWorldKernel(advanceInput(overflow, "overflow-yield", 3000n), { mode: "test" }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "precondition-failed",
      check: "ecology.state-matches-policy@1",
      path: "state.ecology.plants[0].stage",
    },
  });
  const missingHolder = {
    ...world,
    state: createWorldState({
      ...world.state,
      entities: world.state.entities.map(({ resource: _resource, ...entity }) => entity),
    }),
  };
  expect(
    executeWorldKernel(advanceInput(missingHolder, "missing-holder", 3000n), { mode: "test" }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "precondition-failed",
      check: "ecology.state-matches-policy@1",
      path: "policy.ecology.plants[0].objectId",
    },
  });
  const yieldEvent = aggregate.events.find((event) => event.type === "growth.stage-changed")!;
  if (yieldEvent.type !== "growth.stage-changed") throw new Error("missing yield");
  const forged = aggregate.events.map((event) =>
    event === yieldEvent
      ? { ...event, payload: { ...event.payload, yield: { quantity: 4 } } }
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
  ).toEqual({
    code: "invariant-violated",
    check: "ecology.state-matches-policy@1",
    path: "events[1].payload.yield",
  });
});
