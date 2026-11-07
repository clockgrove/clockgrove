import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CanonicalNode,
  canonicalBytes,
  decodeCanonicalNode,
  decodePartitionState,
  encodeCanonicalNode,
  scheduleQueueHash,
  WORLD_KERNEL_EVENT_TYPES,
  type WorldCommandResult,
  worldStateHash,
} from "@clockgrove/application";
import { decodeBrowserScope, decodeEventEnvelope } from "@clockgrove/contracts";
import type { WorldState } from "@clockgrove/domain";
import {
  executeWorldKernel,
  serializeNamedRandomState,
  sha256Hex,
  type WorldKernelInput,
  type WorldKernelOutcome,
} from "@clockgrove/kernel";
import { readPendingSchedules } from "@clockgrove/persistence";
import { runScenario, type ScenarioKernelDriver } from "@clockgrove/simulator";
import { expect } from "vitest";
import { REPO_ROOT } from "../../../../packages/simulator/cli/repo.js";
import { PostgreSqlCommandOwner } from "../../src/world-commands.js";
import { scenarioDocument } from "../journal-parity.js";
import { advanceCommand } from "../world-fixture.js";
import { canonicalResponse, type NativeWorldOwner } from "./native-harness.js";

export const AUTONOMOUS_MODES = [
  "headless",
  "frequent-alarms",
  "long-sleep",
  "workflow-catch-up",
  "redelivery",
  "restart",
  "replacement",
] as const;
export type AutonomousMode = (typeof AUTONOMOUS_MODES)[number];
export interface AutonomousParity {
  readonly pack: string;
  readonly scenario: string;
  readonly run: string;
  readonly mode: AutonomousMode;
  /** Full `worldStateHash`, random state and schedule queue, against the headless application run. */
  readonly actual: string;
  readonly expected: string;
  /** The same without revision, against the independent pure-kernel due-work reference. */
  readonly semantic: string;
  readonly reference: string;
  /** The stored revision, against birth plus the world events the journal holds. */
  readonly revision: bigint;
  readonly journalRevision: bigint;
  readonly continuation: string;
}

export async function configureAutonomousOwner(
  owner: NativeWorldOwner,
  wallTime: bigint | undefined,
  commandLimit: number,
  schedule: boolean,
  workflowCatchUp = false,
): Promise<void> {
  const result = await owner.request("/autonomous/configure", {
    scope: owner.scope,
    wallTime: wallTime?.toString() ?? "",
    commandLimit,
    schedule,
    workflowCatchUp,
  });
  if (result.status !== 200) throw new Error(`autonomous configuration status ${result.status}`);
}

export async function autonomousQuiescent(
  owner: NativeWorldOwner,
  through: bigint,
): Promise<boolean> {
  return (
    (await owner.sql(
      `SELECT (NOT EXISTS (SELECT 1 FROM clockgrove.partition_states WHERE continuation_command_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM clockgrove.partition_schedules WHERE status='pending' AND due_at <= ${through}))::text`,
    )) === "true"
  );
}

export interface NativeAlarmStatus {
  readonly deliveries: number;
  readonly completed: number;
  readonly interruptions: number;
  readonly alarm: number | null;
  readonly worldAlarm: number | null;
  readonly wallTime: string;
  readonly commandLimit: number;
}

export async function nativeAlarmStatus(owner: NativeWorldOwner): Promise<NativeAlarmStatus> {
  const result = await owner.request("/autonomous/status", { scope: owner.scope });
  if (result.status !== 200) throw new Error(`native alarm inspection status ${result.status}`);
  return result.body as NativeAlarmStatus;
}

export async function redeliverNativeAlarm(owner: NativeWorldOwner): Promise<void> {
  const before = await nativeAlarmStatus(owner);
  const result = await owner.request("/autonomous/redeliver", { scope: owner.scope });
  if (result.status !== 200) throw new Error(`native redelivery status ${result.status}`);
  for (let attempt = 0; attempt < 1000; attempt++) {
    if ((await nativeAlarmStatus(owner)).completed === before.completed + 1) return;
    await delay(10);
  }
  throw new Error("native alarm redelivery was not observed");
}

