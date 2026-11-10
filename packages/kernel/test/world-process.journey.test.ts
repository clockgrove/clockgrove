import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  fixedPoint,
  reduceWorldEvent,
} from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel, type WorldSemanticEvent } from "../src/world.js";
import { SNACK_SPEC, utilitySample, utilityWorld } from "./decisions.scenario.js";
import { baseSpec, ecologySample, quantityOf, resourceCommand } from "./ecology.scenario.js";
import { advanceInput, materialState, runChain, runLive } from "./environment.scenario.js";
import { movementInput, startPayload } from "./spatial.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

async function processWorld(food = false, two = false) {
  const kind = food ? "food" : "water";
  const sample = ecologySample(
    baseSpec({
      actors: [],
      intervalMs: 5000,
      phases: [["day", 0, "bright"]],
      segments: [[10000, 10000, "rain"]],
      holders: [
        { objectId: "tank", kind, quantity: food ? 3 : 0 },
        { objectId: "bowl", kind, quantity: 0 },
      ],
      perishables: food ? [["bowl", 2500]] : [],
    }),
  );
  sample.pack.policy.processes = [
    {
      id: "household",
      principalId: "household-principal",
      firstAtMs: "1000",
      periodMs: "1000",
      command: {
        type: "resource.transfer",
        payload: { schemaVersion: 1, fromObjectId: "tank", toObjectId: "bowl", kind, quantity: 1 },
      },
    },
  ];
  if (two)
    sample.pack.policy.processes.unshift({ ...sample.pack.policy.processes[0], id: "visitor" });
  sample.initialState.processes = sample.pack.policy.processes.map((process: { id: string }) => ({
    processId: process.id,
    nextAt: "1000",
  }));
  if (!food) {
    sample.pack.policy.ecology.waterHolders = [
      { objectId: "tank", capacity: 1, catchment: 3600, evaporationPerHour: 0 },
    ];
    sample.initialState.ecology.waterHolders = [
      { objectId: "tank", collectionRemainder: "0", evaporationRemainder: "0", integratedAt: "0" },
    ];
  }
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
const material = (events: readonly WorldSemanticEvent[]) =>
  events
    .filter(
      (event) =>
        event.type === "process.command-attempted" ||
        event.type === "resource.transferred" ||
        (event.type === "resource.weather-integrated" &&
          (event.payload.collected !== 0 || event.payload.evaporated !== 0)),
    )
    .map((event) => ({
      type: event.type,
      time: event.simulationTime,
      payload: event.payload,
      principal: event.attribution.principalId,
      actor: event.attribution.effectiveActorId,
      cause: event.attribution.immediateCauseId,
    }));

it("executes declared process transfers after same-time weather with journaled identity, replay and advance-shape parity", async () => {
  const world = await processWorld();
  const aggregate = runChain(world, "process-aggregate", 3500n);
  const live = runLive(world, "process-live", 3500n, 250n);
  const bounded = runChain(world, "process-bounded", 3500n, 1024, 5);
  expect(bounded.incomplete).toBeGreaterThan(0);
  for (const run of [live, bounded]) {
    expect(material(run.events)).toEqual(material(aggregate.events));
    expect(materialState(run.world.state)).toEqual(materialState(aggregate.world.state));
  }
  expect(
    aggregate.events
      .filter((event) => event.type === "resource.transferred")
      .map((event) => [
        event.simulationTime,
        event.payload,
        event.attribution.principalId,
        event.attribution.effectiveActorId,
      ]),
  ).toEqual(
    [1000n, 2000n, 3000n].map((time) => [
      time,
      { fromObjectId: "tank", toObjectId: "bowl", kind: "water", quantity: 1 },
      "household-principal",
      "process:household",
    ]),
  );
  expect([
    quantityOf(aggregate.world.state, "tank"),
    quantityOf(aggregate.world.state, "bowl"),
  ]).toEqual([0, 3]);
  expect(aggregate.world.state.processes).toEqual([{ processId: "household", nextAt: 4000n }]);
  expect(aggregate.events.reduce(reduceWorldEvent, world.state)).toEqual(aggregate.world.state);
  expect(runChain(aggregate.world, "again", 3500n).events).toEqual([]);
  const simultaneous = runChain(await processWorld(false, true), "process-tie", 1000n);
  expect(
    simultaneous.events
      .filter((event) => event.type === "process.command-attempted")
      .map((event) => [event.payload.processId, event.payload.refusal]),
  ).toEqual([
    ["household", null],
    [
      "visitor",
      {
        code: "precondition-failed",
        path: "payload.quantity",
        check: "resource.available-and-bounded@1",
      },
    ],
  ]);
  const forged = aggregate.events.map((event) =>
    event.type === "process.command-attempted"
      ? {
          ...event,
          attribution: {
            ...event.attribution,
            principalId: "intruder" as NonNullable<typeof event.attribution.principalId>,
          },
        }
      : event,
  );
  expect(
    checkWorldInvariants(
      world.state,
      aggregate.world.state,
      forged,
      "world.advance",
      world.template.pack.pack.policy,
    ),
  ).toMatchObject({ code: "invariant-violated", check: "process.journaled-commands@1" });
  const jumped = createWorldState({
    ...aggregate.world.state,
    processes: [{ processId: "household", nextAt: 5000n as typeof world.state.simulationTime }],
  });
  expect(
    checkWorldInvariants(
      world.state,
      jumped,
      aggregate.events,
      "world.advance",
      world.template.pack.pack.policy,
    ),
  ).toMatchObject({ check: "process.journaled-commands@1", path: "state.processes" });

  const { resource: _resource, ...carrier } = world.state.entities[0]!;
  const movingState = createWorldState({
    ...world.state,
    entities: [
      ...world.state.entities,
      { ...carrier, objectId: "carrier" as typeof carrier.objectId },
    ],
  });
  const movement = executeWorldKernel(
    movementInput(
      { ...world.template, partition: { ...world.template.partition, state: movingState } },
      "movement.start",
      startPayload(
        "carrier",
        {
          kind: "pose",
          pose: { ...carrier.pose, coordinates: [fixedPoint(2000n), fixedPoint(0n)] },
        },
        { observeUntil: 1000n },
      ),
      "process-movement",
    ),
    { mode: "test" },
  );
  if (!movement.ok) throw new Error(JSON.stringify(movement.error));
  expect(quantityOf(movement.result.state, "bowl")).toBe(1);
  expect(
    movement.result.events.find((event) => event.type === "process.command-attempted")
      ?.simulationTime,
  ).toBe(1000n);
});

it("journals ordinary transfer refusals without granting process authority or repeating an occurrence", async () => {
  const world = await processWorld(true);
  const run = runChain(world, "process-refusal", 4000n);
  const attempts = run.events.filter((event) => event.type === "process.command-attempted");
  const unbackedInitial = createWorldState({
    ...world.state,
    entities: world.state.entities.map((entity) =>
      entity.objectId === "tank"
        ? { ...entity, resource: { ...entity.resource!, quantity: 0 } }
        : entity,
    ),
  });
  expect(
    checkWorldInvariants(
      unbackedInitial,
      run.world.state,
      run.events,
      "world.advance",
      world.template.pack.pack.policy,
    ),
  ).toEqual({
    code: "invariant-violated",
    check: "process.journaled-commands@1",
    path: `events[${run.events.findIndex((event) => event.type === "process.command-attempted")}].payload.refusal`,
  });
  expect(attempts.map((event) => [event.simulationTime, event.payload.refusal])).toEqual([
    [1000n, null],
    [
      2000n,
      {
        code: "precondition-failed",
        path: "payload.toObjectId",
        check: "resource.perishable-single-batch@1",
      },
    ],
    [
      3000n,
      {
        code: "precondition-failed",
        path: "payload.toObjectId",
        check: "resource.perishable-single-batch@1",
      },
    ],
    [4000n, null],
  ]);
  expect([quantityOf(run.world.state, "tank"), quantityOf(run.world.state, "bowl")]).toEqual([
    1, 1,
  ]);
  const forgedRefusal = run.events.map((event) =>
    event.type === "process.command-attempted" && event.simulationTime === 2000n
      ? { ...event, payload: { ...event.payload, refusal: null } }
      : event,
  );
  expect(
    checkWorldInvariants(
      world.state,
      run.world.state,
      forgedRefusal,
      "world.advance",
      world.template.pack.pack.policy,
    ),
  ).toMatchObject({
    check: "process.journaled-commands@1",
    path: expect.stringContaining("payload.refusal"),
  });
  const { resource: _food, ...carrier } = world.state.entities[0]!;
  const movingState = createWorldState({
    ...world.state,
    entities: [
      ...world.state.entities,
      { ...carrier, objectId: "carrier" as typeof carrier.objectId },
    ],
  });
  const moved = executeWorldKernel(
    movementInput(
      { ...world.template, partition: { ...world.template.partition, state: movingState } },
      "movement.start",
      startPayload(
        "carrier",
        {
          kind: "pose",
          pose: { ...carrier.pose, coordinates: [fixedPoint(8000n), fixedPoint(0n)] },
        },
        { observeUntil: 4000n },
      ),
      "process-food-movement",
    ),
    { mode: "test" },
  );
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  expect(
    moved.result.events
      .filter((event) => event.type === "resource.spoiled")
      .map((event) => event.simulationTime),
  ).toEqual([3500n]);
  expect(quantityOf(moved.result.state, "bowl")).toBe(1);

  const empty = {
    ...world,
    state: createWorldState({
      ...world.state,
      entities: world.state.entities.map((entity) =>
        entity.objectId === "tank"
          ? { ...entity, resource: { kind: "food" as const, quantity: 0 } }
          : entity,
      ),
    }),
  };
  const ordinary = executeWorldKernel(
    resourceCommand(
      empty,
      "resource.transfer",
      { fromObjectId: "tank", toObjectId: "bowl", kind: "food", quantity: 1 },
      "ordinary-empty",
    ),
  );
  const refused = runChain(empty, "process-empty", 1000n);
  expect(ordinary).toMatchObject({
    ok: false,
    error: {
      code: "precondition-failed",
      path: "payload.quantity",
      check: "resource.available-and-bounded@1",
    },
  });
  expect(
    refused.events.find((event) => event.type === "process.command-attempted")?.payload,
  ).toMatchObject({ refusal: ordinary.ok ? null : ordinary.error });
  expect(runChain(refused.world, "empty-again", 1000n).events).toEqual([]);
  const malformed = advanceInput(world, "bad-process", 1000n);
  expect(
    executeWorldKernel({
      ...malformed,
      pack: {
        ...malformed.pack,
        pack: {
          ...malformed.pack.pack,
          policy: {
            ...malformed.pack.pack.policy,
            processes: [
              {
                ...malformed.pack.pack.policy.processes![0]!,
                command: { type: "resource.offer", payload: {} },
              },
            ],
          },
        },
      },
    } as never),
  ).toMatchObject({
    ok: false,
    error: { code: "invalid-input", path: "pack.pack.policy.processes[0].command.type" },
  });
});

it("journals exact ordinary refusals during a utility actor's manual movement without aborting the outer command", async () => {
  const sample = utilitySample({ ...SNACK_SPEC, intervalMs: 2000, scripted: [] });
  sample.pack.policy.processes = [
    {
      id: "household",
      principalId: "household-principal",
      firstAtMs: "500",
      periodMs: "1000",
      command: {
        type: "resource.transfer",
        payload: {
          schemaVersion: 1,
          fromObjectId: "trash-bin",
          toObjectId: "snack-house",
          kind: "food",
          quantity: 1,
        },
      },
    },
  ];
  sample.initialState.processes = [{ processId: "household", nextAt: "500" }];
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
  const actor = initialState.entities.find((entry) => entry.objectId === "resident-x")!;
  const held = {
    ...template,
    schedules: template.schedules.map((item) => ({ ...item, dueAt: 1000n as typeof item.dueAt })),
  };
  const moving = executeWorldKernel(
    movementInput(
      held,
      "movement.start",
      startPayload(
        "resident-x",
        {
          kind: "pose",
          pose: { ...actor.pose, coordinates: [fixedPoint(2000n), fixedPoint(0n)] },
        },
        { unitsPerSecond: fixedPoint(1000n) },
      ),
      "manual-process-walk",
    ),
    { mode: "test" },
  );
  if (!moving.ok) throw new Error(JSON.stringify(moving.error));
  const actorIndex = initialState.entities.findIndex((entry) => entry.objectId === "resident-x");
  const denied = {
    code: "precondition-failed",
    check: "utility.plan-matches-action@1",
    path: `state.entities[${actorIndex}].movement`,
  };
  expect(
    moving.result.events
      .filter((event) => event.type === "process.command-attempted")
      .map((event) => [event.simulationTime, event.payload.refusal]),
  ).toEqual([
    [500n, denied],
    [1500n, denied],
  ]);
  expect(moving.result.events.filter((event) => event.type === "resource.transferred")).toEqual([]);
  expect(quantityOf(moving.result.state, "trash-bin")).toBe(20);
  expect(quantityOf(moving.result.state, "snack-house")).toBe(6);
  expect(moving.result.state.simulationTime).toBe(2000n);
  expect(moving.result.state.processes).toEqual([{ processId: "household", nextAt: 2500n }]);
  let replayed = initialState;
  for (const event of moving.result.events) {
    if (event.type === "process.command-attempted") {
      const at = createWorldState({ ...replayed, simulationTime: event.simulationTime });
      const ordinary = executeWorldKernel(
        resourceCommand(
          { template, state: at, schedules: held.schedules },
          "resource.transfer",
          sample.pack.policy.processes[0].command.payload,
          "ordinary-during-move",
        ),
        { mode: "test" },
      );
      expect(ordinary.ok ? null : ordinary.error).toEqual(event.payload.refusal);
    }
    replayed = reduceWorldEvent(replayed, event);
  }
  expect(replayed).toEqual(moving.result.state);
});

it("does not retain speculative decision deadlines past a shelter arrival in aggregate advances", async () => {
  let world = await utilityWorld({
    ...SNACK_SPEC,
    scripted: [],
    intervalMs: 5000,
    wetnessPerInterval: 10000,
    segments: [[20000, 10000, "rain"]],
    items: [{ id: "shelter", kind: "shelter", at: [2000, 0], protection: 10000 }],
  });
  world = {
    ...world,
    state: createWorldState({
      ...world.state,
      entities: world.state.entities.map((entity) =>
        entity.needs === undefined
          ? entity
          : { ...entity, needs: { ...entity.needs, wetness: 3000 } },
      ),
    }),
  };
  const aggregate = runChain(world, "arrival-aggregate", 11000n);
  const live = runLive(world, "arrival-live", 11000n, 250n);
  expect(materialState(aggregate.world.state)).toEqual(materialState(live.world.state));
  expect(aggregate.world.schedules).toEqual(live.world.schedules);
  expect(aggregate.events.filter((event) => event.type === "comfort.changed")).toEqual([]);
  expect(aggregate.world.schedules.map((item) => item.dueAt)).toEqual([15000n]);
});
