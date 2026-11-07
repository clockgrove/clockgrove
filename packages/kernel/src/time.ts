import type { SimTimeMs } from "@clockgrove/contracts";

export interface InjectedSimulationTime {
  readonly value: SimTimeMs;
}

export function simulationTimeMs(value: bigint): SimTimeMs {
  if (typeof value !== "bigint") throw new TypeError("simulation time must be a bigint");
  if (value < 0n) throw new RangeError("simulation time must not be negative");
  if (value > (1n << 63n) - 1n)
    throw new RangeError("simulation time must not exceed signed 64-bit milliseconds");
  return value as SimTimeMs;
}

export function injectSimulationTime(value: bigint): InjectedSimulationTime {
  return Object.freeze({ value: simulationTimeMs(value) });
}
