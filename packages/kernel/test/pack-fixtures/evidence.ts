import { buildWorldPack, type WorldPackArtifactRef } from "@clockgrove/world-pack-sdk";
import { canonicalBytes } from "../../src/canonical.js";
import {
  buildFixtureSource,
  cloneSource,
  list,
  newerVersion,
  type PackSource,
  packPorts,
  packSpecs,
  reorderSource,
  repin,
  rewriteResource,
  sha256Hex,
} from "./index.js";

export interface InputIdentity {
  readonly manifestSha256: string;
  readonly resources: readonly { path: string; sha256: string; byteLength: number }[];
  readonly dependencyArtifacts: readonly string[];
  readonly identityHash: string;
}

export type OutputSummary =
  | { readonly ok: false; readonly code: string; readonly path: string }
  | {
      readonly ok: true;
      readonly artifact: WorldPackArtifactRef;
      readonly byteHashes: {
        readonly artifact: string;
        readonly content: string;
        readonly resourceManifest: string;
        readonly assetManifest: string;
        readonly migrationSet: string;
      };
    };

/** Every output is paired with the complete identity of the input that produced it. */
export interface PackCase {
  readonly input: InputIdentity;
  readonly output: OutputSummary;
}

const textBytes = (value: string) => new TextEncoder().encode(value);

async function canonicalDigest(value: unknown): Promise<string> {
  try {
    return await sha256Hex(canonicalBytes(value));
  } catch {
    return sha256Hex(textBytes("uncanonical"));
  }
}

export async function describeInput(source: PackSource): Promise<InputIdentity> {
  const manifestSha256 = await canonicalDigest(source.manifest);
  const resources = await Promise.all(
    Object.keys(source.resources)
      .sort()
      .map(async (path) => {
        const value = source.resources[path];
        return value instanceof Uint8Array
          ? { path, sha256: await sha256Hex(value), byteLength: value.byteLength }
          : { path, sha256: await sha256Hex(textBytes(String(value))), byteLength: -1 };
      }),
  );
  const dependencyArtifacts = await Promise.all(source.dependencyArtifacts.map(canonicalDigest));
  const identityHash = await canonicalDigest({ manifestSha256, resources, dependencyArtifacts });
  return { manifestSha256, resources, dependencyArtifacts, identityHash };
}

export async function buildCase(source: PackSource): Promise<PackCase> {
  const input = await describeInput(source);
  const result = await buildWorldPack(source, packPorts);
  if (!result.ok)
    return { input, output: { ok: false, code: result.error.code, path: result.error.path } };
  const { bytes, artifact } = result.value;
  return {
    input,
    output: {
      ok: true,
      artifact: { ...artifact },
      byteHashes: {
        artifact: await sha256Hex(bytes.artifact),
        content: await sha256Hex(bytes.content),
        resourceManifest: await sha256Hex(bytes.resourceManifest),
        assetManifest: await sha256Hex(bytes.assetManifest),
        migrationSet: await sha256Hex(bytes.migrationSet),
      },
    },
  };
}

type Mutation = (source: PackSource) => Promise<PackSource> | PackSource;
type Json = Record<string, unknown>;

const edited = (edit: (source: PackSource) => void): Mutation => {
  return (source) => {
    const next = cloneSource(source);
    edit(next);
    return next;
  };
};
const resource = (path: string, edit: (document: Json) => void): Mutation => {
  return (source) => rewriteResource(source, path, edit);
};
const actor = (path: string, edit: (document: Json) => void) =>
  resource(`actors/${path}.json`, edit);

