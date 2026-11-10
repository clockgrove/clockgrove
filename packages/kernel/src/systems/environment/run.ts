import type { SimTimeMs } from "@clockgrove/contracts";
import type {
  Comfort,
  EnvironmentPolicy,
  ExposureDirection,
  ExposureThreshold,
  HealthDirection,
  WellbeingNeed,
  WellbeingPolicy,
  WorldNeeds,
} from "@clockgrove/domain";
import { RefusalSignal } from "../../execute/refusal.js";
import {
  boundedCatchUpTarget,
  CATCH_UP_ENGINE_VERSION,
  type CatchUpPayloadHandler,
  type CatchUpRegistry,
  type CatchUpSystemState,
  type ContinuousState,
  type ContinuousSystem,
  catchUpSchedules,
  continuousSystemId,
  createCatchUpRegistry,
} from "../../scheduler/catch-up.js";
import type { ScheduleQueue } from "../../scheduler.js";
import type { ScheduledKernelInput } from "../../transition.js";
import {
  appearanceSystemKind,
  createEcologySystems,
  ECOLOGY_SYSTEM_VERSION,
  type EcologyHolderInit,
  type EcologyRunOptions,
  type EcologyWaterInit,
  growthSystemKind,
  growthSystemState,
  holderSystemState,
  STAGE_THRESHOLD_PREFIX,
  spoilageSystemKind,
  waterSystemKind,
  waterSystemState,
} from "../ecology/index.js";
import {
  createWellbeingSystem,
  WELLBEING_COMFORTABLE,
  WELLBEING_DEATH,
  WELLBEING_HEALTH_ENTERED,
  WELLBEING_HEALTH_LEFT,
  WELLBEING_HUNGER,
  WELLBEING_SYSTEM_VERSION,
  WELLBEING_UNCOMFORTABLE,
  wellbeingSystemKind,
  wellbeingSystemState,
} from "../wellbeing/wellbeing.js";
import {
  createExposureSystem,
  createPhaseSystem,
  createWeatherSystem,
  ENVIRONMENT_SYSTEM_VERSION,
  EXPOSURE_HORIZON,
  exposureSystemKind,
  exposureSystemState,
  type NeedsIntegrator,
  PHASE_SYSTEM_KIND,
  WEATHER_SYSTEM_KIND,
} from "./systems.js";

export interface EnvironmentCrossing {
  readonly objectId: string;
  readonly threshold: ExposureThreshold;
  readonly direction: ExposureDirection;
}

/** Everything the environment owes at one simulation time, in the declared same-time order. */
export interface EnvironmentGroup {
  readonly time: SimTimeMs;
  readonly phase: boolean;
  readonly weather: boolean;
  readonly crossings: readonly EnvironmentCrossing[];
  /** Perishable holders whose food spoils here, in object id code-unit order. */
  readonly spoiled: readonly string[];
  /** Sources that appear here, in object id code-unit order. */
  readonly appeared: readonly string[];
  readonly water: readonly string[];
  /** Plants that reach a new stage here, in object id code-unit order. */
  readonly stages: readonly EcologyStageChange[];
  /** Need crossings (hunger before thirst, then object id order). */
  readonly needs: readonly { readonly objectId: string; readonly need: WellbeingNeed }[];
  /** Actors whose comfort changes here, in object id code-unit order. */
  readonly comforts: readonly { readonly objectId: string; readonly comfort: Comfort }[];
  /** Health crossings in object id code-unit order. */
  readonly health: readonly { readonly objectId: string; readonly direction: HealthDirection }[];
  /** Actors whose health reaches the lifecycle death level here, in object id code-unit order. */
  readonly deaths: readonly string[];
  /** Actors whose routine movement has a crossing or its completion here, in object id order. */
  readonly movers: readonly string[];
}

export interface EcologyStageChange {
  readonly objectId: string;
  readonly stageIndex: number;
}

export interface EnvironmentActor {
  readonly objectId: string;
  /** Needs already integrated to the run's start position. */
  readonly needs: WorldNeeds;
  readonly protection: number;
  /** Thirst and health already integrated to the run's start; present exactly with `wellbeing`. */
  readonly wellbeing?: {
    readonly thirst: number;
    readonly thirstRemainder: bigint;
    readonly health: number;
    readonly healthRemainder: bigint;
  };
}

