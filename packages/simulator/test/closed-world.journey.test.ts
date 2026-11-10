import { executeWorldKernel } from "@clockgrove/kernel";
import { expect, it } from "vitest";
import { runScenario } from "../src/index.js";
import { type Json } from "./fixtures/lamp-hall.js";
import { advance, hall, ports, scenario } from "./scenario/harness.js";

it("checks every scenario driver transition for unjournaled per-holder resource creation", async () => {
  const { source, artifact } = await hall({
    edit: ({ docs }) => {
      (docs["archetypes/sprout.json"] as Json).components["clockgrove.resource"] = {
        type: "clockgrove.resource",
        version: 1,
        state: { kind: "water", quantity: 10 },
      };
    },
  });
  const result = await runScenario(
    { source, artifact, scenario: scenario({ steps: [advance("tick", 100001n, "fast-forward")] }) },
    {
      ...ports,
      driver: () => ({
        call: async (input) => {
          const outcome = executeWorldKernel(input);
          if (!outcome.ok) return outcome;
          const state = structuredClone(outcome.result.state);
          const holders = state.entities as unknown as {
            objectId: string;
            resource?: { quantity: number };
          }[];
          for (const holder of holders) {
            if (holder.objectId === "sec.pond") holder.resource!.quantity += 1;
            if (holder.objectId === "sec.sprout") holder.resource!.quantity -= 1;
          }
          return { ...outcome, result: { ...outcome.result, state } };
        },
      }),
    },
  );
  expect(result).toEqual({
    ok: false,
    error: {
      code: "RESOURCE_CAUSE_INVARIANT",
      path: "state.entities[3].resource.quantity",
      message: "resource.quantity-conservation@1",
    },
  });
});
