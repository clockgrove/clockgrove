import { encodeResource, NAMED_RANDOM_ALGORITHM } from "@clockgrove/world-pack-sdk";
import { previewSeedProjection } from "../../src/index.js";
import { sha256Hex, type FixtureSource, type Json } from "./lamp-hall.js";

export const SECTION_EPOCH = 100000n;

export interface SectionHallContext {
  docs: Record<string, unknown>;
  manifest: Json;
}

export interface SectionHallOptions {
  edit?: (context: SectionHallContext) => void;
  /** Skips the two-pass computation of the expected seed projection hash. */
  expectedSeedProjectionHash?: string;
}

const component = (type: string, state: Json): Json => ({ type, version: 1, state });

const holder = (id: string, kind: string, quantity: number): Json => ({
  id,
  version: 1,
  traits: [],
  components: { "clockgrove.resource": component("clockgrove.resource", { kind, quantity }) },
});

const actor = (id: string, archetype: string, coordinates: bigint[], lifecycle?: Json): Json => ({
  id,
  archetype: { id: archetype, version: 1 },
  traits: [],
  overrides: [],
  capabilities: [],
  placement: { space: { id: "sec.hall", version: 1 }, coordinates },
  ...(lifecycle === undefined ? {} : { lifecycle }),
});

const behavior = (): Json => ({
  type: "clockgrove.world-behavior-policy",
  policy: {
    schemaVersion: 1,
    version: "sec-1",
    decisionIntervalMs: 60000n,
    hungerPerInterval: 100,
    wetnessPerInterval: 100,
    dryingPerInterval: 100,
    hungerWeight: 5000,
    shelterWeight: 5000,
    environment: {
      schemaVersion: 1,
      dayLengthMs: 86400000n,
      phases: [
        { name: "day", startMs: 0n, lightBand: "bright" },
        { name: "night", startMs: 43200000n, lightBand: "dark" },
      ],
      weatherSegments: [
        { durationMs: 3600000n, rainIntensity: 0, temperatureBand: "mild" },
        { durationMs: 1800000n, rainIntensity: 5000, temperatureBand: "cool" },
      ],
      wetThreshold: 3000,
      discomfortThreshold: 6000,
    },
    ecology: {
      schemaVersion: 1,
      perishables: [{ objectId: "sec.crate", shelfLifeMs: 600000n }],
      plants: [
        {
          objectId: "sec.sprout",
          growingLightBands: ["bright"],
          stages: [
            { name: "seed", thresholdMs: 0n },
            { name: "leaf", thresholdMs: 300000n },
          ],
        },
      ],
    },
    wellbeing: {
      schemaVersion: 1,
      thirstPerInterval: 50,
      healthLossPerInterval: 100,
      healthRecoveryPerInterval: 50,
      urgentHunger: 7000,
      urgentThirst: 7000,
      criticalHealth: 2000,
    },
    utility: {
      schemaVersion: 1,
      scorer: "clockgrove.routine-utility",
      scorerVersion: 1,
      thirstWeight: 5000,
      expectationWeight: 3000,
      travelWeight: 2000,
      unitsPerSecond: 1000n,
      perceptionRange: 5000n,
      biteQuantity: 1,
      hungerReliefPerUnit: 1000,
      thirstReliefPerUnit: 1000,
    },
    lifecycle: {
      schemaVersion: 1,
      stages: [
        { name: "young", startsAtAgeMs: 0n },
        { name: "adult", startsAtAgeMs: 10000n },
      ],
      lifespanMs: 10000000n,
      deathHealth: 0,
      reproduction: {
        fertileStages: ["adult"],
        conceptionIntervalMs: 600000n,
        conceptionChance: 1000,
        coParent: "none",
        gestationMs: 300000n,
        gestationMilestones: [{ name: "showing", atMs: 150000n }],
        cooldownMs: 600000n,
        maxPopulation: 8,
      },
      successorRule: null,
    },
  },
});

const scriptedEntry = (ref: string, kind: string, actorId: string, target: string, value: number): Json => ({
  ref,
  kind,
  actorId,
  targetObjectId: target,
  value,
  effectiveAt: 1000n,
});

/**
 * A schema-2 pack whose behaviour policy declares all five optional sections: two needs actors
 * (parent and child, with lifecycle seeds), a food crate, a water pond, a shed, a plant and two
 * scripted-cognition seeds. The expected seed projection hash is computed from the seeded result.
 */
