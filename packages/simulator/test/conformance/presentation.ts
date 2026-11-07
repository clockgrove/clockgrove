import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeAssetManifest, decodePackPresentation } from "@clockgrove/contracts";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { CHECKS, type ConformanceProblem, failCheck, throwIfProblems } from "./failure.js";
import { type LoadedPack, REPO_ROOT } from "./pack-source.js";

type Rec = Record<string, any>;

/**
 * The pack's `presentation.json`, when it has one, names this pack and version and binds only its
 * declared actors to decodable asset manifests under `assets/manifests/` whose semantic entity is
 * that actor or, for a shared variant, whose archetype is the actor's archetype. The file is not
 * part of the pack source, so the pack's content and state hashes do not depend on it.
 */
export async function checkPresentationBindings(
  pack: LoadedPack,
  assetsRoot = join(REPO_ROOT, "assets", "manifests"),
): Promise<void> {
  const file = join(pack.directory, "presentation.json");
  if (!existsSync(file)) return;
  const problems: ConformanceProblem[] = [];
  const add = (detail: string) =>
    problems.push({ pack: pack.name, check: CHECKS.presentation, detail });
  let presentation: ReturnType<typeof decodePackPresentation>;
  try {
    presentation = decodePackPresentation(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    return failCheck(pack.name, CHECKS.presentation, String(error));
  }
  const manifest = pack.source.manifest as Rec;
  if (presentation.pack.id !== manifest.id || presentation.pack.version !== manifest.version)
    add(
      `presentation names ${presentation.pack.id}@${presentation.pack.version}, the pack is ${manifest.id}@${manifest.version}`,
    );
  const archetypes = new Map<string, string>();
  for (const actor of manifest.actors as Rec[]) {
    const bytes = pack.resourceBytes[actor.path];
    const resource = bytes === undefined ? undefined : (decodeResource(bytes, actor.path) as Rec);
    archetypes.set(actor.id, resource?.archetype?.id);
  }
  const resolve = async (
    where: string,
    assetId: string,
    family: string,
    objectId: string | null,
  ) => {
    if (objectId !== null && !archetypes.has(objectId))
      add(`${where}: ${objectId} is not an actor of the pack`);
    const path = join(assetsRoot, assetId, `${family}.json`);
    let asset: ReturnType<typeof decodeAssetManifest>;
    try {
      asset = decodeAssetManifest(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      add(`${where}: no decodable manifest ${assetId}/${family}: ${String(error)}`);
      return;
    }
    if (objectId === null || !archetypes.has(objectId)) return;
    const { entity, archetype } = asset.semantic;
    if (entity === null ? archetype !== archetypes.get(objectId) : entity !== objectId)
      add(
        `${where}: manifest ${assetId}/${family} depicts ${entity ?? archetype}, not ${objectId}`,
      );
  };
  for (const [index, binding] of presentation.bindings.entries())
    await resolve(`bindings[${index}]`, binding.assetId, binding.animationFamily, binding.objectId);
  for (const [index, effect] of presentation.effects.entries())
    await resolve(`effects[${index}]`, effect.assetId, effect.animationFamily, effect.objectId);
  throwIfProblems(problems);
}
