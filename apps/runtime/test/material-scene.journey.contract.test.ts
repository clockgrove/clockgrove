import { readFileSync } from "node:fs";
import {
  decodeAssetManifest,
  decodeAssetStyleProfile,
  decodeObserverSceneMessage,
  decodeOpaqueId,
  decodeSceneMaterialDelivery,
  decodeSceneProjection,
} from "@clockgrove/contracts";
import { fixedPoint } from "@clockgrove/domain";
import { expect, it } from "vitest";
import {
  type AssetEntry,
  buildAtlases,
  encodePng,
  packAtlas,
  sha256Hex,
  validateSource,
} from "../../../packages/assets/src/index.js";
import { scenePatchOperations } from "../src/scene-delivery.js";
import {
  decodeScenePresentations,
  materialSceneLighting,
  sceneEffects,
  scenePresentationBindings,
} from "../src/scene-presentation.js";

it("projects generated material bindings, time-of-day lights and weather without changing legacy scenes", () => {
  const envelope = decodeObserverSceneMessage(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/contracts/test/fixtures/realtime-projection/snapshot.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  if (envelope.type !== "snapshot") throw new Error("expected snapshot");
  const base = envelope.payload;
  const template = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/test/fixtures/asset-manifest/approved.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const style = JSON.parse(
    readFileSync(
      new URL("../../../worlds/fixture/reference/asset-style.json", import.meta.url),
      "utf8",
    ),
  );
  const profile = decodeAssetStyleProfile({
    ...style,
    colour: { mode: "unrestricted" },
    material: {
      materialVersion: 1,
      roles: Object.fromEntries(
        ["actor", "object", "terrain", "effect"].map((role) => [
          role,
          Object.fromEntries(
            ["albedo", "normal", "roughness"].map((channel) => [
              channel,
              {
                encoding: channel === "albedo" ? "srgb" : "linear",
                min: 0,
                max: 255,
                maxFrameChange: 0,
              },
            ]),
          ),
        ]),
      ),
    },
  });
  const entries: AssetEntry[] = (["idle", "walk", "static"] as const).map((animationFamily) => {
    const role = animationFamily === "static" ? "object" : "actor";
    const assetId = role === "actor" ? "keeper-reviewed" : "generated-prop";
    const count = role === "actor" ? 3 : 1;
    const materialSources: Record<string, Uint8Array> = {};
    const renditions = ([1, 2] as const).map((density) => ({
      density,
      channels: Object.fromEntries(
        ["albedo", "normal", "roughness"].map((channel) => {
          const width = 4 * count * density,
            height = 4 * density;
          const rgba = new Uint8Array(width * height * 4);
          for (let frame = 0; frame < count; frame++)
            for (let y = density; y < 3 * density; y++)
              for (let x = density; x < 3 * density; x++)
                rgba.set([32, 32, 32, 255], (y * width + frame * 4 * density + x) * 4);
          const path = `assets/source/${assetId}/${animationFamily}${density === 1 && channel === "albedo" ? "" : `-${density}x-${channel}`}.png`;
          const bytes = encodePng({ width, height, rgba });
          materialSources[path] = bytes;
          return [channel, { path, sha256: sha256Hex(bytes) }];
        }),
      ),
    }));
    const source = `assets/source/${assetId}/${animationFamily}.png`;
    const bytes = materialSources[source]!;
    const manifest = decodeAssetManifest({
      ...template,
      assetId,
      animationFamily,
      semantic: { ...template.semantic, role },
      source: { ...template.source, path: source },
      frames: { width: 4, height: 4, count, durationMs: count > 1 ? 100 : null },
      bounds: { x: 1, y: 1, width: 2, height: 2 },
      anchor: { x: 2, y: 3 },
      palette: ["#202020"],
      atlas: { atlasId: "generated-lit", x: 0, y: 0 },
      contentHash: sha256Hex(bytes),
      material: { materialVersion: 1, renditions },
    });
    expect(validateSource(manifest, bytes, undefined, profile, materialSources)).toEqual([]);
    return { manifest, bytes, materialSources };
  });
  const layout = packAtlas(entries.map((entry) => entry.manifest));
  const positioned = entries.map((entry) => ({
    ...entry,
    manifest: {
      ...entry.manifest,
      atlas: {
        ...entry.manifest.atlas,
        x: layout.get(`${entry.manifest.assetId}/${entry.manifest.animationFamily}`)!.x,
        y: layout.get(`${entry.manifest.assetId}/${entry.manifest.animationFamily}`)!.y,
      },
    },
  }));
  const atlases = buildAtlases(positioned, undefined, profile);
  const materials = Object.fromEntries(
    atlases.flatMap((atlas) => {
      const animations = (
        JSON.parse(atlas.animations) as {
          animations: { assetId: string; animationFamily: string; material: unknown }[];
        }
      ).animations;
      return animations.map((animation) => [
        `${animation.assetId}/${animation.animationFamily}`,
        decodeSceneMaterialDelivery(animation.material),
      ]);
    }),
  );
  const material = materials["keeper-reviewed/idle"]!;
  const inputs = decodeScenePresentations(
    JSON.stringify([
      {
        presentation: {
          presentationVersion: 1,
          assetManifestVersion: 2,
          pack: { id: "generated-world", version: "1.0.0" },
          bindings: [
            { ...base.presentationBindings[0], material },
            {
              ...base.presentationBindings[0],
              objectId: "generated-prop",
              assetId: "generated-prop",
              animationFamily: "static",
              material: materials["generated-prop/static"],
            },
          ],
          effects: [
            { role: "lantern", assetId: "lamp", animationFamily: "static", objectId: "keeper" },
            { role: "window", assetId: "window", animationFamily: "static", objectId: "keeper" },
          ],
        },
        materials,
        drawable: Object.keys(materials),
        activity: {
          families: ["idle"],
          moving: "walk",
          shelter: "shelter",
          arrived: "eat",
          seeking: "sniff",
        },
      },
    ]),
  );
  const projectedEntities = [
    ...base.entities,
    { ...base.entities[0]!, objectId: decodeOpaqueId("generated-prop", "ObjectId") },
  ];
  const projected = new Set(projectedEntities.map((entity) => entity.objectId));
  const entities = projectedEntities.map((entity) => ({
    ...entity,
    spaceId: base.spaceId,
    pose: {
      ...entity.pose,
      coordinates: [
        fixedPoint(BigInt(entity.pose.coordinates[0]!)),
        fixedPoint(BigInt(entity.pose.coordinates[1]!)),
      ] as const,
    },
  }));
  const effects = sceneEffects(
    { packId: "generated-world" },
    { entities, anchorGraphs: [] },
    base.frames,
    projected,
    inputs,
  );
  const binding = scenePresentationBindings(
    { packId: "generated-world" },
    entities,
    projected,
    inputs,
  );
  const night = materialSceneLighting(
    { packId: "generated-world" },
    inputs,
    0n,
    { rainIntensity: 6000 },
    effects,
  );
  const scene = decodeSceneProjection({
    ...base,
    entities: projectedEntities,
    presentationBindings: binding,
    lighting: night,
  });
  expect(scene.presentationBindings.map((binding) => binding.material)).toEqual([
    material,
    materials["generated-prop/static"],
  ]);
  const moving = entities.map((entity) =>
    entity.objectId === "keeper"
      ? {
          ...entity,
          movement: {
            movementId: "generated-move",
            status: "active" as const,
            frameId: entity.pose.frameId,
            frameVersion: entity.pose.frameVersion,
            destination: { kind: "pose" as const, pose: entity.pose },
            anchorPath: [],
            segment: {
              waypoints: [entity.pose.coordinates],
              startTime: 0n,
              speed: { kind: "constant-units-per-second" as const, unitsPerSecond: fixedPoint(1n) },
            },
            initialInside: [],
            exitedAtStart: [],
            emitted: [],
          },
        }
      : entity,
  );
  const walking = scenePresentationBindings(
    { packId: "generated-world" },
    moving,
    projected,
    inputs,
  );
  expect(walking[0]?.animationFamily).toBe("walk");
  expect(walking[0]?.material).toEqual(materials["keeper-reviewed/walk"]);

  expect(
    scenePatchOperations({ ...base, revision: scene.revision + 1n }, scene).find(
      (operation) => operation.op === "set_lighting",
    ),
  ).toEqual({ op: "set_lighting", lighting: null });
  expect(scenePatchOperations(scene).find((operation) => operation.op === "set_lighting")).toEqual({
    op: "set_lighting",
    lighting: night,
  });
  expect(scene.lighting).toEqual({
    directional: [
      { kind: "sun", direction: [Math.cos(-Math.PI / 2), 0, 1], colour: "#fff1d6", intensity: 0 },
      {
        kind: "moon",
        direction: [-Math.cos(-Math.PI / 2), -0, -1],
        colour: "#cbdcff",
        intensity: Math.PI * 0.25,
      },
    ],
    placed: ["lantern", "window"].map((kind) => ({
      kind,
      pose: base.entities[0]!.pose,
      colour: "#ffb966",
      intensity: 1500,
      rangeMetres: 14.4,
    })),
    weatherIntensity: 0.6,
    gradingKey: "night",
  });
  const noon = materialSceneLighting(
    { packId: "generated-world" },
    inputs,
    43_200_000n,
    { rainIntensity: 0 },
    effects,
  );
  expect(noon?.directional.map((light) => light.intensity)).toEqual([Math.PI, 0]);
  expect(noon?.placed.map((light) => light.intensity)).toEqual([0, 0]);
  expect(noon?.gradingKey).toBe("day");
  expect(
    materialSceneLighting({ packId: "legacy" }, [], 0n, { rainIntensity: 0 }, []),
  ).toBeUndefined();
});
