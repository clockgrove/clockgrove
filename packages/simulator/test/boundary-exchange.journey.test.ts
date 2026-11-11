import { join } from "node:path";
import { buildWorldPack, decodeResource, encodeResource } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import {
  createSimulatorPackPorts,
  previewSeedProjection,
  runScenario,
  seedGenesis,
} from "../src/index.js";
import { loadPack, REPO_ROOT } from "./conformance/pack-source.js";
import { type Json, sha256Hex } from "./fixtures/lamp-hall.js";

it("builds an explicit finite boundary in the committed fixture world and imports through the keeper's ordinary command", async () => {
  const source = structuredClone(
    (await loadPack(join(REPO_ROOT, "worlds/fixture/reference"))).source,
  );
  const edit = async (field: string, path: string, change: (document: Json) => void) => {
    const document = decodeResource(source.resources[path]!, path) as Json;
    change(document);
    const bytes = encodeResource(document);
    source.resources[path] = bytes;
    source.manifest[field].find((entry: Json) => entry.path === path).sha256 =
      await sha256Hex(bytes);
  };
  await edit("policies", "policies/behavior.json", (document) => {
    document.policy.boundaryExchanges = [
      {
        id: "neighbour-bins",
        name: "Neighbour's bins down the street",
        kind: "food",
        supply: 3,
        absorb: 0,
        actorIds: ["fixture.keeper"],
      },
    ];
  });
  await edit("archetypes", "archetypes/resident.json", (document) => {
    document.components["clockgrove.resource"] = {
      type: "clockgrove.resource",
      version: 1,
      state: { kind: "food", quantity: 0 },
    };
  });
  source.manifest.capabilities.push({
    id: "fixture.excursion",
    version: 1,
    kind: "influence",
    commands: [{ type: "boundary.exchange", version: 1 }],
  });
  await edit("actors", "actors/keeper.json", (document) => {
    document.capabilities.push({ id: "fixture.excursion", version: 1 });
  });
  const ports = { sha256: sha256Hex };
  const preview = await previewSeedProjection(source, ports);
  if (!preview.ok) throw new Error(JSON.stringify(preview.error));
  source.manifest.expectedSeedProjectionHash = preview.value.actual;
  const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const seeded = await seedGenesis({ source, artifact: built.value.artifact }, ports);
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(seeded.value.bundle.state.boundaryExchanges).toEqual([
    { boundaryId: "neighbour-bins", supplyRemaining: 3, absorbRemaining: 0 },
  ]);
  const result = await runScenario(
    {
      source,
      artifact: built.value.artifact,
      scenario: {
        kind: "clockgrove.scenario",
        schemaVersion: 1,
        name: "boundary-trip",
        pack: { id: source.manifest.id, version: source.manifest.version },
        steps: [
          {
            kind: "command",
            key: "forage",
            type: "boundary.exchange",
            version: 1,
            via: { actor: "fixture.keeper", capability: "fixture.excursion@1" },
            payload: {
              boundaryId: "neighbour-bins",
              actorId: "fixture.keeper",
              objectId: "fixture.keeper",
              kind: "food",
              direction: "import",
              quantity: 2,
            },
          },
        ],
      },
    },
    ports,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const run = result.value.bundle.runs[0]!;
  expect(
    run.finalState.entities.find((entity) => entity.objectId === "fixture.keeper")!.resource,
  ).toEqual({ kind: "food", quantity: 2 });
  expect(run.finalState.boundaryExchanges).toEqual([
    { boundaryId: "neighbour-bins", supplyRemaining: 1, absorbRemaining: 0 },
  ]);
  if (!Array.isArray(run.events)) throw new Error("full recording required");
  expect(
    run.events
      .filter((event) => event.type === "resource.boundary-exchanged")
      .map((event) => [event.simulationTime, event.attribution.effectiveActorId, event.payload]),
  ).toEqual([
    [
      8640000000n,
      "fixture.keeper",
      {
        boundaryId: "neighbour-bins",
        boundaryName: "Neighbour's bins down the street",
        actorId: "fixture.keeper",
        objectId: "fixture.keeper",
        kind: "food",
        direction: "import",
        quantity: 2,
      },
    ],
  ]);
  await edit("policies", "policies/behavior.json", (document) => {
    delete document.policy.boundaryExchanges[0].supply;
  });
  expect(await buildWorldPack(source, createSimulatorPackPorts(ports))).toMatchObject({
    ok: false,
    error: { code: "INVALID_POLICY" },
  });
});
