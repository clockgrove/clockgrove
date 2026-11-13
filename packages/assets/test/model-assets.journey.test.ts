import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAssetsCli } from "../src/cli.js";
import { inspectModel } from "../src/model.js";
import { repositoryRoot } from "../src/repository.js";
import { createRiggedModelFixture, modelWithTriangles, rewriteModelJson } from "./model-fixture.js";

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

it("checks embedded LOD triangle levels and each selected tier through CLI", async () => {
  const world = mkdtempSync(join(tmpdir(), "model-lods-"));
  try {
    const { bytes, manifest, profile } = await createRiggedModelFixture();
    const chain = rewriteModelJson(bytes, (json) => {
      const actor = json.nodes.find((node: { name: string }) => node.name === "actor");
      const primitive = json.meshes[0].primitives[0];
      json.meshes = [6, 2, 1, 1].map((count) => ({
        primitives: Array.from({ length: count }, () => primitive),
      }));
      const alternate = json.nodes.length;
      actor.extensions = { MSFT_lod: { ids: [alternate, alternate + 1] } };
      json.nodes.push(
        { mesh: 1 },
        { mesh: 2 },
        { children: [alternate + 3] },
        { mesh: 3 },
        { mesh: 3 },
      );
      json.scenes[0].nodes.push(alternate + 2, alternate + 4);
      json.extensionsUsed = ["MSFT_lod"];
    });
    expect(inspectModel(chain).levelTriangles).toEqual([7, 3, 2]);
    const nested = rewriteModelJson(chain, (json) => {
      const actor = json.nodes.find((node: { name: string }) => node.name === "actor");
      const [first, second] = actor.extensions.MSFT_lod.ids;
      actor.extensions.MSFT_lod.ids = [first];
      json.nodes[first].extensions = { MSFT_lod: { ids: [second] } };
    });
    expect(inspectModel(nested).levelTriangles).toEqual([7, 3, 2]);
    Object.assign(manifest.output, {
      triangles: 7,
      lods: 3,
      sha256: createHash("sha256").update(chain).digest("hex"),
      levels: [{ triangles: 7 }, { triangles: 3 }, { triangles: 2 }],
      renditions: { low: [1, 2] },
    });
    Object.assign(profile.limits, { triangles: 7, lods: 3 });
    Object.assign(profile.tiers.low, { triangles: 3, lods: 3 });
    mkdirSync(join(world, "assets/source/model-fixture"), { recursive: true });
    mkdirSync(join(world, "reference"));
    const path = join(world, "model.json");
    const save = () => {
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    };
    const run = () => runAssetsCli(["validate", path, "--world", world]);
    writeFileSync(join(world, manifest.output.path), chain);
    save();
    expect(run()).toEqual({
      status: 0,
      stdout: '{"status":"ok","command":"validate"}\n',
      stderr: "",
    });
    profile.tiers.low.triangles = 2;
    save();
    expect(run().stderr).toContain("MODEL_BUDGET_EXCEEDED: low.triangles: 3 exceeds 2 (level 1)");
    profile.tiers.low.triangles = 3;
    const output = manifest.output as typeof manifest.output & {
      levels: { triangles: number }[];
      renditions: Record<string, number[]>;
    };
    output.levels[1]!.triangles = 4;
    save();
    expect(run().stderr).toContain(
      "MODEL_METRIC_MISMATCH: levels[1].triangles: declared 4, actual 3",
    );
    output.levels[1]!.triangles = 3;
    output.renditions.low = [0];
    save();
    expect(run().stderr).toContain("MODEL_BUDGET_EXCEEDED: low.triangles: 7 exceeds 3");
    output.renditions.low = [3];
    save();
    expect(run().stderr).toContain("ASSET_MANIFEST_INVALID");
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

it("validates and ships every declared sibling LOD file with tier renditions", async () => {
  const world = mkdtempSync(join(tmpdir(), "model-file-lods-"));
  try {
    const { bytes, manifest, profile } = await createRiggedModelFixture();
    const files = [6, 2, 1].map((triangles) => modelWithTriangles(bytes, triangles));
    const levels = files.map((data, index) => ({
      triangles: [6, 2, 1][index]!,
      path: index ? `assets/source/model-fixture/lod-${index}.glb` : manifest.output.path,
      sha256: createHash("sha256").update(data).digest("hex"),
    }));
    Object.assign(manifest.output, {
      triangles: 6,
      lods: 3,
      sha256: levels[0]!.sha256,
      levels,
      renditions: { low: [1, 2] },
    });
    Object.assign(profile.limits, { triangles: 6, lods: 3 });
    Object.assign(profile.tiers.low, { triangles: 2, lods: 3 });
    mkdirSync(join(world, "assets/source/model-fixture"), { recursive: true });
    mkdirSync(join(world, "assets/manifests/model-fixture"), { recursive: true });
    mkdirSync(join(world, "reference"));
    const path = join(world, "assets/manifests/model-fixture/model.json");
    const save = () => writeFileSync(path, JSON.stringify(manifest));
    const run = () => runAssetsCli(["validate", path, "--world", world]);
    files.forEach((data, index) => writeFileSync(join(world, levels[index]!.path), data));
    writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    save();
    expect(run().status).toBe(0);
    profile.tiers.low.triangles = 1;
    writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    expect(run().stderr).toContain("MODEL_BUDGET_EXCEEDED: low.triangles: 2 exceeds 1 (level 1)");
    profile.tiers.low.triangles = 2;
    writeFileSync(join(world, "reference/model-target.json"), JSON.stringify(profile));
    rmSync(join(world, levels[2]!.path));
    expect(run().stderr).toContain("MODEL_SOURCE_REQUIRED: assets/source/model-fixture/lod-2.glb");
    writeFileSync(join(world, levels[2]!.path), files[1]!);
    expect(run().stderr).toContain("MODEL_HASH_MISMATCH: levels[2].sha256");
    expect(run().stderr).toContain(
      "MODEL_METRIC_MISMATCH: levels[2].triangles: declared 1, actual 2",
    );
    writeFileSync(join(world, levels[2]!.path), files[2]!);
    levels[1]!.triangles = 3;
    save();
    expect(run().stderr).toContain(
      "MODEL_METRIC_MISMATCH: levels[1].triangles: declared 3, actual 2",
    );
    levels[1]!.triangles = 2;
    Object.assign(manifest.review, {
      status: "approved",
      reviewer: "fixture-human",
      reviewedAt: "2026-11-10T00:00:00Z",
    });
    save();
    expect(runAssetsCli(["build", "--world", world]).status).toBe(0);
    expect(readFileSync(join(world, "assets/reviewed/model-fixture.lod-1.glb"))).toEqual(
      Buffer.from(files[1]!),
    );
    expect(readFileSync(join(world, "assets/reviewed/model-fixture.lod-2.glb"))).toEqual(
      Buffer.from(files[2]!),
    );
    const shipped = JSON.parse(readFileSync(join(world, "assets/reviewed/models.json"), "utf8"))[
      "model-fixture"
    ];
    expect(shipped.levels.map((level: { path: string }) => level.path)).toEqual([
      "model-fixture.glb",
      "model-fixture.lod-1.glb",
      "model-fixture.lod-2.glb",
    ]);
    expect(shipped.renditions).toEqual({ low: [1, 2] });
    expect(runAssetsCli(["check", "--world", world]).status).toBe(0);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});
