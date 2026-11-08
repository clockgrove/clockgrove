// Procedural pixel-art generator for the first Raccoon World asset set. Deterministic: integer
// arithmetic only, no clock and no randomness. Writes sources, manifests and the shared atlas layout.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetManifest } from "@clockgrove/contracts";
import { packAtlas } from "../src/atlas.js";
import { encodePng } from "../src/png.js";
import { hexColour, sha256Hex } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOOL = "packages/assets/scripts/generate-raccoon-world.ts";
const ATLAS_ID = "raccoon-world";

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];

class Canvas {
  readonly rgba: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
  }
  get(x: number, y: number): Rgb | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const i = (y * this.width + x) * 4;
    return this.rgba[i + 3] === 0
      ? null
      : [this.rgba[i] as number, this.rgba[i + 1] as number, this.rgba[i + 2] as number];
  }
  setPixel(x: number, y: number, colour: string | null): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    if (colour === null) this.rgba.fill(0, i, i + 4);
    else this.rgba.set([...hex(colour), 255], i);
  }
  fillRect(x: number, y: number, w: number, h: number, colour: string | null): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.setPixel(x + i, y + j, colour);
  }
  /** Ellipse centred on the pixel (cx, cy) with integer radii. */
  fillEllipse(cx: number, cy: number, rx: number, ry: number, colour: string | null): void {
    for (let y = -ry; y <= ry; y++)
      for (let x = -rx; x <= rx; x++)
        if (x * x * ry * ry + y * y * rx * rx <= rx * rx * ry * ry + Math.floor((rx * ry) / 2))
          this.setPixel(cx + x, cy + y, colour);
  }
  mirror(): Canvas {
    const out = new Canvas(this.width, this.height);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        out.rgba.set(
          this.rgba.subarray((y * this.width + x) * 4, (y * this.width + x) * 4 + 4),
          (y * this.width + (this.width - 1 - x)) * 4,
        );
    return out;
  }
  /** Copies the opaque pixels of `from` at (x, y). */
  blit(from: Canvas, x: number, y: number): void {
    for (let j = 0; j < from.height; j++)
      for (let i = 0; i < from.width; i++) {
        const c = from.get(i, j);
        if (c !== null) this.setPixel(x + i, y + j, hexColour(...c));
      }
  }
  /** One-pixel outline around the opaque shape. */
  outline(colour: string): void {
    const edge: [number, number][] = [];
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        if (
          this.get(x, y) === null &&
          [this.get(x - 1, y), this.get(x + 1, y), this.get(x, y - 1), this.get(x, y + 1)].some(
            (n) => n !== null,
          )
        )
          edge.push([x, y]);
    for (const [x, y] of edge) this.setPixel(x, y, colour);
  }
}

