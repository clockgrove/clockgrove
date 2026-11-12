import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAssetsCli } from "../src/cli.js";
import { repositoryRoot } from "../src/repository.js";
import { createRiggedModelFixture, rewriteModelJson } from "./model-fixture.js";

it("validates generated rigged GLB facts, world tier budgets and stable refusals through CLI", async () => {
  const world = mkdtempSync(join(tmpdir(), "model-assets-"));
  try {
    const { bytes, manifest, profile } = await createRiggedModelFixture();
    mkdirSync(join(world, "assets/source/model-fixture"), { recursive: true });
    mkdirSync(join(world, "assets/manifests/model-fixture"), { recursive: true });
    mkdirSync(join(world, "reference"), { recursive: true });
    const path = join(world, "assets/manifests/model-fixture/model.json");
    const save = () => writeFileSync(path, JSON.stringify(manifest));
    const run = () => runAssetsCli(["validate", path, "--world", world]);
    writeFileSync(join(world, manifest.output.path), bytes);
    writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    save();
    expect(run()).toEqual({
      status: 0,
      stdout: '{"status":"ok","command":"validate"}\n',
      stderr: "",
    });
    const unused = await createRiggedModelFixture({ unusedSampler: true });
    writeFileSync(join(world, manifest.output.path), unused.bytes);
    manifest.output.sha256 = unused.manifest.output.sha256;
    save();
    expect(run()).toEqual({
      status: 0,
      stdout: '{"status":"ok","command":"validate"}\n',
      stderr: "",
    });
    writeFileSync(join(world, manifest.output.path), bytes);
    manifest.output.sha256 = createHash("sha256").update(bytes).digest("hex");
    Object.assign(manifest.review, {
      status: "approved",
      reviewer: "fixture-human",
      reviewedAt: "2026-11-10T00:00:00Z",
    });
    save();
    expect(runAssetsCli(["build", "--world", world]).status).toBe(0);
    expect(readFileSync(join(world, "assets/reviewed/model-fixture.glb"))).toEqual(
      Buffer.from(bytes),
    );
    expect(
      JSON.parse(readFileSync(join(world, "assets/reviewed/models.json"), "utf8"))["model-fixture"]
        .path,
    ).toBe("model-fixture.glb");
    expect(runAssetsCli(["check", "--world", world]).status).toBe(0);
    cpSync(join(repositoryRoot, "worlds/fixture/assets"), join(world, "assets"), {
      recursive: true,
    });
    cpSync(join(repositoryRoot, "worlds/fixture/reference"), join(world, "reference"), {
      recursive: true,
    });
    expect(runAssetsCli(["build", "--world", world]).status).toBe(0);
    expect(readFileSync(join(world, "assets/reviewed/model-fixture.glb"))).toEqual(
      Buffer.from(bytes),
    );
    expect(readFileSync(join(world, "assets/reviewed/atlases.json"))).toEqual(
      readFileSync(join(repositoryRoot, "worlds/fixture/assets/reviewed/atlases.json")),
    );
    manifest.output.bounds.max[1] = 3;
    save();
    expect(run().stderr).toContain("MODEL_BOUNDS_MISMATCH");
    manifest.output.bounds.max[1] = 2;
    manifest.output.clips[0]!.loop = false;
    save();
    expect(run().stderr).toContain("MODEL_CLIPS_MISMATCH");
    manifest.output.clips[0]!.loop = true;
    manifest.output.clips[0]!.generated = true;
    save();
    expect(run().stderr).toContain("generated clips require generated-asset provenance");
    manifest.output.clips[0]!.generated = false;
    Object.assign(manifest.output, { rig: { template: "shared", sha256: "a".repeat(64) } });
    save();
    expect(run().stderr).toContain("MODEL_RIG_MISMATCH");
    delete (manifest.output as typeof manifest.output & { rig?: unknown }).rig;
    manifest.source.kind = "generated";
    Object.assign(manifest.provenance, {
      prompt: "test",
      model: "test",
      provider: "test",
      route: "test",
      providerTermsVersion: "test",
      outputGrant: { license: "MIT", plan: "test", commercial: false, relabel: true },
    });
    save();
    expect(run().stderr).toContain("OUTPUT_GRANT_NOT_PERMITTED");
    manifest.source.kind = "authored";
    manifest.provenance = { prompt: null, references: [] };
    manifest.output.triangles = 2;
    save();
    expect(run().stderr).toContain("MODEL_METRIC_MISMATCH: triangles: declared 2, actual 1");
    manifest.output.triangles = 1;
    manifest.output.clips[0]!.durationMs = 500;
    save();
    expect(run().stderr).toContain("MODEL_CLIPS_MISMATCH");
    manifest.output.clips[0]!.durationMs = 1000;
    save();
    profile.tiers.low.triangles = 0;
    writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    expect(run().stderr).toContain("MODEL_BUDGET_EXCEEDED: low.triangles: 1 exceeds 0");
    for (const malformed of [
      rewriteModelJson(bytes, (json) => {
        json.asset.version = "1.0";
      }),
      rewriteModelJson(bytes, (json) => {
        json.meshes[0].primitives[0].attributes.POSITION = 999;
      }),
      ...[
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].channels[0].target.path = "bad";
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].channels[0].target.node = 999;
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].channels[0].sampler = 999;
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].samplers[0].interpolation = "bad";
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].samplers[0].input = 999;
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].samplers[0].output = json.animations[0].samplers[0].input;
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].samplers[0].interpolation = "CUBICSPLINE";
        },
        (json: Parameters<Parameters<typeof rewriteModelJson>[1]>[0]) => {
          json.animations[0].channels.push(json.animations[0].channels[0]);
        },
      ].map((change) => rewriteModelJson(bytes, change)),
      Uint8Array.from(bytes, (value, index) => (index === 4 ? 1 : value)),
      Uint8Array.from(bytes, (value, index) => (index === 12 ? 1 : value)),
    ]) {
      writeFileSync(join(world, manifest.output.path), malformed);
      manifest.output.sha256 = createHash("sha256").update(malformed).digest("hex");
      save();
      const refusal = run();
      expect(refusal.status).toBe(1);
      expect(refusal.stderr).toContain("MODEL_GLB_INVALID");
    }
    writeFileSync(join(world, manifest.output.path), Buffer.from("not glTF"));
    expect(run().stderr).toContain("MODEL_GLB_INVALID");
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

it("accepts PNG and JPEG handoff textures and KTX2 meshopt shipping media through the same CLI", async () => {
  const world = mkdtempSync(join(tmpdir(), "model-media-"));
  try {
    mkdirSync(join(world, "assets/source/model-fixture"), { recursive: true });
    mkdirSync(join(world, "reference"), { recursive: true });
    const path = join(world, "model.json");
    for (const texture of ["png", "jpeg", "ktx2"] as const) {
      const { bytes, manifest, profile } = await createRiggedModelFixture({
        texture,
        meshopt: texture === "ktx2",
        lod: texture === "ktx2",
        generated: texture === "png",
      });
      writeFileSync(join(world, manifest.output.path), bytes);
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
      expect(runAssetsCli(["validate", path, "--world", world]), texture).toEqual({
        status: 0,
        stdout: '{"status":"ok","command":"validate"}\n',
        stderr: "",
      });
      if (texture === "ktx2") {
        manifest.output.lods = 1;
        writeFileSync(path, JSON.stringify(manifest));
        expect(runAssetsCli(["validate", path, "--world", world]).stderr).toContain(
          "MODEL_METRIC_MISMATCH: lods: declared 1, actual 2",
        );
      }
    }
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});
