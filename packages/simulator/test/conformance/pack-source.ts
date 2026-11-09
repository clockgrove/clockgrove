import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { readBytes } from "../../cli/input.js";
import { ACTUAL_SUFFIX, directoryEntries, walk } from "../../cli/pack-source.js";
import { REPO_ROOT, WORLDS_ROOT } from "../../cli/repo.js";
import type { FixtureSource } from "../fixtures/lamp-hall.js";
import { CHECKS, failCheck } from "./failure.js";

export { REPO_ROOT, WORLDS_ROOT };

export interface ScenarioFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly document: unknown;
}

export interface GoldenFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A committed pack read byte-exact from its documented directory layout. */
export interface LoadedPack {
  /** The directory name under the worlds root. */
  readonly name: string;
  readonly directory: string;
  readonly manifestBytes: Uint8Array;
  readonly source: FixtureSource;
  /** Resource bytes by manifest path, exactly as stored under `resources/`. */
  readonly resourceBytes: Readonly<Record<string, Uint8Array>>;
  readonly scenarios: readonly ScenarioFile[];
  readonly goldens: readonly GoldenFile[];
  /** Entries of `scenarios/` or `goldens/` that are not `<name>.json` files. */
  readonly strayFiles: readonly string[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every directory recursively under `root` that contains a `manifest.json`; none when `root` is absent. */
/**
 * Committed packs small enough for every pull request to run them in workerd and through each CLI
 * path. The other packs run once in Node per PR; their workerd parity and full CLI runs belong to
 * the long-run suite (pnpm test:long-run).
 */
export const SMALL_PACKS: readonly string[] = ["fixture"];

export function discoverPackDirectories(root: string = WORLDS_ROOT): string[] {
  if (!isDirectory(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const directory = join(root, entry);
    if (!isDirectory(directory)) continue;
    if (isFile(join(directory, "manifest.json"))) found.push(directory);
    found.push(...discoverPackDirectories(directory));
  }
  return found.sort();
}

async function jsonFiles(
  directory: string,
  stray: string[],
  label: string,
): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (!isDirectory(directory)) return [];
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const entry of await directoryEntries(directory)) {
    if (label === "goldens" && entry.isFile() && entry.name.endsWith(ACTUAL_SUFFIX)) continue;
    if (entry.isFile() && entry.name.endsWith(".json") && entry.name.length > ".json".length)
      files.push({
        name: entry.name.slice(0, -".json".length),
        bytes: await readBytes(join(directory, entry.name)),
      });
    else stray.push(`${label}/${entry.name}`);
  }
  return files;
}

/**
 * Loads `manifest.json`, `resources/**`, `scenarios/*.json` and `goldens/*.json` (except
 * `*.actual.json`) of one pack directory. Nothing is written.
 */
export async function loadPack(directory: string): Promise<LoadedPack> {
  const name = basename(directory);
  const manifestBytes = await readBytes(join(directory, "manifest.json")).catch((error: unknown) =>
    failCheck(name, CHECKS.load, `manifest.json could not be read: ${String(error)}`),
  );
  let manifest: unknown;
  try {
    manifest = decodeResource(manifestBytes, "manifest.json");
  } catch (error) {
    return failCheck(
      name,
      CHECKS.load,
      `manifest.json is not SDK resource JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    return failCheck(name, CHECKS.load, "manifest.json must hold a JSON object");

  const resources: Record<string, Uint8Array> = {};
  if (isDirectory(join(directory, "resources")))
    await walk(join(directory, "resources"), "", resources);

  const strayFiles: string[] = [];
  const scenarios: ScenarioFile[] = [];
  for (const file of await jsonFiles(join(directory, "scenarios"), strayFiles, "scenarios")) {
    try {
      scenarios.push({
        ...file,
        document: decodeResource(file.bytes, `scenarios/${file.name}.json`),
      });
    } catch (error) {
      failCheck(
        name,
        CHECKS.load,
        `scenarios/${file.name}.json is not SDK resource JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const goldens = await jsonFiles(join(directory, "goldens"), strayFiles, "goldens");

  return {
    name,
    directory,
    manifestBytes,
    source: { manifest: manifest as Record<string, any>, resources, dependencyArtifacts: [] },
    resourceBytes: resources,
    scenarios,
    goldens,
    strayFiles,
  };
}

export async function loadAllPacks(root: string = WORLDS_ROOT): Promise<LoadedPack[]> {
  const packs: LoadedPack[] = [];
  for (const directory of discoverPackDirectories(root)) packs.push(await loadPack(directory));
  return packs;
}
