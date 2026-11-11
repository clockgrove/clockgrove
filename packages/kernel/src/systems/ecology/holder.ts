import type { SimTimeMs } from "@clockgrove/contracts";
import type {
  ContinuousState,
  ContinuousSystem,
  ContinuousThreshold,
} from "../../scheduler/catch-up.js";

const MAX_TIME = (1n << 63n) - 1n;

export const ECOLOGY_SYSTEM_VERSION = 1;
export const SPOILAGE_SYSTEM_KIND_PREFIX = "ecology.spoilage:";
export const GROWTH_SYSTEM_KIND_PREFIX = "ecology.growth:";
export const SPOILAGE_THRESHOLD = "spoil";

export function spoilageSystemKind(objectId: string): string {
  return `${SPOILAGE_SYSTEM_KIND_PREFIX}${objectId}`;
}
export interface HolderConfig {
  readonly objectId: string;
  readonly shelfLifeMs?: bigint;
}

/** `arrival` is the time the current food arrived, or -1 when there is none. */
export function holderSystemState(
  quantity: number,
  arrival: bigint | null,
  active: boolean,
): ContinuousState {
  return Object.freeze({
    active: active ? 1 : 0,
    arrival: arrival === null ? -1n : arrival,
    quantity,
  });
}

function numberOf(state: ContinuousState, key: string): number {
  const value = state[key];
  if (typeof value !== "number") throw new TypeError("holder state quantity must be a number");
  return value;
}

function bigOf(state: ContinuousState, key: string): bigint {
  const value = state[key];
  if (typeof value !== "bigint") throw new TypeError("holder state quantity must be a bigint");
  return value;
}

function spoilTime(
  config: HolderConfig,
  quantity: number,
  arrival: bigint,
  active: number,
): bigint | null {
  if (config.shelfLifeMs === undefined || quantity <= 0 || arrival < 0n || active === 0)
    return null;
  return arrival + config.shelfLifeMs;
}

/** Spoilage removes the current batch; waiting never refills an empty holder. */
export function advanceHolder(
  config: HolderConfig,
  state: ContinuousState,
  _from: SimTimeMs,
  to: SimTimeMs,
): ContinuousState {
  const quantity = numberOf(state, "quantity");
  const arrival = bigOf(state, "arrival");
  const active = numberOf(state, "active");
  const spoils = spoilTime(config, quantity, arrival, active);
  return spoils !== null && spoils <= to ? holderSystemState(0, null, active === 1) : state;
}

function capped(time: bigint, name: string): ContinuousThreshold | null {
  return time > MAX_TIME ? null : { name, time: time as SimTimeMs };
}

/** One spoilage system per perishable holder: its threshold is arrival time plus shelf life. */
export function createSpoilageSystem(config: HolderConfig): ContinuousSystem {
  if (config.shelfLifeMs === undefined) throw new TypeError("spoilage requires a shelf life");
  const system: ContinuousSystem = {
    kind: spoilageSystemKind(config.objectId),
    version: ECOLOGY_SYSTEM_VERSION,
    integrate: (state, from, to) => advanceHolder(config, state, from, to),
    nextThreshold: (state) => {
      const quantity = numberOf(state, "quantity");
      const arrival = bigOf(state, "arrival");
      const active = numberOf(state, "active");
      const spoils = spoilTime(config, quantity, arrival, active);
      if (spoils !== null) return capped(spoils, SPOILAGE_THRESHOLD);
      return null;
    },
  };
  return Object.freeze(system);
}
