import {
  type CommandId,
  decodeAttributionEnvelope,
  decodeExecutionContextRef,
} from "@clockgrove/contracts";
import {
  decodeWorldScenario,
  type NamedRandomState,
  type WorldScenario,
  type WorldState,
} from "@clockgrove/domain";
import garden from "../../../examples/world-packs/garden-rain-shelter.json" with { type: "json" };
import raccoon from "../../../examples/world-packs/raccoon-rain-shelter.json" with { type: "json" };
import { canonicalBytes, canonicalSerialize } from "../src/canonical.js";
import { createDeterministicIdSource } from "../src/deterministic-id.js";
import { simulationTimeMs } from "../src/time.js";
import {
  createWorldSchedules,
  executeWorldKernel,
  type WorldCommand,
  type WorldKernelInput,
} from "../src/world.js";

import { componentFixtureNames, composeComponentFixture } from "./component-fixtures/index.js";

import { packEvidence } from "./pack-fixtures/evidence.js";
import { randomRuntimeEvidence } from "./random-streams.scenario.js";

export const scenarios = { raccoon, garden };
export function fractionalScenario() {
  const sample = structuredClone(raccoon);
  sample.pack.policy.decisionIntervalMs = "7";
  const first = sample.initialState.entities.find((entity) => entity.needs !== undefined);
  if (first === undefined) throw new Error("sample actor required");
  sample.initialState.entities.push({ ...structuredClone(first), objectId: "second-resident" });
  return sample;
}
export async function stateHash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", canonicalBytes(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scenarioInput(
  sample: unknown,
  rain = 10000,
  _maxInputs = 32,
  randomState: NamedRandomState = {},
  _maxEvents = 32,
  resolved?: WorldScenario,
): Promise<WorldKernelInput> {
  const decoded = resolved ?? decodeWorldScenario(sample, await stateHash(sample));
  const state = decoded.initialState;
  const pack =
    resolved === undefined
      ? decoded.pack
      : { ...decoded.pack, contentHash: await stateHash(decoded) };
  const attribution = decodeAttributionEnvelope({
    effectiveActorId: "local-scenario",
    causalRootActionId: "scenario-root",
    authorityDecisionId: "local-scenario-authority",
  });
  const command = {
    schemaVersion: 1,
    commandId: `${pack.packId}:weather` as CommandId,
    type: "world.weather.set",
    target: {
      version: 1,
      tenantId: state.tenantId,
      worldId: state.worldId,
      timelineId: state.timelineId,
      kind: "world",
      id: state.worldId,
    },
    expected: { partitionRevision: state.revision },
    issuedAt: "2026-10-01T00:00:00.000Z",
    context: decodeExecutionContextRef({
      version: 1,
      correlationId: "local-scenario",
      requestId: "local-scenario",
    }),
    attribution: {
      effectiveActorId: attribution.effectiveActorId,
      causalRootActionId: attribution.causalRootActionId,
    },
    payload: {
      schemaVersion: 2,
      rainIntensity: rain,
    },
  } as WorldCommand;
  const ids = createDeterministicIdSource({
    commandId: command.commandId,
    eventIndex: 0,
    randomStream: "routine",
  });
  return {
    partition: {
      schemaVersion: 1,
      partitionId: state.partitionId,
      revision: state.revision,
      state,
    },
    input: { kind: "command", command },
    simulationTime: state.simulationTime,
    attribution,
    policies: {
      schemaVersion: 1,
      policyVersions: { routine: pack.policy.version },
      policy: pack.policy,
    },
    pack: { schemaVersion: 1, packId: pack.packId, packVersion: pack.packVersion, pack },
    randomState,
    ids,
    schedules: createWorldSchedules(state, pack, ids),
  };
}