export interface EnvironmentRunOptions {
  readonly policy?: EnvironmentPolicy;
  readonly wellbeing?: {
    readonly policy: WellbeingPolicy;
    readonly decisionIntervalMs: bigint;
    /** Lifecycle death level: the wellbeing systems also report the first ms health is at or below it. */
    readonly deathHealth?: number;
  };
  readonly actors: readonly EnvironmentActor[];
  readonly position: SimTimeMs;
  /** Rain intensity in force at `position`, possibly a held `world.weather.set` override. */
  readonly rainIntensity: number;
  /** The record's next weather boundary: the held intensity gives way to the authored one there. */
  readonly nextWeatherBoundary: SimTimeMs;
  readonly integrate: NeedsIntegrator;
  /** Present exactly when the policy declares an ecology; its systems share this engine call. */
  readonly ecology?: EcologyRunOptions;
}

export interface EnvironmentDrain {
  /** The time the engine call reached: the bounded threshold horizon, first queued decision's due time, or the target. */
  readonly time: SimTimeMs;
  readonly groups: readonly EnvironmentGroup[];
  /** The decision the engine dispatched at `time`, if one was due. */
  readonly dispatched: ScheduledKernelInput | undefined;
  /** Adopts the engine's end states; without it the run stays where it was. */
  readonly commit: () => void;
}

export interface EnvironmentRun {
  /** Thresholds in `(position, upTo]`, grouped by time; advances the run to `upTo`. */
  readonly step: (upTo: SimTimeMs) => readonly EnvironmentGroup[];
  /**
   * One engine call over the real queue: advances to a bounded threshold horizon, decision or target,
   * dispatches at most that one decision, and reports the grouped thresholds. Pure until `commit`.
   */
  readonly drain: (
    queue: ScheduleQueue,
    target: SimTimeMs,
    thresholdBudget: number,
  ) => EnvironmentDrain;
  /**
   * Replaces the routine-movement systems (one per moving actor) registered for the following
   * engine calls; their states start at the run's position.
   */
  readonly setMovers: (movers: readonly EnvironmentMover[]) => void;
  /**
   * Re-seeds the exposure and wellbeing states of the given actors, and the spoilage and appearance
   * states of the given ecology holders, at the run's position, from values the caller has just
   * journaled (a location change, a relief, a consumption or a new decision).
   */
  readonly reseed: (reseed: EnvironmentReseed) => void;
}

export interface EnvironmentMover {
  readonly objectId: string;
  readonly system: ContinuousSystem;
}

export interface EnvironmentReseed {
  readonly actors: readonly EnvironmentActor[];
  /**
   * Holder contents at the run's position. A source appears only into an empty holder, so a
   * quantity a decision changes must reach the appearance schedule at the instant it changes.
   */
  readonly holders?: readonly EcologyHolderInit[];
  readonly waterHolders?: readonly EcologyWaterInit[];
  readonly rainIntensity: number;
  readonly nextWeatherBoundary: SimTimeMs;
}

const RANK_PHASE = 0;
const RANK_WEATHER = 1;
const RANK_EXPOSURE = 2;
const RANK_SPOILAGE = 3;
const RANK_APPEARANCE = 4;
const RANK_WATER = 4.5;
const RANK_STAGE = 5;
const RANK_WELLBEING = 6;
const RANK_MOVEMENT = 7;

/**
 * The environment systems of one policy and actor set, plus the ecology systems when the policy
 * declares one, registered through `createCatchUpRegistry` in the same engine call.
 */
export function createEnvironmentSystems(
  options: Pick<EnvironmentRunOptions, "actors" | "integrate"> &
    Partial<Pick<EnvironmentRunOptions, "ecology">> & { readonly policy: EnvironmentPolicy },
): readonly ContinuousSystem[] {
  return Object.freeze([
    createPhaseSystem(options.policy),
    createWeatherSystem(options.policy),
    ...options.actors.map((actor) =>
      createExposureSystem({
        objectId: actor.objectId,
        policy: options.policy,
        integrate: options.integrate,
      }),
    ),
    ...(options.ecology === undefined
      ? []
      : createEcologySystems({
          policy: options.ecology.policy,
          environment: options.policy,
          integrate: options.integrate,
        })),
  ]);
}

