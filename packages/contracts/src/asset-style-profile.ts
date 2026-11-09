import {
  array,
  ContractDecodeError,
  exactKeys,
  integer,
  literal,
  literalVersion,
  record,
  string,
} from "./validation.js";

export const ASSET_STYLE_PROFILE_VERSION = 1;
/** WebGL's guaranteed minimum MAX_TEXTURE_SIZE, also the platform texture envelope. */
export const ASSET_STYLE_MAX_TEXTURE_EDGE = 2048;
/** Issue 813's atlas shelf width; a frame must fit on a shelf. */
export const ASSET_STYLE_MAX_FRAME_WIDTH = 1024;
export const ASSET_STYLE_ROLES = ["actor", "object", "terrain", "effect"] as const;
export type AssetStyleRole = (typeof ASSET_STYLE_ROLES)[number];

export interface AssetStyleProfile {
  readonly styleProfileVersion: 1;
  readonly alpha:
    | { readonly mode: "binary" }
    | { readonly mode: "soft"; readonly boundsThreshold: number };
  readonly colour:
    | { readonly mode: "unrestricted" }
    | {
        readonly mode: "palette";
        readonly colours: readonly string[];
        readonly strictness: "subset" | "exact";
      };
  readonly edge: "unrestricted" | "transparent-pixel" | "transparent-border";
  readonly sizes: Readonly<
    Record<AssetStyleRole, { readonly maxWidth: number; readonly maxHeight: number }>
  >;
}

function bounded(value: unknown, max: number, path: string): number {
  const result = integer(value, path);
  if (result < 1 || result > max)
    throw new ContractDecodeError(path, `expected an integer in 1..${max}`);
  return result;
}

/** Decodes presentation data independently of the simulation pack and its content hash. */
export function decodeAssetStyleProfile(value: unknown, path = "style"): AssetStyleProfile {
  const v = record(value, path);
  exactKeys(v, ["styleProfileVersion", "alpha", "colour", "edge", "sizes"], [], path);
  literalVersion(v.styleProfileVersion, ASSET_STYLE_PROFILE_VERSION, `${path}.styleProfileVersion`);
  const a = record(v.alpha, `${path}.alpha`);
  const alphaMode = literal(a.mode, ["binary", "soft"], `${path}.alpha.mode`);
  exactKeys(
    a,
    alphaMode === "binary" ? ["mode"] : ["mode", "boundsThreshold"],
    [],
    `${path}.alpha`,
  );
  const alpha: AssetStyleProfile["alpha"] = Object.freeze(
    alphaMode === "binary"
      ? { mode: "binary" }
      : {
          mode: "soft",
          boundsThreshold: bounded(a.boundsThreshold, 255, `${path}.alpha.boundsThreshold`),
        },
  );
  const c = record(v.colour, `${path}.colour`);
  const colourMode = literal(c.mode, ["unrestricted", "palette"], `${path}.colour.mode`);
  exactKeys(
    c,
    colourMode === "unrestricted" ? ["mode"] : ["mode", "colours", "strictness"],
    [],
    `${path}.colour`,
  );
  let colour: AssetStyleProfile["colour"];
  if (colourMode === "unrestricted") colour = Object.freeze({ mode: "unrestricted" });
  else {
    const colours = array(c.colours, `${path}.colour.colours`, (value, p) => {
      const result = string(value, p);
      if (!/^#[0-9a-f]{6}$/u.test(result))
        throw new ContractDecodeError(p, "expected a #rrggbb colour");
      return result;
    });
    if (colours.length === 0 || colours.some((c, i) => i > 0 && (colours[i - 1] as string) >= c))
      throw new ContractDecodeError(
        `${path}.colour.colours`,
        "expected non-empty sorted, unique colours",
      );
    colour = Object.freeze({
      mode: "palette",
      colours,
      strictness: literal(c.strictness, ["subset", "exact"], `${path}.colour.strictness`),
    });
  }
  const s = record(v.sizes, `${path}.sizes`);
  exactKeys(s, ASSET_STYLE_ROLES, [], `${path}.sizes`);
  const size = (role: AssetStyleRole) => {
    const p = `${path}.sizes.${role}`;
    const r = record(s[role], p);
    exactKeys(r, ["maxWidth", "maxHeight"], [], p);
    return Object.freeze({
      maxWidth: bounded(r.maxWidth, ASSET_STYLE_MAX_FRAME_WIDTH, `${p}.maxWidth`),
      maxHeight: bounded(r.maxHeight, ASSET_STYLE_MAX_TEXTURE_EDGE, `${p}.maxHeight`),
    });
  };
  return Object.freeze({
    styleProfileVersion: 1,
    alpha,
    colour,
    edge: literal(
      v.edge,
      ["unrestricted", "transparent-pixel", "transparent-border"],
      `${path}.edge`,
    ),
    sizes: Object.freeze({
      actor: size("actor"),
      object: size("object"),
      terrain: size("terrain"),
      effect: size("effect"),
    }),
  });
}