/** Integer hash for speckle patterns. */
const hash = (a: number, b: number): number => {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

const INK = "#2a2630";

const raccoonPalettes = {
  stevie: {
    fur: "#8d939e",
    dark: "#5f6470",
    light: "#c4c9d2",
    mask: "#26242c",
    ringDark: "#3b3943",
    belly: "#d9dce2",
    nose: "#1b1a20",
    pink: "#e8a0a8",
  },
  gracie: {
    fur: "#a08a78",
    dark: "#6e5a4c",
    light: "#d2bfae",
    mask: "#2d2623",
    ringDark: "#463830",
    belly: "#e6d8ca",
    nose: "#1f1a18",
    pink: "#eaa39b",
  },
  juniper: {
    fur: "#b9c0cb",
    dark: "#8089a0",
    light: "#e6e9ee",
    mask: "#343743",
    ringDark: "#5a5e70",
    belly: "#f3f4f7",
    nose: "#22232b",
    pink: "#efb0b8",
  },
} as const;
type RaccoonPalette = (typeof raccoonPalettes)[keyof typeof raccoonPalettes];

interface Build {
  rx: number;
  ry: number;
  leg: number;
  hr: number;
  tail: number;
  tailR: number;
  cx: number;
}
const builds = {
  stevie: { rx: 7, ry: 5, leg: 5, hr: 4, tail: 7, tailR: 2, cx: 15 },
  mid: { rx: 6, ry: 5, leg: 5, hr: 4, tail: 7, tailR: 2, cx: 15 },
  kit: { rx: 5, ry: 3, leg: 3, hr: 3, tail: 5, tailR: 1, cx: 13 },
} satisfies Record<string, Build>;

interface Pose {
  bob: number;
  /** How far the head is lowered toward the ground, in quarters of the full drop. */
  down: number;
  nose: number;
  tailSway: number;
  /** Per-leg [dx, lift] for near-front, near-back, far-front, far-back. */
  legs: [number, number][];
  airborne: boolean;
  morsel: number;
}
const standing = (over: Partial<Pose> = {}): Pose => ({
  bob: 0,
  down: 0,
  nose: 0,
  tailSway: 0,
  legs: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  airborne: false,
  morsel: 0,
  ...over,
});

const GROUND = 30;

function tail(c: Canvas, p: RaccoonPalette, b: Build, baseX: number, baseY: number, sway: number) {
  const at = (i: number): [number, number] => [
    baseX - i,
    baseY - Math.floor((i * i) / (b.tail * 2)) - Math.floor((i * sway) / 3),
  ];
  for (let i = b.tail; i >= 0; i--) c.fillEllipse(...at(i), b.tailR + 1, b.tailR + 1, INK);
  for (let i = b.tail; i >= 0; i--) {
    const ring = Math.floor((b.tail - i) / 2) % 2 === 0;
    c.fillEllipse(...at(i), b.tailR, b.tailR, i === b.tail || !ring ? p.ringDark : p.fur);
  }
}

function head(c: Canvas, p: RaccoonPalette, b: Build, hx: number, hy: number, nose: number): void {
  const r = b.hr;
  for (const ex of [hx - 3, hx + 1]) {
    c.fillRect(ex, hy - r - 2, 3, 3, INK);
    c.fillRect(ex + 1, hy - r - 1, 1, 2, p.dark);
  }
  c.fillEllipse(hx, hy, r + 2, r + 1, INK);
  c.fillEllipse(hx + r, hy + 1, 3, Math.max(1, r - 1), INK);
  c.fillEllipse(hx, hy, r + 1, r, p.fur);
  c.fillRect(hx - 1, hy - r, 4, 1, p.light);
  c.fillEllipse(hx + r, hy + 1, 2, Math.max(1, r - 2), p.light);
  c.fillRect(hx - 2, hy - 1, r + 3, 2, p.mask);
  c.setPixel(hx + 2, hy - 1, "#ffffff");
  c.setPixel(hx + r + 2, hy + nose, p.nose);
  c.setPixel(hx + r + 1, hy + nose, p.nose);
}

function raccoon(p: RaccoonPalette, b: Build, pose: Pose): Canvas {
  const c = new Canvas(32, 32);
  const bodyY = GROUND - b.leg - b.ry + 1 + pose.bob;
  const frontX = b.cx + b.rx - 3;
  const backX = b.cx - b.rx + 2;
  const leg = (x: number, [dx, lift]: [number, number], colour: string): void => {
    const top = bodyY + b.ry - 2;
    const bottom = pose.airborne ? bodyY + b.ry + 1 : GROUND - lift;
    c.fillRect(x + dx, top, 2, bottom - top + 1, colour);
    c.fillRect(x + dx, bottom, 3, 1, p.mask);
  };
  tail(c, p, b, b.cx - b.rx + 1, bodyY - 1, pose.tailSway);
  leg(frontX + 2, pose.legs[2] as [number, number], p.dark);
  leg(backX - 1, pose.legs[3] as [number, number], p.dark);
  c.fillEllipse(b.cx, bodyY, b.rx, b.ry, p.fur);
  c.fillRect(b.cx - b.rx + 2, bodyY - b.ry, b.rx * 2 - 4, 1, p.light);
  c.fillEllipse(b.cx + 1, bodyY + b.ry - 1, b.rx - 3, 1, p.belly);
  leg(frontX, pose.legs[0] as [number, number], p.fur);
  leg(backX, pose.legs[1] as [number, number], p.fur);
  const raised = bodyY - b.ry + b.hr - 1;
  const drop = GROUND - 1 - b.hr - raised;
  const hx = b.cx + b.rx - 1 + (pose.down > 0 ? 1 : 0);
  const hy = raised + Math.floor((drop * pose.down) / 4);
  head(c, p, b, hx, hy, pose.nose);
  if (pose.morsel > 0) {
    const mx = hx + b.hr + 3;
    c.fillRect(mx, GROUND - pose.morsel + 1, pose.morsel + 1, pose.morsel, "#c9803a");
    c.setPixel(mx, GROUND - pose.morsel + 1, "#e8b26a");
  }
  c.outline(INK);
  return c;
}

function curled(p: RaccoonPalette, b: Build, breath: number): Canvas {
  const c = new Canvas(32, 32);
  const rx = b.rx + 3;
  const ry = b.ry + 2 + breath;
  const cx = b.cx + 1;
  const cy = GROUND - ry + 1;
  c.fillEllipse(cx, cy, rx, ry, p.fur);
  c.fillRect(cx - rx + 3, cy - ry, rx * 2 - 6, 1, p.light);
  c.fillEllipse(cx - 2, cy - 1, rx - 3, ry - 3, p.dark);
  c.fillEllipse(cx - 2, cy - 2, rx - 4, ry - 4, p.fur);
  const hx = cx + rx - 3;
  const hy = cy - 2;
  for (const ex of [hx - 3, hx + 1]) {
    c.fillRect(ex, hy - b.hr - 1, 3, 3, INK);
    c.fillRect(ex + 1, hy - b.hr, 1, 2, p.dark);
  }
  c.fillEllipse(hx, hy, b.hr, b.hr - 1, p.fur);
  c.fillRect(hx - 2, hy - 1, b.hr + 1, 2, p.mask);
  c.setPixel(hx + 1, hy - 1, "#ffffff");
  // the ringed tail wraps round the front, over the nose
  const wrap: [number, number][] = [
    [-rx, ry - 3],
    [-rx + 2, ry - 1],
    [-4, ry],
    [2, ry],
    [rx - 3, ry - 1],
    [rx, 1],
    [rx - 1, -2],
  ];
  const r = b.tailR;
  for (const [dx, dy] of wrap) c.fillEllipse(cx + dx, cy + dy - 1, r + 1, r + 1, INK);
  wrap.forEach(([dx, dy], i) => {
    c.fillEllipse(cx + dx, cy + dy - 1, r, r, i % 2 === 0 ? p.ringDark : p.fur);
  });
  c.outline(INK);
  return c;
}

function raccoonFrames(kind: "stevie" | "gracie" | "juniper" | "kit", family: string): Canvas[] {
  const p = raccoonPalettes[kind === "kit" ? "juniper" : kind];
  const b: Build = kind === "stevie" ? builds.stevie : kind === "kit" ? builds.kit : builds.mid;
  const swing = b.leg <= 3 ? 1 : 2;
  const at = (list: number[], i: number): number => list[i] as number;
  return [0, 1, 2, 3].map((i) => {
    switch (family) {
      case "idle":
        return raccoon(
          p,
          b,
          standing({ bob: at([0, 0, 1, 1], i), tailSway: at([-1, 0, 1, 0], i) }),
        );
      case "walk": {
        const s = at([swing, 0, -swing, 0], i);
        const up = at([0, 1, 0, 1], i);
        return raccoon(
          p,
          b,
          standing({
            bob: at([0, -1, 0, -1], i),
            tailSway: at([0, 1, 0, -1], i),
            legs: [
              [s, s < 0 ? 0 : up],
              [-s, s > 0 ? 0 : up],
              [-s, s > 0 ? 0 : up],
              [s, s < 0 ? 0 : up],
            ],
          }),
        );
      }
      case "sniff":
        return raccoon(
          p,
          b,
          standing({ down: 2, nose: at([0, -1, 0, -1], i), tailSway: at([0, 0, 1, 1], i) }),
        );
      case "eat":
        return raccoon(
          p,
          b,
          standing({
            down: at([4, 3, 4, 3], i),
            morsel: at([3, 3, 2, 1], i),
            tailSway: at([0, 1, 0, -1], i),
          }),
        );
      case "play": {
        const air = at([0, 4, 6, 2], i);
        return raccoon(
          p,
          b,
          standing({ bob: -air, airborne: air > 0, tailSway: at([-1, 1, -1, 1], i) }),
        );
      }
      case "shelter":
        return curled(p, b, at([0, 0, 1, 1], i));
      default:
        throw new Error(`unknown raccoon family ${family}`);
    }
  });
}

// ---------------------------------------------------------------- objects

function den(): Canvas {
  const c = new Canvas(64, 48);
  c.fillEllipse(32, 42, 30, 5, "#3f5f34");
  c.fillEllipse(32, 36, 28, 18, "#6b4a30");
  c.fillEllipse(32, 32, 24, 13, "#7f5a3a");
  for (let i = 0; i < 40; i++) {
    const x = 10 + (hash(i, 1) % 44);
    const y = 24 + (hash(i, 2) % 18);
    if (c.get(x, y) !== null) c.setPixel(x, y, hash(i, 3) % 2 === 0 ? "#5a3d27" : "#946b45");
  }
  // log frame around the entrance
  c.fillRect(18, 22, 4, 22, "#8a5a2c");
  c.fillRect(42, 22, 4, 22, "#8a5a2c");
  c.fillRect(18, 20, 28, 4, "#9a6a36");
  c.fillRect(18, 20, 28, 1, "#b98448");
  c.fillEllipse(32, 40, 10, 14, "#1d1620");
  c.fillRect(22, 40, 20, 5, "#1d1620");
  c.fillEllipse(32, 42, 7, 9, "#2b2030");
  for (const x of [20, 44]) {
    c.fillEllipse(x, 44, 4, 3, "#b98448");
    c.fillEllipse(x, 44, 2, 1, "#8a5a2c");
    c.setPixel(x, 44, "#d4a468");
  }
  for (const [x, y] of [
    [14, 22],
    [26, 14],
    [38, 14],
    [50, 22],
    [32, 11],
  ] as const) {
    c.fillRect(x - 1, y, 1, 3, "#56803f");
    c.fillRect(x + 1, y + 1, 1, 2, "#6fa04d");
    c.fillRect(x, y - 1, 1, 4, "#6fa04d");
  }
  c.outline(INK);
  return c;
}

function trashCan(): Canvas {
  const c = new Canvas(24, 32);
  c.fillRect(5, 9, 14, 22, "#8c96a3");
  c.fillRect(5, 9, 3, 22, "#aeb7c2");
  c.fillRect(16, 9, 3, 22, "#6c7683");
  for (const y of [14, 20, 26]) c.fillRect(5, y, 14, 1, "#5e6874");
  c.fillRect(4, 29, 16, 2, "#5e6874");
  // lid, knocked slightly askew
  c.fillRect(3, 6, 16, 4, "#a4adb9");
  c.fillRect(3, 6, 16, 1, "#cdd4dc");
  c.fillRect(8, 3, 6, 3, "#6c7683");
  c.fillRect(9, 4, 4, 1, "#a4adb9");
  c.fillRect(17, 8, 4, 2, "#a4adb9");
  // a leaf of lettuce peeks out
  c.fillEllipse(19, 10, 2, 1, "#79b45a");
  c.setPixel(20, 10, "#a2d37e");
  c.outline(INK);
  return c;
}

function feeder(): Canvas {
  const c = new Canvas(24, 24);
  c.fillRect(5, 19, 3, 4, "#7a5230");
  c.fillRect(16, 19, 3, 4, "#7a5230");
  c.fillEllipse(12, 16, 10, 5, "#a56b3a");
  c.fillEllipse(12, 14, 10, 4, "#c58a4e");
  c.fillEllipse(12, 13, 8, 3, "#5b3a22");
  const kibble = ["#d9a05b", "#b9783a", "#e8c07a"];
  for (let i = 0; i < 16; i++) {
    const x = 6 + (hash(i, 7) % 12);
    const y = 8 + (hash(i, 8) % 5);
    if (c.get(x, y) !== null) c.setPixel(x, y, kibble[i % 3] as string);
  }
  c.fillEllipse(12, 10, 4, 2, "#d9a05b");
  c.fillRect(10, 9, 2, 1, "#e8c07a");
  c.fillRect(5, 16, 14, 1, "#8a5a2c");
  c.outline(INK);
  return c;
}

function mailbox(): Canvas {
  const c = new Canvas(16, 32);
  c.fillRect(7, 14, 3, 17, "#8a5a2c");
  c.fillRect(7, 14, 1, 17, "#a8763c");
  c.fillRect(5, 29, 7, 2, "#6b4a30");
  c.fillEllipse(8, 9, 6, 5, "#4a78b8");
  c.fillRect(2, 9, 13, 5, "#4a78b8");
  c.fillRect(2, 5, 12, 1, "#7aa3d8");
  c.fillRect(2, 13, 13, 1, "#355b8e");
  c.fillRect(13, 6, 1, 8, "#355b8e");
  c.fillRect(12, 1, 1, 7, "#d94f3d");
  c.fillRect(12, 1, 3, 2, "#d94f3d");
  c.fillRect(2, 8, 3, 3, "#1f2f4d");
  c.outline(INK);
  return c;
}

function tree(): Canvas {
  const half = new Canvas(64, 96);
  const tiers: [number, number, number][] = [
    [60, 30, 26],
    [46, 25, 28],
    [32, 20, 26],
    [18, 15, 24],
    [4, 10, 22],
  ];
  for (const [top, halfWidth, height] of tiers)
    for (let row = 0; row < height; row++) {
      const w = Math.floor(((row + 1) * halfWidth) / height) + (row >= height - 3 ? 1 : 0);
      const edge = row % 6 === 5 ? "#2a5634" : row >= height - 3 ? "#285230" : "#35693c";
      half.fillRect(32 - w, top + row, w, 1, edge);
      if (row % 6 === 2) half.fillRect(32 - w + 2, top + row, 3, 1, "#2a5634");
    }
  const c = new Canvas(64, 96);
  c.fillRect(29, 78, 6, 17, "#6b4a30");
  c.fillRect(32, 78, 3, 17, "#8a5e3a");
  c.fillRect(26, 92, 12, 3, "#6b4a30");
  c.blit(half, 0, 0);
  const right = half.mirror();
  for (let y = 0; y < 96; y++)
    for (let x = 32; x < 64; x++) {
      const colour = right.get(x, y);
      if (colour === null) continue;
      const lit = (x + y) % 7 < 2 && y % 6 < 3;
      c.setPixel(x, y, lit ? "#5fa05f" : hexColour(...colour));
    }
  c.outline(INK);
  return c;
}

function plant(): Canvas {
  const c = new Canvas(24, 24);
  c.fillEllipse(12, 21, 8, 2, "#4a3524");
  const leaves: [number, number, number, number, string][] = [
    [7, 15, 3, 6, "#4f8f3f"],
    [17, 15, 3, 6, "#4f8f3f"],
    [12, 12, 3, 8, "#69b04f"],
    [9, 17, 3, 4, "#7bc45a"],
    [15, 17, 3, 4, "#7bc45a"],
  ];
  for (const [x, y, rx, ry, colour] of leaves) {
    c.fillEllipse(x, y, rx, ry, colour);
    c.fillRect(x, y - ry + 1, 1, ry * 2 - 2, "#9bdc78");
  }
  for (const [x, y] of [
    [7, 8],
    [17, 9],
    [12, 4],
  ] as const) {
    c.fillRect(x - 1, y, 3, 1, "#b58ae0");
    c.fillRect(x, y - 1, 1, 3, "#b58ae0");
    c.setPixel(x, y, "#f4e27a");
  }
  c.outline(INK);
  return c;
}

function pathTile(): Canvas {
  const c = new Canvas(16, 16);
  const dirt = ["#a8814f", "#a0794a", "#b08a58"];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) c.setPixel(x, y, dirt[hash(x, y) % 3] as string);
  for (let i = 0; i < 10; i++) {
    const x = hash(i, 21) % 15;
    const y = hash(i, 22) % 15;
    c.fillRect(x, y, 2, 1, "#7d5c38");
    c.setPixel(x + 1, y + 1, "#c9a470");
  }
  return c;
}