function refuse(
  outcome: ReturnType<typeof catchUpSchedules> | ReturnType<typeof createCatchUpRegistry>,
): never {
  if (outcome.ok) throw new TypeError("not a refusal");
  throw new RefusalSignal(outcome.error);
}

/**
 * Runs one engine call over the registered systems and returns the grouped material thresholds.
 * Engine refusals (including environment-system exceptions) are rethrown as refusal signals.
 */
export function catchUpEnvironment(
  registry: CatchUpRegistry,
  systems: readonly CatchUpSystemState[],
  start: SimTimeMs,
  target: SimTimeMs,
) {
  const outcome = catchUpSchedules(registry, {
    engineVersion: CATCH_UP_ENGINE_VERSION,
    queue: [],
    start,
    target,
    budget: 1,
    cursor: null,
    systems,
    results: [],
  });
  if (!outcome.ok) return refuse(outcome);
  return outcome.result;
}

/** The payload handler the engine dispatches `world.decision` items through. */
export const DECISION_PAYLOAD_HANDLER: CatchUpPayloadHandler = Object.freeze({
  kind: "world.decision",
  payloadVersion: 1,
  type: "world.decision",
  schemaVersion: 1,
});

/** The engine registry of the decision handler plus the given systems. */
export function createDecisionRegistry(systems: readonly ContinuousSystem[]): CatchUpRegistry {
  const registered = createCatchUpRegistry({ payloads: [DECISION_PAYLOAD_HANDLER], systems });
  if (!registered.ok) return refuse(registered);
  return registered.registry;
}