/** Actual decoder, command handlers, schedules and reducers in both runtimes. */
export async function runScenario(
  sample: unknown,
  rain = 10000,
  maxInputs = 32,
  randomState: NamedRandomState = {},
  maxEvents = 32,
  targetTime = 180000n,
  continuationStages?: string[],
  resolved?: WorldScenario,
) {
  let input = await scenarioInput(sample, rain, maxInputs, randomState, maxEvents, resolved);
  const initialState = input.partition.state;
  const weather = executeWorldKernel(input, { mode: "test" });
  if (!weather.ok) throw new Error(weather.error.code);
  const events = [...weather.result.events];
  const decisions = [...weather.result.decisionDrafts];
  const scheduleMutations = [...weather.result.scheduleMutations];
  const command = input.input.kind === "command" ? input.input.command : undefined;
  if (command === undefined) throw new Error("scenario command required");
  const advance = {
    ...command,
    commandId: `${input.pack.packId}:advance` as CommandId,
    type: "world.advance",
    expected: { partitionRevision: weather.result.state.revision },
    payload: { schemaVersion: 1, targetTime: simulationTimeMs(targetTime), maxInputs, maxEvents },
  } as WorldCommand;
  input = {
    ...input,
    partition: {
      ...input.partition,
      revision: weather.result.state.revision,
      state: weather.result.state,
    },
    simulationTime: weather.result.state.simulationTime,
    input: { kind: "command", command: advance },
    schedules: weather.result.schedules,
    ids: createDeterministicIdSource({
      commandId: advance.commandId,
      eventIndex: 0,
      randomStream: "routine",
    }),
  };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const execution = executeWorldKernel(input, { mode: "test" });
    if (!execution.ok) throw new Error(execution.error.code);
    const result = execution.result;
    if (result.events.length > maxEvents || result.decisionDrafts.length > maxInputs)
      throw new Error("kernel exceeded its input/event budget");
    if (canonicalSerialize(result.projectionDelta.delta) !== canonicalSerialize(result.state))
      throw new Error("projection diverged from reducer state");
    events.push(...result.events);
    decisions.push(...result.decisionDrafts);
    scheduleMutations.push(...result.scheduleMutations);
    if (result.complete)
      return {
        initialState,
        state: result.state,
        events,
        decisions,
        schedules: result.schedules,
        scheduleMutations,
        randomState: result.updatedRandomState,
        stateHash: await stateHash(result.state),
        packHash: input.pack.pack.contentHash,
      };
    if (result.continuation === undefined)
      throw new Error("incomplete execution omitted continuation");
    continuationStages?.push(result.continuation.stage);
    input = {
      ...input,
      partition: { ...input.partition, revision: result.state.revision, state: result.state },
      simulationTime: result.state.simulationTime,
      schedules: result.schedules,
      randomState: result.updatedRandomState,
      continuation: result.continuation,
    };
  }
  throw new Error("bounded scenario continuation exceeded 16 calls");
}

export function actor(state: WorldState) {
  return state.entities.find((entity) => entity.needs !== undefined);
}
export async function wetnessCarryEvidence() {
  let input = await scenarioInput(raccoon);
  const weather = executeWorldKernel(input, { mode: "test" });
  if (!weather.ok || input.input.kind !== "command") throw new Error("weather setup failed");
  let previous = weather.result;
  const origin = input.input.command;
  for (let time = 1n; time <= 50n; time += 1n) {
    const command: WorldCommand = {
      ...origin,
      commandId: `wetness-carry:${time}` as CommandId,
      type: "world.advance",
      expected: { partitionRevision: previous.state.revision },
      payload: {
        schemaVersion: 1,
        targetTime: simulationTimeMs(time),
        maxInputs: 32,
        maxEvents: 32,
      },
    };
    input = {
      ...input,
      partition: { ...input.partition, revision: previous.state.revision, state: previous.state },
      simulationTime: previous.state.simulationTime,
      schedules: previous.schedules,
      input: { kind: "command", command },
      ids: createDeterministicIdSource({
        commandId: command.commandId,
        eventIndex: 0,
        randomStream: "routine",
      }),
    };
    const outcome = executeWorldKernel(input, { mode: "test" });
    if (!outcome.ok || !outcome.result.complete)
      throw new Error("bounded one-millisecond advance failed");
    previous = outcome.result;
  }
  return {
    stepped: actor(previous.state)?.needs,
    aggregate: actor((await runScenario(raccoon, 10000, 32, {}, 32, 50n)).state)?.needs,
  };
}
export async function runComponentScenario(name: "raccoon" | "garden", override = false) {
  const fixture = composeComponentFixture(name, override);
  const sourceBefore = fixture.sourceCanonicalBefore;
  const result = await runScenario(
    undefined,
    10000,
    32,
    {},
    32,
    180000n,
    undefined,
    fixture.scenario,
  );
  if (canonicalSerialize(fixture.sources) !== sourceBefore)
    throw new Error("component source mutation");
  return {
    name,
    override,
    resolvedCanonicalObjects: fixture.canonicalObjects,
    sourceCanonicalBefore: sourceBefore,
    sourceCanonicalAfter: canonicalSerialize(fixture.sources),
    result,
  };
}
export async function runtimeEvidence() {
  const components = await Promise.all(
    componentFixtureNames.flatMap((name) => [
      runComponentScenario(name),
      runComponentScenario(name, true),
    ]),
  );
  const historical = await Promise.all([
    ...Object.values(scenarios).map((sample) => runScenario(sample)),
    runScenario(fractionalScenario(), 10000, 1, {}, 3, 20n),
    wetnessCarryEvidence(),
    randomRuntimeEvidence(),
  ]);
  return {
    schemaVersion: 1,
    composition:
      "production initial catalog/registry, pinned definition resolver, validated WorldState adapter",
    components: components.map(
      ({
        name,
        override,
        resolvedCanonicalObjects,
        sourceCanonicalBefore,
        sourceCanonicalAfter,
        result,
      }) => ({
        name,
        override,
        resolvedCanonicalObjects,
        sourceCanonicalBefore,
        sourceCanonicalAfter,
        semanticEvents: canonicalSerialize(result.events),
        schedules: canonicalSerialize(result.schedules),
        scheduleMutations: canonicalSerialize(result.scheduleMutations),
        decisions: canonicalSerialize(result.decisions),
        finalState: canonicalSerialize(result.state),
        stateHash: result.stateHash,
        initialState: canonicalSerialize(result.initialState),
      }),
    ),
    historical: canonicalSerialize(historical),
    packs: await packEvidence(),
  };
}
