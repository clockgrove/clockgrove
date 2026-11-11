import type { AssetStyleProfile, MaterialChannel } from "@clockgrove/contracts";
import { type AssetManifest, MAX_ASSET_FRAME_EDGE } from "@clockgrove/contracts/asset-manifest";
import { encodeKtx2Uastc } from "./ktx2.js";
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
  readonly materialSources?: Readonly<Record<string, Uint8Array>>;
}
export interface BuiltMaterialTexture {
  readonly atlasId: string;
  readonly density: 1 | 2 | 4;
  readonly channel: MaterialChannel;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
  readonly compressed: Uint8Array;
  readonly format: "ktx2-uastc";
}
export interface BuiltAtlas {
  readonly materialTextures?: readonly BuiltMaterialTexture[];
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
function buildFlatAtlases(
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

/** Packs world-supplied channels without deriving maps or resampling renditions. */
export function buildAtlases(
  entries: readonly AssetEntry[],
  layout: readonly AssetManifest[] = entries.map((entry) => entry.manifest),
  profile?: AssetStyleProfile,
): BuiltAtlas[] {
  const atlases = buildFlatAtlases(entries, layout);
  const materialEntries = entries.filter((entry) => entry.manifest.material !== undefined);
  if (materialEntries.length === 0) return atlases;
  const textures: BuiltMaterialTexture[] = [];
  type TextureReference = {
    encoding?: "srgb" | "linear";
    image: { sha256: string; width: number; height: number; bytes: number };
    compressed: { sha256: string; format: "ktx2-uastc"; bytes: number };
    frames: Segment[];
    pages: {
      atlasId: string;
      image: { sha256: string; width: number; height: number; bytes: number };
      compressed: { sha256: string; format: "ktx2-uastc"; bytes: number };
    }[];
  };
  const deliveries = new Map<
    string,
    {
      materialVersion: 2;
      renditions: {
        density: 1 | 2 | 4;
        channels: Partial<Record<MaterialChannel, TextureReference>>;
      }[];
    }
  >();
  for (const entry of materialEntries)
    deliveries.set(assetKey(entry.manifest), { materialVersion: 2, renditions: [] });
  for (const density of [1, 2, 4] as const) {
    const roles = layout.filter((manifest) =>
      manifest.material?.renditions.some((r) => r.density === density),
    );
    const channels = [
      ...new Set(
        roles.flatMap((manifest) =>
          Object.keys(
            manifest.material?.renditions.find((r) => r.density === density)?.channels ?? {},
          ),
        ),
      ),
    ].sort() as MaterialChannel[];
    for (const channel of channels) {
      const scaled = roles.map((m): AssetManifest => {
        const { material: _, ...flat } = m;
        return {
          ...flat,
          frames: {
            ...m.frames,
            width: m.frames.width * density,
            height: m.frames.height * density,
          },
          anchor: { x: m.anchor.x * density, y: m.anchor.y * density },
          bounds: {
            x: m.bounds.x * density,
            y: m.bounds.y * density,
            width: m.bounds.width * density,
            height: m.bounds.height * density,
          },
          atlas: { atlasId: `${m.atlas.atlasId}-${density}x-${channel}`, x: 0, y: 0 },
        };
      });
      const placements = packAtlas(scaled);
      const aligned = scaled.map((m) => {
        const at = placements.get(assetKey(m)) as Placement;
        return { ...m, atlas: { ...m.atlas, x: at.x, y: at.y } };
      });
      const packed = materialEntries.flatMap((entry): AssetEntry[] => {
        const rendition = entry.manifest.material?.renditions.find((r) => r.density === density);
        const source = rendition?.channels[channel];
        if (source === undefined) return [];
        const bytes =
          source.path === entry.manifest.source.path
            ? entry.bytes
            : entry.materialSources?.[source.path];
        if (bytes === undefined)
          throw new Error(
            `${assetKey(entry.manifest)}: MATERIAL_SOURCE_REQUIRED: ${density}x/${channel}`,
          );
        const manifest = aligned.find(
          (m) => assetKey(m) === assetKey(entry.manifest),
        ) as AssetManifest;
        const image = decodePng(bytes);
        if (
          sha256Hex(bytes) !== source.sha256 ||
          image.width !== manifest.frames.width * manifest.frames.count ||
          image.height !== manifest.frames.height
        )
          throw new Error(`${assetKey(manifest)}: MATERIAL_SOURCE_INVALID: ${density}x/${channel}`);
        return [{ manifest, bytes }];
      });
      const pages = buildFlatAtlases(packed, aligned);
      // The KTX2 transfer function and the encoder's error metric follow the declared encoding:
      // linear when any packed asset declares this channel linear, otherwise sRGB, as the renderer
      // treats an undeclared albedo.
      const pageEncoding = packed.some(
        (entry) =>
          profile?.material?.roles[entry.manifest.semantic.role][channel]?.encoding === "linear",
      )
        ? "linear"
        : "srgb";
      for (const page of pages) {
        const source = decodePng(page.png);
        // Block formats require complete 4×4 blocks; transparent padding leaves all frame rectangles intact.
        const width = Math.ceil(source.width / 4) * 4;
        const height = Math.ceil(source.height / 4) * 4;
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < source.height; y++)
          rgba.set(
            source.rgba.subarray(y * source.width * 4, (y + 1) * source.width * 4),
            y * width * 4,
          );
        const image = { width, height, rgba };
        const png = encodePng(image);
        textures.push({
          atlasId: page.atlasId,
          density,
          channel,
          width,
          height,
          png,
          compressed: encodeKtx2Uastc(image, pageEncoding),
          format: "ktx2-uastc",
        });
      }
      for (const entry of packed) {
        const key = assetKey(entry.manifest);
        const delivery = deliveries.get(key);
        if (delivery === undefined) continue;
        let rendition = delivery.renditions.find((r) => r.density === density);
        if (rendition === undefined) {
          rendition = { density, channels: {} };
          delivery.renditions.push(rendition);
        }
        const p = placements.get(key) as Placement;
        const first = textures.find((t) => t.atlasId === p.atlasId) as BuiltMaterialTexture;
        const role = materialEntries.find((e) => assetKey(e.manifest) === key)?.manifest.semantic
          .role;
        const encoding =
          role === undefined ? undefined : profile?.material?.roles[role][channel]?.encoding;
        rendition.channels[channel] = {
          ...(encoding === undefined ? {} : { encoding }),
          image: {
            sha256: sha256Hex(first.png),
            width: first.width,
            height: first.height,
            bytes: first.png.length,
          },
          compressed: {
            sha256: sha256Hex(first.compressed),
            format: "ktx2-uastc",
            bytes: first.compressed.length,
          },
          frames: Array.from({ length: entry.manifest.frames.count }, (_, i) =>
            frameRect(entry.manifest, p, i),
          ),
          pages: [p, ...p.continued].map((segment) => {
            const texture = textures.find(
              (t) => t.atlasId === segment.atlasId,
            ) as BuiltMaterialTexture;
            return {
              atlasId: texture.atlasId,
              image: {
                sha256: sha256Hex(texture.png),
                width: texture.width,
                height: texture.height,
                bytes: texture.png.length,
              },
              compressed: {
                sha256: sha256Hex(texture.compressed),
                format: "ktx2-uastc",
                bytes: texture.compressed.length,
              },
            };
          }),
        };
      }
    }
  }
  return atlases.map((atlas, n) => {
    const metadata = JSON.parse(atlas.animations) as {
      animations: { assetId: string; animationFamily: string; material?: unknown }[];
    };
    for (const animation of metadata.animations) {
      const delivery = deliveries.get(`${animation.assetId}/${animation.animationFamily}`);
      if (delivery !== undefined) animation.material = delivery;
    }
    return {
      ...atlas,
      animations: canonicalJson(metadata),
      ...(n === 0 ? { materialTextures: textures } : {}),
    };
  });
}

/** All material pages are named explicitly and also available through content-addressed delivery. */
export function materialAtlasFiles(
  atlases: readonly BuiltAtlas[],
): { name: string; bytes: Uint8Array; contentType: string }[] {
  return atlases.flatMap((atlas) =>
    (atlas.materialTextures ?? []).flatMap((texture) => [
      { name: `${texture.atlasId}.png`, bytes: texture.png, contentType: "image/png" },
      {
        name: `${texture.atlasId}.ktx2`,
        bytes: texture.compressed,
        contentType: "image/ktx2",
      },
    ]),
  );
}

/** Runtime world presentation configuration consumes this map under its `materials` field. */
export function atlasMaterials(atlases: readonly BuiltAtlas[]): Readonly<Record<string, unknown>> {
  const materials: Record<string, unknown> = {};
  for (const atlas of atlases) {
    const metadata = JSON.parse(atlas.animations) as {
      animations: { assetId: string; animationFamily: string; material?: unknown }[];
    };
    for (const animation of metadata.animations)
      if (animation.material !== undefined)
        materials[`${animation.assetId}/${animation.animationFamily}`] = animation.material;
  }
  return materials;
}

/**
 * Every file of the reviewed output, by the name the shell requests it under: each page's PNG and
 * animations, the material files, `materials.json` and the page index. Build writes them; upload
 * stores them.
 */
export function reviewedFiles(
  atlases: readonly BuiltAtlas[],
): { name: string; bytes: Uint8Array; contentType: string }[] {
  const json = (name: string, text: string) => ({
    name,
    bytes: new TextEncoder().encode(text),
    contentType: "application/json",
  });
  const files = atlases.flatMap((atlas) => [
    { name: `${atlas.atlasId}.png`, bytes: atlas.png, contentType: "image/png" },
    json(`${atlas.atlasId}.animations.json`, atlas.animations),
  ]);
  files.push(...materialAtlasFiles(atlases));
  const materials = atlasMaterials(atlases);
  if (Object.keys(materials).length > 0)
    files.push(json("materials.json", canonicalJson(materials)));
  if (atlases.length > 0) files.push(json(ATLAS_INDEX, atlasIndex(atlases)));
  return files;
}
