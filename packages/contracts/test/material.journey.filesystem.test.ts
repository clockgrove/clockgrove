import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeAssetMaterial, decodeAssetStyleProfile } from "../src/index.js";

const hash = "a".repeat(64);
const source = (path: string) => ({ path: `assets/source/${path}.png`, sha256: hash });
const albedo = { encoding: "srgb", min: 0, max: 255, maxFrameChange: 255 };
const normal = { encoding: "linear", min: 0, max: 255, maxFrameChange: 12 };
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("../../../worlds/fixture/reference/asset-style.json", import.meta.url),
      "utf8",
    ),
  );

it("reads authored actor-strip and static-prop material declarations with matching channel renditions", () => {
  const root = mkdtempSync(join(tmpdir(), "material-"));
  try {
    const actor = {
      materialVersion: 1,
      renditions: [1, 2].map((density) => ({
        density,
        channels: {
          albedo: source(`actor/walk-${density}`),
          normal: source(`actor/walk-normal-${density}`),
          height: source(`actor/walk-height-${density}`),
          emissive: source(`actor/walk-emissive-${density}`),
          roughness: source(`actor/walk-roughness-${density}`),
          wetness: source(`actor/walk-wetness-${density}`),
          wind: source(`actor/walk-wind-${density}`),
          flow: source(`actor/walk-flow-${density}`),
          ao: source(`actor/walk-ao-${density}`),
          translucency: source(`actor/walk-translucency-${density}`),
        },
      })),
    };
    const prop = {
      materialVersion: 1,
      renditions: [1, 2, 4].map((density) => ({
        density,
        channels: { albedo: source(`prop/static-${density}`) },
      })),
    };
    for (const [name, value] of Object.entries({ actor, prop })) {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      const decoded = decodeAssetMaterial(JSON.parse(readFileSync(path, "utf8")));
      expect(decoded).toEqual(value);
      expect(Object.isFrozen(decoded.renditions[0]?.channels.albedo)).toBe(true);
      expect(Object.isFrozen(decoded.renditions)).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses malformed material declarations at the public decoder boundary", () => {
  const one = { density: 1, channels: { albedo: source("prop/static") } };
  const base = { materialVersion: 1, renditions: [one] };
  const bad: [unknown, string][] = [
    [{ ...base, materialVersion: 2 }, "material.materialVersion: unsupported version; expected 1"],
    [{ ...base, extra: true }, "material.extra: unknown field"],
    [
      { ...base, renditions: [] },
      "material.renditions: expected sorted, unique densities starting with 1 and 2",
    ],
    [
      { ...base, renditions: [one, one] },
      "material.renditions: expected sorted, unique densities starting with 1 and 2",
    ],
    [
      { ...base, renditions: [{ ...one, density: 3 }] },
      "material.renditions[0].density: expected density 1, 2 or 4",
    ],
    [
      { ...base, renditions: [{ ...one, channels: {} }] },
      "material.renditions[0].channels.albedo: missing field",
    ],
    [
      {
        ...base,
        renditions: [{ ...one, channels: { ...one.channels, depth: source("prop/depth") } }],
      },
      "material.renditions[0].channels.depth: unknown field",
    ],
    [
      {
        ...base,
        renditions: [
          one,
          { density: 2, channels: { ...one.channels, normal: source("prop/normal") } },
        ],
      },
      "material.renditions: expected the same channels at every density",
    ],
  ];
  for (const [value, reason] of bad) expect(() => decodeAssetMaterial(value)).toThrow(reason);
  for (const path of [
    "../secret.png",
    "/assets/source/a.png",
    "assets/source/../a.png",
    "assets/source//a.png",
    "assets/source/./a.png",
    "assets/source/a\\b.png",
    "assets/source/a.ktx2",
  ]) {
    expect(() =>
      decodeAssetMaterial({
        ...base,
        renditions: [{ density: 1, channels: { albedo: { path, sha256: hash } } }],
      }),
    ).toThrow(
      "material.renditions[0].channels.albedo.path: expected a world-relative PNG path under assets/source without traversal",
    );
  }
  expect(() =>
    decodeAssetMaterial({
      ...base,
      renditions: [
        { density: 1, channels: { albedo: { ...source("prop/static"), sha256: "A".repeat(64) } } },
      ],
    }),
  ).toThrow("material.renditions[0].channels.albedo.sha256: expected a lowercase SHA-256");
});

it("reads role-specific world material policies while preserving legacy fixture profiles", () => {
  const legacy = fixture();
  expect(decodeAssetStyleProfile(legacy)).toEqual(legacy);
  expect("material" in decodeAssetStyleProfile(legacy)).toBe(false);
  const roles = {
    actor: { albedo, normal },
    object: { albedo },
    terrain: { albedo },
    effect: { albedo },
  };
  const profile = { ...legacy, material: { materialVersion: 1, roles } };
  const root = mkdtempSync(join(tmpdir(), "material-style-"));
  try {
    const path = join(root, "asset-style.json");
    writeFileSync(path, JSON.stringify(profile));
    const decoded = decodeAssetStyleProfile(JSON.parse(readFileSync(path, "utf8")));
    expect(decoded).toEqual(profile);
    expect(decoded.material?.roles.actor.normal?.maxFrameChange).toBe(12);
    expect(Object.isFrozen(decoded.material?.roles.actor.normal)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const check = (policy: unknown) =>
    decodeAssetStyleProfile({
      ...profile,
      material: { materialVersion: 1, roles: { ...roles, actor: policy } },
    });
  expect(() => check({ normal })).toThrow("style.material.roles.actor.albedo: missing field");
  expect(() => check({ albedo, normal: { ...normal, min: 256 } })).toThrow(
    "style.material.roles.actor.normal.min: expected an integer in 0..255",
  );
  expect(() => check({ albedo, normal: { ...normal, min: 10, max: 9 } })).toThrow(
    "style.material.roles.actor.normal: expected min <= max",
  );
  expect(() => check({ albedo, normal: { ...normal, maxFrameChange: -1 } })).toThrow(
    "style.material.roles.actor.normal.maxFrameChange: expected an integer in 0..255",
  );
  expect(() => check({ albedo, normal: { ...normal, encoding: "estimated" } })).toThrow(
    "style.material.roles.actor.normal.encoding: unsupported discriminator",
  );
  expect(() => check({ albedo, normal: { ...normal, guessed: true } })).toThrow(
    "style.material.roles.actor.normal.guessed: unknown field",
  );
});
