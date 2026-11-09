import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  type AssetManifest,
  decodeAssetManifest,
  decodeAssetStyleProfile,
} from "@clockgrove/contracts";
import { afterAll, expect, it } from "vitest";
import {
  type AssetEntry,
  buildAtlases,
  encodePng,
  r2AssetStore,
  reviewedFiles,
  sha256Hex,
  uploadReviewedAssets,
  validateSource,
  worldPaletteProblems,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(
  require.resolve("wrangler/package.json"),
)("miniflare");
const template = JSON.parse(
  readFileSync(
    new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
    "utf8",
  ),
);
const unreviewed = decodeAssetManifest(
  JSON.parse(
    readFileSync(
      new URL("../../contracts/test/fixtures/asset-manifest/unreviewed.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** A 4x4-frame strip whose frame i paints a 2x3 block in the i-th of two colours. */
function entry(assetId: string, count: number, x: number, atlasId = "test"): AssetEntry {
  const palette = ["#202020", "#808080"];
  const rgba = new Uint8Array(4 * count * 4 * 4);
  for (let f = 0; f < count; f++)
    for (let py = 1; py < 4; py++)
      for (let px = 1; px < 3; px++) {
        const c = f === 0 ? 0x20 : 0x80;
        rgba.set([c, c, c, 255], (py * 4 * count + f * 4 + px) * 4);
      }
  const bytes = encodePng({ width: 4 * count, height: 4, rgba });
  const manifest = decodeAssetManifest({
    ...template,
    assetId,
    source: { ...template.source, path: `assets/source/${assetId}/idle.png` },
    frames: { width: 4, height: 4, count, durationMs: count > 1 ? 100 : null },
    anchor: { x: 2, y: 3 },
    bounds: { x: 1, y: 1, width: 2, height: 3 },
    palette: count > 1 ? palette : [palette[0]],
    contentHash: sha256Hex(bytes),
    atlas: { atlasId, x, y: 0 },
  });
  return { manifest, bytes };
}

// The fixture's own pixel-art profile (exact two-colour palette), unmodified.
const fixtureProfile = decodeAssetStyleProfile(
  JSON.parse(
    readFileSync(
      new URL("../../../worlds/fixture/reference/asset-style.json", import.meta.url),
      "utf8",
    ),
  ),
);
const entries = [
  entry("critter-a", 2, 0),
  entry("critter-b", 1, 8),
  entry("critter-c", 1, 0, "other"),
];
const golden = {
  sceneSha256: "scene",
  approval: {
    status: "approved" as const,
    reviewer: "synthetic-reviewer",
    approvedSceneSha256: "scene",
  },
};
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('')}}",
    r2Buckets: ["ASSETS_BUCKET"],
  }),
);
afterAll(() => mf.dispose());

it("builds identical atlases in any order and uploads every page and its index once to R2, refusing unreviewed assets", async () => {
  // critter-b uses one of the two world colours; `exact` holds across the world, not per asset.
  expect(
    entries.flatMap((e) => validateSource(e.manifest, e.bytes, undefined, fixtureProfile)),
  ).toEqual([]);
  const manifests = entries.map((e) => e.manifest);
  expect(worldPaletteProblems(manifests, fixtureProfile)).toEqual([]);
  expect(worldPaletteProblems(manifests.slice(1), fixtureProfile)).toEqual([
    "STYLE_PALETTE: world palette colour #808080 is unused by every asset",
  ]);
  const [forward] = buildAtlases(entries);
  const [reversed] = buildAtlases([...entries].reverse());
  expect(Buffer.from(forward?.png ?? [])).toEqual(Buffer.from(reversed?.png ?? []));
  expect(forward?.animations).toBe(reversed?.animations);
  expect(JSON.parse(forward?.animations ?? "").image.sha256).toBe(
    sha256Hex(forward?.png ?? new Uint8Array()),
  );

  const bucket = await mf.getR2Bucket("ASSETS_BUCKET");
  const store = r2AssetStore(bucket);
  const first = await uploadReviewedAssets(store, { entries, golden });
  for (const key of first.uploaded) {
    const object = await bucket.get(key);
    expect(
      createHash("sha256")
        .update(Buffer.from(await object.arrayBuffer()))
        .digest("hex"),
    ).toBe(key.slice(7));
  }
  // From the directory's key alone, a shell finds the page index and then every page it lists,
  // byte for byte as the asset build writes them, each PNG matching its animations' digest.
  const read = async (key: string) => Buffer.from(await (await bucket.get(key)).arrayBuffer());
  const { files } = JSON.parse((await read(first.directory)).toString());
  const reviewed = reviewedFiles(buildAtlases(entries));
  expect(Object.keys(files).sort()).toEqual(reviewed.map(({ name }) => name).sort());
  for (const { name, bytes } of reviewed)
    expect(await read(files[name])).toEqual(Buffer.from(bytes));
  const { atlases } = JSON.parse((await read(files["atlases.json"])).toString());
  expect(atlases).toEqual(["other", "test"]);
  for (const page of atlases)
    expect(sha256Hex(await read(files[`${page}.png`]))).toBe(
      JSON.parse((await read(files[`${page}.animations.json`])).toString()).image.sha256,
    );
  expect(first.uploaded).toEqual([...Object.values(files), first.directory].sort());
  expect(await uploadReviewedAssets(store, { entries, golden })).toEqual({
    uploaded: [],
    skipped: first.uploaded,
    directory: first.directory,
  });

  const refused: AssetManifest = unreviewed;
  const before = (await bucket.list()).objects.length;
  await expect(
    uploadReviewedAssets(store, {
      entries: [...entries, { manifest: refused, bytes: entries[0]?.bytes ?? new Uint8Array() }],
      golden,
    }),
  ).rejects.toThrow(/REVIEW_NOT_APPROVED/u);
  for (const reviewer of [null, "github-actions[bot]"])
    await expect(
      uploadReviewedAssets(store, {
        entries,
        golden: { ...golden, approval: { ...golden.approval, reviewer } },
      }),
    ).rejects.toThrow(/GOLDEN_REVIEWER_NOT_HUMAN/u);
  expect((await bucket.list()).objects.length).toBe(before);
});
