// Synthetic placeholder material maps (issue 67: "synthetic or hand-made placeholder maps if real ones
// aren't ready"). Generated deterministically in code, identically for every candidate: no image files,
// so nothing goes through Git LFS and a file:// page never taints a WebGL canvas.

export const ASSET_IDS = ["stevie", "lantern-post", "shrub", "ground", "house-wall"] as const;
export type AssetId = (typeof ASSET_IDS)[number];

/** One asset's maps, each RGBA8 row-major from the top-left, `width × height` texels. */
export interface MaterialSet {
  readonly assetId: AssetId;
  readonly width: number;
  readonly height: number;
  /** sRGB colour; alpha is the silhouette (0 outside the sprite). */
  readonly albedo: Uint8ClampedArray;
  /** Tangent-space normal, RGB = (n·0.5 + 0.5)·255, derived from the height map; +y is up the image. */
  readonly normal: Uint8ClampedArray;
  /** Height in R, G and B (0 low, 255 high). */
  readonly heightMap: Uint8ClampedArray;
  /** Emitted light in sRGB colour (black where nothing glows). */
  readonly emissive: Uint8ClampedArray;
  /** R = roughness (255 rough), G = how much the surface darkens and shines when wet (255 fully). */
  readonly roughnessWetness: Uint8ClampedArray;
  /** R = sway weight for wind (0 rigid, 255 free), G = per-texel phase. */
  readonly wind: Uint8ClampedArray;
}
export const MAP_NAMES = [
  "albedo",
  "normal",
  "heightMap",
  "emissive",
  "roughnessWetness",
  "wind",
] as const;
export type MapName = (typeof MAP_NAMES)[number];

