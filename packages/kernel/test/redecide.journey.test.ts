import { expect, it } from "vitest";
import { food, utilityWorld, WITH } from "./decisions.scenario.js";
import {
  applyCommand,
  commandInput,
  environmentWorld,
  GOLDEN_SPEC,
  runChain,
} from "./environment.scenario.js";

it("re-decides at the instant the food its actor walks toward is eaten, not a decision interval later", async () => {
  const world = await utilityWorld(
    WITH({
      intervalMs: 10000,
      actors: [
        ["a-weather", null],
        ["b-weather", null],
      ],
      starts: [
        [0, 0],
        [1000, 0],
      ],
      items: [food("bin", [2000, 0], 1)],
    }),
  );
  const run = runChain(world, "redecide", 3000n);
  const journal = run.events
    .filter((event) =>
      [
        "routine.selected",
        "resource.consumed",
        "movement.completed",
        "movement.interrupted",
      ].includes(event.type),
    )
    .map((event) => [
      event.simulationTime,
      event.type,
      (event.payload as { objectId: string }).objectId,
      (event.payload as { action?: { kind: string } }).action?.kind,
    ]);
  expect(journal).toEqual([
    [0n, "routine.selected", "a-weather", "seek-food"],
    [0n, "routine.selected", "b-weather", "seek-food"],
    [500n, "movement.completed", "b-weather", undefined],
    [500n, "resource.consumed", "bin", undefined],
    [500n, "routine.selected", "a-weather", "stay"],
    [500n, "movement.interrupted", "a-weather", undefined],
  ]);
});

it("keeps advancing a rule-based policy once a shelter an actor selected is retired", async () => {
  const before = runChain(await environmentWorld(GOLDEN_SPEC), "to-9500", 9500n).world;
  const retire = commandInput(before, "object.retire" as "world.advance", "retire-shelter", {
    objectId: "shelter-10000",
    disposition: "discard",
  });
  const retired = applyCommand(before, retire);
  expect(retired.events.map((event) => event.type)).toContain("object.retired");
  const run = runChain(retired.world, "after-retire", 12000n);
  expect(run.world.state.simulationTime).toBe(12000n);
  const sheltered = run.events
    .filter((event) => event.type === "routine.selected")
    .map((event) => (event.payload as { action: { targetObjectId?: string } }).action)
    .filter((action) => action.targetObjectId === "shelter-10000");
  expect(sheltered).toEqual([]);
});
