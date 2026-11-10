import type { SimTimeMs } from "@clockgrove/contracts";
import {
  deriveEnvironmentState,
  type EcologyWaterHolder,
  type EcologyWaterState,
  type EnvironmentPolicy,
} from "@clockgrove/domain";
import type { ContinuousState, ContinuousSystem } from "../../scheduler/catch-up.js";
import { EXPOSURE_HORIZON } from "../environment/systems.js";

// Milliseconds/hour and two basis-point factors (rain and shelter).
export const WATER_COLLECTION_DENOMINATOR = 360_000_000_000_000n;
export const WATER_EVAPORATION_DENOMINATOR = 3_600_000n;
const MAX_TIME = (1n << 63n) - 1n;
export const waterSystemKind = (id: string): string => `ecology.water:${id}`;
export interface WaterSnapshot {
  readonly quantity: number;
  readonly collectionRemainder: bigint;
  readonly evaporationRemainder: bigint;
  readonly protection: number;
  readonly rain: number;
  readonly rainUntil: SimTimeMs;
  readonly active: boolean;
  readonly collected?: bigint;
  readonly evaporated?: bigint;
}
export function waterSystemState(snapshot: WaterSnapshot): ContinuousState {
  return {
    quantity: snapshot.quantity,
    collectionRemainder: snapshot.collectionRemainder,
    evaporationRemainder: snapshot.evaporationRemainder,
    protection: snapshot.protection,
    rain: snapshot.rain,
    rainUntil: snapshot.rainUntil,
    active: snapshot.active ? 1 : 0,
    collected: snapshot.collected ?? 0n,
    evaporated: snapshot.evaporated ?? 0n,
  };
}
export function waterSnapshotOf(state: ContinuousState): WaterSnapshot {
  return {
    quantity: state.quantity as number,
    collectionRemainder: state.collectionRemainder as bigint,
    evaporationRemainder: state.evaporationRemainder as bigint,
    protection: state.protection as number,
    rain: state.rain as number,
    rainUntil: state.rainUntil as SimTimeMs,
    active: state.active === 1,
    collected: (state.collected as bigint) ?? 0n,
    evaporated: (state.evaporated as bigint) ?? 0n,
  };
}
export function createWaterSystem(
  holder: EcologyWaterHolder,
  environment: EnvironmentPolicy,
): ContinuousSystem {
  const settle = (snapshot: WaterSnapshot, at: SimTimeMs): WaterSnapshot => {
    if (at < snapshot.rainUntil) return snapshot;
    const derived = deriveEnvironmentState(environment, at);
    return {
      ...snapshot,
      rain: environment.weatherSegments[derived.segmentIndex]!.rainIntensity,
      rainUntil: derived.nextWeatherBoundary,
    };
  };
  function next(snapshot: WaterSnapshot, at: SimTimeMs): bigint {
    let result: bigint = snapshot.rainUntil;
    const collection =
      snapshot.active && snapshot.quantity < holder.capacity
        ? BigInt(holder.catchment) * BigInt(snapshot.rain) * BigInt(10_000 - snapshot.protection)
        : 0n;
    const evaporation =
      snapshot.active && snapshot.quantity > 0 ? BigInt(holder.evaporationPerHour) : 0n;
    for (const [rate, remainder, denominator] of [
      [collection, snapshot.collectionRemainder, WATER_COLLECTION_DENOMINATOR],
      [evaporation, snapshot.evaporationRemainder, WATER_EVAPORATION_DENOMINATOR],
    ] as const) {
      if (rate > 0n) {
        const due = at + (denominator - remainder + rate - 1n) / rate;
        if (due < result) result = due;
      }
    }
    return result;
  }
  return {
    kind: waterSystemKind(holder.objectId),
    version: 1,
    nextThreshold: (state, at) => {
      const snapshot = settle(waterSnapshotOf(state), at);
      if (!snapshot.active) return null;
      const time = next(snapshot, at);
      if (time > MAX_TIME) return null;
      return {
        name: time === snapshot.rainUntil ? EXPOSURE_HORIZON : "water",
        time: time as SimTimeMs,
      };
    },
    integrate: (state, from, to) => {
      let snapshot = waterSnapshotOf(state);
      let at = from;
      while (at < to) {
        snapshot = settle(snapshot, at);
        const due = next(snapshot, at);
        const end = (due < to ? due : to) as SimTimeMs;
        if (end <= at) throw new RangeError("water integration did not advance");
        const dt = end - at;
        const collecting = snapshot.active && snapshot.quantity < holder.capacity;
        const evaporating = snapshot.active && snapshot.quantity > 0;
        const collection = collecting
          ? snapshot.collectionRemainder +
            dt *
              BigInt(holder.catchment) *
              BigInt(snapshot.rain) *
              BigInt(10_000 - snapshot.protection)
          : 0n;
        const evaporation = evaporating
          ? snapshot.evaporationRemainder + dt * BigInt(holder.evaporationPerHour)
          : 0n;
        const added = collection / WATER_COLLECTION_DENOMINATOR;
        const removed = evaporation / WATER_EVAPORATION_DENOMINATOR;
        const room = BigInt(holder.capacity - snapshot.quantity);
        const collected = added < room ? added : room;
        const available = BigInt(snapshot.quantity) + collected;
        const evaporated = removed < available ? removed : available;
        const quantity = Number(available - evaporated);
        snapshot = {
          ...snapshot,
          quantity,
          collected: (snapshot.collected ?? 0n) + collected,
          evaporated: (snapshot.evaporated ?? 0n) + evaporated,
          collectionRemainder:
            available === BigInt(holder.capacity) ? 0n : collection % WATER_COLLECTION_DENOMINATOR,
          evaporationRemainder: quantity === 0 ? 0n : evaporation % WATER_EVAPORATION_DENOMINATOR,
        };
        at = end;
      }
      return waterSystemState(settle(snapshot, at));
    },
  };
}

export interface EcologyWaterInit {
  readonly entry: EcologyWaterState;
  readonly quantity: number;
  readonly protection: number;
  readonly active: boolean;
}
