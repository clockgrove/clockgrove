import type { EcologyPlantState, EcologyPolicy, EnvironmentPolicy } from "@clockgrove/domain";
import type { ContinuousSystem } from "../../scheduler/catch-up.js";
import type { NeedsIntegrator } from "../environment/systems.js";
import { createGrowthSystem } from "./growth.js";
import { createAppearanceSystem, createSpoilageSystem, type HolderConfig } from "./holder.js";

export * from "./growth.js";
export * from "./holder.js";

/** The dynamic state of one holder object (a perishable holder, a source, or both). */
export interface EcologyHolderInit {
  readonly objectId: string;
  readonly quantity: number;
  readonly arrival: bigint | null;
  readonly active: boolean;
}

/** One plant: its journaled entry plus the shelter protection and lifecycle of its entity. */
export interface EcologyPlantInit {
  readonly entry: EcologyPlantState;
  readonly protection: number;
  readonly active: boolean;
}

export interface EcologyRunOptions {
  readonly policy: EcologyPolicy;
  readonly holders: readonly EcologyHolderInit[];
  readonly plants: readonly EcologyPlantInit[];
}

/** Per-object timeline configuration: a source and a perishable holder may be the same object. */
export function holderConfigs(policy: EcologyPolicy): ReadonlyMap<string, HolderConfig> {
  const configs = new Map<string, HolderConfig>();
  for (const source of policy.sources)
    configs.set(source.objectId, {
      objectId: source.objectId,
      source: {
        firstAtMs: source.firstAtMs,
        periodMs: source.periodMs,
        quantity: source.quantity,
      },
    });
  for (const holder of policy.perishables)
    configs.set(holder.objectId, {
      ...(configs.get(holder.objectId) ?? { objectId: holder.objectId }),
      shelfLifeMs: holder.shelfLifeMs,
    });
  return configs;
}

/** One spoilage system per perishable holder, one appearance system per source, one growth system per plant. */
export function createEcologySystems(options: {
  readonly policy: EcologyPolicy;
  readonly environment: EnvironmentPolicy;
  readonly integrate: NeedsIntegrator;
}): readonly ContinuousSystem[] {
  const configs = holderConfigs(options.policy);
  return Object.freeze([
    ...options.policy.perishables.map((holder) =>
      createSpoilageSystem(configs.get(holder.objectId)!),
    ),
    ...options.policy.sources.map((source) =>
      createAppearanceSystem(configs.get(source.objectId)!),
    ),
    ...options.policy.plants.map((plant) =>
      createGrowthSystem({ plant, environment: options.environment, integrate: options.integrate }),
    ),
  ]);
}
