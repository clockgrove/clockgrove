import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decodeAssetManifest,
  decodeAssetStyleProfile,
  MATERIAL_CHANNELS,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  buildAtlases,
  decodePng,
  encodePng,
  materialAtlasFiles,
  packAtlas,
  readManifests,
  sha256Hex,
  uploadReviewedAssets,
  validateSource,
} from "../src/index.js";

const budgets = JSON.parse(
  readFileSync(new URL("../../../apps/web/scene-budgets.json", import.meta.url), "utf8"),
).budgets;
const template = JSON.parse(
  readFileSync(
    new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
    "utf8",
  ),
);
const fixtureStyle = JSON.parse(
  readFileSync(
    new URL("../../../worlds/fixture/reference/asset-style.json", import.meta.url),
    "utf8",
  ),
);
const policies = Object.fromEntries(
  MATERIAL_CHANNELS.map((channel) => [
    channel,
    {
      encoding: channel === "albedo" ? "srgb" : "linear",
      min: 0,
      max: 255,
      maxFrameChange: channel === "normal" ? 6 : 255,
    },
  ]),
);
const profile = decodeAssetStyleProfile({
  ...fixtureStyle,
  colour: { mode: "unrestricted" },
  material: {
    materialVersion: 1,
    roles: Object.fromEntries(
      ["actor", "object", "terrain", "effect"].map((role) => [role, policies]),
    ),
  },
});
function art(role: "actor" | "object", normal = [64, 64, 64]) {
  const assetId = `material-${role}`;
  const animationFamily = role === "actor" ? "idle" : "static";
  const count = role === "actor" ? 3 : 1;
  const sources: Record<string, Uint8Array> = {};
  const renditions = ([1, 2] as const).map((density) => ({
    density,
    channels: Object.fromEntries(
      MATERIAL_CHANNELS.map((channel) => {
        const width = 4 * count * density,
          height = 4 * density;
        const rgba = new Uint8Array(width * height * 4);
        for (let frame = 0; frame < count; frame++)
          for (let y = density; y < 3 * density; y++)
            for (let x = density; x < 3 * density; x++) {
              const value = channel === "normal" ? (normal[frame] as number) : 32;
              rgba.set([value, value, value, 255], (y * width + frame * 4 * density + x) * 4);
            }
        const bytes = encodePng({ width, height, rgba });
        const path =
          channel === "albedo" && density === 1
            ? `assets/source/${assetId}/${animationFamily}.png`
            : `assets/source/${assetId}/${animationFamily}-${density}x-${channel}.png`;
        sources[path] = bytes;
        return [channel, { path, sha256: sha256Hex(bytes) }];
      }),
    ),
  }));
  const source = `assets/source/${assetId}/${animationFamily}.png`;
  const bytes = sources[source] as Uint8Array;
  const manifest = decodeAssetManifest({
    ...template,
    assetId,
    animationFamily,
    source: { ...template.source, path: source },
    semantic: { ...template.semantic, role },
    frames: { width: 4, height: 4, count, durationMs: count > 1 ? 100 : null },
    bounds: { x: 1, y: 1, width: 2, height: 2 },
    anchor: { x: 2, y: 3 },
    palette: ["#202020"],
    atlas: { atlasId: "lit", x: 0, y: 0 },
    contentHash: sha256Hex(bytes),
    material: { materialVersion: 1, renditions },
  });
  return { manifest, bytes, materialSources: sources };
}
function world() {
  const root = mkdtempSync(join(tmpdir(), "material-world-"));
  const entries = [art("actor"), art("object")];
  const layout = packAtlas(entries.map((e) => e.manifest));
  for (const entry of entries) {
    const p = layout.get(`${entry.manifest.assetId}/${entry.manifest.animationFamily}`)!;
    entry.manifest = { ...entry.manifest, atlas: { ...entry.manifest.atlas, x: p.x, y: p.y } };
    const json = join(
      root,
      "assets/manifests",
      entry.manifest.assetId,
      `${entry.manifest.animationFamily}.json`,
    );
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify(entry.manifest));
    for (const [path, bytes] of Object.entries(entry.materialSources)) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
  mkdirSync(join(root, "reference"));
  writeFileSync(join(root, "reference/asset-style.json"), JSON.stringify(profile));
  return root;
}
it("validates generated fixture-style actor and prop images through CLI, packing, compression and reviewed delivery", async () => {
  const root = world();
  try {
    const entries = readManifests(root);
    expect(
      entries.map((entry) =>
        validateSource(entry.manifest, entry.bytes, entry.path, profile, entry.materialSources),
      ),
    ).toEqual([[], []]);
    const output = execFileSync(
      process.execPath,
      [
        "bin/clockgrove-assets.mjs",
        "validate",
        join(root, "assets/manifests/material-actor/idle.json"),
        "--world",
        root,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 },
    );
    expect(JSON.parse(output)).toEqual({ status: "ok", command: "validate" });
    const atlases = buildAtlases(entries, undefined, profile);
    expect(buildAtlases([...entries].reverse(), undefined, profile)).toEqual(atlases);
    const textures = atlases.flatMap((atlas) => atlas.materialTextures ?? []);
    expect(textures).toHaveLength(20);
    expect(materialAtlasFiles(atlases)).toHaveLength(40);
    const built = () =>
      Object.fromEntries(
        readdirSync(join(root, "assets/reviewed"))
          .sort()
          .map((name) => [name, sha256Hex(readFileSync(join(root, "assets/reviewed", name)))]),
      );
    const build = () =>
      execFileSync(process.execPath, ["bin/clockgrove-assets.mjs", "build", "--world", root], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 30_000,
      });
    expect(JSON.parse(build())).toEqual({ status: "ok", command: "build" });
    const firstBuild = built();
    expect(Object.keys(firstBuild)).toHaveLength(44);
    expect(JSON.parse(build())).toEqual({ status: "ok", command: "build" });
    expect(built()).toEqual(firstBuild);
    expect(
      readdirSync(join(root, "assets/reviewed")).reduce(
        (n, name) => n + readFileSync(join(root, "assets/reviewed", name)).length,
        0,
      ),
    ).toBeLessThanOrEqual(budgets.assetBytes.limit);
    expect(
      textures.reduce((n, t) => n + t.width * t.height * 4, 0) +
        atlases.reduce((n, atlas) => {
          const image = decodePng(atlas.png);
          return n + image.width * image.height * 4;
        }, 0),
    ).toBeLessThanOrEqual(budgets.textureBytes.limit);
    for (const texture of textures) {
      const dds = new DataView(texture.compressed.buffer);
      expect(new TextDecoder().decode(texture.compressed.subarray(0, 4))).toBe("DDS ");
      expect(dds.getUint32(4, true)).toBe(124);
      expect(dds.getUint32(8, true)).toBe(0x81007);
      expect(new TextDecoder().decode(texture.compressed.subarray(84, 88))).toBe("DXT5");
      expect([dds.getUint32(16, true), dds.getUint32(12, true)]).toEqual([
        texture.width,
        texture.height,
      ]);
      expect(texture.compressed.length).toBe(128 + texture.width * texture.height);
      expect([dds.getUint32(76, true), dds.getUint32(80, true), dds.getUint32(108, true)]).toEqual([
        32, 4, 0x1000,
      ]);
      expect(dds.getUint32(20, true)).toBe(texture.width * texture.height);
      expect(decodePng(texture.png).width).toBe(texture.width);
    }
    const normal = textures.find((t) => t.channel === "normal" && t.density === 1)!;
    // Independently decode the 565 endpoint and alpha selector for covered texel (1,1) of block 0.
    const block = new DataView(normal.compressed.buffer);
    const endpoint = block.getUint16(136, true);
    expect([(endpoint >> 11) & 31, (endpoint >> 5) & 63, endpoint & 31]).toEqual([8, 16, 8]);
    let alphaBits = 0n;
    for (let i = 0; i < 6; i++) alphaBits |= BigInt(normal.compressed[130 + i]!) << BigInt(i * 8);
    expect(Number((alphaBits >> 15n) & 7n)).toBe(0);
    expect(normal.compressed[128]).toBe(255);
    const metadata = JSON.parse(atlases[0]!.animations);
    const materials = JSON.parse(
      readFileSync(join(root, "assets/reviewed/materials.json"), "utf8"),
    );
    expect(materials["material-actor/idle"]).toEqual(metadata.animations[0].material);
    expect(materials["material-actor/idle"].renditions[0].channels.albedo.encoding).toBe("srgb");
    expect(materials["material-actor/idle"].renditions[0].channels.normal.encoding).toBe("linear");
    const linear = {
      ...profile,
      material: {
        ...profile.material!,
        roles: {
          ...profile.material!.roles,
          actor: {
            ...profile.material!.roles.actor,
            albedo: { ...profile.material!.roles.actor.albedo, encoding: "linear" as const },
          },
        },
      },
    };
    expect(
      JSON.parse(buildAtlases(entries, undefined, linear)[0]!.animations).animations[0].material
        .renditions[0].channels.albedo.encoding,
    ).toBe("linear");
    expect(
      metadata.animations.map((a: { material: { renditions: { density: number }[] } }) =>
        a.material.renditions.map((r) => r.density),
      ),
    ).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(Object.keys(metadata.animations[0].material.renditions[0].channels).sort()).toEqual(
      [...MATERIAL_CHANNELS].sort(),
    );
    expect(metadata.animations[0].material.renditions[1].channels.albedo.frames[2]).toEqual({
      atlasId: "lit-2x-albedo",
      x: 16,
      y: 0,
      width: 8,
      height: 8,
    });
    const stored = new Map<string, Uint8Array>();
    const result = await uploadReviewedAssets(
      {
        head: async (key) => stored.has(key),
        put: async (key, bytes) => {
          stored.set(key, bytes);
        },
      },
      {
        entries,
        profile,
        golden: {
          sceneSha256: "a".repeat(64),
          approval: {
            status: "approved",
            reviewer: "reviewer",
            approvedSceneSha256: "a".repeat(64),
          },
        },
      },
    );
    expect(result.uploaded.length).toBe(stored.size);
    expect(stored.has(`sha256/${sha256Hex(normal.compressed)}`)).toBe(true);
    expect(stored.has(`sha256/${sha256Hex(normal.png)}`)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("refuses material grid, coverage, ranges, hashes, scaled bounds and excessive loop-seam changes with stable reasons", () => {
  const entry = art("actor", [64, 70, 76]);
  const validate = () =>
    validateSource(entry.manifest, entry.bytes, undefined, profile, entry.materialSources);
  expect(validate()).toEqual([
    "material-actor/idle: MATERIAL_FRAME_CHANGE: 1x/normal exceeds declared loop frame-change bound",
    "material-actor/idle: MATERIAL_FRAME_CHANGE: 2x/normal exceeds declared loop frame-change bound",
  ]);
  const baseline = art("actor");
  const replace = (change: (image: ReturnType<typeof decodePng>) => void, hash = true) => {
    const path = baseline.manifest.material!.renditions[1]!.channels.normal!.path;
    const image = decodePng(baseline.materialSources[path]!);
    change(image);
    const bytes = encodePng(image);
    const manifest = decodeAssetManifest({
      ...baseline.manifest,
      material: {
        materialVersion: 1,
        renditions: baseline.manifest.material!.renditions.map((r) =>
          r.density !== 2
            ? r
            : {
                ...r,
                channels: {
                  ...r.channels,
                  normal: { path, sha256: hash ? sha256Hex(bytes) : "0".repeat(64) },
                },
              },
        ),
      },
    });
    return validateSource(manifest, baseline.bytes, undefined, profile, {
      ...baseline.materialSources,
      [path]: bytes,
    });
  };
  const invalid = new Uint8Array([0]);
  const badSource = baseline.manifest.material!.renditions[1]!.channels.normal!;
  const undecodable = decodeAssetManifest({
    ...baseline.manifest,
    material: {
      materialVersion: 1,
      renditions: baseline.manifest.material!.renditions.map((r) =>
        r.density !== 2
          ? r
          : {
              ...r,
              channels: { ...r.channels, normal: { ...badSource, sha256: sha256Hex(invalid) } },
            },
      ),
    },
  });
  expect(
    validateSource(undecodable, baseline.bytes, undefined, profile, {
      ...baseline.materialSources,
      [badSource.path]: invalid,
    }),
  ).toEqual(["material-actor/idle: MATERIAL_DECODE: 2x/normal"]);
  expect(replace(() => {}, false)).toEqual(["material-actor/idle: MATERIAL_HASH: 2x/normal"]);
  expect(replace((image) => image.rgba.fill(0))).toEqual([
    "material-actor/idle: MATERIAL_ALPHA: 2x/normal coverage differs from albedo",
  ]);
  const strict = {
    ...profile,
    material: {
      materialVersion: 1 as const,
      roles: {
        ...profile.material!.roles,
        actor: {
          ...profile.material!.roles.actor,
          normal: { ...profile.material!.roles.actor.normal!, max: 63 },
        },
      },
    },
  };
  expect(
    validateSource(baseline.manifest, baseline.bytes, undefined, strict, baseline.materialSources),
  ).toEqual([
    "material-actor/idle: MATERIAL_RANGE: 1x/normal outside declared RGB range",
    "material-actor/idle: MATERIAL_RANGE: 2x/normal outside declared RGB range",
  ]);
  expect(
    replace((image) =>
      Object.assign(image, {
        width: image.width / 2,
        rgba: image.rgba.subarray(0, image.rgba.length / 2),
      }),
    ),
  ).toEqual(["material-actor/idle: MATERIAL_GRID: 2x/normal expected 24x8"]);
  const albedo = baseline.manifest.material!.renditions[1]!.channels.albedo;
  const image = decodePng(baseline.materialSources[albedo.path]!);
  image.rgba.set([32, 32, 32, 255], 0);
  const bytes = encodePng(image);
  const malformed = decodeAssetManifest({
    ...baseline.manifest,
    material: {
      materialVersion: 1,
      renditions: baseline.manifest.material!.renditions.map((r) =>
        r.density !== 2
          ? r
          : { ...r, channels: { ...r.channels, albedo: { ...albedo, sha256: sha256Hex(bytes) } } },
      ),
    },
  });
  expect(
    validateSource(malformed, baseline.bytes, undefined, profile, {
      ...baseline.materialSources,
      [albedo.path]: bytes,
    })[0],
  ).toBe("material-actor/idle: MATERIAL_BOUNDS: 2x/albedo does not match scaled owning bounds");
});
