import type { ObjectId } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  initialBoundaryExchanges,
  reduceWorldEvent,
} from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel } from "../src/world.js";
import { containmentInput } from "./containment.scenario.js";
import {
  advanceInput,
  type EnvironmentWorld,
  materialState,
  runChain,
  runLive,
} from "./environment.scenario.js";
import { scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";

async function boundaryWorld(): Promise<EnvironmentWorld> {
  const decoded = decodeWorldScenario(scenarios.weather, await stateHash(scenarios.weather));
  const boundaryExchanges = [
    {
      id: "bins",
      name: "Neighbour's bins",
      kind: "food" as const,
      supply: 3,
      absorb: 2,
      actorIds: ["subject"],
    },
  ];
  const pack = { ...decoded.pack, policy: { ...decoded.pack.policy, boundaryExchanges } };
  const actor = decoded.initialState.entities.find((entity) => entity.objectId === "subject")!;
  const state = createWorldState({
    ...decoded.initialState,
    boundaryExchanges: initialBoundaryExchanges(boundaryExchanges),
    entities: [
      ...decoded.initialState.entities.map((entity) =>
        entity === actor
          ? { ...entity, containment: { kind: "persona-inventory" as const, capacity: 2 } }
          : entity,
      ),
      {
        objectId: "bag" as ObjectId,
        archetypeId: actor.archetypeId,
        spaceId: actor.spaceId,
        pose: actor.pose,
        resource: { kind: "food", quantity: 0 },
        containment: { kind: "object", capacity: 1, containerId: actor.objectId },
      },
      {
        objectId: "distant-bowl" as ObjectId,
        archetypeId: actor.archetypeId,
        spaceId: actor.spaceId,
        pose: actor.pose,
        resource: { kind: "food", quantity: 0 },
      },
    ],
  });
  const template = await scenarioInput(undefined, 0, 32, {}, 32, { pack, initialState: state });
  return { template, state, schedules: template.schedules };
}
const payload = {
  schemaVersion: 1 as const,
  boundaryId: "bins",
  actorId: "subject",
  objectId: "bag",
  direction: "import" as const,
  kind: "food" as const,
  quantity: 2,
};
function exchangeInput(world: EnvironmentWorld, changes = {}, actor = "subject") {
  const attribution = { ...world.template.attribution, effectiveActorId: actor };
  const { authorityDecisionId: _authority, ...intent } = attribution;
  const base = {
    ...world.template,
    partition: { ...world.template.partition, state: world.state, revision: world.state.revision },
    simulationTime: world.state.simulationTime,
    schedules: world.schedules,
    attribution,
  };
  const input = containmentInput(base, "boundary.exchange", { ...payload, ...changes });
  if (input.input.kind !== "command") throw new Error("command required");
  return {
    ...input,
    input: { ...input.input, command: { ...input.input.command, attribution: intent } },
  };
}
function exchange(world: EnvironmentWorld, changes = {}) {
  const result = executeWorldKernel(exchangeInput(world, changes), { mode: "test" });
  if (!result.ok)
    throw new Error(`${result.error.code} ${result.error.path} ${result.error.check}`);
  return {
    world: { ...world, state: result.result.state, schedules: result.result.schedules },
    events: result.result.events,
  };
}
const food = (world: EnvironmentWorld) =>
  world.state.entities.find((entity) => entity.objectId === "bag")!.resource!.quantity;

it("journals a finite carried boundary import/export with literal actor, source, time and replay", async () => {
  const initial = await boundaryWorld();
  const imported = exchange(initial);
  expect(
    imported.events.map((event) => [
      event.type,
      event.simulationTime,
      event.attribution.effectiveActorId,
    ]),
  ).toEqual([
    ["boundary.departed", 0n, "subject"],
    ["resource.boundary-exchanged", 0n, "subject"],
    ["boundary.returned", 0n, "subject"],
  ]);
  expect(imported.events[1]!.payload).toEqual({
    boundaryId: "bins",
    boundaryName: "Neighbour's bins",
    actorId: "subject",
    objectId: "bag",
    kind: "food",
    direction: "import",
    quantity: 2,
  });
  expect(food(imported.world)).toBe(2);
  expect(imported.world.state.boundaryExchanges).toEqual([
    { boundaryId: "bins", supplyRemaining: 1, absorbRemaining: 2 },
  ]);
  const exported = exchange(imported.world, { direction: "export", quantity: 1 });
  expect(food(exported.world)).toBe(1);
  expect(exported.world.state.boundaryExchanges).toEqual([
    { boundaryId: "bins", supplyRemaining: 1, absorbRemaining: 1 },
  ]);
  const depleted = exchange(exported.world, { quantity: 1 });
  const exportedAgain = exchange(depleted.world, { direction: "export", quantity: 1 });
  expect(food(exportedAgain.world)).toBe(1);
  for (const direction of ["import", "export"])
    expect(
      executeWorldKernel(exchangeInput(exportedAgain.world, { direction, quantity: 1 }), {
        mode: "test",
      }),
    ).toMatchObject({
      ok: false,
      error: { check: "boundary.exchange@1", path: "payload.quantity" },
    });
  const events = [
    ...imported.events,
    ...exported.events,
    ...depleted.events,
    ...exportedAgain.events,
  ];
  expect(events.reduce(reduceWorldEvent, initial.state)).toEqual(exportedAgain.world.state);
  expect(
    exportedAgain.world.state.entities.find((entity) => entity.objectId === "subject")!.pose,
  ).toEqual(initial.state.entities.find((entity) => entity.objectId === "subject")!.pose);
  for (const [changes, actor, path] of [
    [{ boundaryId: "unknown" }, "subject", "payload.boundaryId"],
    [{ objectId: "distant-bowl" }, "subject", "payload.objectId"],
    [{}, "imposter", "attribution.effectiveActorId"],
    [{ actorId: "distant-bowl" }, "subject", "payload.actorId"],
    [{ kind: "water" }, "subject", "payload.kind"],
  ] as const)
    expect(
      executeWorldKernel(exchangeInput(initial, changes, actor), { mode: "test" }),
    ).toMatchObject({ ok: false, error: { check: "boundary.exchange@1", path } });
  const forged = imported.events.map((event) =>
    event.type === "resource.boundary-exchanged"
      ? { ...event, payload: { ...event.payload, boundaryName: "forged" } }
      : event,
  );
  expect(
    checkWorldInvariants(
      initial.state,
      imported.world.state,
      forged,
      "boundary.exchange",
      initial.template.pack.pack.policy,
      payload,
    ),
  ).toMatchObject({ check: "boundary.journaled-exchange@1" });
  expect(
    checkWorldInvariants(
      initial.state,
      { ...imported.world.state, boundaryExchanges: initial.state.boundaryExchanges! },
      imported.events,
      "boundary.exchange",
      initial.template.pack.pack.policy,
      payload,
    ),
  ).toMatchObject({ check: "boundary.journaled-exchange@1" });
  const tight = { ...initial.template.pack.pack.policy };
  delete tight.boundaryExchanges;
  const tightState = { ...initial.state };
  delete tightState.boundaryExchanges;
  const tightWorld = {
    ...initial,
    state: tightState,
    template: {
      ...initial.template,
      pack: { ...initial.template.pack, pack: { ...initial.template.pack.pack, policy: tight } },
      policies: { ...initial.template.policies, policy: tight },
    },
  };
  expect(executeWorldKernel(exchangeInput(tightWorld), { mode: "test" })).toMatchObject({
    ok: false,
    error: { path: "payload.boundaryId" },
  });
});

it("preserves finite boundary causes across live, fast-forward and journal replay", async () => {
  const initial = await boundaryWorld();
  const aggregate = runChain(initial, "boundary-fast", 1000n);
  const live = runLive(initial, "boundary-live", 1000n, 250n);
  const imported = [aggregate, live].map((run) => exchange(run.world));
  expect(
    imported[0]!.events.map(({ type, simulationTime, payload }) => ({
      type,
      simulationTime,
      payload,
    })),
  ).toEqual(
    imported[1]!.events.map(({ type, simulationTime, payload }) => ({
      type,
      simulationTime,
      payload,
    })),
  );
  expect(imported[0]!.events[1]!.simulationTime).toBe(1000n);
  const ends = imported.map((run) => runChain(run.world, "boundary-end", 2000n));
  expect(materialState(ends[0]!.world.state)).toEqual(materialState(ends[1]!.world.state));
  expect(food(ends[0]!.world)).toBe(2);
  expect(
    [...aggregate.events, ...imported[0]!.events, ...ends[0]!.events].reduce(
      reduceWorldEvent,
      initial.state,
    ),
  ).toEqual(ends[0]!.world.state);
  const malformed = structuredClone(scenarios.weather) as unknown as Record<string, unknown>;
  const pack = malformed.pack as { policy: Record<string, unknown> };
  pack.policy.boundaryExchanges = [
    { id: "unlimited", name: "No quota", kind: "food", actorIds: ["subject"], absorb: 0 },
  ];
  expect(() => decodeWorldScenario(malformed, "a".repeat(64))).toThrow("invalid boundary exchange");
  expect(
    executeWorldKernel(advanceInput(ends[0]!.world, "no-refill", 3000n), { mode: "test" }).ok,
  ).toBe(true);
});
