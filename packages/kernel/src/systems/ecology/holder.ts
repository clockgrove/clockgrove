import type { SimTimeMs } from "@clockgrove/contracts";
import type {
  ContinuousState,
  ContinuousSystem,
  ContinuousThreshold,
} from "../../scheduler/catch-up.js";

const MAX_TIME = (1n << 63n) - 1n;

export const ECOLOGY_SYSTEM_VERSION = 1;
export const SPOILAGE_SYSTEM_KIND_PREFIX = "ecology.spoilage:";
export const APPEARANCE_SYSTEM_KIND_PREFIX = "ecology.appearance:";
export const GROWTH_SYSTEM_KIND_PREFIX = "ecology.growth:";
export const SPOILAGE_THRESHOLD = "spoil";
export const APPEARANCE_THRESHOLD = "appear";

export function spoilageSystemKind(objectId: string): string {
  return `${SPOILAGE_SYSTEM_KIND_PREFIX}${objectId}`;
}
export function appearanceSystemKind(objectId: string): string {
  return `${APPEARANCE_SYSTEM_KIND_PREFIX}${objectId}`;
}

/**
 * Everything a holder's own timeline depends on besides its state: an object that is a source
 * appears on the source schedule, and an object that is a perishable holder spoils after its shelf
 * life. An object can be both, so the spoilage and appearance systems of one object carry the same
 * configuration and the same pure timeline.
 */
export interface HolderConfig {
  readonly objectId: string;
  readonly shelfLifeMs?: bigint;
  readonly source?: Readonly<{ firstAtMs: bigint; periodMs: bigint; quantity: number }>;
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

/** The first due time at or after `time` (due times are `firstAtMs + k × periodMs`). */
function dueAtOrAfter(source: NonNullable<HolderConfig["source"]>, time: bigint): bigint {
  if (time <= source.firstAtMs) return source.firstAtMs;
  const periods = (time - source.firstAtMs + source.periodMs - 1n) / source.periodMs;
  return source.firstAtMs + periods * source.periodMs;
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

/**
 * The next appearance that lands, given the holder state after every event at or before `after`.
 * An appearance into a holder that still holds food is skipped, so the first landing one is the
 * first due time at or after the spoilage of that food.
 */
function appearTime(
  config: HolderConfig,
  quantity: number,
  arrival: bigint,
  active: number,
  after: bigint,
): bigint | null {
  const source = config.source;
  if (source === undefined || active === 0) return null;
  if (quantity > 0) {
    const spoils = spoilTime(config, quantity, arrival, active);
    if (spoils === null) return null;
    return dueAtOrAfter(source, spoils > after + 1n ? spoils : after + 1n);
  }
  return dueAtOrAfter(source, after + 1n);
}

/** State at `to`: every spoilage and landing appearance in `(from, to]` applied, spoilage first. */
export function advanceHolder(
  config: HolderConfig,
  state: ContinuousState,
  from: SimTimeMs,
  to: SimTimeMs,
): ContinuousState {
  let quantity = numberOf(state, "quantity");
  let arrival = bigOf(state, "arrival");
  const active = numberOf(state, "active");
  let now: bigint = from;
  const arrive = (time: bigint): void => {
    quantity = config.source!.quantity;
    arrival = config.shelfLifeMs === undefined ? -1n : time;
  };
  for (;;) {
    const spoils = spoilTime(config, quantity, arrival, active);
    const appears = appearTime(config, quantity, arrival, active, now);
    if (spoils !== null && spoils <= to && (appears === null || spoils <= appears)) {
      quantity = 0;
      arrival = -1n;
      now = spoils;
      if (appears === spoils) arrive(spoils);
    } else if (appears !== null && appears <= to) {
      arrive(appears);
      now = appears;
    } else break;
  }
  return holderSystemState(quantity, arrival < 0n ? null : arrival, active === 1);
}

function capped(time: bigint, name: string): ContinuousThreshold | null {
  return time > MAX_TIME ? null : { name, time: time as SimTimeMs };
}

/** One spoilage system per perishable holder: its threshold is arrival time plus shelf life. */
export function createSpoilageSystem(config: HolderConfig): ContinuousSystem {
  if (config.shelfLifeMs === undefined) throw new TypeError("spoilage requires a shelf life");
  const shelfLifeMs = config.shelfLifeMs;
  const system: ContinuousSystem = {
    kind: spoilageSystemKind(config.objectId),
    version: ECOLOGY_SYSTEM_VERSION,
    integrate: (state, from, to) => advanceHolder(config, state, from, to),
    nextThreshold: (state, at) => {
      const quantity = numberOf(state, "quantity");
      const arrival = bigOf(state, "arrival");
      const active = numberOf(state, "active");
      const spoils = spoilTime(config, quantity, arrival, active);
      if (spoils !== null) return capped(spoils, SPOILAGE_THRESHOLD);
      // An empty holder spoils only the food its source will bring.
      if (quantity > 0 || config.source === undefined || active === 0) return null;
      return capped(dueAtOrAfter(config.source, at + 1n) + shelfLifeMs, SPOILAGE_THRESHOLD);
    },
  };
  return Object.freeze(system);
}

/** One appearance system per source: its threshold is the next appearance that lands. */
export function createAppearanceSystem(config: HolderConfig): ContinuousSystem {
  if (config.source === undefined) throw new TypeError("appearance requires a source");
  const system: ContinuousSystem = {
    kind: appearanceSystemKind(config.objectId),
    version: ECOLOGY_SYSTEM_VERSION,
    integrate: (state, from, to) => advanceHolder(config, state, from, to),
    nextThreshold: (state, at) => {
      const time = appearTime(
        config,
        numberOf(state, "quantity"),
        bigOf(state, "arrival"),
        numberOf(state, "active"),
        at,
      );
      return time === null ? null : capped(time, APPEARANCE_THRESHOLD);
    },
  };
  return Object.freeze(system);
}
