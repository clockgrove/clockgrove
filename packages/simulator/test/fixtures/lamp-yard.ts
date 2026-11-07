import { encodeResource, NAMED_RANDOM_ALGORITHM } from "@clockgrove/world-pack-sdk";

export type Json = Record<string, any>;

export interface FixtureSource {
  manifest: Json;
  resources: Record<string, Uint8Array>;
  dependencyArtifacts: [];
}

/**
 * Committed seed projection hashes of the lamp-yard fixture, one per version. The world identity
 * is a function of the pack id and version, so each version projects to a different hash.
 */
export const EXPECTED_SEED_PROJECTION_HASHES: Record<string, string> = {
  "1.0.0": "89a4ea27038c8dda354a5166b062bfa86d51f370de77057f389366d62c5fea6b",
  "1.1.0": "089728a25b8a8beda3efbd0f98cdc2108e8479fa36cbb43c06257d32afa625aa",
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const frame = (frameId: string) => ({
  frameId,
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
});

const space = (id: string, frameId: string, regionId: string): Json => ({
  id,
  version: 1,
  frame: frame(frameId),
  regions: [
    {
      regionId,
      version: 1,
      frameId,
      frameVersion: 1,
      shape: { kind: "rectangle", min: [0n, 0n], max: [2000n, 1000n] },
    },
  ],
  anchorGraph: null,
});

const weather = (rainIntensity: number): Json => ({ schemaVersion: 2, rainIntensity });

const actor = (id: string, placement: Json | null): Json => ({
  id,
  archetype: { id: "lamp.keeper", version: 1 },
  traits: [],
  overrides: [],
  capabilities: [{ id: "lamp.look", version: 1 }],
  ...(placement === null ? {} : { placement }),
});

export interface FixtureContext {
  docs: Record<string, unknown>;
  manifest: Json;
  assetBytes: { current: Uint8Array };
}

export interface FixtureOptions {
  version?: string;
  expectedSeedProjectionHash?: string;
  edit?: (context: FixtureContext) => void;
}

/** A small non-raccoon schema-2 pack: two spaces, three actors (two placed) and two seed commands. */
export async function buildLampYardSource(options: FixtureOptions = {}): Promise<FixtureSource> {
  const version = options.version ?? "1.0.0";
  const docs: Record<string, unknown> = {
    "traits/needs.json": {
      id: "lamp.needs",
      version: 1,
      traits: [],
      components: {
        "clockgrove.needs": {
          type: "clockgrove.needs",
          version: 1,
          state: {
            hunger: 3000,
            wetness: 0,
            integratedAt: 0n,
            hungerRemainder: 0n,
            wetnessRemainder: 0n,
          },
        },
      },
    },
    "archetypes/keeper.json": {
      id: "lamp.keeper",
      version: 1,
      traits: [{ id: "lamp.needs", version: 1 }],
      components: {},
    },
    "spaces/yard.json": space("lamp.yard", "frame-ground", "den"),
    "spaces/roof.json": space("lamp.roof", "frame-roof", "ridge"),
    "actors/keeper-one.json": actor("lamp.keeper-one", {
      space: { id: "lamp.yard", version: 1 },
      coordinates: [10n, 20n],
    }),
    "actors/keeper-two.json": actor("lamp.keeper-two", {
      space: { id: "lamp.roof", version: 1 },
      coordinates: [300n, 400n],
    }),
    "actors/statue.json": actor("lamp.statue", null),
    "policies/clock.json": {
      type: "clockgrove.clock-policy",
      epoch: 0n,
      wallEpoch: "2026-01-01T00:00:00.000Z",
      simulationMillisecondsPerWallMillisecond: 1,
      decisionIntervalMs: 60000n,
    },
    "policies/behavior.json": {
      type: "clockgrove.world-behavior-policy",
      policy: {
        schemaVersion: 1,
        version: "lamp-1",
        decisionIntervalMs: 60000n,
        hungerPerInterval: 100,
        wetnessPerInterval: 100,
        dryingPerInterval: 100,
        hungerWeight: 5000,
        shelterWeight: 5000,
      },
    },
  };
  const assetBytes = {
    current: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>lamp</title></svg>',
    ),
  };
  const manifest: Json = {
    schemaVersion: 2,
    id: "fixture.lamp-yard",
    version,
    engineCompatibility: ">=1.0.0 <2.0.0",
    dependencies: [],
    components: [{ type: "clockgrove.needs", version: 1 }],
    archetypes: [{ id: "lamp.keeper", version: 1, path: "archetypes/keeper.json" }],
    traits: [{ id: "lamp.needs", version: 1, path: "traits/needs.json" }],
    spaces: [
      { id: "lamp.yard", version: 1, path: "spaces/yard.json" },
      { id: "lamp.roof", version: 1, path: "spaces/roof.json" },
    ],
    actors: [
      { id: "lamp.keeper-one", version: 1, path: "actors/keeper-one.json" },
      { id: "lamp.keeper-two", version: 1, path: "actors/keeper-two.json" },
      { id: "lamp.statue", version: 1, path: "actors/statue.json" },
    ],
    rules: [],
    capabilities: [
      {
        id: "lamp.look",
        version: 1,
        kind: "inspect",
        commands: [{ type: "world.weather.set", version: 2 }],
      },
    ],
    policies: [
      { id: "lamp.clock", version: 1, path: "policies/clock.json" },
      { id: "lamp.behavior", version: 1, path: "policies/behavior.json" },
    ],
    cognitiveSeeds: [],
    randomStreams: [
      {
        name: "weather",
        algorithm: NAMED_RANDOM_ALGORITHM,
        algorithmVersion: 1,
        seed: "lamp-yard-seed",
        state: [-1, 5, -6, 7],
        draws: 0,
      },
    ],
    assets: [
      {
        id: "lamp.badge",
        version: 1,
        path: "assets/lamp.svg",
        mediaType: "image/svg+xml",
        license: "CC0-1.0",
        provenance: { source: "clockgrove-fixture", method: "hand-authored", reviewStatus: "approved" },
        generation: null,
        dimensions: null,
        anchors: [],
        footprint: null,
      },
    ],
    seedCommands: [
      { key: "lamp.drizzle", type: "world.weather.set", version: 2, payload: weather(2500) },
      { key: "lamp.downpour", type: "world.weather.set", version: 2, payload: weather(7500) },
    ],
    migrations: [],
    expectedSeedProjectionHash:
      options.expectedSeedProjectionHash ??
      EXPECTED_SEED_PROJECTION_HASHES[version] ??
      "0".repeat(64),
  };
  options.edit?.({ docs, manifest, assetBytes });

  const resources: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(docs)) resources[path] = encodeResource(value);
  for (const field of ["archetypes", "traits", "spaces", "actors", "rules", "policies"])
    for (const item of manifest[field] as Json[]) item.sha256 = await sha256Hex(resources[item.path]!);
  for (const item of manifest.assets as Json[]) {
    resources[item.path] = assetBytes.current;
    item.sha256 = await sha256Hex(assetBytes.current);
    item.byteLength = assetBytes.current.byteLength;
  }
  return { manifest, resources, dependencyArtifacts: [] };
}

/** Same facts, different incidental order: every manifest list but seedCommands, and the inventory. */
export function reorderSource(source: FixtureSource): FixtureSource {
  const manifest: Json = {};
  for (const key of Object.keys(source.manifest).reverse()) {
    const value = source.manifest[key];
    manifest[key] =
      Array.isArray(value) && key !== "seedCommands" ? structuredClone(value).reverse() : value;
  }
  const resources: Record<string, Uint8Array> = {};
  for (const key of Object.keys(source.resources).reverse())
    resources[key] = source.resources[key]!.slice();
  return { manifest, resources, dependencyArtifacts: [] };
}