/** Stable refusal code and path expected for each refusal mutation below, in order. */
export const expectedPackRefusals: Record<string, readonly [string, string]> = {
  "hash-mismatch": ["HASH_MISMATCH", "manifest.assets[0].sha256"],
  "missing-resource": ["MISSING_RESOURCE", "manifest.assets[0].path"],
  "unreferenced-resource": ["UNREFERENCED_RESOURCE", 'resources["extra/unused.txt"]'],
  "unknown-manifest-field": ["UNKNOWN_FIELD", "manifest.extra"],
  "unsupported-schema-version": ["UNSUPPORTED_SCHEMA_VERSION", "manifest.schemaVersion"],
  "engine-incompatible": ["ENGINE_INCOMPATIBLE", "manifest.engineCompatibility"],
  "undeclared-component": [
    "UNDECLARED_COMPONENT",
    'manifest.traits[1]#components["clockgrove.weather-exposure"]',
  ],
  "invalid-clock-ratio": [
    "INVALID_CLOCK_POLICY",
    "manifest.policies[0].simulationMillisecondsPerWallMillisecond",
  ],
  "missing-clock-policy": ["MISSING_CLOCK_POLICY", "manifest.policies"],
  "zero-random-state": ["INVALID_RANDOM_STREAM", "manifest.randomStreams[0].state"],
  "invalid-license": ["INVALID_LICENSE", "manifest.assets[0].license"],
  "unsupported-capability": ["UNSUPPORTED_CAPABILITY", "manifest.rules[0]"],
  "duplicate-identity": ["DUPLICATE_IDENTITY", "manifest.traits[2]"],
  "unknown-component-version": ["UNKNOWN_COMPONENT_VERSION", "manifest.components[0].version"],
  "unknown-pack-version": ["INVALID_VERSION", "manifest.version"],
  "dependency-cycle": ["DEPENDENCY_CYCLE", "manifest.dependencies[0].id"],
  "missing-definition": [
    "MISSING_DEFINITION",
    'manifest.archetypes[0]#traits[["routine.ghost",1]]',
  ],
  "definition-cycle": ["DEFINITION_CYCLE", 'manifest.archetypes[0]#traits[["routine.needs",1]]'],
  "invalid-override": [
    "INVALID_OVERRIDE",
    'manifest.actors[2]#definition.overrides["clockgrove.weather-exposure"].state.rainProtection',
  ],
  "malformed-source": ["MALFORMED_SOURCE", "manifest"],
  "malformed-resource-bytes": ["MALFORMED_RESOURCE", "manifest.cognitiveSeeds[0]"],
  "resource-not-bytes": ["MALFORMED_SOURCE", 'resources["assets/badge.svg"]'],
  "escaping-resource-path": ["INVALID_RESOURCE_PATH", 'resources["../escape"]'],
  "actor-archetype-null": ["MALFORMED_RESOURCE", "manifest.actors[0].archetype"],
  "actor-traits-number": ["MALFORMED_RESOURCE", "manifest.actors[0].traits"],
  "actor-traits-object": ["MALFORMED_RESOURCE", "manifest.actors[0].traits"],
};