/** A deterministic hash of integer coordinates to 0..1. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_147_483_647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295;
}
/** Smooth value noise at a texel scale `cell`. */
function noise(x: number, y: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** A texel's look: colour, silhouette, height, glow, roughness, wetness, wind weight. */
interface Texel {
  r: number;
  g: number;
  b: number;
  a: number;
  h: number;
  er: number;
  eg: number;
  eb: number;
  rough: number;
  wet: number;
  wind: number;
}
type Painter = (u: number, v: number, x: number, y: number) => Texel;
const empty = (): Texel => ({
  r: 0,
  g: 0,
  b: 0,
  a: 0,
  h: 0,
  er: 0,
  eg: 0,
  eb: 0,
  rough: 1,
  wet: 0,
  wind: 0,
});
const inEllipse = (u: number, v: number, cu: number, cv: number, ru: number, rv: number) =>
  ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2;

/** u right, v down, both 0..1 across the sprite. */
const PAINTERS: Readonly<Record<AssetId, Painter>> = {
  stevie(u, v, x, y) {
    const t = empty();
    const fur = noise(x, y, 3, 11) * 30;
    const body = inEllipse(u, v, 0.48, 0.68, 0.3, 0.22);
    const head = inEllipse(u, v, 0.72, 0.42, 0.17, 0.15);
    const tail = inEllipse(u, v, 0.18, 0.62, 0.16, 0.1);
    const ear = Math.min(inEllipse(u, v, 0.66, 0.27, 0.05, 0.06), inEllipse(u, v, 0.8, 0.27, 0.05, 0.06));
    const legs =
      v > 0.82 && v < 0.96 && [0.32, 0.42, 0.58, 0.66].some((c) => Math.abs(u - c) < 0.035) ? 0 : 2;
    const inside = Math.min(body, head, tail, ear, legs);
    if (inside > 1) return t;
    t.a = 255;
    t.r = t.g = t.b = 118 + fur;
    t.b += 6;
    t.h = 255 * Math.sqrt(Math.max(0, 1 - Math.min(body, head, tail)));
    t.rough = 0.85;
    t.wet = 0.6;
    if (tail <= 1 && Math.floor(u * 22) % 2 === 0) t.r = t.g = t.b = 40 + fur;
    if (head <= 1 && v > 0.37 && v < 0.45 && u > 0.6) t.r = t.g = t.b = 28 + fur / 2;
    if (inEllipse(u, v, 0.77, 0.41, 0.022, 0.022) <= 1) {
      t.r = t.g = t.b = 230;
      t.rough = 0.15;
    }
    if (head <= 1 && v > 0.47) t.r = t.g = t.b = 205 + fur / 2;
    return t;
  },
  "lantern-post"(u, v, x, y) {
    const t = empty();
    const grain = noise(x, y, 2, 21) * 20;
    const post = Math.abs(u - 0.5) < 0.07 && v > 0.22;
    const base = v > 0.92 && Math.abs(u - 0.5) < 0.16;
    const cap = v > 0.04 && v < 0.08 && Math.abs(u - 0.5) < 0.24;
    const glass = v >= 0.08 && v < 0.2 && Math.abs(u - 0.5) < 0.18;
    const frame = glass && (Math.abs(u - 0.5) > 0.15 || Math.abs(u - 0.5) < 0.015);
    if (!(post || base || cap || glass)) return t;
    t.a = 255;
    t.r = 34 + grain;
    t.g = 36 + grain;
    t.b = 40 + grain;
    t.h = 255 * (1 - Math.abs(u - 0.5) / 0.24);
    t.rough = 0.35;
    t.wet = 0.9;
    if (glass && !frame) {
      t.r = 250;
      t.g = 214;
      t.b = 150;
      t.er = 255;
      t.eg = 170;
      t.eb = 80;
      t.rough = 0.1;
      t.h = 200;
    }
    return t;
  },
  shrub(u, v, x, y) {
    const t = empty();
    const leaves = noise(x, y, 5, 31);
    const blob = inEllipse(u, v, 0.5, 0.56, 0.46, 0.42) - leaves * 0.45;
    if (blob > 1) return t;
    t.a = 255;
    const shade = noise(x, y, 2, 32) * 50;
    t.r = 36 + shade * 0.4;
    t.g = 92 + shade;
    t.b = 46 + shade * 0.3;
    t.h = 255 * leaves;
    t.rough = 0.7;
    t.wet = 0.7;
    t.wind = Math.max(0, Math.min(1, 1.15 - v));
    return t;
  },
  ground(u, v, x, y) {
    const t = empty();
    t.a = 255;
    const path = Math.abs(u - v * 0.35 - 0.38) < 0.12;
    const stoneU = Math.floor(x / 14 + (Math.floor(y / 10) % 2) * 0.5);
    const stoneV = Math.floor(y / 10);
    const mortar = path && (x % 14 < 1.5 || y % 10 < 1.5);
    const grass = noise(x, y, 3, 41);
    if (path) {
      const tone = 90 + hash(stoneU, stoneV, 42) * 50;
      t.r = mortar ? 54 : tone;
      t.g = mortar ? 50 : tone - 6;
      t.b = mortar ? 46 : tone - 14;
      t.h = mortar ? 40 : 200 + noise(x, y, 4, 43) * 55;
      t.rough = mortar ? 0.95 : 0.55;
      t.wet = 1;
    } else {
      t.r = 52 + grass * 30;
      t.g = 84 + grass * 50;
      t.b = 42 + grass * 20;
      t.h = 90 + grass * 120;
      t.rough = 0.9;
      t.wet = 0.5;
    }
    return t;
  },
  "house-wall"(u, v, x, y) {
    const t = empty();
    t.a = 255;
    const plank = Math.floor(y / 9);
    const seam = y % 9 < 1;
    const wood = noise(x * 0.3, y * 3, 4, 50 + plank) * 25;
    t.r = seam ? 46 : 110 + wood;
    t.g = seam ? 36 : 82 + wood * 0.8;
    t.b = seam ? 30 : 60 + wood * 0.6;
    t.h = seam ? 30 : 180 + wood;
    t.rough = 0.8;
    t.wet = 0.4;
    const inWindow = Math.abs(u - 0.45) < 0.11 && v > 0.32 && v < 0.62;
    const frame = Math.abs(u - 0.45) > 0.095 || Math.abs(u - 0.45) < 0.008 || Math.abs(v - 0.47) < 0.008;
    if (inWindow) {
      if (frame || v < 0.335 || v > 0.615) {
        t.r = 200;
        t.g = 190;
        t.b = 170;
        t.h = 255;
      } else {
        t.r = 240;
        t.g = 200;
        t.b = 130;
        t.er = 255;
        t.eg = 190;
        t.eb = 110;
        t.rough = 0.05;
        t.h = 120;
      }
    }
    return t;
  },
};
const DIMENSIONS: Readonly<Record<AssetId, readonly [number, number]>> = {
  stevie: [128, 128],
  "lantern-post": [64, 256],
  shrub: [128, 128],
  ground: [256, 256],
  "house-wall": [256, 96],
};

const cache = new Map<AssetId, MaterialSet>();
/** The maps of one asset; the same bytes on every call and in every candidate. */
export function materialSet(assetId: AssetId): MaterialSet {
  const cached = cache.get(assetId);
  if (cached) return cached;
  const [width, height] = DIMENSIONS[assetId];
  const size = width * height * 4;
  const maps = Object.fromEntries(MAP_NAMES.map((name) => [name, new Uint8ClampedArray(size)])) as Record<
    MapName,
    Uint8ClampedArray
  >;
  const heights = new Float32Array(width * height);
  const paint = PAINTERS[assetId];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const t = paint((x + 0.5) / width, (y + 0.5) / height, x, y);
      const i = (y * width + x) * 4;
      heights[y * width + x] = t.h / 255;
      maps.albedo.set([clamp(t.r), clamp(t.g), clamp(t.b), clamp(t.a)], i);
      maps.heightMap.set([clamp(t.h), clamp(t.h), clamp(t.h), 255], i);
      maps.emissive.set([clamp(t.er), clamp(t.eg), clamp(t.eb), 255], i);
      maps.roughnessWetness.set([clamp(t.rough * 255), clamp(t.wet * 255), 0, 255], i);
      maps.wind.set([clamp(t.wind * 255), clamp(hash(x >> 3, y >> 3, 61) * 255), 0, 255], i);
    }
  // Normals from the height map's central differences; strength 2 keeps the relief visible under light.
  const at = (x: number, y: number) =>
    heights[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))] ?? 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2;
      const dy = (at(x, y - 1) - at(x, y + 1)) * 2;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * width + x) * 4;
      maps.normal.set(
        [
          clamp((-dx / length) * 127.5 + 127.5),
          clamp((-dy / length) * 127.5 + 127.5),
          clamp((1 / length) * 127.5 + 127.5),
          255,
        ],
        i,
      );
    }
  const set: MaterialSet = { assetId, width, height, ...maps };
  cache.set(assetId, set);
  return set;
}