/** Journal receipt timestamps are operational metadata; all semantic envelope fields remain exact. */
export function autonomousSemanticResponse(
  response: Awaited<ReturnType<NativeWorldOwner["submit"]>>,
): Awaited<ReturnType<NativeWorldOwner["submit"]>> {
  if (!Array.isArray(response.body)) return response;
  const result = decodeCanonicalNode(canonicalResponse(response.body)) as WorldCommandResult;
  return {
    ...response,
    body: encodeCanonicalNode({
      ...result,
      events: result.events.map((event) => {
        const { recordedAt: _recordedAt, ...semantic } = decodeEventEnvelope(
          event,
          (payload) => payload,
          event.actor === undefined ? {} : { actorBinding: event.actor },
        );
        return semantic;
      }),
    }),
  };
}

export interface AutonomousCommandObservation {
  readonly run: string;
  readonly mode: AutonomousMode;
  readonly commandId: string;
  readonly response: Awaited<ReturnType<NativeWorldOwner["submit"]>>;
}

export class AutonomousScenarioDriver implements ScenarioKernelDriver {
  private wall = 1_000_000_000n;
  private readonly answered = new Set<string>();
  constructor(
    private readonly owner: NativeWorldOwner,
    private readonly mode: AutonomousMode,
    private readonly ready: Promise<void>,
    private readonly onCommandResponse?: (
      commandId: string,
      response: Awaited<ReturnType<NativeWorldOwner["submit"]>>,
    ) => void,
  ) {}

  async start(): Promise<void> {
    await configureAutonomousOwner(this.owner, this.wall, this.commandLimit(), false);
    for (const [type, payload] of [
      [
        "SetClockPolicy",
        {
          schemaVersion: 1,
          simulationMillisecondsPerWallMillisecond: 1,
          catchUpCapMs: this.mode === "long-sleep" ? 86_400_000n : 31_536_000_000n,
        },
      ],
      ["ResumeWorld", { schemaVersion: 1 }],
    ] as const) {
      const result = await this.owner.submit({
        ...advanceCommand(this.owner.world, `autonomous-${type}`, 0n, null),
        type,
        payload,
      });
      if (result.status !== 200) throw new Error(`autonomous ${type} status ${result.status}`);
    }
    if (this.mode === "headless")
      await configureAutonomousOwner(this.owner, this.wall, this.commandLimit(), false);
  }

  private commandLimit(): number {
    return this.mode === "frequent-alarms" || this.mode === "workflow-catch-up"
      ? 1
      : this.mode === "redelivery"
        ? 2
        : this.mode === "restart"
          ? 3
          : 4;
  }

  async drain(through: bigint): Promise<void> {
    const completedBefore =
      this.mode === "headless" ? 0 : (await nativeAlarmStatus(this.owner)).completed;
    let replaced = false;
    await configureAutonomousOwner(
      this.owner,
      this.wall,
      this.commandLimit(),
      this.mode !== "headless",
      this.mode === "workflow-catch-up",
    );
    if (this.mode === "headless") {
      await this.owner.withSqlClient(async (client) => {
        const owner = new PostgreSqlCommandOwner(client);
        let previousProgress: string | undefined;
        let unchangedAttempts = 0;
        for (let attempt = 0; attempt < 1_000_000; attempt++) {
          const result = await owner.advanceClock(decodeBrowserScope(this.owner.scope), this.wall);
          if (result.status === "refused")
            throw new Error(`headless refused ${JSON.stringify(result)}`);
          if (result.status === "idle" && (await autonomousQuiescent(this.owner, through))) return;
          if (result.commands.length === 0) {
            const progress = await this.owner.sql(
              "SELECT jsonb_build_object('revision',revision,'simulationTime',simulation_time,'stateHash',state_hash,'admittedHorizon',clock_admitted_horizon,'continuationCommandId',continuation_command_id,'clockPolicy',clock_policy,'ownerGeneration',clock_owner_generation,'nextDue',(SELECT min(due_at) FROM clockgrove.partition_schedules WHERE status='pending'),'committedReceipts',(SELECT count(*) FROM clockgrove.command_receipts WHERE status='committed'),'rejectedReceipts',(SELECT count(*) FROM clockgrove.command_receipts WHERE status='rejected'))::text FROM clockgrove.partition_states",
            );
            unchangedAttempts = progress === previousProgress ? unchangedAttempts + 1 : 1;
            previousProgress = progress;
            if (unchangedAttempts >= 4) {
              throw new Error(
                JSON.stringify({
                  kind: "autonomous-headless-stalled",
                  mode: this.mode,
                  through: through.toString(),
                  wallTime: this.wall.toString(),
                  attempts: attempt + 1,
                  unchangedAttempts,
                  status: result.status,
                  commandCount: result.commands.length,
                  progress,
                }),
              );
            }
          } else {
            previousProgress = undefined;
            unchangedAttempts = 0;
          }
        }
        throw new Error(`headless command bound exhausted through ${through}`);
      });
      return;
    }
    for (let attempt = 0; attempt < 120_000; attempt++) {
      if (
        !replaced &&
        (this.mode === "restart" || this.mode === "replacement") &&
        (await nativeAlarmStatus(this.owner)).completed > completedBefore
      ) {
        await configureAutonomousOwner(this.owner, this.wall, this.commandLimit(), false);
        await this.owner.replace(this.mode === "restart");
        await configureAutonomousOwner(this.owner, this.wall, this.commandLimit(), true);
        replaced = true;
      }
      if (await autonomousQuiescent(this.owner, through)) {
        const status = await nativeAlarmStatus(this.owner);
        if (status.deliveries === status.completed) return;
      }
      await delay(10);
    }
    throw new Error(`autonomous work did not drain: ${this.mode} through ${through}`);
  }

