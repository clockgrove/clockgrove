import {
  type AttributionEnvelope,
  decodeAttributionEnvelope,
  decodeExecutionContextRef,
  decodeOpaqueId,
} from "@clockgrove/contracts";
import {
  DomainValidationError,
  type NamedRandomState,
  replayWorldEvents,
  type WorldBehaviorPack,
  type WorldEvent,
  type WorldState,
} from "@clockgrove/domain";
import {
  canonicalBytes,
  checkWorldTransitionInvariants,
  createDeterministicIdSource,
  dispatchWorldDecision,
  evaluateRules,
  executeWorldKernel,
  PERCEIVABLE_EVENT_TYPES,
  resolveAudience,
  restoreNamedRandomState,
  type ScheduledItem,
  serializeNamedRandomState,
  type WorldCommand,
  type WorldKernelInput,
  type WorldKernelOutcome,
  type WorldScheduledPayload,
  worldRegistryIdentity,
} from "@clockgrove/kernel";
import { checkCapabilityCommand, type ValidatedWorldPack } from "@clockgrove/world-pack-sdk";
import { decodeCanonicalBytes } from "../canonical-decode.js";
import type { GenesisBundle } from "../genesis.js";
import type { RandomStreamRecord, RecordList, ScenarioRun } from "./bundle.js";
import { eventMatches, materialEvent } from "./compare.js";
import type { CapabilityVia, ScenarioDocument, ScenarioStep } from "./document.js";
import { SCENARIO_LIMITS } from "./document.js";
import { DigestStream, SubjectTable } from "./summary.js";
import { clonePlain, compareText, isOneOf, isRecord, plain, type Rec, refuse } from "./support.js";

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

/**
 * Where a plan's kernel calls run. Without a driver each call is the pure kernel in memory. A driver
 * runs the same call elsewhere (the Journal parity harness runs it through the journal use cases) and
 * returns the kernel's outcome, or `undefined` when the call was answered from a stored outcome (an
 * exact retry the Journal deduplicates): no kernel call ran and nothing changed. `restart` runs at a
 * `restart` step, after the snapshot round trip.
 */
export interface ScenarioKernelDriver {
  call(input: WorldKernelInput): Promise<WorldKernelOutcome | undefined>;
  restart?(): Promise<void>;
}

export interface PlanContext {
  readonly scenario: ScenarioDocument;
  readonly pack: ValidatedWorldPack;
  readonly seed: GenesisBundle;
  readonly behaviorPack: WorldBehaviorPack | null;
  readonly sha256: Sha256;
  /** The kernel driver of each plan, by run name; absent for the pure kernel. */
  readonly driver?: (run: string) => ScenarioKernelDriver;
}

interface Item {
  readonly id: string;
  readonly kind: string;
  readonly dueAt: bigint;
  readonly payload: unknown;
  readonly raw: unknown;
}

interface Accepted {
  readonly ok: true;
  readonly complete: boolean;
  readonly continuation: unknown;
  readonly events: number;
}
interface Refused {
  readonly ok: false;
  readonly code: string;
  readonly path: string;
  readonly check: string | undefined;
}
/** A driver answered the call from a stored outcome. */
interface Stored {
  readonly ok: "stored";
}

/**
 * A capability step's verdict: the `via` and `capability` fields of its command record, and either the
 * attribution its command runs under or the refusal recorded as its outcome.
 */
type Through =
  | { readonly ok: true; readonly record: Rec; readonly attribution: AttributionEnvelope }
  | { readonly ok: false; readonly record: Rec; readonly outcome: Rec };

/** An ordered record list: an array in full recording, a `DigestStream` in summarised recording. */
type Sink = Rec[] | DigestStream;

/** The expected partition revision every scenario command carries. */
function expectedRevisionOf(command: WorldCommand): bigint {
  const revision = command.expected.partitionRevision;
  if (revision === undefined)
    throw new TypeError("a scenario command always carries its expected revision");
  return revision;
}