// ---------------------------------------------------------------- effects

function rain(frame: number): Canvas {
  const c = new Canvas(32, 32);
  const drops: [number, number][] = [
    [3, 2],
    [13, 9],
    [23, 4],
    [8, 19],
    [19, 15],
    [28, 24],
    [2, 29],
    [15, 26],
  ];
  for (const [x, y0] of drops) {
    const y = (y0 + frame * 10) % 32;
    for (let k = 0; k < 4; k++)
      c.setPixel((x - Math.floor(k / 2) + 32) % 32, (y + k) % 32, k < 2 ? "#cfe9ff" : "#8fc4f0");
  }
  return c;
}

function puddle(frame: number): Canvas {
  const c = new Canvas(24, 12);
  c.fillEllipse(12, 6, 11, 5, "#3e6f9e");
  c.fillEllipse(12, 6, 9, 4, "#5d95c4");
  c.fillRect(6, 4, 4, 1, "#a9d3f2");
  if (frame === 0) {
    c.fillEllipse(13, 6, 3, 1, "#7fb3dc");
    c.fillEllipse(13, 6, 1, 0, "#a9d3f2");
  } else {
    c.fillEllipse(13, 6, 5, 2, "#7fb3dc");
    c.fillEllipse(13, 6, 3, 1, "#5d95c4");
  }
  return c;
}

