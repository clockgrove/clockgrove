import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type AssetManifest, decodeAssetManifest } from "@clockgrove/contracts";
import { afterAll, expect, it } from "vitest";
import {
  type AssetEntry,
  buildAtlases,
  encodePng,
  r2AssetStore,
  sha256Hex,
  uploadReviewedAssets,
  validateSource,
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
function entry(assetId: string, count: number, x: number): AssetEntry {
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
    atlas: { atlasId: "test", x, y: 0 },
  });
  return { manifest, bytes };
}

const entries = [entry("critter-a", 2, 0), entry("critter-b", 1, 8)];
const golden = {
  sceneSha256: "scene",
  approval: { status: "approved" as const, approvedSceneSha256: "scene" },
};
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('')}}",
    r2Buckets: ["ASSETS_BUCKET"],
  }),
);
afterAll(() => mf.dispose());

it("builds identical atlases in any order and uploads them once to R2, refusing unreviewed assets", async () => {
  expect(entries.flatMap((e) => validateSource(e.manifest, e.bytes))).toEqual([]);
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
  expect(first.uploaded).toEqual(
    [
      sha256Hex(forward?.png ?? new Uint8Array()),
      sha256Hex(new TextEncoder().encode(forward?.animations)),
    ]
      .map((hex) => `sha256/${hex}`)
      .sort(),
  );
  for (const key of first.uploaded) {
    const object = await bucket.get(key);
    expect(
      createHash("sha256")
        .update(Buffer.from(await object.arrayBuffer()))
        .digest("hex"),
    ).toBe(key.slice(7));
  }
  expect(await uploadReviewedAssets(store, { entries, golden })).toEqual({
    uploaded: [],
    skipped: first.uploaded,
  });

  const refused: AssetManifest = unreviewed;
  const before = (await bucket.list()).objects.length;
  await expect(
    uploadReviewedAssets(store, {
      entries: [...entries, { manifest: refused, bytes: entries[0]?.bytes ?? new Uint8Array() }],
      golden,
    }),
  ).rejects.toThrow(/REVIEW_NOT_APPROVED/u);
  expect((await bucket.list()).objects.length).toBe(before);
});
