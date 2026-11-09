import { type AssetManifest, MAX_ASSET_FRAME_EDGE } from "@clockgrove/contracts/asset-manifest";
import { decodePng, encodePng } from "./png.js";
import { sha256Hex } from "./validate.js";

/** Atlas width: a decision of issue 813 that keeps atlases under the 2048 px WebGL minimum texture size. */
export const ATLAS_WIDTH = 1024;

/** Part of a strip's frames on one page: `columns` per row, left to right, then down. */
export interface Segment {
  readonly atlasId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** A strip's first segment, plus the pages its frames continue onto, each from its top-left corner. */
export interface Placement extends Segment {
  readonly columns: number;
  readonly continued: readonly Segment[];
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

/**
 * A strip that fits one page row stays one row. A wider one wraps into the fewest rows a page
 * allows, with frames balanced across them. A strip whose rows pass one page's height fills whole
 * pages of full rows, and its remaining frames continue on the next page. Only a frame larger than
 * a page is refused.
 */
function blocks(m: AssetManifest): { columns: number; sizes: [number, number][] } {
  const { width, height, count } = m.frames;
  const columns = Math.floor(MAX_ASSET_FRAME_EDGE / width);
  const rows = Math.floor(MAX_ASSET_FRAME_EDGE / height);
  if (columns === 0 || rows === 0)
    throw new Error(
      `${assetKey(m)}: ATLAS_SIZE: a ${width}x${height} px frame does not fit one ${MAX_ASSET_FRAME_EDGE} px page`,
    );
  if (count <= columns * rows) {
    const used = Math.ceil(count / Math.min(count, columns));
    const balanced = Math.ceil(count / used);
    return { columns: balanced, sizes: [[balanced * width, used * height]] };
  }
  const sizes: [number, number][] = [];
  for (let left = count; left > 0; left -= columns * rows) {
    const n = Math.min(left, columns * rows);
    sizes.push([Math.min(n, columns) * width, Math.ceil(n / columns) * height]);
  }
  return { columns, sizes };
}

/** Frame `i`'s page and its page-local rectangle there. */
export function frameRect(m: Pick<AssetManifest, "frames">, p: Placement, i: number): Segment {
  const { width, height } = m.frames;
  const perPage = p.columns * (p.height / height);
  const page = Math.floor(i / perPage);
  const at = page === 0 ? p : (p.continued[page - 1] as Segment);
  const j = i - page * perPage;
  return {
    atlasId: at.atlasId,
    x: at.x + (j % p.columns) * width,
    y: at.y + Math.floor(j / p.columns) * height,
    width,
    height,
  };
}

/** Shelf packing of strip blocks in (atlasId, assetId, animationFamily) order; keyed by `assetId/animationFamily`. */
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
  const layouts = sorted.map(blocks);
  sorted.forEach((m, n) =>
    widths.set(
      m.atlas.atlasId,
      Math.max(
        widths.get(m.atlas.atlasId) ?? ATLAS_WIDTH,
        ...(layouts[n] as ReturnType<typeof blocks>).sizes.map(([width]) => width),
      ),
    ),
  );
  let groupId = "";
  let atlasId = "";
  let page = 1;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const nextPage = (): void => {
    do atlasId = `${groupId}-page-${++page}`;
    while (usedIds.has(atlasId));
    usedIds.add(atlasId);
    x = y = rowHeight = 0;
  };
  sorted.forEach((m, n) => {
    const { columns, sizes } = layouts[n] as ReturnType<typeof blocks>;
    if (m.atlas.atlasId !== groupId) {
      groupId = atlasId = m.atlas.atlasId;
      page = 1;
      x = y = rowHeight = 0;
    }
    const segments = sizes.map(([width, height], s): Segment => {
      if (s > 0) nextPage();
      else {
        if (x > 0 && x + width > (widths.get(groupId) as number)) {
          y += rowHeight;
          x = rowHeight = 0;
        }
        if (y + height > MAX_ASSET_FRAME_EDGE) nextPage();
      }
      const segment = { atlasId, x, y, width, height };
      x += width;
      rowHeight = Math.max(rowHeight, height);
      return segment;
    });
    const [first, ...continued] = segments as [Segment, ...Segment[]];
    placements.set(assetKey(m), { ...first, columns, continued });
  });
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

/** The reviewed output's page index: every page's basename, in build order. The local shell loads it. */
export const ATLAS_INDEX = "atlases.json";
export const atlasIndex = (atlases: readonly BuiltAtlas[]): string =>
  canonicalJson({ assetManifestVersion: 2, atlases: atlases.map((a) => a.atlasId) });

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
  const placed = sorted.map((e) => placements.get(assetKey(e.manifest)) as Placement);
  const pagesOf = (p: Placement): Segment[] => [p, ...p.continued];
  const strips = new Map<AssetEntry, ReturnType<typeof decodePng>>();
  const atlasIds = [...new Set(placed.flatMap((p) => pagesOf(p).map((s) => s.atlasId)))];
  return atlasIds.map((atlasId) => {
    const here = placed.flatMap(pagesOf).filter((s) => s.atlasId === atlasId);
    const width = Math.max(...here.map((s) => s.x + s.width));
    const height = Math.max(...here.map((s) => s.y + s.height));
    const rgba = new Uint8Array(width * height * 4);
    sorted.forEach((e, n) => {
      const p = placed[n] as Placement;
      if (!pagesOf(p).some((s) => s.atlasId === atlasId)) return;
      const strip = strips.get(e) ?? decodePng(e.bytes);
      strips.set(e, strip);
      const { width: fw, height: fh, count } = e.manifest.frames;
      for (let i = 0; i < count; i++) {
        const at = frameRect(e.manifest, p, i);
        if (at.atlasId !== atlasId) continue;
        for (let row = 0; row < fh; row++) {
          const from = (row * strip.width + i * fw) * 4;
          rgba.set(strip.rgba.subarray(from, from + fw * 4), ((at.y + row) * width + at.x) * 4);
        }
      }
    });
    const png = encodePng({ width, height, rgba });
    // A page lists the animations whose first frame it holds; a frame on a later page names it.
    const animations = canonicalJson({
      assetManifestVersion: 2,
      atlasId,
      image: { sha256: sha256Hex(png), width, height },
      animations: sorted.flatMap((e, n) => {
        const m = e.manifest;
        const p = placed[n] as Placement;
        if (p.atlasId !== atlasId) return [];
        return {
          assetId: m.assetId,
          animationFamily: m.animationFamily,
          frames: Array.from({ length: m.frames.count }, (_, i) => {
            const { atlasId: page, ...rect } = frameRect(m, p, i);
            return page === atlasId ? rect : { atlasId: page, ...rect };
          }),
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