function lantern(frame: number): Canvas {
  const c = new Canvas(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = (x - 8) * (x - 8) + (y - 8) * (y - 8);
      const reach = frame === 0 ? 49 : 56;
      if (d < reach && d > 12 && (x + y) % 2 === 0) c.setPixel(x, y, "#ffd27a");
    }
  c.fillRect(7, 1, 2, 2, "#3b3240");
  c.fillRect(5, 3, 6, 1, "#3b3240");
  c.fillRect(5, 4, 6, 8, "#3b3240");
  c.fillRect(6, 5, 4, 6, "#ffcf5a");
  c.fillRect(7, frame === 0 ? 6 : 5, 2, frame === 0 ? 4 : 5, "#fff3b0");
  c.fillRect(5, 12, 6, 1, "#3b3240");
  return c;
}

function windowLit(): Canvas {
  const c = new Canvas(16, 16);
  c.fillRect(1, 1, 14, 13, "#6b4a30");
  c.fillRect(3, 3, 10, 9, "#ffd66b");
  c.fillRect(3, 3, 10, 2, "#ffe9a0");
  c.fillRect(7, 3, 2, 9, "#6b4a30");
  c.fillRect(3, 7, 10, 1, "#6b4a30");
  c.fillRect(0, 14, 16, 2, "#8a5e3a");
  c.setPixel(10, 9, "#7a5230");
  for (const [x, y] of [
    [1, 1],
    [14, 1],
  ] as const)
    c.setPixel(x, y, null);
  c.setPixel(0, 0, null);
  c.setPixel(15, 0, null);
  return c;
}

