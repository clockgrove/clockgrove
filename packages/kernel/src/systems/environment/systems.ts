import type { SimTimeMs } from "@clockgrove/contracts";
import {
  deriveEnvironmentState,
  type EnvironmentPolicy,
  type WorldNeeds,
} from "@clockgrove/domain";
import type {
  ContinuousState,
  ContinuousSystem,
  ContinuousThreshold,
} from "../../scheduler/catch-up.js";

const MAX_TIME = (1n << 63n) - 1n;

/** Name of a waypoint a system reports at its own weather boundary; it is never a material event. */
export const EXPOSURE_HORIZON = "horizon";

/**
 * The needs integrator the exposure system consumes. It is the world's single wetness
 * arithmetic (`integrateNeedsWith` in `world.ts`); the system never re-states the formula.
 */
export type NeedsIntegrator = (
  needs: WorldNeeds,
  protection: number,
  rainIntensity: number,
  through: SimTimeMs,
) => WorldNeeds;

export const PHASE_SYSTEM_KIND = "environment.phase";
export const WEATHER_SYSTEM_KIND = "environment.weather";
export const EXPOSURE_SYSTEM_KIND_PREFIX = "environment.exposure:";
export const ENVIRONMENT_SYSTEM_VERSION = 1;

const NO_STATE: ContinuousState = Object.freeze({});

/** Stateless: the next phase boundary is derived from the policy and the time alone. */
export function createPhaseSystem(policy: EnvironmentPolicy): ContinuousSystem {
  const system: ContinuousSystem = {
    kind: PHASE_SYSTEM_KIND,
    version: ENVIRONMENT_SYSTEM_VERSION,
    integrate: () => NO_STATE,
    nextThreshold: (_state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null => {
      const time = deriveEnvironmentState(policy, at).nextPhaseBoundary;
      return time > MAX_TIME ? null : { name: "phase", time };
    },
  };
  return Object.freeze(system);
}

/** Stateless: the next weather boundary is derived from the policy and the time alone. */
export function createWeatherSystem(policy: EnvironmentPolicy): ContinuousSystem {
  const system: ContinuousSystem = {
    kind: WEATHER_SYSTEM_KIND,
    version: ENVIRONMENT_SYSTEM_VERSION,
    integrate: () => NO_STATE,
    nextThreshold: (_state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null => {
      const time = deriveEnvironmentState(policy, at).nextWeatherBoundary;
      return time > MAX_TIME ? null : { name: "weather", time };
    },
  };
  return Object.freeze(system);
}

export function exposureSystemKind(objectId: string): string {
  return `${EXPOSURE_SYSTEM_KIND_PREFIX}${objectId}`;
}

/** Quantities one actor's exposure system carries between engine calls. */
export function exposureSystemState(
  needs: WorldNeeds,
  protection: number,
  rainIntensity: number,
  rainUntil: SimTimeMs,
): ContinuousState {
  return Object.freeze({
    hunger: needs.hunger,
    hungerRemainder: needs.hungerRemainder,
    protection,
    rain: rainIntensity,
    rainUntil,
    wetness: needs.wetness,
    wetnessRemainder: needs.wetnessRemainder,
  });
}

function quantity(state: ContinuousState, key: string): number {
  const value = state[key];
  if (typeof value !== "number") throw new TypeError("exposure state quantity must be a number");
  return value;
}

function big(state: ContinuousState, key: string): bigint {
  const value = state[key];
  if (typeof value !== "bigint") throw new TypeError("exposure state quantity must be a bigint");
  return value;
}

function needsAt(state: ContinuousState, at: SimTimeMs): WorldNeeds {
  return Object.freeze({
    hunger: quantity(state, "hunger"),
    wetness: quantity(state, "wetness"),
    integratedAt: at,
    hungerRemainder: big(state, "hungerRemainder"),
    wetnessRemainder: big(state, "wetnessRemainder"),
  });
}

/**
 * Per-actor wetness threshold detector. Wetness at a later time is always read from the injected
 * needs integrator, so the first millisecond at which the existing arithmetic reaches or leaves a
 * threshold is found by bisection over that same function (it is monotonic for a constant rain
 * intensity and shelter protection).
 */
export function createExposureSystem(options: {
  readonly objectId: string;
  readonly policy: EnvironmentPolicy;
  readonly integrate: NeedsIntegrator;
}): ContinuousSystem {
  const { policy, integrate } = options;
  const thresholds = [
    ["wet", policy.wetThreshold],
    ["uncomfortable", policy.discomfortThreshold],
  ] as const;

  /** Rain in force from `at`: the held override until its boundary, then the authored segment. */
  function settle(state: ContinuousState, at: SimTimeMs): { rain: number; until: SimTimeMs } {
    const until = big(state, "rainUntil") as SimTimeMs;
    if (at < until) return { rain: quantity(state, "rain"), until };
    const derived = deriveEnvironmentState(policy, at);
    return {
      rain: policy.weatherSegments[derived.segmentIndex]!.rainIntensity,
      until: derived.nextWeatherBoundary,
    };
  }

  function advanceTo(state: ContinuousState, from: SimTimeMs, to: SimTimeMs): ContinuousState {
    let current = state;
    let at = from;
    while (at < to) {
      const { rain, until } = settle(current, at);
      const end = (to < until ? to : until) as SimTimeMs;
      const next = integrate(needsAt(current, at), quantity(current, "protection"), rain, end);
      current = exposureSystemState(next, quantity(current, "protection"), rain, until);
      at = end;
    }
    const { rain, until } = settle(current, at);
    return exposureSystemState(needsAt(current, at), quantity(current, "protection"), rain, until);
  }

  const system: ContinuousSystem = {
    kind: exposureSystemKind(options.objectId),
    version: ENVIRONMENT_SYSTEM_VERSION,
    integrate: advanceTo,
    nextThreshold: (state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null => {
      const { rain, until } = settle(state, at);
      const limit = (until > MAX_TIME ? MAX_TIME : until) as SimTimeMs;
      if (limit <= at) return null;
      const needs = needsAt(state, at);
      const protection = quantity(state, "protection");
      const wetnessAt = (time: bigint): number =>
        integrate(needs, protection, rain, time as SimTimeMs).wetness;
      const wetnessAtLimit = wetnessAt(limit);
      let earliest: bigint | undefined;
      const found: { label: string; time: bigint }[] = [];
      for (const [threshold, level] of thresholds) {
        const rising = needs.wetness < level;
        const holds = (time: bigint): boolean =>
          rising ? wetnessAt(time) >= level : wetnessAt(time) < level;
        const reached = rising ? wetnessAtLimit >= level : wetnessAtLimit < level;
        if (!reached) continue;
        let low: bigint = at;
        let high: bigint = limit;
        while (high - low > 1n) {
          const middle = low + (high - low) / 2n;
          if (holds(middle)) high = middle;
          else low = middle;
        }
        found.push({ label: `${threshold}.${rising ? "entered" : "left"}`, time: high });
        if (earliest === undefined || high < earliest) earliest = high;
      }
      if (earliest === undefined)
        return until > MAX_TIME ? null : { name: EXPOSURE_HORIZON, time: until };
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
