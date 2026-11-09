import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeAssetManifest, decodeAssetStyleProfile } from "../src/index.js";

it("reads three world style profiles from authored files and refuses malformed declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "asset-style-"));
  try {
    const pixel = JSON.parse(
      readFileSync(
        new URL("../../../worlds/fixture/reference/asset-style.json", import.meta.url),
        "utf8",
      ),
    );
    const approved = JSON.parse(
      readFileSync(new URL("./fixtures/asset-manifest/approved.json", import.meta.url), "utf8"),
    );
    expect(decodeAssetManifest(approved).assetManifestVersion).toBe(1);
    expect(decodeAssetStyleProfile(pixel)).toEqual({
      styleProfileVersion: 1,
      alpha: { mode: "binary" },
      colour: { mode: "palette", colours: ["#202020", "#808080"], strictness: "exact" },
      edge: "transparent-pixel",
      sizes: {
        actor: { maxWidth: 256, maxHeight: 256 },
        object: { maxWidth: 256, maxHeight: 256 },
        terrain: { maxWidth: 256, maxHeight: 256 },
        effect: { maxWidth: 256, maxHeight: 256 },
      },
    });
    const painterly = {
      ...pixel,
      alpha: { mode: "soft", boundsThreshold: 16 },
      colour: { mode: "unrestricted" },
      edge: "unrestricted",
      sizes: Object.fromEntries(
        ["actor", "object", "terrain", "effect"].map((role) => [
          role,
          { maxWidth: 1024, maxHeight: 2048 },
        ]),
      ),
    };
    const cartoon = {
      ...pixel,
      alpha: { mode: "soft", boundsThreshold: 128 },
      colour: { mode: "palette", colours: ["#001122", "#ffffff"], strictness: "subset" },
      edge: "transparent-border",
    };
    for (const [name, value] of Object.entries({ pixel, painterly, cartoon })) {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      expect(decodeAssetStyleProfile(JSON.parse(readFileSync(path, "utf8")))).toEqual(value);
    }
    const malformed: [unknown, string][] = [
      [
        { ...pixel, styleProfileVersion: 2 },
        "style.styleProfileVersion: unsupported version; expected 1",
      ],
      [{ ...pixel, extra: true }, "style.extra: unknown field"],
      [
        { ...pixel, alpha: { mode: "soft", boundsThreshold: 0 } },
        "style.alpha.boundsThreshold: expected an integer in 1..255",
      ],
      [
        { ...pixel, alpha: { mode: "binary", boundsThreshold: 255 } },
        "style.alpha.boundsThreshold: unknown field",
      ],
      [
        {
          ...pixel,
          colour: { mode: "palette", colours: ["#ffffff", "#ffffff"], strictness: "exact" },
        },
        "style.colour.colours: expected non-empty sorted, unique colours",
      ],
      [
        { ...pixel, sizes: { ...pixel.sizes, actor: { maxWidth: 1025, maxHeight: 256 } } },
        "style.sizes.actor.maxWidth: expected an integer in 1..1024",
      ],
      [
        { ...pixel, sizes: { ...pixel.sizes, effect: { maxWidth: 256, maxHeight: 2049 } } },
        "style.sizes.effect.maxHeight: expected an integer in 1..2048",
      ],
      [
        {
          ...pixel,
          sizes: {
            actor: pixel.sizes.actor,
            object: pixel.sizes.object,
            terrain: pixel.sizes.terrain,
          },
        },
        "style.sizes.effect: missing field",
      ],
      [
        { ...pixel, colour: { ...pixel.colour, strictness: "approximate" } },
        "style.colour.strictness: unsupported discriminator",
      ],
      [{ ...pixel, edge: "antialias" }, "style.edge: unsupported discriminator"],
    ];
    for (const [value, reason] of malformed)
      expect(() => decodeAssetStyleProfile(value)).toThrow(reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