  async call(input: WorldKernelInput): Promise<WorldKernelOutcome | undefined> {
    await this.ready;
    if (input.input.kind !== "command") throw new Error("scenario command input required");
    const command = input.input.command;
    const pure = executeWorldKernel(input);
    if (input.continuation === undefined && this.answered.has(command.commandId)) return undefined;
    this.answered.add(command.commandId);
    if (command.type === "world.advance" && pure.ok) {
      this.wall =
        1_000_000_000n + command.payload.targetTime - this.owner.world.birth.state.simulationTime;
      if (this.mode === "long-sleep") await delay(25);
      await this.drain(command.payload.targetTime);
      if (this.mode === "redelivery") {
        const before = await this.owner.sql("SELECT state_hash FROM clockgrove.partition_states");
        await redeliverNativeAlarm(this.owner);
        if ((await this.owner.sql("SELECT state_hash FROM clockgrove.partition_states")) !== before)
          throw new Error(
            `redelivery changed canonical state before ${before} after ${await this.owner.sql("SELECT jsonb_build_object('hash',state_hash,'revision',revision,'simulationTime',simulation_time)::text FROM clockgrove.partition_states")} through ${command.payload.targetTime}`,
          );
      }
    } else if (input.continuation === undefined) {
      // A client sees the owner caught up to earned time before it reads the revision it expects.
      await this.drain(this.owner.world.birth.state.simulationTime + this.wall - 1_000_000_000n);
      // Expected revisions are transport concurrency guards generated by the scenario engine.
      // Preserve their live/stale relation while the autonomous owner uses its own canonical
      // integration boundaries; semantic scenario inputs and every state field stay unchanged.
      const revision = BigInt(
        await this.owner.sql("SELECT revision::text FROM clockgrove.partition_states"),
      );
      const expected = command.expected.partitionRevision;
      const submitted = {
        ...command,
        expected:
          expected === undefined
            ? command.expected
            : {
                ...command.expected,
                partitionRevision: expected === input.partition.revision ? revision : revision + 1n,
              },
      };
      let result = await this.owner.submit(submitted);
      // Catch-up (an environment boundary) changed the state under a live expectation: the client
      // re-reads the revision and sends the same command again.
      if (
        expected === input.partition.revision &&
        result.status === 409 &&
        (result.body as { error?: string }).error === "world_command_conflict"
      )
        result = await this.owner.submit({
          ...command,
          expected: {
            ...command.expected,
            partitionRevision: BigInt(
              await this.owner.sql("SELECT revision::text FROM clockgrove.partition_states"),
            ),
          },
        });
      if (!pure.ok && pure.error.code === "revision-conflict")
        expect(result).toEqual({
          status: 409,
          body: { error: "world_command_conflict", kind: "partition" },
        });
      this.onCommandResponse?.(command.commandId, result);
    } else {
      const resumed = await this.owner.request("/resume", this.owner.scope);
      if (resumed.status !== 200)
        throw new Error(`autonomous scenario continuation status ${resumed.status}`);
    }
    return pure;
  }
  async restart(): Promise<void> {
    await this.owner.replace(true);
    await configureAutonomousOwner(
      this.owner,
      this.wall,
      this.commandLimit(),
      this.mode !== "headless",
      this.mode === "workflow-catch-up",
    );
  }
}

