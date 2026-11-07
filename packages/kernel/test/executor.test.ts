import { describe, expect, it } from "vitest";
import { executeWorldKernel, REFUSAL_CODES } from "../src/index.js";
import { executorEvidence } from "./executor.scenario.js";

describe("kernel executor over the world registry", () => {
  it("never throws for malformed input and exposes no exception text", () => {
    const trap = {
      get input(): never {
        throw new Error("secret /home/host/path");
      },
    };
    const inputs: unknown[] = [
      null,
      "text",
      Symbol("x"),
      trap,
      { input: { kind: "command", command: null } },
      {
        input: {
          kind: "command",
          command: { type: "world.advance", payload: { schemaVersion: 1n } },
        },
      },
    ];
    for (const input of inputs) {
      for (const options of [{ mode: "test" }, null]) {
        const outcome = executeWorldKernel(input as never, options as never);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) continue;
        expect(Object.isFrozen(outcome.error)).toBe(true);
        expect(JSON.stringify(outcome.error)).not.toMatch(/secret|home/);
        expect((REFUSAL_CODES as readonly string[]).includes(outcome.error.code)).toBe(true);
      }
    }
  });

  // The Node half of the long-run differential: the fuzz throws on a refused valid command.
  it("runs the executor goldens and fuzz with current command payloads", async () => {
    expect((await executorEvidence()).fuzz.entries.length).toBeGreaterThan(0);
  });
});
