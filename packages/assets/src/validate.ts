import { createHash } from "node:crypto";
import type { AssetManifest, AssetStyleProfile } from "@clockgrove/contracts";
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
  profile?: AssetStyleProfile,
): string[] {
  const id = `${manifest.assetId}/${manifest.animationFamily}`;
  const problems: string[] = [];
  if (profile === undefined)
    return [`${id}: STYLE_PROFILE_REQUIRED: a declared world style profile is required`];
  const limit = profile.sizes[manifest.semantic.role];
  if (manifest.frames.width > limit.maxWidth || manifest.frames.height > limit.maxHeight)
    problems.push(
      `${id}: STYLE_SIZE: ${manifest.semantic.role} frames exceed ${limit.maxWidth}x${limit.maxHeight}`,
    );
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
  let paintedBorder = false;
  const threshold = profile.alpha.mode === "binary" ? 255 : profile.alpha.boundsThreshold;
  let minX = fw;
  let minY = fh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const alpha = image.rgba[i + 3] as number;
      if (alpha === 0) transparent = true;
      if (alpha !== 0 && alpha !== 255) badAlpha = true;
      const fx = x % fw;
      if (alpha > 0 && (fx === 0 || fx === fw - 1 || y === 0 || y === fh - 1)) paintedBorder = true;
      if (alpha > 0) {
        used.add(
          hexColour(
            image.rgba[i] as number,
            image.rgba[i + 1] as number,
            image.rgba[i + 2] as number,
          ),
        );
      }
      if (alpha >= threshold) {
        minX = Math.min(minX, fx);
        maxX = Math.max(maxX, fx);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  if (profile.alpha.mode === "binary" && badAlpha)
    problems.push(`${id}: STYLE_ALPHA: transparency: every pixel alpha must be 0 or 255`);
  if (profile.edge === "transparent-pixel" && !transparent && manifest.semantic.role !== "terrain")
    problems.push(`${id}: STYLE_EDGE: transparency: a non-terrain asset needs a transparent pixel`);
  if (profile.edge === "transparent-border" && paintedBorder)
    problems.push(`${id}: STYLE_EDGE: every frame needs a transparent border`);
  if (profile.colour.mode === "palette") {
    for (const colour of used) {
      if (!profile.colour.colours.includes(colour))
        problems.push(`${id}: STYLE_PALETTE: ${colour} is not in the world palette`);
      if (!manifest.palette.includes(colour))
        problems.push(`${id}: STYLE_PALETTE: palette: ${colour} is not listed`);
    }
    for (const colour of manifest.palette)
      if (!used.has(colour))
        problems.push(`${id}: STYLE_PALETTE: palette: ${colour} is listed but unused`);
    if (profile.colour.strictness === "exact")
      for (const colour of profile.colour.colours)
        if (!used.has(colour))
          problems.push(`${id}: STYLE_PALETTE: world palette colour ${colour} is unused`);
  }
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
