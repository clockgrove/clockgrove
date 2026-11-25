import { decodeScenePatch, type SceneSurfaces } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import { surfaceSentences } from "../src/world-scene-adapter.js";
import { snapshot } from "./convergence-fixture.js";
import { Headless3DAdapter } from "./headless-3d-adapter.js";

// Issue 267: the look is derived from the projection, tier and scope seed, never stored.
it("derives the same surface look for a snapshot, a replay and a set_surfaces patch", () => {
  const scratched = (low: number) => ({
    channel: "wear",
    band: "scratched",
    tiers: {
      low: { tint: "#c9a27a", opacity: low, marks: false },
      medium: { tint: "#c9a27a", opacity: 0.45, marks: true },
      high: { tint: "#c9a27a", opacity: 0.5, marks: true },
    },
  });
  const dusty = {
    channel: "dust",
    band: "dusty",
    tiers: {
      low: { tint: "#aaaaaa", opacity: 0, marks: false },
      medium: { tint: "#aaaaaa", opacity: 0.1, marks: false },
      high: { tint: "#aaaaaa", opacity: 0.2, marks: false },
    },
  };
  const zone = { label: "Zone", channels: [], sentence: null };
  const surfaces = {
    decals: { low: 0, medium: 1, high: 2 },
    zones: [
      {
        ...zone,
        zoneId: "floor",
        host: {
          kind: "region",
          regionId: "hall",
          frameId: "hall-frame",
          frameVersion: 1,
          min: ["0", "0"],
          max: ["100", "100"],
        },
        treatments: [scratched(0.35), dusty],
        marks: [
          { actorId: null, at: 1n, intensity: 10000, point: { u: 3000, v: 7000 } },
          { actorId: null, at: 2n, intensity: 5000, point: { u: 0, v: 10000 } },
        ],
        sentence: "The hall floor is scratched.",
      },
      {
        ...zone,
        zoneId: "coat",
        host: { kind: "object", objectId: "keeper" },
        treatments: [scratched(0.35)],
        marks: [{ actorId: "keeper", at: 3n, intensity: 2500, point: { u: 5000, v: 5000 } }],
      },
    ],
  } as unknown as SceneSurfaces;
  const base = snapshot.payload;
  const withSurfaces = new Headless3DAdapter();
  withSurfaces.loadSnapshot({ ...base, surfaces });
  const high = withSurfaces.surfaceLook;
  expect(high?.budget).toBe(2);
  expect(high?.withheld).toBe(1);
  expect(high?.zones.map((z) => [z.zoneId, z.layers.length, z.decals.length])).toEqual([
    ["floor", 2, 2],
    ["coat", 1, 0],
  ]);
  expect(high?.zones[0]?.layers).toEqual([
    { channel: "wear", band: "scratched", tint: "#c9a27a", opacity: 0.5 },
    { channel: "dust", band: "dusty", tint: "#aaaaaa", opacity: 0.2 },
  ]);
  // Newest mark first, so the second mark leads; the dust treatment draws no marks, so the tint is wear's.
  const [newest, oldest] = high?.zones[0]?.decals ?? [];
  expect([newest?.at, newest?.u, newest?.v, newest?.tint]).toEqual([2n, 0, 1, "#c9a27a"]);
  expect(newest?.length).toBeCloseTo(0.08, 12);
  expect(newest?.opacity).toBeCloseTo(0.675, 12);
  expect([oldest?.at, oldest?.u, oldest?.v, oldest?.length, oldest?.opacity]).toEqual([
    1n,
    0.3,
    0.7,
    0.12,
    1,
  ]);
  for (const decal of [newest, oldest])
    expect(decal?.angle).toSatisfy((a: number) => a >= 0 && a < Math.PI);

  withSurfaces.tier = "medium";
  expect(withSurfaces.surfaceLook?.withheld).toBe(2);
  expect(withSurfaces.surfaceLook?.zones[0]?.decals.map((d) => d.at)).toEqual([2n]);
  withSurfaces.tier = "low";
  expect(withSurfaces.surfaceLook?.withheld).toBe(0);
  expect(withSurfaces.surfaceLook?.zones.map((z) => z.layers.map((l) => l.opacity))).toEqual([
    [0.35],
    [0.35],
  ]);
  expect(withSurfaces.surfaceLook?.zones.flatMap((z) => z.decals)).toEqual([]);

  const replay = new Headless3DAdapter();
  replay.loadSnapshot({ ...base, surfaces });
  expect(replay.surfaceLook).toEqual(high);

  const patched = new Headless3DAdapter();
  patched.loadSnapshot(base);
  expect(patched.surfaceLook).toBeUndefined();
  patched.applyPatch(
    decodeScenePatch({
      fromRevision: base.revision,
      toRevision: base.revision + 1n,
      sourceEventIds: [],
      audienceHash: base.audienceHash,
      operations: [
        {
          op: "set_surfaces",
          surfaces: JSON.parse(
            JSON.stringify(surfaces, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ),
        },
      ],
    }),
  );
  expect(patched.surfaceLook).toEqual(high);
  expect(surfaceSentences(surfaces)).toEqual([
    { zoneId: "floor", sentence: "The hall floor is scratched." },
  ]);
});
