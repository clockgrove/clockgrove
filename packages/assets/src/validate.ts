import { createHash } from "node:crypto";
import type { AssetManifest, AssetStyleProfile, MaterialChannel } from "@clockgrove/contracts";
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
  materialSources: Readonly<Record<string, Uint8Array>> = {},
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
  return [...problems, ...validateMaterial(manifest, bytes, profile, materialSources)];
}

/**
 * `exact` palette strictness applies to the whole world: every declared colour appears in at
 * least one manifest's palette. Run after `validateSource`, which proves each manifest palette
 * lists exactly the colours its source uses.
 */
export function worldPaletteProblems(
  manifests: readonly AssetManifest[],
  profile: AssetStyleProfile,
): string[] {
  if (profile.colour.mode !== "palette" || profile.colour.strictness !== "exact") return [];
  const used = new Set(manifests.flatMap((m) => m.palette));
  return profile.colour.colours
    .filter((colour) => !used.has(colour))
    .map((colour) => `STYLE_PALETTE: world palette colour ${colour} is unused by every asset`);
}

/** Source bytes are provided by the caller; this validator never synthesizes missing channels. */
export function validateMaterial(
  manifest: AssetManifest,
  bytes: Uint8Array,
  profile: AssetStyleProfile,
  sources: Readonly<Record<string, Uint8Array>>,
): string[] {
  const id = `${manifest.assetId}/${manifest.animationFamily}`;
  const policy = profile.material?.roles[manifest.semantic.role];
  if (manifest.material === undefined)
    return policy === undefined
      ? []
      : [`${id}: MATERIAL_REQUIRED: role declares material channels`];
  if (policy === undefined) return [`${id}: MATERIAL_POLICY_REQUIRED: role has no material policy`];
  const problems: string[] = [];
  const fail = (code: string, detail: string) => problems.push(`${id}: ${code}: ${detail}`);
  const { width, height, count } = manifest.frames;
  for (const rendition of manifest.material.renditions) {
    const density = rendition.density;
    const fw = width * density;
    const fh = height * density;
    const decoded = new Map<MaterialChannel, ReturnType<typeof decodePng>>();
    const channels = Object.keys(rendition.channels) as MaterialChannel[];
    if (Object.keys(policy).sort().join() !== [...channels].sort().join())
      fail("MATERIAL_CHANNELS", `${density}x channels must equal the role policy`);
    for (const channel of channels) {
      const source = rendition.channels[channel];
      if (source === undefined) continue;
      const label = `${density}x/${channel}`;
      const data = source.path === manifest.source.path ? bytes : sources[source.path];
      if (data === undefined) {
        fail("MATERIAL_SOURCE_REQUIRED", label);
        continue;
      }
      if (sha256Hex(data) !== source.sha256) fail("MATERIAL_HASH", label);
      if (
        density === 1 &&
        channel === "albedo" &&
        (source.path !== manifest.source.path || source.sha256 !== manifest.contentHash)
      )
        fail("MATERIAL_ALBEDO", "1x albedo must name the owning source and contentHash");
      let image: ReturnType<typeof decodePng>;
      try {
        image = decodePng(data);
      } catch {
        fail("MATERIAL_DECODE", label);
        continue;
      }
      if (image.width !== fw * count || image.height !== fh) {
        fail("MATERIAL_GRID", `${label} expected ${fw * count}x${fh}`);
        continue;
      }
      decoded.set(channel, image);
    }
    const albedo = decoded.get("albedo");
    if (albedo === undefined) continue;
    let minX = fw,
      minY = fh,
      maxX = -1,
      maxY = -1;
    let badAlpha = false,
      transparent = false,
      paintedBorder = false,
      badPalette = false;
    const threshold = profile.alpha.mode === "binary" ? 255 : profile.alpha.boundsThreshold;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw * count; x++) {
        const alpha = albedo.rgba[(y * albedo.width + x) * 4 + 3] as number;
        if (alpha === 0) transparent = true;
        if (alpha !== 0 && alpha !== 255) badAlpha = true;
        if (alpha > 0 && profile.colour.mode === "palette") {
          const offset = (y * albedo.width + x) * 4;
          if (
            !profile.colour.colours.includes(
              hexColour(
                albedo.rgba[offset] as number,
                albedo.rgba[offset + 1] as number,
                albedo.rgba[offset + 2] as number,
              ),
            )
          )
            badPalette = true;
        }
        if (alpha > 0 && (x % fw === 0 || x % fw === fw - 1 || y === 0 || y === fh - 1))
          paintedBorder = true;
        if (alpha < threshold) continue;
        minX = Math.min(minX, x % fw);
        maxX = Math.max(maxX, x % fw);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    if (badPalette) fail("MATERIAL_PALETTE", `${density}x/albedo violates declared palette`);
    if (profile.alpha.mode === "binary" && badAlpha)
      fail("MATERIAL_ALPHA_MODE", `${density}x/albedo requires binary alpha`);
    if (
      (profile.edge === "transparent-border" && paintedBorder) ||
      (profile.edge === "transparent-pixel" && !transparent && manifest.semantic.role !== "terrain")
    )
      fail("MATERIAL_EDGE", `${density}x/albedo violates declared edge policy`);
    const b = manifest.bounds;
    if (
      minX !== b.x * density ||
      minY !== b.y * density ||
      maxX + 1 !== (b.x + b.width) * density ||
      maxY + 1 !== (b.y + b.height) * density
    )
      fail("MATERIAL_BOUNDS", `${density}x/albedo does not match scaled owning bounds`);
    for (const [channel, image] of decoded) {
      const limit = policy[channel];
      if (limit === undefined) continue;
      let alpha = false,
        range = false,
        temporal = false;
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw * count; x++) {
          const offset = (y * image.width + x) * 4;
          if (image.rgba[offset + 3] !== albedo.rgba[offset + 3]) alpha = true;
          const nextX = (x + fw) % image.width;
          const next = (y * image.width + nextX) * 4;
          for (let c = 0; c < 3; c++) {
            const value = image.rgba[offset + c] as number;
            if ((image.rgba[offset + 3] as number) > 0 && (value < limit.min || value > limit.max))
              range = true;
            if (
              count > 1 &&
              ((image.rgba[offset + 3] as number) > 0 || (image.rgba[next + 3] as number) > 0) &&
              Math.abs(value - (image.rgba[next + c] as number)) > limit.maxFrameChange
            )
              temporal = true;
          }
        }
      if (alpha) fail("MATERIAL_ALPHA", `${density}x/${channel} coverage differs from albedo`);
      if (range) fail("MATERIAL_RANGE", `${density}x/${channel} outside declared RGB range`);
      if (temporal)
        fail(
          "MATERIAL_FRAME_CHANGE",
          `${density}x/${channel} exceeds declared loop frame-change bound`,
        );
    }
  }
  return problems;
}
