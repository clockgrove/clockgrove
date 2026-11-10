import { reduceWorldEvent } from "@clockgrove/domain";
import { expect, it } from "vitest";
import { checkWorldInvariants, executeWorldKernel } from "../src/world.js";
import {
  containmentFixture,
  containmentInput,
  fixturePayload,
  withFixtureInventory,
} from "./containment.scenario.js";

it("refuses unbacked runtime inventory and legacy source packs", async () => {
  const world = withFixtureInventory(await containmentFixture(), [
    { objectId: "store", kind: "food", quantity: 3 },
    { objectId: "bowl", kind: "food", quantity: 0 },
  ]);
  for (const [type, payload, path] of [
    [
      "resource.offer",
      { schemaVersion: 1, objectId: "bowl", kind: "food", quantity: 1 },
      "payload.quantity",
    ],
    [
      "object.create",
      fixturePayload(world, "unbacked", { kind: "water", quantity: 1 }),
      "payload.object.resource.quantity",
    ],
  ] as const) {
    expect(
      executeWorldKernel(containmentInput(world, type, payload), { mode: "test" }),
    ).toMatchObject({
      ok: false,
      error: { code: "precondition-failed", check: "resource.closed-world@1", path },
    });
  }
  const empty = executeWorldKernel(
    containmentInput(
      world,
      "object.create",
      fixturePayload(world, "empty", { kind: "food", quantity: 0 }),
    ),
    { mode: "test" },
  );
  if (!empty.ok) throw new Error(empty.error.code);
  const event = empty.result.events[0]!;
  const historic = {
    ...event,
    type: "resource.offered",
    payload: { objectId: "bowl", kind: "food", quantity: 2 },
  };
  expect(
    reduceWorldEvent(world.partition.state, historic as never).entities.map(
      (entity) => entity.resource?.quantity,
    ),
  ).toEqual([2, 3]);
  const created = {
    ...event,
    type: "object.created",
    payload: { object: world.partition.state.entities[1]!, quantityAdded: 3 },
  };
  for (const forged of [created, historic, { ...historic, type: "resource.appeared" }]) {
    expect(
      checkWorldInvariants(world.partition.state, empty.result.state, [forged] as never),
    ).toEqual({
      code: "invariant-violated",
      check: "resource.closed-world@1",
      path: "events[0].type",
    });
  }
  const policy = {
    ...world.pack.pack.policy,
    ecology: { schemaVersion: 1, sources: [], perishables: [], plants: [] },
  };
  const legacy = { ...world, pack: { ...world.pack, pack: { ...world.pack.pack, policy } } };
  expect(executeWorldKernel(legacy as never, { mode: "test" })).toMatchObject({
    ok: false,
    error: { code: "invalid-input", path: "pack.pack.policy.ecology.sources" },
  });
});
