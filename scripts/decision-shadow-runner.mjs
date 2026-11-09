import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decisionShadowReport, runDecisionShadow } from "../packages/application/src/index.ts";
import { executeWorldKernel, scoreUtility } from "../packages/kernel/src/index.ts";
import {
  AiSdkDecisionAdapter,
  createModelGateway,
  decisionAlias,
  environmentCredentials,
  InMemoryModelBudget,
} from "../packages/model-gateway/src/index.ts";
import { readPackDirectory, sdkSource } from "../packages/simulator/cli/pack-source.ts";
import {
  createSimulatorPackPorts,
  runScenario,
  seedGenesis,
} from "../packages/simulator/src/index.ts";
import { buildWorldPack, validateWorldPack } from "../packages/world-pack-sdk/src/index.ts";

const sha256 = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const ports = { sha256 };

export async function simulate(directory, spanMs) {
  const source = sdkSource(await readPackDirectory(directory));
  const packPorts = createSimulatorPackPorts(ports);
  const built = await buildWorldPack(source, packPorts);
  if (!built.ok) throw new Error(`Pack refused: ${built.error.code}`);
  const validated = await validateWorldPack(source, packPorts);
  if (!validated.ok) throw new Error(`Pack refused: ${validated.error.code}`);
  const seeded = await seedGenesis({ artifact: built.value.artifact, source }, ports);
  if (!seeded.ok) throw new Error(`Genesis refused: ${seeded.error.code}`);
  const start = seeded.value.bundle.state.simulationTime;
  const subjects = [];
  const result = await runScenario(
    {
      artifact: built.value.artifact,
      source,
      scenario: {
        kind: "clockgrove.scenario",
        schemaVersion: 1,
        name: "decision-shadow",
        pack: { id: validated.value.id, version: validated.value.version },
        // Full recording preserves the independent event replay proof for this finite operator run.
        steps: [
          {
            kind: "advance",
            key: "shadow-span",
            to: start + spanMs,
            mode: "fast-forward",
            maxInputs: 1024,
            maxEvents: 4096,
          },
        ],
      },
    },
    {
      ...ports,
      driver: () => ({
        call: async (input) => {
          const outcome = executeWorldKernel(input);
          if (outcome.ok)
            for (const draft of outcome.result.decisionDrafts)
              if (draft.kind === "routine") {
                const entity = input.partition.state.entities.find(
                  (entry) => entry.objectId === draft.decision.objectId,
                );
                subjects.push({
                  fixtureState: input.partition.state,
                  fixturePolicy: input.policies.policy,
                  commandId: input.input.command.commandId,
                  trace: draft.decision,
                  ...(entity?.archetypeId === undefined ? {} : { archetype: entity.archetypeId }),
                });
              }
          return outcome;
        },
      }),
    },
  );
  if (!result.ok) throw new Error(`Simulation refused: ${result.error.code}`);
  const run = result.value.bundle.runs[0];
  if (run.commands.some((command) => command.outcome.status === "refused"))
    throw new Error("Simulation command refused");
  if (!run.replay.matches) throw new Error("Simulation replay diverged");
  return { subjects, pack: validated.value, run, artifact: built.value.artifact };
}

function declarations(simulation, alias, margin, maxCalls, spend) {
  const utility = simulation.pack.behaviorPolicy?.utility;
  if (utility === undefined) throw new Error("World needs a utility policy");
  const fallback = {
    id: "operator.shadow",
    trigger: { kind: "score-margin", maxMargin: margin },
    candidates: "kernel-valid",
    signatureScope: "actor",
    marginBuckets: { noneMax: 0n, smallMax: margin > 0n ? margin : 1n },
    features: [
      ...new Set(
        simulation.subjects.flatMap(({ trace }) =>
          trace.candidates.flatMap((candidate) => Object.keys(candidate.features)),
        ),
      ),
    ].sort(),
    confidenceThreshold: 0,
    fallback: "utility-top-pick",
  };
  return {
    ambiguity: {
      schemaVersion: 1,
      conditions: [
        { kind: "score-margin", maxMargin: margin },
        ...(utility.ambiguity?.conditions.filter(
          (condition) => condition.kind !== "score-margin",
        ) ?? []),
      ],
    },
    decisionPoints: {
      schemaVersion: 1,
      points: (utility.decisionPoints?.points ?? [fallback]).map((point) => ({
        ...point,
        modelAlias: alias.alias,
        budget: {
          maxCalls: Math.min(point.budget?.maxCalls ?? maxCalls, maxCalls),
          maxMicrousd: Math.min(point.budget?.maxMicrousd ?? spend, spend),
        },
      })),
    },
  };
}

