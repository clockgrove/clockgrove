import {
  decodeResource,
  encodeResource,
  NAMED_RANDOM_ALGORITHM,
  type WorldPackPorts,
} from "@clockgrove/world-pack-sdk";
import { canonicalBytes } from "../../src/canonical.js";
import { initializeNamedRandomStreams } from "../../src/index.js";

export type PackName = "weather" | "lantern";
export interface PackSource {
  manifest: Record<string, unknown>;
  resources: Record<string, unknown>;
  dependencyArtifacts: unknown[];
}
type Json = Record<string, unknown>;

/** Two independent packs: different identities, vocabulary, clock policies and seeds. */
export const packSpecs = {
  weather: {
    packId: "clockgrove.pack.weather-rain",
    prefix: "weather",
    needsPrefix: "routine",
    resident: "weather.subject",
    seed: "weather-installation-1",
    epoch: 0n,
    wallEpoch: "2026-01-01T00:00:00.000Z",
    ratio: 1,
    interval: 60000n,
  },
  lantern: {
    packId: "clockgrove.pack.lantern-vigil",
    prefix: "lantern",
    needsPrefix: "vigil",
    resident: "lantern.mae",
    seed: "lantern-installation-1",
    epoch: 86400000n,
    wallEpoch: "2026-03-01T12:00:00.000Z",
    ratio: 60,
    interval: 30000n,
  },
} as const;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const packPorts: WorldPackPorts = { canonicalBytes, sha256: sha256Hex };

const streamNames = ["behavior", "lifecycle", "weather"] as const;

/** Random streams recorded from the kernel's installation initializer, cross-checking the SDK. */
export function randomStreamSeeds(seed: string) {
  const initial = initializeNamedRandomStreams({ version: 1, seed }, streamNames);
  return streamNames.map((name) => ({
    name,
    algorithm: NAMED_RANDOM_ALGORITHM,
    algorithmVersion: 1,
    seed,
    state: initial[name]!.state.map(Number),
    draws: 0,
  }));
}

