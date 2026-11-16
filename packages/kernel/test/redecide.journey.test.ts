import { expect, it } from "vitest";
import { food, utilityWorld, WITH } from "./decisions.scenario.js";
import { runChain } from "./environment.scenario.js";

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
