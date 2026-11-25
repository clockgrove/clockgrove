import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAssetManifest,
  decodePackPresentation,
  surfaceDecalRefusal,
} from "@clockgrove/contracts";
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
  assetsRoot = join(REPO_ROOT, "worlds", "fixture", "assets", "manifests"),
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
  if (presentation.surfaces !== undefined) {
    // Surface bindings name the pack's own zones, channels and bands, and fit their decal budget.
    const policyEntry = (manifest.policies as Rec[]).find((entry) => {
      const bytes = pack.resourceBytes[entry.path];
      return (
        bytes !== undefined &&
        (decodeResource(bytes, entry.path) as Rec)?.type === "clockgrove.world-behavior-policy"
      );
    });
    const declared = policyEntry
      ? (decodeResource(pack.resourceBytes[policyEntry.path]!, policyEntry.path) as Rec).policy
          ?.surfaces
      : undefined;
    if (declared === undefined) add("surfaces: the pack's behaviour policy declares no surfaces");
    else {
      const zones = (declared.zones as Rec[]).map((zone) => ({
        zoneId: zone.id as string,
        channels: (zone.channels as Rec[]).map((entry) => entry.channel as string),
        markCapacity: zone.markCapacity as number,
      }));
      const channels = new Map(
        (declared.channels as Rec[]).map((channel) => [
          channel.id as string,
          new Set((channel.bands as Rec[]).map((band) => band.name as string)),
        ]),
      );
      for (const [index, zone] of presentation.surfaces.zones.entries())
        if (!zones.some((item) => item.zoneId === zone.zoneId))
          add(`surfaces.zones[${index}]: ${zone.zoneId} is not a zone of the pack`);
      for (const [index, treatment] of presentation.surfaces.treatments.entries())
        if (!channels.get(treatment.channel)?.has(treatment.band))
          add(
            `surfaces.treatments[${index}]: ${treatment.channel}/${treatment.band} is not a band of the pack`,
          );
      const refusal = surfaceDecalRefusal(presentation.surfaces, zones);
      if (refusal !== undefined)
        add(
          `surfaces.decals.${refusal.tier}: ${refusal.code}: ${refusal.required} marks, budget ${refusal.budget}`,
        );
    }
  }
  throwIfProblems(problems);
}