export async function buildSectionHallSource(options: SectionHallOptions = {}): Promise<FixtureSource> {
  const assemble = async (expected: string): Promise<FixtureSource> => {
    const docs: Record<string, unknown> = {
      "traits/needs.json": {
        id: "sec.needs",
        version: 1,
        traits: [],
        components: {
          "clockgrove.needs": component("clockgrove.needs", {
            hunger: 3000,
            wetness: 0,
            integratedAt: 0n,
            hungerRemainder: 0n,
            wetnessRemainder: 0n,
          }),
        },
      },
      "archetypes/keeper.json": {
        id: "sec.keeper",
        version: 1,
        traits: [{ id: "sec.needs", version: 1 }],
        components: {},
      },
      "archetypes/crate.json": holder("sec.crate-kind", "food", 3),
      "archetypes/pond.json": holder("sec.pond-kind", "water", 5),
      "archetypes/shed.json": {
        id: "sec.shed-kind",
        version: 1,
        traits: [],
        components: {
          "clockgrove.weather-exposure": component("clockgrove.weather-exposure", {
            rainProtection: 5000,
          }),
        },
      },
      "archetypes/sprout.json": { id: "sec.sprout-kind", version: 1, traits: [], components: {} },
      "spaces/hall.json": {
        id: "sec.hall",
        version: 1,
        frame: {
          frameId: "frame-ground",
          version: 1,
          dimensions: 2,
          unit: { name: "meter", fractionalDigits: 3 },
          axes: {
            axes: [
              { name: "x", positiveDirection: "east" },
              { name: "y", positiveDirection: "north" },
            ],
          },
          origin: [0n, 0n],
          gravity: { kind: "constant-vector", vector: [0n, 0n] },
        },
        regions: [
          {
            regionId: "den",
            version: 1,
            frameId: "frame-ground",
            frameVersion: 1,
            shape: { kind: "rectangle", min: [0n, 0n], max: [2000n, 1000n] },
          },
        ],
        anchorGraph: null,
      },
      "actors/parent.json": actor("sec.parent", "sec.keeper", [10n, 20n], {
        householdId: "sec.household",
        parentIds: [],
        generation: 0,
        bornAt: 0n,
      }),
      "actors/child.json": actor("sec.child", "sec.keeper", [30n, 40n], {
        householdId: "sec.household",
        parentIds: ["sec.parent"],
        generation: 1,
        bornAt: 95000n,
      }),
      "actors/crate.json": actor("sec.crate", "sec.crate-kind", [100n, 100n]),
      "actors/pond.json": actor("sec.pond", "sec.pond-kind", [200n, 100n]),
      "actors/shed.json": actor("sec.shed", "sec.shed-kind", [300n, 100n]),
      "actors/sprout.json": actor("sec.sprout", "sec.sprout-kind", [400n, 100n]),
      "policies/clock.json": {
        type: "clockgrove.clock-policy",
        epoch: SECTION_EPOCH,
        wallEpoch: "2026-01-01T00:00:00.000Z",
        simulationMillisecondsPerWallMillisecond: 1,
        decisionIntervalMs: 60000n,
      },
      "policies/behavior.json": behavior(),
      "cognition/first.json": {
        type: "clockgrove.scripted-cognition",
        schemaVersion: 1,
        entries: [scriptedEntry("scripted:b", "belief", "sec.parent", "sec.crate", 7000)],
      },
      "cognition/second.json": {
        type: "clockgrove.scripted-cognition",
        schemaVersion: 1,
        entries: [scriptedEntry("scripted:a", "memory", "sec.child", "sec.pond", 4000)],
      },
      "cognition/other.json": { type: "clockgrove.other-cognition", note: "ignored" },
    };
    const manifest: Json = {
      schemaVersion: 2,
      id: "fixture.section-hall",
      version: "1.0.0",
      engineCompatibility: ">=1.0.0 <2.0.0",
      dependencies: [],
      components: [
        { type: "clockgrove.needs", version: 1 },
        { type: "clockgrove.resource", version: 1 },
        { type: "clockgrove.weather-exposure", version: 1 },
      ],
      archetypes: [
        { id: "sec.keeper", version: 1, path: "archetypes/keeper.json" },
        { id: "sec.crate-kind", version: 1, path: "archetypes/crate.json" },
        { id: "sec.pond-kind", version: 1, path: "archetypes/pond.json" },
        { id: "sec.shed-kind", version: 1, path: "archetypes/shed.json" },
        { id: "sec.sprout-kind", version: 1, path: "archetypes/sprout.json" },
      ],
      traits: [{ id: "sec.needs", version: 1, path: "traits/needs.json" }],
      spaces: [{ id: "sec.hall", version: 1, path: "spaces/hall.json" }],
      actors: [
        { id: "sec.parent", version: 1, path: "actors/parent.json" },
        { id: "sec.child", version: 1, path: "actors/child.json" },
        { id: "sec.crate", version: 1, path: "actors/crate.json" },
        { id: "sec.pond", version: 1, path: "actors/pond.json" },
        { id: "sec.shed", version: 1, path: "actors/shed.json" },
        { id: "sec.sprout", version: 1, path: "actors/sprout.json" },
      ],
      rules: [],
      capabilities: [],
      policies: [
        { id: "sec.clock", version: 1, path: "policies/clock.json" },
        { id: "sec.behavior", version: 1, path: "policies/behavior.json" },
      ],
      cognitiveSeeds: [
        { id: "sec.cognition-first", version: 1, path: "cognition/first.json" },
        { id: "sec.cognition-second", version: 1, path: "cognition/second.json" },
        { id: "sec.cognition-other", version: 1, path: "cognition/other.json" },
      ],
      randomStreams: [
        {
          name: "weather",
          algorithm: NAMED_RANDOM_ALGORITHM,
          algorithmVersion: 1,
          seed: "section-hall-seed",
          state: [-1, 5, -6, 7],
          draws: 0,
        },
      ],
      assets: [],
      seedCommands: [],
      migrations: [],
      expectedSeedProjectionHash: expected,
    };
    options.edit?.({ docs, manifest });
    const resources: Record<string, Uint8Array> = {};
    for (const [path, value] of Object.entries(docs)) resources[path] = encodeResource(value);
    for (const field of ["archetypes", "traits", "spaces", "actors", "rules", "policies", "cognitiveSeeds"])
      for (const item of manifest[field] as Json[]) item.sha256 = await sha256Hex(resources[item.path]!);
    return { manifest, resources, dependencyArtifacts: [] };
  };
  if (options.expectedSeedProjectionHash !== undefined)
    return assemble(options.expectedSeedProjectionHash);
  const probe = await assemble("0".repeat(64));
  const preview = await previewSeedProjection(probe, { sha256: sha256Hex });
  return preview.ok ? assemble(preview.value.actual) : probe;
}