const snapshot = (type: string, state: unknown) => ({ type, version: 1, state });
const ref = (id: string, version = 1) => ({ id, version });
const text = (value: string) => new TextEncoder().encode(value);
const badge = (label: string) =>
  text(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>${label}</title></svg>`,
  );

export interface FixtureOptions {
  readonly packId?: string;
  readonly version?: string;
  readonly dependencies?: readonly { id: string; versionRange: string }[];
  readonly dependencyArtifacts?: readonly unknown[];
}

export async function buildFixtureSource(
  name: PackName,
  options: FixtureOptions = {},
): Promise<PackSource> {
  const spec = packSpecs[name];
  const needs = `${spec.needsPrefix}.needs`;
  const shelter = `${spec.needsPrefix}.shelter`;
  const resident = `${spec.prefix}.resident`;
  const cover = `${spec.prefix}.cover`;
  const actorDocuments: [string, string, string, unknown[]][] = [
    [spec.resident, "actors/resident.json", resident, []],
    [`${spec.prefix}.primary-cover`, "actors/primary-cover.json", cover, []],
    [
      `${spec.prefix}.secondary-cover`,
      "actors/secondary-cover.json",
      cover,
      [snapshot("clockgrove.weather-exposure", { rainProtection: 7500 })],
    ],
  ];
  const documents: Record<string, unknown> = {
    "traits/needs.json": {
      id: needs,
      version: 1,
      traits: [],
      components: {
        "clockgrove.needs": snapshot("clockgrove.needs", {
          hunger: 3000,
          wetness: 0,
          integratedAt: 0n,
          hungerRemainder: 0n,
          wetnessRemainder: 0n,
        }),
      },
    },
    "traits/shelter.json": {
      id: shelter,
      version: 1,
      traits: [],
      components: {
        "clockgrove.weather-exposure": snapshot("clockgrove.weather-exposure", {
          rainProtection: 10000,
        }),
      },
    },
    "archetypes/resident.json": { id: resident, version: 1, traits: [ref(needs)], components: {} },
    "archetypes/cover.json": { id: cover, version: 1, traits: [ref(shelter)], components: {} },
    "policies/clock.json": {
      type: "clockgrove.clock-policy",
      epoch: spec.epoch,
      wallEpoch: spec.wallEpoch,
      simulationMillisecondsPerWallMillisecond: spec.ratio,
      decisionIntervalMs: spec.interval,
    },
    "cognition/persona.json": { id: `${spec.prefix}.persona`, temperament: "careful" },
  };
  for (const [id, path, archetype, overrides] of actorDocuments)
    documents[path] = {
      id,
      archetype: ref(archetype),
      traits: [],
      overrides,
      capabilities: [],
    };
  const resources: Record<string, unknown> = {};
  for (const [path, document] of Object.entries(documents))
    resources[path] = encodeResource(document);
  const assetBytes = badge(spec.prefix);
  resources["assets/badge.svg"] = assetBytes;
  const entry = async (id: string, path: string) => ({
    id,
    version: 1,
    path,
    sha256: await sha256Hex(resources[path] as Uint8Array),
  });
  const randomStreams = randomStreamSeeds(spec.seed);
  const manifest: Json = {
    schemaVersion: 1,
    id: options.packId ?? spec.packId,
    version: options.version ?? "1.0.0",
    engineCompatibility: ">=1.0.0 <2.0.0",
    dependencies: [...(options.dependencies ?? [])],
    components: [
      { type: "clockgrove.needs", version: 1 },
      { type: "clockgrove.weather-exposure", version: 1 },
    ],
    archetypes: [
      await entry(resident, "archetypes/resident.json"),
      await entry(cover, "archetypes/cover.json"),
    ],
    traits: [await entry(needs, "traits/needs.json"), await entry(shelter, "traits/shelter.json")],
    spaces: [],
    actors: await Promise.all(actorDocuments.map(([id, path]) => entry(id, path))),
    rules: [],
    capabilities: [],
    policies: [await entry(`${spec.prefix}.clock`, "policies/clock.json")],
    cognitiveSeeds: [await entry(`${spec.prefix}.persona`, "cognition/persona.json")],
    randomStreams,
    assets: [
      {
        ...(await entry(`${spec.prefix}.badge`, "assets/badge.svg")),
        mediaType: "image/svg+xml",
        byteLength: assetBytes.byteLength,
        license: "CC0-1.0",
        provenance: {
          source: "clockgrove-fixture",
          method: "hand-authored",
          reviewStatus: "approved",
        },
      },
    ],
    seedCommands: [],
    migrations: [],
    expectedSeedProjectionHash: await sha256Hex(canonicalBytes(randomStreams)),
  };
  return { manifest, resources, dependencyArtifacts: [...(options.dependencyArtifacts ?? [])] };
}

export function cloneSource(source: PackSource): PackSource {
  const resources: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(source.resources))
    resources[path] = value instanceof Uint8Array ? value.slice() : value;
  return {
    manifest: structuredClone(source.manifest),
    resources,
    dependencyArtifacts: structuredClone(source.dependencyArtifacts),
  };
}

export function list(source: PackSource, field: string): Json[] {
  return source.manifest[field] as Json[];
}

/** Replace resource bytes and keep every manifest pin (hash, and asset length) consistent. */
export async function repin(source: PackSource, path: string, bytes: Uint8Array): Promise<void> {
  source.resources[path] = bytes;
  const digest = await sha256Hex(bytes);
  for (const field of ["archetypes", "traits", "actors", "policies", "cognitiveSeeds", "assets"])
    for (const item of list(source, field))
      if (item.path === path) {
        item.sha256 = digest;
        if (field === "assets") item.byteLength = bytes.byteLength;
      }
}

export async function rewriteResource(
  source: PackSource,
  path: string,
  edit: (document: Json) => void,
): Promise<PackSource> {
  const next = cloneSource(source);
  const document = decodeResource(next.resources[path] as Uint8Array, path) as Json;
  edit(document);
  await repin(next, path, encodeResource(document));
  return next;
}

/** Same facts, different incidental order: manifest keys, lists and resource inventory. */
export function reorderSource(source: PackSource): PackSource {
  const next = cloneSource(source);
  const manifest: Json = {};
  for (const key of Object.keys(next.manifest).reverse()) {
    const value = next.manifest[key];
    manifest[key] = Array.isArray(value) ? [...value].reverse() : value;
  }
  const resources: Record<string, unknown> = {};
  for (const key of Object.keys(next.resources).reverse()) resources[key] = next.resources[key];
  return { manifest, resources, dependencyArtifacts: next.dependencyArtifacts };
}

export function newerVersion(source: PackSource, version: string): PackSource {
  const next = cloneSource(source);
  next.manifest.version = version;
  return next;
}
