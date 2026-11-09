import { readFileSync } from "node:fs";
import {
  decodeObserverSceneMessage,
  decodeSceneProjection,
  type SceneMaterialDelivery,
} from "@clockgrove/contracts";
import { fixedPoint } from "@clockgrove/domain";
import { expect, it } from "vitest";
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
  const texture = (density: 1 | 2) => ({
    image: { sha256: "a".repeat(64), width: 8 * density, height: 8 * density, bytes: 100 },
    compressed: { sha256: "b".repeat(64), format: "bc3-dds" as const, bytes: 144 },
    frames: [{ atlasId: `atlas-${density}`, x: 0, y: 0, width: 8 * density, height: 8 * density }],
  });
  const material: SceneMaterialDelivery = {
    materialVersion: 1,
    renditions: ([1, 2] as const).map((density) => ({
      density,
      channels: { albedo: texture(density), normal: texture(density), roughness: texture(density) },
    })),
  };
  const inputs = decodeScenePresentations(
    JSON.stringify([
      {
        presentation: {
          presentationVersion: 1,
          assetManifestVersion: 2,
          pack: { id: "generated-world", version: "1.0.0" },
          bindings: [{ ...base.presentationBindings[0], material }],
          effects: [
            { role: "lantern", assetId: "lamp", animationFamily: "static", objectId: "keeper" },
            { role: "window", assetId: "window", animationFamily: "static", objectId: "keeper" },
          ],
        },
        drawable: ["keeper-reviewed/idle"],
        activity: {
          families: [],
          moving: "walk",
          shelter: "shelter",
          arrived: "eat",
          seeking: "sniff",
        },
      },
    ]),
  );
  const projected = new Set(base.entities.map((entity) => entity.objectId));
  const entities = base.entities.map((entity) => ({
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
  const scene = decodeSceneProjection({ ...base, presentationBindings: binding, lighting: night });
  expect(scene.presentationBindings[0]?.material).toEqual(material);
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
