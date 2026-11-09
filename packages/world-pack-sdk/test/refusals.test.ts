import { describe, expect, it } from "vitest";

// Committed packs are valid, so pack conformance never reaches a refusal. This file keeps one case per
// published refusal code (docs/refusal-codes.md) and the artifact identity properties no golden covers.
import {
  buildWorldPack,
  encodeResource,
  NAMED_RANDOM_ALGORITHM,
  type WorldPackPorts,
} from "../src/index.js";

const catalog = [
  { type: "world.move", version: 1 },
  { type: "world.say", version: 1 },
];

const ports: WorldPackPorts = {
  canonicalBytes: encodeResource,
  commandCatalog: catalog,
  async sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  },
};

type Json = Record<string, any>;

interface Context {
  docs: Record<string, unknown>;
  manifest: Json;
}

const frame = () => ({
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
});

const space = (): Json => ({
  id: "unit.hall",
  version: 1,
  frame: frame(),
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
});

const rule = (): Json => ({
  schemaVersion: 1,
  id: "unit.chime",
  version: 1,
  trigger: { kind: "event", eventType: "needs.changed", eventVersion: 1 },
  bindings: [],
  condition: null,
  intents: [
    {
      commandType: "world.move",
      commandVersion: 1,
      payload: { x: { op: "literal", type: "integer", value: 1n } },
    },
  ],
  budget: { maxFanout: 2, maxDepth: 3, cooldownMs: 5n },
});

const behavior = (): Json => ({
  type: "clockgrove.world-behavior-policy",
  policy: {
    schemaVersion: 1,
    version: "unit-1",
    decisionIntervalMs: 60000n,
    hungerPerInterval: 100,
    wetnessPerInterval: 100,
    dryingPerInterval: 100,
    hungerWeight: 5000,
    shelterWeight: 5000,
  },
});

const capability = (): Json => ({
  id: "unit.look",
  version: 1,
  kind: "inspect",
  commands: [{ type: "world.say", version: 1 }],
});

const seeds = (): Json[] => [
  { key: "unit.first", type: "world.move", version: 1, payload: { to: 1n, name: "a" } },
  { key: "unit.second", type: "world.say", version: 1, payload: { text: "hi", list: [1, 2] } },
];

async function build(edit: (context: Context) => void = () => undefined) {
  const docs: Record<string, unknown> = {
    "traits/needs.json": {
      id: "unit.needs",
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
    "archetypes/resident.json": {
      id: "unit.resident",
      version: 1,
      traits: [{ id: "unit.needs", version: 1 }],
      components: {},
    },
    "spaces/hall.json": space(),
    "rules/chime.json": rule(),
    "actors/resident.json": {
      id: "unit.actor",
      archetype: { id: "unit.resident", version: 1 },
      traits: [],
      overrides: [],
      capabilities: [{ id: "unit.look", version: 1 }],
      placement: { space: { id: "unit.hall", version: 1 }, coordinates: [10n, 20n] },
    },
    "policies/clock.json": {
      type: "clockgrove.clock-policy",
      epoch: 0n,
      wallEpoch: "2026-01-01T00:00:00.000Z",
      simulationMillisecondsPerWallMillisecond: 1,
      decisionIntervalMs: 60000n,
    },
    "policies/behavior.json": behavior(),
  };
  const svg = new TextEncoder().encode("<svg/>");
  const randomStreams = [
    {
      name: "weather",
      algorithm: NAMED_RANDOM_ALGORITHM,
      algorithmVersion: 1,
      seed: "unit-seed",
      state: [-1, 5, -6, 0],
      draws: 0,
    },
  ];
  const manifest: Json = {
    schemaVersion: 2,
    id: "unit.pack",
    version: "1.0.0",
    engineCompatibility: ">=1.0.0 <2.0.0",
    dependencies: [],
    components: [{ type: "clockgrove.needs", version: 1 }],
    archetypes: [{ id: "unit.resident", version: 1, path: "archetypes/resident.json" }],
    traits: [{ id: "unit.needs", version: 1, path: "traits/needs.json" }],
    spaces: [{ id: "unit.hall", version: 1, path: "spaces/hall.json" }],
    actors: [{ id: "unit.actor", version: 1, path: "actors/resident.json" }],
    rules: [{ id: "unit.chime", version: 1, path: "rules/chime.json" }],
    capabilities: [capability()],
    policies: [
      { id: "unit.clock", version: 1, path: "policies/clock.json" },
      { id: "unit.behavior", version: 1, path: "policies/behavior.json" },
    ],
    cognitiveSeeds: [],
    randomStreams,
    assets: [
      {
        id: "unit.badge",
        version: 1,
        path: "assets/badge.svg",
        sha256: await ports.sha256(svg),
        mediaType: "image/svg+xml",
        byteLength: svg.byteLength,
        license: "CC0-1.0",
        provenance: { source: "unit", method: "hand-authored", reviewStatus: "approved" },
        generation: null,
        dimensions: { width: 64, height: 32 },
        anchors: [],
        footprint: null,
      },
    ],
    seedCommands: seeds(),
    migrations: [],
    expectedSeedProjectionHash: await ports.sha256(ports.canonicalBytes(randomStreams)),
  };
  edit({ docs, manifest });
  const resources: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(docs)) resources[path] = encodeResource(value);
  resources["assets/badge.svg"] = svg;
  for (const field of ["archetypes", "traits", "spaces", "actors", "rules", "policies"] as const)
    for (const item of manifest[field] as Json[])
      item.sha256 = await ports.sha256(resources[item.path]!);
  return { manifest, resources, dependencyArtifacts: [] as [] };
}