function selection(frame: number): Canvas {
  const c = new Canvas(32, 12);
  c.fillEllipse(16, 6, 15, 5, "#ffd24a");
  c.fillEllipse(16, 6, 13, 3, null);
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 32; x++)
      if (c.get(x, y) !== null && (Math.floor(x / 3) + y + frame) % 2 === 0)
        c.setPixel(x, y, "#fff3b0");
  return c;
}

// ---------------------------------------------------------------- assembly

interface Spec {
  assetId: string;
  family: "idle" | "walk" | "sniff" | "eat" | "play" | "shelter" | "static" | "loop";
  role: "actor" | "object" | "terrain" | "effect";
  entity: string | null;
  archetype: string | null;
  width: number;
  height: number;
  frames: Canvas[];
  durationMs: number | null;
  anchor: { x: number; y: number };
  footprint: { width: number; depth: number };
  label: string;
  params: string;
}

const specs: Spec[] = [];
const verbs = {
  idle: "standing",
  walk: "walking",
  sniff: "sniffing",
  eat: "eating",
  play: "playing",
  shelter: "sheltering",
} as const;
const actors = [
  {
    id: "stevie",
    kind: "stevie",
    name: "Stevie",
    entity: "grove.stevie",
    archetype: "grove.raccoon-kind",
    footprint: { width: 700, depth: 400 },
    palette: "stevie",
  },
  {
    id: "gracie",
    kind: "gracie",
    name: "Gracie",
    entity: "grove.gracie",
    archetype: "grove.raccoon-kind",
    footprint: { width: 650, depth: 380 },
    palette: "gracie",
  },
  {
    id: "juniper",
    kind: "juniper",
    name: "Juniper",
    entity: null,
    archetype: "grove.raccoon-kind",
    footprint: { width: 650, depth: 380 },
    palette: "juniper",
  },
  {
    id: "kit",
    kind: "kit",
    name: "The kit",
    entity: "grove.kit",
    archetype: "grove.kit-kind",
    footprint: { width: 400, depth: 250 },
    palette: "juniper",
  },
] as const;
for (const a of actors)
  for (const family of ["idle", "walk", "sniff", "eat", "play", "shelter"] as const)
    specs.push({
      assetId: a.id,
      family,
      role: "actor",
      entity: a.entity,
      archetype: a.archetype,
      width: 32,
      height: 32,
      frames: raccoonFrames(a.kind, family),
      durationMs: family === "walk" || family === "play" ? 150 : 250,
      anchor: { x: 16, y: GROUND },
      footprint: a.footprint,
      label: `${a.name} ${verbs[family]}`,
      params: `procedural raccoon; palette ${a.palette}; family ${family}; 4 frames`,
    });

