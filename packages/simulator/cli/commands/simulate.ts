import { writeFile } from "node:fs/promises";
import {
  buildWorldPack,
  decodeResource,
  type WorldPackArtifactRef,
  WorldPackError,
} from "@clockgrove/world-pack-sdk";
import { seedGenesis } from "../../src/index.js";
import { isRecord, type Rec } from "../../src/scenario/support.js";
import { type CommandSpec, type Options, optionValue } from "../args.js";
import { packArtifactDocument, readPackArtifact } from "../artifact.js";
import { failed, type Outcome, type Refusal, succeed, usage } from "../envelope.js";
import { isDirectory, isFileSystemError, pathExists, readCanonicalFile } from "../input.js";
import { type PackFiles, readableSdkSource, readPackDirectory } from "../pack-source.js";
import { packPorts, ports } from "../ports.js";
import { readingOption } from "../reading.js";
import { countersOf, deltaSince, type RunDelta, type RunView } from "../run-view.js";
import { type CommandStep, runSession, type SessionStep, verifyState } from "../session.js";
import { encodeState, readStateDocument, SESSION_SCENARIO } from "../state.js";

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/u;

/** A pack source directory is built; a pack artifact file is read as it is. */
async function readPack(
  path: string,
): Promise<
  | { readonly ok: true; readonly artifact: WorldPackArtifactRef; readonly files: PackFiles }
  | { readonly ok: false; readonly refusal: Refusal }
> {
  if (await isDirectory(path)) {
    const files = await readPackDirectory(path);
    const built = await buildWorldPack(readableSdkSource(files), packPorts);
    return built.ok
      ? { ok: true, artifact: built.value.artifact, files }
      : { ok: false, refusal: built.error };
  }
  const file = readPackArtifact(await readCanonicalFile(path));
  return { ok: true, artifact: file.artifact, files: file };
}

function epochOf(clock: unknown): unknown {
  if (!isRecord(clock) || !Object.hasOwn(clock, "epoch"))
    throw new Error("the clock policy has no epoch");
  return clock.epoch;
}

const seed: CommandSpec = {
  options: ["--pack", "--out"],
  run: async (options) => {
    const out = optionValue(options, "--out");
    if (await pathExists(out))
      return usage("OUT_EXISTS", "--out", "the output path already exists");
    return readingOption("--pack", async () => {
      const read = await readPack(optionValue(options, "--pack"));
      if (!read.ok) return failed(read.refusal);
      const pack = { artifact: read.artifact, source: readableSdkSource(read.files) };
      const seeded = await seedGenesis(pack, ports);
      if (!seeded.ok) return failed(seeded.error);
      const genesis = seeded.value.bundle;
      const session = await runSession(pack, SESSION_SCENARIO, []);
      if (!session.ok) return failed(session.refusal);
      const state = encodeState({
        pack: packArtifactDocument(read.artifact, read.files).document,
        genesis,
        scenarioName: SESSION_SCENARIO,
        steps: [],
        run: session.run.raw,
        finalStateHash: session.run.finalStateHash,
      });
      try {
        await writeFile(out, state.bytes, { flag: "wx" });
      } catch (error) {
        if (isFileSystemError(error))
          return usage("OUT_UNWRITABLE", "--out", "the output file cannot be created");
        throw error;
      }
      return succeed({
        artifact: genesis.artifact,
        epoch: epochOf(genesis.clock),
        clock: genesis.clock,
        cognitiveSeeds: genesis.cognitiveSeeds,
        genesisCommandId: genesis.genesisCommandId,
        seedCommands: genesis.seedCommands,
        schedules: genesis.schedules,
        events: genesis.events,
        decisionTraces: genesis.decisionTraces,
        seedProjection: genesis.seedProjection,
        randomState: genesis.randomState,
        counters: genesis.counters,
        initialStateHash: genesis.initialStateHash,
        finalStateHash: genesis.finalStateHash,
        bundleHash: genesis.bundleHash,
        stateBundleHash: state.bundleHash,
      });
    });
  },
};

/** `--command` is inline SDK resource JSON `{ type, version, payload }`; anything else is a usage error. */
function parseCommand(
  text: string,
):
  | { readonly ok: true; readonly step: Omit<CommandStep, "key"> }
  | { readonly ok: false; readonly outcome: Outcome } {
  const malformed = (message: string) => ({
    ok: false as const,
    outcome: usage("MALFORMED_VALUE", "--command", message),
  });
  let value: unknown;
  try {
    value = decodeResource(new TextEncoder().encode(text), "--command");
  } catch (error) {
    if (error instanceof WorldPackError) return malformed("the command is not SDK resource JSON");
    throw error;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "payload,type,version" ||
    typeof value.type !== "string" ||
    typeof value.version !== "number" ||
    !isRecord(value.payload)
  )
    return malformed("the command must be { type, version, payload }");
  return {
    ok: true,
    step: { kind: "command", type: value.type, version: value.version, payload: value.payload },
  };
}

