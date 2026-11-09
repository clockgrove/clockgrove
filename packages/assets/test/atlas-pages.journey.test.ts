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
function entry(id: string, height: number, y: number, atlasId = "sheet", width = 600) {
  const rgba = new Uint8Array(width * 2 * height * 4);
  for (const x of [1, width + 1]) rgba.set([23, 97, 201, 180], (width * 2 + x) * 4);
  const bytes = encodePng({ width: width * 2, height, rgba });
  const manifest = decodeAssetManifest({
    ...template,
    assetId: id,
    source: { ...template.source, path: `assets/source/${id}/idle.png` },
    frames: { width, height, count: 2, durationMs: 100 },
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
    { atlasId: "sheet", x: 0, y: 0, width: 1200, height: 1000 },
    { atlasId: "sheet", x: 0, y: 1000, width: 1200, height: 1000 },
    { atlasId: "sheet-page-3", x: 0, y: 0, width: 1200, height: 600 },
    { atlasId: "sheet-page-3", x: 0, y: 600, width: 1200, height: 200 },
    { atlasId: "sheet-page-2", x: 0, y: 0, width: 8, height: 4 },
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
  const tooWide = { ...layout[0]!, frames: { ...layout[0]!.frames, width: 1025 } };
  expect(() => buildAtlases([{ manifest: tooWide, bytes: new Uint8Array() }])).toThrow(
    "a/idle: ATLAS_SIZE: strip exceeds 2048 px",
  );
  expect(() =>
    packAtlas([{ ...layout[0]!, frames: { ...layout[0]!.frames, height: 2049 } }]),
  ).toThrow("a/idle: ATLAS_SIZE: strip exceeds 2048 px");
});