const still = (
  assetId: string,
  role: Spec["role"],
  canvas: Canvas,
  entity: string | null,
  archetype: string | null,
  anchor: { x: number; y: number },
  footprint: { width: number; depth: number },
  label: string,
): void => {
  specs.push({
    assetId,
    family: "static",
    role,
    entity,
    archetype,
    width: canvas.width,
    height: canvas.height,
    frames: [canvas],
    durationMs: null,
    anchor,
    footprint,
    label,
    params: `procedural ${assetId}; fixed palette; family static; 1 frame`,
  });
};
still(
  "den",
  "object",
  den(),
  "grove.den",
  "grove.den-kind",
  { x: 32, y: 46 },
  { width: 3000, depth: 2200 },
  "The den",
);
still(
  "trash-can",
  "object",
  trashCan(),
  "grove.trash-can",
  "grove.food-source-kind",
  { x: 12, y: 30 },
  { width: 500, depth: 500 },
  "The trash can",
);
still(
  "feeder",
  "object",
  feeder(),
  "grove.snack-dish",
  "grove.food-source-kind",
  { x: 12, y: 22 },
  { width: 450, depth: 450 },
  "The snack feeder",
);
still(
  "mailbox",
  "object",
  mailbox(),
  null,
  null,
  { x: 8, y: 30 },
  { width: 300, depth: 300 },
  "A mailbox",
);
still(
  "tree",
  "object",
  tree(),
  "grove.cedar",
  "grove.cedar-kind",
  { x: 32, y: 94 },
  { width: 2000, depth: 2000 },
  "The cedar tree",
);
still(
  "plant",
  "object",
  plant(),
  "grove.herb",
  "grove.herb-kind",
  { x: 12, y: 22 },
  { width: 500, depth: 500 },
  "The herb patch",
);
still(
  "path",
  "terrain",
  pathTile(),
  null,
  null,
  { x: 8, y: 8 },
  { width: 800, depth: 800 },
  "A dirt path",
);
still(
  "window",
  "effect",
  windowLit(),
  "grove.porch",
  "grove.porch-kind",
  { x: 8, y: 15 },
  { width: 400, depth: 400 },
  "A lit porch window",
);