/** Each case starts from the valid weather pack and must be refused with a stable code and path. */
export const refusalMutations: readonly (readonly [string, Mutation])[] = [
  [
    "hash-mismatch",
    edited((source) => {
      const bytes = (source.resources["assets/badge.svg"] as Uint8Array).slice();
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      source.resources["assets/badge.svg"] = bytes;
    }),
  ],
  [
    "missing-resource",
    edited((source) => {
      delete source.resources["assets/badge.svg"];
    }),
  ],
  [
    "unreferenced-resource",
    edited((source) => {
      source.resources["extra/unused.txt"] = textBytes("unused");
    }),
  ],
  [
    "unknown-manifest-field",
    edited((source) => {
      source.manifest.extra = 1;
    }),
  ],
  [
    "unsupported-schema-version",
    edited((source) => {
      source.manifest.schemaVersion = 99;
    }),
  ],
  [
    "engine-incompatible",
    edited((source) => {
      source.manifest.engineCompatibility = ">=2.0.0 <3.0.0";
    }),
  ],
  [
    "undeclared-component",
    edited((source) => {
      source.manifest.components = [{ type: "clockgrove.needs", version: 1 }];
    }),
  ],
  [
    "invalid-clock-ratio",
    resource("policies/clock.json", (document) => {
      document.simulationMillisecondsPerWallMillisecond = 0;
    }),
  ],
  [
    "missing-clock-policy",
    edited((source) => {
      source.manifest.policies = [];
      delete source.resources["policies/clock.json"];
    }),
  ],
  [
    "zero-random-state",
    edited((source) => {
      list(source, "randomStreams")[0]!.state = [0, 0, 0, 0];
    }),
  ],
  [
    "invalid-license",
    edited((source) => {
      list(source, "assets")[0]!.license = "not a license";
    }),
  ],
  [
    "unsupported-capability",
    edited((source) => {
      source.manifest.rules = [{ id: "clockgrove.rule.unsupported" }];
    }),
  ],
  [
    "duplicate-identity",
    edited((source) => {
      const traits = list(source, "traits");
      traits.push({ ...traits[1]! });
    }),
  ],
  [
    "unknown-component-version",
    edited((source) => {
      list(source, "components")[0]!.version = 99;
    }),
  ],
  [
    "unknown-pack-version",
    edited((source) => {
      source.manifest.version = "latest";
    }),
  ],
  [
    "dependency-cycle",
    edited((source) => {
      source.manifest.dependencies = [{ id: source.manifest.id, versionRange: ">=1.0.0 <2.0.0" }];
    }),
  ],
  [
    "missing-definition",
    resource("archetypes/resident.json", (document) => {
      document.traits = [{ id: `${packSpecs.weather.needsPrefix}.ghost`, version: 1 }];
    }),
  ],
  [
    "definition-cycle",
    async (source) => {
      const needs = `${packSpecs.weather.needsPrefix}.needs`;
      const shelter = `${packSpecs.weather.needsPrefix}.shelter`;
      const first = await rewriteResource(source, "traits/needs.json", (document) => {
        document.traits = [{ id: shelter, version: 1 }];
      });
      return rewriteResource(first, "traits/shelter.json", (document) => {
        document.traits = [{ id: needs, version: 1 }];
      });
    },
  ],
  [
    "invalid-override",
    actor("secondary-cover", (document) => {
      document.overrides = [
        { type: "clockgrove.weather-exposure", version: 1, state: { rainProtection: 20000 } },
      ];
    }),
  ],
  [
    "malformed-source",
    edited((source) => {
      (source as { manifest: unknown }).manifest = "not a manifest record";
    }),
  ],
  [
    "malformed-resource-bytes",
    async (source) => {
      const next = cloneSource(source);
      await repin(next, "cognition/persona.json", textBytes("{not json"));
      return next;
    },
  ],
  [
    "resource-not-bytes",
    edited((source) => {
      source.resources["assets/badge.svg"] = "not bytes";
    }),
  ],
  [
    "escaping-resource-path",
    edited((source) => {
      source.resources["../escape"] = textBytes("escape");
    }),
  ],
  [
    "actor-archetype-null",
    actor("resident", (document) => {
      document.archetype = null;
    }),
  ],
  [
    "actor-traits-number",
    actor("resident", (document) => {
      document.traits = 7;
    }),
  ],
  [
    "actor-traits-object",
    actor("resident", (document) => {
      document.traits = { id: "routine.needs", version: 1 };
    }),
  ],
];

export const hashChangeMutations: readonly (readonly [string, Mutation])[] = [
  [
    "trait-state",
    resource("traits/needs.json", (document) => {
      const components = document.components as Record<string, { state: Json }>;
      components["clockgrove.needs"]!.state.hunger = 3001;
    }),
  ],
  [
    "asset-bytes",
    async (source) => {
      const next = cloneSource(source);
      await repin(next, "assets/badge.svg", textBytes("<svg xmlns='http://www.w3.org/2000/svg'/>"));
      return next;
    },
  ],
  [
    "asset-license",
    edited((source) => {
      list(source, "assets")[0]!.license = "MIT";
    }),
  ],
];

function artifactOf(value: PackCase): WorldPackArtifactRef {
  if (!value.output.ok) throw new Error("expected a built pack");
  return value.output.artifact;
}