function refusedStep(commands: readonly Rec[], what: string): Refusal | null {
  for (const entry of commands) {
    const outcome = entry.outcome;
    if (isRecord(outcome) && outcome.status === "refused")
      return {
        code: String(outcome.code),
        path: String(outcome.path),
        message: `the kernel refused the ${what}`,
      };
  }
  return null;
}

interface Extension {
  readonly stepCount: number;
  readonly next: RunView;
  readonly added: RunDelta;
  readonly entry: Rec;
  readonly stateBundleHash: string;
}

/**
 * Appends one step to a verified state file and replaces the file. `plan` turns the verified current run
 * into the step (or a refusal); the file is left unchanged unless the step is accepted.
 */
async function extendState(
  path: string,
  what: string,
  plan: (current: RunView, key: string) => SessionStep | Refusal,
  report: (extension: Extension) => unknown,
): Promise<Outcome> {
  return readingOption("--state", async () => {
    const state = readStateDocument(await readCanonicalFile(path));
    const verified = await verifyState(state);
    if (!verified.ok) return failed(verified.refusal);
    const step = plan(verified.run, `step-${state.steps.length + 1}`);
    if (!("kind" in step)) return failed(step);
    const steps = [...state.steps, step];
    const executed = await runSession(verified.pack, state.scenarioName, steps);
    if (!executed.ok) return failed(executed.refusal);
    const added = deltaSince(verified.run, executed.run);
    const refused = refusedStep(added.commands, what);
    if (refused !== null) return failed(refused);
    const [entry] = added.commands;
    if (entry === undefined) throw new Error("the step recorded no command");
    const encoded = encodeState({
      pack: state.pack,
      genesis: state.genesis,
      scenarioName: state.scenarioName,
      steps,
      run: executed.run.raw,
      finalStateHash: executed.run.finalStateHash,
    });
    try {
      await writeFile(path, encoded.bytes);
    } catch (error) {
      if (isFileSystemError(error))
        return usage("STATE_UNWRITABLE", "--state", "the state file cannot be replaced");
      throw error;
    }
    return succeed(
      report({
        stepCount: steps.length,
        next: executed.run,
        added,
        entry,
        stateBundleHash: encoded.bundleHash,
      }),
    );
  });
}

const command: CommandSpec = {
  options: ["--state", "--command"],
  run: (options: Options) => {
    const parsed = parseCommand(optionValue(options, "--command"));
    if (!parsed.ok) return Promise.resolve(parsed.outcome);
    return extendState(
      optionValue(options, "--state"),
      "command",
      (_current, key) => ({ ...parsed.step, key }),
      ({ stepCount, next, added, entry, stateBundleHash }) => ({
        commandId: entry.commandId,
        outcome: entry.outcome,
        events: added.events,
        decisionTraces: added.decisions,
        scheduleMutations: added.scheduleMutations,
        randomState: next.randomState,
        counters: countersOf(stepCount, next),
        finalStateHash: next.finalStateHash,
        stateBundleHash,
      }),
    );
  },
};

const advance: CommandSpec = {
  options: ["--state", "--to"],
  run: (options: Options) => {
    const target = optionValue(options, "--to");
    if (!DECIMAL_INTEGER.test(target))
      return Promise.resolve(
        usage(
          "MALFORMED_VALUE",
          "--to",
          "the target must be a decimal integer of simulation milliseconds",
        ),
      );
    const to = BigInt(target);
    return extendState(
      optionValue(options, "--state"),
      "advance",
      (current, key) =>
        to > current.simulationTime
          ? { kind: "advance", key, to, mode: "fast-forward" }
          : {
              code: "TARGET_NOT_AFTER_CURRENT",
              path: "--to",
              message: "the target is not after the current simulation time",
            },
      ({ stepCount, next, added, entry, stateBundleHash }) => ({
        to,
        commandId: entry.commandId,
        outcome: entry.outcome,
        scheduledInputs: added.scheduledInputs,
        events: added.events,
        decisionTraces: added.decisions,
        scheduleMutations: added.scheduleMutations,
        ruleEvaluations: added.ruleEvaluations,
        ruleIntents: added.ruleIntents,
        ruleDisposition: next.ruleDisposition,
        remainingSchedule: next.remainingSchedule,
        nextDueAt: next.nextDueAt,
        randomState: next.randomState,
        counters: countersOf(stepCount, next),
        finalStateHash: next.finalStateHash,
        stateBundleHash,
      }),
    );
  },
};

const verify: CommandSpec = {
  options: ["--bundle"],
  run: (options) =>
    readingOption("--bundle", async () => {
      const state = readStateDocument(await readCanonicalFile(optionValue(options, "--bundle")));
      const verified = await verifyState(state);
      if (!verified.ok) return failed(verified.refusal);
      return succeed({
        bundleHash: state.bundleHash,
        finalStateHash: state.finalStateHash,
        steps: state.steps.length,
      });
    }),
};

export const SIMULATE_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map([
  ["simulate seed", seed],
  ["simulate command", command],
  ["simulate advance", advance],
  ["simulate verify", verify],
]);