const loop = (
  assetId: string,
  frames: Canvas[],
  durationMs: number,
  entity: string | null,
  archetype: string | null,
  anchor: { x: number; y: number },
  footprint: { width: number; depth: number },
  label: string,
): void => {
  const first = frames[0] as Canvas;
  specs.push({
    assetId,
    family: "loop",
    role: "effect",
    entity,
    archetype,
    width: first.width,
    height: first.height,
    frames,
    durationMs,
    anchor,
    footprint,
    label,
    params: `procedural ${assetId}; fixed palette; family loop; ${frames.length} frames`,
  });
};
loop(
  "rain",
  [0, 1, 2].map(rain),
  100,
  null,
  null,
  { x: 16, y: 31 },
  { width: 2000, depth: 2000 },
  "Falling rain",
);
loop(
  "puddle",
  [0, 1].map(puddle),
  400,
  null,
  null,
  { x: 12, y: 6 },
  { width: 1200, depth: 600 },
  "A puddle",
);
loop(
  "lantern",
  [0, 1].map(lantern),
  300,
  "grove.porch",
  "grove.porch-kind",
  { x: 8, y: 15 },
  { width: 300, depth: 300 },
  "The porch lantern",
);
loop(
  "selection",
  [0, 1].map(selection),
  400,
  null,
  null,
  { x: 16, y: 6 },
  { width: 900, depth: 400 },
  "Selection ring",
);