/**
 * The independent reference: continuous headless execution from the pure kernel alone, sharing no
 * runtime code with admission, alarms or due-work routing. A running clock integrates only through
 * due work, never at a wall-time boundary, so a scenario advance becomes one pure advance to each
 * successive deadline at or before its target; with nothing due the call changes nothing.
 */
function continuousReference(): (
  input: WorldKernelInput,
) => Promise<WorldKernelOutcome | undefined> {
  // The scenario's last advance target is the earned time the owner's clock has reached.
  let earned = 0n;
  type Step = Extract<WorldKernelInput["input"], { kind: "command" }>["command"];
  type Event = Extract<WorldKernelOutcome, { ok: true }>["result"]["events"][number];
  /** One pure advance to each successive deadline at or before `through`; nothing due changes nothing. */
  const throughDeadlines = (
    start: WorldKernelInput,
    command: Step,
    through: bigint,
  ): [WorldKernelInput, WorldKernelOutcome | undefined, Event[]] => {
    let current = start;
    let outcome: WorldKernelOutcome | undefined;
    const events: Event[] = [];
    for (
      let due = current.schedules[0]?.dueAt;
      due !== undefined && due <= through;
      due = current.schedules[0]?.dueAt
    ) {
      const state = current.partition.state;
      const step = {
        ...command,
        expected: { ...command.expected, partitionRevision: state.revision },
        payload: {
          ...command.payload,
          targetTime: due > state.simulationTime ? due : state.simulationTime,
        },
      } as Step;
      let continuation: WorldKernelInput["continuation"];
      do {
        outcome = executeWorldKernel({
          ...current,
          input: { kind: "command", command: step },
          ...(continuation === undefined ? {} : { continuation }),
        });
        if (!outcome.ok) return [current, outcome, events];
        const { result } = outcome;
        events.push(...result.events);
        continuation = result.continuation;
        current = {
          ...current,
          partition: { ...current.partition, revision: result.state.revision, state: result.state },
          simulationTime: result.state.simulationTime,
          schedules: result.schedules,
          randomState: result.updatedRandomState,
        };
      } while (!outcome.result.complete);
    }
    return [current, outcome, events];
  };
  return async (input) => {
    const command = input.input.kind === "command" ? input.input.command : undefined;
    if (command === undefined || input.continuation !== undefined) return executeWorldKernel(input);
    if (command.type === "world.advance") {
      earned = command.payload.targetTime;
      return throughDeadlines(input, command, earned)[1];
    }
    // A client command runs after the overdue deadlines and any environment boundaries up to
    // earned time (a lazy advance), at earned time.
    earned = earned > input.simulationTime ? earned : input.simulationTime;
    const advance = {
      ...command,
      type: "world.advance",
      payload: { schemaVersion: 1, targetTime: earned, maxInputs: 64, maxEvents: 4096 },
    } as Step;
    const [due, , events] = throughDeadlines(input, advance, earned);
    const state = due.partition.state;
    const lazy = executeWorldKernel({
      ...due,
      input: {
        kind: "command",
        command: {
          ...advance,
          expected: { partitionRevision: state.revision },
          payload: { ...advance.payload, lazy: true },
        } as Step,
      },
    });
    if (!lazy.ok) return lazy;
    const boundaries = lazy.result.events.some((event) => event.type !== "time.advanced");
    const { result } = lazy;
    // With a boundary the lazy advance commits as its own step; without one, time alone moves.
    const ready = boundaries
      ? {
          ...due,
          partition: { ...due.partition, revision: result.state.revision, state: result.state },
          simulationTime: result.state.simulationTime,
          schedules: result.schedules,
          randomState: result.updatedRandomState,
        }
      : {
          ...due,
          simulationTime: result.state.simulationTime,
          partition: {
            ...due.partition,
            state: { ...state, simulationTime: result.state.simulationTime },
          },
        };
    if (boundaries) events.push(...result.events);
    // As the driver does for the owner: the client reads the revision after catch-up, so a live
    // expectation names the caught-up revision and a stale one stays stale.
    const expected = command.expected.partitionRevision;
    const seen =
      expected === undefined
        ? command.expected
        : {
            ...command.expected,
            partitionRevision:
              expected === input.partition.revision
                ? ready.partition.revision
                : ready.partition.revision + 1n,
          };
    const outcome = executeWorldKernel({
      ...ready,
      input: { kind: "command", command: { ...command, expected: seen } },
    } as WorldKernelInput);
    return outcome.ok
      ? { ...outcome, result: { ...outcome.result, events: [...events, ...outcome.result.events] } }
      : outcome;
  };
}

