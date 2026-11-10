import {
  type AttributionEnvelope,
  type CommandEnvelope,
  type CommandId,
  type DeterministicIdSource,
  decodeAttributionEnvelope,
  type ObjectId,
  type ScheduleId,
  type SimTimeMs,
} from "@clockgrove/contracts";
import {
  CONTAINMENT_COMMAND_TYPES,
  CONTAINMENT_PAYLOAD_SCHEMAS,
  type ContainmentCommand,
  type ContainmentCommandType,
  type ContainmentPayload,
  type CrossingRecord,
  classifyRainChange,
  createWorldState,
  currentInside,
  type DecisionTrace,
  deriveComfort,
  deriveEnvironmentState,
  type EcologyPolicy,
  EnvironmentValidationError,
  ecologyDisagreement,
  environmentDisagreement,
  expectedCrossings,
  isRegionCrossing,
  lifecycleDisagreement,
  MOVEMENT_COMMAND_TYPES,
  type MovementCommand,
  type MovementCommandType,
  type MovementInterruptPayload,
  type MovementRecord,
  movementCompletionTime,
  type NamedRandomState,
  PORTAL_COMMAND_TYPES,
  type PortalCommand,
  type PortalCommandType,
  type PortalTogglePayload,
  parsePortalPayload,
  pendingPortalSteps,
  plantStageIndex,
  portalIsOpen,
  positionAt,
  RESOURCE_KINDS,
  type RoutineCandidate,
  reduceWorldEvent,
  regionsContaining,
  sameCoordinates,
  scriptedCognitionDisagreement,
  validateNamedRandomState,
  validateWorldBehaviorPack,
  validateWorldState,
  WORLD_COMMAND_DEFINITIONS,
  type WorldBehaviorPack,
  type WorldBehaviorPolicy,
  type WorldCommandType,
  type WorldEntity,
  type WorldEvent,
  type WorldNeeds,
  type WorldState,
  wellbeingDisagreement,
  worldEventVersion,
} from "@clockgrove/domain";
import { canonicalSerialize } from "./canonical.js";
import { createDeterministicIdSource } from "./deterministic-id.js";
import { createKernel, type ExecuteOptions, type Kernel } from "./execute/executor.js";
import {
  invalid,
  type Refusal,
  RefusalSignal,
  type RegistrationResult,
  refusal,
} from "./execute/refusal.js";
import {
  CheckRegistry,
  type CommandRegistration,
  CommandRegistry,
  type HandlerContext,
  type HandlerOutput,
  type InvariantContext,
  type PreconditionContext,
} from "./execute/registry.js";
import { lifecycleScheduleId, lifecycleSuccessorId } from "./lifecycle/ids.js";
import {
  CONCEPTION_DECISION_KIND,
  type ConceptionDecision,
  type LifecyclePlan,
  nextLifecycleTime,
  planLifecycleAt,
} from "./lifecycle/plan.js";
import { EventRegistry, ReducerRegistry } from "./reducers/registry.js";
import { PORTAL_OWNER, registerWorldReducers, WORLD_OWNER } from "./reducers/world.js";
import type { ContinuousSystem } from "./scheduler/catch-up.js";
import {
  CATCH_UP_ENGINE_VERSION,
  type CatchUpRegistry,
  catchUpSchedules,
} from "./scheduler/catch-up.js";
import {
  cancelSchedule,
  createScheduleQueue,
  type ScheduledItem,
  type ScheduleQueue,
  upsertSchedule,
} from "./scheduler.js";
import { guardDomain, parseMovementPayloadAtBoundary } from "./spatial/boundary.js";
import {
  type DwellPayload,
  dwellChanges,
  dwellHolds,
  isDwellItem,
  remainedPayload,
  validateDwellItem,
} from "./spatial/dwell.js";
import type { SpatialIndexFactory } from "./spatial/index-port.js";
import {
  crossingEvent,
  type MovementRuntime,
  movementIdFor,
  movementPreconditionPath,
  runMovementHandler,
} from "./spatial/movement.js";
import {
  PORTAL_CHECKS,
  type PortalCheck,
  portalPreconditionPath,
  runPortalUse,
} from "./spatial/portal.js";
import { createQuadtreeSpatialIndex } from "./spatial/quadtree.js";
import {
  createGrowthSystem,
  createWaterSystem,
  type EcologyHolderInit,
  type EcologyPlantInit,
  type EcologyRunOptions,
  type EcologyWaterInit,
  growthSnapshotOf,
  growthSystemState,
  waterSnapshotOf,
  waterSystemState,
} from "./systems/ecology/index.js";
import {
  createEnvironmentRun,
  type EnvironmentGroup,
  type EnvironmentRun,
} from "./systems/environment/index.js";
import { createDecisionRegistry } from "./systems/environment/run.js";
import {
  actorPosition,
  createMovementSystem,
  PLAN_MATCHES_ACTION_CHECK,
  PLANNING_REQUEST_KIND,
  type PlanningRequest,
  planFor,
  planningRequestFor,
  scoreUtility,
  utilityPlanDisagreement,
  utilityRegistryIdentity,
} from "./systems/utility/index.js";
import {
  createWellbeingSystem,
  wellbeingSnapshotOf,
  wellbeingSystemState,
} from "./systems/wellbeing/index.js";
import type {
  DecisionDraft,
  KernelStimulus,
  KernelTransitionInput,
  KernelTransitionResult,
  ProjectionDelta,
  ScheduledKernelInput,
  ScheduleMutation,
  SemanticEventDraft,
} from "./transition.js";

export interface WorldCommandPayload {
  readonly schemaVersion: 1 | 2;
  readonly targetTime: SimTimeMs;
  readonly maxInputs: number;
  readonly maxEvents: number;
  readonly rainIntensity?: number;
  /** `world.advance` only: move time without integrating every actor and plant at the target. */
  readonly lazy?: true;
}
export type WorldCommand = CommandEnvelope<WorldCommandType, WorldCommandPayload>;
export interface WorldDecisionPayload {
  readonly schemaVersion: 1;
  readonly objectId: ObjectId;
}
/** A `world.decision` payload, or the payload of a keyed remain-in-region schedule. */
export type WorldScheduledPayload = WorldDecisionPayload | DwellPayload;
export interface WorldContinuation {
  readonly schemaVersion: 1;
  readonly tenantId: WorldState["tenantId"];
  readonly worldId: WorldState["worldId"];
  readonly timelineId: WorldState["timelineId"];
  readonly partitionId: WorldState["partitionId"];
  /** Exact canonical bindings, not claimed cryptographic hashes. */
  readonly inputIdentity: string;
  readonly stateIdentity: string;
  readonly commandId: CommandId;
  readonly targetTime: SimTimeMs;
  readonly packHash: string;
  readonly policyVersion: string;
  readonly expectedRevision: bigint;
  readonly stage: "scheduled" | "finalize";
}
export interface WorldKernelInput
  extends KernelTransitionInput<
    WorldState,
    KernelStimulus<WorldCommand>,
    WorldBehaviorPolicy,
    WorldBehaviorPack
  > {
  readonly attribution: AttributionEnvelope;
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
  readonly continuation?: WorldContinuation;
  /**
   * Non-canonical, rebuildable index adapter used to narrow movement region candidates. It is never
   * hashed, persisted or part of canonical data; the default is the loose quadtree.
   */
  readonly spatialIndexFactory?: SpatialIndexFactory;
}
export type WorldSemanticEvent = WorldEvent & SemanticEventDraft;
export type WorldScheduleMutation = ScheduleMutation<WorldScheduledPayload> &
  Readonly<{ item?: ScheduledItem<WorldScheduledPayload> }>;
export interface WorldKernelResult
  extends KernelTransitionResult<
    WorldSemanticEvent,
    WorldScheduleMutation,
    ProjectionDelta<WorldState>,
    DecisionDraft<DecisionTrace>
  > {
  readonly state: WorldState;
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
  readonly complete: boolean;
  readonly continuation?: WorldContinuation;
}
/** Refusals are stable `{ code, path, check? }` envelopes; they never carry exception text. */
export type WorldKernelOutcome =
  | Readonly<{ ok: true; result: WorldKernelResult }>
  | Readonly<{ ok: false; error: Refusal }>;
const MAX_TIME = (1n << 63n) - 1n;
const WETNESS_SCALE = 100_000_000n;
/**
 * The events of the world time a movement or portal command passes (see `runWorld`): the events
 * `world.advance` emits for its time, other than `time.advanced`.
 */
const WORLD_TIME_TYPES: readonly string[] = Object.freeze([
  "environment.phase-changed",
  "weather.transitioned",
  "exposure.threshold-crossed",
  "resource.spoiled",
  "resource.appeared",
  "resource.weather-integrated",
  "growth.integrated",
  "growth.stage-changed",
  "needs.changed",
  "wellbeing.integrated",
  "needs.threshold-crossed",
  "comfort.changed",
  "health.threshold-crossed",
  "lifecycle.died",
  "lifecycle.successor-intended",
  "lifecycle.stage-changed",
  "lifecycle.gestation-milestone",
  "lifecycle.born",
  "lifecycle.conceived",
  "routine.selected",
  "location.changed",
  "resource.consumed",
  "needs.relieved",
  "movement.started",
  "movement.replanned",
  "movement.interrupted",
  "movement.completed",
  "movement.region-entered",
  "movement.region-exited",
  "movement.region-remained",
  "movement.portal-crossed",
]);
/** The crossings a moving command's handler emits for its mover. */
const CROSSING_TYPES: readonly string[] = Object.freeze([
  "movement.region-entered",
  "movement.region-exited",
  "movement.region-remained",
  "movement.portal-crossed",
]);
/** The events of the mover's own movement that each moving command owns. */
const OWN_MOVEMENT_TYPES: Readonly<Record<MovementCommandType | "portal.use", readonly string[]>> =
  Object.freeze({
    "movement.start": ["movement.started", "movement.completed"],
    "movement.interrupt": ["movement.interrupted"],
    "movement.replan": ["movement.replanned", "movement.completed"],
    "portal.use": ["movement.started", "movement.completed"],
  });
/**
 * The entity fields each event a moving command journals may change on the object its `objectId`
 * names (`movement.scope@4`). An event type not listed changes no entity field: its state, if any,
 * lives in the world's wellbeing, lifecycle, ecology or environment records. `lifecycle.born` adds
 * the entity its `childId` names instead.
 */
const MOVING_ENTITY_FIELDS: Readonly<Record<string, readonly (keyof WorldEntity)[]>> =
  Object.freeze({
    "needs.changed": ["needs"],
    "needs.relieved": ["needs"],
    "resource.spoiled": ["resource"],
    "resource.appeared": ["resource"],
    "resource.weather-integrated": ["resource"],
    "growth.stage-changed": ["resource"],
    "resource.consumed": ["resource"],
    "routine.selected": ["selectedAction"],
    "location.changed": ["locationId"],
    "lifecycle.died": ["lifecycle"],
    "movement.started": ["movement"],
    "movement.region-entered": ["movement"],
    "movement.region-exited": ["movement"],
    "movement.portal-crossed": ["movement"],
    "movement.replanned": ["movement", "pose"],
    "movement.interrupted": ["movement", "pose"],
    "movement.completed": ["movement", "pose"],
  });
/**
 * The only event a moving command may journal twice with the same time and payload
 * (`movement.events-ordered-and-unique@3`): two actors eating from one holder at one time.
 */
const REPEATABLE_MOVING_TYPES: ReadonlySet<string> = new Set(["resource.consumed"]);
/** The movement events that begin, change or end one mover's movement (not its crossings). */
const MOVEMENT_LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  "movement.started",
  "movement.replanned",
  "movement.interrupted",
  "movement.completed",
]);
/** The events a movement or portal command's own handler may emit. */
function handlerTypes(command: string): readonly string[] {
  if (command === "portal.open") return ["portal.opened"];
  if (command === "portal.close") return ["portal.closed"];
  return [
    ...(OWN_MOVEMENT_TYPES[command as keyof typeof OWN_MOVEMENT_TYPES] ?? []),
    ...CROSSING_TYPES,
  ];
}
/**
 * The world time a moving command may pass (`movement.passed-time@2`): at most one decision interval
 * of the world policy, and no more events or decisions than one `world.advance` call.
 */
const PASSED_TIME_CHECK = "movement.passed-time";
const PASSED_TIME_VERSION = 2;
/** The event budget of one `world.advance` call (its payload's ceiling), and of one moving command. */
const MAX_EVENTS_PER_CALL = 4096;
/** The decision budget of one `world.advance` call (its payload's ceiling), and of one moving command. */
const MAX_INPUTS_PER_CALL = 1024;

const ENVIRONMENT_CHECK = "environment.state-matches-policy";
const ECOLOGY_CHECK = "ecology.state-matches-policy";
const WELLBEING_CHECK = "wellbeing.state-matches-policy";
const LIFECYCLE_CHECK = "lifecycle.state-matches-policy";
const FIRST_DUE_CHECK = "world.decision.first-due";
/** A scheduled decision runs one `world.advance` step with this event budget. */
const SCHEDULED_MAX_EVENTS = 4096;
/**
 * Invariant subjects carry no pack, so the policy of the call being executed is held here for the
 * synchronous duration of that call only (set and restored by `withActivePolicy`).
 */
let activePolicy: WorldBehaviorPolicy | undefined;

function withActivePolicy<T>(policy: WorldBehaviorPolicy | undefined, run: () => T): T {
  const previous = activePolicy;
  activePolicy = policy;
  try {
    return run();
  } finally {
    activePolicy = previous;
  }
}

function policyOf(input: unknown): WorldBehaviorPolicy | undefined {
  try {
    const policy = (input as WorldKernelInput).pack.pack.policy;
    return typeof policy === "object" && policy !== null ? policy : undefined;
  } catch {
    return undefined;
  }
}

interface WorldHandlerExtra {
  readonly schedules: ScheduleQueue<WorldScheduledPayload>;
  readonly complete: boolean;
  readonly stage: WorldContinuation["stage"];
  readonly inputIdentity: string;
}

export type ContainmentKernelInput = Omit<WorldKernelInput, "input"> & {
  readonly input: KernelStimulus<ContainmentCommand>;
};

export type MovementKernelInput = Omit<WorldKernelInput, "input"> & {
  readonly input: KernelStimulus<MovementCommand>;
};

export type PortalKernelInput = Omit<WorldKernelInput, "input"> & {
  readonly input: KernelStimulus<PortalCommand>;
};

type WorldContext = HandlerContext<WorldState, WorldKernelInput, WorldEvent>;

/**
 * The needs actors that are still alive. Without lifecycle state nothing ever dies, so every needs
 * actor is returned and non-lifecycle behavior is unchanged.
 */
function livingActorsOf(state: WorldState): WorldEntity[] {
  return state.entities.filter(
    (entity) =>
      entity.needs !== undefined &&
      (state.lifecycle === undefined || entity.lifecycle?.status !== "dead"),
  );
}

/** Initializes explicit, owned scheduling state; callers retain it alongside the physical projection. */
export function createWorldSchedules(
  state: WorldState,
  pack: WorldBehaviorPack,
  ids: DeterministicIdSource,
): ScheduleQueue<WorldScheduledPayload> {
  const canonical = createWorldState(state);
  validateWorldBehaviorPack(pack);
  return createScheduleQueue(
    livingActorsOf(canonical).map((entity, index) => {
      const source = createDeterministicIdSource({ ...ids.seed, eventIndex: index });
      return decisionSchedule(
        canonical,
        entity.objectId,
        source.next("ScheduleId"),
        canonical.simulationTime,
      );
    }),
  );
}

/** Full-input validation that precedes the registry-driven checks; refusals are `invalid-input`. */
let decisionRegistry: CatchUpRegistry | undefined;

/**
 * The scheduled input the catch-up engine dispatches for one `world.decision` item: the exact
 * `ScheduledKernelInput` (and engine command id) a caller must present to `executeWorldKernel`.
 */
export function dispatchWorldDecision(
  item: ScheduledItem<WorldScheduledPayload>,
): ScheduledKernelInput<"world.decision", WorldScheduledPayload> {
  decisionRegistry ??= createDecisionRegistry([]);
  const outcome = catchUpSchedules(decisionRegistry, {
    engineVersion: CATCH_UP_ENGINE_VERSION,
    queue: [item],
    start: item.dueAt,
    target: item.dueAt,
    budget: 1,
    cursor: null,
    systems: [],
    results: [],
  });
  const dispatched = outcome.ok ? outcome.result.dispatched[0] : undefined;
  if (dispatched === undefined) throw new RangeError("the decision item cannot be dispatched");
  return dispatched as ScheduledKernelInput<"world.decision", WorldScheduledPayload>;
}

function decodeScheduledInput(input: WorldKernelInput): WorldState {
  const scheduled = (input.input as { scheduled: ScheduledKernelInput }).scheduled;
  let state: WorldState;
  try {
    state = createWorldState(input.partition.state);
  } catch (error) {
    return invalid(
      error instanceof EnvironmentValidationError ? `partition.${error.path}` : "partition.state",
    );
  }
  const pack = input.pack.pack;
  const policy = pack.policy;
  try {
    validateWorldBehaviorPack(pack);
  } catch (error) {
    return invalid(
      error instanceof EnvironmentValidationError ? `pack.pack.${error.path}` : "pack.pack",
    );
  }
  const scriptedProblem = scriptedCognitionDisagreement(policy, state);
  if (scriptedProblem !== undefined) return invalid(`partition.${scriptedProblem}`);
  try {
    validateNamedRandomState(input.randomState);
  } catch {
    return invalid("randomState");
  }
  if (policy.lifecycle !== undefined && !Object.hasOwn(input.randomState, "lifecycle"))
    return invalid("randomState.lifecycle");
  try {
    decodeAttributionEnvelope(input.attribution);
  } catch {
    return invalid("attribution");
  }
  if (
    input.partition.schemaVersion !== 1 ||
    input.partition.partitionId !== state.partitionId ||
    input.partition.revision !== state.revision
  )
    return invalid("partition");
  if (input.simulationTime !== state.simulationTime) return invalid("simulationTime");
  if (
    input.pack.schemaVersion !== 1 ||
    input.pack.packId !== pack.packId ||
    input.pack.packVersion !== pack.packVersion
  )
    return invalid("pack");
  if (
    input.policies.schemaVersion !== 1 ||
    canonicalSerialize(input.policies.policy) !== canonicalSerialize(policy) ||
    input.policies.policyVersions.routine !== policy.version
  )
    return invalid("policies");
  if (input.continuation !== undefined) return invalid("continuation");
  const actors = livingActorsOf(state);
  let schedules: ScheduleQueue<WorldScheduledPayload>;
  try {
    schedules = createScheduleQueue(input.schedules);
    validateDecisionQueue(state, schedules, actors);
  } catch {
    return invalid("schedules");
  }
  const item = schedules.find((candidate) => candidate.id === scheduled.scheduleId);
  if (item === undefined) return invalid("input.scheduled.scheduleId");
  if (
    scheduled.payload === null ||
    typeof scheduled.payload !== "object" ||
    (scheduled.payload as { objectId?: unknown }).objectId !== item.payload.objectId
  )
    return invalid("input.scheduled.payload.objectId");
  let expected: string;
  try {
    expected = dispatchWorldDecision(item).commandId;
  } catch {
    return invalid("input.scheduled.scheduleId");
  }
  if (scheduled.commandId !== expected) return invalid("input.scheduled.commandId");
  if (input.ids.seed.commandId !== scheduled.commandId) return invalid("ids.seed.commandId");
  return state;
}

