import { type AssetManifest, MAX_ASSET_FRAME_EDGE } from "@clockgrove/contracts";
import { decodePng, encodePng } from "./png.js";
import { sha256Hex } from "./validate.js";

/** Atlas width: a decision of issue 813 that keeps atlases under the 2048 px WebGL minimum texture size. */
export const ATLAS_WIDTH = 1024;

export interface Placement {
  readonly atlasId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface AssetEntry {
  readonly manifest: AssetManifest;
  readonly bytes: Uint8Array;
}
export interface BuiltAtlas {
  readonly atlasId: string;
  readonly png: Uint8Array;
  readonly animations: string;
}

export const assetKey = (m: Pick<AssetManifest, "assetId" | "animationFamily">): string =>
  `${m.assetId}/${m.animationFamily}`;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Shelf packing in (atlasId, assetId, animationFamily) order; keyed by `assetId/animationFamily`. */
export function packAtlas(manifests: readonly AssetManifest[]): Map<string, Placement> {
  const sorted = [...manifests].sort(
    (a, b) =>
      compare(a.atlas.atlasId, b.atlas.atlasId) ||
      compare(a.assetId, b.assetId) ||
      compare(a.animationFamily, b.animationFamily),
  );
  const placements = new Map<string, Placement>();
  const usedIds = new Set(sorted.map((m) => m.atlas.atlasId));
  const widths = new Map<string, number>();
  for (const m of sorted) {
    const width = m.frames.width * m.frames.count;
    if (width > MAX_ASSET_FRAME_EDGE || m.frames.height > MAX_ASSET_FRAME_EDGE)
      throw new Error(`${assetKey(m)}: ATLAS_SIZE: strip exceeds ${MAX_ASSET_FRAME_EDGE} px`);
    widths.set(m.atlas.atlasId, Math.max(widths.get(m.atlas.atlasId) ?? ATLAS_WIDTH, width));
  }
  let groupId = "";
  let atlasId = "";
  let page = 1;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const m of sorted) {
    const width = m.frames.width * m.frames.count;
    const height = m.frames.height;
    if (m.atlas.atlasId !== groupId) {
      groupId = atlasId = m.atlas.atlasId;
      page = 1;
      x = y = rowHeight = 0;
    }
    if (x > 0 && x + width > (widths.get(groupId) as number)) {
      y += rowHeight;
      x = rowHeight = 0;
    }
    if (y + height > MAX_ASSET_FRAME_EDGE) {
      do atlasId = `${groupId}-page-${++page}`;
      while (usedIds.has(atlasId));
      usedIds.add(atlasId);
      x = y = rowHeight = 0;
    }
    placements.set(assetKey(m), { atlasId, x, y, width, height });
    x += width;
    rowHeight = Math.max(rowHeight, height);
  }
  return placements;
}

/** Recorded `atlas.x/y` that differ from the computed placement. */
export function atlasLocationProblems(
  manifests: readonly AssetManifest[],
  layout: readonly AssetManifest[] = manifests,
): string[] {
  const placements = packAtlas(layout);
  return manifests.flatMap((m) => {
    const p = placements.get(assetKey(m));
    if (p === undefined) return [`${assetKey(m)}: atlas location: not part of the layout`];
    return p.x === m.atlas.x && p.y === m.atlas.y
      ? []
      : [
          `${assetKey(m)}: atlas location: recorded ${m.atlas.x},${m.atlas.y}, computed ${p.x},${p.y}`,
        ];
  });
}

export function canonicalJson(value: unknown): string {
  const write = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${write((v as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return `${write(value)}\n`;
}

/**
 * Bounded atlas pages per logical atlasId. `layout` computes placements (default: the
 * entries); pass every manifest so a pending asset keeps its place when only approved ones build.
 */
export function buildAtlases(
  entries: readonly AssetEntry[],
  layout: readonly AssetManifest[] = entries.map((e) => e.manifest),
): BuiltAtlas[] {
  const problems = atlasLocationProblems(
    entries.map((e) => e.manifest),
    layout,
  );
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const placements = packAtlas(layout);
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.manifest.atlas.atlasId, b.manifest.atlas.atlasId) ||
      compare(a.manifest.assetId, b.manifest.assetId) ||
      compare(a.manifest.animationFamily, b.manifest.animationFamily),
  );
  const physicalId = (e: AssetEntry): string =>
    (placements.get(assetKey(e.manifest)) as Placement).atlasId;
  const atlasIds = [...new Set(sorted.map(physicalId))];
  return atlasIds.map((atlasId) => {
    const members = sorted.filter((e) => physicalId(e) === atlasId);
    const placed = members.map((e) => placements.get(assetKey(e.manifest)) as Placement);
    const width = Math.max(...placed.map((p) => p.x + p.width));
    const height = Math.max(...placed.map((p) => p.y + p.height));
    const rgba = new Uint8Array(width * height * 4);
    members.forEach((e, n) => {
      const p = placed[n] as Placement;
      const strip = decodePng(e.bytes);
      for (let row = 0; row < p.height; row++)
        rgba.set(
          strip.rgba.subarray(row * p.width * 4, (row + 1) * p.width * 4),
          ((p.y + row) * width + p.x) * 4,
        );
    });
    const png = encodePng({ width, height, rgba });
    const animations = canonicalJson({
      assetManifestVersion: 2,
      atlasId,
      image: { sha256: sha256Hex(png), width, height },
      animations: members.map((e, n) => {
        const m = e.manifest;
        const p = placed[n] as Placement;
        return {
          assetId: m.assetId,
          animationFamily: m.animationFamily,
          frames: Array.from({ length: m.frames.count }, (_, i) => ({
            x: p.x + i * m.frames.width,
            y: p.y,
            width: m.frames.width,
            height: m.frames.height,
          })),
          durationMs: m.frames.durationMs,
          anchor: m.anchor,
          bounds: m.bounds,
          footprint: m.footprint,
          accessibilityLabel: m.accessibilityLabel,
          contentHash: m.contentHash,
          license: m.license,
        };
      }),
    });
    return { atlasId, png, animations };
  });
}
