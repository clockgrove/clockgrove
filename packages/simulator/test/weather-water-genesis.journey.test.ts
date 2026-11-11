import { buildWorldPack } from "@clockgrove/world-pack-sdk";
import { expect, it } from "vitest";
import { createSimulatorPackPorts, seedGenesis } from "../src/index.js";
import { type Json, sha256Hex } from "./fixtures/lamp-hall.js";
import { buildSectionHallSource } from "./fixtures/section-hall.js";

it("seeds an SDK-built weather collector with its initial inventory and epoch", async () => {
  const source = await buildSectionHallSource({
    edit: ({ docs }) => {
      const ecology = (docs["policies/behavior.json"] as Json).policy.ecology;
      ecology.waterHolders = [
        { objectId: "sec.pond", capacity: 10, catchment: 3600, evaporationPerHour: 1 },
      ];
    },
  });
  const ports = { sha256: sha256Hex };
  const built = await buildWorldPack(source, createSimulatorPackPorts(ports));
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const seeded = await seedGenesis({ source, artifact: built.value.artifact }, ports);
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const state = seeded.value.bundle.state;
  expect(state.simulationTime).toBe(100000n);
  expect(state.ecology?.waterHolders).toEqual([
    {
      objectId: "sec.pond",
      collectionRemainder: 0n,
      evaporationRemainder: 0n,
      integratedAt: 100000n,
    },
  ]);
  expect(state.entities.find((entity) => entity.objectId === "sec.pond")?.resource).toEqual({
    kind: "water",
    quantity: 5,
  });
});