function decodeWorldInput(input: WorldKernelInput): WorldState {
  const stimulus = input.input;
  if (stimulus.kind === "scheduled") return decodeScheduledInput(input);
  if (stimulus.kind !== "command") return invalid("input.kind");
  const command = stimulus.command;
  let state: WorldState;
  try {
    state = createWorldState(input.partition.state);
  } catch (error) {
    return invalid(
      error instanceof EnvironmentValidationError ? `partition.${error.path}` : "partition.state",
    );
  }
  const pack = input.pack.pack;
  const policy = pack.policy;
  try {
    validateWorldBehaviorPack(pack);
  } catch (error) {
    return invalid(
      error instanceof EnvironmentValidationError ? `pack.pack.${error.path}` : "pack.pack",
    );
  }
  const scriptedProblem = scriptedCognitionDisagreement(policy, state);
  if (scriptedProblem !== undefined) return invalid(`partition.${scriptedProblem}`);
  try {
    validateNamedRandomState(input.randomState);
  } catch {
    return invalid("randomState");
  }
  if (policy.lifecycle !== undefined && !Object.hasOwn(input.randomState, "lifecycle"))
    return invalid("randomState.lifecycle");
  let attribution: AttributionEnvelope;
  try {
    attribution = decodeAttributionEnvelope(input.attribution);
  } catch {
    return invalid("attribution");
  }
  if (
    input.partition.schemaVersion !== 1 ||
    input.partition.partitionId !== state.partitionId ||
    input.partition.revision !== state.revision
  )
    return invalid("partition");
  if (command.schemaVersion !== 1) return invalid("command.schemaVersion");
  if (input.simulationTime !== state.simulationTime) return invalid("simulationTime");
  if (
    command.simulationTime !== undefined &&
    (typeof command.simulationTime !== "bigint" ||
      command.simulationTime < 0n ||
      command.simulationTime > state.simulationTime)
  )
    return invalid("command.simulationTime");
  if (
    command.target.version !== 1 ||
    command.target.kind !== "world" ||
    command.target.id !== state.worldId ||
    command.target.tenantId !== state.tenantId ||
    command.target.worldId !== state.worldId ||
    command.target.timelineId !== state.timelineId
  )
    return invalid("command.target");
  const { authorityDecisionId: _authority, ...intent } = attribution;
  if (canonicalSerialize(intent) !== canonicalSerialize(command.attribution))
    return invalid("command.attribution");
  if (input.ids.seed.commandId !== command.commandId) return invalid("ids.seed.commandId");
  if (
    input.pack.schemaVersion !== 1 ||
    input.pack.packId !== pack.packId ||
    input.pack.packVersion !== pack.packVersion
  )
    return invalid("pack");
  if (
    input.policies.schemaVersion !== 1 ||
    canonicalSerialize(input.policies.policy) !== canonicalSerialize(policy) ||
    input.policies.policyVersions.routine !== policy.version
  )
    return invalid("policies");
  const actors = livingActorsOf(state);
  const continuation = input.continuation;
  if (continuation !== undefined) {
    let schedules: ScheduleQueue<WorldScheduledPayload>;
    try {
      schedules = createScheduleQueue(input.schedules);
    } catch {
      return invalid("schedules");
    }
    if (
      command.type !== "world.advance" ||
      continuation.schemaVersion !== 1 ||
      continuation.tenantId !== state.tenantId ||
      continuation.worldId !== state.worldId ||
      continuation.timelineId !== state.timelineId ||
      continuation.partitionId !== state.partitionId ||
      continuation.inputIdentity !== worldInputIdentity(input, command, attribution) ||
      continuation.stateIdentity !== canonicalSerialize({ state, schedules }) ||
      continuation.commandId !== command.commandId ||
      continuation.targetTime !== command.payload.targetTime ||
      continuation.packHash !== pack.contentHash ||
      continuation.policyVersion !== policy.version ||
      !["scheduled", "finalize"].includes(continuation.stage)
    )
      return invalid("continuation");
  }
  try {
    validateDecisionQueue(state, createScheduleQueue(input.schedules), actors);
  } catch {
    return invalid("schedules");
  }
  return state;
}

function worldInputIdentity(
  input: WorldKernelInput,
  command: WorldCommand,
  attribution: AttributionEnvelope,
  randomState: NamedRandomState = input.randomState,
): string {
  // Every named random stream, including `lifecycle`, is bound. A stopped call records the
  // identity over its kept (rolled-back) random state, so a continuation must present exactly that.
  return canonicalSerialize({
    command,
    pack: input.pack,
    policies: input.policies,
    attribution,
    randomState,
    idSeed: input.ids.seed,
  });
}

function validateWorldPayload(payload: unknown, { state }: { readonly state: WorldState }): void {
  const value = payload as WorldCommandPayload;
  if (
    typeof value.targetTime !== "bigint" ||
    value.targetTime < state.simulationTime ||
    value.targetTime > MAX_TIME
  )
    invalid("payload.targetTime");
  if (value.lazy !== undefined && value.lazy !== true) invalid("payload.lazy");
  const actors = livingActorsOf(state);
  // Every plant is integrated wherever the actors are, so the smallest budget covers them too.
  const plantCount =
    (state.ecology?.plants.length ?? 0) + (state.ecology?.waterHolders?.length ?? 0);
  // With wellbeing every integration is a needs event plus a wellbeing event.
  const perActor = state.wellbeing === undefined ? 1 : 2;
  if (
    !Number.isSafeInteger(value.maxInputs) ||
    value.maxInputs < 1 ||
    value.maxInputs > MAX_INPUTS_PER_CALL
  )
    invalid("payload.maxInputs");
  if (
    !Number.isSafeInteger(value.maxEvents) ||
    value.maxEvents < perActor * actors.length + plantCount + 1 ||
    value.maxEvents > MAX_EVENTS_PER_CALL
  )
    invalid("payload.maxEvents");
}

/** `world.weather.set` v2 carries only the intensity: it applies at the command's own time. */
function validateWeatherV2(payload: unknown): void {
  const keys = Object.keys(payload as object)
    .sort()
    .join();
  if (keys !== "rainIntensity,schemaVersion") invalid("payload");
}

function runWorldCommand(context: WorldContext): HandlerOutput<WorldState, WorldHandlerExtra> {
  const command = context.command as WorldCommand;
  const attribution = decodeAttributionEnvelope(context.input.attribution);
  const state = context.state;
  // Version 2 has no budget fields: the command integrates every actor and plant once and emits one event.
  const payload =
    command.payload.schemaVersion === 2
      ? {
          ...command.payload,
          targetTime: state.simulationTime,
          maxInputs: 1,
          maxEvents:
            (state.wellbeing === undefined ? 1 : 2) * livingActorsOf(state).length +
            (state.ecology?.plants.length ?? 0) +
            (state.ecology?.waterHolders?.length ?? 0) +
            1,
        }
      : command.payload;
  return runWorld(context, {
    type: command.type,
    payload,
    inputIdentity: (random) => worldInputIdentity(context.input, command, attribution, random),
  });
}

/**
 * The accepted scheduled `world.decision`: exactly one `world.advance` step that stops after the
 * decision it was dispatched for. It refuses unless that decision is the first due, unchanged.
 */
function runScheduledDecision(context: WorldContext): HandlerOutput<WorldState, WorldHandlerExtra> {
  const scheduled = (context.input.input as { scheduled: ScheduledKernelInput }).scheduled;
  const first = decisionsOf(createScheduleQueue(context.input.schedules))[0];
  if (first === undefined || first.id !== scheduled.scheduleId)
    throw new RefusalSignal(
      refusal("precondition-failed", "input.scheduled.scheduleId", `${FIRST_DUE_CHECK}@1`),
    );
  return runWorld(context, {
    type: "world.advance",
    payload: {
      schemaVersion: 1,
      targetTime: first.dueAt,
      maxInputs: 1,
      maxEvents: SCHEDULED_MAX_EVENTS,
    },
    inputIdentity: () => canonicalSerialize(scheduled),
    scheduled: { scheduleId: first.id, dueAt: first.dueAt },
  });
}

interface WorldRunSpec {
  readonly type: WorldCommandType | MovementCommandType | PortalCommandType;
  readonly payload: WorldCommandPayload;
  readonly inputIdentity: (keptRandom: NamedRandomState) => string;
  readonly scheduled?: { readonly scheduleId: ScheduleId; readonly dueAt: SimTimeMs };
  /** A movement or portal command: its handler, run on the runtime the world time passes through. */
  readonly move?: (rt: MovementRuntime) => void;
}