export function createEnvironmentRun(options: EnvironmentRunOptions): EnvironmentRun {
  const environment = options.policy;
  const wellbeing = options.wellbeing;
  const wellbeingActors = wellbeing === undefined ? [] : options.actors;
  const systems: readonly ContinuousSystem[] = Object.freeze([
    ...(environment === undefined
      ? []
      : createEnvironmentSystems({ ...options, policy: environment, actors: options.actors })),
    ...(environment === undefined || wellbeing === undefined
      ? []
      : wellbeingActors.map((actor) =>
          createWellbeingSystem({
            objectId: actor.objectId,
            environment,
            wellbeing: wellbeing.policy,
            decisionIntervalMs: wellbeing.decisionIntervalMs,
            integrate: options.integrate,
            ...(wellbeing.deathHealth === undefined ? {} : { deathHealth: wellbeing.deathHealth }),
          }),
        )),
  ]);
  let registry = createDecisionRegistry(systems);
  /** Routine-movement system id to its actor; replaced whole by `setMovers`. */
  let moverObjects = new Map<string, string>();
  const objects = new Map<string, string>(
    environment === undefined
      ? []
      : options.actors.map((actor) => [
          continuousSystemId(exposureSystemKind(actor.objectId), ENVIRONMENT_SYSTEM_VERSION),
          actor.objectId,
        ]),
  );
  const wellbeingObjects = new Map<string, string>(
    wellbeing === undefined
      ? []
      : options.actors.map((actor) => [
          continuousSystemId(wellbeingSystemKind(actor.objectId), WELLBEING_SYSTEM_VERSION),
          actor.objectId,
        ]),
  );
  /** Ecology system id to its kind of change and object. */
  const ecologyObjects = new Map<string, { rank: number; objectId: string }>();
  const ecologyStates: CatchUpSystemState[] = [];
  const ecology = options.ecology;
  if (ecology !== undefined) {
    const holders = new Map(ecology.holders.map((holder) => [holder.objectId, holder]));
    const holderState = (objectId: string) => {
      const holder = holders.get(objectId);
      if (holder === undefined) throw new RangeError("ecology holder without state");
      return holderSystemState(holder.quantity, holder.arrival, holder.active);
    };
    for (const holder of ecology.policy.perishables) {
      const id = continuousSystemId(spoilageSystemKind(holder.objectId), ECOLOGY_SYSTEM_VERSION);
      ecologyObjects.set(id, { rank: RANK_SPOILAGE, objectId: holder.objectId });
      ecologyStates.push({
        systemId: id,
        at: options.position,
        state: holderState(holder.objectId),
      });
    }
    for (const source of ecology.policy.sources) {
      const id = continuousSystemId(appearanceSystemKind(source.objectId), ECOLOGY_SYSTEM_VERSION);
      ecologyObjects.set(id, { rank: RANK_APPEARANCE, objectId: source.objectId });
      ecologyStates.push({
        systemId: id,
        at: options.position,
        state: holderState(source.objectId),
      });
    }
    for (const init of ecology.waterHolders ?? []) {
      const id = continuousSystemId(waterSystemKind(init.entry.objectId), 1);
      ecologyObjects.set(id, { rank: RANK_WATER, objectId: init.entry.objectId });
      ecologyStates.push({
        systemId: id,
        at: options.position,
        state: waterSystemState({
          ...init.entry,
          quantity: init.quantity,
          protection: init.protection,
          active: init.active,
          rain: options.rainIntensity,
          rainUntil: options.nextWeatherBoundary,
        }),
      });
    }
    for (const plant of ecology.policy.plants) {
      const init = ecology.plants.find((candidate) => candidate.entry.objectId === plant.objectId);
      if (init === undefined) throw new RangeError("ecology plant without state");
      const id = continuousSystemId(growthSystemKind(plant.objectId), ECOLOGY_SYSTEM_VERSION);
      ecologyObjects.set(id, { rank: RANK_STAGE, objectId: plant.objectId });
      const system = systems.find(
        (candidate) => candidate.kind === growthSystemKind(plant.objectId),
      );
      if (system === undefined) throw new RangeError("growth system is not registered");
      // Bring the journaled entry forward to the run's start without emitting anything.
      const entry = init.entry;
      ecologyStates.push({
        systemId: id,
        at: options.position,
        state: system.integrate(
          growthSystemState({
            growingMs: entry.growingMs,
            wetness: entry.wetness,
            wetnessRemainder: entry.wetnessRemainder,
            protection: init.protection,
            rain: options.rainIntensity,
            rainUntil: options.nextWeatherBoundary,
            active: init.active,
          }),
          entry.integratedAt,
          options.position,
        ),
      });
    }
  }
  const empty: ContinuousState = Object.freeze({});
  let position = options.position;
  let states: readonly CatchUpSystemState[] = Object.freeze([
    ...(environment === undefined
      ? []
      : [
          {
            systemId: continuousSystemId(PHASE_SYSTEM_KIND, ENVIRONMENT_SYSTEM_VERSION),
            at: position,
            state: empty,
          },
          {
            systemId: continuousSystemId(WEATHER_SYSTEM_KIND, ENVIRONMENT_SYSTEM_VERSION),
            at: position,
            state: empty,
          },
          ...options.actors.map((actor) => ({
            systemId: continuousSystemId(
              exposureSystemKind(actor.objectId),
              ENVIRONMENT_SYSTEM_VERSION,
            ),
            at: position,
            state: exposureSystemState(
              actor.needs,
              actor.protection,
              options.rainIntensity,
              options.nextWeatherBoundary,
            ),
          })),
        ]),
    ...ecologyStates,
    ...(environment === undefined || wellbeing === undefined
      ? []
      : options.actors.map((actor) => {
          const extra = actor.wellbeing;
          if (extra === undefined) throw new RangeError("wellbeing actor without wellbeing state");
          return {
            systemId: continuousSystemId(
              wellbeingSystemKind(actor.objectId),
              WELLBEING_SYSTEM_VERSION,
            ),
            at: position,
            state: wellbeingSystemState({
              hunger: actor.needs.hunger,
              hungerRemainder: actor.needs.hungerRemainder,
              wetness: actor.needs.wetness,
              wetnessRemainder: actor.needs.wetnessRemainder,
              ...extra,
              protection: actor.protection,
              rain: options.rainIntensity,
              rainUntil: options.nextWeatherBoundary,
            }),
          };
        })),
  ]);
  const group = (result: {
    readonly thresholds: readonly { systemId: string; name: string; time: SimTimeMs }[];
  }): readonly EnvironmentGroup[] => {
    const records = result.thresholds
      .filter((record) => record.name !== EXPOSURE_HORIZON)
      .map((record, order) => ({
        record,
        order,
        objectId:
          objects.get(record.systemId) ??
          ecologyObjects.get(record.systemId)?.objectId ??
          wellbeingObjects.get(record.systemId) ??
          moverObjects.get(record.systemId),
        rank: moverObjects.has(record.systemId)
          ? RANK_MOVEMENT
          : record.systemId === continuousSystemId(PHASE_SYSTEM_KIND, ENVIRONMENT_SYSTEM_VERSION)
            ? RANK_PHASE
            : record.systemId ===
                continuousSystemId(WEATHER_SYSTEM_KIND, ENVIRONMENT_SYSTEM_VERSION)
              ? RANK_WEATHER
              : wellbeingObjects.has(record.systemId)
                ? RANK_WELLBEING
                : (ecologyObjects.get(record.systemId)?.rank ?? RANK_EXPOSURE),
      }))
      .sort((left, right) =>
        left.record.time !== right.record.time
          ? left.record.time < right.record.time
            ? -1
            : 1
          : left.rank !== right.rank
            ? left.rank - right.rank
            : left.rank >= RANK_SPOILAGE && left.objectId !== right.objectId
              ? (left.objectId as string) < (right.objectId as string)
                ? -1
                : 1
              : left.order - right.order,
      );
    const groups: {
      time: SimTimeMs;
      phase: boolean;
      weather: boolean;
      crossings: EnvironmentCrossing[];
      spoiled: string[];
      appeared: string[];
      water: string[];
      stages: EcologyStageChange[];
      needs: { objectId: string; need: WellbeingNeed }[];
      comforts: { objectId: string; comfort: Comfort }[];
      health: { objectId: string; direction: HealthDirection }[];
      deaths: string[];
      movers: string[];
    }[] = [];
    for (const { record, rank, objectId } of records) {
      let group = groups[groups.length - 1];
      if (group === undefined || group.time !== record.time) {
        group = {
          time: record.time,
          phase: false,
          weather: false,
          crossings: [],
          spoiled: [],
          appeared: [],
          water: [],
          stages: [],
          needs: [],
          comforts: [],
          health: [],
          deaths: [],
          movers: [],
        };
        groups.push(group);
      }
      if (rank === RANK_MOVEMENT) group.movers.push(objectId as string);
      else if (rank === RANK_PHASE) group.phase = true;
      else if (rank === RANK_WEATHER) group.weather = true;
      else if (rank === RANK_SPOILAGE) group.spoiled.push(objectId as string);
      else if (rank === RANK_APPEARANCE) group.appeared.push(objectId as string);
      else if (rank === RANK_WATER) group.water.push(objectId as string);
      else if (rank === RANK_STAGE)
        group.stages.push({
          objectId: objectId as string,
          stageIndex: Number(record.name.slice(STAGE_THRESHOLD_PREFIX.length)),
        });
      else if (rank === RANK_WELLBEING)
        for (const label of record.name.split("+")) {
          if (label === WELLBEING_UNCOMFORTABLE)
            group.comforts.push({ objectId: objectId as string, comfort: "uncomfortable" });
          else if (label === WELLBEING_COMFORTABLE)
            group.comforts.push({ objectId: objectId as string, comfort: "comfortable" });
          else if (label === WELLBEING_HEALTH_ENTERED)
            group.health.push({ objectId: objectId as string, direction: "entered" });
          else if (label === WELLBEING_HEALTH_LEFT)
            group.health.push({ objectId: objectId as string, direction: "left" });
          else if (label === WELLBEING_DEATH) group.deaths.push(objectId as string);
          else
            group.needs.push({
              objectId: objectId as string,
              need: label === WELLBEING_HUNGER ? "hunger" : "thirst",
            });
        }
      else
        for (const label of record.name.split("+")) {
          const [threshold, direction] = label.split(".") as [ExposureThreshold, ExposureDirection];
          group.crossings.push({ objectId: objectId as string, threshold, direction });
        }
    }
    const byId = (left: string, right: string): number =>
      left === right ? 0 : left < right ? -1 : 1;
    for (const entry of groups) {
      entry.needs.sort(
        (left, right) =>
          (left.need === right.need ? 0 : left.need === "hunger" ? -1 : 1) ||
          byId(left.objectId, right.objectId),
      );
      entry.comforts.sort((left, right) => byId(left.objectId, right.objectId));
      entry.health.sort((left, right) => byId(left.objectId, right.objectId));
      entry.deaths.sort(byId);
    }
    return Object.freeze(groups.map((entry) => Object.freeze(entry)));
  };
  return Object.freeze({
    setMovers: (movers: readonly EnvironmentMover[]): void => {
      const stale = new Set(moverObjects.keys());
      registry = createDecisionRegistry([...systems, ...movers.map((mover) => mover.system)]);
      moverObjects = new Map(
        movers.map((mover) => [
          continuousSystemId(mover.system.kind, mover.system.version),
          mover.objectId,
        ]),
      );
      states = Object.freeze([
        ...states.filter((state) => !stale.has(state.systemId)),
        ...[...moverObjects.keys()].map((systemId) => ({ systemId, at: position, state: empty })),
      ]);
    },
    reseed: (reseed: EnvironmentReseed): void => {
      const byId = new Map<string, EnvironmentActor>();
      for (const actor of reseed.actors) {
        byId.set(
          continuousSystemId(exposureSystemKind(actor.objectId), ENVIRONMENT_SYSTEM_VERSION),
          actor,
        );
        byId.set(
          continuousSystemId(wellbeingSystemKind(actor.objectId), WELLBEING_SYSTEM_VERSION),
          actor,
        );
      }
      const holders = new Map((reseed.holders ?? []).map((holder) => [holder.objectId, holder]));
      states = Object.freeze(
        states.map((state): CatchUpSystemState => {
          const ecologyObject = ecologyObjects.get(state.systemId);
          if (ecologyObject?.rank === RANK_WATER) {
            const init = reseed.waterHolders?.find(
              (entry) => entry.entry.objectId === ecologyObject.objectId,
            );
            if (init !== undefined)
              return {
                systemId: state.systemId,
                at: position,
                state: waterSystemState({
                  ...init.entry,
                  quantity: init.quantity,
                  protection: init.protection,
                  active: init.active,
                  rain: reseed.rainIntensity,
                  rainUntil: reseed.nextWeatherBoundary,
                }),
              };
            return state;
          }
          const holder =
            ecologyObject === undefined || ecologyObject.rank === RANK_STAGE
              ? undefined
              : holders.get(ecologyObject.objectId);
          if (holder !== undefined)
            return {
              systemId: state.systemId,
              at: position,
              state: holderSystemState(holder.quantity, holder.arrival, holder.active),
            };
          const actor = byId.get(state.systemId);
          if (actor === undefined) return state;
          if (wellbeingObjects.has(state.systemId)) {
            const extra = actor.wellbeing;
            if (extra === undefined)
              throw new RangeError("wellbeing actor without wellbeing state");
            return {
              systemId: state.systemId,
              at: position,
              state: wellbeingSystemState({
                hunger: actor.needs.hunger,
                hungerRemainder: actor.needs.hungerRemainder,
                wetness: actor.needs.wetness,
                wetnessRemainder: actor.needs.wetnessRemainder,
                ...extra,
                protection: actor.protection,
                rain: reseed.rainIntensity,
                rainUntil: reseed.nextWeatherBoundary,
              }),
            };
          }
          return {
            systemId: state.systemId,
            at: position,
            state: exposureSystemState(
              actor.needs,
              actor.protection,
              reseed.rainIntensity,
              reseed.nextWeatherBoundary,
            ),
          };
        }),
      );
    },
    step: (upTo: SimTimeMs): readonly EnvironmentGroup[] => {
      if (upTo <= position) return [];
      const result = catchUpEnvironment(registry, states, position, upTo);
      position = upTo;
      states = result.systems;
      return group(result);
    },
    drain: (queue: ScheduleQueue, target: SimTimeMs, thresholdBudget: number): EnvironmentDrain => {
      const first = queue[0];
      const wanted = first !== undefined && first.dueAt <= target ? first.dueAt : target;
      let to = (wanted < position ? position : wanted) as SimTimeMs;
      // Keep the leg's speculative scheduling order, with lookahead bounded by the event budget.
      to = boundedCatchUpTarget(registry, states, to, thresholdBudget);
      const outcome = catchUpSchedules(registry, {
        engineVersion: CATCH_UP_ENGINE_VERSION,
        queue,
        start: position,
        target: to,
        budget: 1,
        cursor: null,
        systems: states,
        results: [],
      });
      if (!outcome.ok) return refuse(outcome);
      const result = outcome.result;
      return Object.freeze({
        time: to,
        groups: group(result),
        dispatched: result.dispatched[0],
        commit: () => {
          position = to;
          states = result.systems;
        },
      });
    },
  });
}
