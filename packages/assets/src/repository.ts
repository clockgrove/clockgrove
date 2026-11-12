import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractDecodeError,
  decodeModelAssetManifest,
  decodeModelTargetProfile,
  type ModelAssetManifest,
  type ModelTargetProfile,
} from "@clockgrove/contracts";
import {
  type AssetManifest,
  decodeAssetManifest,
  decodePackPresentation,
  type PackPresentation,
} from "@clockgrove/contracts/asset-manifest";
import {
  type AssetStyleProfile,
  decodeAssetStyleProfile,
} from "@clockgrove/contracts/asset-style-profile";
import type { AssetEntry } from "./atlas.js";
import type { SceneCamera } from "./scene.js";

export const repositoryRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

export interface GoldenRecord {
  camera: SceneCamera;
  simulationTimeMs: number;
  rainIntensity: number;
  selectedObjectId: string | null;
  sceneSha256: string;
  approval: {
    status: "pending" | "approved";
    reviewer: string | null;
    approvedSceneSha256: string | null;
  };
}
export interface ManifestFile extends AssetEntry {
  /** Repository-relative path of the manifest JSON. */
  readonly path: string;
}
export interface PackScene {
  readonly packDir: string;
  readonly presentation: PackPresentation;
  readonly placements: Map<string, [number, number]>;
  readonly paths: [[number, number], [number, number]][];
}

const names = (dir: string, suffix: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(suffix))
        .sort()
    : [];
