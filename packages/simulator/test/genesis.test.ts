import { buildWorldPack } from "@clockgrove/world-pack-sdk";
import { describe, expect, it } from "vitest";
import { createSimulatorPackPorts, seedGenesis } from "../src/index.js";
import {
  buildLampYardSource,
  type FixtureOptions,
  type FixtureSource,
  type Json,
  reorderSource,
  sha256Hex,
} from "./fixtures/lamp-yard.js";
import { buildSectionYardSource, type SectionYardOptions } from "./fixtures/section-yard.js";

// Pack conformance seeds and verifies every committed pack. This file keeps what no committed pack
// reaches: seeding a reordered source byte-identically and the published seedGenesis refusal codes.

const ports = { sha256: sha256Hex };

async function prepared(source: FixtureSource) {
  const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
  if (!built.ok) throw new Error(`fixture build failed: ${JSON.stringify(built.error)}`);
  return { source, artifact: built.value.artifact };
}

async function refusal(input: unknown) {
  const result = await seedGenesis(input, ports);
  if (result.ok) throw new Error("expected a refusal");
  return { code: result.error.code, path: result.error.path };
}

const lamp = async (options: FixtureOptions) =>
  refusal(await prepared(await buildLampYardSource(options)));
const section = async (edit: NonNullable<SectionYardOptions["edit"]>) =>
  refusal(await prepared(await buildSectionYardSource({ edit })));
const firstSeed = (docs: Record<string, unknown>): Json => docs["cognition/first.json"] as Json;

describe("seedGenesis", () => {
  it("seeds a reordered source (manifest lists, cognitive seeds, resources) into identical bytes", async () => {
    const { source, artifact } = await prepared(await buildSectionYardSource());
    const original = await seedGenesis({ artifact, source }, ports);
    const reordered = await seedGenesis(
      { artifact, source: reorderSource(await buildSectionYardSource()) },
      ports,
    );
    if (!original.ok || !reordered.ok) throw new Error("seeding refused");
    expect(Array.from(reordered.value.bytes)).toEqual(Array.from(original.value.bytes));
  });

  it("refuses with the published codes and paths", async () => {
    const { source, artifact } = await prepared(await buildLampYardSource());
    expect(await refusal(null)).toEqual({ code: "MALFORMED_INPUT", path: "input" });
    expect(await refusal({ artifact, source, extra: 1 })).toEqual({
      code: "UNKNOWN_FIELD",
      path: "input.extra",
    });
    expect(
      await refusal({ artifact: { ...artifact, engineCompatibility: ">=2.0.0 <3.0.0" }, source }),
    ).toEqual({
      code: "ENGINE_INCOMPATIBLE",
      path: "artifact.engineCompatibility",
    });
    expect(
      await lamp({
        edit: ({ manifest }) =>
          manifest.seedCommands.push({
            key: "lamp.crate",
            type: "object.create",
            version: 1,
            payload: {
              schemaVersion: 1,
              object: {
                objectId: "lamp.crate",
                archetypeId: "missing.archetype@1",
                spatial: {
                  spaceId: "lamp.yard",
                  pose: { frameId: "frame-ground", frameVersion: 1, coordinates: [0n, 0n] },
                },
                containment: { kind: "object", capacity: 2 },
              },
            },
          }),
      }),
    ).toEqual({ code: "SEED_COMMAND_REFUSED", path: "manifest.seedCommands[2]" });
    expect(
      await lamp({
        edit: ({ docs, manifest }) => {
          delete docs["policies/behavior.json"];
          manifest.policies = manifest.policies.filter(
            (entry: { id: string }) => entry.id !== "lamp.behavior",
          );
        },
      }),
    ).toEqual({ code: "MISSING_BEHAVIOR_POLICY", path: "manifest.policies" });
    expect(
      await section(({ docs }) => delete (docs["actors/child.json"] as Json).lifecycle),
    ).toEqual({
      code: "INVALID_INITIAL_STATE",
      path: "manifest.actors[1]#lifecycle",
    });
    expect(
      await section(({ docs }) => delete (docs["policies/behavior.json"] as Json).policy.utility),
    ).toEqual({
      code: "INVALID_COGNITIVE_SEED",
      path: "manifest.cognitiveSeeds[0]",
    });
    expect(await section(({ docs }) => (firstSeed(docs).entries[0].value = 10001))).toEqual({
      code: "INVALID_COGNITIVE_SEED",
      path: "manifest.cognitiveSeeds[0]#state.scriptedCognition.entries[0].value",
    });
    expect(
      await section(
        ({ docs }) => ((docs["cognition/second.json"] as Json).entries[0].ref = "scripted:b"),
      ),
    ).toEqual({ code: "INVALID_COGNITIVE_SEED", path: "manifest.cognitiveSeeds[1]#entries[0]" });
  });

  it("refuses a function value in a seed payload without executing it", async () => {
    const { source, artifact } = await prepared(await buildLampYardSource());
    let called = false;
    const hostile = structuredClone(source.manifest);
    hostile.seedCommands[0].payload.hook = () => {
      called = true;
    };
    expect(await refusal({ artifact, source: { ...source, manifest: hostile } })).toEqual({
      code: "INVALID_SEED_COMMAND",
      path: expect.any(String),
    });
    expect(called).toBe(false);
  });
});
