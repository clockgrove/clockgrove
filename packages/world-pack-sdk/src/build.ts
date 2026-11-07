import { CompositionError } from "@clockgrove/domain";
import { WorldPackError, type WorldPackIssue } from "./errors.js";
import {
  type ResourceEntry,
  type ValidatedWorldPack,
  WORLD_PACK_BUILD_TOOL_VERSION,
  type WorldPackArtifactRef,
  type WorldPackPorts,
} from "./manifest/types.js";
import { migrationSetEntries } from "./migrations.js";
import { validateWorldPackSource } from "./validation/validate.js";

export type WorldPackResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorldPackIssue };

export interface WorldPackBuild {
  readonly artifact: WorldPackArtifactRef;
  /** The exact canonical bytes whose SHA-256 values are recorded in the artifact. */
  readonly bytes: {
    readonly artifact: Uint8Array;
    readonly content: Uint8Array;
    readonly resourceManifest: Uint8Array;
    readonly assetManifest: Uint8Array;
    readonly migrationSet: Uint8Array;
  };
}

/** Total: every thrown value becomes a stable code and path; nothing escapes. */
function refusal(error: unknown): { readonly ok: false; readonly error: WorldPackIssue } {
  if (error instanceof WorldPackError || error instanceof CompositionError)
    return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
  return {
    ok: false,
    error: { code: "MALFORMED_SOURCE", path: "manifest", message: "source could not be read" },
  };
}

export async function validateWorldPack(
  source: unknown,
  ports: WorldPackPorts,
): Promise<WorldPackResult<ValidatedWorldPack>> {
  try {
    return { ok: true, value: await validateWorldPackSource(source, ports) };
  } catch (error) {
    return refusal(error);
  }
}

const resourceRow = (field: string) => (entry: ResourceEntry) => ({
  field,
  id: entry.id,
  version: entry.version,
  path: entry.path,
  sha256: entry.sha256,
});

async function assemble(pack: ValidatedWorldPack, ports: WorldPackPorts): Promise<WorldPackBuild> {
  const hashed = async (document: unknown) => {
    const bytes = ports.canonicalBytes(document);
    return { bytes, digest: await ports.sha256(bytes) };
  };
  const resourceManifest = await hashed({
    kind: "clockgrove.world-pack.resource-manifest",
    version: 1,
    resources: [
      ...pack.archetypes.map(resourceRow("archetypes")),
      ...pack.traits.map(resourceRow("traits")),
      ...pack.actors.map(resourceRow("actors")),
      ...pack.policies.map(resourceRow("policies")),
      ...pack.cognitiveSeeds.map(resourceRow("cognitiveSeeds")),
      ...pack.spaces.map(resourceRow("spaces")),
      ...pack.ruleEntries.map(resourceRow("rules")),
    ],
  });
  const assetManifest = await hashed({
    kind: "clockgrove.world-pack.asset-manifest",
    version: 1,
    assets: pack.assets,
  });
  const migrationSet = await hashed({
    kind: "clockgrove.world-pack.migration-set",
    version: 1,
    migrations: migrationSetEntries(pack.migrations),
  });
  const content = await hashed({
    kind: "clockgrove.world-pack.content",
    version: 1,
    schemaVersion: pack.schemaVersion,
    id: pack.id,
    packVersion: pack.version,
    engineCompatibility: pack.engineCompatibility,
    buildToolVersion: WORLD_PACK_BUILD_TOOL_VERSION,
    dependencies: pack.dependencies,
    components: pack.components,
    resourceManifestHash: resourceManifest.digest,
    assetManifestHash: assetManifest.digest,
    migrationSetHash: migrationSet.digest,
    randomStreams: pack.randomStreams,
    expectedSeedProjectionHash: pack.expectedSeedProjectionHash,
    clockPolicy: pack.clockPolicy,
    capabilities: pack.capabilities,
    seedCommands: pack.seedCommands,
    behaviorPolicy: pack.behaviorPolicy,
  });
  const artifact: WorldPackArtifactRef = Object.freeze({
    packId: pack.id,
    version: pack.version,
    contentHash: content.digest,
    engineCompatibility: pack.engineCompatibility,
    resourceManifestHash: resourceManifest.digest,
    assetManifestHash: assetManifest.digest,
    migrationSetHash: migrationSet.digest,
    buildToolVersion: WORLD_PACK_BUILD_TOOL_VERSION,
  });
  return Object.freeze({
    artifact,
    bytes: Object.freeze({
      artifact: ports.canonicalBytes(artifact),
      content: content.bytes,
      resourceManifest: resourceManifest.bytes,
      assetManifest: assetManifest.bytes,
      migrationSet: migrationSet.bytes,
    }),
  });
}

/** Validates complete source and builds the immutable, content-addressed artifact reference. */
export async function buildWorldPack(
  source: unknown,
  ports: WorldPackPorts,
): Promise<WorldPackResult<WorldPackBuild>> {
  try {
    const pack = await validateWorldPackSource(source, ports);
    return { ok: true, value: await assemble(pack, ports) };
  } catch (error) {
    return refusal(error);
  }
}
