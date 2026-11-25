import { readFileSync } from "node:fs";
import {
  decodeSceneMaterialDelivery,
  decodeScenePatch,
  SceneCompatibilityError,
  type SceneMaterialDelivery,
} from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  applyScenePatch,
  MATERIAL_DELIVERY_BUDGET,
  materialPageCost,
  selectMaterialRendition,
} from "../src/world-scene-adapter.js";
import { snapshot } from "./convergence-fixture.js";
import { Headless3DAdapter } from "./headless-3d-adapter.js";

it("delivers every channel to an adapter while an albedo-only client selects density within budgets", () => {
  const declared = JSON.parse(
    readFileSync(new URL("../scene-budgets.json", import.meta.url), "utf8"),
  ).budgets;
  expect(MATERIAL_DELIVERY_BUDGET).toEqual({
    transferBytes: declared.assetBytes.limit,
    textureBytes: declared.atlasTextureBytes.limit,
  });
  const texture = (density: number, channel: number) => ({
    image: {
      sha256: String(channel).repeat(64),
      width: 8 * density,
      height: 8 * density,
      bytes: 100 * density,
    },
    compressed: { sha256: "a".repeat(64), format: "ktx2-uastc", bytes: 80 * density },
    frames: [{ atlasId: "atlas", x: 0, y: 0, width: 8 * density, height: 8 * density }],
  });
  const material = decodeSceneMaterialDelivery({
    materialVersion: 2,
    renditions: [1, 2, 4].map((density) => ({
      density,
      channels: Object.fromEntries(
        [
          "albedo",
          "normal",
          "height",
          "emissive",
          "roughness",
          "wetness",
          "wind",
          "flow",
          "ao",
          "translucency",
        ].map((channel, i) => [channel, texture(density, i)]),
      ),
    })),
  });
  const budget = { transferBytes: 1000, textureBytes: 4096 };
  expect(selectMaterialRendition(material, 1, budget)?.density).toBe(1);
  expect(selectMaterialRendition(material, 1.5, budget)?.density).toBe(2);
  expect(selectMaterialRendition(material, 4, { ...budget, textureBytes: 1024 })?.density).toBe(2);
  expect(selectMaterialRendition(material, 2, { ...budget, transferBytes: 150 })?.density).toBe(1);
  expect(
    selectMaterialRendition(material, 2, { transferBytes: 0, textureBytes: 0 }),
  ).toBeUndefined();
  // A device that samples a compressed format fetches the KTX2 file and uploads 16 bytes per 4×4
  // block (1 B/texel), so the same budget admits 4× where RGBA8 PNG pages stop at 2×.
  expect(
    materialPageCost({ image: { width: 10, height: 6, bytes: 7 }, compressed: { bytes: 5 } }, true),
  ).toEqual({
    transferBytes: 5,
    textureBytes: 96,
  });
  expect(
    materialPageCost(
      { image: { width: 10, height: 6, bytes: 7 }, compressed: { bytes: 5 } },
      false,
    ),
  ).toEqual({
    transferBytes: 7,
    textureBytes: 240,
  });
  expect(
    selectMaterialRendition(material, 4, { ...budget, textureBytes: 1024 }, ["albedo"], true)
      ?.density,
  ).toBe(4);
  expect(
    selectMaterialRendition(
      material,
      4,
      { transferBytes: 319, textureBytes: 1024 },
      ["albedo"],
      true,
    )?.density,
  ).toBe(2);
  expect(
    selectMaterialRendition(material, 2, { ...budget, textureBytes: 1024 }, ["albedo", "normal"])
      ?.density,
  ).toBe(1);
  const projection = {
    ...snapshot.payload,
    presentationBindings: snapshot.payload.presentationBindings.map((binding) => ({
      ...binding,
      material,
    })),
  };
  const adapter = new Headless3DAdapter();
  adapter.loadSnapshot(projection);
  adapter.setReducedMotion(true);
  expect(adapter.bindings[0]?.material).toEqual(material);
  expect(adapter.nodes.get(projection.entities[0]!.objectId)?.material?.delivery).toEqual(material);
  expect(adapter.scene?.entities[0]?.presentation).toEqual(
    snapshot.payload.entities[0]?.presentation,
  );
  expect(adapter.reducedMotion).toBe(true);
  const lighting = {
    directional: [
      { kind: "sun" as const, direction: [0, 0, -1] as const, colour: "#fff1d6", intensity: 1 },
    ],
    placed: [],
    weatherIntensity: 0.6,
    gradingKey: "overcast",
  };
  const patch = decodeScenePatch({
    fromRevision: projection.revision,
    toRevision: projection.revision + 1n,
    sourceEventIds: [],
    audienceHash: projection.audienceHash,
    operations: [{ op: "set_lighting", lighting }],
  });
  const lit = applyScenePatch(projection, patch);
  expect(lit.lighting).toEqual(lighting);
  const clear = decodeScenePatch({
    fromRevision: lit.revision,
    toRevision: lit.revision + 1n,
    sourceEventIds: [],
    audienceHash: lit.audienceHash,
    operations: [{ op: "set_lighting", lighting: null }],
  });
  expect(applyScenePatch(lit, clear)).not.toHaveProperty("lighting");
  expect(() =>
    decodeSceneMaterialDelivery({ ...material, renditions: [material.renditions[0]] }),
  ).toThrow("expected sorted unique densities 1, 2 and optional 4");
  // A version-1 (BC3 DDS) delivery gets the stable compatibility code, not a field error.
  let legacy: unknown;
  try {
    decodeSceneMaterialDelivery({ ...material, materialVersion: 1 });
  } catch (error) {
    legacy = error;
  }
  expect(legacy).toBeInstanceOf(SceneCompatibilityError);
  expect((legacy as SceneCompatibilityError).code).toBe("unsupported_material_version");
  const invalid: SceneMaterialDelivery = {
    ...material,
    renditions: material.renditions.map((r) => ({
      ...r,
      channels: {
        ...r.channels,
        albedo: { ...r.channels.albedo, frames: [{ x: 1, y: 0, width: 999, height: 8 }] },
      },
    })),
  };
  expect(() => decodeSceneMaterialDelivery(invalid)).toThrow("frame exceeds texture bounds");
});

