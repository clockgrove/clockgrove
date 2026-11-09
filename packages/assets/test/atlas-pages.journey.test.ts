import { readFileSync } from "node:fs";
import { decodeAssetManifest, decodeAssetStyleProfile } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  buildAtlases,
  decodePng,
  encodePng,
  packAtlas,
  sha256Hex,
  validateSource,
} from "../src/index.js";

const template = JSON.parse(
  readFileSync(
    new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
    "utf8",
  ),
);
const profile = decodeAssetStyleProfile({
  styleProfileVersion: 1,
  alpha: { mode: "soft", boundsThreshold: 180 },
  colour: { mode: "unrestricted" },
  edge: "unrestricted",
  sizes: Object.fromEntries(
    ["actor", "object", "terrain", "effect"].map((role) => [
      role,
      { maxWidth: 1024, maxHeight: 2048 },
    ]),
  ),
});
function entry(id: string, height: number, y: number, atlasId = "sheet", width = 600, count = 2) {
  const rgba = new Uint8Array(width * count * height * 4);
  for (let f = 0; f < count; f++)
    rgba.set([23, 97, 201 - f, 180], (width * count + f * width + 1) * 4);
  const bytes = encodePng({ width: width * count, height, rgba });
  const manifest = decodeAssetManifest({
    ...template,
    assetId: id,
    source: { ...template.source, path: `assets/source/${id}/idle.png` },
    frames: { width, height, count, durationMs: 100 },
    anchor: { x: 1, y: 1 },
    bounds: { x: 1, y: 1, width: 1, height: 1 },
    contentHash: sha256Hex(bytes),
    atlas: { atlasId, x: 0, y },
  });
  expect(validateSource(manifest, bytes, undefined, profile)).toEqual([]);
  return { manifest, bytes };
}

it("builds bounded deterministic pages for large soft-alpha strips, preserving pending slots and declared IDs", () => {
  const entries = [
    entry("a", 1000, 0),
    entry("b", 1000, 1000),
    entry("c", 600, 0),
    entry("d", 200, 600),
  ];
  const reserved = entry("reserved", 4, 0, "sheet-page-2", 4);
  entries.push(reserved);
  const layout = entries.map((e) => e.manifest);
  expect([...packAtlas(layout).values()]).toEqual([
    { atlasId: "sheet", x: 0, y: 0, width: 1200, height: 1000, columns: 2, continued: [] },
    { atlasId: "sheet", x: 0, y: 1000, width: 1200, height: 1000, columns: 2, continued: [] },
    { atlasId: "sheet-page-3", x: 0, y: 0, width: 1200, height: 600, columns: 2, continued: [] },
    { atlasId: "sheet-page-3", x: 0, y: 600, width: 1200, height: 200, columns: 2, continued: [] },
    { atlasId: "sheet-page-2", x: 0, y: 0, width: 8, height: 4, columns: 2, continued: [] },
  ]);
  const atlases = buildAtlases(entries);
  expect(buildAtlases([...entries].reverse(), [...layout].reverse())).toEqual(atlases);
  expect(
    atlases.map((a) => [
      a.atlasId,
      JSON.parse(a.animations).image.width,
      JSON.parse(a.animations).image.height,
    ]),
  ).toEqual([
    ["sheet", 1200, 2000],
    ["sheet-page-3", 1200, 800],
    ["sheet-page-2", 8, 4],
  ]);
  const [subset] = buildAtlases([entries[3]!], layout);
  expect(subset!.atlasId).toBe("sheet-page-3");
  expect(JSON.parse(subset!.animations).animations[0].frames).toEqual([
    { x: 0, y: 600, width: 600, height: 200 },
    { x: 600, y: 600, width: 600, height: 200 },
  ]);
  const image = decodePng(subset!.png);
  expect([image.width, image.height]).toEqual([1200, 800]);
  expect([...image.rgba.subarray((601 * 1200 + 1) * 4, (601 * 1200 + 1) * 4 + 4)]).toEqual([
    23, 97, 201, 180,
  ]);
  expect(image.rgba.subarray(0, 600 * 1200 * 4).every((v) => v === 0)).toBe(true);
  // An 8-frame strip of 300 px frames (2400 px) wraps into two rows of four; each frame keeps its rect.
  const walk = entry("walk", 300, 0, "walk", 300, 8);
  const [wrapped] = buildAtlases([walk]);
  const frames = JSON.parse(wrapped!.animations).animations[0].frames;
  expect([frames[3], frames[4], frames[7]]).toEqual([
    { x: 900, y: 0, width: 300, height: 300 },
    { x: 0, y: 300, width: 300, height: 300 },
    { x: 900, y: 300, width: 300, height: 300 },
  ]);
  const sheet = decodePng(wrapped!.png);
  expect([sheet.width, sheet.height]).toEqual([1200, 600]);
  for (const [f, { x, y }] of frames.entries())
    expect([
      ...sheet.rgba.subarray(((y + 1) * 1200 + x + 1) * 4, ((y + 1) * 1200 + x + 2) * 4),
    ]).toEqual([23, 97, 201 - f, 180]);
  expect(() =>
    packAtlas([{ ...layout[0]!, frames: { ...layout[0]!.frames, height: 2049 } }]),
  ).toThrow("a/idle: ATLAS_SIZE: a 600x2049 px frame does not fit one 2048 px page");
});