const strip = (spec: Spec): Uint8Array => {
  const canvas = new Canvas(spec.width * spec.frames.length, spec.height);
  spec.frames.forEach((frame, i) => {
    if (frame.width !== spec.width || frame.height !== spec.height)
      throw new Error(`${spec.assetId}/${spec.family}: frame size differs`);
    canvas.blit(frame, i * spec.width, 0);
  });
  return encodePng({ width: canvas.width, height: canvas.height, rgba: canvas.rgba });
};

function describe(spec: Spec, bytes: Uint8Array): Omit<AssetManifest, "atlas"> {
  const palette = new Set<string>();
  let minX = spec.width;
  let minY = spec.height;
  let maxX = -1;
  let maxY = -1;
  for (const frame of spec.frames)
    for (let y = 0; y < spec.height; y++)
      for (let x = 0; x < spec.width; x++) {
        const colour = frame.get(x, y);
        if (colour === null) continue;
        palette.add(hexColour(...colour));
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
  return {
    assetManifestVersion: 1,
    assetId: spec.assetId,
    animationFamily: spec.family,
    source: {
      kind: "generated",
      path: `assets/source/${spec.assetId}/${spec.family}.png`,
      creator: "Clockgrove",
      tool: TOOL,
    },
    license: "MIT",
    provenance: { prompt: spec.params, references: [] },
    review: { status: "pending", reviewer: null, reviewedAt: null, notes: "" },
    semantic: { role: spec.role, entity: spec.entity, archetype: spec.archetype },
    frames: {
      width: spec.width,
      height: spec.height,
      count: spec.frames.length,
      durationMs: spec.durationMs,
    },
    anchor: spec.anchor,
    footprint: spec.footprint,
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    palette: [...palette].sort(),
    contentHash: sha256Hex(bytes),
    accessibilityLabel: spec.label,
  };
}

const described = specs.map((spec) => {
  const bytes = strip(spec);
  return { spec, bytes, manifest: describe(spec, bytes) };
});
const placements = packAtlas(
  described.map((d) => ({ ...d.manifest, atlas: { atlasId: ATLAS_ID, x: 0, y: 0 } })),
);

rmSync(join(root, "assets/source"), { recursive: true, force: true });
rmSync(join(root, "assets/manifests"), { recursive: true, force: true });
for (const { spec, bytes, manifest } of described) {
  const place = placements.get(`${spec.assetId}/${spec.family}`);
  if (place === undefined) throw new Error("missing placement");
  const full: AssetManifest = { ...manifest, atlas: { atlasId: ATLAS_ID, x: place.x, y: place.y } };
  const sourcePath = join(root, full.source.path);
  const manifestPath = join(root, `assets/manifests/${spec.assetId}/${spec.family}.json`);
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(sourcePath, bytes);
  writeFileSync(manifestPath, `${JSON.stringify(full, null, 2)}\n`);
}
