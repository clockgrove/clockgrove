import type { ObjectId, SimTimeMs } from "@clockgrove/contracts";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  type EnvironmentPolicy,
  initialSurfaceState,
  reduceWorldEvent,
  type SurfacePolicy,
  surfaceValueAt,
  validateSurfacePolicy,
} from "@clockgrove/domain";
import { expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import { executeWorldKernel, type WorldSemanticEvent } from "../src/world.js";
import { containmentInput } from "./containment.scenario.js";
import {
  advanceInput,
  applyCommand,
  type EnvironmentWorld,
  runChain,
  runLive,
} from "./environment.scenario.js";
import {
  lifeChain,
  lifecycleSample,
  lifeWorldFromSample,
  SURE_SPEC,
} from "./lifecycle.scenario.js";
import { movementInput } from "./spatial.scenario.js";
import { scenarioInput, scenarios, stateHash } from "./weather-needs.scenario.js";

const HOUR = 3_600_000n;
const host = (objectId: string) => ({ kind: "object" as const, objectId: objectId as ObjectId });
const surfaces: SurfacePolicy = {
  schemaVersion: 1,
  budgets: { zones: 4, marksPerZone: 2 },
  channels: [
    {
      id: "wear",
      max: 100,
      carried: false,
      bands: [
        { name: "fresh", min: 0, max: 9 },
        { name: "scuffed", min: 10, max: 59 },
        { name: "scarred", min: 40, max: 100 },
      ],
      recovery: { driver: "time", amount: 1, periodMs: HOUR },
    },
    {
      id: "mud",
      max: 50,
      carried: true,
      bands: [
        { name: "clean", min: 0, max: 0 },
        { name: "muddy", min: 1, max: 50 },
      ],
      recovery: { driver: "none" },
    },
  ],
  zones: [
    {
      id: "post",
      host: { kind: "object", objectId: "post-object" as ObjectId },
      channels: [{ channel: "wear", initial: 0 }],
      markCapacity: 2,
    },
    {
      id: "bed",
      host: { kind: "object", objectId: "bed-object" as ObjectId },
      channels: [{ channel: "mud", initial: 20 }],
      markCapacity: 0,
    },
    {
      id: "step",
      host: { kind: "object", objectId: "step-object" as ObjectId },
      channels: [{ channel: "mud", initial: 0 }],
      markCapacity: 0,
    },
  ],
  interactions: [
    { id: "scratch", effects: [{ channel: "wear", kind: "add", amount: 30 }], leavesMark: true },
    { id: "tread", effects: [{ channel: "mud", kind: "pickup", amount: 8 }], leavesMark: false },
    { id: "wipe", effects: [{ channel: "mud", kind: "deposit", amount: 5 }], leavesMark: false },
  ],
};

async function surfaceWorld(
  policy: SurfacePolicy = surfaces,
  extra: {
    readonly hosts?: readonly object[];
    readonly regions?: readonly object[];
    readonly environment?: EnvironmentPolicy;
  } = {},
): Promise<EnvironmentWorld> {
  const decoded = decodeWorldScenario(scenarios.weather, await stateHash(scenarios.weather));
  const environment = extra.environment;
  const pack = {
    ...decoded.pack,
    policy: { ...decoded.pack.policy, surfaces: policy, ...(environment && { environment }) },
  };
  const actor = decoded.initialState.entities.find((entity) => entity.objectId === "subject")!;
  const state = createWorldState({
    ...decoded.initialState,
    surfaces: initialSurfaceState(policy, decoded.initialState.simulationTime),
    ...(environment && {
      environment: deriveEnvironmentState(environment, decoded.initialState.simulationTime),
    }),
    ...(extra.regions === undefined ? {} : { spatialRegions: extra.regions as never }),
    entities: [
      ...decoded.initialState.entities,
      ...["post-object", "bed-object", "step-object"].map((objectId) => ({
        objectId: objectId as ObjectId,
        archetypeId: actor.archetypeId,
        spaceId: actor.spaceId,
        pose: actor.pose,
      })),
      ...(extra.hosts ?? []).map((host) => ({
        archetypeId: actor.archetypeId,
        spaceId: actor.spaceId,
        pose: actor.pose,
        ...host,
      })),
    ] as never,
  });
  const template = await scenarioInput(undefined, 0, 32, {}, 32, { pack, initialState: state });
  return { template, state, schedules: template.schedules };
}

function command(
  world: EnvironmentWorld,
  type: "surface.interact" | "surface.repair",
  payload: object,
  actor = "subject",
) {
  const attribution = { ...world.template.attribution, effectiveActorId: actor };
  const { authorityDecisionId: _authority, ...intent } = attribution;
  const input = containmentInput(
    {
      ...world.template,
      partition: {
        ...world.template.partition,
        state: world.state,
        revision: world.state.revision,
      },
      simulationTime: world.state.simulationTime,
      schedules: world.schedules,
      attribution,
    },
    type,
    { schemaVersion: 1, ...payload },
  );
  if (input.input.kind !== "command") throw new Error("command required");
  return {
    ...input,
    input: { ...input.input, command: { ...input.input.command, attribution: intent } },
  };
}
const interact = (zoneId: string, interactionId: string, actorId = "subject") => ({
  actorId,
  zoneId,
  interactionId,
  intensity: 10000,
  point: { u: 5, v: 7 },
});
function run(
  world: EnvironmentWorld,
  type: "surface.interact" | "surface.repair",
  payload: object,
) {
  const result = executeWorldKernel(command(world, type, payload), { mode: "test" });
  if (!result.ok) throw new Error(`${result.error.path} ${result.error.check}`);
  return {
    world: { ...world, state: result.result.state, schedules: result.result.schedules },
    events: result.result.events,
  };
}
const refusal = (
  world: EnvironmentWorld,
  type: "surface.interact",
  payload: object,
  actor?: string,
) => {
  const result = executeWorldKernel(command(world, type, payload, actor), { mode: "test" });
  return result.ok
    ? undefined
    : { code: result.error.code, path: result.error.path, check: result.error.check };
};
const surfaceEvents = (events: readonly WorldSemanticEvent[]) =>
  events
    .filter((event) => event.type.startsWith("surface."))
    .map(({ type, simulationTime, payload }) => ({ type, simulationTime, payload }));
const zone = (world: EnvironmentWorld, id: string) =>
  world.state.surfaces!.zones.find((entry) => entry.zoneId === id)!;

it("journals scratches with a folding mark ring, actor attribution and refusals", async () => {
  let world = await surfaceWorld();
  const events: WorldSemanticEvent[] = [];
  for (let scratch = 0; scratch < 3; scratch += 1) {
    const next = run(world, "surface.interact", interact("post", "scratch"));
    world = next.world;
    events.push(...next.events);
  }
  expect(
    events.map((event) => [event.type, event.simulationTime, event.attribution.effectiveActorId]),
  ).toEqual(Array(3).fill(["surface.interacted", 0n, "subject"]));
  const mark = {
    actorId: "subject",
    interactionId: "scratch",
    at: 0n,
    intensity: 10000,
    point: { u: 5, v: 7 },
  };
  const third = events[2]!.payload as { folded: unknown; channels: unknown; mark: unknown };
  expect(third.folded).toEqual(mark);
  expect(third.channels).toEqual([{ channel: "wear", value: 90, remainder: 0n, settledAt: 0n }]);
  expect(zone(world, "post").marks).toEqual([mark, mark]);
  expect(zone(world, "post").channels[0]).toMatchObject({ value: 90 });
  expect(events.reduce(reduceWorldEvent, (await surfaceWorld()).state)).toEqual(world.state);

  expect(refusal(world, "surface.interact", interact("post", "scratch"), "imposter")).toEqual({
    code: "precondition-failed",
    path: "payload.actorId",
    check: "surface.actor@1",
  });
  expect(refusal(world, "surface.interact", interact("post", "polish"))).toEqual({
    code: "precondition-failed",
    path: "payload.interactionId",
    check: "surface.interaction@1",
  });
  expect(refusal(world, "surface.interact", interact("nowhere", "scratch"))).toEqual({
    code: "precondition-failed",
    path: "payload.zoneId",
    check: "surface.zone@1",
  });
});

it("journals only band crossings while a scratched surface heals, identically in every advance shape", async () => {
  let world = await surfaceWorld();
  for (let scratch = 0; scratch < 3; scratch += 1)
    world = run(world, "surface.interact", interact("post", "scratch")).world;
  const end = 100n * HOUR;
  const aggregate = runChain(world, "heal-one", end);
  const bounded = runChain(world, "heal-bounded", end, 4, 8);
  const live = runLive(world, "heal-live", end, 7n * HOUR);
  expect(bounded.incomplete).toBeGreaterThan(0);
  const crossing = (time: bigint, value: number, bands: string[], previousBands: string[]) => ({
    type: "surface.band-crossed",
    simulationTime: time,
    payload: { zoneId: "post", channel: "wear", value, remainder: 0n, bands, previousBands },
  });
  const expected = [
    crossing(31n * HOUR, 59, ["scuffed", "scarred"], ["scarred"]),
    crossing(51n * HOUR, 39, ["scuffed"], ["scuffed", "scarred"]),
    crossing(81n * HOUR, 9, ["fresh"], ["scuffed"]),
  ];
  for (const result of [aggregate, bounded, live]) {
    expect(surfaceEvents(result.events)).toEqual(expected);
    expect(canonicalSerialize(result.world.state.surfaces)).toBe(
      canonicalSerialize(aggregate.world.state.surfaces),
    );
  }
  const settled = zone(aggregate.world, "post").channels[0]!;
  expect(settled).toEqual({ channel: "wear", value: 9, remainder: 0n, settledAt: 81n * HOUR });
  expect(surfaceValueAt(surfaces.channels[0]!, settled, end as SimTimeMs)).toEqual({
    value: 0,
    remainder: 0n,
  });
  const replayed = [...aggregate.events].reduce(reduceWorldEvent, world.state);
  expect(replayed.surfaces).toEqual(aggregate.world.state.surfaces);
});

it("heals by rain and by growing light in closed form, journaling only crossings in every advance shape", async () => {
  const bands = (...names: [string, number, number][]) =>
    names.map(([name, min, max]) => ({ name, min, max }));
  const drivers: SurfacePolicy = {
    schemaVersion: 1,
    budgets: { zones: 2, marksPerZone: 0 },
    channels: [
      {
        id: "grime",
        max: 100,
        carried: false,
        bands: bands(["clean", 0, 0], ["spotted", 1, 49], ["soaked", 50, 100]),
        recovery: { driver: "rain", amount: 1, periodMs: HOUR },
      },
      {
        id: "scar",
        max: 10,
        carried: false,
        bands: bands(["healed", 0, 4], ["scarred", 5, 10]),
        recovery: { driver: "growth", amount: 1, periodMs: 4n * HOUR, lightBands: ["bright"] },
      },
    ],
    zones: [
      {
        id: "sill",
        host: host("post-object"),
        channels: [{ channel: "grime", initial: 60 }],
        markCapacity: 0,
      },
      {
        id: "bark",
        host: host("bed-object"),
        channels: [{ channel: "scar", initial: 10 }],
        markCapacity: 0,
      },
    ],
    interactions: [],
  };
  // Rain at half intensity for the first 12 h of every day (6 grime a day); bright light from 6 h
  // to 18 h (3 scar a day).
  const environment: EnvironmentPolicy = {
    schemaVersion: 1,
    dayLengthMs: 24n * HOUR,
    phases: [
      { name: "night", startMs: 0n, lightBand: "dark" },
      { name: "day", startMs: 6n * HOUR, lightBand: "bright" },
      { name: "dusk", startMs: 18n * HOUR, lightBand: "dark" },
    ],
    weatherSegments: [
      { durationMs: 12n * HOUR, rainIntensity: 5000, temperatureBand: "mild" },
      { durationMs: 12n * HOUR, rainIntensity: 0, temperatureBand: "mild" },
    ],
    wetThreshold: 5000,
    discomfortThreshold: 8000,
  };
  const world = await surfaceWorld(drivers, { environment });
  const end = 240n * HOUR;
  const aggregate = runChain(world, "drivers-one", end);
  const bounded = runChain(world, "drivers-bounded", end, 4, 8);
  const live = runLive(world, "drivers-live", end, 7n * HOUR);
  const crossing = (
    time: bigint,
    zoneId: string,
    channel: string,
    value: number,
    b: string[],
    p: string[],
  ) => ({
    type: "surface.band-crossed",
    simulationTime: time,
    payload: { zoneId, channel, value, remainder: 0n, bands: b, previousBands: p },
  });
  const expected = [
    crossing(34n * HOUR, "sill", "grime", 49, ["spotted"], ["soaked"]),
    crossing(42n * HOUR, "bark", "scar", 4, ["healed"], ["scarred"]),
    crossing(228n * HOUR, "sill", "grime", 0, ["clean"], ["spotted"]),
  ];
  for (const result of [aggregate, bounded, live]) {
    expect(surfaceEvents(result.events)).toEqual(expected);
    expect(canonicalSerialize(result.world.state.surfaces)).toBe(
      canonicalSerialize(aggregate.world.state.surfaces),
    );
  }
  const replayed = [...aggregate.events].reduce(reduceWorldEvent, world.state);
  expect(replayed.surfaces).toEqual(aggregate.world.state.surfaces);
});

it("conserves carried mud across tread and wipe, and journals what a repair removes", async () => {
  const start = await surfaceWorld();
  const total = (world: EnvironmentWorld) =>
    zone(world, "bed").channels[0]!.value +
    zone(world, "step").channels[0]!.value +
    world.state.surfaces!.carried.reduce((sum, entry) => sum + entry.amount, 0);
  const trodden = run(start, "surface.interact", interact("bed", "tread"));
  expect(zone(trodden.world, "bed").channels[0]!.value).toBe(12);
  expect(trodden.world.state.surfaces!.carried).toEqual([
    { objectId: "subject", channel: "mud", amount: 8 },
  ]);
  const wiped = run(trodden.world, "surface.interact", interact("step", "wipe"));
  expect(zone(wiped.world, "step").channels[0]!.value).toBe(5);
  expect(wiped.world.state.surfaces!.carried).toEqual([
    { objectId: "subject", channel: "mud", amount: 3 },
  ]);
  expect([total(start), total(trodden.world), total(wiped.world)]).toEqual([20, 20, 20]);
  expect(wiped.events[0]!.payload).toMatchObject({
    carried: [{ channel: "mud", amount: 3 }],
    mark: null,
  });

  const repaired = run(wiped.world, "surface.repair", { zoneId: "step", reason: "sweep" });
  expect(repaired.events.map((event) => [event.type, event.payload])).toEqual([
    [
      "surface.repaired",
      { zoneId: "step", reason: "sweep", removed: [{ channel: "mud", amount: 5 }] },
    ],
  ]);
  expect(zone(repaired.world, "step").channels[0]!.value).toBe(0);
  expect(
    refusal(wiped.world, "surface.interact", { ...interact("step", "wipe"), zoneId: "post" }),
  ).toMatchObject({
    check: "surface.interaction@1",
  });
});

it("refuses a pack whose surfaces exceed its own declared budget, dropping nothing", async () => {
  const world = await surfaceWorld();
  const overBudget = (budgets: SurfacePolicy["budgets"]) => {
    const policy = { ...surfaces, budgets };
    const input = command(world, "surface.interact", interact("post", "scratch"));
    const pack = input.pack.pack;
    const result = executeWorldKernel(
      {
        ...input,
        pack: { ...input.pack, pack: { ...pack, policy: { ...pack.policy, surfaces: policy } } },
      },
      { mode: "test" },
    );
    expect(() => validateSurfacePolicy(policy)).toThrow(
      "surface budget exceeded (surface.budget@1)",
    );
    return result.ok ? undefined : result.error;
  };
  expect(overBudget({ zones: 2, marksPerZone: 2 })).toEqual({
    code: "invalid-input",
    path: "pack.pack.policy.surfaces.zones",
    check: "surface.budget@1",
  });
  expect(overBudget({ zones: 4, marksPerZone: 1 })).toEqual({
    code: "invalid-input",
    path: "pack.pack.policy.surfaces.zones[0].markCapacity",
    check: "surface.budget@1",
  });
  // A malformed declaration at the same path carries no check, so the two stay distinguishable.
  const input = command(world, "surface.interact", interact("post", "scratch"));
  const malformed = { ...surfaces, zones: [{ ...surfaces.zones[0]!, markCapacity: 33 }] };
  const result = executeWorldKernel(
    {
      ...input,
      pack: {
        ...input.pack,
        pack: { ...input.pack.pack, policy: { ...input.pack.pack.policy, surfaces: malformed } },
      },
    },
    { mode: "test" },
  );
  expect(result.ok ? undefined : result.error).toEqual({
    code: "invalid-input",
    path: "pack.pack.policy.surfaces.zones[0].markCapacity",
  });
});

it("reaches ground-region zones by standing in them, and refuses distant and retired hosts", async () => {
  const square = (regionId: string, min: bigint, max: bigint) => ({
    regionId,
    version: 1,
    frameId: "zone-ground",
    frameVersion: 1,
    shape: { kind: "rectangle", min: [min, min], max: [max, max] },
  });
  const wear = (id: string, host: SurfacePolicy["zones"][number]["host"]) => ({
    id,
    host,
    channels: [{ channel: "wear", initial: 0 }],
    markCapacity: 1,
  });
  const policy: SurfacePolicy = {
    ...surfaces,
    budgets: { zones: 8, marksPerZone: 2 },
    zones: [
      ...surfaces.zones,
      wear("patch", { kind: "region", regionId: "patch" }),
      wear("yonder", { kind: "region", regionId: "yonder" }),
      wear("across", { kind: "object", objectId: "across-object" as ObjectId }),
      wear("discarded", { kind: "object", objectId: "discarded-object" as ObjectId }),
    ],
  };
  const world = await surfaceWorld(policy, {
    regions: [square("patch", -1000n, 1000n), square("yonder", 5000n, 6000n)],
    hosts: [
      { objectId: "across-object", spaceId: "elsewhere" },
      { objectId: "discarded-object", lifecycle: { status: "retired" } },
    ],
  });
  const scratched = run(world, "surface.interact", interact("patch", "scratch"));
  expect(surfaceEvents(scratched.events)).toMatchObject([
    {
      type: "surface.interacted",
      payload: { zoneId: "patch", channels: [{ channel: "wear", value: 30 }] },
    },
  ]);
  expect(scratched.events.reduce(reduceWorldEvent, world.state)).toEqual(scratched.world.state);
  const reach = { code: "precondition-failed", path: "payload.actorId", check: "surface.reach@1" };
  expect(refusal(world, "surface.interact", interact("yonder", "scratch"))).toEqual(reach);
  expect(refusal(world, "surface.interact", interact("across", "scratch"))).toEqual(reach);
  expect(refusal(world, "surface.interact", interact("discarded", "scratch"))).toEqual({
    code: "precondition-failed",
    path: "payload.zoneId",
    check: "surface.zone@1",
  });
});

it("decodes a scenario that declares surfaces and their state", async () => {
  const strings = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
  const sample = structuredClone(scenarios.weather) as {
    pack: { policy: Record<string, unknown> };
    initialState: Record<string, unknown>;
  };
  const decodedBase = decodeWorldScenario(scenarios.weather, await stateHash(scenarios.weather));
  const state = initialSurfaceState(surfaces, decodedBase.initialState.simulationTime);
  sample.pack.policy.surfaces = strings(surfaces);
  sample.initialState.surfaces = strings(state);
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  expect(decoded.pack.policy.surfaces).toEqual(surfaces);
  expect(decoded.initialState.surfaces).toEqual(state);
});

it("wears a porch and tracks mud onto it as an actor walks in, one entry per region and no event per step", async () => {
  const region = (regionId: string, min: bigint, max: bigint) => ({
    regionId,
    version: 1,
    frameId: "zone-ground",
    frameVersion: 1,
    shape: { kind: "rectangle", min: [min, -1000n], max: [max, 1000n] },
  });
  const ground = (
    id: string,
    channels: SurfacePolicy["zones"][number]["channels"],
    traffic: string,
  ) => ({
    id,
    host: { kind: "region", regionId: id } as const,
    channels,
    markCapacity: 1,
    traffic,
  });
  const policy: SurfacePolicy = {
    ...surfaces,
    budgets: { zones: 8, marksPerZone: 2 },
    zones: [
      ...surfaces.zones,
      ground("yard", [{ channel: "mud", initial: 20 }], "tread"),
      ground(
        "porch",
        [
          { channel: "mud", initial: 0 },
          { channel: "wear", initial: 0 },
        ],
        "track",
      ),
    ],
    interactions: [
      ...surfaces.interactions,
      {
        id: "track",
        effects: [
          { channel: "mud", kind: "deposit", amount: 5 },
          { channel: "wear", kind: "add", amount: 3 },
        ],
        leavesMark: true,
      },
    ],
  };
  const world = await surfaceWorld(policy, {
    regions: [region("yard", 2000n, 4000n), region("porch", 6000n, 8000n)],
  });
  const pose = world.state.entities.find((entity) => entity.objectId === "subject")!.pose;
  const destination = { kind: "pose", pose: { ...pose, coordinates: [9000n, 0n] } };
  const started = applyCommand(
    world,
    movementInput(
      advanceInput(world, "walk", world.state.simulationTime),
      "movement.start",
      { schemaVersion: 1, objectId: "subject", destination, unitsPerSecond: 1000n },
      "walk",
    ) as never,
  );
  const walked = runChain(started.world, "arrive", started.world.state.simulationTime + 20_000n);
  const events = [...started.events, ...walked.events];
  const entered = events.flatMap((event) =>
    event.type === "movement.region-entered" ? [event] : [],
  );
  expect(entered.map((event) => [event.simulationTime, event.payload.regionId])).toEqual([
    [2000n, "yard"],
    [6000n, "porch"],
  ]);
  expect(entered.map((event) => event.payload.surfaces)).toEqual([
    [
      {
        zoneId: "yard",
        interactionId: "tread",
        channels: [{ channel: "mud", value: 12, remainder: 0n, settledAt: 2000n }],
        carried: [{ channel: "mud", amount: 8 }],
        mark: null,
        folded: null,
      },
    ],
    [
      {
        zoneId: "porch",
        interactionId: "track",
        channels: [
          { channel: "mud", value: 5, remainder: 0n, settledAt: 6000n },
          { channel: "wear", value: 3, remainder: 0n, settledAt: 6000n },
        ],
        carried: [{ channel: "mud", amount: 3 }],
        mark: {
          actorId: "subject",
          interactionId: "track",
          at: 6000n,
          intensity: 10000,
          point: { u: 5000, v: 5000 },
        },
        folded: null,
      },
    ],
  ]);
  expect(surfaceEvents(events)).toEqual([]);
  const final = walked.world.state.surfaces!;
  const mud = (id: string) => final.zones.find((z) => z.zoneId === id)!.channels[0]!.value;
  expect([mud("yard"), mud("porch"), final.carried]).toEqual([
    12,
    5,
    [{ objectId: "subject", channel: "mud", amount: 3 }],
  ]);
  expect(events.reduce(reduceWorldEvent, world.state).surfaces).toEqual(final);
});

it("drains what a dying actor carries in the same instant, right after its death", async () => {
  const strings = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
  const sample = lifecycleSample(SURE_SPEC);
  const carried = [{ objectId: "a-resident", channel: "mud", amount: 8 }];
  sample.pack.policy.surfaces = strings(surfaces);
  sample.initialState.surfaces = strings({
    ...initialSurfaceState(surfaces, 0n as SimTimeMs),
    carried,
  });
  const world = await lifeWorldFromSample(sample);
  const run = lifeChain(world, "dying", 13000n);
  const types = run.events.map((event) => event.type);
  const died = types.indexOf("lifecycle.died");
  expect(run.events[died]!.simulationTime).toBe(10000n);
  expect(run.events[died + 1]).toMatchObject({
    type: "surface.carried-drained",
    simulationTime: 10000n,
    payload: { actorId: "a-resident", removed: [{ channel: "mud", amount: 8 }], cause: "died" },
  });
  expect(types.filter((type) => type.startsWith("surface."))).toEqual(["surface.carried-drained"]);
  expect(run.world.state.surfaces!.carried).toEqual([]);
  expect(run.events.reduce(reduceWorldEvent, world.state).surfaces).toEqual(
    run.world.state.surfaces,
  );
});
