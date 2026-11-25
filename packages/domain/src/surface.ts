import { decodeOpaqueId, type ObjectId, type SimTimeMs } from "@clockgrove/contracts";
import { DomainValidationError } from "./actor-process.js";
import type { ContainmentPayload } from "./commands/containment-commands.js";
import { type EnvironmentPolicy, EnvironmentValidationError } from "./environment/environment.js";
import { regionContains } from "./spatial/region.js";
import type { WorldBehaviorPolicy, WorldState } from "./world.js";

export interface SurfaceBand {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}
export type SurfaceRecovery =
  | { readonly driver: "none" }
  | { readonly driver: "time"; readonly amount: number; readonly periodMs: bigint }
  | { readonly driver: "rain"; readonly amount: number; readonly periodMs: bigint }
  | {
      readonly driver: "growth";
      readonly amount: number;
      readonly periodMs: bigint;
      readonly lightBands: readonly string[];
    };
export interface SurfaceChannel {
  readonly id: string;
  readonly max: number;
  readonly carried: boolean;
  readonly bands: readonly SurfaceBand[];
  readonly recovery: SurfaceRecovery;
}
export type SurfaceHost =
  | { readonly kind: "object"; readonly objectId: ObjectId }
  | { readonly kind: "region"; readonly regionId: string };
export interface SurfaceZoneChannel {
  readonly channel: string;
  readonly initial: number;
}
export interface SurfaceZone {
  readonly id: string;
  readonly host: SurfaceHost;
  readonly channels: readonly SurfaceZoneChannel[];
  readonly markCapacity: number;
  /** An interaction applied to every actor entering the region host (a worn path, tracked mud). */
  readonly traffic?: string;
}
export interface SurfaceEffect {
  readonly channel: string;
  readonly kind: "add" | "pickup" | "deposit";
  readonly amount: number;
}
export interface SurfaceInteraction {
  readonly id: string;
  readonly effects: readonly SurfaceEffect[];
  readonly leavesMark: boolean;
}
export interface SurfacePolicy {
  readonly schemaVersion: 1;
  readonly budgets: { readonly zones: number; readonly marksPerZone: number };
  readonly channels: readonly SurfaceChannel[];
  readonly zones: readonly SurfaceZone[];
  readonly interactions: readonly SurfaceInteraction[];
}
export interface SurfaceChannelState {
  readonly channel: string;
  readonly value: number;
  readonly remainder: bigint;
  readonly settledAt: SimTimeMs;
}
export interface SurfaceMark {
  readonly actorId: ObjectId;
  readonly interactionId: string;
  readonly at: SimTimeMs;
  readonly intensity: number;
  readonly point: { readonly u: number; readonly v: number };
}
export interface SurfaceZoneState {
  readonly zoneId: string;
  readonly channels: readonly SurfaceChannelState[];
  readonly marks: readonly SurfaceMark[];
}
export interface SurfaceCarried {
  readonly objectId: ObjectId;
  readonly channel: string;
  readonly amount: number;
}
export interface SurfaceState {
  readonly zones: readonly SurfaceZoneState[];
  readonly carried: readonly SurfaceCarried[];
}

export type SurfaceInteractPayload = ContainmentPayload<"surface.interact">;
export type SurfaceRepairPayload = ContainmentPayload<"surface.repair">;

export interface SurfaceInteractedPayload {
  readonly actorId: ObjectId;
  readonly zoneId: string;
  readonly interactionId: string;
  readonly intensity: number;
  readonly point: { readonly u: number; readonly v: number };
  readonly channels: readonly SurfaceChannelState[];
  readonly carried: readonly { readonly channel: string; readonly amount: number }[];
  readonly mark: SurfaceMark | null;
  readonly folded: SurfaceMark | null;
}
export interface SurfaceBandCrossedPayload {
  readonly zoneId: string;
  readonly channel: string;
  readonly value: number;
  readonly remainder: bigint;
  readonly bands: readonly string[];
  readonly previousBands: readonly string[];
}
/** A rain channel settled where the rain the world holds changes; rides on the weather event. */
export interface SurfaceRainSettlement {
  readonly zoneId: string;
  readonly channel: string;
  readonly value: number;
  readonly remainder: bigint;
}
export interface SurfaceRepairedPayload {
  readonly zoneId: string;
  readonly reason: string;
  readonly removed: readonly { readonly channel: string; readonly amount: number }[];
}
export interface SurfaceCarriedDrainedPayload {
  readonly actorId: ObjectId;
  readonly removed: readonly { readonly channel: string; readonly amount: number }[];
  readonly cause: "died";
}
export type SurfaceEventData =
  | {
      readonly type: "surface.carried-drained";
      readonly payload: SurfaceCarriedDrainedPayload;
    }
  | {
      readonly type: "surface.interacted";
      readonly payload: SurfaceInteractedPayload;
    }
  | {
      readonly type: "surface.band-crossed";
      readonly payload: SurfaceBandCrossedPayload;
    }
  | {
      readonly type: "surface.repaired";
      readonly payload: SurfaceRepairedPayload;
    };

