import type { CommandId } from "@clockgrove/contracts";
import {
  type ContainmentCommand,
  createWorldState,
  replayWorldEvents,
  type WorldEvent,
  type WorldState,
} from "@clockgrove/domain";
import { canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { drawNamedRandomStream, initializeNamedRandomStreams } from "../src/random.js";
import {
  type ContainmentKernelInput,
  checkWorldInvariants,
  executeWorldKernel,
  type WorldKernelInput,
  worldRegistryIdentity,
  worldResourceTotals,
} from "../src/world.js";
import { assertEnvelope } from "./executor.scenario.js";
import { scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";

export const containmentSeed = { version: 1, seed: "containment-conservation-v1" } as const;
const streams = ["behavior", "containment", "lifecycle", "weather"];

/** Lossless tagged evidence only; canonical v1 deliberately cannot encode fractional numbers.
 * Every node is tagged so a user record/string can never collide with a numeric escape.
 * The evidence hashes this declared representation using the unchanged canonical v1 encoder.
 */
function malformedNode(value: unknown): unknown {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array", value.map(malformedNode)];
  if (typeof value === "object")
    return [
      "record",
      Object.keys(value)
        .sort()
        .map((key) => [key, malformedNode((value as Record<string, unknown>)[key])]),
    ];
  return [typeof value, typeof value === "number" && Object.is(value, -0) ? "-0" : String(value)];
}
export async function containmentInputIdentity(value: unknown) {
  try {
    return { encoding: "clockgrove-canonical-v1", inputHash: await stateHash(value) };
  } catch {
    const representation = {
      encoding: "clockgrove-malformed-input-v1",
      value: malformedNode(value),
    };
    return {
      encoding: representation.encoding,
      canonicalInput: canonicalSerialize(representation),
      inputHash: await stateHash(representation),
    };
  }
}
function equal(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return;
  if (canonicalSerialize(actual) !== canonicalSerialize(expected))
    throw new Error(`containment assertion failed: ${canonicalSerialize([actual, expected])}`);
}
function totals(state: WorldState) {
  return Object.fromEntries(
    Object.entries(worldResourceTotals(state)).map(([kind, quantity]) => [
      kind,
      quantity.toString(),
    ]),
  );
}
export function assertPhysical(state: WorldState): void {
  const ids = new Set(state.entities.map((entity) => entity.objectId));
  equal(ids.size, state.entities.length);
  for (const entity of state.entities) {
    if (!entity.spaceId) throw new Error("object has no physical space");
    const visited = new Set<string>([entity.objectId]);
    let current = entity;
    while (current.containment?.containerId !== undefined) {
      const parent = state.entities.find(
        (candidate) => candidate.objectId === current.containment!.containerId,
      );
      if (
        parent === undefined ||
        visited.has(parent.objectId) ||
        parent.spaceId !== entity.spaceId ||
        (parent.lifecycle?.status ?? "active") !== "active"
      )
        throw new Error("invalid containment chain");
      visited.add(parent.objectId);
      current = parent;
    }
    const contents = state.entities.filter(
      (candidate) => candidate.containment?.containerId === entity.objectId,
    );
    if (contents.length > (entity.containment?.capacity ?? 0)) throw new Error("capacity exceeded");
    if (
      (entity.lifecycle?.status ?? "active") !== "active" &&
      contents.some((child) => (child.lifecycle?.status ?? "active") === "active")
    )
      throw new Error("inactive container has active contents");
    if (
      entity.resource !== undefined &&
      (!Number.isSafeInteger(entity.resource.quantity) || entity.resource.quantity < 0)
    )
      throw new Error("invalid material quantity");
  }
}
function deltas(events: readonly WorldEvent[]) {
  const result: Record<string, bigint> = { food: 0n, water: 0n };
  for (const event of events) {
    switch (event.type) {
      case "object.created":
        if (event.payload.object.resource)
          result[event.payload.object.resource.kind]! += BigInt(event.payload.quantityAdded);
        break;
      case "object.retired":
        if (event.payload.kind !== null)
          result[event.payload.kind]! -= BigInt(event.payload.quantityRemoved);
        break;
      case "resource.offered":
        result[event.payload.kind]! += BigInt(event.payload.quantity);
        break;
      case "resource.consumed":
        result[event.payload.kind]! -= BigInt(event.payload.quantity);
        break;
    }
  }
  return result;
}
export async function containmentFixture(): Promise<WorldKernelInput> {
  const base = await scenarioInput(scenarios.weather);
  const state = createWorldState({ ...base.partition.state, entities: [] });
  const pack = {
    ...base.pack.pack,
    archetypes: [...base.pack.pack.archetypes, "fixture.object@1"],
  };
  return {
    ...base,
    partition: { ...base.partition, state },
    schedules: [],
    pack: { ...base.pack, pack: { ...pack, contentHash: await stateHash(pack) } },
    randomState: initializeNamedRandomStreams(containmentSeed, streams),
  };
}
export function containmentInput(
  base: WorldKernelInput,
  type: string,
  payload: unknown,
  id = "containment-test",
): ContainmentKernelInput {
  if (base.input.kind !== "command") throw new Error("command fixture required");
  const command = {
    ...base.input.command,
    type,
    commandId: id as CommandId,
    expected: { partitionRevision: base.partition.revision },
    payload,
  } as ContainmentCommand;
  return {
    ...base,
    input: { kind: "command", command },
    ids: createDeterministicIdSource({
      commandId: command.commandId,
      eventIndex: 0,
      randomStream: "containment",
    }),
  };
}
export function fixturePayload(
  base: WorldKernelInput,
  objectId: string,
  resource?: { kind: "food" | "water"; quantity: number },
  capacity = 2,
  kind: "object" | "persona-inventory" = "object",
) {
  return {
    schemaVersion: 1,
    object: {
      objectId,
      archetypeId: "fixture.object@1",
      spatial: {
        spaceId: "fixture-space",
        pose: {
          frameId: base.partition.state.spatialFrames[0]!.frameId,
          frameVersion: 1,
          coordinates: [0n, 0n],
        },
      },
      containment: { kind, capacity },
      ...(resource ? { resource } : {}),
    },
  };
}

/** Declared genesis inventory, before commands begin. */
export function withFixtureInventory(
  base: WorldKernelInput,
  holders: readonly { objectId: string; kind: "food" | "water"; quantity: number }[],
): WorldKernelInput {
  const state = createWorldState({
    ...base.partition.state,
    entities: [
      ...base.partition.state.entities,
      ...holders.map(({ objectId, kind, quantity }) => {
        const { spatial, ...object } = fixturePayload(base, objectId, { kind, quantity }).object;
        return { ...object, ...spatial, lifecycle: { status: "active" as const } };
      }),
    ],
  } as never);
  return { ...base, partition: { ...base.partition, state } };
}

export async function containmentEvidence(steps = 48) {
  let current = withFixtureInventory(await containmentFixture(), [
    { objectId: "food-a", kind: "food", quantity: 10 },
    { objectId: "food-b", kind: "food", quantity: 10 },
    { objectId: "water", kind: "water", quantity: 2 },
  ]);
  const entries: {
    label: string;
    input: Awaited<ReturnType<typeof containmentInputIdentity>> & {
      type: string | null;
      version: number | null;
      commandId: string;
      preStateHash: string;
      randomStateHash: string;
    };
    output: {
      kind: string;
      postStateHash: string;
      resourceTotalsBefore: Record<string, string>;
      resourceTotalsAfter: Record<string, string>;
      [key: string]: unknown;
    };
  }[] = [];
  async function execute(
    label: string,
    input: ContainmentKernelInput,
    expected?: string,
    retry = true,
  ) {
    const before = input.partition.state;
    const inputValue = { ...input, ids: input.ids.seed };
    const identity = await containmentInputIdentity(inputValue);
    const outcome = executeWorldKernel(input, { mode: "test" });
    const state = outcome.ok ? outcome.result.state : before;
    if (!outcome.ok) assertEnvelope(outcome.error);
    if (expected !== undefined) equal(outcome.ok ? "success" : outcome.error.code, expected);
    const changes = outcome.ok ? deltas(outcome.result.events) : { food: 0n, water: 0n };
    entries.push({
      label,
      input: {
        type: input.input.kind === "command" ? input.input.command.type : null,
        version: input.input.kind === "command" ? input.input.command.payload.schemaVersion : null,
        commandId: input.ids.seed.commandId,
        ...identity,
        preStateHash: await stateHash(before),
        randomStateHash: await stateHash(input.randomState),
      },
      output: {
        ...(outcome.ok
          ? {
              kind: "success",
              eventTypes: outcome.result.events.map((event) => event.type),
              eventIds: outcome.result.events.map((event) => event.eventId),
              quantityChanges: Object.fromEntries(
                Object.entries(changes).map(([kind, quantity]) => [kind, quantity.toString()]),
              ),
            }
          : { kind: "refusal", ...outcome.error }),
        postStateHash: await stateHash(state),
        resourceTotalsBefore: totals(before),
        resourceTotalsAfter: totals(state),
      },
    });
    equal(await containmentInputIdentity(inputValue), identity);
    if (!outcome.ok) return;
    if (input.input.kind !== "command") throw new Error("command required");
    const submitted = input.input.command;
    const emitted = outcome.result.events[0]!;
    equal(outcome.result.events.length, 1);
    if (submitted.type.startsWith("resource.")) {
      const body = emitted.payload as { quantity: number; kind: string };
      const requested = submitted.payload as { quantity: number; kind: string };
      equal([body.quantity, body.kind], [requested.quantity, requested.kind]);
    }
    if (emitted.type === "object.retired") {
      const retired = before.entities.find(
        (entity) => entity.objectId === emitted.payload.objectId,
      )!;
      equal(emitted.payload.quantityRemoved, retired.resource?.quantity ?? 0);
    }
    assertPhysical(state);
    equal(
      checkWorldInvariants(
        before,
        state,
        outcome.result.events,
        input.input.kind === "command" ? input.input.command.type : "world.advance",
      ),
      undefined,
    );
    equal(replayWorldEvents(before, outcome.result.events), state);
    equal(outcome.result.updatedRandomState, input.randomState);
    const beforeTotals = worldResourceTotals(before),
      afterTotals = worldResourceTotals(state);
    for (const kind of ["food", "water"])
      equal(afterTotals[kind]! - beforeTotals[kind]!, changes[kind]);
    current = {
      ...current,
      partition: { ...current.partition, state, revision: state.revision },
      schedules: outcome.result.schedules,
      simulationTime: state.simulationTime,
    };
    if (retry)
      await execute(
        `${label}:retry`,
        { ...input, partition: current.partition },
        "revision-conflict",
        false,
      );
  }
  const run = async (
    label: string,
    type: string,
    payload: Record<string, unknown>,
    expected?: string,
  ) =>
    execute(
      label,
      containmentInput(current, type, { schemaVersion: 1, ...payload }, label),
      expected,
    );
  for (const id of ["box-a", "box-b", "inventory"])
    await execute(
      `create:${id}`,
      containmentInput(
        current,
        "object.create",
        fixturePayload(
          current,
          id,
          id.startsWith("food")
            ? { kind: "food", quantity: 10 }
            : id === "water"
              ? { kind: "water", quantity: 2 }
              : undefined,
          2,
          id === "inventory" ? "persona-inventory" : "object",
        ),
        `create:${id}`,
      ),
      "success",
    );
  await run("put", "containment.put", { objectId: "food-a", containerId: "box-a" }, "success");
  await run(
    "retire-with-contents",
    "object.retire",
    { objectId: "box-a", disposition: "discard" },
    "precondition-failed",
  );
  await run(
    "container-transfer",
    "containment.transfer",
    { objectId: "food-a", fromContainerId: "box-a", toContainerId: "box-b" },
    "success",
  );
  await run(
    "inventory-transfer",
    "containment.transfer",
    { objectId: "food-a", fromContainerId: "box-b", toContainerId: "inventory" },
    "success",
  );
  await run(
    "remove",
    "containment.remove",
    { objectId: "food-a", containerId: "inventory" },
    "success",
  );
  await run("nested", "containment.put", { objectId: "box-b", containerId: "box-a" }, "success");
  await run(
    "cycle",
    "containment.put",
    { objectId: "box-a", containerId: "box-b" },
    "precondition-failed",
  );
  await run(
    "self",
    "containment.put",
    { objectId: "food-a", containerId: "food-a" },
    "precondition-failed",
  );
  await run("fill", "containment.put", { objectId: "food-a", containerId: "box-a" }, "success");
  await run(
    "capacity",
    "containment.put",
    { objectId: "food-b", containerId: "box-a" },
    "precondition-failed",
  );
  await run(
    "offer",
    "resource.offer",
    { objectId: "food-a", kind: "food", quantity: 4 },
    "precondition-failed",
  );
  await run(
    "resource-transfer",
    "resource.transfer",
    { fromObjectId: "food-a", toObjectId: "food-b", kind: "food", quantity: 10 },
    "success",
  );
  await run(
    "exhausted",
    "resource.consume",
    { objectId: "food-a", kind: "food", quantity: 1 },
    "precondition-failed",
  );
  await run(
    "consume-all",
    "resource.consume",
    { objectId: "food-b", kind: "food", quantity: 20 },
    "success",
  );
  await run(
    "kind-mismatch",
    "resource.transfer",
    { fromObjectId: "water", toObjectId: "food-a", kind: "water", quantity: 1 },
    "precondition-failed",
  );
  await run(
    "retire-resource",
    "object.retire",
    { objectId: "water", disposition: "discard" },
    "success",
  );
  for (const type of [
    "containment.put",
    "containment.remove",
    "containment.transfer",
    "resource.offer",
    "resource.consume",
    "resource.transfer",
    "object.retire",
  ]) {
    const payload =
      type === "containment.transfer"
        ? { objectId: "water", fromContainerId: "box-a", toContainerId: "inventory" }
        : type === "resource.transfer"
          ? { fromObjectId: "water", toObjectId: "food-a", kind: "water", quantity: 1 }
          : type.startsWith("containment")
            ? { objectId: "water", containerId: "box-a" }
            : type === "object.retire"
              ? { objectId: "water", disposition: "discard" }
              : { objectId: "water", kind: "water", quantity: 1 };
    await run(`retired:${type}`, type, payload, "precondition-failed");
  }
  await run(
    "unknown-object",
    "resource.offer",
    { objectId: "missing", kind: "food", quantity: 1 },
    "precondition-failed",
  );
  await run(
    "unknown-kind",
    "resource.offer",
    { objectId: "food-a", kind: "unknown", quantity: 1 },
    "invalid-input",
  );
  for (const quantity of [-1, 0, 0.5, "1", 1n << 64n, null])
    await run(
      `invalid-quantity:${String(quantity)}`,
      "resource.offer",
      { objectId: "food-a", kind: "food", quantity },
      "invalid-input",
    );
  await run(
    "unknown-version",
    "resource.offer",
    { schemaVersion: 2, objectId: "food-a", kind: "food", quantity: 1 },
    "unknown-command-version",
  );
  let driver = initializeNamedRandomStreams(containmentSeed, streams);
  const next = () => {
    const result = drawNamedRandomStream(driver, "containment");
    driver = result.randomState;
    return Number(result.draw.rawValue + 2147483648n);
  };
  for (let index = 0; index < steps; index++) {
    const action = next() % 8;
    current = { ...current, randomState: driver };
    const quantity = 1 + (next() % 15);
    if (action < 3)
      await run(
        `generated:${index}`,
        ["resource.offer", "resource.consume", "resource.transfer"][action]!,
        action === 2
          ? { fromObjectId: "food-a", toObjectId: "food-b", kind: "food", quantity }
          : { objectId: next() % 2 ? "food-a" : "food-b", kind: "food", quantity },
      );
    else if (action === 3)
      await run(`generated:${index}`, "containment.put", {
        objectId: "food-b",
        containerId: next() % 2 ? "inventory" : "box-a",
      });
    else if (action === 4)
      await run(`generated:${index}`, "containment.remove", {
        objectId: "food-b",
        containerId: "inventory",
      });
    else if (action === 5)
      await run(`generated:${index}`, "containment.transfer", {
        objectId: "food-b",
        fromContainerId: "inventory",
        toContainerId: "box-b",
      });
    else if (action === 6)
      await run(
        `generated:${index}`,
        "resource.offer",
        { objectId: "food-a", kind: "food", quantity: -quantity },
        "invalid-input",
      );
    else
      await run(
        `generated:${index}`,
        "object.retire",
        { objectId: "box-a", disposition: "discard" },
        "precondition-failed",
      );
  }
  const identity = worldRegistryIdentity();
  return {
    schemaVersion: 1,
    seed: containmentSeed,
    steps,
    registry: { ...identity, hash: await stateHash(identity) },
    entries,
    finalStateHash: await stateHash(current.partition.state),
    finalResourceTotals: totals(current.partition.state),
  };
}
