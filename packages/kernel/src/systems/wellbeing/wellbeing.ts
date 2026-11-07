import type { SimTimeMs } from "@clockgrove/contracts";
import {
  deriveEnvironmentState,
  type EnvironmentPolicy,
  type WellbeingPolicy,
  type WorldNeeds,
} from "@clockgrove/domain";
import type {
  ContinuousState,
  ContinuousSystem,
  ContinuousThreshold,
} from "../../scheduler/catch-up.js";
import { EXPOSURE_HORIZON, type NeedsIntegrator } from "../environment/systems.js";

const MAX_TIME = (1n << 63n) - 1n;

export const WELLBEING_SYSTEM_KIND_PREFIX = "wellbeing:";
export const WELLBEING_SYSTEM_VERSION = 1;

/** Labels a wellbeing system reports; several at one time are joined with `+`. */
export const WELLBEING_HUNGER = "need.hunger";
export const WELLBEING_THIRST = "need.thirst";
export const WELLBEING_UNCOMFORTABLE = "comfort.uncomfortable";
export const WELLBEING_COMFORTABLE = "comfort.comfortable";
export const WELLBEING_HEALTH_ENTERED = "health.entered";
export const WELLBEING_HEALTH_LEFT = "health.left";
export const WELLBEING_DEATH = "health.death";

export function wellbeingSystemKind(objectId: string): string {
  return `${WELLBEING_SYSTEM_KIND_PREFIX}${objectId}`;
}

/** The need values one actor's wellbeing system integrates together. */
export interface WellbeingSnapshot {
  readonly hunger: number;
  readonly hungerRemainder: bigint;
  readonly wetness: number;
  readonly wetnessRemainder: bigint;
  readonly thirst: number;
  readonly thirstRemainder: bigint;
  readonly health: number;
  readonly healthRemainder: bigint;
}

export interface WellbeingSystemInit extends WellbeingSnapshot {
  readonly protection: number;
  /** Rain intensity in force from the state's time until `rainUntil`, then the authored segment. */
  readonly rain: number;
  readonly rainUntil: SimTimeMs;
}

export function wellbeingSystemState(init: WellbeingSystemInit): ContinuousState {
  return Object.freeze({
    health: init.health,
    healthRemainder: init.healthRemainder,
    hunger: init.hunger,
    hungerRemainder: init.hungerRemainder,
    protection: init.protection,
    rain: init.rain,
    rainUntil: init.rainUntil,
    thirst: init.thirst,
    thirstRemainder: init.thirstRemainder,
    wetness: init.wetness,
    wetnessRemainder: init.wetnessRemainder,
  });
}

function numberOf(state: ContinuousState, key: string): number {
  const value = state[key];
  if (typeof value !== "number") throw new TypeError("wellbeing state quantity must be a number");
  return value;
}

function bigOf(state: ContinuousState, key: string): bigint {
  const value = state[key];
  if (typeof value !== "bigint") throw new TypeError("wellbeing state quantity must be a bigint");
  return value;
}

export function wellbeingSnapshotOf(state: ContinuousState): WellbeingSnapshot {
  return Object.freeze({
    hunger: numberOf(state, "hunger"),
    hungerRemainder: bigOf(state, "hungerRemainder"),
    wetness: numberOf(state, "wetness"),
    wetnessRemainder: bigOf(state, "wetnessRemainder"),
    thirst: numberOf(state, "thirst"),
    thirstRemainder: bigOf(state, "thirstRemainder"),
    health: numberOf(state, "health"),
    healthRemainder: bigOf(state, "healthRemainder"),
  });
}

function clamp(value: bigint): bigint {
  return value < 0n ? 0n : value > 10000n ? 10000n : value;
}

/** Thirst rises like hunger: floor with remainder, clamped to 10000. */
export function integrateThirst(
  thirst: number,
  remainder: bigint,
  elapsed: bigint,
  perInterval: number,
  interval: bigint,
): { thirst: number; thirstRemainder: bigint } {
  const units = remainder + elapsed * BigInt(perInterval);
  const raw = BigInt(thirst) + units / interval;
  return { thirst: Number(clamp(raw)), thirstRemainder: raw >= 10000n ? 0n : units % interval };
}

/** Health follows wetness's rule: floor division, nonnegative remainder, clamped to 0..10000. */
export function integrateHealth(
  health: number,
  remainder: bigint,
  elapsed: bigint,
  signedPerInterval: bigint,
  interval: bigint,
): { health: number; healthRemainder: bigint } {
  const units = remainder + elapsed * signedPerInterval;
  const delta = units >= 0n ? units / interval : -((-units + interval - 1n) / interval);
  const raw = BigInt(health) + delta;
  return {
    health: Number(clamp(raw)),
    healthRemainder: raw < 0n || raw >= 10000n ? 0n : units - delta * interval,
  };
}