it("continues a strip whose rows pass one page onto further pages; each frame names its page", () => {
  // Every frame size the profile envelope admits packs at any count the manifest allows.
  const base = entry("base", 4, 0, "hero", 4, 2).manifest;
  const strip = (width: number, height: number, count: number) => ({
    ...base,
    frames: { ...base.frames, width, height, count },
  });
  expect(
    [
      [1024, 1024, 5],
      [700, 700, 9],
      [512, 512, 17],
      [1024, 2048, 32],
      [1024, 1025, 3],
    ].map(([w, h, n]) => {
      const p = packAtlas([strip(w!, h!, n!)]).get("base/idle")!;
      return [p.atlasId, p.columns, p.width, p.height, p.continued];
    }),
  ).toEqual([
    ["hero", 2, 2048, 2048, [{ atlasId: "hero-page-2", x: 0, y: 0, width: 1024, height: 1024 }]],
    [
      "hero",
      2,
      1400,
      1400,
      [
        { atlasId: "hero-page-2", x: 0, y: 0, width: 1400, height: 1400 },
        { atlasId: "hero-page-3", x: 0, y: 0, width: 700, height: 700 },
      ],
    ],
    ["hero", 4, 2048, 2048, [{ atlasId: "hero-page-2", x: 0, y: 0, width: 512, height: 512 }]],
    [
      "hero",
      2,
      2048,
      2048,
      Array.from({ length: 15 }, (_, n) => ({
        atlasId: `hero-page-${n + 2}`,
        x: 0,
        y: 0,
        width: 2048,
        height: 2048,
      })),
    ],
    ["hero", 2, 2048, 1025, [{ atlasId: "hero-page-2", x: 0, y: 0, width: 1024, height: 1025 }]],
  ]);
  // Built: a 5-frame strip of 1024 px frames fills page one with four frames; the fifth leads
  // page two, and the next strip in the group continues that page's shelf.
  const hero = entry("hero", 1024, 0, "hero", 1024, 5);
  const next = entry("next", 4, 0, "hero", 4, 2);
  const layout = [hero.manifest, { ...next.manifest, atlas: { ...next.manifest.atlas, x: 1024 } }];
  const atlases = buildAtlases([hero, { ...next, manifest: layout[1]! }], layout);
  expect(atlases.map((a) => a.atlasId)).toEqual(["hero", "hero-page-2"]);
  const [first, second] = atlases.map((a) => JSON.parse(a.animations));
  expect(first.animations.map((a: { assetId: string }) => a.assetId)).toEqual(["hero"]);
  expect(first.animations[0].frames).toEqual([
    { x: 0, y: 0, width: 1024, height: 1024 },
    { x: 1024, y: 0, width: 1024, height: 1024 },
    { x: 0, y: 1024, width: 1024, height: 1024 },
    { x: 1024, y: 1024, width: 1024, height: 1024 },
    { atlasId: "hero-page-2", x: 0, y: 0, width: 1024, height: 1024 },
  ]);
  expect(second.animations.map((a: { assetId: string }) => a.assetId)).toEqual(["next"]);
  expect(second.animations[0].frames[0]).toEqual({ x: 1024, y: 0, width: 4, height: 4 });
  expect([first.image.width, first.image.height, second.image.width, second.image.height]).toEqual([
    2048, 2048, 1032, 1024,
  ]);
  const pages = atlases.map((a) => decodePng(a.png));
  first.animations[0].frames.forEach((f: { atlasId?: string; x: number; y: number }, n: number) => {
    const page = pages[f.atlasId === undefined ? 0 : 1]!;
    const at = ((f.y + 1) * page.width + f.x + 1) * 4;
    expect([...page.rgba.subarray(at, at + 4)]).toEqual([23, 97, 201 - n, 180]);
  });
  expect(buildAtlases([{ ...next, manifest: layout[1]! }, hero], [...layout].reverse())).toEqual(
    atlases,
  );
});