/** The terminal state, named random state and schedule queue hash together. */
interface Terminal {
  readonly state: WorldState;
  /** Serialized, as the partition document stores it. */
  readonly randomState: string;
  readonly schedulesHash: string;
}
function terminalHash({ state, randomState, schedulesHash }: Terminal): string {
  return sha256Hex(canonicalBytes({ state: worldStateHash(state), randomState, schedulesHash }));
}
/**
 * For the pure reference only: revision counts transport commands, which the reference chunks
 * differently from the application; every other field stays.
 */
function semanticHash(terminal: Terminal): string {
  return terminalHash({ ...terminal, state: { ...terminal.state, revision: 0n } });
}

interface StoredRow {
  readonly tenant_id: string;
  readonly timeline_id: string;
  readonly partition_id: string;
  readonly revision: string;
  readonly simulation_time: string;
  readonly document_version: number;
  readonly document: CanonicalNode;
  readonly document_hash: string;
  readonly state_hash: string;
}

/** The stored document, verified against its schedule rows, with the queue rebuilt from those rows. */
async function storedTerminal(owner: NativeWorldOwner): Promise<Terminal> {
  return owner.withSqlClient(async (client) => {
    const [row] = (
      await client.query(
        `SELECT tenant_id, timeline_id, partition_id, revision::text, simulation_time::text,
                document_version, document, document_hash, state_hash
           FROM clockgrove.partition_states`,
      )
    ).rows as StoredRow[];
    if (row === undefined) throw new Error("the partition has no state row");
    const { state, schedules, randomState } = decodePartitionState({
      revision: BigInt(row.revision),
      simulationTime: BigInt(row.simulation_time),
      documentVersion: row.document_version,
      document: row.document,
      documentHash: row.document_hash,
      stateHash: row.state_hash,
      schedules: await readPendingSchedules(client, {
        tenantId: row.tenant_id,
        timelineId: row.timeline_id,
        partitionId: row.partition_id,
      }),
    });
    return { state, randomState, schedulesHash: scheduleQueueHash(schedules) };
  });
}

/**
 * Every mode's terminal against headless application execution on the full state hash, and every
 * mode (headless included) against the independent pure-kernel reference on the semantic hash.
 */