function runWorld(
  context: WorldContext,
  spec: WorldRunSpec,
): HandlerOutput<WorldState, WorldHandlerExtra> {
  const { input } = context;
  const startState = context.state;
  const startRevision = startState.revision;
  const pack = input.pack.pack;
  const policy = pack.policy;
  const attribution = decodeAttributionEnvelope(input.attribution);
  const payload = spec.payload;
  /**
   * The object a movement or portal command moves. Its movement events come only from the command,
   * never from the routine-movement systems, and its decision waits for the command's end.
   */
  const mover =
    spec.move === undefined
      ? undefined
      : (context.payload as { readonly objectId?: string }).objectId;
  const actors = livingActorsOf(startState);
  let schedules = createScheduleQueue(input.schedules);
  const scheduleMutations: WorldScheduleMutation[] = [];
  const decisionDrafts: DecisionDraft<DecisionTrace | ConceptionDecision | PlanningRequest>[] = [];
  /** Simulation time each lifecycle draft/draw belongs to, for rollback to the final time. */
  const draftTimes: bigint[] = [];
  const lifecyclePolicy = policy.lifecycle;
  /** The `lifecycle` stream state after each emitted lifecycle group (rolled back to the final time). */
  let lifecycleRandom: NamedRandomState = input.randomState;
  const randomLog: { time: bigint; random: NamedRandomState }[] = [];
  function current(): WorldState {
    return context.workingState();
  }
  function emit(event: WorldEvent): void {
    if (
      context.eventCount() >= payload.maxEvents ||
      current().revision > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new RangeError("event adoption budget or deterministic index exhausted");
    context.emit(event);
    // Entries, exits, remains, deaths and retirements keep the keyed dwell schedules current.
    for (const change of dwellChanges(schedules, current(), event)) {
      scheduleMutations.push(change as WorldScheduleMutation);
      if (change.kind === "cancel") schedules = cancelSchedule(schedules, change.scheduleId);
      else {
        schedules = upsertSchedule(schedules, change.item);
        if (armedDue === undefined || change.dueAt < armedDue) armedDue = change.dueAt;
      }
    }
  }
  /** The earliest dwell armed since the last engine drain; a drain past it must restart there. */
  let armedDue: SimTimeMs | undefined;
  /**
   * Emits the dwells due at or before `at` (after every other event at their time): a
   * `movement.region-remained` when the object is still inside, else just the cancellation.
   * Returns false, leaving the rest queued, when the event budget is spent.
   */
  function fireDwells(at: SimTimeMs): boolean {
    for (const item of schedules.filter((entry) => isDwellItem(entry) && entry.dueAt <= at)) {
      const dwell = item.payload as DwellPayload;
      if (dwellHolds(current(), dwell, item.dueAt)) {
        if (context.eventCount() >= payload.maxEvents) return false;
        emit(event("movement.region-remained", item.dueAt, remainedPayload(dwell)));
      } else {
        schedules = cancelSchedule(schedules, item.id);
        scheduleMutations.push(Object.freeze({ kind: "cancel", scheduleId: item.id }));
      }
    }
    return true;
  }
  function event<T extends WorldEvent["type"]>(
    type: T,
    time: SimTimeMs,
    data: Extract<WorldEvent, { type: T }>["payload"],
  ): WorldEvent {
    const state = current();
    return {
      schemaVersion: worldEventVersion(type),
      tenantId: state.tenantId,
      worldId: state.worldId,
      timelineId: state.timelineId,
      partitionId: state.partitionId,
      simulationTime: time,
      attribution,
      policyVersions: input.policies.policyVersions,
      type,
      payload: data,
    } as WorldEvent;
  }
  function integrate(actor: WorldEntity, through: SimTimeMs): void {
    const needs = integrateNeeds(current(), actor, through, policy);
    if (needs !== undefined && canonicalSerialize(needs) !== canonicalSerialize(actor.needs))
      emit(event("needs.changed", through, { objectId: actor.objectId, ...needs }));
  }
  /**
   * Wellbeing (RW-0108a) is integrated wherever needs are: one wellbeing system per needs actor,
   * the same arithmetic the engine integrates, journaled as `wellbeing.integrated`.
   */
  const wellbeingPolicy = policy.wellbeing;
  const perActor = wellbeingPolicy === undefined ? 1 : 2;
  const wellbeingSystems = new Map<string, ContinuousSystem>();
  function wellbeingSystemFor(objectId: ObjectId): ContinuousSystem | undefined {
    if (policy.environment === undefined || wellbeingPolicy === undefined) return undefined;
    let system = wellbeingSystems.get(objectId);
    if (system === undefined) {
      system = createWellbeingSystem({
        objectId,
        environment: policy.environment,
        wellbeing: wellbeingPolicy,
        decisionIntervalMs: policy.decisionIntervalMs,
        integrate: (needs, protection, rain, through) =>
          integrateNeedsWith(needs, protection, rain, through, policy),
      });
      wellbeingSystems.set(objectId, system);
    }
    return system;
  }
  /** An actor's thirst and health integrated through `through`; no events. */
  function wellbeingThrough(actor: WorldEntity, through: SimTimeMs) {
    return wellbeingAt(current(), actor, through, wellbeingSystemFor(actor.objectId));
  }
  /** Needs, then wellbeing, integrated through `through` (each only when it changes). */
  function integrateActor(actor: WorldEntity, through: SimTimeMs): void {
    const entity =
      current().entities.find((candidate) => candidate.objectId === actor.objectId) ?? actor;
    const next = wellbeingThrough(entity, through);
    integrate(entity, through);
    const entry = current().wellbeing?.entries.find(
      (candidate) => candidate.objectId === actor.objectId,
    );
    if (next !== undefined && entry !== undefined && entry.integratedAt !== through)
      emit(
        event("wellbeing.integrated", through, {
          objectId: actor.objectId,
          ...next,
          integratedAt: through,
        }),
      );
  }
  /** Events one integration of this actor through `through` would journal. */
  function integrationEvents(actor: WorldEntity, through: SimTimeMs): number {
    const needs = integrateNeeds(current(), actor, through, policy);
    const needsEvent =
      needs !== undefined && canonicalSerialize(needs) !== canonicalSerialize(actor.needs) ? 1 : 0;
    const entry = current().wellbeing?.entries.find(
      (candidate) => candidate.objectId === actor.objectId,
    );
    return needsEvent + (entry !== undefined && entry.integratedAt !== through ? 1 : 0);
  }
  /**
   * Plants (RW-0107b) are integrated wherever the needs actors are. Their growth system calls the
   * same `integrateNeedsWith` through the injected integrator; there is no second wetness formula.
   */
  const ecologyPolicy = policy.ecology;
  const waterTotal = ecologyPolicy?.waterHolders?.length ?? 0;
  const plantTotal = (ecologyPolicy?.plants.length ?? 0) + waterTotal;
  const growthSystems = new Map<string, ContinuousSystem>();
  if (ecologyPolicy !== undefined && policy.environment !== undefined)
    for (const plant of ecologyPolicy.plants)
      growthSystems.set(
        plant.objectId,
        createGrowthSystem({
          plant,
          environment: policy.environment,
          integrate: (needs, protection, rain, through) =>
            integrateNeedsWith(needs, protection, rain, through, policy),
        }),
      );
  /** The plants that a journaled integration through `through` would change. */
  function pendingPlants(through: SimTimeMs): readonly string[] {
    const state = current();
    return (state.ecology?.plants ?? [])
      .filter((entry) => {
        const entity = state.entities.find((candidate) => candidate.objectId === entry.objectId);
        return entity !== undefined && active(entity) && entry.integratedAt < through;
      })
      .map((entry) => entry.objectId);
  }
  function integratePlant(objectId: string, through: SimTimeMs): void {
    const next = plantAt(current(), objectId, through, growthSystems.get(objectId));
    if (next === undefined) return;
    emit(
      event("growth.integrated", through, {
        objectId: objectId as ObjectId,
        ...next,
        integratedAt: through,
      }),
    );
  }
  function integratePlants(through: SimTimeMs, includeWater = true): void {
    if (includeWater) integrateWaters(through);
    for (const objectId of pendingPlants(through)) integratePlant(objectId, through);
  }
  function pendingWater(through: SimTimeMs): readonly string[] {
    return (current().ecology?.waterHolders ?? [])
      .filter((entry) => entry.integratedAt < through)
      .map((entry) => entry.objectId)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }
  function integrateWater(objectId: string, through: SimTimeMs): void {
    const next = waterAt(current(), objectId, through, policy);
    if (next !== undefined) emit(event("resource.weather-integrated", through, next));
  }
  function integrateWaters(through: SimTimeMs): void {
    for (const id of pendingWater(through)) integrateWater(id, through);
  }
  function currentActorOf(objectId: ObjectId): WorldEntity {
    const found = current().entities.find((entity) => entity.objectId === objectId);
    if (found === undefined) throw new RangeError("scheduled actor disappeared");
    return found;
  }
  /** Whether the moving command's mover has died in the time it passed. */
  function moverDied(): boolean {
    if (mover === undefined) return false;
    const entity = current().entities.find((candidate) => candidate.objectId === mover);
    return entity?.lifecycle?.status === "dead";
  }
  function reschedule(item: ScheduledItem<WorldScheduledPayload>, dueAt: SimTimeMs): void {
    const next = Object.freeze({
      ...item,
      dueAt,
      payload: Object.freeze({ ...item.payload }),
      idempotencyKey: `${item.id}:${dueAt}`,
    });
    schedules = upsertSchedule(schedules, next);
    scheduleMutations.push(
      Object.freeze({
        kind: "upsert",
        scheduleId: next.id,
        dueAt: next.dueAt,
        payload: next.payload,
        item: next,
      }),
    );
  }
  /**
   * Utility decisions (RW-0108b): scoring, routine movement plans, arrivals. Everything below is
   * inert without a `utility` policy, so outputs without it are unchanged.
   */
  const utilityPolicy = policy.utility;
  const objectsOf = (state: WorldState, objectId: string): WorldEntity | undefined =>
    state.entities.find((candidate) => candidate.objectId === objectId);
  type Derived = ReturnType<typeof deriveComfort>;
  interface ArrivalPlan {
    readonly consume?: {
      readonly holder: string;
      readonly kind: "food" | "water";
      readonly quantity: number;
    };
    readonly relieve?: { readonly need: "hunger" | "thirst"; readonly value: number };
    readonly location?: string | null;
    readonly comfort?: Derived;
  }
  const arrivalEventCount = (plan: ArrivalPlan): number =>
    (plan.location === undefined ? 0 : 1) +
    (plan.consume === undefined ? 0 : 2) +
    (plan.comfort === undefined ? 0 : 1);
  /**
   * The arrival effects at a target for an actor whose needs are integrated in `state`. A move
   * (`moved`: completed, or a walk stopped at the target) ends in the shelter standing at the
   * target, if any; an actor that was already standing there enters only the shelter it sought.
   */
  function arrivalPlan(
    state: WorldState,
    actor: WorldEntity,
    targetId: string | undefined,
    baseline: Derived["comfort"] | undefined,
    held: ReadonlyMap<string, number>,
    moved: boolean,
  ): ArrivalPlan {
    const target = targetId === undefined ? undefined : objectsOf(state, targetId);
    const entry = state.wellbeing?.entries.find(
      (candidate) => candidate.objectId === actor.objectId,
    );
    const needs = actor.needs;
    const environmentPolicy = policy.environment;
    if (
      utilityPolicy === undefined ||
      target === undefined ||
      !active(target) ||
      needs === undefined ||
      entry === undefined ||
      environmentPolicy === undefined ||
      wellbeingPolicy === undefined
    )
      return {};
    const was = actor.locationId ?? null;
    const location = moved
      ? shelterAt(state, actor, target.pose.coordinates, target.objectId)
      : target.shelter !== undefined
        ? target.objectId
        : was;
    const located = location === was ? {} : { location };
    const resource = target.resource;
    if (resource !== undefined && (resource.kind === "food" || resource.kind === "water")) {
      const available = held.get(target.objectId) ?? resource.quantity;
      const quantity = Math.min(utilityPolicy.biteQuantity, available);
      if (quantity <= 0) return located;
      const food = resource.kind === "food";
      const current = food ? needs.hunger : entry.thirst;
      const drop =
        BigInt(quantity) *
        BigInt(food ? utilityPolicy.hungerReliefPerUnit : utilityPolicy.thirstReliefPerUnit);
      const value = drop >= BigInt(current) ? 0 : current - Number(drop);
      const derived = deriveComfort(environmentPolicy, wellbeingPolicy, {
        hunger: food ? value : needs.hunger,
        thirst: food ? entry.thirst : value,
        wetness: needs.wetness,
      });
      return {
        ...located,
        consume: { holder: target.objectId, kind: resource.kind, quantity },
        relieve: { need: food ? "hunger" : "thirst", value },
        ...(derived.comfort === (baseline ?? entry.comfort) ? {} : { comfort: derived }),
      };
    }
    return located;
  }
  /** A copy of the state with one actor's needs and wellbeing integrated through `through`. */
  function viewAt(objectId: string, through: SimTimeMs): WorldState {
    const state = current();
    const actor = objectsOf(state, objectId);
    if (actor === undefined) throw new RangeError("view of an unknown actor");
    const needs = integrateNeeds(state, actor, through, policy) ?? actor.needs;
    const extra = wellbeingThrough(actor, through);
    return {
      ...state,
      entities: state.entities.map((entity) =>
        entity.objectId === objectId ? { ...entity, needs } : entity,
      ),
      ...(state.wellbeing === undefined || extra === undefined
        ? {}
        : {
            wellbeing: {
              ...state.wellbeing,
              entries: state.wellbeing.entries.map((entry) =>
                entry.objectId === objectId ? { ...entry, ...extra, integratedAt: through } : entry,
              ),
            },
          }),
    } as unknown as WorldState;
  }
  function pendingCrossings(movement: MovementRecord, upTo: bigint) {
    return expectedCrossings(movement, startState.spatialRegions ?? [])
      .slice(movement.emitted.length)
      .filter((crossing) => crossing.time <= upTo);
  }
  function emitCrossings(
    objectId: string,
    movementId: string,
    crossings: readonly CrossingRecord[],
  ): void {
    for (const crossing of crossings) {
      const [type, payload] = crossingEvent(objectId, movementId, crossing);
      emit(event(type as never, crossing.time as SimTimeMs, payload as never));
    }
  }
  /**
   * The plan a movement `world.advance` completes belongs to: the decision plan that started or
   * replanned it when its id is the one that decision's dispatch derives (`movementIdFor` of the
   * actor's decision command at the movement's start), else the movement itself, which a moving
   * command started and the world time finished.
   */
  function completedPlanId(objectId: string, movement: MovementRecord): string {
    const start = movement.segment.startTime as SimTimeMs;
    const item = decisionsOf(schedules).find((entry) => entry.payload.objectId === objectId);
    if (item !== undefined) {
      const decision = dispatchWorldDecision({
        ...item,
        dueAt: start,
        idempotencyKey: `${item.id}:${start}`,
      });
      if (movementIdFor(decision.commandId) === movement.movementId)
        return `plan:${objectId}@${start}`;
    }
    return movement.movementId;
  }
  /** The inventory arrivals and decisions observe after this time's water integration. */
  function waterViewAt(state: WorldState, through: SimTimeMs): WorldState {
    const pending = pendingWater(through);
    if (pending.length === 0) return state;
    const changes = new Map(pending.map((id) => [id, waterAt(current(), id, through, policy)!]));
    return {
      ...state,
      entities: state.entities.map((entity) => {
        const change = changes.get(entity.objectId);
        return change === undefined || entity.resource === undefined
          ? entity
          : {
              ...entity,
              resource: {
                ...entity.resource,
                quantity: entity.resource.quantity + change.collected - change.evaporated,
              },
            };
      }),
    };
  }
  /** The immediate-or-completed (`moved`) arrival effects, journaled from the live state. */
  function emitArrival(objectId: string, planId: string, at: SimTimeMs, moved: boolean): void {
    const actor = objectsOf(current(), objectId);
    if (actor === undefined) throw new RangeError("arriving actor disappeared");
    const plan = arrivalPlan(
      current(),
      actor,
      actor.selectedAction?.targetObjectId,
      undefined,
      new Map(),
      moved,
    );
    if (plan.location !== undefined)
      emit(
        event("location.changed", at, {
          objectId: objectId as ObjectId,
          locationId: plan.location as ObjectId | null,
          planId,
        }),
      );
    if (plan.consume !== undefined && plan.relieve !== undefined) {
      emit(
        event("resource.consumed", at, {
          objectId: plan.consume.holder as ObjectId,
          kind: plan.consume.kind,
          quantity: plan.consume.quantity,
        } as never),
      );
      emit(
        event("needs.relieved", at, {
          objectId: objectId as ObjectId,
          need: plan.relieve.need,
          sourceObjectId: plan.consume.holder as ObjectId,
          quantity: plan.consume.quantity,
          value: plan.relieve.value,
          planId,
        }),
      );
    }
    if (plan.comfort !== undefined)
      emit(
        event("comfort.changed", at, {
          objectId: objectId as ObjectId,
          comfort: plan.comfort.comfort,
          causes: plan.comfort.causes,
        }),
      );
  }
  type DecisionStep =
    | {
        readonly kind: "crossings";
        readonly movementId: string;
        readonly crossings: readonly CrossingRecord[];
      }
    | {
        readonly kind: "interrupt";
        readonly movementId: string;
        readonly position: readonly bigint[];
      }
    | {
        readonly kind: "replan";
        readonly priorMovementId: string;
        readonly position: readonly bigint[];
        readonly record: MovementRecord;
      }
    | { readonly kind: "unlocate" }
    | { readonly kind: "locate"; readonly locationId: string | null }
    | { readonly kind: "start"; readonly record: MovementRecord }
    | { readonly kind: "arrive"; readonly events: number; readonly walked: boolean };
  interface DecisionPlan {
    readonly steps: readonly DecisionStep[];
    readonly links: readonly string[];
  }
  /** What a selected action does to the actor's routine movement at `t` (pure). */
  function planDecision(
    state: WorldState,
    actor: WorldEntity,
    selected: { readonly kind: string; readonly targetObjectId?: string },
    target: WorldEntity | undefined,
    priorAction: { readonly kind: string; readonly targetObjectId?: string } | undefined,
    t: SimTimeMs,
    commandId: string,
  ): DecisionPlan {
    if (utilityPolicy === undefined) throw new RangeError("decision plan without a utility policy");
    const steps: DecisionStep[] = [];
    const links: string[] = [];
    const prior = actor.movement?.status === "active" ? actor.movement : undefined;
    let stopped: MovementRecord | undefined = prior;
    const stopPrior = (): void => {
      if (prior === undefined) return;
      const crossings = pendingCrossings(prior, t);
      if (crossings.length > 0)
        steps.push({ kind: "crossings", movementId: prior.movementId, crossings });
      stopped = { ...prior, emitted: [...prior.emitted, ...crossings] };
    };
    if (target === undefined) {
      if (prior !== undefined) {
        stopPrior();
        const position = positionAt(prior.segment, t);
        steps.push({ kind: "interrupt", movementId: prior.movementId, position });
        // Where a stopped walk stands, the actor is in the shelter standing there, or on open ground.
        const locationId = shelterAt(state, actor, position);
        if (locationId !== (actor.locationId ?? null)) steps.push({ kind: "locate", locationId });
      }
      return { steps, links };
    }
    if (
      prior !== undefined &&
      priorAction?.kind === selected.kind &&
      priorAction.targetObjectId === selected.targetObjectId
    )
      return { steps, links };
    const planId = `plan:${actor.objectId}@${t}`;
    const position = actorPosition(actor, t);
    if (sameCoordinates(position, target.pose.coordinates)) {
      if (prior !== undefined) {
        stopPrior();
        steps.push({
          kind: "interrupt",
          movementId: prior.movementId,
          position: positionAt(prior.segment, t),
        });
      }
      // A walk stopped at the target ends there as a completed one would.
      const walked = prior !== undefined;
      const live = arrivalPlan(state, actor, target.objectId, undefined, new Map(), walked);
      steps.push({ kind: "arrive", events: arrivalEventCount(live), walked });
      links.push(planId);
      return { steps, links };
    }
    links.push(planId);
    if (prior !== undefined) {
      stopPrior();
      const flushed = stopped as MovementRecord;
      const exitedAtStart = [
        ...new Set(
          flushed.emitted
            .filter(isRegionCrossing)
            .filter((crossing) => crossing.kind === "exited" && crossing.time === t)
            .map((crossing) => crossing.regionId),
        ),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const record = planFor(
        state,
        actor,
        target,
        position,
        utilityPolicy.unitsPerSecond,
        t,
        commandId,
        {
          priorMovementId: prior.movementId,
          initialInside: currentInside(flushed),
          exitedAtStart,
        },
      );
      if (record === undefined) throw new RangeError("selected seek is not plannable");
      steps.push({ kind: "replan", priorMovementId: prior.movementId, position, record });
      links.push(record.movementId);
      const first = pendingCrossings(record, t);
      if (first.length > 0)
        steps.push({ kind: "crossings", movementId: record.movementId, crossings: first });
      return { steps, links };
    }
    if (actor.locationId !== undefined && actor.locationId !== null)
      steps.push({ kind: "unlocate" });
    const record = planFor(
      state,
      actor,
      target,
      actor.pose.coordinates,
      utilityPolicy.unitsPerSecond,
      t,
      commandId,
      {
        initialInside: regionsContaining(
          startState.spatialRegions ?? [],
          actor.pose.frameId,
          actor.pose.frameVersion,
          actor.pose.coordinates,
        ),
        exitedAtStart: [],
      },
    );
    if (record === undefined) throw new RangeError("selected seek is not plannable");
    steps.push({ kind: "start", record });
    links.push(record.movementId);
    const first = pendingCrossings(record, t);
    if (first.length > 0)
      steps.push({ kind: "crossings", movementId: record.movementId, crossings: first });
    return { steps, links };
  }
  const stepEvents = (steps: readonly DecisionStep[]): number =>
    steps.reduce(
      (total, step) =>
        total +
        (step.kind === "crossings"
          ? step.crossings.length
          : step.kind === "arrive"
            ? step.events
            : 1),
      0,
    );
  function executePlan(objectId: string, plan: DecisionPlan, t: SimTimeMs): void {
    const planId = `plan:${objectId}@${t}`;
    for (const step of plan.steps) {
      if (step.kind === "crossings") emitCrossings(objectId, step.movementId, step.crossings);
      else if (step.kind === "interrupt")
        emit(
          event("movement.interrupted", t, {
            objectId: objectId as ObjectId,
            movementId: step.movementId,
            position: step.position,
          } as never),
        );
      else if (step.kind === "replan")
        emit(
          event("movement.replanned", t, {
            objectId: objectId as ObjectId,
            priorMovementId: step.priorMovementId,
            position: step.position,
            movement: step.record,
          } as never),
        );
      else if (step.kind === "unlocate" || step.kind === "locate")
        emit(
          event("location.changed", t, {
            objectId: objectId as ObjectId,
            locationId: (step.kind === "locate" ? step.locationId : null) as ObjectId | null,
            planId,
          }),
        );
      else if (step.kind === "start")
        emit(
          event("movement.started", t, {
            objectId: objectId as ObjectId,
            movement: step.record,
          } as never),
        );
      else emitArrival(objectId, planId, t, step.walked);
    }
  }
  /** Re-seeds the engine states of the given (journaled) actors and re-registers the movers. */
  function refreshRun(target: EnvironmentRun, ids: readonly string[]): void {
    const state = current();
    target.reseed({
      actors: ids.map((objectId) => {
        const actor = objectsOf(state, objectId) as WorldEntity;
        const extra = wellbeingThrough(actor, state.simulationTime);
        return {
          objectId,
          needs: integrateNeeds(state, actor, state.simulationTime, policy) as WorldNeeds,
          protection: rainProtectionOf(state, actor),
          ...(extra === undefined ? {} : { wellbeing: extra }),
        };
      }),
      rainIntensity: state.weather.rainIntensity,
      nextWeatherBoundary: state.environment?.nextWeatherBoundary ?? (MAX_TIME as SimTimeMs),
      // A decision or arrival may have consumed from a holder: its next appearance depends on that.
      ...(ecologyPolicy === undefined
        ? {}
        : { holders: ecologyHolders(state, ecologyPolicy), waterHolders: ecologyWaters(state) }),
    });
    target.setMovers(
      state.entities
        .filter(
          (entity) =>
            entity.needs !== undefined &&
            entity.movement?.status === "active" &&
            entity.objectId !== mover,
        )
        .map((entity) => ({
          objectId: entity.objectId,
          system: createMovementSystem(
            entity.objectId,
            entity.movement as MovementRecord,
            state.spatialRegions ?? [],
          ),
        })),
    );
  }
  /** Actors that completed a movement in the group just emitted. */
  let arrivedActors: readonly string[] = [];
  let complete = true;
  let stage: WorldContinuation["stage"] = "scheduled";
  const environment = policy.environment;
  /**
   * Environment boundaries and exposure crossings come from the RW-0106 engine, one leg between
   * decision due times at a time. A time group is emitted whole or not at all, so every stopping
   * point leaves the environment record agreeing with the policy at the simulation time.
   */
  let timeline: EnvironmentRun | undefined;
  /**
   * A run built from the working state at its simulation time. Building from any state at any
   * position equals resuming, so the run is rebuilt after a lifecycle change (death or birth).
   */
  function buildRun(): EnvironmentRun {
    const begin = current();
    const position = begin.simulationTime;
    const record = begin.environment;
    if (environment !== undefined && record === undefined)
      throw new RangeError("environment policy without a state record");
    const built = createEnvironmentRun({
      ...(environment === undefined ? {} : { policy: environment }),
      ...(wellbeingPolicy === undefined
        ? {}
        : {
            wellbeing: {
              policy: wellbeingPolicy,
              decisionIntervalMs: policy.decisionIntervalMs,
              ...(lifecyclePolicy === undefined
                ? {}
                : { deathHealth: lifecyclePolicy.deathHealth }),
            },
          }),
      actors:
        environment === undefined
          ? []
          : livingActorsOf(begin).map((actor) => {
              const needs = integrateNeeds(begin, actor, position, policy) as WorldNeeds;
              const extra = wellbeingThrough(actor, position);
              return {
                objectId: actor.objectId,
                needs,
                protection: rainProtectionOf(begin, actor),
                ...(extra === undefined ? {} : { wellbeing: extra }),
              };
            }),
      position,
      rainIntensity: begin.weather.rainIntensity,
      nextWeatherBoundary: record?.nextWeatherBoundary ?? (MAX_TIME as SimTimeMs),
      integrate: (needs, protection, rain, through) =>
        integrateNeedsWith(needs, protection, rain, through, policy),
      ...(ecologyPolicy === undefined ? {} : { ecology: ecologyRunOptions(begin, ecologyPolicy) }),
    });
    if (utilityPolicy !== undefined) refreshRun(built, []);
    return built;
  }
  if (spec.type === "world.advance") timeline = buildRun();
  /** Records one decision draft with the simulation time it belongs to. */
  function pushDraft(
    draft: DecisionDraft<DecisionTrace | ConceptionDecision | PlanningRequest>,
    time: bigint,
  ): void {
    decisionDrafts.push(draft);
    draftTimes.push(time);
  }
  /** The lifecycle actions of a group, planned once per group (pure; commits nothing). */
  const sizeOfLifecycle = (plan: LifecyclePlan, at: bigint): number => {
    let total = 0;
    for (const action of plan.actions) {
      total += 1;
      if (action.kind !== "died") continue;
      if (lifecyclePolicy !== undefined && lifecyclePolicy.successorRule !== null) total += 1;
      const movement = objectsOf(current(), action.objectId)?.movement;
      if (movement !== undefined && movement.status === "active")
        total += pendingCrossings(movement, at).length + 1;
    }
    return total;
  };
  let lifecycleChanged = false;
  /** Emits one environment time group; returns false, emitting nothing, when it does not fit. */
  function emitGroup(group: EnvironmentGroup): boolean {
    if (environment === undefined) return true;
    const at = group.time;
    const derived = deriveEnvironmentState(environment, at);
    // Lifecycle (RW-0109): everything due at exactly this time, planned before anything is emitted.
    const lifecycleNow = current().lifecycle;
    const plan: LifecyclePlan | undefined =
      lifecyclePolicy === undefined || lifecycleNow === undefined
        ? undefined
        : planLifecycleAt(
            lifecyclePolicy,
            lifecycleNow,
            at,
            new Set(group.deaths),
            lifecycleRandom,
          );
    const dying = new Set<string>(plan?.dying ?? []);
    const involved = new Set<string>([
      ...group.needs.map((entry) => entry.objectId),
      ...group.comforts.map((entry) => entry.objectId),
      ...group.health.map((entry) => entry.objectId),
      ...dying,
    ]);
    // Weather integrates every actor; a wellbeing crossing integrates the actors it concerns.
    const pending = livingActorsOf(current())
      .filter((actor) => group.weather || involved.has(actor.objectId))
      .reduce((total, actor) => total + integrationEvents(actor, at), 0);
    // Plants integrated at the weather boundary, or just before their stage change, add one event each.
    const plantsToIntegrate = new Set(group.weather ? pendingPlants(at) : []);
    for (const change of group.stages)
      if (pendingPlants(at).includes(change.objectId)) plantsToIntegrate.add(change.objectId);
    // Routine movement (utility): region crossings, then arrivals in object id order.
    const moverCrossings: {
      objectId: string;
      movement: MovementRecord;
      crossings: readonly CrossingRecord[];
    }[] = [];
    const arrivalIds: string[] = [];
    let movementSize = 0;
    if (utilityPolicy !== undefined && group.movers.length > 0) {
      const before = current();
      const integratedHere = new Set<string>(
        group.weather ? livingActorsOf(before).map((entity) => entity.objectId) : [...involved],
      );
      const held = new Map<string, number>();
      const comforts = new Map(group.comforts.map((entry) => [entry.objectId, entry.comfort]));
      for (const objectId of group.movers) {
        if (dying.has(objectId)) continue;
        const movement = objectsOf(before, objectId)?.movement;
        if (movement === undefined || movement.status !== "active")
          throw new RangeError("movement system without an active movement");
        const crossings = pendingCrossings(movement, at);
        moverCrossings.push({ objectId, movement, crossings });
        movementSize += crossings.length;
      }
      for (const { objectId, movement } of moverCrossings) {
        if (movementCompletionTime(movement.segment) !== at) continue;
        arrivalIds.push(objectId);
        const view = waterViewAt(viewAt(objectId, at), at);
        const actor = objectsOf(view, objectId) as WorldEntity;
        const plan = arrivalPlan(
          view,
          actor,
          actor.selectedAction?.targetObjectId,
          comforts.get(objectId),
          held,
          true,
        );
        if (plan.consume !== undefined) {
          const holder = objectsOf(view, plan.consume.holder);
          held.set(
            plan.consume.holder,
            (held.get(plan.consume.holder) ?? holder?.resource?.quantity ?? 0) -
              plan.consume.quantity,
          );
        }
        movementSize +=
          (integratedHere.has(objectId)
            ? 0
            : integrationEvents(objectsOf(before, objectId) as WorldEntity, at)) +
          1 +
          arrivalEventCount(plan);
      }
    }
    const size =
      movementSize +
      (group.phase ? 1 : 0) +
      (group.weather ? 1 : 0) +
      pending +
      group.needs.length +
      group.comforts.length +
      group.health.length +
      group.crossings.length +
      plantsToIntegrate.size +
      group.spoiled.length +
      group.appeared.length +
      group.stages.length +
      pendingWater(at).length +
      (plan === undefined ? 0 : sizeOfLifecycle(plan, at));
    if (context.eventCount() + size > payload.maxEvents) {
      if (context.eventCount() === 0) invalid("payload.maxEvents");
      return false;
    }
    const waterBeforeWeather = group.weather
      ? pendingWater(at).map((id) => waterAt(current(), id, at, policy)!)
      : [];
    if (group.phase)
      emit(
        event("environment.phase-changed", at, {
          phase: derived.phase,
          lightBand: derived.lightBand,
          nextPhaseBoundary: derived.nextPhaseBoundary,
        }),
      );
    if (group.weather) {
      for (const actor of livingActorsOf(current())) integrateActor(actor, at);
      integratePlants(at, false);
      const segment = environment.weatherSegments[derived.segmentIndex] as NonNullable<
        (typeof environment.weatherSegments)[number]
      >;
      emit(
        event("weather.transitioned", at, {
          segmentIndex: derived.segmentIndex,
          rainIntensity: segment.rainIntensity,
          temperatureBand: derived.temperatureBand,
          nextWeatherBoundary: derived.nextWeatherBoundary,
          rainChange: classifyRainChange(current().weather.rainIntensity, segment.rainIntensity),
        }),
      );
    }
    for (const crossing of group.crossings) {
      const actor = current().entities.find((entity) => entity.objectId === crossing.objectId);
      const wetness =
        actor === undefined ? undefined : integrateNeeds(current(), actor, at, policy)?.wetness;
      const level =
        crossing.threshold === "wet" ? environment.wetThreshold : environment.discomfortThreshold;
      if (wetness === undefined || (crossing.direction === "entered") !== wetness >= level)
        throw new RangeError("exposure crossing disagrees with the needs integrator");
      emit(
        event("exposure.threshold-crossed", at, {
          objectId: crossing.objectId as ObjectId,
          threshold: crossing.threshold,
          direction: crossing.direction,
          wetness,
        }),
      );
    }
    for (const objectId of group.spoiled) {
      const entity = current().entities.find((candidate) => candidate.objectId === objectId);
      const holder = ecologyPolicy?.perishables.find(
        (candidate) => candidate.objectId === objectId,
      );
      const entry = current().ecology?.perishables.find(
        (candidate) => candidate.objectId === objectId,
      );
      if (
        entity?.resource?.kind !== "food" ||
        entity.resource.quantity <= 0 ||
        holder === undefined ||
        entry?.arrivedAt == null ||
        entry.arrivedAt + holder.shelfLifeMs !== at
      )
        throw new RangeError("spoilage disagrees with the perishable holder");
      emit(
        event("resource.spoiled", at, {
          objectId: entity.objectId,
          kind: "food",
          quantity: entity.resource.quantity,
        }),
      );
    }
    for (const objectId of group.appeared) {
      const entity = current().entities.find((candidate) => candidate.objectId === objectId);
      const source = ecologyPolicy?.sources.find((candidate) => candidate.objectId === objectId);
      if (
        entity?.resource === undefined ||
        source === undefined ||
        !active(entity) ||
        entity.resource.quantity !== 0 ||
        entity.resource.kind !== source.kind
      )
        throw new RangeError("appearance disagrees with the source holder");
      emit(
        event("resource.appeared", at, {
          objectId: entity.objectId,
          kind: source.kind,
          quantity: source.quantity,
        }),
      );
    }
    for (const next of waterBeforeWeather) emit(event("resource.weather-integrated", at, next));
    integrateWaters(at);
    for (const change of group.stages) {
      integratePlant(change.objectId, at);
      const entry = current().ecology?.plants.find(
        (candidate) => candidate.objectId === change.objectId,
      );
      const plant = ecologyPolicy?.plants.find(
        (candidate) => candidate.objectId === change.objectId,
      );
      const stage = plant?.stages[change.stageIndex];
      if (
        entry === undefined ||
        plant === undefined ||
        stage === undefined ||
        plantStageIndex(plant, entry.growingMs) !== change.stageIndex ||
        entry.stage + 1 !== change.stageIndex
      )
        throw new RangeError("stage change disagrees with the growth integrator");
      emit(
        event("growth.stage-changed", at, {
          objectId: entry.objectId,
          stageIndex: change.stageIndex,
          stageName: stage.name,
          ...(stage.yield === undefined ? {} : { yield: stage.yield }),
        }),
      );
    }
    if (wellbeingPolicy !== undefined) {
      // Integrate the concerned actors in object id order, then emit need crossings (hunger before
      // thirst), comfort changes and health crossings, each in object id order.
      for (const objectId of [...involved].sort((left, right) =>
        left === right ? 0 : left < right ? -1 : 1,
      )) {
        const actor = current().entities.find((candidate) => candidate.objectId === objectId);
        if (actor === undefined) throw new RangeError("wellbeing crossing for an unknown actor");
        integrateActor(actor, at);
      }
      const entryOf = (objectId: string) => {
        const entry = current().wellbeing?.entries.find(
          (candidate) => candidate.objectId === objectId,
        );
        const actor = current().entities.find((candidate) => candidate.objectId === objectId);
        if (entry === undefined || actor?.needs === undefined)
          throw new RangeError("wellbeing crossing for an unknown actor");
        return { entry, needs: actor.needs };
      };
      for (const crossing of group.needs) {
        const { entry, needs } = entryOf(crossing.objectId);
        const value = crossing.need === "hunger" ? needs.hunger : entry.thirst;
        const urgent =
          crossing.need === "hunger" ? wellbeingPolicy.urgentHunger : wellbeingPolicy.urgentThirst;
        if (value < urgent) throw new RangeError("need crossing disagrees with the integrator");
        emit(
          event("needs.threshold-crossed", at, {
            objectId: crossing.objectId as ObjectId,
            need: crossing.need,
            value,
          }),
        );
      }
      for (const change of group.comforts) {
        const { entry, needs } = entryOf(change.objectId);
        const derived = deriveComfort(environment, wellbeingPolicy, {
          hunger: needs.hunger,
          thirst: entry.thirst,
          wetness: needs.wetness,
        });
        if (derived.comfort !== change.comfort || entry.comfort === derived.comfort)
          throw new RangeError("comfort change disagrees with the integrator");
        emit(
          event("comfort.changed", at, {
            objectId: change.objectId as ObjectId,
            comfort: derived.comfort,
            causes: derived.causes,
          }),
        );
      }
      for (const crossing of group.health) {
        const { entry } = entryOf(crossing.objectId);
        if ((crossing.direction === "entered") !== entry.health < wellbeingPolicy.criticalHealth)
          throw new RangeError("health crossing disagrees with the integrator");
        emit(
          event("health.threshold-crossed", at, {
            objectId: crossing.objectId as ObjectId,
            threshold: "critical",
            direction: crossing.direction,
            health: entry.health,
          }),
        );
      }
    }
    if (plan !== undefined && lifecyclePolicy !== undefined) {
      for (const action of plan.actions) {
        if (action.kind === "died") {
          const movement = objectsOf(current(), action.objectId)?.movement;
          if (movement !== undefined && movement.status === "active") {
            emitCrossings(action.objectId, movement.movementId, pendingCrossings(movement, at));
            emit(
              event("movement.interrupted", at, {
                objectId: action.objectId,
                movementId: movement.movementId,
                position: positionAt(movement.segment, at),
              } as never),
            );
          }
          const entry = current().wellbeing?.entries.find(
            (candidate) => candidate.objectId === action.objectId,
          );
          if (entry === undefined) throw new RangeError("dying actor has no wellbeing entry");
          if (action.cause === "health" && entry.health > lifecyclePolicy.deathHealth)
            throw new RangeError("health death disagrees with the integrator");
          emit(
            event("lifecycle.died", at, {
              objectId: action.objectId,
              cause: action.cause,
              health: entry.health,
            }),
          );
          const queued = decisionsOf(schedules).find(
            (candidate) => candidate.payload.objectId === action.objectId,
          );
          if (queued !== undefined) {
            schedules = cancelSchedule(schedules, queued.id);
            scheduleMutations.push(Object.freeze({ kind: "cancel", scheduleId: queued.id }));
          }
          if (lifecyclePolicy.successorRule !== null)
            emit(
              event("lifecycle.successor-intended", at, {
                objectId: action.objectId,
                successorId: lifecycleSuccessorId(action.objectId, lifecyclePolicy.successorRule),
                rule: lifecyclePolicy.successorRule,
              }),
            );
        } else if (action.kind === "stage") {
          emit(
            event("lifecycle.stage-changed", at, {
              objectId: action.objectId,
              stageIndex: action.stageIndex,
              stageName: action.stageName,
            }),
          );
        } else if (action.kind === "milestone") {
          emit(
            event("lifecycle.gestation-milestone", at, {
              objectId: action.objectId,
              childId: action.childId,
              milestoneIndex: action.milestoneIndex,
              milestoneName: action.milestoneName,
            }),
          );
        } else if (action.kind === "born") {
          emit(
            event("lifecycle.born", at, {
              childId: action.childId,
              gestatingParentId: action.gestatingParentId,
              coParentId: action.coParentId,
            }),
          );
          const item = decisionSchedule(
            current(),
            action.childId,
            lifecycleScheduleId(action.childId),
            (at + policy.decisionIntervalMs) as SimTimeMs,
          );
          schedules = upsertSchedule(schedules, item);
          scheduleMutations.push(
            Object.freeze({
              kind: "upsert",
              scheduleId: item.id,
              dueAt: item.dueAt,
              payload: item.payload,
              item,
            }),
          );
        } else {
          emit({
            ...event("lifecycle.conceived", at, {
              objectId: action.objectId,
              coParentId: action.coParentId,
              childId: action.childId,
              dueAt: action.dueAt as SimTimeMs,
            }),
            randomDraws: Object.freeze([action.draw]),
          } as unknown as WorldEvent);
        }
      }
      for (const { decision, draws } of plan.decisions)
        pushDraft(
          Object.freeze({ kind: CONCEPTION_DECISION_KIND, decision, randomDraws: draws }),
          at,
        );
      lifecycleRandom = plan.random;
      randomLog.push({ time: at, random: plan.random });
      if (plan.dying.length > 0 || plan.births.length > 0) lifecycleChanged = true;
    }
    for (const { objectId, movement, crossings } of moverCrossings)
      emitCrossings(objectId, movement.movementId, crossings);
    for (const objectId of arrivalIds) {
      const actor = objectsOf(current(), objectId) as WorldEntity;
      integrateActor(actor, at);
      const movement = objectsOf(current(), objectId)?.movement as MovementRecord;
      emit(
        event("movement.completed", at, {
          objectId: objectId as ObjectId,
          movementId: movement.movementId,
        } as never),
      );
      emitArrival(objectId, completedPlanId(objectId, movement), at, true);
    }
    arrivedActors = arrivalIds;
    return true;
  }
  let dispatched = 0;
  let finished = false;
  let run: EnvironmentRun | undefined = timeline;
  /** Lifecycle times at or before this have been planned (and emitted, if they had events). */
  let cursor = current().simulationTime;
  const quiet = (time: SimTimeMs): EnvironmentGroup => ({
    time,
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
  });
  /** Actors with a wellbeing event that brings their queued decision forward, by group. */
  const broughtForward = (group: EnvironmentGroup): ObjectId[] => [
    ...new Set<ObjectId>([
      ...group.needs.map((entry) => entry.objectId as ObjectId),
      ...group.comforts
        .filter((entry) => entry.comfort === "uncomfortable")
        .map((entry) => entry.objectId as ObjectId),
      ...group.health
        .filter((entry) => entry.direction === "entered")
        .map((entry) => entry.objectId as ObjectId),
    ]),
  ];
  /**
   * The decisions a drain may dispatch. A move drains neither its mover's decision nor one already
   * due when it starts: those fall due at its end instead.
   */
  const dispatchable = (): ScheduleQueue<WorldScheduledPayload> =>
    spec.move === undefined
      ? decisionsOf(schedules)
      : decisionsOf(schedules).filter(
          (item) => item.payload.objectId !== mover && item.dueAt > startState.simulationTime,
        );
  /**
   * Passes the world time to `target` as `world.advance` does: environment, ecology, wellbeing and
   * lifecycle groups, routine movers and due decisions, in time order, and the dwells due by
   * `dwellsThrough`. Returns false, with `complete` false, when the budget stops it first.
   */
  function advanceTo(target: SimTimeMs, dwellsThrough: SimTimeMs): boolean {
    if (run === undefined) run = buildRun();
    let engine = run;
    while (true) {
      // One engine call over the real queue; decisions a threshold brings forward are single
      // upserts, after which the same saved system states are drained again.
      const lifeTime =
        lifecyclePolicy === undefined
          ? undefined
          : nextLifecycleTime(lifecyclePolicy, current().lifecycle as never, cursor);
      const barrier =
        lifeTime !== undefined && lifeTime <= target ? (lifeTime as SimTimeMs) : undefined;
      // A queued dwell is a barrier like a lifecycle time: the drain stops there to fire it.
      const dwellAt = schedules.find(isDwellItem)?.dueAt;
      const dwellBarrier = dwellAt !== undefined && dwellAt <= dwellsThrough ? dwellAt : undefined;
      const limit =
        dwellBarrier !== undefined && dwellBarrier < (barrier ?? target)
          ? dwellBarrier
          : (barrier ?? target);
      armedDue = undefined;
      let drain = engine.drain(
        dispatchable(),
        limit,
        Math.max(1, payload.maxEvents - context.eventCount()),
      );
      let pulled = true;
      while (pulled) {
        pulled = false;
        for (const group of drain.groups) {
          let again = false;
          for (const objectId of broughtForward(group)) {
            const queued = decisionsOf(schedules).find(
              (candidate) => candidate.payload.objectId === objectId,
            );
            if (queued !== undefined && queued.dueAt > group.time) {
              reschedule(queued, group.time);
              // A move never drains its mover's decision: it falls due at the move's end.
              if (objectId !== mover) again = true;
            }
          }
          if (again) {
            drain = engine.drain(
              dispatchable(),
              limit,
              Math.max(1, payload.maxEvents - context.eventCount()),
            );
            pulled = true;
            break;
          }
        }
      }
      const groups =
        barrier !== undefined &&
        drain.time === barrier &&
        !drain.groups.some((group) => group.time === barrier)
          ? [...drain.groups, quiet(barrier)]
          : drain.groups;
      let fits = true;
      let restartAt: SimTimeMs | undefined;
      lifecycleChanged = false;
      let rebuildAt: SimTimeMs | undefined;
      for (const group of groups) {
        arrivedActors = [];
        if (!emitGroup(group)) {
          fits = false;
          break;
        }
        if (lifecycleChanged) {
          rebuildAt = group.time;
          break;
        }
        // An arrival, or an entry whose dwell falls due within this drain, restarts the drain here.
        if (arrivedActors.length > 0 || (armedDue !== undefined && armedDue <= drain.time)) {
          restartAt = group.time;
          break;
        }
      }
      if (!fits) {
        complete = false;
        break;
      }
      if (rebuildAt !== undefined) {
        cursor = rebuildAt;
        // A move ends where its mover dies.
        if (moverDied()) break;
        // A death or birth changed the set of living actors: rebuild the engine run from the state.
        engine = run = buildRun();
        continue;
      }
      if (restartAt !== undefined) {
        cursor = restartAt;
        // An arrival changed the actor's needs, location or movement: the engine states beyond this
        // time were computed from the old ones, so advance to it, re-seed and drain again. A newly
        // armed dwell only needs the drain to stop at its due time, which the next limit does.
        engine.step(restartAt);
        refreshRun(engine, arrivedActors);
        continue;
      }
      drain.commit();
      if (drain.time > cursor) cursor = drain.time;
      const item =
        drain.dispatched === undefined
          ? undefined
          : schedules.find((candidate) => candidate.id === drain.dispatched?.scheduleId);
      if (item === undefined) {
        // Stopped at a dwell barrier: fire what is due, then continue from it.
        if (dwellBarrier !== undefined && drain.time === dwellBarrier) {
          if (!fireDwells(drain.time)) {
            complete = false;
            break;
          }
          continue;
        }
        // Stopped at a threshold or lifecycle barrier short of the target: continue from it.
        if (drain.time < target) continue;
        break;
      }
      // A decision is decided on the due actor's integrated view first. It is material when it
      // selects a different action or its plan journals an event (a movement, location change or
      // arrival effect). An unchanged re-selection journals nothing: no integration and no
      // `routine.selected`, only its decision trace and the next schedule.
      const dueActor = current().entities.find(
        (entity) => entity.objectId === item.payload.objectId,
      );
      if (dueActor === undefined) throw new RangeError("scheduled actor disappeared");
      const view = waterViewAt(viewAt(dueActor.objectId, item.dueAt), item.dueAt);
      const viewActor = objectsOf(view, dueActor.objectId) as WorldEntity;
      let unchanged: DecisionTrace | undefined;
      let decisionSize: number;
      if (utilityPolicy === undefined) {
        const trial = chooseRoutine(view, viewActor, item.dueAt, policy);
        if (sameAction(trial.selectedAction, viewActor.selectedAction)) unchanged = trial;
        decisionSize = 2 + (wellbeingPolicy === undefined ? 0 : 1) + plantTotal;
      } else {
        // The decision is indivisible: its integrations, selection and plan fit whole or not at all.
        const commandId = (drain.dispatched as ScheduledKernelInput).commandId;
        const trial = scoreUtility(view, viewActor, item.dueAt, policy, commandId);
        const trialPlan = planDecision(
          view,
          viewActor,
          trial.trace.selectedAction,
          trial.target,
          viewActor.selectedAction,
          item.dueAt,
          commandId,
        );
        if (
          stepEvents(trialPlan.steps) === 0 &&
          sameAction(trial.trace.selectedAction, viewActor.selectedAction)
        )
          unchanged = Object.freeze({
            ...trial.trace,
            outcomeLinks: Object.freeze([...trialPlan.links]),
          });
        decisionSize =
          integrationEvents(dueActor, item.dueAt) +
          pendingPlants(item.dueAt).length +
          pendingWater(item.dueAt).length +
          1 +
          stepEvents(trialPlan.steps);
      }
      if (dispatched === payload.maxInputs) {
        complete = false;
        break;
      }
      if (unchanged === undefined && context.eventCount() + decisionSize > payload.maxEvents) {
        if (utilityPolicy !== undefined && context.eventCount() === 0) invalid("payload.maxEvents");
        complete = false;
        break;
      }
      if (
        spec.scheduled !== undefined &&
        (item.id !== spec.scheduled.scheduleId || item.dueAt !== spec.scheduled.dueAt)
      )
        throw new RefusalSignal(
          refusal("precondition-failed", "input.scheduled.scheduleId", `${FIRST_DUE_CHECK}@1`),
        );
      const actor = current().entities.find((entity) => entity.objectId === item.payload.objectId);
      if (actor === undefined || item.dueAt < current().simulationTime)
        throw new RangeError("scheduled actor or deadline no longer matches physical state");
      let decision: DecisionTrace;
      if (unchanged !== undefined) decision = unchanged;
      else if (utilityPolicy === undefined) {
        integrateActor(actor, item.dueAt);
        integratePlants(item.dueAt);
        const currentActor = currentActorOf(actor.objectId);
        decision = chooseRoutine(current(), currentActor, item.dueAt, policy);
        emit(
          event("routine.selected", item.dueAt, {
            objectId: actor.objectId,
            action: decision.selectedAction,
          }),
        );
      } else {
        integrateActor(actor, item.dueAt);
        integratePlants(item.dueAt);
        const currentActor = currentActorOf(actor.objectId);
        const commandId = (drain.dispatched as ScheduledKernelInput).commandId;
        const scoring = scoreUtility(current(), currentActor, item.dueAt, policy, commandId);
        emit(
          event("routine.selected", item.dueAt, {
            objectId: actor.objectId,
            action: scoring.trace.selectedAction,
          }),
        );
        const plan = planDecision(
          current(),
          currentActor,
          scoring.trace.selectedAction,
          scoring.target,
          currentActor.selectedAction,
          item.dueAt,
          commandId,
        );
        executePlan(actor.objectId, plan, item.dueAt);
        decision = Object.freeze({
          ...scoring.trace,
          outcomeLinks: Object.freeze([...plan.links]),
        });
        refreshRun(engine, [actor.objectId]);
      }
      pushDraft(Object.freeze({ kind: "routine", decision }), item.dueAt);
      // A policy-declared ambiguity is recorded beside the trace, never executed: the decision
      // above has already taken the deterministic fallback, so nothing waits on the request.
      const ambiguity = utilityPolicy?.ambiguity;
      if (ambiguity !== undefined) {
        const commandId = (drain.dispatched as ScheduledKernelInput).commandId;
        const request = planningRequestFor(decision, ambiguity, commandId);
        if (request !== undefined)
          pushDraft(Object.freeze({ kind: PLANNING_REQUEST_KIND, decision: request }), item.dueAt);
      }
      const nextDueAt = item.dueAt + policy.decisionIntervalMs;
      if (nextDueAt > MAX_TIME) throw new RangeError("next decision exceeds simulation-time range");
      reschedule(item, nextDueAt as SimTimeMs);
      dispatched += 1;
      if (spec.scheduled !== undefined) {
        // A scheduled decision stops once it has been dispatched; it never advances time further.
        finished = true;
        break;
      }
    }
    return complete;
  }
  if (spec.move !== undefined) {
    // A movement or portal command moves the world time to its last event. Up to each of its
    // events, the world time it passes runs as in `world.advance`, through the same systems and in
    // the same order: environment and ecology boundaries, every actor's exposure and wellbeing
    // crossings, lifecycle (drawing from the `lifecycle` stream in the same order), routine movers,
    // dwells and other actors' decisions. Each lands at its own time, before the command's events at
    // that time. Three things differ:
    // - the mover's movement events come only from the command, never from the routine movers;
    // - its decision, and any decision already due when the command starts, falls due at the
    //   command's end instead;
    // - when the mover dies, its movement is interrupted there (`movement.interrupted`, then
    //   `lifecycle.died`) and the move ends at that time.
    //
    // The time a move may pass is bounded (`movement.passed-time@2`, `precondition-failed`): at most
    // one `decisionIntervalMs` of the policy, and at most `world.advance`'s per-call event and
    // decision budgets.
    const start = current().simulationTime;
    const passedTime = (path: string): never => {
      throw new RefusalSignal(
        refusal("precondition-failed", path, `${PASSED_TIME_CHECK}@${PASSED_TIME_VERSION}`),
      );
    };
    let ended = false;
    /**
     * Journals the mover's location at `at` as a decision's move does. Whatever shelter protects is
     * integrated first under the shelter it was in (a needs actor's needs and wellbeing, a plant's
     * growth) and continues under the new one: an actor's exposure is re-seeded, and a plant's
     * growth is rebuilt with the run. `reserve` events must still fit after it.
     */
    const relocate = (
      at: SimTimeMs,
      locationId: string | null,
      planId: string,
      reserve: number,
    ): void => {
      const actor = objectsOf(current(), mover as string);
      if (actor === undefined || !active(actor)) return;
      if ((actor.locationId ?? null) === locationId) return;
      const plant = pendingPlants(at).includes(actor.objectId);
      const integration = integrationEvents(actor, at) + (plant ? 1 : 0);
      if (context.eventCount() + integration + 1 + reserve > payload.maxEvents)
        passedTime("events");
      integrateActor(actor, at);
      if (plant) integratePlant(actor.objectId, at);
      emit(
        event("location.changed", at, {
          objectId: actor.objectId,
          locationId: locationId as ObjectId | null,
          planId,
        }),
      );
      if (run === undefined) return;
      if (current().ecology?.plants.some((entry) => entry.objectId === actor.objectId))
        run = buildRun();
      else if (actor.needs !== undefined) refreshRun(run, [actor.objectId]);
    };
    spec.move({
      state: startState,
      command: { type: context.command.type, commandId: context.command.commandId },
      payload: context.payload,
      indexFactory: input.spatialIndexFactory ?? createQuadtreeSpatialIndex,
      emit: (type, data, time) => {
        // The world time's events come only from its systems, never from the movement handler.
        if (!handlerTypes(context.command.type).includes(type))
          throw new RangeError("a movement handler emitted an event its command does not own");
        if (ended) return;
        if (time - start > policy.decisionIntervalMs) passedTime("state.simulationTime");
        // Dwells due at `time` fall due after the command's events at that time.
        if (!advanceTo(time as SimTimeMs, (time - 1n) as SimTimeMs)) passedTime("events");
        ended = moverDied();
        if (ended) return;
        if (context.eventCount() + pendingWater(time as SimTimeMs).length >= payload.maxEvents)
          passedTime("events");
        integrateWaters(time as SimTimeMs);
        const at = time as SimTimeMs;
        // A move off the spot leaves the mover's location as it sets out.
        if (type === "movement.started" || type === "movement.replanned") {
          const movement = (data as { readonly movement: MovementRecord }).movement;
          if (leavesStart(movement)) relocate(at, null, movement.movementId, 1);
        }
        emit(event(type as WorldEvent["type"], at, data as never));
        // Where it stops, it is in the shelter standing there, or on open ground.
        if (type === "movement.completed" || type === "movement.interrupted") {
          const actor = objectsOf(current(), mover as string) as WorldEntity;
          const movementId = (data as { readonly movementId: string }).movementId;
          relocate(at, shelterAt(current(), actor, actor.pose.coordinates), movementId, 0);
        }
      },
    });
    const through = current().simulationTime;
    integrateWaters(through);
    if (through > start) {
      if (!fireDwells(through)) passedTime("events");
      // The mover's decision, and any already due at the start, is due at the final time, so the
      // next `world.advance` runs it first, never in the past.
      for (const item of decisionsOf(schedules))
        if (item.dueAt < through) reschedule(item, through);
    }
  } else if (spec.type === "world.weather.set") {
    for (const actor of actors) integrateActor(actor, current().simulationTime);
    // Plants are integrated first, under the rain still in force.
    integratePlants(current().simulationTime);
    emit(
      event("weather.changed", current().simulationTime, {
        rainIntensity: payload.rainIntensity as number,
      }),
    );
    for (const item of decisionsOf(schedules)) reschedule(item, current().simulationTime);
  } else {
    advanceTo(payload.targetTime, payload.targetTime);
    if (spec.scheduled !== undefined && !finished)
      throw new RefusalSignal(
        refusal("precondition-failed", "input.scheduled.scheduleId", `${FIRST_DUE_CHECK}@1`),
      );
    if (complete && !finished) {
      if (
        context.eventCount() + perActor * livingActorsOf(current()).length + plantTotal + 1 >
        payload.maxEvents
      ) {
        complete = false;
        stage = "finalize";
      } else {
        integrateWaters(payload.targetTime);
        // A lazy advance leaves needs, wellbeing and plants stored with their `integratedAt`.
        if (payload.lazy !== true) {
          for (const actor of livingActorsOf(current())) integrateActor(actor, payload.targetTime);
          integratePlants(payload.targetTime);
        }
        if (current().simulationTime < payload.targetTime)
          emit(event("time.advanced", payload.targetTime, {}));
      }
    }
  }
  const declared = createWorldState(current());
  // Lifecycle groups planned beyond the state's final time (a stopped call) are rolled back whole.
  // A routine draft (and its planning request) is recorded only for a dispatched decision and is
  // always kept: an unchanged decision journals nothing, so it may lie beyond the state's final time.
  const finalTime = declared.simulationTime;
  const keptDrafts = decisionDrafts.filter(
    (draft, index) =>
      draft.kind === "routine" ||
      draft.kind === PLANNING_REQUEST_KIND ||
      (draftTimes[index] as bigint) <= finalTime,
  );
  let keptRandom: NamedRandomState = input.randomState;
  for (const entry of randomLog) if (entry.time <= finalTime) keptRandom = entry.random;
  const inputIdentity = spec.inputIdentity(keptRandom);
  return Object.freeze({
    scheduleMutations: Object.freeze(scheduleMutations),
    decisionDrafts: Object.freeze(keptDrafts),
    ...(lifecyclePolicy === undefined ? {} : { randomState: keptRandom }),
    projectionDelta: Object.freeze({
      schemaVersion: 1,
      partitionId: declared.partitionId,
      fromRevision: startRevision,
      toRevision: declared.revision,
      delta: declared,
    }),
    extra: Object.freeze({ schedules, complete, stage, inputIdentity }),
  });
}

type WorldPrecondition = PreconditionContext<WorldState, WorldKernelInput>;
type WorldInvariantSubject = InvariantContext<WorldState, WorldEvent> & {
  readonly state: WorldState;
};

function worldPayload(context: WorldPrecondition): WorldCommandPayload {
  return context.payload as WorldCommandPayload;
}

function registerWorldChecks(
  preconditions: CheckRegistry<WorldPrecondition>,
  invariants: CheckRegistry<WorldInvariantSubject>,
): RegistrationResult {
  const results = [
    preconditions.register({
      name: "world.advance.no-weather-change",
      version: 1,
      commands: ["world.advance"],
      check: (context) =>
        worldPayload(context).rainIntensity === undefined ? undefined : "payload.rainIntensity",
    }),
    preconditions.register({
      name: "world.weather.bounded-current-time-intensity",
      version: 1,
      commands: ["world.weather.set"],
      check: (context) => {
        const payload = worldPayload(context);
        if (context.input.continuation !== undefined) return "continuation";
        if (
          !Number.isSafeInteger(payload.rainIntensity) ||
          (payload.rainIntensity ?? -1) < 0 ||
          (payload.rainIntensity ?? 10001) > 10000
        )
          return "payload.rainIntensity";
        return undefined;
      },
    }),
    preconditions.register({
      name: ENVIRONMENT_CHECK,
      version: 1,
      check: ({ state, input }) => environmentDisagreement(input.pack.pack.policy, state),
    }),
    invariants.register({
      name: ENVIRONMENT_CHECK,
      version: 1,
      check: ({ state }) =>
        activePolicy === undefined ? undefined : environmentDisagreement(activePolicy, state),
    }),
    preconditions.register({
      name: ECOLOGY_CHECK,
      version: 1,
      check: ({ state, input }) => ecologyDisagreement(input.pack.pack.policy, state),
    }),
    invariants.register({
      name: ECOLOGY_CHECK,
      version: 1,
      check: ({ initial, state, events }) => {
        if (activePolicy === undefined) return undefined;
        const disagreement = ecologyDisagreement(activePolicy, state);
        if (disagreement !== undefined) return disagreement;
        const weatherIndex = events.findIndex(
          (event) =>
            event.type === "resource.weather-integrated" &&
            !activePolicy!.ecology?.waterHolders?.some(
              (holder) => holder.objectId === event.payload.objectId,
            ),
        );
        if (weatherIndex >= 0) return `events[${weatherIndex}].payload.objectId`;
        if ((activePolicy.ecology?.waterHolders?.length ?? 0) > 0) {
          let weatherState = initial;
          const boundaryWater = new Map<string, ReturnType<typeof waterAt>>();
          for (const [index, event] of events.entries()) {
            if (event.type === "weather.transitioned") {
              for (const entry of weatherState.ecology?.waterHolders ?? [])
                boundaryWater.set(
                  entry.objectId,
                  waterAt(weatherState, entry.objectId, event.simulationTime, activePolicy),
                );
            }
            if (event.type === "resource.weather-integrated") {
              const expected =
                boundaryWater.get(event.payload.objectId) ??
                waterAt(weatherState, event.payload.objectId, event.simulationTime, activePolicy);
              boundaryWater.delete(event.payload.objectId);
              if (canonicalSerialize(expected) !== canonicalSerialize(event.payload))
                return `events[${index}].payload`;
            }
            weatherState = reduceWorldEvent(weatherState, event);
          }
        }
        const stages = new Map(
          initial.ecology?.plants.map((plant) => [plant.objectId, plant.stage]),
        );
        for (const [index, event] of events.entries()) {
          if (event.type !== "growth.stage-changed") continue;
          const plant = activePolicy.ecology?.plants.find(
            (candidate) => candidate.objectId === event.payload.objectId,
          );
          const stage = plant?.stages[event.payload.stageIndex];
          if (
            !plant?.stages.some((candidate) => candidate.yield !== undefined) &&
            event.payload.yield === undefined
          )
            continue;
          if (
            stage === undefined ||
            event.payload.stageIndex !== (stages.get(event.payload.objectId) ?? -1) + 1 ||
            stage.name !== event.payload.stageName ||
            stage.yield?.quantity !== event.payload.yield?.quantity
          )
            return `events[${index}].payload.yield`;
          stages.set(event.payload.objectId, event.payload.stageIndex);
        }
        return undefined;
      },
    }),
    preconditions.register({
      name: WELLBEING_CHECK,
      version: 1,
      check: ({ state, input }) => wellbeingDisagreement(input.pack.pack.policy, state),
    }),
    invariants.register({
      name: WELLBEING_CHECK,
      version: 1,
      check: ({ state }) =>
        activePolicy === undefined ? undefined : wellbeingDisagreement(activePolicy, state),
    }),
    preconditions.register({
      name: LIFECYCLE_CHECK,
      version: 1,
      check: ({ state, input }) => lifecycleDisagreement(input.pack.pack.policy, state),
    }),
    invariants.register({
      name: LIFECYCLE_CHECK,
      version: 1,
      check: ({ state }) =>
        activePolicy === undefined ? undefined : lifecycleDisagreement(activePolicy, state),
    }),
    invariants.register({
      name: "lifecycle.successor-distinct",
      version: 1,
      check: ({ state, events }) => {
        const index = events.findIndex(
          (event) =>
            event.type === "lifecycle.successor-intended" &&
            (event.payload.successorId === event.payload.objectId ||
              state.entities.some((entity) => entity.objectId === event.payload.successorId)),
        );
        return index < 0 ? undefined : `events[${index}].payload.successorId`;
      },
    }),
    preconditions.register({
      name: PLAN_MATCHES_ACTION_CHECK,
      version: 1,
      check: ({ state, input }) => utilityPlanDisagreement(input.pack.pack.policy, state),
    }),
    invariants.register({
      name: PLAN_MATCHES_ACTION_CHECK,
      version: 1,
      check: ({ state }) =>
        activePolicy === undefined ? undefined : utilityPlanDisagreement(activePolicy, state),
    }),
    preconditions.register({
      name: FIRST_DUE_CHECK,
      version: 1,
      commands: ["world.decision"],
      check: ({ input }) => {
        const scheduled = (input.input as { scheduled?: ScheduledKernelInput }).scheduled;
        const first = decisionsOf(createScheduleQueue(input.schedules))[0];
        return first !== undefined && scheduled !== undefined && first.id === scheduled.scheduleId
          ? undefined
          : "input.scheduled.scheduleId";
      },
    }),
    preconditions.register({
      name: "world.entity-budget-and-pinned-archetypes",
      version: 1,
      check: ({ state, input }) => {
        if (state.entities.length > 128) return "state.entities";
        const index = state.entities.findIndex(
          (entity) => !input.pack.pack.archetypes.includes(entity.archetypeId),
        );
        return index < 0 ? undefined : `state.entities[${index}].archetypeId`;
      },
    }),
    preconditions.register({
      name: "world.need-remainders-within-denominator",
      version: 1,
      check: ({ state, input }) => {
        const interval = input.pack.pack.policy.decisionIntervalMs;
        const index = state.entities.findIndex(
          (entity) =>
            entity.needs !== undefined &&
            (entity.needs.hungerRemainder >= interval ||
              entity.needs.wetnessRemainder >= interval * WETNESS_SCALE),
        );
        return index < 0 ? undefined : `state.entities[${index}].needs`;
      },
    }),
    invariants.register({
      name: "world.state-valid",
      version: 1,
      check: ({ state }) => {
        try {
          validateWorldState(state);
          return undefined;
        } catch {
          return "state";
        }
      },
    }),
    invariants.register({
      name: "world.revision-counts-events",
      version: 1,
      check: ({ initial, state, events }) =>
        state.revision === initial.revision + BigInt(events.length) ? undefined : "state.revision",
    }),
    invariants.register({
      name: "world.simulation-time-monotonic",
      version: 1,
      check: ({ initial, state }) =>
        state.simulationTime >= initial.simulationTime ? undefined : "state.simulationTime",
    }),
    invariants.register({
      name: "world.needs-integrated-through-now",
      version: 1,
      check: ({ state }) => {
        const index = state.entities.findIndex(
          (entity) =>
            entity.needs !== undefined &&
            (entity.needs.integratedAt > state.simulationTime ||
              entity.needs.hungerRemainder < 0n ||
              entity.needs.wetnessRemainder < 0n),
        );
        return index < 0 ? undefined : `state.entities[${index}].needs`;
      },
    }),
  ];
  return results.find((result) => !result.ok) ?? { ok: true };
}

function worldCommand(
  type: WorldCommandType,
  version: number,
  idempotentNoOp: boolean,
): CommandRegistration<WorldState, WorldKernelInput, WorldEvent, WorldHandlerExtra> {
  return {
    type,
    version,
    owner: WORLD_OWNER,
    expectedRevision: "continuation-or-optional",
    idempotentNoOp,
    validatePayload: version === 2 ? validateWeatherV2 : validateWorldPayload,
    handler: runWorldCommand,
  };
}

type WorldKernel = Kernel<WorldState, WorldKernelInput, WorldEvent, WorldHandlerExtra>;
type WorldKernelCreation =
  | Readonly<{ ok: true; kernel: WorldKernel }>
  | Readonly<{ ok: false; error: Refusal }>;

function buildWorldKernel(): WorldKernelCreation {
  const commands = new CommandRegistry<
    WorldState,
    WorldKernelInput,
    WorldEvent,
    WorldHandlerExtra
  >();
  const events = new EventRegistry();
  const reducers = new ReducerRegistry<WorldState, WorldEvent>();
  const preconditions = new CheckRegistry<WorldPrecondition>();
  const invariants = new CheckRegistry<WorldInvariantSubject>();
  for (const { type, version } of WORLD_COMMAND_DEFINITIONS) {
    // Advancing to the current time with nothing due is a declared idempotent no-op.
    const registered = commands.register(worldCommand(type, version, type === "world.advance"));
    if (!registered.ok) return Object.freeze({ ok: false, error: registered.error });
  }
  for (const type of CONTAINMENT_COMMAND_TYPES) {
    const registered = commands.register({
      type,
      version: 1,
      owner: type.startsWith("resource.") ? "clockgrove.resource" : "clockgrove.containment",
      expectedRevision: "required",
      validatePayload: (payload) => {
        // Canonical checking also rejects accessors, explicit undefined and exotic objects.
        try {
          canonicalSerialize(payload);
        } catch {
          invalid("payload");
        }
        const parsed = CONTAINMENT_PAYLOAD_SCHEMAS[type].safeParse(payload);
        if (!parsed.success) {
          const path = parsed.error.issues[0]?.path.map(String).join(".");
          invalid(path ? `payload.${path}` : "payload");
        }
      },
      handler: runContainmentCommand,
    });
    if (!registered.ok) return Object.freeze({ ok: false, error: registered.error });
  }
  for (const type of MOVEMENT_COMMAND_TYPES) {
    const registered = commands.register({
      type,
      version: 1,
      owner: "clockgrove.movement",
      expectedRevision: "required",
      validatePayload: (payload) => {
        try {
          canonicalSerialize(payload);
        } catch {
          invalid("payload");
        }
        const parsed = parseMovementPayloadAtBoundary(type, payload);
        if (!parsed.ok) throw new RefusalSignal(parsed.error);
      },
      handler: runMovementCommand,
    });
    if (!registered.ok) return Object.freeze({ ok: false, error: registered.error });
  }
  for (const type of PORTAL_COMMAND_TYPES) {
    const registered = commands.register({
      type,
      version: 1,
      owner: PORTAL_OWNER,
      expectedRevision: "required",
      validatePayload: (payload) => {
        try {
          canonicalSerialize(payload);
        } catch {
          invalid("payload");
        }
        const parsed = guardDomain(() => parsePortalPayload(type, payload));
        if (!parsed.ok) throw new RefusalSignal(parsed.error);
      },
      handler: runPortalCommand,
    });
    if (!registered.ok) return Object.freeze({ ok: false, error: registered.error });
  }
  const movementChecks = registerMovementChecks(preconditions, invariants);
  if (!movementChecks.ok) return Object.freeze({ ok: false, error: movementChecks.error });
  const portalChecks = registerPortalChecks(preconditions, invariants);
  if (!portalChecks.ok) return Object.freeze({ ok: false, error: portalChecks.error });
  const containmentChecks = registerContainmentChecks(preconditions, invariants);
  if (!containmentChecks.ok) return Object.freeze({ ok: false, error: containmentChecks.error });
  const reduced = registerWorldReducers(events, reducers);
  if (!reduced.ok) return Object.freeze({ ok: false, error: reduced.error });
  const checked = registerWorldChecks(preconditions, invariants);
  if (!checked.ok) return Object.freeze({ ok: false, error: checked.error });
  const scheduled = new CommandRegistry<
    WorldState,
    WorldKernelInput,
    WorldEvent,
    WorldHandlerExtra
  >();
  const decision = scheduled.register({
    type: "world.decision",
    version: 1,
    owner: WORLD_OWNER,
    expectedRevision: "none",
    // A decision that repeats the actor's selection journals no event.
    idempotentNoOp: true,
    validatePayload: (payload) => {
      const value = payload as Record<string, unknown>;
      const keys = Reflect.ownKeys(value);
      for (const key of ["schemaVersion", "objectId"])
        if (!keys.includes(key) || value[key] === undefined)
          invalid(`input.scheduled.payload.${key}`);
      const extra = keys.find((key) => key !== "schemaVersion" && key !== "objectId");
      if (extra !== undefined) invalid(`input.scheduled.payload.${String(extra)}`);
      if (value.schemaVersion !== 1) invalid("input.scheduled.payload.schemaVersion");
      if (typeof value.objectId !== "string" || value.objectId.length === 0)
        invalid("input.scheduled.payload.objectId");
    },
    handler: runScheduledDecision,
  });
  if (!decision.ok) return Object.freeze({ ok: false, error: decision.error });
  return createKernel({
    commands,
    scheduled,
    events,
    reducers,
    preconditions,
    invariants,
    decodeInput: decodeWorldInput,
    revisionOf: (state) => state.revision,
    deriveDelta: (initial, final) => ({
      schemaVersion: 1,
      partitionId: final.partitionId,
      fromRevision: initial.revision,
      toRevision: final.revision,
      delta: final,
    }),
  });
}

const WORLD_KERNEL: WorldKernelCreation = buildWorldKernel();
const PRODUCTION: ExecuteOptions = Object.freeze({ mode: "production" });

/** Sorted command/event/reducer/check identities of the production world registry. */
export function worldRegistryIdentity(): Readonly<{
  commands: readonly (readonly [string, number])[];
  events: readonly (readonly [string, number])[];
  reducers: readonly (readonly [string, number])[];
  preconditions: readonly (readonly [string, number])[];
  invariants: readonly (readonly [string, number])[];
  scheduled: readonly (readonly [string, number])[];
  utility: readonly (readonly [string, number])[];
}> {
  if (!WORLD_KERNEL.ok)
    return Object.freeze({
      commands: [],
      events: [],
      reducers: [],
      preconditions: [],
      invariants: [],
      scheduled: [],
      utility: [],
    });
  return Object.freeze({ ...WORLD_KERNEL.kernel.identity(), utility: utilityRegistryIdentity() });
}

/** Runs the registered post-state invariants over an arbitrary reduced state. */
export function checkWorldInvariants(
  initial: WorldState,
  final: WorldState,
  events: readonly WorldSemanticEvent[],
  commandType:
    | WorldCommandType
    | ContainmentCommandType
    | MovementCommandType
    | PortalCommandType = "world.advance",
  /** The policy `environment.state-matches-policy@1` compares the state with; omitted means none. */
  policy?: WorldBehaviorPolicy,
  /** The payload of the command whose events are checked; omitted means an empty one. */
  payload: unknown = {},
): Refusal | undefined {
  if (!WORLD_KERNEL.ok) return WORLD_KERNEL.error;
  const kernel = WORLD_KERNEL.kernel;
  const subject = Object.freeze({ payload, initial, state: final, events });
  return withActivePolicy(policy, () => {
    for (const invariant of kernel.definition.invariants.ordered(commandType)) {
      const name = `${invariant.name}@${invariant.version}`;
      try {
        const offending = invariant.check(subject);
        if (offending !== undefined) return refusal("invariant-violated", offending, name);
      } catch {
        return refusal("check-error", "invariant", name);
      }
    }
    return undefined;
  });
}

/**
 * The existing pure transition seam, specialized to the first physical-behavior capability and
 * routed through the production registry, executor, reducers and invariants. Total: refusals are
 * returned, never thrown.
 */
export function executeWorldKernel(
  candidate: WorldKernelInput | ContainmentKernelInput | MovementKernelInput | PortalKernelInput,
  options: ExecuteOptions = PRODUCTION,
): WorldKernelOutcome {
  const input = candidate as WorldKernelInput;
  try {
    if (!WORLD_KERNEL.ok) return Object.freeze({ ok: false, error: WORLD_KERNEL.error });
    const kernel = WORLD_KERNEL.kernel;
    const outcome = withActivePolicy(policyOf(input), () => kernel.execute(input, options));
    if (!outcome.ok) return outcome;
    const { extra, ...execution } = outcome.result;
    if (extra === undefined)
      return Object.freeze({ ok: false, error: refusal("handler-failed", "handler") });
    const { state } = execution;
    return Object.freeze({
      ok: true,
      result: Object.freeze({
        ...execution,
        events: execution.events as readonly WorldSemanticEvent[],
        scheduleMutations: execution.scheduleMutations as readonly WorldScheduleMutation[],
        decisionDrafts: execution.decisionDrafts as readonly DecisionDraft<DecisionTrace>[],
        schedules: extra.schedules,
        complete: extra.complete,
        ...(extra.complete
          ? {}
          : {
              continuation: Object.freeze({
                schemaVersion: 1 as const,
                tenantId: state.tenantId,
                worldId: state.worldId,
                timelineId: state.timelineId,
                partitionId: state.partitionId,
                inputIdentity: extra.inputIdentity,
                stateIdentity: canonicalSerialize({ state, schedules: extra.schedules }),
                commandId: (input.input as { command: WorldCommand }).command.commandId,
                targetTime: (input.input as { command: WorldCommand }).command.payload.targetTime,
                packHash: input.pack.pack.contentHash,
                policyVersion: input.pack.pack.policy.version,
                expectedRevision: state.revision,
                stage: extra.stage,
              }),
            }),
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: error instanceof RefusalSignal ? error.refusal : refusal("invalid-input", "input"),
    });
  }
}

function decisionSchedule(
  state: WorldState,
  objectId: ObjectId,
  id: ScheduleId,
  dueAt: SimTimeMs,
): ScheduledItem<WorldScheduledPayload> {
  return Object.freeze({
    id,
    tenantId: state.tenantId,
    worldId: state.worldId,
    timelineId: state.timelineId,
    ownerPartitionId: state.partitionId,
    dueAt,
    priority: 10,
    tieBreakKey: objectId,
    kind: "world.decision",
    payloadVersion: 1,
    payload: Object.freeze({ schemaVersion: 1, objectId }),
    idempotencyKey: `${id}:${dueAt}`,
    catchUpClass: "exact",
  });
}
/** The `world.decision` items of a queue, in queue order: everything but remain-in-region dwells. */
function decisionsOf<T>(schedules: ScheduleQueue<T>): ScheduleQueue<T> {
  return schedules.filter((item) => !isDwellItem(item));
}
function validateDecisionQueue(
  state: WorldState,
  schedules: ScheduleQueue<WorldScheduledPayload>,
  actors: readonly WorldEntity[],
): void {
  const decisions = decisionsOf(schedules);
  if (
    decisions.length !== actors.length ||
    new Set(decisions.map((item) => item.payload.objectId)).size !== actors.length
  )
    throw new RangeError("each actor needs exactly one owned decision schedule");
  for (const item of schedules) {
    if (
      isDwellItem(item) &&
      item.tenantId === state.tenantId &&
      item.worldId === state.worldId &&
      item.timelineId === state.timelineId &&
      item.ownerPartitionId === state.partitionId
    ) {
      validateDwellItem(state, item);
      continue;
    }
    if (
      item.tenantId !== state.tenantId ||
      item.worldId !== state.worldId ||
      item.timelineId !== state.timelineId ||
      item.ownerPartitionId !== state.partitionId ||
      item.kind !== "world.decision" ||
      item.payloadVersion !== 1 ||
      item.payload.schemaVersion !== 1 ||
      item.catchUpClass !== "exact" ||
      item.dueAt < state.simulationTime ||
      !actors.some((actor) => actor.objectId === item.payload.objectId)
    )
      throw new RangeError("unsupported or foreign scheduled input");
  }
}
/** An actor's thirst and health integrated through `through`; no events, nothing stored. */
function wellbeingAt(
  state: WorldState,
  actor: WorldEntity,
  through: SimTimeMs,
  system: ContinuousSystem | undefined,
) {
  const entry = state.wellbeing?.entries.find((candidate) => candidate.objectId === actor.objectId);
  if (entry === undefined) return undefined;
  const record = state.environment;
  const needs = actor.needs;
  if (system === undefined || record === undefined || needs === undefined)
    throw new RangeError("wellbeing actor is missing its system or needs");
  if (entry.integratedAt >= through)
    return Object.freeze({
      thirst: entry.thirst,
      thirstRemainder: entry.thirstRemainder,
      health: entry.health,
      healthRemainder: entry.healthRemainder,
    });
  const next = wellbeingSnapshotOf(
    system.integrate(
      wellbeingSystemState({
        hunger: needs.hunger,
        hungerRemainder: needs.hungerRemainder,
        wetness: needs.wetness,
        wetnessRemainder: needs.wetnessRemainder,
        thirst: entry.thirst,
        thirstRemainder: entry.thirstRemainder,
        health: entry.health,
        healthRemainder: entry.healthRemainder,
        protection: rainProtectionOf(state, actor),
        rain: state.weather.rainIntensity,
        rainUntil: record.nextWeatherBoundary,
      }),
      entry.integratedAt,
      through,
    ),
  );
  return Object.freeze({
    thirst: next.thirst,
    thirstRemainder: next.thirstRemainder,
    health: next.health,
    healthRemainder: next.healthRemainder,
  });
}
/** A plant's growth integrated through `through`; `undefined` when it has nothing to integrate. */
function plantAt(
  state: WorldState,
  objectId: string,
  through: SimTimeMs,
  system: ContinuousSystem | undefined,
) {
  const entry = state.ecology?.plants.find((candidate) => candidate.objectId === objectId);
  const entity = state.entities.find((candidate) => candidate.objectId === objectId);
  const record = state.environment;
  if (entry === undefined || entity === undefined || record === undefined || system === undefined)
    throw new RangeError("plant is missing from the physical state");
  if (!active(entity) || entry.integratedAt >= through) return undefined;
  return growthSnapshotOf(
    system.integrate(
      growthSystemState({
        growingMs: entry.growingMs,
        wetness: entry.wetness,
        wetnessRemainder: entry.wetnessRemainder,
        protection: rainProtectionOf(state, entity),
        rain: state.weather.rainIntensity,
        rainUntil: record.nextWeatherBoundary,
        active: true,
      }),
      entry.integratedAt,
      through,
    ),
  );
}
/**
 * The continuous values at `through`, derived with the same lazy integration the kernel journals
 * (needs, wellbeing, plant growth). Pure: it reads the state and writes nothing, so it is a view,
 * never canonical state.
 */
export function worldContinuousAt(
  state: WorldState,
  policy: WorldBehaviorPolicy,
  through: SimTimeMs,
) {
  const at = through > state.simulationTime ? through : state.simulationTime;
  const environment = policy.environment;
  const wellbeing = policy.wellbeing;
  const integrate = (
    needs: WorldNeeds,
    protection: number,
    rain: number,
    to: SimTimeMs,
  ): WorldNeeds => integrateNeedsWith(needs, protection, rain, to, policy);
  const actors = livingActorsOf(state);
  return Object.freeze({
    simulationTime: at,
    needs: actors.map((actor) =>
      Object.freeze({
        objectId: actor.objectId,
        needs: integrateNeeds(state, actor, at, policy) as WorldNeeds,
      }),
    ),
    wellbeing:
      environment === undefined || wellbeing === undefined
        ? []
        : actors.flatMap((actor) => {
            const next = wellbeingAt(
              state,
              actor,
              at,
              createWellbeingSystem({
                objectId: actor.objectId,
                environment,
                wellbeing,
                decisionIntervalMs: policy.decisionIntervalMs,
                integrate,
              }),
            );
            return next === undefined ? [] : [Object.freeze({ objectId: actor.objectId, ...next })];
          }),
    plants:
      environment === undefined || policy.ecology === undefined
        ? []
        : policy.ecology.plants.flatMap((plant) => {
            const next = plantAt(
              state,
              plant.objectId,
              at,
              createGrowthSystem({ plant, environment, integrate }),
            );
            return next === undefined ? [] : [Object.freeze({ objectId: plant.objectId, ...next })];
          }),
  });
}
function integrateNeeds(
  state: WorldState,
  actor: WorldEntity,
  through: SimTimeMs,
  policy: WorldBehaviorPolicy,
): WorldNeeds | undefined {
  const needs = actor.needs;
  if (needs === undefined) return undefined;
  return integrateNeedsWith(
    needs,
    rainProtectionOf(state, actor),
    state.weather.rainIntensity,
    through,
    policy,
  );
}
/** Every source and perishable holder's contents, arrival and lifecycle in `state`. */
function ecologyHolders(state: WorldState, policy: EcologyPolicy): EcologyHolderInit[] {
  const record = state.ecology;
  if (record === undefined) throw new RangeError("ecology policy without a state record");
  const entities = new Map(state.entities.map((entity) => [entity.objectId as string, entity]));
  const arrivals = new Map(record.perishables.map((entry) => [entry.objectId, entry.arrivedAt]));
  const ids = new Set([...policy.sources, ...policy.perishables].map((entry) => entry.objectId));
  return [...ids].map((objectId) => {
    const entity = entities.get(objectId);
    if (entity === undefined) throw new RangeError("ecology object is missing from the state");
    return {
      objectId,
      quantity: entity.resource?.quantity ?? 0,
      arrival: arrivals.get(objectId) ?? null,
      active: active(entity),
    };
  });
}
/** The dynamic state the ecology systems start from: holder contents, arrivals and plant entries. */
function ecologyRunOptions(state: WorldState, policy: EcologyPolicy): EcologyRunOptions {
  const record = state.ecology;
  if (record === undefined) throw new RangeError("ecology policy without a state record");
  const plants: EcologyPlantInit[] = record.plants.map((entry) => {
    const entity = state.entities.find((candidate) => candidate.objectId === entry.objectId);
    if (entity === undefined) throw new RangeError("ecology object is missing from the state");
    return { entry, protection: rainProtectionOf(state, entity), active: active(entity) };
  });
  return {
    policy,
    holders: ecologyHolders(state, policy),
    plants,
    ...(record.waterHolders === undefined ? {} : { waterHolders: ecologyWaters(state) }),
  };
}
function ecologyWaters(state: WorldState): EcologyWaterInit[] {
  return (state.ecology?.waterHolders ?? []).map((entry) => {
    const entity = state.entities.find((candidate) => candidate.objectId === entry.objectId)!;
    return {
      entry,
      quantity: entity.resource!.quantity,
      protection: rainProtectionOf(state, entity),
      active: active(entity),
    };
  });
}
function waterAt(
  state: WorldState,
  objectId: string,
  through: SimTimeMs,
  policy: WorldBehaviorPolicy,
) {
  const init = ecologyWaters(state).find((candidate) => candidate.entry.objectId === objectId);
  const holder = policy.ecology?.waterHolders?.find((candidate) => candidate.objectId === objectId);
  if (
    init === undefined ||
    holder === undefined ||
    policy.environment === undefined ||
    state.environment === undefined
  )
    throw new RangeError("water holder without policy/state");
  if (init.entry.integratedAt >= through) return undefined;
  const system = createWaterSystem(holder, policy.environment);
  const next = waterSnapshotOf(
    system.integrate(
      waterSystemState({
        ...init.entry,
        quantity: init.quantity,
        protection: init.protection,
        active: init.active,
        rain: state.weather.rainIntensity,
        rainUntil: state.environment.nextWeatherBoundary,
      }),
      init.entry.integratedAt,
      through,
    ),
  );
  return {
    objectId: init.entry.objectId,
    collected: Number(next.collected ?? 0n),
    evaporated: Number(next.evaporated ?? 0n),
    collectionRemainder: next.collectionRemainder,
    evaporationRemainder: next.evaporationRemainder,
    integratedAt: through,
  };
}
/** The rain protection of the shelter an object is in: none once that shelter is retired. */
function rainProtectionOf(state: WorldState, actor: WorldEntity): number {
  const location = state.entities.find((entity) => entity.objectId === actor.locationId);
  return location !== undefined && active(location) ? (location.shelter?.rainProtection ?? 0) : 0;
}
/**
 * The world's single needs/wetness arithmetic, given the rain intensity and shelter protection in
 * force. `integrateNeeds` and the environment exposure system both call it.
 */
export function integrateNeedsWith(
  needs: WorldNeeds,
  rainProtection: number,
  rainIntensity: number,
  through: SimTimeMs,
  policy: WorldBehaviorPolicy,
): WorldNeeds {
  const elapsed = through - needs.integratedAt;
  if (elapsed < 0n) throw new RangeError("need integration cannot move backwards");
  const protection = BigInt(rainProtection);
  const hungerUnits = needs.hungerRemainder + elapsed * BigInt(policy.hungerPerInterval);
  const hungerRaw = BigInt(needs.hunger) + hungerUnits / policy.decisionIntervalMs;
  const exposedRain = BigInt(rainIntensity) * (10000n - protection);
  const wetnessRate =
    BigInt(policy.wetnessPerInterval) * exposedRain -
    BigInt(policy.dryingPerInterval) * (WETNESS_SCALE - exposedRain);
  const denominator = policy.decisionIntervalMs * WETNESS_SCALE;
  const wetnessUnits = needs.wetnessRemainder + elapsed * wetnessRate;
  // Floor division retains a nonnegative remainder even when drying crosses an integer boundary.
  const wetnessDelta =
    wetnessUnits >= 0n
      ? wetnessUnits / denominator
      : -((-wetnessUnits + denominator - 1n) / denominator);
  const wetnessRaw = BigInt(needs.wetness) + wetnessDelta;
  return Object.freeze({
    hunger: Number(clamp(hungerRaw)),
    wetness: Number(clamp(wetnessRaw)),
    integratedAt: through,
    hungerRemainder: hungerRaw >= 10000n ? 0n : hungerUnits % policy.decisionIntervalMs,
    wetnessRemainder:
      wetnessRaw < 0n || wetnessRaw >= 10000n ? 0n : wetnessUnits - wetnessDelta * denominator,
  });
}
function clamp(value: bigint): bigint {
  return value < 0n ? 0n : value > 10000n ? 10000n : value;
}
function chooseRoutine(
  state: WorldState,
  actor: WorldEntity,
  time: SimTimeMs,
  policy: WorldBehaviorPolicy,
): DecisionTrace {
  if (actor.needs === undefined) throw new RangeError("routine actor has no needs");
  const hunger = BigInt(actor.needs.hunger);
  const wetness = BigInt(actor.needs.wetness);
  const rain = BigInt(state.weather.rainIntensity);
  const candidates: RoutineCandidate[] = [
    Object.freeze({
      action: Object.freeze({ kind: "stay" as const }),
      features: Object.freeze({ hunger, wetness, rain }),
      score: 0n,
    }),
    Object.freeze({
      action: Object.freeze({ kind: "seek-food" as const }),
      features: Object.freeze({ hunger }),
      score: hunger * BigInt(policy.hungerWeight),
    }),
  ];
  for (const shelter of state.entities.filter((entity) => entity.shelter !== undefined)) {
    const compatible =
      shelter.spaceId === actor.spaceId &&
      shelter.pose.frameId === actor.pose.frameId &&
      shelter.pose.frameVersion === actor.pose.frameVersion;
    const protection = BigInt(shelter.shelter?.rainProtection ?? 0);
    candidates.push(
      Object.freeze({
        action: Object.freeze({ kind: "seek-shelter" as const, targetObjectId: shelter.objectId }),
        features: Object.freeze({ wetness, rain, protection }),
        score: ((wetness + rain) * protection * BigInt(policy.shelterWeight)) / 10000n,
        ...(!compatible
          ? { excludedReason: "outside-current-space-or-frame" }
          : protection === 0n
            ? { excludedReason: "no-rain-protection" }
            : {}),
      }),
    );
  }
  const eligible = candidates.filter((candidate) => candidate.excludedReason === undefined);
  const reflex =
    wetness >= 9000n
      ? eligible.filter((candidate) => candidate.action.kind === "seek-shelter")
      : [];
  const pool = reflex.length > 0 ? reflex : eligible;
  const selected = [...pool].sort((left, right) =>
    left.score === right.score
      ? actionKey(left) < actionKey(right)
        ? -1
        : actionKey(left) > actionKey(right)
          ? 1
          : 0
      : left.score > right.score
        ? -1
        : 1,
  )[0];
  if (selected === undefined) throw new RangeError("routine has no eligible invariant-safe action");
  return Object.freeze({
    schemaVersion: 1,
    objectId: actor.objectId,
    inputRevision: state.revision,
    simulationTime: time,
    policyVersion: policy.version,
    selectionTier: reflex.length > 0 ? "reflex" : "utility",
    candidates: Object.freeze(candidates),
    selectedAction: selected.action,
    perceptionRefs: Object.freeze([]),
    beliefRefs: Object.freeze([]),
    memoryRefs: Object.freeze([]),
    randomDraws: Object.freeze([]),
    outcomeLinks: Object.freeze([]),
  });
}
/** Whether a selection repeats the actor's current action (same kind and target). */
function sameAction(
  selected: { readonly kind: string; readonly targetObjectId?: string },
  prior: { readonly kind: string; readonly targetObjectId?: string } | undefined,
): boolean {
  return prior !== undefined && canonicalSerialize(selected) === canonicalSerialize(prior);
}
function actionKey(candidate: RoutineCandidate): string {
  return `${candidate.action.kind}:${candidate.action.targetObjectId ?? ""}`;
}

/** Exact material totals; safe-integer per-holder quantities never lose aggregate precision. */
export function worldResourceTotals(state: WorldState): Readonly<Record<string, bigint>> {
  return Object.freeze(
    Object.fromEntries(
      RESOURCE_KINDS.map((kind) => [
        kind,
        state.entities.reduce(
          (total, entity) =>
            total + (entity.resource?.kind === kind ? BigInt(entity.resource.quantity) : 0n),
          0n,
        ),
      ]),
    ),
  );
}

function active(entity: WorldEntity): boolean {
  return entity.lifecycle === undefined || entity.lifecycle.status === "active";
}
/**
 * Where an actor that has stopped moving at `position` is: an active shelter standing there in its
 * space and frame, other than itself (a moved shelter is never inside itself), else open ground
 * (null). Where several shelters stand together, the actor keeps the one it is in, else takes
 * `preferred` (the shelter it sought), else the first by object id.
 */
function shelterAt(
  state: WorldState,
  actor: WorldEntity,
  position: readonly bigint[],
  preferred?: string,
): string | null {
  const here = state.entities
    .filter(
      (entity) =>
        entity.shelter !== undefined &&
        entity.objectId !== actor.objectId &&
        active(entity) &&
        entity.spaceId === actor.spaceId &&
        entity.pose.frameId === actor.pose.frameId &&
        entity.pose.frameVersion === actor.pose.frameVersion &&
        sameCoordinates(entity.pose.coordinates, position),
    )
    .map((entity) => entity.objectId as string);
  for (const kept of [actor.locationId, preferred])
    if (kept !== undefined && kept !== null && here.includes(kept)) return kept;
  return here[0] ?? null;
}
/** Whether a movement takes its mover off the point it starts from (a zero-length one does not). */
function leavesStart(movement: MovementRecord): boolean {
  const [first, ...rest] = movement.segment.waypoints;
  return rest.some((point) => !sameCoordinates(point, first!));
}
function entityPath(state: WorldState, entity: WorldEntity): string {
  return `state.entities[${state.entities.indexOf(entity)}]`;
}
function children(state: WorldState, id: string): readonly WorldEntity[] {
  return state.entities.filter((entity) => entity.containment?.containerId === id);
}

function runContainmentCommand(
  context: WorldContext,
): HandlerOutput<WorldState, WorldHandlerExtra> {
  const { state, input } = context;
  const type = context.command.type as ContainmentCommandType;
  const payload = context.payload as ContainmentPayload;
  const find = (id: string) => state.entities.find((entity) => entity.objectId === id)!;
  const emit = (data: { type: string; payload: unknown }) => {
    context.emit({
      schemaVersion: 1,
      tenantId: state.tenantId,
      worldId: state.worldId,
      timelineId: state.timelineId,
      partitionId: state.partitionId,
      simulationTime: state.simulationTime,
      attribution: decodeAttributionEnvelope(input.attribution),
      policyVersions: input.policies.policyVersions,
      ...data,
    } as WorldEvent);
  };
  switch (type) {
    case "object.create": {
      const value = (payload as ContainmentPayload<"object.create">).object;
      const { spatial, ...rest } = value;
      const object = createWorldState({
        ...state,
        entities: [
          {
            ...rest,
            objectId: value.objectId as ObjectId,
            ...spatial,
            lifecycle: { status: "active" },
          } as WorldEntity,
        ],
      }).entities[0]!;
      emit({
        type: "object.created",
        payload: { object, quantityAdded: object.resource?.quantity ?? 0 },
      });
      break;
    }
    case "object.retire": {
      const p = payload as ContainmentPayload<"object.retire">;
      const entity = find(p.objectId);
      // Whatever is in a retired shelter stands on open ground from now: each is integrated first
      // under the protection still in force, then leaves it (`location.changed` to null).
      const occupants = state.entities.filter(
        (occupant) => occupant.locationId === entity.objectId && active(occupant),
      );
      if (occupants.length > 0) {
        const at = state.simulationTime;
        const continuous = worldContinuousAt(state, input.pack.pack.policy, at);
        for (const occupant of occupants) {
          const objectId = occupant.objectId;
          const needs = continuous.needs.find((entry) => entry.objectId === objectId)?.needs;
          if (
            needs !== undefined &&
            canonicalSerialize(needs) !== canonicalSerialize(occupant.needs)
          )
            emit({ type: "needs.changed", payload: { objectId, ...needs } });
          const wellbeing = continuous.wellbeing.find((entry) => entry.objectId === objectId);
          const entry = state.wellbeing?.entries.find((item) => item.objectId === objectId);
          if (wellbeing !== undefined && entry !== undefined && entry.integratedAt !== at)
            emit({ type: "wellbeing.integrated", payload: { ...wellbeing, integratedAt: at } });
          const growth = continuous.plants.find((item) => item.objectId === objectId);
          if (growth !== undefined)
            emit({ type: "growth.integrated", payload: { ...growth, integratedAt: at } });
          emit({
            type: "location.changed",
            payload: { objectId, locationId: null, planId: context.command.commandId },
          });
        }
      }
      emit({
        type: "object.retired",
        payload: {
          objectId: entity.objectId,
          disposition: p.disposition,
          kind: entity.resource?.kind ?? null,
          quantityRemoved: entity.resource?.quantity ?? 0,
        },
      });
      break;
    }
    case "containment.put":
      emit({ type: "containment.put", payload: withoutVersion(payload) });
      break;
    case "containment.remove":
      emit({ type: "containment.removed", payload: withoutVersion(payload) });
      break;
    case "containment.transfer":
      emit({ type: "containment.transferred", payload: withoutVersion(payload) });
      break;
    case "resource.offer":
      emit({ type: "resource.offered", payload: withoutVersion(payload) });
      break;
    case "resource.consume":
      emit({ type: "resource.consumed", payload: withoutVersion(payload) });
      break;
    case "resource.transfer":
      emit({ type: "resource.transferred", payload: withoutVersion(payload) });
      break;
  }
  const final = context.workingState();
  // A retired object leaves no keyed dwell behind.
  let schedules = createScheduleQueue(input.schedules);
  const mutations =
    type === "object.retire"
      ? dwellChanges(schedules, final, {
          type: "object.retired",
          simulationTime: state.simulationTime,
          payload: payload,
        })
      : [];
  for (const change of mutations)
    if (change.kind === "cancel") schedules = cancelSchedule(schedules, change.scheduleId);
  return {
    scheduleMutations: mutations as readonly WorldScheduleMutation[],
    projectionDelta: {
      schemaVersion: 1,
      partitionId: state.partitionId,
      fromRevision: state.revision,
      toRevision: final.revision,
      delta: final,
    },
    extra: {
      schedules,
      complete: true,
      stage: "scheduled",
      inputIdentity: "",
    },
  };
}
/** A movement or portal command, run by `runWorld` so it passes the world time like `world.advance`. */
function runMovingCommand(
  context: WorldContext,
  move: (rt: MovementRuntime) => void,
): HandlerOutput<WorldState, WorldHandlerExtra> {
  return runWorld(context, {
    type: context.command.type as MovementCommandType | PortalCommandType,
    // A moving command is atomic and never continued: over the budget it is refused whole.
    payload: {
      schemaVersion: 1,
      targetTime: context.state.simulationTime,
      maxInputs: MAX_INPUTS_PER_CALL,
      maxEvents: MAX_EVENTS_PER_CALL,
    },
    inputIdentity: () => "",
    move,
  });
}

/** `portal.open` and `portal.close` emit their one event; `portal.use` moves through the portal. */
function runPortalCommand(context: WorldContext): HandlerOutput<WorldState, WorldHandlerExtra> {
  return runMovingCommand(context, (rt) => {
    if (context.command.type === "portal.use") runPortalUse(rt);
    else
      rt.emit(
        context.command.type === "portal.open" ? "portal.opened" : "portal.closed",
        { portalId: (context.payload as PortalTogglePayload).portalId },
        context.state.simulationTime,
      );
  });
}

function runMovementCommand(context: WorldContext): HandlerOutput<WorldState, WorldHandlerExtra> {
  return runMovingCommand(context, runMovementHandler);
}

/** Index of the first emitted crossing that repeats a state or goes back in time, or -1. */
function badCrossingIndex(movement: NonNullable<WorldEntity["movement"]>): number {
  const inside = new Set(movement.initialInside);
  for (const [index, crossing] of movement.emitted.entries()) {
    if (index > 0 && crossing.time < movement.emitted[index - 1]!.time) return index;
    if (crossing.kind === "portal") continue;
    if (crossing.kind === "entered") {
      if (inside.has(crossing.regionId)) return index;
      inside.add(crossing.regionId);
    } else {
      if (!inside.has(crossing.regionId)) return index;
      inside.delete(crossing.regionId);
    }
  }
  return -1;
}

/**
 * The path of the first resource event of a moving command's world time that its ecology does not
 * own, or undefined: food appears only at its source's appearance times, and spoils only when its
 * holder's shelf life ends.
 */
function passedTimeDisagreement(
  initial: WorldState,
  events: readonly WorldEvent[],
): string | undefined {
  const ecology = activePolicy?.ecology;
  const arrived = new Map(
    (initial.ecology?.perishables ?? []).map((entry) => [
      entry.objectId as string,
      entry.arrivedAt,
    ]),
  );
  for (const [index, event] of events.entries()) {
    const time = event.simulationTime;
    const objectId = (event.payload as { objectId?: string }).objectId as string;
    let owned = true;
    if (event.type === "resource.appeared") {
      const source = ecology?.sources.find((candidate) => candidate.objectId === objectId);
      owned =
        source !== undefined &&
        time >= source.firstAtMs &&
        (time - source.firstAtMs) % source.periodMs === 0n;
      if (arrived.has(objectId)) arrived.set(objectId, time);
    } else if (event.type === "resource.spoiled") {
      const holder = ecology?.perishables.find((candidate) => candidate.objectId === objectId);
      const since = arrived.get(objectId);
      owned = holder !== undefined && since != null && since + holder.shelfLifeMs === time;
      arrived.set(objectId, null);
    }
    if (!owned) return `events[${index}].simulationTime`;
  }
  return undefined;
}

/**
 * The path of the first event a moving command (`movement.*`, `portal.use`) may not emit, or
 * undefined. The mover's own movement events belong to the command alone; the world time's events,
 * including other objects' movement events, come from the systems that run with it. A mover's
 * `movement.interrupted` is also allowed when its `lifecycle.died` follows at the same time.
 */
function movingEventAuthority(
  type: MovementCommandType | "portal.use",
  subject: WorldInvariantSubject,
): string | undefined {
  const mover = (subject.payload as { readonly objectId?: string }).objectId;
  const { events } = subject;
  const index = events.findIndex((event, at) => {
    if (!WORLD_TIME_TYPES.includes(event.type)) return true;
    if (!MOVEMENT_LIFECYCLE_TYPES.has(event.type)) return false;
    if ((event.payload as { readonly objectId?: string }).objectId !== mover) return false;
    if (OWN_MOVEMENT_TYPES[type].includes(event.type)) return false;
    return !(
      event.type === "movement.interrupted" &&
      events
        .slice(at + 1)
        .some(
          (later) =>
            later.type === "lifecycle.died" &&
            later.simulationTime === event.simulationTime &&
            (later.payload as { readonly objectId?: string }).objectId === mover,
        )
    );
  });
  return index < 0 ? undefined : `events[${index}].type`;
}

function registerMovementChecks(
  preconditions: CheckRegistry<WorldPrecondition>,
  invariants: CheckRegistry<WorldInvariantSubject>,
): RegistrationResult {
  /** `portal.use` moves its actor like `movement.start`, so it shares the movement invariants. */
  const moving = [...MOVEMENT_COMMAND_TYPES, "portal.use"] as const;
  const pre = (name: "active-object" | "route" | "timing") =>
    preconditions.register({
      name: `movement.${name}`,
      version: 1,
      commands: MOVEMENT_COMMAND_TYPES,
      check: ({ state, command, payload }) =>
        movementPreconditionPath(name, state, command.type, command.commandId, payload),
    });
  const results = [
    ...MOVEMENT_COMMAND_TYPES.map((type) =>
      invariants.register({
        name: `movement.event-authority.${type}`,
        version: 3,
        commands: [type],
        check: (subject) => movingEventAuthority(type, subject),
      }),
    ),
    pre("active-object"),
    pre("route"),
    pre("timing"),
    preconditions.register({
      name: PASSED_TIME_CHECK,
      version: PASSED_TIME_VERSION,
      commands: ["movement.interrupt", "movement.replan"],
      check: ({ state, input, payload }) =>
        (payload as MovementInterruptPayload).at - state.simulationTime >
        input.pack.pack.policy.decisionIntervalMs
          ? "payload.at"
          : undefined,
    }),
    invariants.register({
      name: "movement.events-ordered-and-unique",
      version: 3,
      commands: moving,
      check: ({ initial, state, events }) => {
        // Every event is in time order and none repeats, except a consumption: two actors eating
        // from one holder at one time each journal the same `resource.consumed`.
        let last = initial.simulationTime;
        const seen = new Set<string>();
        for (const [index, event] of events.entries()) {
          if (event.simulationTime < last) return `events[${index}].simulationTime`;
          last = event.simulationTime;
          if (REPEATABLE_MOVING_TYPES.has(event.type)) continue;
          const key = canonicalSerialize({
            type: event.type,
            time: event.simulationTime,
            payload: event.payload,
          });
          if (seen.has(key)) return `events[${index}]`;
          seen.add(key);
        }
        return events.length > 0 && state.simulationTime !== last
          ? "state.simulationTime"
          : undefined;
      },
    }),
    invariants.register({
      name: "movement.crossings-consistent",
      version: 1,
      check: ({ state }) => {
        for (const entity of state.entities) {
          if (entity.movement === undefined) continue;
          const bad = badCrossingIndex(entity.movement);
          if (bad >= 0) return `${entityPath(state, entity)}.movement.emitted[${bad}]`;
        }
        return undefined;
      },
    }),
    invariants.register({
      name: "movement.scope",
      version: 4,
      commands: moving,
      check: ({ initial, state, events, payload }) => {
        // The command moves one object: its own events name its mover, and the only other objects
        // with movement events are needs actors, the ones the routine movers move, and objects whose
        // dwell falls due (`movement.region-remained` changes no entity field). The world time it
        // passes changes, on each object an event names, only the fields that event type owns
        // (`MOVING_ENTITY_FIELDS`); the mover's movement and pose change only through movement
        // events. Food appears and spoils only at the times its ecology owns. The frames, regions
        // and anchor graphs never change, and the weather only at a weather transition. No entity
        // is removed, and the only new ones are those born.
        const unowned = passedTimeDisagreement(initial, events);
        if (unowned !== undefined) return unowned;
        const mover = (payload as { readonly objectId?: string }).objectId;
        const born = new Set(
          events
            .filter((event) => event.type === "lifecycle.born")
            .map((event) => (event.payload as { childId: string }).childId),
        );
        const objectOf = (event: WorldEvent) =>
          (event.payload as { readonly objectId?: string }).objectId;
        const moved = new Set(
          events
            .filter(
              (event) =>
                event.type.startsWith("movement.") && event.type !== "movement.region-remained",
            )
            .map(objectOf),
        );
        if (!moved.has(mover)) return "events";
        for (const objectId of moved)
          if (
            objectId !== mover &&
            !born.has(objectId as string) &&
            initial.entities.find((entity) => entity.objectId === objectId)?.needs === undefined
          )
            return "events";
        const weather = events.some((event) => event.type === "weather.transitioned");
        for (const key of ["weather", "spatialFrames", "spatialRegions", "anchorGraphs"] as const)
          if (
            !(key === "weather" && weather) &&
            canonicalSerialize(initial[key] ?? null) !== canonicalSerialize(state[key] ?? null)
          )
            return `state.${key}`;
        const released = new Map<string, Set<string>>();
        for (const event of events) {
          const objectId = objectOf(event);
          const fields = MOVING_ENTITY_FIELDS[event.type];
          if (objectId === undefined || fields === undefined) continue;
          const set = released.get(objectId) ?? new Set<string>();
          for (const field of fields) set.add(field);
          released.set(objectId, set);
        }
        for (const before of initial.entities)
          if (!state.entities.some((entity) => entity.objectId === before.objectId))
            return "state.entities";
        for (const entity of state.entities) {
          const before = initial.entities.find(
            (candidate) => candidate.objectId === entity.objectId,
          );
          if (before === undefined) {
            if (!born.has(entity.objectId)) return "state.entities";
            continue;
          }
          const free = released.get(entity.objectId);
          const kept = (value: WorldEntity) =>
            canonicalSerialize(
              Object.fromEntries(Object.entries(value).filter(([key]) => free?.has(key) !== true)),
            );
          if (kept(before) !== kept(entity)) return entityPath(state, entity);
        }
        return undefined;
      },
    }),
  ];
  return results.find((result) => !result.ok) ?? { ok: true };
}

/**
 * Portal preconditions (`portal.<check>@1`, see `portalPreconditionPath`), per-command event
 * authority, and the global `portal.transit-open@1`: no active movement still has to cross a
 * portal that is not open, so actors cross only through open portals.
 */
function registerPortalChecks(
  preconditions: CheckRegistry<WorldPrecondition>,
  invariants: CheckRegistry<WorldInvariantSubject>,
): RegistrationResult {
  const results = [
    ...PORTAL_CHECKS.map((name: PortalCheck) =>
      preconditions.register({
        name: `portal.${name}`,
        version: 1,
        commands: PORTAL_COMMAND_TYPES,
        check: ({ state, command, payload }) =>
          portalPreconditionPath(
            name,
            state,
            command.type as PortalCommandType,
            command.commandId,
            payload,
          ),
      }),
    ),
    ...PORTAL_COMMAND_TYPES.map((type) =>
      invariants.register({
        name: `portal.event-authority.${type}`,
        // `portal.use` allows the world time's events: those of `world.advance` since version 3.
        version: type === "portal.use" ? 3 : 1,
        commands: [type],
        check: (subject) => {
          if (type === "portal.use") return movingEventAuthority(type, subject);
          const only = type === "portal.open" ? "portal.opened" : "portal.closed";
          const index = subject.events.findIndex((event) => event.type !== only);
          return index < 0 ? undefined : `events[${index}].type`;
        },
      }),
    ),
    invariants.register({
      name: "portal.transit-open",
      version: 1,
      check: ({ state }) => {
        for (const entity of state.entities) {
          if (entity.movement === undefined) continue;
          const steps = pendingPortalSteps(entity.movement);
          const index = steps.findIndex((step) => !portalIsOpen(state, step.portalId));
          if (index >= 0) {
            const at = (entity.movement.portalSteps ?? []).length - steps.length + index;
            return `${entityPath(state, entity)}.movement.portalSteps[${at}]`;
          }
        }
        return undefined;
      },
    }),
  ];
  return results.find((result) => !result.ok) ?? { ok: true };
}

function withoutVersion(payload: ContainmentPayload): unknown {
  const { schemaVersion: _version, ...rest } = payload;
  return rest;
}

function registerContainmentChecks(
  preconditions: CheckRegistry<WorldPrecondition>,
  invariants: CheckRegistry<WorldInvariantSubject>,
): RegistrationResult {
  const registerPre = (name: string, check: (context: WorldPrecondition) => string | undefined) =>
    preconditions.register({ name, version: 1, commands: CONTAINMENT_COMMAND_TYPES, check });
  const authority: Record<ContainmentCommandType, readonly string[]> = {
    "object.create": ["object.created"],
    // Retiring a shelter integrates and evicts whatever is in it first.
    "object.retire": [
      "needs.changed",
      "wellbeing.integrated",
      "growth.integrated",
      "location.changed",
      "object.retired",
    ],
    "containment.put": ["containment.put"],
    "containment.remove": ["containment.removed"],
    "containment.transfer": ["containment.transferred"],
    "resource.offer": ["resource.offered"],
    "resource.consume": ["resource.consumed"],
    "resource.transfer": ["resource.transferred"],
  };
  const authorityChecks = [
    ...CONTAINMENT_COMMAND_TYPES,
    ...new Set(WORLD_COMMAND_DEFINITIONS.map(({ type }) => type)),
  ].map((type) =>
    invariants.register({
      name: `resource.event-authority.${type}`,
      version: type === "object.retire" ? 2 : 1,
      commands: [type],
      check: ({ events }) => {
        const allowed =
          type in authority
            ? authority[type as ContainmentCommandType]
            : [
                "weather.changed",
                "needs.changed",
                "routine.selected",
                "time.advanced",
                "environment.phase-changed",
                "weather.transitioned",
                "exposure.threshold-crossed",
                "resource.appeared",
                "resource.weather-integrated",
                "resource.spoiled",
                "growth.stage-changed",
                "growth.integrated",
                "wellbeing.integrated",
                "needs.threshold-crossed",
                "comfort.changed",
                "health.threshold-crossed",
                "movement.started",
                "movement.region-entered",
                "movement.region-exited",
                "movement.region-remained",
                "movement.portal-crossed",
                "movement.interrupted",
                "movement.replanned",
                "movement.completed",
                "resource.consumed",
                "location.changed",
                "needs.relieved",
                "lifecycle.conceived",
                "lifecycle.gestation-milestone",
                "lifecycle.born",
                "lifecycle.stage-changed",
                "lifecycle.died",
                "lifecycle.successor-intended",
              ];
        const index = events.findIndex((event) => !allowed.includes(event.type));
        return index < 0 ? undefined : `events[${index}].type`;
      },
    }),
  );
  const results = [
    ...authorityChecks,
    registerPre("containment.fixture-and-references", ({ state, payload, input, command }) => {
      if (input.continuation !== undefined) return "continuation";
      const p = payload as Record<string, unknown>;
      if (command.type === "object.create") {
        const value = (payload as ContainmentPayload<"object.create">).object;
        if (state.entities.length >= 128) return "state.entities";
        if (state.entities.some((entity) => entity.objectId === value.objectId))
          return "payload.object.objectId";
        if (!input.pack.pack.archetypes.includes(value.archetypeId))
          return "payload.object.archetypeId";
        if (value.spatial.locationId !== undefined) return "payload.object.spatial.locationId";
        try {
          createWorldState({
            ...state,
            entities: [
              { ...value, ...value.spatial, objectId: value.objectId as ObjectId } as WorldEntity,
            ],
          });
        } catch {
          return "payload.object.spatial.pose";
        }
        if (value.containment?.containerId !== undefined) {
          const parent = state.entities.find(
            (entity) => entity.objectId === value.containment!.containerId,
          );
          if (parent === undefined || !active(parent) || parent.containment === undefined)
            return "payload.object.containment.containerId";
          if (parent.spaceId !== value.spatial.spaceId) return "payload.object.spatial.spaceId";
          if (children(state, parent.objectId).length >= parent.containment.capacity)
            return "payload.object.containment.containerId";
        }
        return undefined;
      }
      for (const key of [
        "objectId",
        "containerId",
        "fromContainerId",
        "toContainerId",
        "fromObjectId",
        "toObjectId",
      ]) {
        if (p[key] === undefined) continue;
        const entity = state.entities.find((candidate) => candidate.objectId === p[key]);
        if (entity === undefined || !active(entity)) return `payload.${key}`;
      }
      return undefined;
    }),
    registerPre("containment.operation", ({ state, payload, command }) => {
      const p = payload as Record<string, string>;
      const object = state.entities.find((entity) => entity.objectId === p.objectId);
      if (command.type === "object.retire") {
        if (object!.needs !== undefined) return "payload.objectId";
        if (children(state, object!.objectId).length !== 0) return "payload.objectId";
      }
      if (!command.type.startsWith("containment.")) return undefined;
      if (object!.containment === undefined) return "payload.objectId";
      const old = object!.containment.containerId;
      if (command.type === "containment.put" && old !== undefined) return "payload.objectId";
      if (command.type !== "containment.put" && old !== (p.containerId ?? p.fromContainerId))
        return command.type === "containment.remove"
          ? "payload.containerId"
          : "payload.fromContainerId";
      if (command.type === "containment.remove") return undefined;
      const key = command.type === "containment.put" ? "containerId" : "toContainerId";
      const destination = state.entities.find((entity) => entity.objectId === p[key])!;
      if (destination.containment === undefined) return `payload.${key}`;
      if (destination.spaceId !== object!.spaceId) return `payload.${key}`;
      if (children(state, destination.objectId).length >= destination.containment.capacity)
        return `payload.${key}`;
      let ancestor: WorldEntity | undefined = destination;
      const seen = new Set<string>();
      while (ancestor !== undefined) {
        if (ancestor.objectId === object!.objectId || seen.has(ancestor.objectId))
          return `payload.${key}`;
        seen.add(ancestor.objectId);
        ancestor = state.entities.find(
          (entity) => entity.objectId === ancestor!.containment?.containerId,
        );
      }
      return undefined;
    }),
    registerPre("resource.available-and-bounded", ({ state, payload, command }) => {
      if (!command.type.startsWith("resource.")) return undefined;
      const p = payload as ContainmentPayload<"resource.transfer"> &
        ContainmentPayload<"resource.offer">;
      const source = state.entities.find(
        (entity) => entity.objectId === (p.objectId ?? p.fromObjectId),
      )!;
      if (source.resource?.kind !== p.kind) return "payload.kind";
      if (command.type !== "resource.offer" && source.resource.quantity < p.quantity)
        return "payload.quantity";
      if (
        command.type === "resource.offer" &&
        source.resource.quantity > Number.MAX_SAFE_INTEGER - p.quantity
      )
        return "payload.quantity";
      if (command.type === "resource.transfer") {
        if (p.fromObjectId === p.toObjectId) return "payload.toObjectId";
        const target = state.entities.find((entity) => entity.objectId === p.toObjectId)!;
        if (target.resource?.kind !== p.kind) return "payload.kind";
        if (target.resource.quantity > Number.MAX_SAFE_INTEGER - p.quantity)
          return "payload.quantity";
      }
      return undefined;
    }),
    registerPre("resource.perishable-single-batch", ({ state, payload, command }) => {
      if (command.type !== "resource.offer" && command.type !== "resource.transfer")
        return undefined;
      const p = payload as { objectId?: string; toObjectId?: string };
      const offer = command.type === "resource.offer";
      const id = offer ? p.objectId : p.toObjectId;
      if (state.ecology?.perishables.some((entry) => entry.objectId === id) !== true)
        return undefined;
      const holder = state.entities.find((entity) => entity.objectId === id);
      return (holder?.resource?.quantity ?? 0) > 0
        ? offer
          ? "payload.objectId"
          : "payload.toObjectId"
        : undefined;
    }),
    invariants.register({
      name: "containment.structure",
      version: 1,
      check: ({ state }) => {
        for (const entity of state.entities) {
          const path = entityPath(state, entity);
          if (typeof entity.spaceId !== "string" || entity.spaceId.length === 0)
            return `${path}.spaceId`;
          const containment = entity.containment;
          if (containment === undefined) continue;
          if (!Number.isSafeInteger(containment.capacity) || containment.capacity < 1)
            return `${path}.containment.capacity`;
          if (children(state, entity.objectId).length > containment.capacity)
            return `${path}.containment.capacity`;
          let ancestor: WorldEntity | undefined = entity;
          const seen = new Set<string>();
          while (ancestor?.containment?.containerId !== undefined) {
            if (seen.has(ancestor.objectId)) return `${path}.containment.containerId`;
            seen.add(ancestor.objectId);
            const parent: WorldEntity | undefined = state.entities.find(
              (candidate) => candidate.objectId === ancestor!.containment!.containerId,
            );
            if (parent?.containment === undefined || !active(parent))
              return `${path}.containment.containerId`;
            if (parent.spaceId !== entity.spaceId) return `${path}.spaceId`;
            ancestor = parent;
          }
        }
        return undefined;
      },
    }),
    invariants.register({
      name: "object.immutable-scope",
      version: 1,
      check: ({ initial, state }) => {
        for (const key of ["tenantId", "worldId", "timelineId", "partitionId"] as const)
          if (initial[key] !== state[key]) return `state.${key}`;
        for (const entity of initial.entities)
          if (!state.entities.some((candidate) => candidate.objectId === entity.objectId))
            return "state.entities";
        // Entity scope is inherited exclusively from its immutable partition envelope.
        for (const entity of state.entities)
          for (const key of ["tenantId", "worldId", "timelineId", "partitionId"])
            if (Object.hasOwn(entity, key)) return `${entityPath(state, entity)}.${key}`;
        return undefined;
      },
    }),
    invariants.register({
      name: "object.lifecycle",
      version: 1,
      check: ({ initial, state }) => {
        for (const entity of state.entities) {
          const path = entityPath(state, entity);
          const before = initial.entities.find(
            (candidate) => candidate.objectId === entity.objectId,
          );
          if (
            before !== undefined &&
            !active(before) &&
            canonicalSerialize(before) !== canonicalSerialize(entity)
          )
            return path;
          if (!active(entity) && children(state, entity.objectId).some(active))
            return `${path}.lifecycle.status`;
          if (
            !active(entity) &&
            (entity.resource?.quantity ?? 0) !== 0 &&
            before?.lifecycle?.status !== entity.lifecycle?.status
          )
            return `${path}.resource.quantity`;
        }
        return undefined;
      },
    }),
    invariants.register({
      name: "resource.quantity-conservation",
      version: 1,
      check: ({ initial, state, events }) => {
        for (const entity of state.entities) {
          if (
            entity.resource !== undefined &&
            (!RESOURCE_KINDS.includes(entity.resource.kind) ||
              !Number.isSafeInteger(entity.resource.quantity) ||
              entity.resource.quantity < 0 ||
              Object.is(entity.resource.quantity, -0))
          )
            return `${entityPath(state, entity)}.resource.quantity`;
        }
        const before = worldResourceTotals(initial),
          after = worldResourceTotals(state);
        const changes = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, 0n]));
        const holderChanges = new Map<ObjectId, Map<string, bigint>>();
        const changeHolder = (objectId: ObjectId, kind: string, quantity: bigint) => {
          const holder = holderChanges.get(objectId) ?? new Map<string, bigint>();
          holder.set(kind, (holder.get(kind) ?? 0n) + quantity);
          holderChanges.set(objectId, holder);
        };
        for (const event of events) {
          switch (event.type) {
            case "object.created":
              if (event.payload.object.resource !== undefined) {
                changes[event.payload.object.resource.kind]! += BigInt(event.payload.quantityAdded);
                changeHolder(
                  event.payload.object.objectId,
                  event.payload.object.resource.kind,
                  BigInt(event.payload.quantityAdded),
                );
              }
              break;
            case "object.retired":
              if (event.payload.kind !== null) {
                changes[event.payload.kind]! -= BigInt(event.payload.quantityRemoved);
                changeHolder(
                  event.payload.objectId,
                  event.payload.kind,
                  -BigInt(event.payload.quantityRemoved),
                );
              }
              break;
            case "resource.offered":
              changes[event.payload.kind]! += BigInt(event.payload.quantity);
              changeHolder(
                event.payload.objectId,
                event.payload.kind,
                BigInt(event.payload.quantity),
              );
              break;
            case "resource.consumed":
              changes[event.payload.kind]! -= BigInt(event.payload.quantity);
              changeHolder(
                event.payload.objectId,
                event.payload.kind,
                -BigInt(event.payload.quantity),
              );
              break;
            case "resource.appeared":
              changes[event.payload.kind]! += BigInt(event.payload.quantity);
              changeHolder(
                event.payload.objectId,
                event.payload.kind,
                BigInt(event.payload.quantity),
              );
              break;
            case "resource.weather-integrated": {
              const delta = BigInt(event.payload.collected) - BigInt(event.payload.evaporated);
              changes.water! += delta;
              changeHolder(event.payload.objectId, "water", delta);
              break;
            }
            case "growth.stage-changed":
              if (event.payload.yield !== undefined) {
                const quantity = BigInt(event.payload.yield.quantity);
                changes.food! += quantity;
                changeHolder(event.payload.objectId, "food", quantity);
              }
              break;
            case "resource.transferred":
              changeHolder(
                event.payload.fromObjectId,
                event.payload.kind,
                -BigInt(event.payload.quantity),
              );
              changeHolder(
                event.payload.toObjectId,
                event.payload.kind,
                BigInt(event.payload.quantity),
              );
              break;
            case "resource.spoiled":
              changes[event.payload.kind]! -= BigInt(event.payload.quantity);
              changeHolder(
                event.payload.objectId,
                event.payload.kind,
                -BigInt(event.payload.quantity),
              );
              break;
          }
        }
        for (const kind of RESOURCE_KINDS)
          if (after[kind]! - before[kind]! !== changes[kind]) return `state.resources.${kind}`;
        const beforeHolders = new Map(initial.entities.map((entity) => [entity.objectId, entity]));
        const afterHolders = new Map(state.entities.map((entity) => [entity.objectId, entity]));
        const holderIds = new Set([
          ...beforeHolders.keys(),
          ...afterHolders.keys(),
          ...holderChanges.keys(),
        ]);
        for (const objectId of [...holderIds].sort()) {
          const beforeHolder = beforeHolders.get(objectId);
          const afterHolder = afterHolders.get(objectId);
          for (const kind of RESOURCE_KINDS) {
            const beforeQuantity =
              beforeHolder?.resource?.kind === kind ? BigInt(beforeHolder.resource.quantity) : 0n;
            const afterQuantity =
              afterHolder?.resource?.kind === kind ? BigInt(afterHolder.resource.quantity) : 0n;
            if (afterQuantity - beforeQuantity !== (holderChanges.get(objectId)?.get(kind) ?? 0n))
              return afterHolder === undefined
                ? "state.entities"
                : `${entityPath(state, afterHolder)}.resource.quantity`;
          }
        }
        return undefined;
      },
    }),
  ];
  return results.find((result) => !result.ok) ?? { ok: true };
}
