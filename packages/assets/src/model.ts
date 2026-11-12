import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ModelAssetManifest, ModelTargetProfile } from "@clockgrove/contracts";
import { sha256Hex } from "./validate.js";

export interface ModelFacts {
  triangles: number;
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
  const metrics = ["triangles", "textureMaxPx", "materials", "bones", "lods"] as const;
  for (const metric of metrics) {
    if (facts[metric] !== manifest.output[metric])
      fail(
        "MODEL_METRIC_MISMATCH",
        `${metric}: declared ${manifest.output[metric]}, actual ${facts[metric]}`,
      );
    for (const [tier, limits] of [
      ["default", profile.limits],
      ...Object.entries(profile.tiers ?? {}),
    ] as const)
      if (facts[metric] > limits[metric])
        fail(
          "MODEL_BUDGET_EXCEEDED",
          `${tier}.${metric}: ${facts[metric]} exceeds ${limits[metric]}`,
        );
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