const ACTOR_KEYS = ["objectId", "fromObjectId"] as const;

/** Payload keys naming the object an event is about, in priority order (`childId` for births). */
const SUBJECT_KEYS = ["objectId", "childId", "fromObjectId"] as const;

/** The object an event is about: its first subject key, else `payload.object.objectId`. */
function subjectOf(event: { readonly payload: unknown }): string | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  for (const key of SUBJECT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nested = payload.object;
  return isRecord(nested) && typeof nested.objectId === "string" ? nested.objectId : null;
}

const omitCall = (entry: Rec): Rec => {
  const { call: _call, ...rest } = entry;
  return rest;
};
const TARGET_KEYS = ["containerId", "toContainerId", "toObjectId"] as const;

const sortedCounts = (counts: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries([...counts].sort(([left], [right]) => compareText(left, right)));

function describeRandom(state: NamedRandomState): readonly RandomStreamRecord[] {
  return Object.entries(state)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, stream]) => {
      return plain({
        name,
        algorithm: stream.algorithm.algorithm,
        algorithmVersion: stream.algorithm.version,
        draws: stream.draws,
        state: [...stream.state],
      });
    });
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (isRecord(value)) for (const key of Object.keys(value)) collectStrings(value[key], into);
}

/** Reads the kernel's schedule queue; an entry that is not a well-formed schedule item is an internal defect. */
function scheduleItems(schedules: unknown): readonly Item[] {
  if (!Array.isArray(schedules)) throw new TypeError("the schedule queue is not a list");
  return schedules.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.dueAt !== "bigint"
    )
      throw new TypeError("a schedule item is malformed");
    return { id: item.id, kind: item.kind, dueAt: item.dueAt, payload: item.payload, raw: item };
  });
}

