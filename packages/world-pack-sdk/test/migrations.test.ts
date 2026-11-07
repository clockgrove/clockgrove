import { describe, expect, it } from "vitest";

// No committed pack declares migrations, so nothing else reaches them: this keeps the chain refusals,
// the hashing of the migration set and the resumable migration plan.
import {
  buildWorldPack,
  encodeResource,
  NAMED_RANDOM_ALGORITHM,
  planWorldPackMigration,
  type ValidatedWorldPack,
  validateWorldPack,
  type WorldPackPorts,
} from "../src/index.js";

const ports: WorldPackPorts = {
  canonicalBytes: encodeResource,
  commandCatalog: [
    { type: "world.move", version: 1 },
    { type: "world.say", version: 1 },
  ],
  async sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  },
};

type Json = Record<string, any>;
interface Context {
  docs: Record<string, any>;
  manifest: Json;
}

const MIG_A = "migrations/a.json";
const MIG_B = "migrations/b.json";

const migrationDocs = (): Record<string, Json> => ({
  [MIG_A]: {
    id: "unit.mig-a",
    version: 1,
    fromPackVersion: "1.0.0",
    toPackVersion: "1.1.0",
    steps: [
      { key: "unit.first", type: "world.move", version: 1, payload: { to: 1n, name: "a" } },
      { key: "unit.second", type: "world.say", version: 1, payload: { text: "hi", list: [1] } },
    ],
  },
  [MIG_B]: {
    id: "unit.mig-b",
    version: 1,
    fromPackVersion: "1.1.0",
    toPackVersion: "2.0.0",
    steps: [{ key: "unit.third", type: "world.say", version: 1, payload: {} }],
  },
});

async function source(edit: (context: Context) => void = () => undefined) {
  const docs: Record<string, any> = {
    "policies/clock.json": {
      type: "clockgrove.clock-policy",
      epoch: 0n,
      wallEpoch: "2026-01-01T00:00:00.000Z",
      simulationMillisecondsPerWallMillisecond: 1,
      decisionIntervalMs: 60000n,
    },
    ...migrationDocs(),
  };
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
    version: "2.0.0",
    engineCompatibility: ">=1.0.0 <2.0.0",
    dependencies: [],
    components: [],
    archetypes: [],
    traits: [],
    spaces: [],
    actors: [],
    rules: [],
    capabilities: [],
    policies: [{ id: "unit.clock", version: 1, path: "policies/clock.json" }],
    cognitiveSeeds: [],
    randomStreams,
    assets: [],
    seedCommands: [],
    migrations: [
      { id: "unit.mig-a", version: 1, path: MIG_A },
      { id: "unit.mig-b", version: 1, path: MIG_B },
    ],
    expectedSeedProjectionHash: await ports.sha256(ports.canonicalBytes(randomStreams)),
  };
  edit({ docs, manifest });
  const resources: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(docs)) resources[path] = encodeResource(value);
  for (const field of ["policies", "migrations"])
    for (const item of manifest[field] as Json[])
      item.sha256 = await ports.sha256(resources[item.path]!);
  return { manifest, resources, dependencyArtifacts: [] as [] };
}

const refusal = (code: string, path: string) => ({
  ok: false,
  error: { code, path, message: expect.any(String) },
});

async function built(edit?: (context: Context) => void) {
  const result = await buildWorldPack(await source(edit), ports);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}`);
  return result.value;
}

const refused = async (edit: (context: Context) => void) =>
  await buildWorldPack(await source(edit), ports);

async function validated(): Promise<ValidatedWorldPack> {
  const result = await validateWorldPack(await source(), ports);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}`);
  return result.value;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("migration declarations", () => {
  it.each<[string, string, (context: Context) => void]>([
    [
      "INVALID_MIGRATION",
      "manifest.migrations[0].toPackVersion",
      ({ docs }) => (docs[MIG_A]!.toPackVersion = "2.0.1"),
    ],
    [
      "AMBIGUOUS_MIGRATION",
      "manifest.migrations[1]",
      ({ docs }) => (docs[MIG_B]!.fromPackVersion = "1.0.0"),
    ],
    [
      "MIGRATION_GAP",
      "manifest.migrations[0].toPackVersion",
      ({ docs }) => (docs[MIG_A]!.toPackVersion = "1.0.5"),
    ],
    [
      "UNKNOWN_COMMAND",
      "manifest.migrations[0]#steps[0].type",
      ({ docs }) => (docs[MIG_A]!.steps[0].type = "world.nope"),
    ],
  ])("refuses %s at %s", async (code, path, edit) => {
    expect(await refused(edit)).toEqual(refusal(code, path));
  });

  it("hashes the migration set into the content hash independent of manifest order", async () => {
    const base = await built();
    const changed = await built(({ docs }) => (docs[MIG_B]!.steps[0].payload = { a: 1 }));
    expect(changed.artifact.migrationSetHash).not.toBe(base.artifact.migrationSetHash);
    expect(changed.artifact.contentHash).not.toBe(base.artifact.contentHash);
    const reversed = await built(({ manifest }) => manifest.migrations.reverse());
    expect(reversed.artifact).toEqual(base.artifact);
    expect(hex(reversed.bytes.migrationSet)).toBe(hex(base.bytes.migrationSet));
  });
});

describe("planWorldPackMigration", () => {
  it("plans the chain in order and resumes at every cursor", async () => {
    const pack = await validated();
    const full = planWorldPackMigration(pack, "1.0.0", 0);
    if (!full.ok) throw new Error(full.error.code);
    expect(full.value.map((step) => step.stepId)).toEqual([
      "unit.mig-a@1/unit.first",
      "unit.mig-a@1/unit.second",
      "unit.mig-b@1/unit.third",
    ]);
    expect(full.value[0]).toEqual({
      stepId: "unit.mig-a@1/unit.first",
      fromPackVersion: "1.0.0",
      toPackVersion: "1.1.0",
      type: "world.move",
      version: 1,
      payload: { to: 1n, name: "a" },
    });
    for (let k = 0; k <= full.value.length; k += 1)
      expect(planWorldPackMigration(pack, "1.0.0", k)).toEqual({
        ok: true,
        value: full.value.slice(k),
      });
    expect(planWorldPackMigration(pack, "2.0.0", 0)).toEqual({ ok: true, value: [] });
  });

  it("refuses an undeclared origin and an invalid cursor", async () => {
    const pack = await validated();
    expect(planWorldPackMigration(pack, "0.9.0", 0)).toEqual(
      refusal("UNSUPPORTED_MIGRATION", "fromPackVersion"),
    );
    for (const cursor of [-1, 1.5, 4])
      expect(planWorldPackMigration(pack, "1.0.0", cursor)).toEqual(
        refusal("INVALID_MIGRATION_CURSOR", "completedSteps"),
      );
  });
});