/** Parses a JSON file, naming the file when it is malformed (`JSON_INVALID`). */
// biome-ignore lint/suspicious/noExplicitAny: pack resources are read structurally
export function readJson(path: string): Record<string, any> {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON_INVALID: ${path}: ${(error as Error).message}`);
  }
}

/** Runs a contract decoder, turning its field-path refusal into a coded input error. */
export function decodeAs<T>(code: string, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof ContractDecodeError) throw new Error(`${code}: ${error.message}`);
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalidScene = (file: string, detail: string) =>
  new Error(`PACK_SCENE_INVALID: ${file}: ${detail}`);
/** A wire point: at least two `{ "$bigint": "<integer>" }` coordinates, of which x and y are read. */
function point(value: unknown, file: string, field: string): [number, number] {
  const integer = (c: unknown) =>
    isRecord(c) && typeof c.$bigint === "string" && /^-?\d+$/u.test(c.$bigint);
  if (!Array.isArray(value) || value.length < 2 || !integer(value[0]) || !integer(value[1]))
    throw invalidScene(file, `${field} must list integer { "$bigint" } coordinates`);
  return [Number(value[0].$bigint), Number(value[1].$bigint)];
}

/** Presentation data lives beside presentation.json, outside the simulation pack hash. */
export function readAssetStyleProfile(root: string, packDir: string): AssetStyleProfile {
  const path = join(root, packDir, "asset-style.json");
  if (!existsSync(path)) throw new Error(`STYLE_PROFILE_REQUIRED: ${path}`);
  try {
    return decodeAssetStyleProfile(readJson(path), path);
  } catch (error) {
    throw new Error(`STYLE_PROFILE_INVALID: ${(error as Error).message}`);
  }
}

export function readManifests(root: string, assetRoot = "assets"): ManifestFile[] {
  const base = join(root, assetRoot, "manifests");
  const files: ManifestFile[] = [];
  for (const assetId of existsSync(base) ? readdirSync(base).sort() : [])
    for (const name of names(join(base, assetId), ".json")) {
      const path = `${assetRoot}/manifests/${assetId}/${name}`;
      const json = readJson(join(root, path));
      if (json.kind === "model") continue;
      const manifest: AssetManifest = decodeAs("ASSET_MANIFEST_INVALID", () =>
        decodeAssetManifest(json, path),
      );
      files.push({
        path,
        manifest,
        bytes: readFileSync(join(root, dirname(assetRoot), manifest.source.path)),
        ...(manifest.material === undefined
          ? {}
          : {
              materialSources: readMaterialSources(root, dirname(assetRoot), manifest),
            }),
      });
    }
  return files;
}

export function readPackScenes(root: string, worldRoot = "worlds"): PackScene[] {
  const directories: string[] = [];
  function visit(directory: string): void {
    if (!existsSync(directory)) return;
    if (existsSync(join(directory, "presentation.json"))) directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !["node_modules", ".git", "assets"].includes(entry.name))
        visit(join(directory, entry.name));
  }
  visit(join(root, worldRoot));
  const sceneBase =
    worldRoot === "worlds" || worldRoot.startsWith("worlds/")
      ? join(root, "worlds")
      : join(root, worldRoot);
  return directories.sort().map((pack) => {
    const packDir = relative(sceneBase, pack) || ".";
    const placements = new Map<string, [number, number]>();
    for (const name of names(join(pack, "resources/actors"), ".json")) {
      const file = join(pack, "resources/actors", name);
      const actor = readJson(file);
      if (actor.placement === undefined || actor.placement === null) continue;
      if (typeof actor.id !== "string")
        throw invalidScene(file, "a placed actor needs a string id");
      if (!isRecord(actor.placement)) throw invalidScene(file, "placement must be an object");
      placements.set(actor.id, point(actor.placement.coordinates, file, "placement.coordinates"));
    }
    const paths: PackScene["paths"] = [];
    for (const name of names(join(pack, "resources/spaces"), ".json")) {
      const file = join(pack, "resources/spaces", name);
      const graph = readJson(file).anchorGraph;
      if (graph === undefined || graph === null) continue;
      if (
        !isRecord(graph) ||
        !Array.isArray(graph.anchors ?? []) ||
        !Array.isArray(graph.edges ?? [])
      )
        throw invalidScene(file, "anchorGraph must hold anchor and edge arrays");
      const anchors = new Map<string, [number, number]>();
      for (const [index, anchor] of ((graph.anchors ?? []) as unknown[]).entries()) {
        if (!isRecord(anchor) || typeof anchor.anchorId !== "string")
          throw invalidScene(file, `anchorGraph.anchors[${index}] needs a string anchorId`);
        anchors.set(
          anchor.anchorId,
          point(anchor.coordinates, file, `anchorGraph.anchors[${index}].coordinates`),
        );
      }
      for (const [index, edge] of ((graph.edges ?? []) as unknown[]).entries()) {
        const from = isRecord(edge) ? anchors.get(edge.from as string) : undefined;
        const to = isRecord(edge) ? anchors.get(edge.to as string) : undefined;
        if (from === undefined || to === undefined)
          throw invalidScene(file, `anchorGraph.edges[${index}] must join two declared anchors`);
        paths.push([from, to]);
      }
    }
    const presentationFile = join(pack, "presentation.json");
    const json = readJson(presentationFile);
    const presentation = decodeAs("PRESENTATION_INVALID", () =>
      decodePackPresentation(json, presentationFile),
    );
    return {
      packDir,
      presentation,
      placements,
      paths,
    };
  });
}

export const goldenPaths = (root: string, packDir: string, assetRoot = "assets") => ({
  record: join(root, assetRoot, "goldens", `${packDir.replaceAll("/", "-")}.scene.json`),
  image: join(root, assetRoot, "goldens", `${packDir.replaceAll("/", "-")}.scene.png`),
});

export const readGolden = (path: string): GoldenRecord | null =>
  existsSync(path) ? (readJson(path) as GoldenRecord) : null;

export function readMaterialSources(
  root: string,
  worldRoot: string,
  manifest: AssetManifest,
): Readonly<Record<string, Uint8Array>> {
  const sources: Record<string, Uint8Array> = {};
  for (const rendition of manifest.material?.renditions ?? [])
    for (const source of Object.values(rendition.channels)) {
      const path = join(root, worldRoot, source.path);
      if (existsSync(path)) sources[source.path] = readFileSync(path);
    }
  return sources;
}

export interface ModelManifestFile {
  readonly path: string;
  readonly manifest: ModelAssetManifest;
  readonly bytes: Uint8Array;
}
export function readModelTargetProfile(root: string, packDir: string): ModelTargetProfile {
  const path = join(root, packDir, "model-target.json");
  if (!existsSync(path)) throw new Error(`MODEL_PROFILE_REQUIRED: ${path}`);
  return decodeAs("MODEL_PROFILE_INVALID", () => decodeModelTargetProfile(readJson(path), path));
}
export function readModelBytes(root: string, manifest: ModelAssetManifest): Uint8Array {
  const path = resolve(root, manifest.output.path);
  if (relative(root, path).startsWith(".."))
    throw new Error("ASSET_PATH_INVALID: model output is outside world");
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`MODEL_SOURCE_REQUIRED: ${manifest.output.path}`);
  if (relative(realpathSync(root), realpathSync(path)).startsWith(".."))
    throw new Error("ASSET_PATH_INVALID: model output resolves outside world");
  return readFileSync(path);
}
export function readModelManifests(root: string, assetRoot = "assets"): ModelManifestFile[] {
  const base = join(root, assetRoot, "manifests");
  const files: ModelManifestFile[] = [];
  for (const assetId of existsSync(base) ? readdirSync(base).sort() : [])
    for (const name of names(join(base, assetId), ".json")) {
      const path = `${assetRoot}/manifests/${assetId}/${name}`;
      const json = readJson(join(root, path));
      if (json.kind !== "model") continue;
      const manifest = decodeAs("ASSET_MANIFEST_INVALID", () =>
        decodeModelAssetManifest(json, path),
      );
      if (name !== "model.json" || assetId !== manifest.assetId)
        throw new Error(
          `MODEL_MANIFEST_PATH: expected assets/manifests/${manifest.assetId}/model.json`,
        );
      files.push({
        path,
        manifest,
        bytes: readModelBytes(join(root, dirname(assetRoot)), manifest),
      });
    }
  return files;
}
