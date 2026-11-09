import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encodePng, repositoryRoot, sha256Hex } from "../src/index.js";

it("preflights the declared profile for every CLI action before changing reviewed or golden output", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "asset-preflight-"));
  const assetPackage = join(root, "packages/assets");
  const world = join(root, "worlds/fixture");
  const profilePath = join(world, "reference/asset-style.json");
  const manifestPath = join(world, "assets/manifests/fixture-critter/idle.json");
  const reviewedPath = join(world, "assets/reviewed/keep.txt");
  const goldenPath = join(world, "assets/goldens/keep.scene.json");
  try {
    for (const dir of [
      "reference",
      "assets/manifests/fixture-critter",
      "assets/source/fixture-critter",
      "assets/reviewed",
      "assets/goldens",
    ])
      fs.mkdirSync(join(world, dir), { recursive: true });
    const original = join(repositoryRoot, "packages/assets");
    for (const dir of ["src", "bin"])
      fs.cpSync(join(original, dir), join(assetPackage, dir), { recursive: true });
    fs.writeFileSync(join(assetPackage, "package.json"), '{"type":"module"}');
    fs.symlinkSync(join(original, "node_modules"), join(assetPackage, "node_modules"));
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL("../../contracts/test/fixtures/asset-manifest/approved.json", import.meta.url),
        "utf8",
      ),
    );
    const rgba = new Uint8Array(4 * 4 * 4);
    rgba.set([32, 32, 32, 255], (1 * 4 + 1) * 4);
    rgba.set([128, 128, 128, 255], (2 * 4 + 2) * 4);
    const bytes = encodePng({ width: 4, height: 4, rgba });
    Object.assign(manifest, {
      frames: { width: 4, height: 4, count: 1, durationMs: null },
      anchor: { x: 2, y: 3 },
      bounds: { x: 1, y: 1, width: 2, height: 2 },
      contentHash: sha256Hex(bytes),
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(join(world, manifest.source.path), bytes);
    fs.writeFileSync(reviewedPath, "reviewed sentinel");
    fs.writeFileSync(goldenPath, "golden sentinel");
    const profile = JSON.parse(
      fs.readFileSync(join(repositoryRoot, "worlds/fixture/reference/asset-style.json"), "utf8"),
    );
    const run = (command: string) =>
      spawnSync(process.execPath, [join(assetPackage, "bin/clockgrove-assets.mjs"), command], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    for (const failure of ["STYLE_PROFILE_REQUIRED", "STYLE_PROFILE_INVALID", "STYLE_SIZE"]) {
      if (failure === "STYLE_PROFILE_INVALID") fs.writeFileSync(profilePath, "{}");
      if (failure === "STYLE_SIZE") {
        profile.sizes.actor.maxWidth = 3;
        fs.writeFileSync(profilePath, JSON.stringify(profile));
      }
      for (const command of ["check", "build", "update-golden"]) {
        const result = run(command);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(failure);
        expect(fs.readFileSync(reviewedPath, "utf8")).toBe("reviewed sentinel");
        expect(fs.readFileSync(goldenPath, "utf8")).toBe("golden sentinel");
      }
    }
    profile.sizes.actor.maxWidth = 256;
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    expect(run("build").status).toBe(0);
    expect(fs.readFileSync(join(world, "assets/reviewed/fixture.png")).length).toBeGreaterThan(0);
    expect(fs.readFileSync(join(world, "assets/license-report.md"), "utf8")).toContain(
      "fixture-critter",
    );
    expect(fs.readFileSync(goldenPath, "utf8")).toBe("golden sentinel");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
