import { expect, it } from "vitest";
import { runScenario, seedGenesis } from "../src/index.js";
import { type Json, sha256Hex } from "./fixtures/lamp-hall.js";
import { advance, hall, scenario } from "./scenario/harness.js";

it("seeds declared process cursors on the authored cadence at a nonzero world epoch", async () => {
  const { source, artifact } = await hall({
    edit: ({ docs }) => {
      const policy = (docs["policies/behavior.json"] as Json).policy;
      (docs["archetypes/crate.json"] as Json).components["clockgrove.resource"].state = {
        kind: "water",
        quantity: 0,
      };
      policy.ecology.perishables = [];
      policy.processes = [
        {
          id: "household",
          principalId: "household-principal",
          firstAtMs: 1000n,
          periodMs: 1000n,
          command: {
            type: "resource.transfer",
            payload: {
              schemaVersion: 1,
              fromObjectId: "sec.pond",
              toObjectId: "sec.crate",
              kind: "water",
              quantity: 1,
            },
          },
        },
        {
          id: "visitor",
          principalId: "visitor-principal",
          firstAtMs: 1001n,
          periodMs: 1000n,
          command: {
            type: "resource.transfer",
            payload: {
              schemaVersion: 1,
              fromObjectId: "sec.pond",
              toObjectId: "sec.crate",
              kind: "water",
              quantity: 1,
            },
          },
        },
      ];
    },
  });
  const ports = { sha256: sha256Hex };
  const seeded = await seedGenesis({ source, artifact }, ports);
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(seeded.value.bundle.state.simulationTime).toBe(100000n);
  expect(seeded.value.bundle.state.processes).toEqual([
    { processId: "household", nextAt: 100000n },
    { processId: "visitor", nextAt: 100001n },
  ]);
  const run = await runScenario(
    {
      source,
      artifact,
      scenario: scenario({ steps: [advance("processes", 100001n, "fast-forward")] }),
    },
    ports,
  );
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const events = run.value.bundle.runs[0]!.events;
  if (!Array.isArray(events)) throw new Error("full recording required");
  expect(
    events
      .filter((event) => event.type === "process.command-attempted")
      .map((event) => [
        event.simulationTime,
        (event.payload as Json).processId,
        (event.payload as Json).refusal,
      ]),
  ).toEqual([
    [100000n, "household", null],
    [100001n, "visitor", null],
  ]);
  expect(events.filter((event) => event.type === "resource.transferred")).toHaveLength(2);
});