export interface WellbeingSystemConfig {
  readonly objectId: string;
  readonly environment: EnvironmentPolicy;
  readonly wellbeing: WellbeingPolicy;
  readonly decisionIntervalMs: bigint;
  /** The world's single hunger/wetness arithmetic (`integrateNeedsWith`); never re-stated here. */
  readonly integrate: NeedsIntegrator;
  /** Lifecycle (RW-0109): reports `health.death` at the first millisecond health is at or below it. */
  readonly deathHealth?: number;
}

function needsAt(state: ContinuousState, at: SimTimeMs): WorldNeeds {
  return Object.freeze({
    hunger: numberOf(state, "hunger"),
    wetness: numberOf(state, "wetness"),
    integratedAt: at,
    hungerRemainder: bigOf(state, "hungerRemainder"),
    wetnessRemainder: bigOf(state, "wetnessRemainder"),
  });
}

/**
 * Per-actor thirst, comfort and health detector. Hunger and wetness are always read from the
 * injected needs integrator; thirst and health use the same floor-with-remainder rule. Within a
 * piece of constant rain, shelter and comfort every quantity is monotone, so the first millisecond
 * at which a predicate holds is found by bisection over the same functions the integration uses.
 */
export function createWellbeingSystem(config: WellbeingSystemConfig): ContinuousSystem {
  const { environment, wellbeing, decisionIntervalMs: interval, integrate } = config;

  /** Rain in force from `at`: the held override until its boundary, then the authored segment. */
  function settle(state: ContinuousState, at: SimTimeMs): { rain: number; until: SimTimeMs } {
    const until = bigOf(state, "rainUntil") as SimTimeMs;
    if (at < until) return { rain: numberOf(state, "rain"), until };
    const derived = deriveEnvironmentState(environment, at);
    return {
      rain: environment.weatherSegments[derived.segmentIndex]!.rainIntensity,
      until: derived.nextWeatherBoundary,
    };
  }

  interface View {
    readonly state: ContinuousState;
    readonly at: SimTimeMs;
    readonly rain: number;
    readonly protection: number;
    readonly needs: WorldNeeds;
  }

  const hungerAt = (view: View, time: bigint): number =>
    integrate(view.needs, view.protection, view.rain, time as SimTimeMs).hunger;
  const wetnessAt = (view: View, time: bigint): number =>
    integrate(view.needs, view.protection, view.rain, time as SimTimeMs).wetness;
  const thirstAt = (view: View, time: bigint): number =>
    integrateThirst(
      numberOf(view.state, "thirst"),
      bigOf(view.state, "thirstRemainder"),
      time - view.at,
      wellbeing.thirstPerInterval,
      interval,
    ).thirst;
  const hungryAt = (view: View, time: bigint): boolean =>
    hungerAt(view, time) >= wellbeing.urgentHunger;
  const thirstyAt = (view: View, time: bigint): boolean =>
    thirstAt(view, time) >= wellbeing.urgentThirst;
  const wetAt = (view: View, time: bigint): boolean =>
    wetnessAt(view, time) >= environment.discomfortThreshold;
  const comfortableAt = (view: View, time: bigint): boolean =>
    !hungryAt(view, time) && !thirstyAt(view, time) && !wetAt(view, time);
  const healthAt = (view: View, time: bigint, comfortable: boolean): number =>
    integrateHealth(
      numberOf(view.state, "health"),
      bigOf(view.state, "healthRemainder"),
      time - view.at,
      BigInt(comfortable ? wellbeing.healthRecoveryPerInterval : -wellbeing.healthLossPerInterval),
      interval,
    ).health;

  /** First time in `(at, limit]` where `holds` is true, given it is false at `at` and monotone. */
  function first(view: View, holds: (time: bigint) => boolean, limit: bigint): bigint | undefined {
    if (limit <= view.at || !holds(limit)) return undefined;
    let low: bigint = view.at;
    let high: bigint = limit;
    while (high - low > 1n) {
      const middle = low + (high - low) / 2n;
      if (holds(middle)) high = middle;
      else low = middle;
    }
    return high;
  }

  function viewOf(state: ContinuousState, at: SimTimeMs, rain: number): View {
    return {
      state,
      at,
      rain,
      protection: numberOf(state, "protection"),
      needs: needsAt(state, at),
    };
  }

  /** The first millisecond in `(at, limit]` at which the derived comfort differs, if any. */
  function comfortChange(view: View, limit: bigint): bigint | undefined {
    const at = view.at;
    const hungry = hungryAt(view, at);
    const thirsty = thirstyAt(view, at);
    const wet = wetAt(view, at);
    if (!hungry && !thirsty && !wet) {
      const times = [
        first(view, (time) => hungryAt(view, time), limit),
        first(view, (time) => thirstyAt(view, time), limit),
        first(view, (time) => wetAt(view, time), limit),
      ].filter((time): time is bigint => time !== undefined);
      return times.length === 0 ? undefined : times.reduce((a, b) => (b < a ? b : a));
    }
    if (!hungry && !thirsty && wet) {
      const off = first(view, (time) => !wetAt(view, time), limit);
      if (off === undefined) return undefined;
      // Hunger and thirst never fall, so they must still be below urgent where wetness lets go.
      return comfortableAt(view, off) ? off : undefined;
    }
    return undefined;
  }

  function advanceTo(state: ContinuousState, from: SimTimeMs, to: SimTimeMs): ContinuousState {
    let current = state;
    let at = from;
    while (at < to) {
      const { rain, until } = settle(current, at);
      const pieceEnd = to < until ? to : until;
      const view = viewOf(current, at, rain);
      const change = comfortChange(view, pieceEnd);
      const end = (change !== undefined && change < pieceEnd ? change : pieceEnd) as SimTimeMs;
      const next = integrate(view.needs, view.protection, rain, end);
      const elapsed = end - at;
      const thirst = integrateThirst(
        numberOf(current, "thirst"),
        bigOf(current, "thirstRemainder"),
        elapsed,
        wellbeing.thirstPerInterval,
        interval,
      );
      const health = integrateHealth(
        numberOf(current, "health"),
        bigOf(current, "healthRemainder"),
        elapsed,
        BigInt(
          comfortableAt(view, at)
            ? wellbeing.healthRecoveryPerInterval
            : -wellbeing.healthLossPerInterval,
        ),
        interval,
      );
      current = wellbeingSystemState({
        ...next,
        ...thirst,
        ...health,
        protection: view.protection,
        rain,
        rainUntil: until,
      });
      at = end;
    }
    const { rain, until } = settle(current, at);
    return wellbeingSystemState({
      ...wellbeingSnapshotOf(current),
      protection: numberOf(current, "protection"),
      rain,
      rainUntil: until,
    });
  }

  const system: ContinuousSystem = {
    kind: wellbeingSystemKind(config.objectId),
    version: WELLBEING_SYSTEM_VERSION,
    integrate: advanceTo,
    nextThreshold: (state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null => {
      const { rain, until } = settle(state, at);
      const limit = until > MAX_TIME ? MAX_TIME : until;
      if (limit <= at) return null;
      const view = viewOf(state, at, rain);
      const found: { label: string; time: bigint }[] = [];
      const hungry = hungryAt(view, at);
      const thirsty = thirstyAt(view, at);
      if (!hungry) {
        const time = first(view, (t) => hungryAt(view, t), limit);
        if (time !== undefined) found.push({ label: WELLBEING_HUNGER, time });
      }
      if (!thirsty) {
        const time = first(view, (t) => thirstyAt(view, t), limit);
        if (time !== undefined) found.push({ label: WELLBEING_THIRST, time });
      }
      const change = comfortChange(view, limit);
      const comfortable = comfortableAt(view, at);
      if (change !== undefined)
        found.push({
          label: comfortable ? WELLBEING_UNCOMFORTABLE : WELLBEING_COMFORTABLE,
          time: change,
        });
      // Comfort is constant on `[at, change)`, so health up to `change` follows the current rate.
      const healthEnd = change ?? limit;
      const critical = numberOf(state, "health") < wellbeing.criticalHealth;
      const time = first(
        view,
        critical
          ? (t) => healthAt(view, t, comfortable) >= wellbeing.criticalHealth
          : (t) => healthAt(view, t, comfortable) < wellbeing.criticalHealth,
        healthEnd,
      );
      if (time !== undefined)
        found.push({ label: critical ? WELLBEING_HEALTH_LEFT : WELLBEING_HEALTH_ENTERED, time });
      const deathHealth = config.deathHealth;
      if (deathHealth !== undefined && numberOf(state, "health") > deathHealth) {
        const death = first(view, (t) => healthAt(view, t, comfortable) <= deathHealth, healthEnd);
        if (death !== undefined) found.push({ label: WELLBEING_DEATH, time: death });
      }
      if (found.length === 0)
        return until > MAX_TIME ? null : { name: EXPOSURE_HORIZON, time: until };
      const earliest = found.reduce((a, b) => (b.time < a.time ? b : a)).time;
      return {
        name: found
          .filter((entry) => entry.time === earliest)
          .map((entry) => entry.label)
          .join("+"),
        time: earliest as SimTimeMs,
      };
    },
  };
  return Object.freeze(system);
}