/** Deterministic, JSON-safe evidence: identical bytes are required from Node and Workers. */
export async function packEvidence() {
  const weather = await buildFixtureSource("weather");
  const lantern = await buildFixtureSource("lantern");
  const built = { weather: await buildCase(weather), lantern: await buildCase(lantern) };

  const refusals: { name: string; case: PackCase }[] = [];
  for (const [name, mutate] of refusalMutations)
    refusals.push({ name, case: await buildCase(await mutate(weather)) });

  const baseArtifact = artifactOf(built.weather);
  const hashChanges: {
    name: string;
    case: PackCase;
    changed: { contentHash: boolean; resourceManifestHash: boolean; assetManifestHash: boolean };
  }[] = [];
  for (const [name, mutate] of hashChangeMutations) {
    const changedCase = await buildCase(await mutate(weather));
    const artifact = artifactOf(changedCase);
    hashChanges.push({
      name,
      case: changedCase,
      changed: {
        contentHash: artifact.contentHash !== baseArtifact.contentHash,
        resourceManifestHash: artifact.resourceManifestHash !== baseArtifact.resourceManifestHash,
        assetManifestHash: artifact.assetManifestHash !== baseArtifact.assetManifestHash,
      },
    });
  }

  const reordered = await buildCase(reorderSource(weather));
  const reorderedLantern = await buildCase(reorderSource(lantern));
  const v2Source = newerVersion(weather, "1.1.0");
  const v2 = await buildCase(v2Source);
  const rebuilt = await buildCase(await buildFixtureSource("weather"));
  const afterV2 = await buildCase(weather);
  const retained = {
    unchanged: JSON.stringify(afterV2) === JSON.stringify(built.weather),
    before: built.weather,
    after: afterV2,
  };

  const extras = "clockgrove.pack.weather-extras";
  const dependOn = async (versionRange: string, artifacts: readonly WorldPackArtifactRef[]) =>
    buildCase(
      await buildFixtureSource("weather", {
        packId: extras,
        dependencies: [{ id: packSpecs.weather.packId, versionRange }],
        dependencyArtifacts: artifacts.map((artifact) => ({ ...artifact })),
      }),
    );
  const first = baseArtifact;
  const second = artifactOf(v2);
  const dependent = {
    pinned: await dependOn(">=1.0.0 <1.1.0", [first, second]),
    ambiguous: await dependOn(">=1.0.0 <2.0.0", [first, second]),
    incompatible: await dependOn(">=2.0.0 <3.0.0", [first]),
    missing: await dependOn(">=1.0.0 <2.0.0", []),
  };
  return {
    built,
    refusals,
    hashChanges,
    reordered,
    reorderedLantern,
    v2,
    rebuilt,
    retained,
    dependent,
  };
}

export type PackEvidence = Awaited<ReturnType<typeof packEvidence>>;

/** Flat, ordered inventory of every input identity, for exact cross-runtime equality. */
export function inputIdentities(evidence: PackEvidence): { label: string; input: InputIdentity }[] {
  const all: [string, PackCase][] = [
    ["built.weather", evidence.built.weather],
    ["built.lantern", evidence.built.lantern],
    ...evidence.refusals.map(({ name, case: item }): [string, PackCase] => [
      `refusal.${name}`,
      item,
    ]),
    ...evidence.hashChanges.map(({ name, case: item }): [string, PackCase] => [
      `hashChange.${name}`,
      item,
    ]),
    ["reordered", evidence.reordered],
    ["reorderedLantern", evidence.reorderedLantern],
    ["v2", evidence.v2],
    ["rebuilt", evidence.rebuilt],
    ["retained.before", evidence.retained.before],
    ["retained.after", evidence.retained.after],
    ...Object.entries(evidence.dependent).map(([name, item]): [string, PackCase] => [
      `dependent.${name}`,
      item,
    ]),
  ];
  return all.map(([label, item]) => ({ label, input: item.input }));
}
