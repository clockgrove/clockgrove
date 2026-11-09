import "../../../packages/assets/bin/typescript-hooks.mjs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { decodeAssetManifest } = await import("../../../packages/contracts/src/index.ts");
const { packAtlas, assetKey } = await import("../../../packages/assets/src/atlas.ts");
const { encodePng } = await import("../../../packages/assets/src/png.ts");
const { sha256Hex } = await import("../../../packages/assets/src/validate.ts");
const manifests = "worlds/fixture/assets/manifests";
const files = readdirSync(join(root, manifests))
  .sort()
  .flatMap((assetId) =>
    readdirSync(join(root, manifests, assetId))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const path = `${manifests}/${assetId}/${name}`;
        const value = JSON.parse(readFileSync(join(root, path), "utf8"));
        return { path, manifest: decodeAssetManifest(value, path) };
      }),
  );
const placements = packAtlas(files.map((file) => file.manifest));
for (const file of files) {
  const manifest = JSON.parse(readFileSync(join(root, file.path), "utf8"));
  const { width, height, count } = manifest.frames;
  const total = width * count;
  const rgba = new Uint8Array(total * height * 4);
  const bounds = manifest.bounds;
  for (let frame = 0; frame < count; frame++)
    for (let y = bounds.y; y < bounds.y + bounds.height; y++)
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        const colour = (x + y + frame) % 2 ? 128 : 32;
        rgba.set([colour, colour, colour, 255], (y * total + frame * width + x) * 4);
      }
  const bytes = encodePng({ width: total, height, rgba });
  const source = join(root, "worlds/fixture", manifest.source.path);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, bytes);
  manifest.contentHash = sha256Hex(bytes);
  const placement = placements.get(assetKey(manifest));
  manifest.atlas = { atlasId: placement.atlasId, x: placement.x, y: placement.y };
  writeFileSync(join(root, file.path), `${JSON.stringify(manifest, null, 2)}\n`);
}
