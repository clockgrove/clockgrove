import { createWorldState } from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel } from "../src/world.js";
import {
  containmentFixture,
  containmentInput,
  withFixtureInventory,
} from "./containment.scenario.js";

it("accounts each holder and resource kind against the native command journal", async () => {
  let current = withFixtureInventory(await containmentFixture(), [
    { objectId: "food-a", kind: "food", quantity: 8 },
    { objectId: "food-b", kind: "food", quantity: 2 },
    { objectId: "water", kind: "water", quantity: 8 },
  ]);
  let commandIndex = 0;
  const run = (type: string, payload: unknown) => {
    const input = containmentInput(current, type, payload, `accounting-${commandIndex++}`);
    const outcome = executeWorldKernel(input, { mode: "test" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.code);
    current = {
      ...current,
      partition: {
        ...current.partition,
        state: outcome.result.state,
        revision: outcome.result.state.revision,
      },
      schedules: outcome.result.schedules,
      simulationTime: outcome.result.state.simulationTime,
    };
    return outcome.result;
  };
  const initial = current.partition.state;
  const transfer = run("resource.transfer", {
    schemaVersion: 1,
    fromObjectId: "food-a",
    toObjectId: "food-b",
    kind: "food",
    quantity: 3,
  });
  expect(transfer.state.entities.map((entity) => entity.resource?.quantity)).toEqual([5, 5, 8]);
  expect(
    checkWorldInvariants(initial, transfer.state, transfer.events, "resource.transfer"),
  ).toBeUndefined();
  expect(checkWorldInvariants(initial, transfer.state, [], "resource.transfer")).toEqual({
    code: "invariant-violated",
    check: "resource.quantity-conservation@1",
    path: "state.entities[0].resource.quantity",
  });
  const forged = createWorldState({
    ...transfer.state,
    entities: transfer.state.entities.map((entity) => ({
      ...entity,
      resource: {
        ...entity.resource!,
        quantity: entity.objectId === "food-a" ? 4 : entity.objectId === "food-b" ? 6 : 8,
      },
    })),
  });
  expect(checkWorldInvariants(initial, forged, transfer.events, "resource.transfer")).toEqual({
    code: "invariant-violated",
    check: "resource.quantity-conservation@1",
    path: "state.entities[0].resource.quantity",
  });
  const swapped = createWorldState({
    ...initial,
    entities: initial.entities.map((entity) =>
      entity.objectId === "food-b"
        ? entity
        : {
            ...entity,
            resource: {
              ...entity.resource!,
              kind: entity.resource!.kind === "food" ? "water" : "food",
            },
          },
    ),
  });
  expect(checkWorldInvariants(initial, swapped, [])).toEqual({
    code: "invariant-violated",
    check: "resource.quantity-conservation@1",
    path: "state.entities[0].resource.quantity",
  });
  run("resource.consume", { schemaVersion: 1, objectId: "food-b", kind: "food", quantity: 1 });
  run("object.retire", { schemaVersion: 1, objectId: "water", disposition: "discard" });
  expect(current.partition.state.entities.map((entity) => entity.resource?.quantity)).toEqual([
    5, 4, 0,
  ]);
});
