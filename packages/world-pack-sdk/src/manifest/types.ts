import type {
  AnchorGraph,
  RuleDefinition,
  SpatialFrame,
  SpatialRegion,
  WorldBehaviorPolicy,
} from "@clockgrove/domain";

export const WORLD_PACK_SCHEMA_VERSION = 2;
export const WORLD_PACK_ENGINE_VERSION = "1.0.0";
export const WORLD_PACK_BUILD_TOOL_VERSION = "clockgrove-world-pack-sdk@0.1.0";
export const NAMED_RANDOM_ALGORITHM = "pure-rand@8.4.2/xoroshiro128plus";
export const CLOCK_POLICY_TYPE = "clockgrove.clock-policy";

/** Architecture §8: the one immutable, content-addressed result of a build. */
export interface WorldPackArtifactRef {
  readonly packId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly engineCompatibility: string;
  readonly resourceManifestHash: string;
  readonly assetManifestHash: string;
  readonly migrationSetHash: string;
  readonly buildToolVersion: string;
}

/** Composition ports: the SDK itself performs no hashing or I/O. */
export interface WorldPackPorts {
  /** Deterministic, type-preserving bytes for a plain value (strings, safe integers, bigint). */
  canonicalBytes(value: unknown): Uint8Array;
  /** Lowercase hexadecimal SHA-256 of the exact bytes. */
  sha256(bytes: Uint8Array): Promise<string>;
  /** Commands rules, capabilities and seed commands may name; an absent catalog is empty. */
  readonly commandCatalog?: readonly { type: string; version: number }[];
}

export const BEHAVIOR_POLICY_TYPE = "clockgrove.world-behavior-policy";
export const CAPABILITY_KINDS = [
  "inspect",
  "embodied-dialogue",
  "interpreted-perspective",
  "influence",
  "operator-authoring",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface DefinitionRef {
  readonly id: string;
  readonly version: number;
}

export interface SpaceEntry extends ResourceEntry {
  readonly frame: SpatialFrame;
  readonly regions: readonly SpatialRegion[];
  readonly anchorGraph: AnchorGraph | null;
  /** The space's semantic parent (graph 5), another space of the pack; null for a root. */
  readonly parent: DefinitionRef | null;
}

export interface CapabilityDefinition {
  readonly id: string;
  readonly version: number;
  readonly kind: CapabilityKind;
  readonly commands: readonly { readonly type: string; readonly version: number }[];
}

export interface SeedCommand {
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ActorPlacement {
  readonly space: DefinitionRef;
  readonly coordinates: readonly bigint[];
}

export interface ActorLifecycleSeed {
  readonly householdId: string;
  readonly parentIds: readonly string[];
  readonly generation: number;
  readonly bornAt: bigint;
}

export interface TraitDefinitionDocument {
  readonly id: string;
  readonly version: number;
  readonly traits: readonly DefinitionRef[];
  readonly components: Readonly<Record<string, unknown>>;
  readonly conflictResolutions?: unknown;
}

export interface ActorDefinitionDocument {
  readonly id: string;
  readonly version: number;
  readonly archetype: DefinitionRef;
  readonly traits: readonly DefinitionRef[];
  readonly overrides: readonly unknown[];
  readonly capabilities: readonly DefinitionRef[];
  readonly placement: ActorPlacement | null;
  readonly lifecycle: ActorLifecycleSeed | null;
}

export interface PackDefinitions {
  readonly traits: readonly TraitDefinitionDocument[];
  readonly archetypes: readonly TraitDefinitionDocument[];
  readonly actors: readonly ActorDefinitionDocument[];
}

export interface ResourceEntry {
  readonly id: string;
  readonly version: number;
  readonly path: string;
  readonly sha256: string;
}

export interface MigrationStep {
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A manifest migration entry with its validated resource document. */
export interface MigrationEntry extends ResourceEntry {
  readonly fromPackVersion: string;
  readonly toPackVersion: string;
  readonly steps: readonly MigrationStep[];
}

/** One planned migration step; `stepId` is `<migrationId>@<version>/<stepKey>`. */
export interface PlannedMigrationStep {
  readonly stepId: string;
  readonly fromPackVersion: string;
  readonly toPackVersion: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AssetEntry extends ResourceEntry {
  readonly mediaType: string;
  readonly byteLength: number;
  readonly license: string;
  readonly provenance: {
    readonly source: string;
    readonly method: string;
    readonly reviewStatus: string;
  };
  readonly generation: {
    readonly provider: string;
    readonly model: string;
    readonly parametersSha256: string;
  } | null;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly anchors: readonly { readonly name: string; readonly x: number; readonly y: number }[];
  readonly footprint: { readonly width: number; readonly depth: number } | null;
}

export interface RandomStreamEntry {
  readonly name: string;
  readonly algorithm: string;
  readonly algorithmVersion: number;
  readonly seed: string;
  readonly state: readonly number[];
  readonly draws: number;
}

export interface ClockPolicy {
  readonly epoch: bigint;
  readonly wallEpoch: string;
  readonly simulationMillisecondsPerWallMillisecond: number;
  readonly decisionIntervalMs: bigint;
}

export interface ResolvedDependency {
  readonly id: string;
  readonly versionRange: string;
  readonly version: string;
  readonly contentHash: string;
}

/** The normalized (sorted, frozen) facts a build hashes. */
export interface ValidatedWorldPack {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly version: string;
  readonly engineCompatibility: string;
  readonly dependencies: readonly ResolvedDependency[];
  readonly components: readonly { readonly type: string; readonly version: number }[];
  readonly archetypes: readonly ResourceEntry[];
  readonly traits: readonly ResourceEntry[];
  readonly actors: readonly ResourceEntry[];
  readonly policies: readonly ResourceEntry[];
  readonly cognitiveSeeds: readonly ResourceEntry[];
  readonly assets: readonly AssetEntry[];
  readonly randomStreams: readonly RandomStreamEntry[];
  readonly expectedSeedProjectionHash: string;
  readonly clockPolicy: ClockPolicy;
  readonly spaces: readonly SpaceEntry[];
  /** Domain rule definitions sorted by id then version. */
  readonly rules: readonly RuleDefinition[];
  /** Resource entries of `rules`, in the same order. */
  readonly ruleEntries: readonly ResourceEntry[];
  readonly capabilities: readonly CapabilityDefinition[];
  /** Manifest (execution) order. */
  readonly seedCommands: readonly SeedCommand[];
  readonly behaviorPolicy: WorldBehaviorPolicy | null;
  /** Sorted by fromPackVersion. */
  readonly migrations: readonly MigrationEntry[];
  readonly definitions: PackDefinitions;
}
