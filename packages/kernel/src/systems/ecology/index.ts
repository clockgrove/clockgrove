import type { EcologyPlantState, EcologyPolicy, EnvironmentPolicy } from "@clockgrove/domain";
import type { ContinuousSystem } from "../../scheduler/catch-up.js";
import type { NeedsIntegrator } from "../environment/systems.js";
import { createGrowthSystem } from "./growth.js";
import { createSpoilageSystem, type HolderConfig } from "./holder.js";

import { createWaterSystem, type EcologyWaterInit } from "./water.js";

export * from "./growth.js";
export * from "./holder.js";
export * from "./water.js";

/** The dynamic state of one holder object (a perishable holder). */
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
  readonly waterHolders?: readonly EcologyWaterInit[];
}

/** Per-object timeline configuration: each perishable has one spoilage timeline. */
export function holderConfigs(policy: EcologyPolicy): ReadonlyMap<string, HolderConfig> {
  const configs = new Map<string, HolderConfig>();
  for (const holder of policy.perishables)
    configs.set(holder.objectId, {
      ...(configs.get(holder.objectId) ?? { objectId: holder.objectId }),
      shelfLifeMs: holder.shelfLifeMs,
    });
  return configs;
}

/** One spoilage system per perishable holder, one growth system per plant. */
export function createEcologySystems(options: {
  readonly policy: EcologyPolicy;
  readonly environment: EnvironmentPolicy;
  readonly integrate: NeedsIntegrator;
}): readonly ContinuousSystem[] {
  const configs = holderConfigs(options.policy);
  return Object.freeze([
    ...(options.policy.waterHolders ?? []).map((holder) =>
      createWaterSystem(holder, options.environment),
    ),
    ...options.policy.perishables.map((holder) =>
      createSpoilageSystem(configs.get(holder.objectId)!),
    ),
    ...options.policy.plants.map((plant) =>
      createGrowthSystem({ plant, environment: options.environment, integrate: options.integrate }),
    ),
  ]);
}