/** Labelled native fixture state variations, checked against a fixed close-call margin. */
export function referenceSituations(subjects) {
  const subject = subjects.find(({ trace }) =>
    trace.candidates.some(
      (candidate) =>
        candidate.action.kind === "seek-shelter" &&
        candidate.features.travelMs > 0n &&
        candidate.excludedReason !== "unreachable",
    ),
  );
  if (!subject) throw new Error("Reference fixture needs a reachable shelter away from an actor");
  const candidate = subject.trace.candidates.find(
    (entry) =>
      entry.action.kind === "seek-shelter" &&
      entry.features.travelMs > 0n &&
      entry.excludedReason !== "unreachable",
  );
  const targetId = candidate.action.targetObjectId;
  const interval = subject.fixturePolicy.decisionIntervalMs;
  // Decision: calibrate the travel penalty just below rain relief, producing a genuine close call
  // through the native scorer rather than inventing scores. Dry and weak-shelter cases test judgement
  // on either side of that boundary. 8000 stays below the kernel's 9000 wetness reflex threshold.
  const travelWeight = Number(
    (((17000n * 9000n) / 10000n) * interval) / (candidate.features.travelMs * 10000n),
  );
  // Decision: a reference-only range keeps the fixture shelter perceived in all three cases.
  const policy = {
    ...subject.fixturePolicy,
    shelterWeight: 1,
    utility: { ...subject.fixturePolicy.utility, perceptionRange: 1000000000n, travelWeight },
  };
  return [
    {
      id: "heavy-rain",
      expectedKind: "seek-shelter",
      rain: 9000,
      wetness: 8000,
      protection: 9000,
      reason:
        "When wet in heavy rain, the nearby protective shelter provides relief worth its travel.",
    },
    {
      id: "dry-weather",
      expectedKind: "stay",
      rain: 0,
      wetness: 0,
      protection: 9000,
      reason: "When dry with no rain or urgent need, stay rather than travel for rain protection.",
    },
    {
      id: "weak-distant-shelter",
      expectedKind: "stay",
      rain: 9000,
      wetness: 8000,
      protection: 1,
      reason: "Negligible rain protection does not justify the same trip, so stay.",
    },
  ].map((entry, index) => {
    const entities = subject.fixtureState.entities
      .filter(
        (entity) => entity.objectId === subject.trace.objectId || entity.objectId === targetId,
      )
      .map((entity) =>
        entity.objectId === subject.trace.objectId
          ? {
              ...entity,
              movement: undefined,
              needs: { ...entity.needs, hunger: 0, wetness: entry.wetness },
            }
          : { ...entity, shelter: { rainProtection: entry.protection } },
      );
    const state = {
      ...subject.fixtureState,
      entities,
      weather: { rainIntensity: entry.rain },
      wellbeing: {
        ...subject.fixtureState.wellbeing,
        entries: subject.fixtureState.wellbeing.entries.map((item) => ({ ...item, thirst: 0 })),
      },
    };
    const actor = entities.find((entity) => entity.objectId === subject.trace.objectId);
    const casePolicy =
      entry.id === "heavy-rain"
        ? policy
        : { ...policy, utility: { ...policy.utility, travelWeight: 1 } };
    const trace = scoreUtility(
      state,
      actor,
      subject.trace.simulationTime,
      casePolicy,
      `reference-${index}`,
    ).trace;
    const expectedPick = entry.expectedKind === "stay" ? "stay:" : `seek-shelter:${targetId}`;
    const eligible = trace.candidates.filter((choice) => choice.excludedReason === undefined);
    if (eligible.length !== 2) throw new Error("Reference situation lost a valid choice");
    const scores = eligible
      .map((choice) => choice.score)
      .sort((left, right) => (left > right ? -1 : left < right ? 1 : 0));
    if (scores[0] - scores[1] > 2n)
      throw new Error("Reference situation exceeded its declared margin");
    return {
      id: entry.id,
      reason: entry.reason,
      expectedPick,
      actualGap: String(scores[0] - scores[1]),
      margin: "2",
      subject: { commandId: `reference-${index}`, trace, archetype: subject.archetype },
    };
  });
}