/** Executes one step plan against the post-seed world and returns its canonical run record. */
export async function executePlan(
  ctx: PlanContext,
  name: string,
  planPath: string,
  steps: readonly ScenarioStep[],
): Promise<ScenarioRun> {
  const { scenario, pack, seed, behaviorPack, sha256 } = ctx;
  const driver = ctx.driver?.(name);
  const policy = pack.behaviorPolicy;
  const behavior = policy === null || behaviorPack === null ? null : { policy, behaviorPack };
  if (behavior === null && steps.length > 0)
    return refuse("MISSING_BEHAVIOR_POLICY", "manifest.policies", "steps need a behaviour policy");
  const registry = worldRegistryIdentity();
  const catalog = registry.commands.map(([type, version]) => ({ type, version }));
  const reducers = new Set(registry.reducers.map(([type, version]) => `${type}@${version}`));
  const scriptedRefs = new Set<string>(
    (seed.state.scriptedCognition?.entries ?? []).map((entry) => entry.ref),
  );
  const rules = pack.rules;

  const idFor = (stepKey: string): string =>
    createDeterministicIdSource({
      commandId: decodeOpaqueId(`${pack.id}@${pack.version}`, "CommandId"),
      eventIndex: 0,
      randomStream: `scenario:${scenario.name}:${stepKey}`,
    }).next("CommandId");
  const runId = idFor("run");
  const attribution = decodeAttributionEnvelope({
    effectiveActorId: "simulator-scenario",
    causalRootActionId: runId,
    authorityDecisionId: "simulator-scenario-authority",
  });

  let state: WorldState = seed.state;
  let schedules: unknown = seed.schedules;
  let random: NamedRandomState = restoreNamedRandomState(seed.randomState);
  const randomBefore = describeRandom(random);
  const scheduleInitial = scheduleItems(schedules).map((item) =>
    plain({ scheduleId: item.id, kind: item.kind, dueAt: item.dueAt, payload: item.payload }),
  );
  let cooldowns: readonly unknown[] = [];
  let heldGroup: unknown;
  let callCount = 0;

  const summarised = scenario.recording === "summarised";
  const streams: DigestStream[] = [];
  const stream = (): DigestStream => {
    const created = new DigestStream(sha256);
    streams.push(created);
    return created;
  };
  const sink = (): Sink => {
    if (summarised) return stream();
    const list: Rec[] = [];
    return list;
  };
  const finish = async (list: Sink): Promise<RecordList> =>
    list instanceof DigestStream ? list.finish() : list;

  const commandRecords: Rec[] = [];
  const eventRecords = sink();
  const rawEvents: WorldEvent[] = [];
  const mutationRecords = sink();
  const scheduledInputs = sink();
  const decisionRecords = sink();
  const ruleEvaluations = sink();
  const ruleIntents = sink();
  const ruleTrace = sink();
  const perceptionRecords = sink();

  // Summarised recording only: what the §9.3 long-run invariants and declared equivalences need,
  // in memory that does not grow with the horizon.
  const subjects = new SubjectTable();
  let replayState: WorldState | undefined = seed.state;
  let replayFailure: string | null = null;
  let schedulePeak = scheduleItems(schedules).length;
  let scheduleDuplicateIds = 0;
  let undispatchedDecisions = 0;
  const views = scenario.equivalences
    .filter((declared) => summarised && (declared.left === name || declared.right === name))
    .map((declared) => ({
      declared,
      events: stream(),
      decisions: stream(),
      intents: stream(),
      trace: stream(),
    }));
  const counted = scenario.assertions.flatMap((assertion) =>
    summarised && assertion.kind === "eventCount" && assertion.run === name
      ? [{ assertion, observed: 0 }]
      : [],
  );
  const eventCounts = new Map<string, number>();
  const usedScripted = new Set<string>();
  const envelopes = new Map<
    string,
    {
      command: WorldCommand;
      type: string;
      version: number;
      payload: Rec;
      through: Through | null;
    }
  >();

  /**
   * A step submitted through a capability binding: the pack decides with `checkCapabilityCommand`. An
   * accepted command is attributed to the actor (`effectiveActorId`), initiated by the scenario; a
   * refused one never reaches the kernel and its refusal is the step's outcome.
   */
  const through = (via: CapabilityVia, type: string, version: number, at: string): Through => {
    const requested = {
      actorId: via.actor,
      id: via.capability.id,
      version: via.capability.version,
    };
    const checked = checkCapabilityCommand(pack, {
      actorId: via.actor,
      capability: via.capability,
      type,
      version,
    });
    if (!checked.ok) {
      const { code } = checked.error;
      const path = checked.error.path === "type" ? `${at}.type` : `${at}.via.${checked.error.path}`;
      return {
        ok: false,
        record: { via: requested, capability: null },
        outcome: plain({ status: "refused", code, path, calls: 0, events: 0 }),
      };
    }
    return {
      ok: true,
      record: { via: requested, capability: { ...checked.value } },
      attribution: decodeAttributionEnvelope({
        effectiveActorId: via.actor,
        initiatorId: attribution.effectiveActorId,
        causalRootActionId: attribution.causalRootActionId,
        authorityDecisionId: attribution.authorityDecisionId,
      }),
    };
  };

  // The type and payload are author-supplied data; the kernel validates them when it executes the command.
  const makeCommand = (
    commandId: string,
    type: string,
    payload: Rec,
    by: AttributionEnvelope = attribution,
  ): WorldCommand =>
    ({
      schemaVersion: 1,
      commandId,
      type,
      target: {
        version: 1,
        tenantId: state.tenantId,
        worldId: state.worldId,
        timelineId: state.timelineId,
        kind: "world",
        id: state.worldId,
      },
      expected: { partitionRevision: state.revision },
      issuedAt: pack.clockPolicy.wallEpoch,
      context: decodeExecutionContextRef({
        version: 1,
        correlationId: runId,
        requestId: commandId,
      }),
      attribution: {
        ...(by.initiatorId === undefined ? {} : { initiatorId: by.initiatorId }),
        effectiveActorId: by.effectiveActorId,
        causalRootActionId: by.causalRootActionId,
      },
      payload,
    }) as unknown as WorldCommand;

  function evaluateTransition(
    call: number,
    before: WorldState,
    after: WorldState,
    events: readonly unknown[],
    complete: boolean,
  ): void {
    if (rules.length === 0) return;
    let continuation: unknown;
    for (let pass = 0; pass < SCENARIO_LIMITS.chunksPerAdvance; pass += 1) {
      const outcome = evaluateRules({
        rules,
        catalog,
        transition: {
          from: before.simulationTime,
          to: after.simulationTime,
          before,
          after,
          events,
        },
        cooldowns,
        depth: 0,
        holdEnd: !complete,
        ...(continuation === undefined ? {} : { continuation }),
        ...(heldGroup === undefined ? {} : { heldGroup }),
      });
      if (!outcome.ok) {
        ruleEvaluations.push(
          plain({
            call,
            pass,
            from: before.simulationTime,
            to: after.simulationTime,
            refusal: { code: outcome.error.code, path: outcome.error.path },
          }),
        );
        return;
      }
      const result = outcome.result;
      ruleEvaluations.push(
        plain({
          call,
          pass,
          from: before.simulationTime,
          to: after.simulationTime,
          complete: result.complete,
          intents: result.intents.length,
          trace: result.trace.length,
        }),
      );
      for (const intent of result.intents) {
        const record = plain({ call, ...intent });
        ruleIntents.push(record);
        for (const view of views) view.intents.push(omitCall(record));
      }
      for (const entry of result.trace) {
        const record = plain({ call, ...entry });
        ruleTrace.push(record);
        for (const view of views) view.trace.push(omitCall(record));
      }
      cooldowns = result.cooldowns;
      if (result.complete) {
        heldGroup = result.heldGroup;
        return;
      }
      continuation = result.continuation;
    }
    throw new Error("rule evaluation did not converge");
  }

  function resolvePerception(
    call: number,
    event: { readonly type: string; readonly eventId: string; readonly payload: unknown },
    after: WorldState,
  ): void {
    const perception = scenario.perception;
    if (perception === null) return;
    const type = event.type;
    if (!isOneOf(PERCEIVABLE_EVENT_TYPES, type)) return;
    const payload = isRecord(event.payload) ? event.payload : {};
    const pick = (keys: readonly string[]): string | null => {
      for (const key of keys) {
        const value = payload[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      const nested = payload.object;
      if (isRecord(nested) && typeof nested.objectId === "string") return nested.objectId;
      return null;
    };
    const actorId = pick(ACTOR_KEYS);
    const targetId = pick(TARGET_KEYS);
    const entities = after.entities;
    const spaceOf = (id: string | null): string | null => {
      const entity =
        id === null ? undefined : entities.find((candidate) => candidate.objectId === id);
      return typeof entity?.spaceId === "string" ? entity.spaceId : null;
    };
    const spaceId = spaceOf(actorId) ?? spaceOf(targetId);
    const base = { call, eventId: event.eventId, type };
    if (spaceId === null || (actorId === null && targetId === null)) {
      perceptionRecords.push(plain({ ...base, status: "not-addressable" }));
      return;
    }
    const regionId = payload.regionId;
    const modality = perception.modalities[type] ?? perception.modality;
    const outcome = resolveAudience(
      {
        version: 1,
        type,
        eventId: event.eventId,
        modality,
        sourceRevision: after.revision,
        spaceId,
        actorId,
        targetId,
        regionIds: typeof regionId === "string" ? [regionId] : [],
      },
      after,
      clonePlain(perception.policy),
    );
    if (!outcome.ok) {
      perceptionRecords.push(
        plain({
          ...base,
          status: "refused",
          modality,
          refusal: { code: outcome.error.code, path: outcome.error.path },
        }),
      );
      return;
    }
    const value = outcome.value;
    perceptionRecords.push(
      plain({
        ...base,
        status: "resolved",
        modality,
        spaceId,
        actorId,
        targetId,
        resolverVersion: value.resolverVersion,
        sourceRevision: value.sourceRevision,
        reasons: value.reasons.map((reason) => ({ ...reason, sources: [...reason.sources] })),
        perceptions: value.perceptions.map((entry) => ({ ...entry })),
        clientInterestHash: value.clientInterest.hash,
      }),
    );
  }

  async function applyCall(
    command: WorldCommand,
    continuation: unknown,
    by: AttributionEnvelope,
  ): Promise<Accepted | Refused | Stored> {
    // Unreachable: a plan without a behaviour policy has no steps.
    if (behavior === null)
      return refuse(
        "MISSING_BEHAVIOR_POLICY",
        "manifest.policies",
        "steps need a behaviour policy",
      );
    // The kernel validates every member of its input; the runner only assembles it.
    const input = {
      partition: {
        schemaVersion: 1,
        partitionId: state.partitionId,
        revision: state.revision,
        state,
      },
      input: { kind: "command", command },
      simulationTime: state.simulationTime,
      attribution: by,
      policies: {
        schemaVersion: 1,
        policyVersions: { routine: behavior.policy.version },
        policy: behavior.policy,
      },
      pack: {
        schemaVersion: 1,
        packId: pack.id,
        packVersion: pack.version,
        pack: behavior.behaviorPack,
      },
      randomState: random,
      ids: createDeterministicIdSource({
        commandId: command.commandId,
        eventIndex: 0,
        randomStream: "scenario",
      }),
      schedules,
      ...(continuation === undefined ? {} : { continuation }),
    } as unknown as WorldKernelInput;
    const outcome = driver === undefined ? executeWorldKernel(input) : await driver.call(input);
    if (outcome === undefined) return { ok: "stored" };
    if (!outcome.ok)
      return {
        ok: false,
        code: String(outcome.error.code),
        path: String(outcome.error.path),
        check: outcome.error.check === undefined ? undefined : String(outcome.error.check),
      };
    const result = outcome.result;
    // Drivers may aggregate catch-up and client commands; native calls validate each command.
    const causeFailure =
      driver === undefined
        ? undefined
        : checkWorldTransitionInvariants(state, result.state, result.events, behavior.policy);
    if (causeFailure !== undefined)
      refuse("RESOURCE_CAUSE_INVARIANT", String(causeFailure.path), String(causeFailure.check));
    const call = callCount;
    callCount += 1;
    const before = state;
    const beforeItems = scheduleItems(schedules);
    state = result.state;
    schedules = result.schedules;
    random = result.updatedRandomState;

    for (const event of result.events) {
      if (!summarised) rawEvents.push(event);
      const type = event.type;
      eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
      const version = event.schemaVersion;
      const record: Rec = plain({
        call,
        ...event,
        reducer: reducers.has(`${type}@${version}`) ? { type, version } : null,
      });
      eventRecords.push(record);
      if (!summarised) continue;
      const subject = subjectOf(event);
      if (subject !== null) subjects.add(subject, type, event.simulationTime);
      for (const entry of counted) if (eventMatches(entry.assertion, record)) entry.observed += 1;
      for (const view of views) {
        const { eventTypes, ignoreEventTypes } = view.declared;
        if (
          !materialEvent(record) ||
          ignoreEventTypes.includes(type) ||
          (eventTypes.length > 0 && !eventTypes.includes(type))
        )
          continue;
        view.events.push({ type, simulationTime: record.simulationTime, payload: record.payload });
      }
    }
    if (summarised && replayState !== undefined) {
      try {
        replayState = replayWorldEvents(replayState, result.events);
      } catch (error) {
        if (!(error instanceof DomainValidationError)) throw error;
        replayState = undefined;
        replayFailure = "replay-threw";
      }
    }
    for (const mutation of result.scheduleMutations)
      mutationRecords.push(plain({ call, ...mutation }));
    const currentItems = scheduleItems(schedules);
    const afterItems = new Map(currentItems.map((item) => [item.id, item.dueAt]));
    if (summarised) {
      schedulePeak = Math.max(schedulePeak, currentItems.length);
      scheduleDuplicateIds += currentItems.length - afterItems.size;
    }
    for (const item of beforeItems) {
      if (afterItems.get(item.id) === item.dueAt) continue;
      let dispatch: Rec | null = null;
      if (item.kind === "world.decision") {
        try {
          const dispatched = dispatchWorldDecision(
            item.raw as ScheduledItem<WorldScheduledPayload>,
          );
          dispatch = {
            commandId: dispatched.commandId,
            type: dispatched.type,
            schemaVersion: dispatched.schemaVersion,
          };
        } catch (error) {
          // Only the kernel's "cannot be dispatched" RangeError is an undispatchable decision.
          if (!(error instanceof RangeError)) throw error;
          dispatch = null;
        }
        if (dispatch === null && !afterItems.has(item.id)) undispatchedDecisions += 1;
      }
      scheduledInputs.push(
        plain({
          call,
          scheduleId: item.id,
          kind: item.kind,
          dueAt: item.dueAt,
          payload: item.payload,
          disposition: afterItems.has(item.id) ? "rescheduled" : "consumed",
          dispatch,
        }),
      );
    }
    for (const draft of result.decisionDrafts) {
      const strings = new Set<string>();
      collectStrings(draft.decision, strings);
      const refs = [...strings].filter((text) => scriptedRefs.has(text)).sort(compareText);
      for (const ref of refs) usedScripted.add(ref);
      const record = plain({
        call,
        kind: draft.kind,
        decision: draft.decision,
        randomDraws: draft.randomDraws ?? [],
        scriptedRefs: refs,
      });
      decisionRecords.push(record);
      for (const view of views)
        view.decisions.push({ kind: record.kind, decision: record.decision });
    }
    evaluateTransition(call, before, state, result.events, result.complete);
    for (const event of result.events) resolvePerception(call, event, state);
    return {
      ok: true,
      complete: result.complete,
      continuation: result.continuation,
      events: result.events.length,
    };
  }

  /** Chains kernel calls through continuations until the command completes or is refused. */
  async function runChain(
    command: WorldCommand,
    at: string,
    by: AttributionEnvelope = attribution,
  ): Promise<Rec> {
    let continuation: unknown;
    let calls = 0;
    let events = 0;
    for (let attempt = 0; attempt < SCENARIO_LIMITS.chunksPerAdvance; attempt += 1) {
      const step = await applyCall(command, continuation, by);
      for (const open of streams) await open.drain();
      if (step.ok === "stored") return { status: "stored", calls, events };
      if (!step.ok)
        return plain({
          status: "refused",
          code: step.code,
          path: step.path,
          check: step.check,
          calls,
          events,
        });
      calls += 1;
      events += step.events;
      if (step.complete) return { status: "accepted", calls, events };
      if (step.continuation === undefined)
        throw new Error("an incomplete kernel call omitted its continuation");
      continuation = step.continuation;
    }
    return refuse(
      "SCENARIO_BOUND_EXCEEDED",
      at,
      `a step needs more than ${SCENARIO_LIMITS.chunksPerAdvance} kernel chunks; raise maxInputs or maxEvents`,
    );
  }

  const entry = (
    step: ScenarioStep,
    role: string,
    chunk: number,
    command: WorldCommand | null,
    type: string | null,
    version: number | null,
    payload: Rec | null,
    expectedRevision: bigint | null,
    outcome: Rec,
    extra: Rec = {},
  ): void => {
    commandRecords.push(
      plain({
        step: step.key,
        role,
        chunk,
        commandId: command === null ? null : command.commandId,
        type,
        version,
        payload,
        expectedRevision,
        outcome,
        ...extra,
      }),
    );
  };

  for (const [index, step] of steps.entries()) {
    const at = `${planPath}[${index}]`;
    if (step.kind === "command") {
      const verdict =
        step.via === undefined ? null : through(step.via, step.type, step.version, at);
      const command = makeCommand(
        idFor(step.key),
        step.type,
        clonePlain(step.payload),
        verdict?.ok === true ? verdict.attribution : attribution,
      );
      envelopes.set(step.key, {
        command,
        type: step.type,
        version: step.version,
        payload: step.payload,
        through: verdict,
      });
      const expected = state.revision;
      entry(
        step,
        "command",
        0,
        command,
        step.type,
        step.version,
        step.payload,
        expected,
        verdict === null
          ? await runChain(command, at)
          : verdict.ok
            ? await runChain(command, at, verdict.attribution)
            : verdict.outcome,
        verdict?.record,
      );
    } else if (step.kind === "retry") {
      const original = envelopes.get(step.of);
      if (original === undefined)
        return refuse("INVALID_STEP", `${at}.of`, "retry names no earlier command step");
      const expected = expectedRevisionOf(original.command);
      const verdict = original.through;
      entry(
        step,
        "retry",
        0,
        original.command,
        original.type,
        original.version,
        original.payload,
        expected,
        verdict === null
          ? await runChain(original.command, at)
          : verdict.ok
            ? await runChain(original.command, at, verdict.attribution)
            : verdict.outcome,
        { of: step.of, ...verdict?.record },
      );
    } else if (step.kind === "advance") {
      if (step.to < state.simulationTime)
        refuse(
          "INVALID_STEP",
          `${at}.to`,
          "advance target lies before the current simulation time",
        );
      const targets: bigint[] = [];
      if (step.mode === "fast-forward") targets.push(step.to);
      else {
        const stepMs = step.stepMs;
        if (stepMs === null) throw new TypeError("a decoded live advance always has stepMs");
        for (let time: bigint = state.simulationTime; time < step.to; ) {
          time = time + stepMs < step.to ? time + stepMs : step.to;
          targets.push(time);
          if (targets.length > SCENARIO_LIMITS.chunksPerAdvance)
            refuse(
              "SCENARIO_BOUND_EXCEEDED",
              `${at}.stepMs`,
              `a live advance is at most ${SCENARIO_LIMITS.chunksPerAdvance} chunks`,
            );
        }
        if (targets.length === 0) targets.push(step.to);
      }
      for (const [chunk, target] of targets.entries()) {
        const payload: Rec = {
          schemaVersion: 1,
          targetTime: target,
          maxInputs: step.maxInputs,
          maxEvents: step.maxEvents,
        };
        const command = makeCommand(
          idFor(`${step.key}:${chunk}`),
          "world.advance",
          clonePlain(payload),
        );
        const outcome = await runChain(command, `${at}.maxInputs`);
        entry(
          step,
          "advance",
          chunk,
          command,
          "world.advance",
          1,
          payload,
          expectedRevisionOf(command),
          outcome,
          { mode: step.mode },
        );
        if (outcome.status === "refused") break;
      }
    } else {
      const hashOf = async (value: unknown): Promise<string> => sha256(canonicalBytes(value));
      const hashBefore = await hashOf(state);
      const randomBefore2 = serializeNamedRandomState(random);
      const snapshot = canonicalBytes({
        kind: "clockgrove.scenario-restart",
        version: 1,
        state,
        schedules,
        randomState: randomBefore2,
        cooldowns,
        heldGroup: heldGroup ?? null,
      });
      const decoded = decodeCanonicalBytes(snapshot);
      if (!decoded.ok)
        throw new Error("the restart snapshot did not round-trip through canonical bytes");
      const restored = clonePlain(decoded.value);
      if (
        !isRecord(restored) ||
        !isRecord(restored.state) ||
        typeof restored.randomState !== "string" ||
        !Array.isArray(restored.cooldowns)
      )
        throw new Error("the restart snapshot lost a member");
      // The snapshot is the canonical encoding of the state held just above; `stateIdentical` below records
      // whether the round trip reproduced it.
      state = restored.state as unknown as WorldState;
      schedules = restored.schedules;
      random = restoreNamedRandomState(restored.randomState);
      cooldowns = restored.cooldowns;
      heldGroup = restored.heldGroup === null ? undefined : restored.heldGroup;
      await driver?.restart?.();
      const hashAfter = await hashOf(state);
      entry(step, "restart", 0, null, null, null, null, null, {
        status: "restored",
        byteLength: snapshot.length,
        bytesHash: await sha256(snapshot),
        stateHashBefore: hashBefore,
        stateHashAfter: hashAfter,
        stateIdentical: hashBefore === hashAfter,
        randomStateIdentical: randomBefore2 === serializeNamedRandomState(random),
      });
    }
  }

  const finalStateHash = await sha256(canonicalBytes(state));
  let replayed: WorldState | undefined = replayState;
  if (!summarised) {
    try {
      replayed = replayWorldEvents(seed.state, rawEvents);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      replayed = undefined;
      replayFailure = "replay-threw";
    }
  }
  const replayedHash = replayed === undefined ? null : await sha256(canonicalBytes(replayed));

  const summary = summarised
    ? {
        subjects: subjects.toRecords(),
        schedulePeak,
        scheduleDuplicateIds,
        undispatchedDecisions,
        equivalenceViews: await Promise.all(
          views.map(async (view) => ({
            id: view.declared.id,
            events: await view.events.finish(),
            decisions: await view.decisions.finish(),
            rules: {
              intents: await view.intents.finish(),
              trace: await view.trace.finish(),
              cooldowns,
            },
          })),
        ),
        eventCountAssertions: counted.map((entry) => ({
          id: entry.assertion.id,
          observed: entry.observed,
        })),
      }
    : null;

  const finalItems = scheduleItems(schedules);
  const nextDueAt = finalItems.reduce<bigint | null>(
    (best, item) => (best === null || item.dueAt < best ? item.dueAt : best),
    null,
  );

  return plain({
    name,
    randomState: { before: randomBefore, after: describeRandom(random) },
    commands: commandRecords,
    scheduledInputs: await finish(scheduledInputs),
    scheduleMutations: await finish(mutationRecords),
    schedule: {
      initial: scheduleInitial,
      remaining: finalItems.map((item) => ({
        scheduleId: item.id,
        kind: item.kind,
        dueAt: item.dueAt,
        payload: item.payload,
      })),
      nextDueAt,
    },
    events: await finish(eventRecords),
    decisions: await finish(decisionRecords),
    scriptedInputsUsed: [...usedScripted].sort(compareText),
    rules: {
      evaluated: rules.length > 0,
      rules: rules.map((rule) => ({ id: rule.id, version: rule.version })),
      evaluations: await finish(ruleEvaluations),
      intents: await finish(ruleIntents),
      trace: await finish(ruleTrace),
      cooldowns,
      disposition: "recorded-not-executed",
    },
    perception: await finish(perceptionRecords),
    eventCounts: sortedCounts(eventCounts),
    startStateHash: seed.finalStateHash,
    finalState: state,
    finalStateHash,
    replay: {
      from: "post-seed-state",
      eventCount: summarised
        ? [...eventCounts.values()].reduce((sum, count) => sum + count, 0)
        : rawEvents.length,
      replayedStateHash: replayedHash,
      finalStateHash,
      failure: replayFailure,
      matches: replayedHash !== null && replayedHash === finalStateHash,
    },
    ...(summary === null ? {} : { recording: "summarised" as const, summary }),
  });
}
