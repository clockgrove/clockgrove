import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAssetsCli } from "../src/cli.js";
import { decodePng, encodePng, repositoryRoot, sha256Hex } from "../src/index.js";

it.each(["pixel", "cartoon", "painterly"])(
  "builds and reviews an external %s world through the pinned CLI",
  (style) => {
    const world = mkdtempSync(join(tmpdir(), "external-assets-"));
    // Commands run in this process; the executable itself runs once, for the final check.
    const run = (...args: string[]) => runAssetsCli([...args, "--world", world]);
    try {
      expect(run("check", "--world", world).status).toBe(2);
      expect(run("validate").status).toBe(2);
      cpSync(join(repositoryRoot, "worlds/fixture/reference"), join(world, "reference"), {
        recursive: true,
      });
      // Presentation metadata binds assets, but the world has none: nothing to check is a refusal.
      const empty = run("check");
      expect([empty.status, empty.stderr.includes("ASSETS_REQUIRED")]).toEqual([1, true]);
      const manifest = JSON.parse(
        readFileSync(
          join(repositoryRoot, "packages/contracts/test/fixtures/asset-manifest/approved.json"),
          "utf8",
        ),
      );
      mkdirSync(join(world, "assets/manifests/fixture-critter"), { recursive: true });
      mkdirSync(join(world, "assets/source/fixture-critter"), { recursive: true });
      const presentationPath = join(world, "reference/presentation.json");
      const presentation = JSON.parse(readFileSync(presentationPath, "utf8"));
      presentation.bindings = [
        { ...presentation.bindings[0], assetId: "fixture-critter", animationFamily: "idle" },
      ];
      presentation.effects = [];
      writeFileSync(presentationPath, JSON.stringify(presentation));
      const profilePath = join(world, "reference/asset-style.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      if (style === "cartoon") {
        profile.colour.strictness = "subset";
        profile.edge = "transparent-border";
        for (const limit of Object.values(profile.sizes) as {
          maxWidth: number;
          maxHeight: number;
        }[])
          Object.assign(limit, { maxWidth: 64, maxHeight: 64 });
      }
      if (style === "painterly") {
        profile.alpha = { mode: "soft", boundsThreshold: 180 };
        profile.colour = { mode: "unrestricted" };
        profile.edge = "unrestricted";
        for (const limit of Object.values(profile.sizes) as {
          maxWidth: number;
          maxHeight: number;
        }[])
          Object.assign(limit, { maxWidth: 512, maxHeight: 512 });
      }
      writeFileSync(profilePath, JSON.stringify(profile));
      const rgba = new Uint8Array(64);
      rgba.set([32, 32, 32, 255], 20);
      rgba.set([128, 128, 128, 255], 40);
      const bytes = encodePng({ width: 4, height: 4, rgba });
      Object.assign(manifest, {
        frames: { width: 4, height: 4, count: 1, durationMs: null },
        anchor: { x: 2, y: 3 },
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        contentHash: sha256Hex(bytes),
      });
      const path = join(world, "assets/manifests/fixture-critter/idle.json");
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(join(world, manifest.source.path), bytes);
      expect(run("validate", path).status).toBe(0);
      expect(run("validate", join(world, "missing.json")).status).toBe(2);
      const outside = join(repositoryRoot, "packages/contracts/test/fixtures/asset-manifest");
      expect(run("validate", join(outside, "approved.json")).stderr).toContain(
        "ASSET_PATH_INVALID",
      );
      expect(run("validate", join(outside, "approved.json")).status).toBe(2);
      const approved = manifest.review;
      manifest.review = { status: "pending", reviewer: null, reviewedAt: null, notes: "" };
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).status).toBe(0);
      expect(run("check").stderr).toContain("REVIEW_NOT_APPROVED fixture-critter/idle:");
      manifest.review = approved;
      writeFileSync(path, JSON.stringify(manifest));
      const unrelated = join(world, "assets/manifests/fixture-critter/broken.json");
      writeFileSync(unrelated, "{");
      expect(run("validate", path).status).toBe(0);
      expect(run("check").stderr).toContain(`JSON_INVALID: ${unrelated}:`);
      writeFileSync(unrelated, "{}");
      const malformed = run("check");
      expect([malformed.status, malformed.stderr]).toEqual([
        1,
        expect.stringContaining("ASSET_MANIFEST_INVALID: assets/manifests/fixture-critter/broken"),
      ]);
      const source = (width: number, height: number, paint: [number, number[]][]) => {
        const pixels = new Uint8Array(width * height * 4);
        for (const [index, rgba] of paint) pixels.set(rgba, index * 4);
        const png = encodePng({ width, height, rgba: pixels });
        writeFileSync(join(world, manifest.source.path), png);
        return png;
      };
      const refusal = (changes: object, png: Uint8Array) => {
        writeFileSync(
          path,
          JSON.stringify({ ...manifest, ...changes, contentHash: sha256Hex(png) }),
        );
        const result = run("validate", path);
        expect(result.status).toBe(1);
        return result.stderr;
      };
      if (style === "cartoon") {
        // Cartoon refusals through the CLI: painted border, off-palette colour, oversize frame.
        expect(refusal({}, source(4, 4, [[0, [32, 32, 32, 255]]]))).toContain("STYLE_EDGE");
        expect(refusal({}, source(4, 4, [[5, [255, 0, 0, 255]]]))).toContain("STYLE_PALETTE");
        const big = { frames: { width: 65, height: 4, count: 1, durationMs: null } };
        expect(refusal(big, source(65, 4, [[66, [32, 32, 32, 255]]]))).toContain("STYLE_SIZE");
        writeFileSync(path, JSON.stringify(manifest));
        writeFileSync(join(world, manifest.source.path), bytes);
      }
      rmSync(unrelated);
      if (style === "pixel") {
        // A one-colour sprite passes the exact pixel-art profile on its own; `exact` is per world,
        // so a world whose only asset leaves #808080 unused is refused at build.
        const one = source(4, 4, [[5, [32, 32, 32, 255]]]);
        const single = { bounds: { x: 1, y: 1, width: 1, height: 1 }, palette: ["#202020"] };
        writeFileSync(
          path,
          JSON.stringify({ ...manifest, ...single, contentHash: sha256Hex(one) }),
        );
        expect(run("validate", path).status).toBe(0);
        expect(run("build").stderr).toContain("world palette colour #808080 is unused by every");
        writeFileSync(path, JSON.stringify(manifest));
        writeFileSync(join(world, manifest.source.path), bytes);
      }
      if (style === "painterly") {
        Object.assign(profile.sizes.actor, { maxWidth: 1024, maxHeight: 2048 });
        writeFileSync(profilePath, JSON.stringify(profile));
        const stripManifest = structuredClone(manifest);
        // Under a 1024x2048 actor limit, a 3072 px strip wraps onto two rows of one page. With
        // 1025 px frames two rows pass 2048 px, so the third frame continues on a second page.
        for (const height of [4, 1025]) {
          const strip = new Uint8Array(1024 * 3 * height * 4);
          for (let frame = 0; frame < 3; frame++)
            strip.set([32, 32, 32, 255], (1024 * 3 + frame * 1024 + 1) * 4);
          const png = encodePng({ width: 1024 * 3, height, rgba: strip });
          Object.assign(stripManifest, {
            frames: { width: 1024, height, count: 3, durationMs: 100 },
            bounds: { x: 1, y: 1, width: 1, height: 1 },
            contentHash: sha256Hex(png),
          });
          writeFileSync(path, JSON.stringify(stripManifest));
          writeFileSync(join(world, manifest.source.path), png);
          expect(run("validate", path).status).toBe(0);
          expect(run("build").status).toBe(0);
          const reviewed = join(world, "assets/reviewed");
          const pages = JSON.parse(readFileSync(join(reviewed, "atlases.json"), "utf8")).atlases;
          const { atlasId } = stripManifest.atlas;
          expect(pages).toEqual(height === 4 ? [atlasId] : [atlasId, `${atlasId}-page-2`]);
          const frames = JSON.parse(
            readFileSync(join(reviewed, `${atlasId}.animations.json`), "utf8"),
          ).animations[0].frames;
          expect(frames.map((f: { atlasId?: string }) => f.atlasId ?? atlasId)).toEqual([
            atlasId,
            atlasId,
            height === 4 ? atlasId : `${atlasId}-page-2`,
          ]);
        }
        writeFileSync(path, JSON.stringify(manifest));
        writeFileSync(join(world, manifest.source.path), bytes);
      }
      expect(run("build").status).toBe(0);
      expect(readFileSync(join(world, "assets/license-report.md"), "utf8")).toContain(
        manifest.assetId,
      );
      expect(run("check").stderr).toContain("golden");
      expect(run("update-golden").status).toBe(0);
      const goldenPath = join(world, "assets/goldens/reference.scene.json");
      const approve = () => {
        const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
        expect(golden.approval.status).toBe("pending");
        golden.approval = {
          status: "approved",
          reviewer: "synthetic-reviewer",
          approvedSceneSha256: golden.sceneSha256,
        };
        writeFileSync(goldenPath, JSON.stringify(golden));
      };
      expect(run("check").stderr).toContain("not human-approved");
      approve();
      expect(run("update-golden").status).toBe(0);
      const pinned = spawnSync(
        process.execPath,
        [
          join(repositoryRoot, "packages/assets/bin/clockgrove-assets.mjs"),
          "check",
          "--world",
          world,
        ],
        { cwd: world, encoding: "utf8", timeout: 30_000 },
      );
      expect([pinned.status, pinned.stdout]).toEqual([0, '{"status":"ok","command":"check"}\n']);
      if (style === "pixel") {
        const record = readFileSync(goldenPath, "utf8");
        for (const reviewer of [null, "github-actions[bot]"]) {
          const golden = JSON.parse(record);
          golden.approval.reviewer = reviewer;
          writeFileSync(goldenPath, JSON.stringify(golden));
          expect(run("check").stderr).toContain("GOLDEN_REVIEWER_NOT_HUMAN");
        }
        writeFileSync(goldenPath, record);
        // Malformed world data is a coded input refusal (exit 1), not an internal error (70).
        const actors = join(world, "reference/resources/actors");
        const actorPath = join(actors, readdirSync(actors).sort()[0] as string);
        const actor = readFileSync(actorPath, "utf8");
        writeFileSync(actorPath, JSON.stringify({ ...JSON.parse(actor), placement: {} }));
        const bad = run("check");
        expect([bad.status, bad.stderr]).toEqual([
          1,
          expect.stringContaining("PACK_SCENE_INVALID"),
        ]);
        writeFileSync(actorPath, actor);
      }
      if (style === "painterly") {
        // The small binary placeholder has already passed under the same soft-alpha profile.
        const painted = new Uint8Array(300 * 300 * 4);
        painted.set([17, 99, 201, 180], (150 * 300 + 150) * 4);
        painted.set([123, 213, 42, 64], (149 * 300 + 150) * 4);
        const png = encodePng({ width: 300, height: 300, rgba: painted });
        Object.assign(manifest, {
          frames: { width: 300, height: 300, count: 1, durationMs: null },
          bounds: { x: 150, y: 150, width: 1, height: 1 },
          contentHash: sha256Hex(png),
        });
        writeFileSync(path, JSON.stringify(manifest));
        writeFileSync(join(world, manifest.source.path), png);
        expect(run("validate", path).status).toBe(0);
        expect(run("build").status).toBe(0);
        const changed = run("check");
        expect(changed.status).toBe(1);
        expect(changed.stderr).toContain("visual diff");
        expect(run("update-golden").status).toBe(0);
        approve();
        expect(run("check").status).toBe(0);
        // Soft alpha blends over the grass (noon, [88, 140, 72]); the golden stays opaque.
        const scene = decodePng(readFileSync(join(world, "assets/goldens/reference.scene.png")));
        const pixels = new Set<string>();
        for (let i = 0; i < scene.rgba.length; i += 4)
          pixels.add(scene.rgba.slice(i, i + 4).join());
        expect([...pixels].filter((p) => !p.endsWith(",255"))).toEqual([]);
        expect(pixels).toContain("38,111,163,255");
        expect(pixels).toContain("97,158,64,255");
      }
      const provenance = manifest.provenance;
      manifest.provenance = { prompt: provenance.prompt, references: provenance.references };
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).stderr).toContain("GENERATED_PROVENANCE_INCOMPLETE");
      manifest.provenance = provenance;
      manifest.license = "CC-BY-4.0";
      provenance.outputGrant = {
        license: "CC-BY-4.0",
        plan: "free",
        commercial: true,
        relabel: false,
        attribution: "Provider credit",
      };
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).status).toBe(0);
      expect(run("build").status).toBe(0);
      expect(readFileSync(join(world, "assets/license-report.md"), "utf8")).toContain(
        "Provider credit",
      );
      manifest.license = "MIT";
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).stderr).toContain("OUTPUT_GRANT_LICENSE_MISMATCH");
      manifest.license = "CC-BY-4.0";
      provenance.outputGrant.commercial = false;
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).stderr).toContain("OUTPUT_GRANT_NOT_PERMITTED");
      provenance.outputGrant.commercial = true;
      manifest.contentHash = "0".repeat(64);
      writeFileSync(path, JSON.stringify(manifest));
      expect(run("validate", path).status).toBe(1);
      expect(run("validate", path).stderr).toContain("contentHash");
    } finally {
      rmSync(world, { recursive: true, force: true });
    }
  },
);
