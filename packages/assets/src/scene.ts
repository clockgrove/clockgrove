import type { AssetManifest, PackPresentation } from "@clockgrove/contracts";
import { type AssetEntry, assetKey } from "./atlas.js";
import { decodePng, encodePng, type RgbaImage } from "./png.js";

export interface SceneCamera {
  readonly originXMm: number;
  readonly originYMm: number;
  readonly mmPerPixel: number;
  readonly width: number;
  readonly height: number;
}
export interface SceneInput {
  readonly presentation: PackPresentation;
  readonly entries: readonly AssetEntry[];
  readonly placements: ReadonlyMap<string, readonly [number, number]>;
  readonly paths: readonly (readonly [readonly [number, number], readonly [number, number]])[];
  readonly camera: SceneCamera;
  readonly simulationTimeMs: number;
  /** 0..10000 */
  readonly rainIntensity: number;
  readonly selectedObjectId: string | null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GRASS = [88, 140, 72] as const;

interface Sprite {
  readonly manifest: AssetManifest;
  readonly image: RgbaImage;
}

function blit(target: RgbaImage, sprite: Sprite, destX: number, destY: number): void {
  const { width: w, height: h } = sprite.manifest.frames;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const tx = destX + x;
      const ty = destY + y;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const s = (y * sprite.image.width + x) * 4;
      if (sprite.image.rgba[s + 3] === 0) continue;
      target.rgba.set(sprite.image.rgba.subarray(s, s + 4), (ty * target.width + tx) * 4);
    }
}

/** Renders frame 0 of every bound asset in a fixed order, integer arithmetic only. */
export function renderScene(input: SceneInput): Uint8Array {
  const { camera, presentation } = input;
  const sprites = new Map<string, Sprite>();
  for (const { manifest, bytes } of input.entries)
    sprites.set(assetKey(manifest), { manifest, image: decodePng(bytes) });
  const sprite = (assetId: string, family: string): Sprite => {
    const found = sprites.get(`${assetId}/${family}`);
    if (found === undefined) throw new Error(`missing asset manifest ${assetId}/${family}`);
    return found;
  };
  const effects = (role: string) => presentation.effects.filter((e) => e.role === role);
  const project = ([xMm, yMm]: readonly [number, number]): [number, number] => [
    Math.floor((xMm - camera.originXMm) / camera.mmPerPixel),
    camera.height - Math.floor((yMm - camera.originYMm) / camera.mmPerPixel),
  ];
  const stamp = (s: Sprite, [x, y]: readonly [number, number]): void =>
    blit(image, s, x - s.manifest.anchor.x, y - s.manifest.anchor.y);

  const night = (() => {
    const t = ((input.simulationTimeMs % DAY_MS) + DAY_MS) % DAY_MS;
    return t < 6 * HOUR_MS || t >= 18 * HOUR_MS;
  })();
  const image: RgbaImage = {
    width: camera.width,
    height: camera.height,
    rgba: new Uint8Array(camera.width * camera.height * 4),
  };
  const [r, g, b] = GRASS.map((c) => (night ? Math.floor((c * 2) / 5) : c));
  for (let i = 0; i < image.rgba.length; i += 4)
    image.rgba.set([r as number, g as number, b as number, 255], i);

  for (const effect of effects("path")) {
    const s = sprite(effect.assetId, effect.animationFamily);
    for (const [from, to] of input.paths) {
      const [x0, y0] = project(from);
      const [x1, y1] = project(to);
      const length = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      const step = s.manifest.frames.width;
      for (let t = 0; t <= length; t += step)
        stamp(
          s,
          length === 0
            ? [x0, y0]
            : [
                x0 + Math.floor(((x1 - x0) * t) / length),
                y0 + Math.floor(((y1 - y0) * t) / length),
              ],
        );
    }
  }
  if (input.rainIntensity > 0)
    for (const effect of effects("puddle")) {
      const s = sprite(effect.assetId, effect.animationFamily);
      for (const [from, to] of input.paths)
        stamp(s, project([Math.floor((from[0] + to[0]) / 2), Math.floor((from[1] + to[1]) / 2)]));
    }

  const objects = presentation.bindings
    .flatMap((binding) => {
      const at = input.placements.get(binding.objectId);
      return at === undefined ? [] : [{ binding, screen: project(at) }];
    })
    .sort(
      (a, b) =>
        a.screen[1] - b.screen[1] ||
        (a.binding.objectId < b.binding.objectId
          ? -1
          : a.binding.objectId > b.binding.objectId
            ? 1
            : 0),
    );
  for (const { binding, screen } of objects) {
    if (binding.objectId === input.selectedObjectId)
      for (const effect of effects("selection"))
        stamp(sprite(effect.assetId, effect.animationFamily), screen);
    stamp(sprite(binding.assetId, binding.animationFamily), screen);
  }

  if (night)
    for (const effect of [...effects("lantern"), ...effects("window")]) {
      const at = effect.objectId === null ? undefined : input.placements.get(effect.objectId);
      if (at !== undefined) stamp(sprite(effect.assetId, effect.animationFamily), project(at));
    }

  if (input.rainIntensity > 0)
    for (const effect of effects("rain")) {
      const s = sprite(effect.assetId, effect.animationFamily);
      for (let y = 0; y < camera.height; y += s.manifest.frames.height)
        for (let x = 0; x < camera.width; x += s.manifest.frames.width) blit(image, s, x, y);
    }
  return encodePng(image);
}