// Issue 267: a scratch reaches an open scene as `set_surfaces`; the adapter replaces the surfaces
// whole, drops a zone whose host object left the scene and stops naming a marker that left it.
it("applies set_surfaces patches and keeps surfaces to the projected scene", () => {
  const tiers = {
    low: { tint: "#c9a27a", opacity: 0.35, marks: false },
    medium: { tint: "#c9a27a", opacity: 0.45, marks: true },
    high: { tint: "#c9a27a", opacity: 0.5, marks: true },
  };
  const mark = { actorId: "keeper", at: 5n, intensity: 10000, point: { u: 3000, v: 7000 } };
  const zone = {
    channels: [{ channel: "wear", value: 300, max: 1000, bands: ["scratched"] }],
    treatments: [{ channel: "wear", band: "scratched", tiers }],
    marks: [mark],
  };
  const surfaces = {
    decals: { low: 0, medium: 12, high: 24 },
    zones: [
      {
        ...zone,
        zoneId: "coat",
        label: "The keeper's coat",
        host: { kind: "object", objectId: "keeper" },
        sentence: "The keeper's coat is scratched; most recently by Keeper.",
      },
      {
        ...zone,
        zoneId: "floor",
        label: "The hall floor",
        host: {
          kind: "region",
          regionId: "hall",
          frameId: "hall-frame",
          frameVersion: 1,
          min: ["0", "0"],
          max: ["100", "100"],
        },
        sentence: "The hall floor is scratched; most recently by Keeper.",
      },
    ],
  };
  const projection = snapshot.payload;
  const step = (from: typeof projection, operations: unknown[]) =>
    applyScenePatch(
      from,
      decodeScenePatch({
        fromRevision: from.revision,
        toRevision: from.revision + 1n,
        sourceEventIds: [],
        audienceHash: from.audienceHash,
        operations: operations.map((operation) =>
          JSON.parse(
            JSON.stringify(operation, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ),
        ),
      }),
    );
  const scratched = step(projection, [{ op: "set_surfaces", surfaces }]);
  expect(scratched.surfaces).toEqual(surfaces);
  // The keeper leaves: its coat's zone goes with it, and the floor's mark no longer names it.
  const left = step(scratched, [
    { op: "remove_entity", objectId: "keeper" },
    ...projection.presentationBindings.map((binding) => ({
      op: "remove_presentation",
      objectId: binding.objectId,
    })),
    ...projection.interactions.map((interaction) => ({
      op: "remove_interaction",
      objectId: interaction.entityId,
    })),
  ]);
  expect(left.surfaces?.zones.map((item) => item.zoneId)).toEqual(["floor"]);
  expect(left.surfaces?.zones[0]?.marks).toEqual([{ ...mark, actorId: null }]);
  expect(step(scratched, [{ op: "set_surfaces", surfaces: null }])).not.toHaveProperty("surfaces");
});