const refusal = (code: string, path: string) => ({
  ok: false,
  error: { code, path, message: expect.any(String) },
});

async function built(edit?: (context: Context) => void) {
  const result = await buildWorldPack(await build(edit), ports);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}`);
  return result.value;
}

type Case = [code: string, path: string, edit: (context: Context) => void];
const doc = (context: Context, path: string): Json => context.docs[path] as Json;
const actor = (context: Context): Json => doc(context, "actors/resident.json");
const behaviorPolicy = (context: Context): Json => doc(context, "policies/behavior.json").policy;

const cases: Case[] = [
  [
    "UNSUPPORTED_SCHEMA_VERSION",
    "manifest.schemaVersion",
    ({ manifest }) => (manifest.schemaVersion = 99),
  ],
  ["MALFORMED_RESOURCE", "manifest.actors[0].archetype", (c) => (actor(c).archetype = null)],
  [
    "MALFORMED_RESOURCE",
    "manifest.actors[0]#lifecycle.parentIds",
    (c) =>
      (actor(c).lifecycle = {
        householdId: "den",
        parentIds: ["unit.b", "unit.a"],
        generation: 2,
        bornAt: 5n,
      }),
  ],
  [
    "RESOURCE_IDENTITY_MISMATCH",
    "manifest.spaces[0]",
    (c) => (doc(c, "spaces/hall.json").id = "unit.other"),
  ],
  [
    "UNKNOWN_FIELD",
    "manifest.spaces[0].colour",
    (c) => (doc(c, "spaces/hall.json").colour = "red"),
  ],
  [
    "UNKNOWN_PARENT",
    "manifest.spaces[0].parent",
    (c) => (doc(c, "spaces/hall.json").parent = { id: "unit.town", version: 1 }),
  ],
  [
    "UNKNOWN_PARENT",
    "manifest.spaces[0]#regions[0].parent.regionId",
    (c) => (doc(c, "spaces/hall.json").regions[0].parent = { regionId: "porch", version: 1 }),
  ],
  [
    "PARENT_CYCLE",
    "manifest.spaces[0]#regions[0].parent",
    (c) => (doc(c, "spaces/hall.json").regions[0].parent = { regionId: "den", version: 1 }),
  ],
  [
    "INVALID_RULE",
    "manifest.rules[0]#rule.intents[0].commandType",
    (c) => (doc(c, "rules/chime.json").intents[0].commandVersion = 7),
  ],
  [
    "INVALID_CAPABILITY",
    "manifest.capabilities[0].kind",
    ({ manifest }) => (manifest.capabilities[0].kind = "teleport"),
  ],
  [
    "UNKNOWN_COMMAND",
    "manifest.capabilities[0].commands[0]",
    ({ manifest }) => (manifest.capabilities[0].commands = [{ type: "world.fly", version: 1 }]),
  ],
  [
    "DUPLICATE_IDENTITY",
    "manifest.capabilities[1]",
    ({ manifest }) => manifest.capabilities.push(capability()),
  ],
  [
    "UNKNOWN_CAPABILITY",
    "manifest.actors[0].capabilities[0]",
    (c) => (actor(c).capabilities = [{ id: "unit.ghost", version: 1 }]),
  ],
  [
    "INVALID_SEED_COMMAND",
    "manifest.seedCommands[0].payload",
    ({ manifest }) => (manifest.seedCommands[0].payload = { run: () => 1 }),
  ],
  [
    "LIMIT_EXCEEDED",
    "manifest.seedCommands",
    ({ manifest }) =>
      (manifest.seedCommands = Array.from({ length: 1025 }, (_, i) => ({
        key: `unit.k${i}`,
        type: "world.move",
        version: 1,
        payload: {},
      }))),
  ],
  [
    "INVALID_POLICY",
    "manifest.policies[1]#policy.hungerWieght",
    (c) => (behaviorPolicy(c).hungerWieght = 5000),
  ],
  [
    "DUPLICATE_POLICY",
    "manifest.policies[2]",
    ({ docs, manifest }) => {
      docs["policies/behavior2.json"] = behavior();
      manifest.policies.push({ id: "unit.behavior2", version: 1, path: "policies/behavior2.json" });
    },
  ],
  [
    "UNSUPPORTED_POLICY",
    "manifest.policies[1]",
    ({ docs }) => (docs["policies/behavior.json"] = { type: "other.policy" }),
  ],
  [
    "UNKNOWN_SPACE",
    "manifest.actors[0].placement.space",
    (c) => (actor(c).placement.space = { id: "unit.nowhere", version: 1 }),
  ],
  [
    "INVALID_PLACEMENT",
    "manifest.actors[0].placement.coordinates",
    (c) => (actor(c).placement.coordinates = [2001n, 20n]),
  ],
  [
    "INVALID_ASSET",
    "manifest.assets[0].anchors[0].x",
    ({ manifest }) => (manifest.assets[0].anchors = [{ name: "a", x: 65, y: 0 }]),
  ],
  [
    "INVALID_PROVENANCE",
    "manifest.assets[0].generation.parametersSha256",
    ({ manifest }) =>
      (manifest.assets[0].generation = {
        provider: "p",
        model: "m",
        parametersSha256: "A".repeat(64),
      }),
  ],
];

describe("world pack refusals", () => {
  it.each(cases)("refuses %s at %s", async (code, path, edit) => {
    expect(await buildWorldPack(await build(edit), ports)).toEqual(refusal(code, path));
  });

  it("states the declared and actual hash of a tampered resource", async () => {
    const source = await build();
    const bytes = source.resources["assets/badge.svg"]!.slice();
    bytes[1] = 0x58;
    source.resources["assets/badge.svg"] = bytes;
    const declared = (source.manifest.assets as Json[])[0]!.sha256;
    expect(await buildWorldPack(source, ports)).toEqual({
      ok: false,
      error: {
        code: "HASH_MISMATCH",
        path: "manifest.assets[0].sha256",
        message: `declared hash differs from the supplied bytes: expected ${declared}, actual ${await ports.sha256(bytes)}`,
      },
    });
  });

  it("never throws for hostile sources and fails closed without a command catalog", async () => {
    for (const hostile of [null, undefined, 1, "x", [], {}, { manifest: null }])
      expect((await buildWorldPack(hostile, ports)).ok).toBe(false);
    const { commandCatalog: _omitted, ...bare } = ports;
    expect(await buildWorldPack(await build(), bare)).toEqual(
      refusal("UNKNOWN_COMMAND", "manifest.capabilities[0].commands[0]"),
    );
  });

  it("accepts a placement on a region boundary", async () => {
    await built((c) => (actor(c).placement.coordinates = [2000n, 1000n]));
  });
});

describe("artifact identity", () => {
  it("binds every collection into the content hash and keeps seed command order", async () => {
    const base = (await built()).artifact.contentHash;
    const edits: ((context: Context) => void)[] = [
      (c) => (doc(c, "spaces/hall.json").regions[0].shape.max = [3000n, 1000n]),
      (c) => (doc(c, "rules/chime.json").budget.maxFanout = 3),
      ({ manifest }) => (manifest.capabilities[0].kind = "influence"),
      ({ manifest }) => manifest.seedCommands.reverse(),
      ({ manifest }) => (manifest.assets[0].dimensions = { width: 64, height: 33 }),
    ];
    for (const edit of edits) expect((await built(edit)).artifact.contentHash).not.toBe(base);
  });
});
