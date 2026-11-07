import { SCRIPTED_COGNITION_VERSION } from "@clockgrove/domain";
import {
  CANONICAL_ENCODING_VERSION,
  CATCH_UP_ENGINE_VERSION,
  canonicalBytes,
  RANDOM_ALGORITHM,
  RANDOM_CONTRACT_VERSION,
  RESOLVER_VERSION,
  worldRegistryIdentity,
} from "@clockgrove/kernel";
import {
  validateWorldPack,
  WORLD_PACK_ENGINE_VERSION,
  type WorldPackArtifactRef,
} from "@clockgrove/world-pack-sdk";
import { SIMULATOR_VERSION } from "../constants.js";
import {
  behaviorPackOf,
  createSimulatorPackPorts,
  type SimulatorPorts,
  seedGenesis,
} from "../genesis.js";
import {
  SCENARIO_BUNDLE_KIND,
  SCENARIO_BUNDLE_VERSION,
  type ScenarioBundle,
  type ScenarioResult,
  type ScenarioRun,
} from "./bundle.js";
import { evaluateAssertion, evaluateEquivalence } from "./compare.js";
import { decodeScenario, MAIN_RUN, SCENARIO_SCHEMA_VERSION } from "./document.js";
import { executePlan, type ScenarioKernelDriver } from "./engine.js";
import { deepFreeze, isOneOf, isRecord, plain, refuse, ScenarioRefusal } from "./support.js";

const INPUT_FIELDS = ["artifact", "source", "scenario"] as const;

/**
 * The simulator ports, plus an optional kernel driver per run (main and each variant, by name). The
 * driver is for harnesses that run the same plans elsewhere; the pure kernel runs without one.
 */
export interface ScenarioPorts extends SimulatorPorts {
  readonly driver?: (run: string) => ScenarioKernelDriver;
}

function readInput(input: unknown): { artifact: unknown; source: unknown; scenario: unknown } {
  if (!isRecord(input)) return refuse("MALFORMED_INPUT", "input", "input must be a record");
  for (const key of Object.keys(input))
    if (!isOneOf(INPUT_FIELDS, key)) refuse("UNKNOWN_FIELD", `input.${key}`, "unknown input field");
  for (const key of INPUT_FIELDS)
    if (!Object.hasOwn(input, key)) refuse("MISSING_FIELD", `input.${key}`, `${key} is required`);
  return { artifact: input.artifact, source: input.source, scenario: input.scenario };
}

/**
 * Runs a declarative scenario against a built pack artifact and returns the canonical, hashed scenario
 * bundle. Malformed input resolves to a `{ code, path, message }` refusal; `seedGenesis` refusals pass
 * through unchanged; an internal defect rejects with the original error and is never a refusal.
 */
