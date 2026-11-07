import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";
import type { WorldPackArtifactRef } from "@clockgrove/world-pack-sdk";
import { UnreadableInput } from "./input.js";
import { compareText, type NamedBytes, type PackFiles } from "./pack-source.js";

export const PACK_ARTIFACT_KIND = "clockgrove.pack-artifact";

export const ARTIFACT_REF_FIELDS = [
  "packId",
  "version",
  "contentHash",
  "engineCompatibility",
  "resourceManifestHash",
  "assetManifestHash",
  "migrationSetHash",
  "buildToolVersion",
] as const satisfies readonly (keyof WorldPackArtifactRef)[];

/** A pack artifact file read back: the reference, the exact source and the committed scenario files. */
export interface PackArtifact extends PackFiles {
  readonly artifact: WorldPackArtifactRef;
  /** The `bundleHash` the file records. */
  readonly bundleHash: string;
  /** The SHA-256 of the file's canonical bytes without `bundleHash`. */
  readonly computedBundleHash: string;
}

type Fields = Readonly<Record<string, unknown>>;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function named(files: readonly NamedBytes[]) {
  return files.map(({ name, bytes }) => ({ name, bytes: base64(bytes) }));
}

/** The closed artifact document including its `bundleHash`, and that hash. */
export function packArtifactDocument(
  artifact: WorldPackArtifactRef,
  files: PackFiles,
): { readonly document: Fields; readonly bundleHash: string } {
  const withoutHash = {
    kind: PACK_ARTIFACT_KIND,
    version: 1,
    artifact: { ...artifact },
    source: {
      manifest: base64(files.manifest),
      resources: Object.fromEntries(
        Object.entries(files.resources)
          .sort(([left], [right]) => compareText(left, right))
          .map(([path, content]) => [path, base64(content)]),
      ),
    },
    scenarios: named(files.scenarios),
    goldens: named(files.goldens),
  };
  const bundleHash = sha256Hex(canonicalBytes(withoutHash));
  return { document: { ...withoutHash, bundleHash }, bundleHash };
}

/** The canonical bytes of the artifact file, and the `bundleHash` they record. */
export function encodePackArtifact(
  artifact: WorldPackArtifactRef,
  files: PackFiles,
): { readonly bytes: Uint8Array; readonly bundleHash: string } {
  const { document, bundleHash } = packArtifactDocument(artifact, files);
  return { bytes: canonicalBytes(document), bundleHash };
}

function malformed(): never {
  throw new UnreadableInput("NOT_PACK_ARTIFACT");
}

function fields(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Fields;
}

function closedRecord(value: unknown, keys: readonly string[]): Fields {
  const record = fields(value);
  const actual = Object.keys(record).sort(compareText);
  if (
    actual.length !== keys.length ||
    [...keys].sort(compareText).some((key, i) => key !== actual[i])
  )
    return malformed();
  return record;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : malformed();
}

function bytes(value: unknown): Uint8Array {
  const encoded = text(value);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded ? new Uint8Array(decoded) : malformed();
}

function namedList(value: unknown): NamedBytes[] {
  if (!Array.isArray(value)) return malformed();
  return value.map((item: unknown) => {
    const entry = closedRecord(item, ["name", "bytes"]);
    return { name: text(entry.name), bytes: bytes(entry.bytes) };
  });
}

/** Reads a decoded document as a pack artifact; anything else is `NOT_PACK_ARTIFACT`. */
export function readPackArtifact(document: unknown): PackArtifact {
  if (fields(document).kind !== PACK_ARTIFACT_KIND) return malformed();
  const root = closedRecord(document, [
    "kind",
    "version",
    "artifact",
    "source",
    "scenarios",
    "goldens",
    "bundleHash",
  ]);
  if (root.version !== 1) return malformed();
  const reference = closedRecord(root.artifact, ARTIFACT_REF_FIELDS);
  const source = closedRecord(root.source, ["manifest", "resources"]);
  const resourceDocument = fields(source.resources);
  const resources: Record<string, Uint8Array> = {};
  for (const path of Object.keys(resourceDocument).sort(compareText))
    resources[path] = bytes(resourceDocument[path]);
  const { bundleHash, ...withoutHash } = root;
  return {
    artifact: {
      packId: text(reference.packId),
      version: text(reference.version),
      contentHash: text(reference.contentHash),
      engineCompatibility: text(reference.engineCompatibility),
      resourceManifestHash: text(reference.resourceManifestHash),
      assetManifestHash: text(reference.assetManifestHash),
      migrationSetHash: text(reference.migrationSetHash),
      buildToolVersion: text(reference.buildToolVersion),
    },
    manifest: bytes(source.manifest),
    resources,
    scenarios: namedList(root.scenarios),
    goldens: namedList(root.goldens),
    bundleHash: text(bundleHash),
    computedBundleHash: sha256Hex(canonicalBytes(withoutHash)),
  };
}
