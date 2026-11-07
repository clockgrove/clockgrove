import { join } from "node:path";
import type { CommandEnvelope } from "@clockgrove/contracts";
import {
  executeWorldKernel,
  sha256Hex,
  type WorldKernelInput,
  type WorldKernelOutcome,
} from "@clockgrove/kernel";
import { runScenario, type ScenarioKernelDriver } from "@clockgrove/simulator";
import { REPO_ROOT } from "../../../../packages/simulator/cli/repo.js";
import { goldenReference, scenarioDocument } from "../journal-parity.js";
import type { NativeWorldOwner } from "./native-harness.js";

// Native-owner parity: a committed Wave 1 scenario's plans (main and each variant) run through the
// simulator's scenario engine with a driver that sends every command to POST /v1/runtime/commands,
// every continuation chunk to the trusted owner RPC, and every restart step to a replaced runtime
// that has lost its local storage. The engine still steps with the pure kernel; the native side is
// checked where it is authoritative: the final state hash PostgreSQL holds, against the golden's.

/** One run's result: coverage identity and counts, and the actual versus expected final hash. */
export interface NativeRunParity {
  readonly pack: string;
  readonly scenario: string;
  readonly run: string;
  readonly commands: number;
  readonly chunks: number;
  readonly retries: number;
  readonly restarts: number;
  readonly ms: number;
  readonly actual: string;
  readonly expected: string;
}

class NativeDriver implements ScenarioKernelDriver {
  commands = 0;
  chunks = 0;
  retries = 0;
  restarts = 0;
  readonly started = performance.now();
  ms = 0;
  private readonly answered = new Map<string, string>();

  constructor(
    private readonly owner: NativeWorldOwner,
    private readonly ready: Promise<void>,
  ) {}

  async call(input: WorldKernelInput): Promise<WorldKernelOutcome | undefined> {
    await this.ready;
    const call = input as unknown as {
      readonly input: { readonly command: CommandEnvelope<string, unknown> };
      readonly continuation?: unknown;
    };
    const { command } = call.input;
    const pure = executeWorldKernel(input);
    if (call.continuation !== undefined) {
      const resumed = await this.owner.request("/resume", {
        ...this.owner.scope,
        commandId: "native-parity-resume",
      });
      if (resumed.status !== 200 || JSON.stringify(resumed.body) === "null")
        throw new Error(`no continuation resumed for ${command.commandId}: ${resumed.status}`);
      this.chunks += 1;
      return pure;
    }
    const response = await this.owner.submit(command);
    const body = JSON.stringify(response.body);
    const first = this.answered.get(command.commandId);
    if (first !== undefined) {
      // An exact retry: the owner answers from the stored receipt, as the Journal driver records it.
      if (body !== first) throw new Error(`retry of ${command.commandId} answered differently`);
      this.retries += 1;
      return undefined;
    }
    this.answered.set(command.commandId, body);
    if ((response.status === 200) !== pure.ok)
      throw new Error(
        `${command.commandId}: native ${response.status} ${body}, pure ok=${pure.ok}`,
      );
    this.commands += 1;
    return pure;
  }

  async restart(): Promise<void> {
    this.restarts += 1;
    await this.owner.replace(true);
  }
}

/** The committed partition's state hash, or a marker when a continuation is still open. */
async function finalHash(owner: NativeWorldOwner): Promise<string> {
  const partition = `${owner.world.birth.world.partitionId}:${owner.scope.spaceId}`;
  return owner.sql(
    `SELECT CASE WHEN continuation_command_id IS NULL THEN state_hash ELSE 'open-continuation' END
       FROM clockgrove.partition_states WHERE partition_id = '${partition}'`,
  );
}

/**
 * Runs every plan of `worlds/<pack>/<directory>/<scenario>` through the native owner. A committed
 * scenario is checked against its golden; a long run (no golden) against the pure kernel's run.
 */
export async function nativeScenarioParity(
  owner: NativeWorldOwner,
  scenario: string,
  directory: "scenarios" | "long-runs" = "scenarios",
): Promise<NativeRunParity[]> {
  const pack = owner.packName;
  const { document } = await scenarioDocument(
    join(REPO_ROOT, "worlds", pack, directory, `${scenario}.json`),
  );
  const golden = directory === "scenarios" ? await goldenReference(pack, scenario) : undefined;
  const drivers = new Map<string, NativeDriver>();
  const actual = new Map<string, string>();
  // Each run starts from the provisioned world: genesis fixes the command and event IDs.
  await owner.reset();
  let chain = Promise.resolve();
  let last: string | undefined;
  const ran = await runScenario(
    { artifact: owner.world.artifact, source: owner.world.source, scenario: document },
    {
      sha256: async (bytes) => sha256Hex(bytes),
      driver: (run) => {
        const previous = last;
        last = run;
        if (previous !== undefined)
          chain = chain.then(async () => {
            actual.set(previous, await finalHash(owner));
            drivers.get(previous)!.ms = performance.now() - drivers.get(previous)!.started;
            await owner.reset();
          });
        chain.catch(() => undefined);
        const driver = new NativeDriver(owner, chain);
        drivers.set(run, driver);
        return driver;
      },
    },
  );
  await chain;
  if (last !== undefined) {
    actual.set(last, await finalHash(owner));
    drivers.get(last)!.ms = performance.now() - drivers.get(last)!.started;
  }
  if (!ran.ok) throw new Error(`the native run refused: ${ran.error.code} ${ran.error.path}`);
  const pure = new Map(
    ran.value.bundle.runs.map((run) => [String(run.name), String(run.finalStateHash)]),
  );
  return [...drivers].map(([run, driver]) => ({
    pack,
    scenario,
    run,
    commands: driver.commands,
    chunks: driver.chunks,
    retries: driver.retries,
    restarts: driver.restarts,
    ms: Math.round(driver.ms),
    actual: actual.get(run) ?? "missing",
    expected: (golden === undefined ? pure.get(run) : golden.get(run)?.finalStateHash) ?? "missing",
  }));
}

/** Prints each run's coverage identity and hashes; returns the mismatches. */
export function reportNativeParity(runs: readonly NativeRunParity[]): string[] {
  const mismatches: string[] = [];
  for (const run of runs) {
    const id = `${run.pack}/${run.scenario}:${run.run}`;
    const match = run.actual === run.expected;
    process.stdout.write(
      `native-owner parity ${id}: ${match ? "match" : "MISMATCH"} actual ${run.actual} expected ${run.expected} (${run.commands} commands, ${run.chunks} continuation chunks, ${run.retries} retries, ${run.restarts} restarts, ${run.ms} ms)\n`,
    );
    if (!match) mismatches.push(`${id} actual ${run.actual} != expected ${run.expected}`);
  }
  return mismatches;
}
