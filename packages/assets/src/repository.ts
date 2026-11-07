import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssetManifest,
  decodeAssetManifest,
  decodePackPresentation,
  type PackPresentation,
} from "@clockgrove/contracts";
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
// biome-ignore lint/suspicious/noExplicitAny: pack resources are read structurally
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"));
const point = (coordinates: { $bigint: string }[]): [number, number] => [
  Number(coordinates[0]?.$bigint),
  Number(coordinates[1]?.$bigint),
];

export function readManifests(root: string): ManifestFile[] {
  const base = join(root, "assets/manifests");
  const files: ManifestFile[] = [];
  for (const assetId of existsSync(base) ? readdirSync(base).sort() : [])
    for (const name of names(join(base, assetId), ".json")) {
      const path = `assets/manifests/${assetId}/${name}`;
      const manifest: AssetManifest = decodeAssetManifest(readJson(join(root, path)), path);
      files.push({ path, manifest, bytes: readFileSync(join(root, manifest.source.path)) });
    }
  return files;
}

export function readPackScenes(root: string): PackScene[] {
  return names(join(root, "worlds"), "")
    .filter((dir) => existsSync(join(root, "worlds", dir, "presentation.json")))
    .map((packDir) => {
      const pack = join(root, "worlds", packDir);
      const placements = new Map<string, [number, number]>();
      for (const name of names(join(pack, "resources/actors"), ".json")) {
        const actor = readJson(join(pack, "resources/actors", name));
        if (actor.placement) placements.set(actor.id, point(actor.placement.coordinates));
      }
      const paths: PackScene["paths"] = [];
      for (const name of names(join(pack, "resources/spaces"), ".json")) {
        const graph = readJson(join(pack, "resources/spaces", name)).anchorGraph;
        const anchors = new Map<string, [number, number]>(
          graph.anchors.map((a: { anchorId: string; coordinates: { $bigint: string }[] }) => [
            a.anchorId,
            point(a.coordinates),
          ]),
        );
        for (const edge of graph.edges)
          paths.push([
            anchors.get(edge.from) as [number, number],
            anchors.get(edge.to) as [number, number],
          ]);
      }
      const presentation = decodePackPresentation(readJson(join(pack, "presentation.json")));
      return { packDir, presentation, placements, paths };
    });
}

export const goldenPaths = (root: string, packDir: string) => ({
  record: join(root, "assets/goldens", `${packDir}.scene.json`),
  image: join(root, "assets/goldens", `${packDir}.scene.png`),
});

export const readGolden = (path: string): GoldenRecord | null =>
  existsSync(path) ? (readJson(path) as GoldenRecord) : null;