export async function autonomousScenarioParity(
  owner: NativeWorldOwner,
  scenario: string,
  observe?: (observation: AutonomousCommandObservation) => void,
): Promise<AutonomousParity[]> {
  const { document } = await scenarioDocument(
    join(REPO_ROOT, "worlds", owner.packName, "scenarios", `${scenario}.json`),
  );
  // Each run's terminal reference is its last committed outcome; a call changing nothing keeps it.
  const reference = new Map<string, string>();
  const headless = new Map<string, string>();
  const pure = await runScenario(
    { artifact: owner.world.artifact, source: owner.world.source, scenario: document },
    {
      sha256: async (bytes) => sha256Hex(bytes),
      driver: (run) => {
        const referenceCall = continuousReference();
        return {
          call: async (input) => {
            const outcome = await referenceCall(input);
            if (outcome?.ok) {
              const { state, updatedRandomState, schedules } = outcome.result;
              reference.set(
                run,
                semanticHash({
                  state,
                  randomState: serializeNamedRandomState(updatedRandomState),
                  schedulesHash: scheduleQueueHash(schedules),
                }),
              );
            }
            return outcome;
          },
        };
      },
    },
  );
  if (!pure.ok) throw new Error(`pure scenario refused: ${pure.error.code} ${pure.error.path}`);
  const expectedResponses = new Map<string, Awaited<ReturnType<NativeWorldOwner["submit"]>>>();
  const results: AutonomousParity[] = [];
  for (const mode of AUTONOMOUS_MODES) {
    let chain = Promise.resolve();
    let last: string | undefined;
    const capture = async (run: string) => {
      const terminal = await storedTerminal(owner);
      const actual = terminalHash(terminal);
      // Revision counts applied world events (kernel invariant world.revision-counts-events), so
      // storage gives it independently of the code that increments it.
      const journalTypes = JSON.parse(
        await owner.sql(
          "SELECT COALESCE(jsonb_object_agg(event_type, n), '{}')::text FROM (SELECT event_type, count(*) AS n FROM clockgrove.events WHERE (tenant_id, timeline_id, partition_id) IN (SELECT tenant_id, timeline_id, partition_id FROM clockgrove.partition_states) GROUP BY event_type) AS journal",
        ),
      ) as Record<string, number>;
      const journalRevision = Object.entries(journalTypes).reduce(
        (total, [type, count]) =>
          WORLD_KERNEL_EVENT_TYPES.includes(type) ? total + BigInt(count) : total,
        owner.world.birth.state.revision,
      );
      if (mode === "headless") headless.set(run, actual);
      const continuation = await owner.sql(
        "SELECT COALESCE(continuation_command_id,'none') FROM clockgrove.partition_states",
      );
      results.push({
        pack: owner.packName,
        scenario,
        run,
        mode,
        actual,
        expected: headless.get(run) ?? "missing-headless",
        semantic: semanticHash(terminal),
        reference: reference.get(run) ?? "missing-pure-run",
        revision: terminal.state.revision,
        journalRevision,
        continuation,
      });
    };
    await owner.reset();
    const ran = await runScenario(
      { artifact: owner.world.artifact, source: owner.world.source, scenario: document },
      {
        sha256: async (bytes) => sha256Hex(bytes),
        driver: (run) => {
          const previous = last;
          last = run;
          chain = chain.then(async () => {
            if (previous !== undefined) {
              await capture(previous);
              await owner.reset();
            }
            await driver.start();
          });
          const driver = new AutonomousScenarioDriver(owner, mode, chain, (commandId, response) => {
            const key = `${run}:${commandId}`;
            if (mode === "headless")
              expectedResponses.set(key, autonomousSemanticResponse(response));
            else
              expect(
                autonomousSemanticResponse(response),
                `${owner.packName}/${scenario}:${run}:${mode}:${commandId}`,
              ).toEqual(expectedResponses.get(key));
            observe?.({ run, mode, commandId, response });
          });
          return driver;
        },
      },
    );
    await chain;
    if (!ran.ok)
      throw new Error(`autonomous scenario refused: ${ran.error.code} ${ran.error.path}`);
    if (last !== undefined) await capture(last);
  }
  return results;
}

export function reportAutonomousParity(runs: readonly AutonomousParity[]): string[] {
  return runs.flatMap((run) => {
    const identity = `${run.pack}/${run.scenario}:${run.run}:${run.mode}`;
    process.stdout.write(
      `autonomous parity ${identity} actual ${run.actual} expected ${run.expected} semantic ${run.semantic} reference ${run.reference} revision ${run.revision} journal ${run.journalRevision} continuation ${run.continuation}\n`,
    );
    return [
      ...(run.actual === run.expected ? [] : [`actual ${run.actual} != expected ${run.expected}`]),
      ...(run.semantic === run.reference
        ? []
        : [`semantic ${run.semantic} != reference ${run.reference}`]),
      ...(run.revision === run.journalRevision
        ? []
        : [`revision ${run.revision} != journal ${run.journalRevision}`]),
      ...(run.continuation === "none" ? [] : [`continuation ${run.continuation}`]),
    ].map((failure) => `${identity} ${failure}`);
  });
}
