import { createHash } from "node:crypto";
import type { AssetManifest } from "@clockgrove/contracts";
import { decodePng } from "./png.js";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hexColour(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Everything wrong with a source PNG against its manifest; empty when it is valid. */
export function validateSource(
  manifest: AssetManifest,
  bytes: Uint8Array,
  manifestPath?: string,
): string[] {
  const id = `${manifest.assetId}/${manifest.animationFamily}`;
  const problems: string[] = [];
  const expectedPath = `assets/manifests/${id}.json`;
  if (manifestPath !== undefined && manifestPath !== expectedPath)
    problems.push(`${id}: naming: manifest must be at ${expectedPath}, found ${manifestPath}`);
  if (sha256Hex(bytes) !== manifest.contentHash)
    problems.push(`${id}: contentHash does not equal the sha256 of ${manifest.source.path}`);
  let image: ReturnType<typeof decodePng>;
  try {
    image = decodePng(bytes);
  } catch (error) {
    return [...problems, `${id}: ${(error as Error).message}`];
  }
  const { width: fw, height: fh, count } = manifest.frames;
  if (image.width !== fw * count || image.height !== fh)
    return [
      ...problems,
      `${id}: dimensions: PNG is ${image.width}x${image.height}, expected ${fw * count}x${fh}`,
    ];
  const used = new Set<string>();
  let transparent = false;
  let badAlpha = false;
  let minX = fw;
  let minY = fh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const alpha = image.rgba[i + 3] as number;
      if (alpha === 0) transparent = true;
      else if (alpha !== 255) badAlpha = true;
      else {
        used.add(
          hexColour(
            image.rgba[i] as number,
            image.rgba[i + 1] as number,
            image.rgba[i + 2] as number,
          ),
        );
        const fx = x % fw;
        minX = Math.min(minX, fx);
        maxX = Math.max(maxX, fx);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  if (badAlpha) problems.push(`${id}: transparency: every pixel alpha must be 0 or 255`);
  if (!transparent && manifest.semantic.role !== "terrain")
    problems.push(`${id}: transparency: a non-terrain asset needs a transparent pixel`);
  for (const colour of used)
    if (!manifest.palette.includes(colour))
      problems.push(`${id}: palette: ${colour} is not listed`);
  for (const colour of manifest.palette)
    if (!used.has(colour)) problems.push(`${id}: palette: ${colour} is listed but unused`);
  const b = manifest.bounds;
  if (
    maxX < 0 ||
    b.x !== minX ||
    b.y !== minY ||
    b.width !== maxX - minX + 1 ||
    b.height !== maxY - minY + 1
  )
    problems.push(
      `${id}: bounds: expected ${maxX < 0 ? "an opaque pixel" : `${minX},${minY} ${maxX - minX + 1}x${maxY - minY + 1}`}, found ${b.x},${b.y} ${b.width}x${b.height}`,
    );
  return problems;
}