export async function runShadowDay(config, adapter) {
  if (!/^\d+$/.test(String(config.spanMs)) || BigInt(config.spanMs) <= 0n)
    throw new Error("span-ms must be a positive integer");
  if (!/^\d+$/.test(String(config.margin))) throw new Error("margin must be a nonnegative integer");
  if (!Number.isSafeInteger(config.spendMicrousd) || config.spendMicrousd < 0)
    throw new Error("spend-microusd must be a nonnegative safe integer");
  if (typeof config.alias?.alias !== "string" || typeof config.alias?.model !== "string")
    throw new Error("alias configuration needs alias and model");
  const alias = decisionAlias(config.alias);
  if (!Number.isSafeInteger(alias.maxCostMicrousd) || alias.maxCostMicrousd <= 0)
    throw new Error("alias maxCostMicrousd must be a positive safe integer");
  const maxCalls = Math.floor(config.spendMicrousd / alias.maxCostMicrousd);
  const simulation = await simulate(config.pack, BigInt(config.spanMs));
  const fixture = await simulate(
    config.referencePack ?? fileURLToPath(new URL("../worlds/fixture/reference", import.meta.url)),
    86400000n,
  );
  const reference = referenceSituations(fixture.subjects);
  let reservations = 0;
  const calls = [];
  const gateway = createModelGateway({
    aliases: [],
    adapters: {},
    decisionAliases: [alias],
    decisionAdapters: {
      "vercel-ai-gateway": adapter ?? new AiSdkDecisionAdapter(environmentCredentials),
    },
    budget: new InMemoryModelBudget(() => config.spendMicrousd),
    accounting: { record: () => undefined, recordDecision: (record) => calls.push(record) },
  });
  const decider = config.modelsOff
    ? undefined
    : {
        pick: async (request) => {
          if (reservations >= maxCalls)
            return {
              status: "failed",
              code: "budget_exceeded",
              model: alias.route.model,
              latencyMs: 0,
              costMicrousd: 0,
            };
          reservations += 1;
          const outcome = await gateway.decide({
            ...request,
            attribution: {
              tenantId: simulation.run.finalState.tenantId,
              worldId: simulation.run.finalState.worldId,
              actorId: "operator-decision-shadow",
            },
            question: {
              type: "choice",
              options: request.options,
              instructions: request.instructions,
            },
          });
          const accounting = {
            model: outcome.record.model,
            latencyMs: outcome.record.latencyMs,
            costMicrousd: outcome.record.costMicrousd,
          };
          return outcome.status === "completed"
            ? {
                status: "completed",
                label: outcome.value.label,
                confidence: outcome.value.confidence,
                ...accounting,
              }
            : { status: "failed", code: outcome.code, ...accounting };
        },
      };
  const declared = declarations(
    simulation,
    alias,
    BigInt(config.margin),
    maxCalls,
    config.spendMicrousd,
  );
  // Judge reference cases first, so a day with many observations cannot starve calibration.
  const labelled = [];
  for (const entry of reference) {
    const records = await runDecisionShadow({
      subjects: [entry.subject],
      decider,
      declarations: {
        ambiguity: {
          schemaVersion: 1,
          conditions: [{ kind: "score-margin", maxMargin: BigInt(entry.margin) }],
        },
        decisionPoints: {
          schemaVersion: 1,
          points: [
            {
              candidates: "kernel-valid",
              signatureScope: "actor",
              marginBuckets: { noneMax: 0n, smallMax: 2n },
              confidenceThreshold: 0,
              budget: { maxCalls, maxMicrousd: config.spendMicrousd },
              fallback: "utility-top-pick",
              id: `reference.${entry.id}`,
              trigger: { kind: "score-margin", maxMargin: BigInt(entry.margin) },
              features: [
                "hunger",
                "thirst",
                "wetness",
                "rain",
                "health",
                "protection",
                "travelMs",
                "perceived",
              ],
              modelAlias: alias.alias,
            },
          ],
        },
      },
    });
    const record = records[0];
    labelled.push({
      id: entry.id,
      expectedPick: entry.expectedPick,
      reason: entry.reason,
      declaredMargin: entry.margin,
      actualGap: entry.actualGap,
      picked: record?.shadow.choice ?? null,
      status: record?.shadow.status ?? "models-off",
      correct: record?.shadow.status === "picked" && record.shadow.choice === entry.expectedPick,
      record: record ?? null,
    });
  }
  const records = await runDecisionShadow({
    subjects: simulation.subjects,
    declarations: declared,
    decider,
  });
  const referenceAnswered = labelled.filter((entry) => entry.status === "picked").length;
  return {
    schemaVersion: 1,
    pack: simulation.artifact,
    spanMs: String(config.spanMs),
    alias: alias.alias,
    model: alias.route.model,
    ambiguityMargin: String(config.margin),
    modelsOff: Boolean(config.modelsOff),
    budget: {
      capMicrousd: config.spendMicrousd,
      perCallCeilingMicrousd: alias.maxCostMicrousd,
      reservedMicrousd: reservations * alias.maxCostMicrousd,
      calls: calls.length,
    },
    replay: simulation.run.replay,
    finalStateHash: simulation.run.finalStateHash,
    utilityAgreement: decisionShadowReport(records),
    records,
    reference: {
      kind: "labelled-fixture-state-variations",
      total: labelled.length,
      correct: labelled.filter((entry) => entry.correct).length,
      answered: referenceAnswered,
      coverage: referenceAnswered / labelled.length,
      accuracy:
        referenceAnswered === 0
          ? null
          : labelled.filter((entry) => entry.correct).length / referenceAnswered,
      cases: labelled,
    },
    measuredCostMicrousd: calls.reduce((sum, call) => sum + (call.costMicrousd ?? 0), 0),
    unknownCosts: calls.filter((call) => call.costMicrousd === null).length,
  };
}
