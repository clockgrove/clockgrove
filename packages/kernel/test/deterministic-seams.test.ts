import { describe, expect, it } from "vitest";
import { injectSimulationTime, simulationTimeMs } from "../src/index.js";

describe("simulation time", () => {
  it("accepts the full non-negative 63-bit range and rejects values outside it", () => {
    for (const helper of [simulationTimeMs, injectSimulationTime]) {
      expect(() => helper((1n << 63n) - 1n)).not.toThrow();
      expect(() => helper(-1n)).toThrow(RangeError);
      expect(() => helper(1n << 63n)).toThrow(RangeError);
    }
  });

  it("rejects non-bigint values without calling any coercion hook", () => {
    const calls = { toPrimitive: 0, valueOf: 0, toString: 0 };
    const value = {
      [Symbol.toPrimitive]: () => ((calls.toPrimitive += 1), 0n),
      valueOf: () => ((calls.valueOf += 1), 0n),
      toString: () => ((calls.toString += 1), "0"),
    };
    for (const helper of [simulationTimeMs, injectSimulationTime]) {
      for (const bad of [0, "0", Object(0n), value])
        expect(() => helper(bad as bigint)).toThrow(TypeError);
    }
    expect(calls).toStrictEqual({ toPrimitive: 0, valueOf: 0, toString: 0 });
  });
});
