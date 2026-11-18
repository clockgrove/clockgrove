import { sha256Hex } from "@clockgrove/kernel";
import { parseWorldPackLimits, type WorldPackPorts } from "@clockgrove/world-pack-sdk";
import { createSimulatorPackPorts, type SimulatorPorts } from "../src/index.js";

/**
 * The CLI's ports under an environment: `WORLD_PACK_LIMITS`, when set, is the world owner's raise of
 * the pack size limits, applied alike when a pack is built, validated, seeded and run.
 */
export function cliPorts(environment: Readonly<Record<string, string | undefined>>): {
  readonly ports: SimulatorPorts;
  readonly packPorts: WorldPackPorts;
} {
  const raises = environment.WORLD_PACK_LIMITS;
  const ports: SimulatorPorts = {
    sha256: (bytes) => Promise.resolve(sha256Hex(bytes)),
    ...(raises === undefined ? {} : { packLimits: parseWorldPackLimits(raises) }),
  };
  return { ports, packPorts: createSimulatorPackPorts(ports) };
}

const configured = cliPorts(process.env);

export const ports: SimulatorPorts = configured.ports;

/** The ports artifacts must be built with for seeding to accept them. */
export const packPorts: WorldPackPorts = configured.packPorts;
