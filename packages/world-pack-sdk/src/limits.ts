import { fail } from "./errors.js";
import type { WorldPackPorts } from "./manifest/types.js";

/** Safety bounds on the size of a pack; docs/source-and-compatibility.md gives each reason. */
export interface WorldPackLimits {
  readonly resources: number;
  readonly resourceBytes: number;
  readonly seedCommands: number;
  readonly capabilities: number;
  readonly capabilityCommands: number;
  readonly regions: number;
  readonly anchors: number;
  readonly migrationSteps: number;
}

export const DEFAULT_WORLD_PACK_LIMITS: WorldPackLimits = Object.freeze({
  resources: 1024,
  resourceBytes: 1_048_576,
  seedCommands: 1024,
  capabilities: 256,
  capabilityCommands: 64,
  regions: 64,
  anchors: 64,
  migrationSteps: 256,
});

/** The defaults with the composition root's raises applied; a limit may only be raised. */
export function resolveWorldPackLimits(ports: WorldPackPorts): WorldPackLimits {
  const resolved: Record<string, number> = { ...DEFAULT_WORLD_PACK_LIMITS };
  for (const [name, value] of Object.entries(ports.limits ?? {})) {
    const path = `ports.limits.${name}`;
    if (!Object.hasOwn(DEFAULT_WORLD_PACK_LIMITS, name))
      fail("MALFORMED_SOURCE", path, "unknown limit");
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < resolved[name]!)
      fail("MALFORMED_SOURCE", path, `limits may only be raised above ${resolved[name]}`);
    resolved[name] = value;
  }
  return Object.freeze(resolved) as unknown as WorldPackLimits;
}

/**
 * Reads the world owner's raises from their configuration text (the `WORLD_PACK_LIMITS` binding or
 * environment variable): a JSON object of limit names to integers no lower than their defaults.
 * Anything else throws, so a misconfigured deployment fails loudly instead of using the defaults.
 */
export function parseWorldPackLimits(text: string): Partial<WorldPackLimits> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("WORLD_PACK_LIMITS must be a JSON object of limit names to integers");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("WORLD_PACK_LIMITS must be a JSON object of limit names to integers");
  const raises: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const floor = (DEFAULT_WORLD_PACK_LIMITS as unknown as Record<string, number>)[name];
    if (!Object.hasOwn(DEFAULT_WORLD_PACK_LIMITS, name) || floor === undefined)
      throw new Error(`WORLD_PACK_LIMITS names an unknown limit: ${name}`);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < floor)
      throw new Error(`WORLD_PACK_LIMITS.${name} may only raise the limit above ${floor}`);
    raises[name] = value;
  }
  return Object.freeze(raises) as Partial<WorldPackLimits>;
}
