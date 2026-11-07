import { sha256Hex } from "@clockgrove/kernel";
import { createSimulatorPackPorts, type SimulatorPorts } from "../src/index.js";

export const ports: SimulatorPorts = { sha256: (bytes) => Promise.resolve(sha256Hex(bytes)) };

/** The ports artifacts must be built with for seeding to accept them. */
export const packPorts = createSimulatorPackPorts(ports);
