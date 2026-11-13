import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ModelAssetManifest, ModelTargetProfile } from "@clockgrove/contracts";
import { sha256Hex } from "./validate.js";

export interface ModelFacts {
  triangles: number;
  levelTriangles?: readonly number[];
  textureMaxPx: number;
  materials: number;
  bones: number;
  lods: number;
  clips: ModelAssetManifest["output"]["clips"];
  bounds: ModelAssetManifest["output"]["bounds"];
  rig?: ModelAssetManifest["output"]["rig"];
}

/** A separate process keeps the existing synchronous CLI API while the glTF decoders initialize. */
export function inspectModel(bytes: Uint8Array): ModelFacts {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./inspect-model.mjs", import.meta.url))],
    {
      input: bytes,
      encoding: "utf8",
      // Decision: a malformed/offline asset must not hold the synchronous generation hook indefinitely.
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`MODEL_GLB_INVALID: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout) as ModelFacts;
}

export function validateModel(
  manifest: ModelAssetManifest,
  bytes: Uint8Array,
  profile: ModelTargetProfile,
  sources: Readonly<Record<string, Uint8Array>> = {},
): string[] {
  const problems: string[] = [];
  const fail = (code: string, detail: string) =>
    problems.push(`${manifest.assetId}/model: ${code}: ${detail}`);
  if (sha256Hex(bytes) !== manifest.output.sha256)
    fail("MODEL_HASH_MISMATCH", "output.sha256 differs from the GLB bytes");
  let facts: ModelFacts;
  try {
    facts = inspectModel(bytes);
  } catch (error) {
    return [...problems, `${manifest.assetId}/model: ${(error as Error).message}`];
  }
  const declared = manifest.output.levels;
  const fileLevels = declared?.[0]?.path !== undefined;
  const levels: ModelFacts[] = fileLevels
    ? [facts]
    : (facts.levelTriangles ?? [facts.triangles]).map((triangles) => ({ ...facts, triangles }));
  if (fileLevels) {
    if (facts.lods !== 1) fail("MODEL_METRIC_MISMATCH", "levels[0] must be a single-level GLB");
    for (const [index, level] of declared!.entries()) {
      if (index === 0) continue;
      const data = sources[level.path!];
      if (!data) {
        fail("MODEL_SOURCE_REQUIRED", level.path!);
        continue;
      }
      if (sha256Hex(data) !== level.sha256)
        fail("MODEL_HASH_MISMATCH", `levels[${index}].sha256 differs from ${level.path}`);
      try {
        const actual = inspectModel(data);
        if (actual.lods !== 1)
          fail("MODEL_METRIC_MISMATCH", `levels[${index}] must be a single-level GLB`);
        if (manifest.source.kind !== "generated" && actual.clips.some((clip) => clip.generated))
          fail(
            "MODEL_CLIPS_MISMATCH",
            `levels[${index}] generated clips require generated-asset provenance`,
          );
        levels[index] = actual;
      } catch (error) {
        fail("MODEL_GLB_INVALID", `levels[${index}]: ${(error as Error).message}`);
      }
    }
  }
  const actualLods = fileLevels ? declared!.length : facts.lods;
  const metrics = ["triangles", "textureMaxPx", "materials", "bones", "lods"] as const;
  for (const metric of metrics) {
    const actual = metric === "lods" ? actualLods : facts[metric];
    if (actual !== manifest.output[metric])
      fail(
        "MODEL_METRIC_MISMATCH",
        `${metric}: declared ${manifest.output[metric]}, actual ${actual}`,
      );
    if (actual > profile.limits[metric])
      fail(
        "MODEL_BUDGET_EXCEEDED",
        `default.${metric}: ${actual} exceeds ${profile.limits[metric]}`,
      );
  }
  if (declared)
    for (const [index, level] of declared.entries()) {
      if (levels[index] && levels[index]!.triangles !== level.triangles)
        fail(
          "MODEL_METRIC_MISMATCH",
          `levels[${index}].triangles: declared ${level.triangles}, actual ${levels[index]!.triangles}`,
        );
    }
  for (const tier of Object.keys(manifest.output.renditions ?? {}))
    if (!Object.hasOwn(profile.tiers ?? {}, tier))
      fail("MODEL_PROFILE_INVALID", `rendition names unknown tier ${tier}`);
  for (const [tier, limits] of Object.entries(profile.tiers ?? {})) {
    const selections = manifest.output.renditions?.[tier] ?? [0];
    for (const index of selections) {
      if (index >= actualLods) {
        fail("MODEL_METRIC_MISMATCH", `${tier} selects missing level ${index}`);
        continue;
      }
      const actual = levels[index];
      if (!actual) continue;
      for (const metric of metrics) {
        const value = metric === "lods" ? actualLods : actual[metric];
        if (value > limits[metric])
          fail(
            "MODEL_BUDGET_EXCEEDED",
            `${tier}.${metric}: ${value} exceeds ${limits[metric]}${index ? ` (level ${index})` : ""}`,
          );
      }
    }
  }
  if (
    facts.clips.length !== manifest.output.clips.length ||
    manifest.output.clips.some((clip) => {
      const actual = facts.clips.find((c) => c.name === clip.name);
      return (
        !actual ||
        Math.abs(actual.durationMs - clip.durationMs) > 0.001 ||
        actual.loop !== clip.loop ||
        actual.generated !== clip.generated
      );
    })
  )
    fail(
      "MODEL_CLIPS_MISMATCH",
      "clips must match GLB names, durationMs, loop and generated metadata",
    );
  // Decision: one micrometre tolerates float32 transform rounding while preserving metre-scale bounds.
  for (const edge of ["min", "max"] as const)
    if (
      facts.bounds[edge].some(
        (n, i) => Math.abs(n - (manifest.output.bounds[edge][i] as number)) > 1e-6,
      )
    )
      fail("MODEL_BOUNDS_MISMATCH", `${edge} differs from the default-scene bounds in metres`);
  if (
    facts.rig?.template !== manifest.output.rig?.template ||
    facts.rig?.sha256 !== manifest.output.rig?.sha256
  )
    fail("MODEL_RIG_MISMATCH", "rig must match asset.extras.rig identity");
  return problems;
}
