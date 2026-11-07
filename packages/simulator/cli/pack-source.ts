import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeResource, WorldPackError } from "@clockgrove/world-pack-sdk";
import { isFileSystemError, readBytes, UnreadableInput } from "./input.js";

export interface NamedBytes {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A pack in the documented `worlds/<dir>` layout, read byte-exact. */
export interface PackFiles {
  readonly manifest: Uint8Array;
  /** Resource bytes by manifest path. */
  readonly resources: Readonly<Record<string, Uint8Array>>;
  /** `scenarios/<name>.json`, by name. */
  readonly scenarios: readonly NamedBytes[];
  /** `goldens/<name>.json`, by name. */
  readonly goldens: readonly NamedBytes[];
}

export interface SdkSource {
  readonly manifest: unknown;
  readonly resources: Readonly<Record<string, Uint8Array>>;
  readonly dependencyArtifacts: readonly [];
}

/** Review copies written next to a golden; never goldens themselves. */
export const ACTUAL_SUFFIX = ".actual.json";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The entries of a directory in code-unit order; none when it is absent. */
export async function directoryEntries(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      compareText(a.name, b.name),
    );
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return [];
    if (isFileSystemError(error)) throw new UnreadableInput("INPUT_UNREADABLE");
    throw error;
  }
}

/** Every file under `base` by `/`-separated relative path, byte-exact. */
export async function walk(
  base: string,
  relative: string,
  out: Record<string, Uint8Array>,
): Promise<void> {
  for (const entry of await directoryEntries(join(base, relative))) {
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walk(base, next, out);
    else if (entry.isFile()) out[next] = await readBytes(join(base, next));
  }
}

async function jsonFiles(directory: string, ignoredSuffix: string | null): Promise<NamedBytes[]> {
  const files: NamedBytes[] = [];
  for (const entry of await directoryEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (ignoredSuffix !== null && entry.name.endsWith(ignoredSuffix)) continue;
    files.push({
      name: entry.name.slice(0, -".json".length),
      bytes: await readBytes(join(directory, entry.name)),
    });
  }
  return files;
}

/** Reads `manifest.json`, `resources/**`, `scenarios/*.json` and `goldens/*.json`; nothing is written. */
export async function readPackDirectory(directory: string): Promise<PackFiles> {
  const manifest = await readBytes(join(directory, "manifest.json"));
  const resources: Record<string, Uint8Array> = {};
  await walk(join(directory, "resources"), "", resources);
  return {
    manifest,
    resources,
    scenarios: await jsonFiles(join(directory, "scenarios"), null),
    goldens: await jsonFiles(join(directory, "goldens"), ACTUAL_SUFFIX),
  };
}

/**
 * The SDK source of a pack. A manifest that is not SDK resource JSON throws the SDK's
 * `WorldPackError` (`MALFORMED_RESOURCE`); callers decide whether that is an unreadable input.
 */
export function sdkSource(files: Pick<PackFiles, "manifest" | "resources">): SdkSource {
  return {
    manifest: decodeResource(files.manifest, "manifest.json"),
    resources: files.resources,
    dependencyArtifacts: [],
  };
}

/** A manifest that is not SDK resource JSON is an unreadable pack source. */
export function readableSdkSource(files: Pick<PackFiles, "manifest" | "resources">): SdkSource {
  try {
    return sdkSource(files);
  } catch (error) {
    if (error instanceof WorldPackError) throw new UnreadableInput("NOT_PACK_SOURCE");
    throw error;
  }
}
