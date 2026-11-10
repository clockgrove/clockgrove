import { readFileSync } from "node:fs";
import {
  createWorldState,
  decodeWorldScenario,
  deriveEnvironmentState,
  type HistoricWorldEvent,
  reduceWorldEvent,
  replayWorldEvents,
  upcastWorldEvent,
} from "@clockgrove/domain";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/canonical.js";
import type { WorldSemanticEvent } from "../src/world.js";
import { type UtilitySpec, utilitySample } from "./decisions.scenario.js";
import { type EnvironmentWorld, type Run, runChain } from "./environment.scenario.js";
import { scenarioInput, stateHash } from "./weather-needs.scenario.js";

// biome-ignore lint: fixture data is built from plain objects
type Loose = Record<string, any>;

/** Event types that follow integration or time steps rather than a semantic change. */
const INCIDENTAL_TYPES = [
  "needs.changed",
  "growth.integrated",
  "wellbeing.integrated",
  "time.advanced",
] as const;
const isIncidental = (type: string): boolean =>
  (INCIDENTAL_TYPES as readonly string[]).includes(type);

const DAY_MS = 10000;
const SPAN = BigInt(DAY_MS * 10);
const INTERVAL_MS = 1000;
const ACTORS = 2;
const PLANTS = 1;
/** The kernel's documented per-call maxima; a bounded call that stops early is continued. */
const MAX_INPUTS = 1024;
const MAX_EVENTS = 4096;

function spec(segments: UtilitySpec["segments"]): UtilitySpec {
  return {
    dayLengthMs: DAY_MS,
    phases: [
      ["night", 0, "dark"],
      ["day", 3000, "bright"],
      ["dusk", 8000, "dim"],
    ],
    segments,
    wetThreshold: 3000,
    discomfortThreshold: 6000,
    intervalMs: INTERVAL_MS,
    hungerPerInterval: 5,
    wetnessPerInterval: 1500,
    dryingPerInterval: 1000,
    actors: [
      ["a-weather", null],
      ["b-weather", 10000],
    ],
    wellbeing: {
      thirstPerInterval: 40,
      healthLossPerInterval: 100,
      healthRecoveryPerInterval: 100,
      urgentHunger: 3200,
      urgentThirst: 300,
      criticalHealth: 1,
    },
    items: [],
    utility: {
      thirstWeight: 1500,
      expectationWeight: 400,
      travelWeight: 100,
      unitsPerSecond: 2000n,
      perceptionRange: 3000n,
      biteQuantity: 2,
      hungerReliefPerUnit: 500,
      thirstReliefPerUnit: 500,
    },
  };
}

/** Two weather segments per cycle; the cycle repeats every day. */
const FIRST = spec([
  [5000, 0, "mild"],
  [5000, 10000, "wet"],
]);

async function fixtureWorld(source: UtilitySpec): Promise<EnvironmentWorld> {
  const sample = utilitySample(source);
  sample.pack.packId = "clockgrove.fixture.event-volume";
  if (!sample.pack.archetypes.includes("reference.cedar@1"))
    sample.pack.archetypes.push("reference.cedar@1");
  const pose = { frameId: "zone-ground", frameVersion: 1, coordinates: ["0", "0"] };
  (sample.initialState.entities as Loose[]).push({
    objectId: "cedar",
    archetypeId: "reference.cedar@1",
    pose,
    spaceId: "zone",
  });
  (sample.initialState.entities as Loose[]).sort((l, r) =>
    l.objectId < r.objectId ? -1 : l.objectId > r.objectId ? 1 : 0,
  );
  sample.pack.policy.ecology = {
    schemaVersion: 1,
    perishables: [],
    plants: [
      {
        objectId: "cedar",
        growingLightBands: ["dim", "bright"],
        stages: [
          { name: "seedling", thresholdMs: "0" },
          { name: "sapling", thresholdMs: "20000" },
          { name: "mature", thresholdMs: "60000" },
        ],
      },
    ],
  };
  sample.initialState.ecology = {
    perishables: [],
    plants: [
      {
        objectId: "cedar",
        stage: 0,
        growingMs: "0",
        wetness: 0,
        wetnessRemainder: "0",
        integratedAt: "0",
      },
    ],
  };
  const decoded = decodeWorldScenario(sample, await stateHash(sample));
  const policy = decoded.pack.policy.environment;
  if (policy === undefined) throw new Error("environment policy required");
  const initialState = createWorldState({
    ...decoded.initialState,
    environment: deriveEnvironmentState(policy, decoded.initialState.simulationTime),
  });
  const template = await scenarioInput(undefined, 0, 32, {}, 32, {
    pack: decoded.pack,
    initialState,
  });
  return { template, state: template.partition.state, schedules: template.schedules };
}