export async function runScenario(input: unknown, ports: ScenarioPorts): Promise<ScenarioResult> {
  /** Records an exception thrown by the caller's sha256 port, which `seedGenesis` would hide as a refusal. */
  const trap: { failed: boolean; error: unknown } = { failed: false, error: undefined };
  try {
    if (!isRecord(ports) || typeof ports.sha256 !== "function")
      refuse("MALFORMED_INPUT", "ports", "ports must provide sha256");
    if (ports.driver !== undefined && typeof ports.driver !== "function")
      refuse("MALFORMED_INPUT", "ports.driver", "ports.driver must be a function");
    const sha256 = async (bytes: Uint8Array): Promise<string> => {
      try {
        return await ports.sha256(bytes);
      } catch (error) {
        trap.failed = true;
        trap.error = error;
        throw error;
      }
    };
    const wrapped: SimulatorPorts = { sha256 };

    const { artifact: suppliedArtifact, source, scenario: rawScenario } = readInput(input);
    const scenario = decodeScenario(rawScenario);
    if (
      isRecord(suppliedArtifact) &&
      typeof suppliedArtifact.packId === "string" &&
      typeof suppliedArtifact.version === "string" &&
      (suppliedArtifact.packId !== scenario.pack.id ||
        suppliedArtifact.version !== scenario.pack.version)
    )
      refuse(
        "PACK_MISMATCH",
        "scenario.pack",
        "the scenario names a different pack than the artifact",
      );

    const seeded = await seedGenesis({ artifact: suppliedArtifact, source }, wrapped);
    if (!seeded.ok) {
      if (trap.failed) throw trap.error;
      // seedGenesis flags a caught exception that is not a refusal. The input shape was already checked
      // above, so it is an internal defect, which must not look like a refusal.
      if (seeded.defect === true) throw new Error("seeding failed with an internal defect");
      return { ok: false, error: seeded.error };
    }
    const seed = seeded.value.bundle;
    if (
      seed.artifact.packId !== scenario.pack.id ||
      seed.artifact.version !== scenario.pack.version
    )
      refuse(
        "PACK_MISMATCH",
        "scenario.pack",
        "the scenario names a different pack than the artifact",
      );

    const validated = await validateWorldPack(source, createSimulatorPackPorts(wrapped));
    if (!validated.ok) {
      if (trap.failed) throw trap.error;
      return { ok: false, error: validated.error };
    }
    const pack = validated.value;
    const policy = pack.behaviorPolicy;
    if (
      policy === null &&
      (scenario.steps.length > 0 || scenario.variants.some((v) => v.steps.length > 0))
    )
      refuse(
        "MISSING_BEHAVIOR_POLICY",
        "scenario.steps",
        "steps need a pack with a behaviour policy",
      );

    const artifact: WorldPackArtifactRef = seed.artifact;
    const behaviorPack = behaviorPackOf(pack, artifact);

    const driver = ports.driver;
    const context = {
      scenario,
      pack,
      seed,
      behaviorPack,
      sha256,
      ...(driver === undefined ? {} : { driver }),
    };
    const plans = [
      { name: MAIN_RUN, path: "scenario.steps", steps: scenario.steps },
      ...scenario.variants.map((variant, index) => ({
        name: variant.name,
        path: `scenario.variants[${index}].steps`,
        steps: variant.steps,
      })),
    ];
    const runs = new Map<string, ScenarioRun>();
    for (const plan of plans)
      runs.set(plan.name, await executePlan(context, plan.name, plan.path, plan.steps));

    const equivalences = scenario.equivalences.map((declared) =>
      evaluateEquivalence(declared, runs),
    );
    const byId = new Map(equivalences.map((entry) => [entry.id, entry]));
    const assertions = scenario.assertions.map((assertion) =>
      evaluateAssertion(assertion, runs, byId),
    );

    const registry = worldRegistryIdentity();
    const pairs = (list: readonly (readonly [string, number])[]) =>
      list.map(([type, version]) => ({ type, version }));
    const scenarioHash = await sha256(canonicalBytes(scenario));
    const runList = plans.map((plan) => {
      const run = runs.get(plan.name);
      if (run === undefined) throw new TypeError(`plan ${plan.name} recorded no run`);
      return run;
    });

    const withoutHash: Omit<ScenarioBundle, "bundleHash"> = plain({
      kind: SCENARIO_BUNDLE_KIND,
      version: SCENARIO_BUNDLE_VERSION,
      versions: {
        simulator: SIMULATOR_VERSION,
        packEngine: WORLD_PACK_ENGINE_VERSION,
        canonicalEncoding: CANONICAL_ENCODING_VERSION,
        catchUpEngine: CATCH_UP_ENGINE_VERSION,
        audienceResolver: RESOLVER_VERSION,
        randomContract: RANDOM_CONTRACT_VERSION,
        randomAlgorithm: RANDOM_ALGORITHM,
        behaviorPolicy: policy === null ? null : policy.version,
        scriptedCognition: SCRIPTED_COGNITION_VERSION,
        scenarioSchema: SCENARIO_SCHEMA_VERSION,
        genesisBundle: seed.version,
      },
      pack: { id: pack.id, version: pack.version },
      artifact: { ...artifact },
      kernel: {
        commands: pairs(registry.commands),
        events: pairs(registry.events),
        reducers: pairs(registry.reducers),
      },
      prng: {
        contract: RANDOM_CONTRACT_VERSION,
        algorithm: RANDOM_ALGORITHM,
        streams: pack.randomStreams.map((stream) => ({
          name: stream.name,
          algorithm: stream.algorithm,
          algorithmVersion: stream.algorithmVersion,
          seed: stream.seed,
        })),
      },
      genesis: {
        bundleHash: seed.bundleHash,
        initialStateHash: seed.initialStateHash,
        finalStateHash: seed.finalStateHash,
        seedProjection: seed.seedProjection,
        counters: seed.counters,
        world: seed.world,
      },
      scenario: { name: scenario.name, hash: scenarioHash, document: scenario },
      scriptedInputs: (seed.state.scriptedCognition?.entries ?? []).map((entry) => ({
        scripted: true as const,
        origin: "cognitive-seed" as const,
        ref: entry.ref,
        entry,
      })),
      runs: runList,
      equivalences,
      assertions,
      replayVerified: runList.every((run) => run.replay.matches),
    });
    const bundleHash = await sha256(canonicalBytes(withoutHash));
    const bundle: ScenarioBundle = deepFreeze({ ...withoutHash, bundleHash });
    return { ok: true, value: Object.freeze({ bundle, bytes: canonicalBytes(bundle) }) };
  } catch (error) {
    if (error instanceof ScenarioRefusal && !trap.failed)
      return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
    throw error;
  }
}
