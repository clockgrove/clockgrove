import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literalVersion,
  record,
  string,
} from "./validation.js";

export const ASSET_MATERIAL_VERSION = 1;
export const MATERIAL_CHANNELS = [
  "albedo",
  "normal",
  "height",
  "emissive",
  "roughness",
  "wetness",
  "wind",
  "flow",
  "ao",
  "translucency",
] as const;
export type MaterialChannel = (typeof MATERIAL_CHANNELS)[number];
export type MaterialChannels<T> = Readonly<
  { albedo: T } & Partial<Record<Exclude<MaterialChannel, "albedo">, T>>
>;
export interface MaterialSource {
  readonly path: string;
  readonly sha256: string;
}
export interface MaterialRendition {
  readonly density: 1 | 2 | 4;
  readonly channels: MaterialChannels<MaterialSource>;
}
/** Every channel uses the owning asset's frame grid, scaled by density. */
export interface AssetMaterial {
  readonly materialVersion: 1;
  readonly renditions: readonly MaterialRendition[];
}

export function decodeMaterialChannels<T>(
  value: unknown,
  path: string,
  decode: (value: unknown, path: string) => T,
): MaterialChannels<T> {
  const v = record(value, path);
  exactKeys(v, ["albedo"], MATERIAL_CHANNELS.slice(1), path);
  return Object.freeze(
    Object.fromEntries(
      MATERIAL_CHANNELS.filter((channel) => channel in v).map((channel) => [
        channel,
        decode(v[channel], `${path}.${channel}`),
      ]),
    ),
  ) as MaterialChannels<T>;
}

function decodeSource(value: unknown, path: string): MaterialSource {
  const v = record(value, path);
  exactKeys(v, ["path", "sha256"], [], path);
  const sourcePath = string(v.path, `${path}.path`);
  const segments = sourcePath.split("/");
  if (
    !sourcePath.startsWith("assets/source/") ||
    !sourcePath.endsWith(".png") ||
    sourcePath.includes("\\") ||
    sourcePath.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new ContractDecodeError(
      `${path}.path`,
      "expected a world-relative PNG path under assets/source without traversal",
    );
  const sha256 = string(v.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/u.test(sha256))
    throw new ContractDecodeError(`${path}.sha256`, "expected a lowercase SHA-256");
  return Object.freeze({ path: sourcePath, sha256 });
}

export function decodeAssetMaterial(value: unknown, path = "material"): AssetMaterial {
  const v = record(value, path);
  exactKeys(v, ["materialVersion", "renditions"], [], path);
  literalVersion(v.materialVersion, ASSET_MATERIAL_VERSION, `${path}.materialVersion`);
  const renditions = array(v.renditions, `${path}.renditions`, (value, p): MaterialRendition => {
    const r = record(value, p);
    exactKeys(r, ["density", "channels"], [], p);
    const density = integer(r.density, `${p}.density`);
    if (density !== 1 && density !== 2 && density !== 4)
      throw new ContractDecodeError(`${p}.density`, "expected density 1, 2 or 4");
    return Object.freeze({
      density,
      channels: decodeMaterialChannels(r.channels, `${p}.channels`, decodeSource),
    });
  });
  if (
    renditions[0]?.density !== 1 ||
    renditions.some(
      (r, i) => i > 0 && (renditions[i - 1] as MaterialRendition).density >= r.density,
    )
  )
    throw new ContractDecodeError(
      `${path}.renditions`,
      "expected sorted, unique densities starting with 1",
    );
  const channels = Object.keys((renditions[0] as MaterialRendition).channels).join(",");
  if (renditions.some((r) => Object.keys(r.channels).join(",") !== channels))
    throw new ContractDecodeError(
      `${path}.renditions`,
      "expected the same channels at every density",
    );
  return Object.freeze({ materialVersion: 1, renditions });
}
