import { readFileSync } from "node:fs";
import { decodeAssetManifest, decodeAssetStyleProfile } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  buildAtlases,
  decodePng,
  encodePng,
  sha256Hex,
  validateSource,
  worldPaletteProblems,
} from "../src/index.js";

const template = JSON.parse(
  readFileSync(
    new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
    "utf8",
  ),
);
const sizes = Object.fromEntries(
  ["actor", "object", "terrain", "effect"].map((role) => [role, { maxWidth: 4, maxHeight: 4 }]),
);
const base = {
  styleProfileVersion: 1,
  sizes,
  alpha: { mode: "binary" },
  edge: "transparent-pixel",
};
const pixel = decodeAssetStyleProfile({
  ...base,
  colour: { mode: "palette", colours: ["#202020"], strictness: "exact" },
});
const cartoon = decodeAssetStyleProfile({
  ...base,
  edge: "transparent-border",
  colour: { mode: "palette", colours: ["#202020", "#808080"], strictness: "subset" },
});
const painterly = decodeAssetStyleProfile({
  ...base,
  alpha: { mode: "soft", boundsThreshold: 180 },
  colour: { mode: "unrestricted" },
  edge: "unrestricted",
});
const profiles = { pixel, cartoon, painterly };
const reasons = (rows: string[]) => rows.map((p) => p.replace("sample/idle: ", ""));
function entry(alpha = 255, edge = false) {
  const rgba = new Uint8Array(4 * 4 * 4);
  rgba.set([32, 32, 32, alpha], (1 * 4 + 1) * 4);
  if (edge) rgba.set([17, 99, 201, 64], 0);
  const bytes = encodePng({ width: 4, height: 4, rgba });
  const manifest = decodeAssetManifest({
    ...template,
    assetId: "sample",
    animationFamily: "idle",
    source: { ...template.source, path: "assets/source/sample/idle.png" },
    frames: { width: 4, height: 4, count: 1, durationMs: null },
    anchor: { x: 1, y: 1 },
    bounds: { x: 1, y: 1, width: 1, height: 1 },
    palette: ["#202020"],
    contentHash: sha256Hex(bytes),
    atlas: { atlasId: "sample", x: 0, y: 0 },
  });
  return { manifest, bytes, rgba };
}
it("validates and builds code-generated pixel, cartoon and painterly art", () => {
  for (const [name, profile] of Object.entries(profiles)) {
    const art = name === "painterly" ? entry(180, true) : entry();
    const validate = (
      manifest = art.manifest,
      bytes = art.bytes,
      location = "assets/manifests/sample/idle.json",
    ) => reasons(validateSource(manifest, bytes, location, profile));
    expect(validate()).toEqual([]);
    const placeholder = entry();
    expect(validateSource(placeholder.manifest, placeholder.bytes, undefined, profile)).toEqual([]);
    const [atlas] = buildAtlases([art]);
    expect(decodePng(atlas!.png).rgba).toEqual(art.rgba);
    expect(validate({ ...art.manifest, contentHash: "0".repeat(64) })).toContain(
      "contentHash does not equal the sha256 of assets/source/sample/idle.png",
    );
    expect(validate(art.manifest, art.bytes, "wrong.json")[0]).toContain("naming:");
    expect(validate({ ...art.manifest, bounds: { x: 0, y: 0, width: 1, height: 1 } })).toContain(
      "bounds: expected 1,1 1x1, found 0,0 1x1",
    );
    expect(validate({ ...art.manifest, frames: { ...art.manifest.frames, count: 2 } })).toContain(
      "dimensions: PNG is 4x4, expected 8x4",
    );
    expect(validate(art.manifest, new Uint8Array([0])).join("\n")).toContain("PNG");
    for (const role of ["actor", "object", "terrain", "effect"] as const) {
      const small = {
        ...profile,
        sizes: { ...profile.sizes, [role]: { maxWidth: 3, maxHeight: 3 } },
      };
      const manifest = { ...art.manifest, semantic: { ...art.manifest.semantic, role } };
      expect(validateSource(manifest, art.bytes, undefined, small)).toContain(
        `sample/idle: STYLE_SIZE: ${role} frames exceed 3x3`,
      );
    }
  }
});
it("retains pixel inventory, alpha and edge refusals while applying declared subset and threshold rules", () => {
  const art = entry();
  const validate = (manifest = art.manifest, bytes = art.bytes, profile = pixel) =>
    reasons(validateSource(manifest, bytes, undefined, profile));
  expect(validateSource(art.manifest, art.bytes)).toEqual([
    "sample/idle: STYLE_PROFILE_REQUIRED: a declared world style profile is required",
  ]);
  expect(validate({ ...art.manifest, palette: ["#808080"] })).toEqual([
    "STYLE_PALETTE: palette: #202020 is not listed",
    "STYLE_PALETTE: palette: #808080 is listed but unused",
  ]);
  const soft = entry(180, true);
  expect(validate(soft.manifest, soft.bytes).join("\n")).toContain("STYLE_ALPHA");
  expect(validate(soft.manifest, soft.bytes, cartoon).join("\n")).toContain("STYLE_EDGE");
  expect(validate(soft.manifest, soft.bytes).join("\n")).toContain(
    "STYLE_PALETTE: #1163c9 is not in the world palette",
  );
  const exact = decodeAssetStyleProfile({
    ...cartoon,
    colour: { mode: "palette", colours: ["#202020", "#808080"], strictness: "exact" },
  });
  // `exact` is per world: one asset may use part of the palette.
  expect(validate(art.manifest, art.bytes, exact)).toEqual([]);
  expect(worldPaletteProblems([art.manifest], exact)).toEqual([
    "STYLE_PALETTE: world palette colour #808080 is unused by every asset",
  ]);
  expect(validate(soft.manifest, soft.bytes, painterly)).toEqual([]);
  expect(
    validate(soft.manifest, soft.bytes, {
      ...painterly,
      alpha: { mode: "soft", boundsThreshold: 181 },
    }),
  ).toContain("bounds: expected an opaque pixel, found 1,1 1x1");
  const rgba = new Uint8Array(4 * 4 * 4).fill(32);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const bytes = encodePng({ width: 4, height: 4, rgba });
  const solid = {
    ...art.manifest,
    contentHash: sha256Hex(bytes),
    bounds: { x: 0, y: 0, width: 4, height: 4 },
  };
  expect(validate(solid, bytes)).toEqual([
    "STYLE_EDGE: transparency: a non-terrain asset needs a transparent pixel",
  ]);
  expect(validate({ ...solid, semantic: { ...solid.semantic, role: "terrain" } }, bytes)).toEqual(
    [],
  );
});