// decision: these ceilings bound per-instant work like the 64-entry policy lists.
export const MAX_SURFACE_ZONES = 256;
export const MAX_SURFACE_CHANNELS = 16;
export const MAX_SURFACE_BANDS = 16;
export const MAX_SURFACE_INTERACTIONS = 64;
export const MAX_SURFACE_MARKS = 32;
export const MAX_SURFACE_EFFECTS = 8;
const MAX_CHANNEL_VALUE = 1_000_000;
const MAX_INTENSITY = 10_000;
const MAX_TIME = (1n << 63n) - 1n;
const MAX_DURATION = 1n << 53n;
// floor(2^53 / 10000): keeps the rain remainder (below periodMs * 10000) under the state bound.
const MAX_RAIN_PERIOD = 900_719_925_474n;
const FULL_RAIN = 10_000n;
const MAX_LIGHT_BANDS = 64;
const BUDGET_CHECK = "surface.budget@1";
const BUDGET_MESSAGE = `surface budget exceeded (${BUDGET_CHECK})`;

function bad(path: string, message = "invalid surface declaration"): never {
  throw new EnvironmentValidationError(path, message);
}
function overBudget(path: string): never {
  throw new EnvironmentValidationError(path, BUDGET_MESSAGE, BUDGET_CHECK);
}
function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(path);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)))
    bad(path);
  return raw;
}
function name(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    bad(path);
  return value;
}
function int(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    bad(path);
  return value;
}
function array(value: unknown, min: number, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) bad(path);
  return value;
}
function time(value: unknown, path: string): SimTimeMs {
  if (typeof value !== "bigint" || value < 0n || value > MAX_TIME) bad(path);
  return value as SimTimeMs;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateSurfacePolicy(value: unknown): asserts value is SurfacePolicy {
  const root = "policy.surfaces";
  const raw = record(
    value,
    ["schemaVersion", "budgets", "channels", "zones", "interactions"],
    root,
  );
  if (raw.schemaVersion !== 1) bad(`${root}.schemaVersion`);
  const budgets = record(raw.budgets, ["zones", "marksPerZone"], `${root}.budgets`);
  const zoneBudget = int(budgets.zones, 1, MAX_SURFACE_ZONES, `${root}.budgets.zones`);
  const markBudget = int(
    budgets.marksPerZone,
    0,
    MAX_SURFACE_MARKS,
    `${root}.budgets.marksPerZone`,
  );
  const channels = new Map<string, SurfaceChannel>();
  array(raw.channels, 0, MAX_SURFACE_CHANNELS, `${root}.channels`).forEach((candidate, i) => {
    const path = `${root}.channels[${i}]`;
    const entry = record(candidate, ["id", "max", "carried", "bands", "recovery"], path);
    const id = name(entry.id, `${path}.id`);
    if (channels.has(id)) bad(`${path}.id`);
    const max = int(entry.max, 1, MAX_CHANNEL_VALUE, `${path}.max`);
    if (typeof entry.carried !== "boolean") bad(`${path}.carried`);
    const names = new Set<string>();
    array(entry.bands, 1, MAX_SURFACE_BANDS, `${path}.bands`).forEach((band, k) => {
      const bandPath = `${path}.bands[${k}]`;
      const b = record(band, ["name", "min", "max"], bandPath);
      const bandName = name(b.name, `${bandPath}.name`);
      if (names.has(bandName)) bad(`${bandPath}.name`);
      names.add(bandName);
      const min = int(b.min, 0, max, `${bandPath}.min`);
      int(b.max, min, max, `${bandPath}.max`);
    });
    const recovery = entry.recovery as Record<string, unknown> | null;
    const driver = recovery !== null && typeof recovery === "object" ? recovery.driver : undefined;
    if (driver === "time" || driver === "rain" || driver === "growth") {
      const r = record(
        recovery,
        driver === "growth"
          ? ["driver", "amount", "periodMs", "lightBands"]
          : ["driver", "amount", "periodMs"],
        `${path}.recovery`,
      );
      int(r.amount, 1, Number.MAX_SAFE_INTEGER, `${path}.recovery.amount`);
      const limit = driver === "rain" ? MAX_RAIN_PERIOD : MAX_DURATION;
      if (typeof r.periodMs !== "bigint" || r.periodMs <= 0n || r.periodMs > limit)
        bad(`${path}.recovery.periodMs`);
      if (driver === "growth") {
        const bandsPath = `${path}.recovery.lightBands`;
        const seenBands = new Set<string>();
        array(r.lightBands, 1, MAX_LIGHT_BANDS, bandsPath).forEach((band, k) => {
          const bandName = name(band, `${bandsPath}[${k}]`);
          if (seenBands.has(bandName)) bad(`${bandsPath}[${k}]`);
          seenBands.add(bandName);
        });
      }
    } else {
      const r = record(recovery, ["driver"], `${path}.recovery`);
      if (r.driver !== "none") bad(`${path}.recovery.driver`);
    }
    channels.set(id, entry as unknown as SurfaceChannel);
  });
  const zones = array(raw.zones, 0, MAX_SURFACE_ZONES, `${root}.zones`);
  if (zones.length > zoneBudget) overBudget(`${root}.zones`);
  const zoneIds = new Set<string>();
  const traffic: { path: string; zone: Record<string, unknown> }[] = [];
  zones.forEach((candidate, i) => {
    const path = `${root}.zones[${i}]`;
    const withTraffic =
      candidate !== null && typeof candidate === "object" && Object.hasOwn(candidate, "traffic");
    const keys = ["id", "host", "channels", "markCapacity"];
    const entry = record(candidate, withTraffic ? [...keys, "traffic"] : keys, path);
    const id = name(entry.id, `${path}.id`);
    if (zoneIds.has(id)) bad(`${path}.id`);
    zoneIds.add(id);
    const host = entry.host as Record<string, unknown> | null;
    if (host !== null && typeof host === "object" && host.kind === "object") {
      const h = record(host, ["kind", "objectId"], `${path}.host`);
      try {
        decodeOpaqueId(h.objectId, "ObjectId");
      } catch {
        bad(`${path}.host.objectId`);
      }
    } else {
      const h = record(host, ["kind", "regionId"], `${path}.host`);
      if (h.kind !== "region") bad(`${path}.host.kind`);
      name(h.regionId, `${path}.host.regionId`);
    }
    const seen = new Set<string>();
    array(entry.channels, 1, MAX_SURFACE_CHANNELS, `${path}.channels`).forEach((zc, k) => {
      const zcPath = `${path}.channels[${k}]`;
      const c = record(zc, ["channel", "initial"], zcPath);
      const channel = channels.get(name(c.channel, `${zcPath}.channel`));
      if (channel === undefined || seen.has(c.channel as string)) bad(`${zcPath}.channel`);
      seen.add(c.channel as string);
      int(c.initial, 0, channel.max, `${zcPath}.initial`);
    });
    const capacity = int(entry.markCapacity, 0, MAX_SURFACE_MARKS, `${path}.markCapacity`);
    if (capacity > markBudget) overBudget(`${path}.markCapacity`);
    if (withTraffic) {
      name(entry.traffic, `${path}.traffic`);
      traffic.push({ path, zone: entry });
    }
  });
  const interactionIds = new Set<string>();
  const effectChannels = new Map<string, readonly string[]>();
  array(raw.interactions, 0, MAX_SURFACE_INTERACTIONS, `${root}.interactions`).forEach(
    (candidate, i) => {
      const path = `${root}.interactions[${i}]`;
      const entry = record(candidate, ["id", "effects", "leavesMark"], path);
      const id = name(entry.id, `${path}.id`);
      if (interactionIds.has(id)) bad(`${path}.id`);
      interactionIds.add(id);
      if (typeof entry.leavesMark !== "boolean") bad(`${path}.leavesMark`);
      const used: string[] = [];
      effectChannels.set(id, used);
      array(entry.effects, 1, MAX_SURFACE_EFFECTS, `${path}.effects`).forEach((effect, k) => {
        const effectPath = `${path}.effects[${k}]`;
        const e = record(effect, ["channel", "kind", "amount"], effectPath);
        const channel = channels.get(name(e.channel, `${effectPath}.channel`));
        used.push(e.channel as string);
        if (channel === undefined) bad(`${effectPath}.channel`);
        if (e.kind !== "add" && e.kind !== "pickup" && e.kind !== "deposit")
          bad(`${effectPath}.kind`);
        if ((e.kind === "add") === channel.carried) bad(`${effectPath}.kind`);
        int(e.amount, 1, MAX_CHANNEL_VALUE, `${effectPath}.amount`);
      });
    },
  );
  for (const { path, zone } of traffic) {
    const used = effectChannels.get(zone.traffic as string);
    const host = zone.host as { kind: string };
    const has = (zone.channels as { channel: string }[]).map((c) => c.channel);
    if (host.kind !== "region" || used === undefined || used.some((c) => !has.includes(c)))
      bad(`${path}.traffic`);
  }
}

function stateBad(path: string): never {
  throw new EnvironmentValidationError(path, "invalid surface state");
}
function carriedOrder(left: SurfaceCarried, right: SurfaceCarried): number {
  return compare(left.objectId, right.objectId) || compare(left.channel, right.channel);
}
function validateMark(value: unknown, path: string): void {
  const raw = record(value, ["actorId", "interactionId", "at", "intensity", "point"], path);
  try {
    decodeOpaqueId(raw.actorId, "ObjectId");
  } catch {
    stateBad(`${path}.actorId`);
  }
  name(raw.interactionId, `${path}.interactionId`);
  time(raw.at, `${path}.at`);
  int(raw.intensity, 1, MAX_INTENSITY, `${path}.intensity`);
  const point = record(raw.point, ["u", "v"], `${path}.point`);
  int(point.u, 0, MAX_INTENSITY, `${path}.point.u`);
  int(point.v, 0, MAX_INTENSITY, `${path}.point.v`);
}

export function validateSurfaceState(value: unknown): asserts value is SurfaceState {
  const root = "state.surfaces";
  const raw = record(value, ["zones", "carried"], root);
  array(raw.zones, 0, MAX_SURFACE_ZONES, `${root}.zones`).forEach((candidate, i) => {
    const path = `${root}.zones[${i}]`;
    const zone = record(candidate, ["zoneId", "channels", "marks"], path);
    name(zone.zoneId, `${path}.zoneId`);
    array(zone.channels, 1, MAX_SURFACE_CHANNELS, `${path}.channels`).forEach((channel, k) => {
      const channelPath = `${path}.channels[${k}]`;
      const c = record(channel, ["channel", "value", "remainder", "settledAt"], channelPath);
      name(c.channel, `${channelPath}.channel`);
      int(c.value, 0, MAX_CHANNEL_VALUE, `${channelPath}.value`);
      if (typeof c.remainder !== "bigint" || c.remainder < 0n || c.remainder >= MAX_DURATION)
        stateBad(`${channelPath}.remainder`);
      time(c.settledAt, `${channelPath}.settledAt`);
    });
    array(zone.marks, 0, MAX_SURFACE_MARKS, `${path}.marks`).forEach((mark, k) =>
      validateMark(mark, `${path}.marks[${k}]`),
    );
  });
  let previous: SurfaceCarried | undefined;
  array(raw.carried, 0, Number.MAX_SAFE_INTEGER, `${root}.carried`).forEach((candidate, i) => {
    const path = `${root}.carried[${i}]`;
    const entry = record(candidate, ["objectId", "channel", "amount"], path);
    try {
      decodeOpaqueId(entry.objectId, "ObjectId");
    } catch {
      stateBad(`${path}.objectId`);
    }
    name(entry.channel, `${path}.channel`);
    int(entry.amount, 1, Number.MAX_SAFE_INTEGER, `${path}.amount`);
    const current = entry as unknown as SurfaceCarried;
    if (previous !== undefined && carriedOrder(previous, current) >= 0) stateBad(path);
    previous = current;
  });
}

export function surfaceBands(channel: SurfaceChannel, value: number): readonly string[] {
  return channel.bands.filter((band) => value >= band.min && value <= band.max).map((b) => b.name);
}

interface RecoveryClock {
  /** Recovery weight accrued over [0, t). */
  readonly cumulative: (t: bigint) => bigint;
  /** Smallest t with cumulative(t) >= target (target > 0), or null when never. */
  readonly invert: (target: bigint) => bigint | null;
  readonly divisor: bigint;
}
interface ClockSegment {
  readonly duration: bigint;
  readonly weight: bigint;
}

function cycleClock(segments: readonly ClockSegment[], divisor: bigint): RecoveryClock {
  const length = segments.reduce((sum, s) => sum + s.duration, 0n);
  const integral = segments.reduce((sum, s) => sum + s.duration * s.weight, 0n);
  return {
    divisor,
    cumulative(t) {
      let rest = t % length;
      let total = (t / length) * integral;
      for (const s of segments) {
        const part = rest < s.duration ? rest : s.duration;
        total += part * s.weight;
        rest -= part;
        if (rest === 0n) break;
      }
      return total;
    },
    invert(target) {
      if (integral === 0n) return null;
      const cycles = (target - 1n) / integral;
      let rest = target - cycles * integral;
      let at = cycles * length;
      for (const s of segments) {
        const span = s.duration * s.weight;
        if (span >= rest) return at + (rest + s.weight - 1n) / s.weight;
        rest -= span;
        at += s.duration;
      }
      return null;
    },
  };
}

/**
 * The rain the world holds over its schedule: a `world.weather.set` intensity that differs from the
 * authored segment's, in force until the next weather boundary. Absent when the sky follows the
 * schedule. Rain channels settle whenever a hold begins or ends (on `weather.changed` and on the
 * `weather.transitioned` that ends it), so every unsettled span lies inside one regime.
 */
export interface SurfaceRainHold {
  readonly rainIntensity: number;
  readonly until: SimTimeMs;
}

export function surfaceRainHold(
  state: Pick<WorldState, "weather" | "environment">,
  environment?: EnvironmentPolicy,
): SurfaceRainHold | undefined {
  const record = state.environment;
  if (environment === undefined || record === undefined) return undefined;
  const scheduled = environment.weatherSegments[record.segmentIndex]?.rainIntensity;
  return state.weather.rainIntensity === scheduled
    ? undefined
    : { rainIntensity: state.weather.rainIntensity, until: record.nextWeatherBoundary };
}

/** The schedule's clock with a constant held weight before `until`; exact for spans after the hold began. */
function heldClock(schedule: RecoveryClock, hold: SurfaceRainHold): RecoveryClock {
  const until = hold.until as bigint;
  const weight = BigInt(hold.rainIntensity);
  const atUntil = schedule.cumulative(until);
  return {
    divisor: schedule.divisor,
    cumulative: (t) => (t < until ? atUntil - weight * (until - t) : schedule.cumulative(t)),
    invert(target) {
      if (target > atUntil) return schedule.invert(target);
      return weight === 0n ? until : until - (atUntil - target) / weight;
    },
  };
}

function recoveryClock(
  recovery: Exclude<SurfaceRecovery, { readonly driver: "none" }>,
  environment: EnvironmentPolicy | undefined,
  hold?: SurfaceRainHold,
): RecoveryClock {
  if (recovery.driver === "time")
    return cycleClock([{ duration: 1n, weight: 1n }], recovery.periodMs);
  if (environment === undefined)
    throw new DomainValidationError("environment", "surface driver requires an environment");
  if (recovery.driver === "rain") {
    const schedule = cycleClock(
      environment.weatherSegments.map((s) => ({
        duration: s.durationMs,
        weight: BigInt(s.rainIntensity),
      })),
      recovery.periodMs * FULL_RAIN,
    );
    return hold === undefined ? schedule : heldClock(schedule, hold);
  }
  const phases = environment.phases;
  return cycleClock(
    phases.map((phase, i) => ({
      duration: (phases[i + 1]?.startMs ?? environment.dayLengthMs) - phase.startMs,
      weight: recovery.lightBands.includes(phase.lightBand) ? 1n : 0n,
    })),
    recovery.periodMs,
  );
}

export function surfaceValueAt(
  channel: SurfaceChannel,
  entry: SurfaceChannelState,
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
  hold?: SurfaceRainHold,
): { value: number; remainder: bigint } {
  if (channel.recovery.driver === "none" || entry.value === 0)
    return { value: entry.value, remainder: 0n };
  if (at < entry.settledAt)
    throw new DomainValidationError("at", "surface cannot settle before its last settlement");
  const clock = recoveryClock(channel.recovery, environment, hold);
  const total =
    (clock.cumulative(at) - clock.cumulative(entry.settledAt)) * BigInt(channel.recovery.amount) +
    entry.remainder;
  const drop = total / clock.divisor;
  const value = BigInt(entry.value) - drop;
  if (value <= 0n) return { value: 0, remainder: 0n };
  return { value: Number(value), remainder: total % clock.divisor };
}

export function nextSurfaceCrossing(
  channel: SurfaceChannel,
  entry: SurfaceChannelState,
  environment?: EnvironmentPolicy,
  hold?: SurfaceRainHold,
): SimTimeMs | null {
  const recovery = channel.recovery;
  if (recovery.driver === "none" || entry.value === 0) return null;
  let target = -1;
  for (const band of channel.bands)
    for (const candidate of [band.min - 1, band.max])
      if (candidate >= 0 && candidate < entry.value && candidate > target) target = candidate;
  if (target < 0) return null;
  const clock = recoveryClock(recovery, environment, hold);
  const amount = BigInt(recovery.amount);
  const numerator = BigInt(entry.value - target) * clock.divisor - entry.remainder;
  const weight = (numerator + amount - 1n) / amount;
  const at = clock.invert(clock.cumulative(entry.settledAt) + weight);
  return at === null || at > MAX_TIME ? null : (at as SimTimeMs);
}

export function dueSurfaceCrossings(
  policy: SurfacePolicy,
  state: SurfaceState,
  environment?: EnvironmentPolicy,
  hold?: SurfaceRainHold,
): { time: SimTimeMs; crossings: readonly { zoneId: string; channel: string }[] } | null {
  const found: { time: SimTimeMs; zoneId: string; channel: string }[] = [];
  for (const [i, zone] of state.zones.entries())
    for (const entry of zone.channels) {
      const channel = policy.channels.find((candidate) => candidate.id === entry.channel);
      const at =
        channel === undefined ? null : nextSurfaceCrossing(channel, entry, environment, hold);
      if (at !== null)
        found.push({ time: at, zoneId: policy.zones[i]!.id, channel: entry.channel });
    }
  if (found.length === 0) return null;
  const time = found.reduce((least, f) => (f.time < least ? f.time : least), found[0]!.time);
  return {
    time,
    crossings: found
      .filter((f) => f.time === time)
      .map(({ zoneId, channel }) => ({ zoneId, channel })),
  };
}

function declared(policy: SurfacePolicy, id: string): SurfaceChannel {
  const channel = policy.channels.find((candidate) => candidate.id === id);
  if (channel === undefined)
    throw new DomainValidationError("channel", "surface channel is not declared");
  return channel;
}
function zoneIndex(policy: SurfacePolicy, state: SurfaceState, zoneId: string): number {
  const index = policy.zones.findIndex((zone) => zone.id === zoneId);
  if (index < 0 || state.zones[index]?.zoneId !== zoneId)
    throw new DomainValidationError("zoneId", "surface zone is not declared");
  return index;
}

/**
 * Settles every rain-driven channel with a value at `at` under the rain in force before the weather
 * event, for a `weather.changed` that changes the rain or a `weather.transitioned` that ends a hold.
 */
export function planSurfaceRainSettlement(
  policy: SurfacePolicy,
  state: WorldState,
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
): readonly SurfaceRainSettlement[] {
  const hold = surfaceRainHold(state, environment);
  const settled: SurfaceRainSettlement[] = [];
  for (const [i, zone] of (state.surfaces?.zones ?? []).entries())
    for (const entry of zone.channels) {
      const channel = policy.channels.find((candidate) => candidate.id === entry.channel);
      if (channel?.recovery.driver !== "rain" || entry.value === 0) continue;
      const { value, remainder } = surfaceValueAt(channel, entry, at, environment, hold);
      settled.push({ zoneId: policy.zones[i]!.id, channel: entry.channel, value, remainder });
    }
  return settled;
}

export function reduceSurfaceRainSettlement(
  state: WorldState,
  at: SimTimeMs,
  settled: readonly SurfaceRainSettlement[],
): SurfaceState {
  const surfaces = state.surfaces;
  if (surfaces === undefined)
    throw new DomainValidationError("event.surfaces", "world has no surface state");
  let zones = surfaces.zones;
  for (const entry of settled) {
    const index = zones.findIndex((zone) => zone.zoneId === entry.zoneId);
    const zone = zones[index];
    if (zone === undefined || !zone.channels.some((c) => c.channel === entry.channel))
      throw new DomainValidationError("event.surfaces", "unknown surface zone or channel");
    if (!Number.isSafeInteger(entry.value) || entry.value < 0 || entry.remainder < 0n)
      throw new DomainValidationError("event.surfaces", "invalid settled surface value");
    zones = zones.map((candidate, k) =>
      k !== index
        ? candidate
        : {
            ...candidate,
            channels: candidate.channels.map((c) =>
              c.channel === entry.channel
                ? { ...c, value: entry.value, remainder: entry.remainder, settledAt: at }
                : c,
            ),
          },
    );
  }
  return { ...surfaces, zones };
}

export function planSurfaceCrossing(
  policy: SurfacePolicy,
  state: SurfaceState,
  zoneId: string,
  channelId: string,
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
  hold?: SurfaceRainHold,
): SurfaceBandCrossedPayload {
  const zone = state.zones[zoneIndex(policy, state, zoneId)]!;
  const entry = zone.channels.find((candidate) => candidate.channel === channelId);
  if (entry === undefined)
    throw new DomainValidationError("channel", "surface channel is not on the zone");
  const channel = declared(policy, channelId);
  const settled = surfaceValueAt(channel, entry, at, environment, hold);
  return {
    zoneId,
    channel: channelId,
    value: settled.value,
    remainder: settled.remainder,
    bands: surfaceBands(channel, settled.value),
    previousBands: surfaceBands(channel, entry.value),
  };
}

type Refusal = { ok: false; path: string; check: string };
const refuse = (path: string, check: string): Refusal => ({ ok: false, path, check });

export function planSurfaceInteraction(
  policy: SurfacePolicy,
  state: WorldState,
  payload: Pick<SurfaceInteractPayload, "zoneId" | "interactionId" | "intensity" | "point"> & {
    readonly actorId: ObjectId;
  },
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
): { ok: true; payload: SurfaceInteractedPayload } | Refusal {
  const surfaces = state.surfaces;
  const index = policy.zones.findIndex((zone) => zone.id === payload.zoneId);
  if (surfaces === undefined || index < 0) return refuse("payload.zoneId", "surface.zone@1");
  const zone = policy.zones[index]!;
  const interaction = policy.interactions.find(
    (candidate) => candidate.id === payload.interactionId,
  );
  if (
    interaction === undefined ||
    interaction.effects.some((e) => !zone.channels.some((c) => c.channel === e.channel))
  )
    return refuse("payload.interactionId", "surface.interaction@1");
  const actor = state.entities.find((entity) => entity.objectId === payload.actorId);
  if (actor === undefined) return refuse("payload.actorId", "surface.actor@1");
  if (zone.host.kind === "object") {
    const hostId = zone.host.objectId;
    const host = state.entities.find((entity) => entity.objectId === hostId);
    // A retired host stays in `entities`; its zone is gone for interactions all the same.
    if (host === undefined || (host.lifecycle !== undefined && host.lifecycle.status !== "active"))
      return refuse("payload.zoneId", "surface.zone@1");
    if (host.spaceId !== actor.spaceId) return refuse("payload.actorId", "surface.reach@1");
  } else {
    const regionId = zone.host.regionId;
    const region = state.spatialRegions?.find((candidate) => candidate.regionId === regionId);
    if (
      region === undefined ||
      region.frameId !== actor.pose.frameId ||
      region.frameVersion !== actor.pose.frameVersion ||
      !regionContains(region, actor.pose.coordinates)
    )
      return refuse("payload.actorId", "surface.reach@1");
  }
  return {
    ok: true,
    payload: applyInteraction(
      policy,
      state,
      index,
      interaction,
      payload.actorId,
      payload.intensity,
      payload.point,
      at,
      environment,
    ),
  };
}

function applyInteraction(
  policy: SurfacePolicy,
  state: WorldState,
  index: number,
  interaction: SurfaceInteraction,
  actorId: ObjectId,
  intensity: number,
  point: { readonly u: number; readonly v: number },
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
): SurfaceInteractedPayload {
  const surfaces = state.surfaces!;
  const zone = policy.zones[index]!;
  const zoneState = surfaces.zones[index]!;
  const values = new Map<string, { value: number; remainder: bigint }>();
  for (const entry of zoneState.channels)
    values.set(
      entry.channel,
      surfaceValueAt(
        declared(policy, entry.channel),
        entry,
        at,
        environment,
        surfaceRainHold(state, environment),
      ),
    );
  const carried = new Map<string, number>();
  const touched: string[] = [];
  const held = (channel: string): number =>
    carried.get(channel) ??
    surfaces.carried.find((c) => c.objectId === actorId && c.channel === channel)?.amount ??
    0;
  for (const effect of interaction.effects) {
    const channel = declared(policy, effect.channel);
    const current = values.get(effect.channel)!;
    const scaled = Math.max(1, Math.floor((effect.amount * intensity) / MAX_INTENSITY));
    if (effect.kind === "add") {
      current.value = Math.min(channel.max, current.value + scaled);
      continue;
    }
    if (!touched.includes(effect.channel)) touched.push(effect.channel);
    if (effect.kind === "pickup") {
      const moved = Math.min(scaled, current.value);
      current.value -= moved;
      carried.set(effect.channel, held(effect.channel) + moved);
    } else {
      const moved = Math.min(scaled, held(effect.channel), channel.max - current.value);
      current.value += moved;
      carried.set(effect.channel, held(effect.channel) - moved);
    }
  }
  const channels = zoneState.channels.map((entry) => {
    const current = values.get(entry.channel)!;
    return {
      channel: entry.channel,
      value: current.value,
      remainder: current.value === 0 ? 0n : current.remainder,
      settledAt: at,
    };
  });
  let mark: SurfaceMark | null = null;
  let folded: SurfaceMark | null = null;
  if (interaction.leavesMark && zone.markCapacity > 0) {
    mark = {
      actorId: actorId,
      interactionId: interaction.id,
      at,
      intensity: intensity,
      point: { u: point.u, v: point.v },
    };
    if (zoneState.marks.length >= zone.markCapacity) folded = zoneState.marks[0]!;
  }
  return {
    actorId,
    zoneId: zone.id,
    interactionId: interaction.id,
    intensity,
    point: { u: point.u, v: point.v },
    channels,
    carried: touched.map((channel) => ({ channel, amount: held(channel) })),
    mark,
    folded,
  };
}

export interface SurfaceTrafficEntry {
  readonly zoneId: string;
  readonly interactionId: string;
  readonly channels: readonly SurfaceChannelState[];
  readonly carried: readonly { readonly channel: string; readonly amount: number }[];
  readonly mark: SurfaceMark | null;
  readonly folded: SurfaceMark | null;
}

const TRAFFIC_POINT = { u: 5000, v: 5000 };

/** What an actor entering `regionId` does to the region's traffic zones, in declaration order. */
export function planSurfaceTraffic(
  policy: SurfacePolicy,
  state: WorldState,
  actorId: ObjectId,
  regionId: string,
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
): readonly SurfaceTrafficEntry[] {
  const entries: SurfaceTrafficEntry[] = [];
  let current = state;
  for (const [index, zone] of policy.zones.entries()) {
    if (
      zone.traffic === undefined ||
      zone.host.kind !== "region" ||
      zone.host.regionId !== regionId
    )
      continue;
    const interaction = policy.interactions.find((candidate) => candidate.id === zone.traffic);
    if (interaction === undefined || current.surfaces === undefined) continue;
    const planned = applyInteraction(
      policy,
      current,
      index,
      interaction,
      actorId,
      MAX_INTENSITY,
      TRAFFIC_POINT,
      at,
      environment,
    );
    entries.push({
      zoneId: planned.zoneId,
      interactionId: planned.interactionId,
      channels: planned.channels,
      carried: planned.carried,
      mark: planned.mark,
      folded: planned.folded,
    });
    current = {
      ...current,
      surfaces: reduceSurfaceEvent(current, {
        type: "surface.interacted",
        simulationTime: at,
        payload: planned,
      }),
    };
  }
  return entries;
}

export function reduceSurfaceTraffic(
  state: WorldState,
  event: {
    readonly simulationTime: SimTimeMs;
    readonly payload: {
      readonly objectId: ObjectId;
      readonly surfaces?: readonly SurfaceTrafficEntry[];
    };
  },
): SurfaceState {
  let current = state;
  for (const entry of event.payload.surfaces ?? [])
    current = {
      ...current,
      surfaces: reduceSurfaceEvent(current, {
        type: "surface.interacted",
        simulationTime: event.simulationTime,
        payload: {
          ...entry,
          actorId: event.payload.objectId,
          intensity: MAX_INTENSITY,
          point: TRAFFIC_POINT,
        },
      }),
    };
  return current.surfaces!;
}

export function planSurfaceRepair(
  policy: SurfacePolicy,
  state: WorldState,
  payload: Pick<SurfaceRepairPayload, "zoneId" | "reason">,
  at: SimTimeMs,
  environment?: EnvironmentPolicy,
): { ok: true; payload: SurfaceRepairedPayload } | Refusal {
  const index = policy.zones.findIndex((zone) => zone.id === payload.zoneId);
  const zoneState = state.surfaces?.zones[index];
  if (zoneState === undefined) return refuse("payload.zoneId", "surface.zone@1");
  const removed: { channel: string; amount: number }[] = [];
  for (const entry of zoneState.channels) {
    const channel = declared(policy, entry.channel);
    const hold = surfaceRainHold(state, environment);
    const settled = surfaceValueAt(channel, entry, at, environment, hold);
    if (settled.value > 0) removed.push({ channel: entry.channel, amount: settled.value });
  }
  return { ok: true, payload: { zoneId: payload.zoneId, reason: payload.reason, removed } };
}

export function initialSurfaceState(policy: SurfacePolicy, epoch: SimTimeMs): SurfaceState {
  return {
    zones: policy.zones.map((zone) => ({
      zoneId: zone.id,
      channels: zone.channels.map((c) => ({
        channel: c.channel,
        value: c.initial,
        remainder: 0n,
        settledAt: epoch,
      })),
      marks: [],
    })),
    carried: [],
  };
}

export function reduceSurfaceEvent(
  state: WorldState,
  event: { readonly simulationTime: SimTimeMs } & SurfaceEventData,
): SurfaceState {
  const surfaces = state.surfaces;
  if (surfaces === undefined)
    throw new DomainValidationError("event", "the world declares no surfaces");
  if (event.type === "surface.carried-drained")
    return {
      zones: surfaces.zones,
      carried: surfaces.carried.filter((entry) => entry.objectId !== event.payload.actorId),
    };
  const index = surfaces.zones.findIndex((zone) => zone.zoneId === event.payload.zoneId);
  const zone = surfaces.zones[index];
  if (zone === undefined) throw new DomainValidationError("event.zoneId", "unknown surface zone");
  const withZone = (next: SurfaceZoneState, carried = surfaces.carried): SurfaceState => ({
    zones: surfaces.zones.map((candidate, at) => (at === index ? next : candidate)),
    carried,
  });
  switch (event.type) {
    case "surface.band-crossed": {
      const p = event.payload;
      if (!zone.channels.some((entry) => entry.channel === p.channel))
        throw new DomainValidationError("event.channel", "unknown surface channel");
      return withZone({
        ...zone,
        channels: zone.channels.map((entry) =>
          entry.channel === p.channel
            ? { ...entry, value: p.value, remainder: p.remainder, settledAt: event.simulationTime }
            : entry,
        ),
      });
    }
    case "surface.repaired":
      return withZone({
        ...zone,
        channels: zone.channels.map((entry) => ({
          ...entry,
          value: 0,
          remainder: 0n,
          settledAt: event.simulationTime,
        })),
        marks: [],
      });
    case "surface.interacted": {
      const p = event.payload;
      if (
        p.channels.length !== zone.channels.length ||
        p.channels.some((entry, at) => entry.channel !== zone.channels[at]!.channel)
      )
        throw new DomainValidationError("event.channels", "must list the zone channels in order");
      let marks = zone.marks;
      if (p.folded !== null) {
        if (
          marks[0] === undefined ||
          JSON.stringify(marks[0], bigintJson) !== JSON.stringify(p.folded, bigintJson)
        )
          throw new DomainValidationError("event.folded", "must be the oldest mark");
        marks = marks.slice(1);
      }
      if (p.mark !== null) marks = [...marks, p.mark];
      const carried = new Map(
        surfaces.carried.map((entry) => [`${entry.objectId}\u0000${entry.channel}`, entry]),
      );
      for (const entry of p.carried) {
        const key = `${p.actorId}\u0000${entry.channel}`;
        if (entry.amount > 0)
          carried.set(key, { objectId: p.actorId, channel: entry.channel, amount: entry.amount });
        else carried.delete(key);
      }
      return withZone(
        { ...zone, channels: p.channels, marks },
        [...carried.values()].sort(carriedOrder),
      );
    }
  }
}
const bigintJson = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export function surfaceDisagreement(
  policy: WorldBehaviorPolicy,
  state: WorldState,
): string | undefined {
  const surfaces = policy.surfaces;
  if (surfaces === undefined) return state.surfaces === undefined ? undefined : "state.surfaces";
  const current = state.surfaces;
  if (current === undefined || current.zones.length !== surfaces.zones.length)
    return "state.surfaces.zones";
  for (const [i, zone] of surfaces.zones.entries()) {
    const entry = current.zones[i]!;
    const path = `state.surfaces.zones[${i}]`;
    if (entry.zoneId !== zone.id) return `${path}.zoneId`;
    if (entry.channels.length !== zone.channels.length) return `${path}.channels`;
    for (const [j, declaredChannel] of zone.channels.entries()) {
      const channelState = entry.channels[j]!;
      const channel = surfaces.channels.find((c) => c.id === declaredChannel.channel)!;
      const at = `${path}.channels[${j}]`;
      if (channelState.channel !== channel.id) return `${at}.channel`;
      if (channelState.value > channel.max) return `${at}.value`;
      if (
        channelState.remainder !== 0n &&
        (channel.recovery.driver === "none" ||
          channelState.value === 0 ||
          channelState.remainder >=
            channel.recovery.periodMs * (channel.recovery.driver === "rain" ? FULL_RAIN : 1n))
      )
        return `${at}.remainder`;
      if (channelState.settledAt > state.simulationTime) return `${at}.settledAt`;
      const crossing = nextSurfaceCrossing(
        channel,
        channelState,
        policy.environment,
        surfaceRainHold(state, policy.environment),
      );
      if (crossing !== null && crossing <= state.simulationTime) return at;
    }
    if (entry.marks.length > zone.markCapacity) return `${path}.marks`;
    for (const [k, mark] of entry.marks.entries())
      if (mark.at > state.simulationTime || (k > 0 && mark.at < entry.marks[k - 1]!.at))
        return `${path}.marks[${k}]`;
  }
  let previous: SurfaceCarried | undefined;
  for (const [i, entry] of current.carried.entries()) {
    const path = `state.surfaces.carried[${i}]`;
    if (previous !== undefined && carriedOrder(previous, entry) >= 0) return path;
    previous = entry;
    if (!surfaces.channels.some((c) => c.id === entry.channel && c.carried))
      return `${path}.channel`;
    const holder = state.entities.find((e) => e.objectId === entry.objectId);
    if (entry.amount <= 0 || holder === undefined || holder.lifecycle?.status === "dead")
      return path;
  }
  return undefined;
}
