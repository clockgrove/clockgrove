import type { SimTimeMs } from "@clockgrove/contracts";
import {
  deriveEnvironmentState,
  type EcologyPlant,
  type EnvironmentPolicy,
  plantStageIndex,
  type WorldNeeds,
} from "@clockgrove/domain";
import type {
  ContinuousState,
  ContinuousSystem,
  ContinuousThreshold,
} from "../../scheduler/catch-up.js";
import { EXPOSURE_HORIZON, type NeedsIntegrator } from "../environment/systems.js";
import { ECOLOGY_SYSTEM_VERSION, GROWTH_SYSTEM_KIND_PREFIX } from "./holder.js";

const MAX_TIME = (1n << 63n) - 1n;

export const STAGE_THRESHOLD_PREFIX = "stage:";

export function growthSystemKind(objectId: string): string {
  return `${GROWTH_SYSTEM_KIND_PREFIX}${objectId}`;
}

export interface GrowthConfig {
  readonly plant: EcologyPlant;
  readonly environment: EnvironmentPolicy;
  /** The world's single wetness arithmetic (`integrateNeedsWith`); never re-stated here. */
  readonly integrate: NeedsIntegrator;
}

/** The quantities one plant carries between engine calls and integrations. */
export interface GrowthSnapshot {
  readonly growingMs: bigint;
  readonly wetness: number;
  readonly wetnessRemainder: bigint;
  readonly protection: number;
  /** Rain intensity in force from the state's time until `rainUntil`, then the authored segment. */
  readonly rain: number;
  readonly rainUntil: SimTimeMs;
  readonly active: boolean;
}

export function growthSystemState(snapshot: GrowthSnapshot): ContinuousState {
  return Object.freeze({
    active: snapshot.active ? 1 : 0,
    growing: snapshot.growingMs,
    protection: snapshot.protection,
    rain: snapshot.rain,
    rainUntil: snapshot.rainUntil,
    wetness: snapshot.wetness,
    wetnessRemainder: snapshot.wetnessRemainder,
  });
}

function numberOf(state: ContinuousState, key: string): number {
  const value = state[key];
  if (typeof value !== "number") throw new TypeError("growth state quantity must be a number");
  return value;
}

function bigOf(state: ContinuousState, key: string): bigint {
  const value = state[key];
  if (typeof value !== "bigint") throw new TypeError("growth state quantity must be a bigint");
  return value;
}

export function growthSnapshotOf(state: ContinuousState): {
  growingMs: bigint;
  wetness: number;
  wetnessRemainder: bigint;
} {
  return {
    growingMs: bigOf(state, "growing"),
    wetness: numberOf(state, "wetness"),
    wetnessRemainder: bigOf(state, "wetnessRemainder"),
  };
}

function needsAt(state: ContinuousState, at: SimTimeMs): WorldNeeds {
  return Object.freeze({
    hunger: 0,
    wetness: numberOf(state, "wetness"),
    integratedAt: at,
    hungerRemainder: 0n,
    wetnessRemainder: bigOf(state, "wetnessRemainder"),
  });
}

/**
 * Per-plant growth: one growing millisecond for each simulation millisecond `[t, t + 1)` whose phase
 * light band is a growing band and whose wetness at `t` is at or above the environment's
 * `wetThreshold`. Wetness is always read from the injected needs integrator.
 */
export function createGrowthSystem(config: GrowthConfig): ContinuousSystem {
  const { plant, environment, integrate } = config;
  const bands = new Set(plant.growingLightBands);

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

  /** The piece of time after `at` over which rain, protection and light band are constant. */
  function piece(state: ContinuousState, at: SimTimeMs) {
    const { rain, until } = settle(state, at);
    const derived = deriveEnvironmentState(environment, at);
    const boundary = derived.nextPhaseBoundary < until ? derived.nextPhaseBoundary : until;
    return {
      rain,
      until,
      end: (boundary > MAX_TIME ? MAX_TIME : boundary) as SimTimeMs,
      grows: bands.has(derived.lightBand),
    };
  }

  /** The milliseconds of `[at, end)` that are wet: wetness is monotone inside a piece. */
  function wetRange(
    state: ContinuousState,
    at: SimTimeMs,
    end: SimTimeMs,
    rain: number,
  ): readonly [bigint, bigint] {
    const needs = needsAt(state, at);
    const protection = numberOf(state, "protection");
    const wetAt = (time: bigint): boolean =>
      integrate(needs, protection, rain, time as SimTimeMs).wetness >= environment.wetThreshold;
    const last = end - 1n;
    const startWet = wetAt(at);
    const endWet = wetAt(last);
    if (startWet && endWet) return [at, end];
    if (!startWet && !endWet) return [at, at];
    let low: bigint = at;
    let high: bigint = last;
    while (high - low > 1n) {
      const middle = low + (high - low) / 2n;
      if (wetAt(middle) === endWet) high = middle;
      else low = middle;
    }
    return startWet ? [at, high] : [high, end];
  }

  function advanceTo(state: ContinuousState, from: SimTimeMs, to: SimTimeMs): ContinuousState {
    let current = state;
    let growing = bigOf(state, "growing");
    let at = from;
    const protection = numberOf(state, "protection");
    const active = numberOf(state, "active");
    while (at < to) {
      const here = piece(current, at);
      const end = (to < here.end ? to : here.end) as SimTimeMs;
      if (active === 1 && here.grows) {
        const [low, high] = wetRange(current, at, end, here.rain);
        growing += high - low;
      }
      const next = integrate(needsAt(current, at), protection, here.rain, end);
      current = growthSystemState({
        growingMs: growing,
        wetness: next.wetness,
        wetnessRemainder: next.wetnessRemainder,
        protection,
        rain: here.rain,
        rainUntil: here.until,
        active: active === 1,
      });
      at = end;
    }
    const settled = settle(current, at);
    return growthSystemState({
      growingMs: growing,
      wetness: numberOf(current, "wetness"),
      wetnessRemainder: bigOf(current, "wetnessRemainder"),
      protection,
      rain: settled.rain,
      rainUntil: settled.until,
      active: active === 1,
    });
  }

  const system: ContinuousSystem = {
    kind: growthSystemKind(plant.objectId),
    version: ECOLOGY_SYSTEM_VERSION,
    integrate: advanceTo,
    nextThreshold: (state: ContinuousState, at: SimTimeMs): ContinuousThreshold | null => {
      if (numberOf(state, "active") === 0) return null;
      const growing = bigOf(state, "growing");
      const stage = plantStageIndex(plant, growing);
      const next = plant.stages[stage + 1];
      if (next === undefined) return null;
      const here = piece(state, at);
      if (here.end <= at) return null;
      if (here.grows) {
        const [low, high] = wetRange(state, at, here.end, here.rain);
        const needed = next.thresholdMs - growing;
        if (needed <= high - low)
          return {
            name: `${STAGE_THRESHOLD_PREFIX}${stage + 1}`,
            time: (low + needed) as SimTimeMs,
          };
      }
      return here.end >= MAX_TIME ? null : { name: EXPOSURE_HORIZON, time: here.end };
    },
  };
  return Object.freeze(system);
}