/** Calls `world.advance` in steps of `stepMs` up to the span, continuing bounded calls. */
function drive(start: EnvironmentWorld, label: string, stepMs: bigint): Run {
  let world = start;
  const events: WorldSemanticEvent[] = [];
  const calls: Run["calls"][number][] = [];
  let logical = 0;
  for (let index = 0; world.state.simulationTime < SPAN; index += 1) {
    const next = world.state.simulationTime + stepMs;
    const run = runChain(
      world,
      `${label}:${index}`,
      next < SPAN ? next : SPAN,
      MAX_INPUTS,
      MAX_EVENTS,
    );
    logical += 1;
    events.push(...run.events);
    calls.push(...run.calls);
    world = run.world;
  }
  return { world, events, calls, incomplete: calls.length - logical };
}

const materialOf = (events: readonly WorldSemanticEvent[]) =>
  events
    .filter((event) => !isIncidental(event.type))
    .map((event) => ({
      type: event.type,
      time: event.simulationTime as bigint,
      payload: event.payload,
    }));
const incidentalCount = (events: readonly WorldSemanticEvent[]) =>
  events.filter((e) => isIncidental(e.type)).length;
const finalState = (run: Run) => canonicalSerialize({ ...run.world.state, revision: 0n });

describe("event volume follows semantic changes", () => {
  it("is independent of step frequency", async () => {
    const world = await fixtureWorld(FIRST);
    const one = drive(world, "one", SPAN);
    const stepped = drive(world, "int", BigInt(INTERVAL_MS));
    expect(one.calls.length - one.incomplete).toBe(1);
    expect(stepped.calls.length - stepped.incomplete).toBe(Number(SPAN) / INTERVAL_MS);
    expect(materialOf(one.events).length).toBeGreaterThan(0);
    expect(canonicalSerialize(materialOf(stepped.events))).toBe(
      canonicalSerialize(materialOf(one.events)),
    );
    expect(finalState(stepped)).toBe(finalState(one));
    // Only incidental events grow with the step count, bounded per call and material time.
    const times = new Set(materialOf(stepped.events).map((event) => event.time));
    expect(incidentalCount(stepped.events)).toBeLessThanOrEqual(
      (times.size + stepped.calls.length) * (2 * ACTORS + PLANTS + 1),
    );
  }, 300000);
});

describe("historic event replay", () => {
  it("replays a historic routine.selected@1 stream to the state the current contract reaches", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./event-fixtures/routine-selected-v1-stream.json", import.meta.url),
        "utf8",
      ),
      (_key, value) =>
        value !== null && typeof value === "object" && Object.keys(value).join() === "$bigint"
          ? BigInt(value.$bigint)
          : value,
    ) as { finalStateHash: string; events: HistoricWorldEvent[] };
    const historic = fixture.events;
    const world = await fixtureWorld(FIRST);
    const current = runChain(world, "historic", 20000n, MAX_INPUTS, MAX_EVENTS);
    const v1 = historic.filter((event) => event.type === "routine.selected");
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.every((event) => event.schemaVersion === 1)).toBe(true);
    // The historic stream replays, through the upcast, to exactly the state it once reduced to,
    // which is the current run's state with revision set aside.
    const replayed = replayWorldEvents(world.state, historic);
    expect(await stateHash(replayed)).toBe(fixture.finalStateHash);
    expect(canonicalSerialize({ ...replayed, revision: 0n })).toBe(
      canonicalSerialize({ ...current.world.state, revision: 0n }),
    );
    // A historic event reaches the reducer only through the explicit upcast.
    const first = v1[0]!;
    expect(() => reduceWorldEvent(world.state, first as never)).toThrow(/schema version/);
    expect(upcastWorldEvent(first)).toEqual({ ...first, schemaVersion: 2 });
  }, 300000);
});
