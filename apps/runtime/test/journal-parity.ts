import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DueWorkPorts, EncodedPartitionState } from "@clockgrove/application";
import {
  continueWorldCommand,
  createPartitionSnapshot,
  decodeCanonicalNode,
  decodePartitionState,
  executeWorldCommand,
  exportReplayBundle,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  plainValue,
  type RuntimeAuthorizationContext,
  SnapshotIncompatibleError,
  SnapshotIntegrityError,
  SnapshotNotQuiescentError,
  verifyPartitionReplay,
  verifyReplayBundle,
  WORLD_KERNEL_EVENT_TYPES,
  type WorldPartitionScope,
} from "@clockgrove/application";
import type { CommandEnvelope } from "@clockgrove/contracts";
import {
  canonicalBytes,
  executeWorldKernel,
  restoreNamedRandomState,
  sha256Hex,
  type WorldKernelInput,
  type WorldKernelOutcome,
} from "@clockgrove/kernel";
import {
  installAuthorization,
  PostgreSqlArtifactStore,
  type PostgreSqlClient,
  PostgreSqlDueWorkReader,
  PostgreSqlJournalRangeSource,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldCommandJournal,
  type PostgreSqlWorldCommandTimeouts,
  PostgreSqlWorldProvisioningStore,
  readPendingSchedules,
  WORLD_COMMAND_TIMEOUTS,
} from "@clockgrove/persistence";
import { runScenario, type ScenarioKernelDriver } from "@clockgrove/simulator";
import { decodeResource } from "@clockgrove/world-pack-sdk";

import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import { decodeCanonicalBytes } from "../../../packages/simulator/src/canonical-decode.js";
import {
  applyMigrations,
  psql,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import type { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import {
  commandRequest,
  connect,
  type DatabaseFixture,
  type ProvisionedPartition,
  provisionTestWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

// Journal parity: a Wave 1 scenario's plans (main and each variant) run through the simulator's own
// scenario engine with a kernel driver that sends every kernel call through the world-command use
// cases against real PostgreSQL. Each run has its own database, cloned from a template where the world
// is already provisioned, because the pack's genesis fixes the tenant, world and command IDs (a second
// run in one database would collide on receipts and event IDs). The checks then read the outcome back
// in a fresh connection and compare it with the committed golden, or with the pure run.

type Rec = Record<string, any>;

const PRINCIPAL = "principal-journal-parity";
const EVENT_PAGE = 2_000n;
const sha256 = async (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);

export interface ParityCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface RunParity {
  readonly pack: string;
  readonly scenario: string;
  readonly run: string;
  readonly reference: "golden" | "pure";
  readonly checks: readonly ParityCheck[];
  readonly passed: boolean;
  readonly kernelCalls: number;
  readonly events: number;
  /** Snapshots taken during the run, and the kernel events replayed after the latest one. */
  readonly snapshots: number;
  readonly suffixEvents: number;
  /** Time in the kernel, and in the journal around it (transactions, reads and appends). */
  readonly kernelMs: number;
  readonly journalMs: number;
  /** The final state hash the run is checked against (the golden's, or the pure run's). */
  readonly finalStateHash: string;
  /** Journal time around each kernel call (the call's wall time less its kernel time), in ms. */
  readonly journalLatencyMs: LatencySummary;
  /** The diagnostic replay of the run's database: kernel events folded and its wall time. */
  readonly replay: { readonly events: number; readonly ms: number };
}

export interface LatencySummary {
  readonly calls: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles of per-call samples, rounded to 0.1 ms. */
function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value * 10) / 10;
  const rank = (p: number) => round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    calls: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: round(sorted.at(-1) ?? 0),
    mean: round(sorted.length === 0 ? 0 : total / sorted.length),
  };
}

/** What one pure run ended with: the comparison side of every check. */
export interface Reference {
  readonly finalStateHash: string;
  readonly randomAfter: unknown;
  readonly remaining: unknown;
  readonly events: EventStream;
  readonly commands: readonly Rec[];
}

/** An order-sensitive hash of kernel events, each without its `authorityDecisionId`. */
class EventStream {
  private readonly hash = createHash("sha256");
  private digested: string | undefined;
  count = 0;

  add(event: unknown): void {
    if (this.digested !== undefined) throw new Error("the event stream is already digested");
    const bytes = canonicalBytes(withoutDecision(event));
    this.hash.update(`${bytes.length}:`);
    this.hash.update(bytes);
    this.count += 1;
  }

  digest(): string {
    this.digested ??= `${this.count}:${this.hash.digest("hex")}`;
    return this.digested;
  }
}

/**
 * A kernel event as both sides compare it: the journal seals each event with the command's own
 * authority decision, the simulator with a fixed one, so `attribution.authorityDecisionId` is set aside.
 */
function withoutDecision(event: unknown): unknown {
  const plain = plainValue(event) as Rec;
  const { authorityDecisionId: _decision, ...attribution } = plain.attribution as Rec;
  return { ...plain, attribution };
}

/** The random-state record a scenario run reports (`randomState.after`), from a serialized state. */
function describeRandom(serialized: string): unknown {
  const state = restoreNamedRandomState(serialized);
  return Object.keys(state)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => {
      const stream = state[name]!;
      return {
        name,
        algorithm: stream.algorithm.algorithm,
        algorithmVersion: stream.algorithm.version,
        draws: stream.draws,
        state: [...stream.state],
      };
    });
}

const same = (left: unknown, right: unknown): boolean =>
  sha256Hex(canonicalBytes(plainValue(left))) === sha256Hex(canonicalBytes(plainValue(right)));

const check = (id: string, passed: boolean, detail?: string): ParityCheck =>
  passed || detail === undefined ? { id, passed } : { id, passed, detail };

/** A provisioned pack world in its template database. */
interface ParityWorld extends ProvisionedPartition {
  readonly template: string;
}

/**
 * Runs each kernel call of one plan through the Journal: a new command through `executeWorldCommand`,
 * a continuation chunk through `continueWorldCommand`. It returns the outcome of the one kernel call
 * the journal transaction made, or `undefined` when the journal answered from a stored outcome.
 */
class JournalDriver implements ScenarioKernelDriver {
  private client: HyperdrivePostgreSqlClient | undefined;
  calls = 0;
  snapshots = 0;
  /** Wall time inside the kernel, and of the whole journal calls around it. */
  kernelMs = 0;
  journalMs = 0;
  /** Per kernel call: its journal wall time less its kernel time. */
  readonly latencies: number[] = [];

  constructor(
    private readonly world: ParityWorld,
    private readonly open: () => HyperdrivePostgreSqlClient,
    private readonly timeouts: PostgreSqlWorldCommandTimeouts,
  ) {}

  async call(input: WorldKernelInput): Promise<WorldKernelOutcome | undefined> {
    this.client ??= this.open();
    if (this.calls === 0 && this.snapshots === 0) await this.snapshot();
    let captured: WorldKernelOutcome | undefined;
    let kernelMs = 0;
    const ports: DueWorkPorts = {
      journal: new PostgreSqlWorldCommandJournal(this.client, undefined, undefined, this.timeouts),
      behavior: this.world.behavior,
      dueWork: new PostgreSqlDueWorkReader(this.client),
      kernel: (kernelInput) => {
        const started = performance.now();
        captured = executeWorldKernel(kernelInput);
        kernelMs = performance.now() - started;
        this.kernelMs += kernelMs;
        return captured;
      },
    };
    const call = input as unknown as {
      readonly input: { readonly command: CommandEnvelope<string, unknown> };
      readonly continuation?: unknown;
    };
    const started = performance.now();
    if (call.continuation === undefined) {
      await executeWorldCommand(commandRequest(this.world, call.input.command), ports);
    } else if ((await continueWorldCommand(this.world.partition, ports)) === undefined) {
      throw new Error(`the journal has no open continuation for ${call.input.command.commandId}`);
    }
    const elapsed = performance.now() - started;
    this.journalMs += elapsed;
    if (captured !== undefined) {
      this.calls += 1;
      this.latencies.push(elapsed - kernelMs);
    }
    if (captured !== undefined && (this.calls & (this.calls - 1)) === 0) await this.snapshot();
    return captured;
  }

  /**
   * Snapshots the committed head: before the first kernel call and after calls 1, 2, 4, 8, …, so even a
   * one-call run has a snapshot below its head. A head with an open continuation is skipped.
   */
  private async snapshot(): Promise<void> {
    const client = this.client!;
    const ports = {
      snapshots: new PostgreSqlSnapshotStore(client),
      artifacts: new PostgreSqlArtifactStore(client),
    };
    try {
      await createPartitionSnapshot(this.world.authorization, partitionScope(this.world), ports);
      this.snapshots += 1;
    } catch (error) {
      if (!(error instanceof SnapshotNotQuiescentError)) throw error;
    }
  }

  /** A restart step: the next call runs on a new connection, from the state PostgreSQL holds. */
  async restart(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }
}

/** A scenario document as the CLI reads it, with its pack and plan names. */
export async function scenarioDocument(
  file: string,
): Promise<{ document: unknown; runs: readonly string[] }> {
  const document = decodeResource(new Uint8Array(await readFile(file)), "scenario") as Rec;
  const variants = Array.isArray(document.variants) ? document.variants : [];
  return { document, runs: ["main", ...variants.map((variant: Rec) => String(variant.name))] };
}

/** One run's reference from its recorded bundle run and its kernel event stream. */
const referenceOf = (run: Rec, events: EventStream): Reference => ({
  finalStateHash: String(run.finalStateHash),
  randomAfter: run.randomState.after,
  remaining: run.schedule.remaining,
  events,
  commands: run.commands,
});

/** The pure reference of every run, from the committed golden (full recording). */
export async function goldenReference(
  pack: string,
  scenario: string,
): Promise<Map<string, Reference>> {
  const decoded = decodeCanonicalBytes(
    new Uint8Array(await readFile(join(REPO_ROOT, "worlds", pack, "goldens", `${scenario}.json`))),
  );
  if (!decoded.ok) throw new Error(`the ${scenario} golden is not canonical bytes`);
  const references = new Map<string, Reference>();
  for (const run of (decoded.value as Rec).runs as Rec[]) {
    if (!Array.isArray(run.events))
      throw new Error(`the ${scenario} golden is not a full recording`);
    const events = new EventStream();
    for (const { call: _call, reducer: _reducer, ...event } of run.events as Rec[])
      events.add(event);
    references.set(String(run.name), referenceOf(run, events));
  }
  return references;
}

/** The pure reference of every run, from a pure run of the scenario whose kernel events are hashed. */
async function pureReference(
  world: ParityWorld,
  document: unknown,
): Promise<Map<string, Reference>> {
  const streams = new Map<string, EventStream>();
  const ran = await runScenario(
    { artifact: world.world.artifact, source: world.world.source, scenario: document },
    {
      sha256,
      driver: (run) => {
        const events = new EventStream();
        streams.set(run, events);
        return {
          call: async (input) => {
            const outcome = executeWorldKernel(input);
            if (outcome.ok) for (const event of outcome.result.events) events.add(event);
            return outcome;
          },
        };
      },
    },
  );
  if (!ran.ok) throw new Error(`the pure run refused: ${ran.error.code} ${ran.error.path}`);
  const runs = ran.value.bundle.runs as unknown as Rec[];
  return new Map(
    runs.map((run) => [String(run.name), referenceOf(run, streams.get(String(run.name))!)]),
  );
}

/** Cluster-level SQL as the admin role, outside any database a run uses. */
export function admin(
  fixture: DatabaseFixture,
  sql: string,
  database = "postgres",
): Promise<string> {
  return truthOf(fixture, database)(sql);
}

/**
 * A migrated cluster with one provisioned template database per pack. Each run clones its own
 * database from the template of its pack.
 */
export class ParityCluster {
  private readonly worlds = new Map<string, ParityWorld>();
  private databases = 0;

  private constructor(
    readonly fixture: DatabaseFixture,
    private readonly timeouts: PostgreSqlWorldCommandTimeouts,
  ) {}

  /**
   * `timeouts` bound each world-command transaction; the default is production's. A scenario's own
   * kernel budgets can exceed what one production transaction allows (its kernel calls are not
   * chunked by `DUE_WORK_ADVANCE_BUDGET`), so the long runs pass wider bounds.
   */
  static async create(
    fixture: DatabaseFixture,
    timeouts: PostgreSqlWorldCommandTimeouts = WORLD_COMMAND_TIMEOUTS,
  ): Promise<ParityCluster> {
    await applyMigrations(fixture.tools, fixture.environment);
    return new ParityCluster(fixture, timeouts);
  }

  /** The provisioned world of a pack (`worlds/<pack>`), provisioned once into its template. */
  async world(pack: string): Promise<ParityWorld> {
    const known = this.worlds.get(pack);
    if (known !== undefined) return known;
    const template = `parity_template_${pack}`;
    await admin(this.fixture, `CREATE DATABASE ${template} TEMPLATE clockgrove`);
    const world: ParityWorld = {
      ...(await provisionTestWorld(this.fixture, await testWorld(pack), PRINCIPAL, template)),
      template,
    };
    this.worlds.set(pack, world);
    return world;
  }

  /** A new database cloned from `template` (no connection to it may be open). */
  async clone(template: string): Promise<string> {
    this.databases += 1;
    const database = `parity_${this.databases}`;
    await admin(this.fixture, `CREATE DATABASE ${database} TEMPLATE ${template}`);
    return database;
  }

  /** Runs admin SQL inside one database, from stdin (documents can exceed one argument). */
  async tamper(database: string, sql: string): Promise<void> {
    await psql(this.fixture.tools, { ...this.fixture.environment, PGDATABASE: database }, sql);
  }

  /**
   * Runs every plan of a committed scenario (`worlds/<pack>/scenarios` or `long-runs`) through the
   * Journal and checks each against the golden, or against the pure run when the scenario has none.
   */
  async scenario(
    pack: string,
    scenario: string,
    options: { readonly directory?: "scenarios" | "long-runs" } = {},
  ): Promise<{ runs: readonly RunParity[]; databases: ReadonlyMap<string, string> }> {
    const directory = options.directory ?? "scenarios";
    const world = await this.world(pack);
    const { document, runs } = await scenarioDocument(
      join(REPO_ROOT, "worlds", pack, directory, `${scenario}.json`),
    );
    // Clone first: the cluster's deadline bounds its psql calls, and a long pure run comes next.
    const databases = new Map<string, string>();
    for (const run of runs) databases.set(run, await this.clone(world.template));
    const references =
      directory === "scenarios"
        ? await goldenReference(pack, scenario)
        : await pureReference(world, document);
    const drivers = new Map<string, JournalDriver>();
    let ran: Awaited<ReturnType<typeof runScenario>>;
    try {
      ran = await runScenario(
        { artifact: world.world.artifact, source: world.world.source, scenario: document },
        {
          sha256,
          driver: (run) => {
            const database = databases.get(run);
            if (database === undefined) throw new Error(`no database for run ${run}`);
            const driver = new JournalDriver(
              world,
              () => connect(this.fixture.environment, database),
              this.timeouts,
            );
            drivers.set(run, driver);
            return driver;
          },
        },
      );
    } finally {
      for (const driver of drivers.values()) await driver.close();
    }
    if (!ran.ok) throw new Error(`the journal run refused: ${ran.error.code} ${ran.error.path}`);
    const journalRuns = new Map(
      (ran.value.bundle.runs as unknown as Rec[]).map((run) => [String(run.name), run]),
    );
    const results: RunParity[] = [];
    for (const run of runs) {
      const reference = references.get(run);
      const journal = journalRuns.get(run);
      if (reference === undefined || journal === undefined)
        throw new Error(`run ${run} has no reference`);
      const projection = await this.projectionChecks(world, databases.get(run)!, reference);
      const checks = [
        ...stepChecks(reference.commands, journal.commands as Rec[]),
        ...projection.checks,
      ];
      results.push({
        pack,
        scenario,
        run,
        reference: directory === "scenarios" ? "golden" : "pure",
        checks,
        passed: checks.every((entry) => entry.passed),
        kernelCalls: drivers.get(run)!.calls,
        events: reference.events.count,
        snapshots: drivers.get(run)!.snapshots,
        suffixEvents: projection.suffixEvents,
        kernelMs: Math.round(drivers.get(run)!.kernelMs),
        journalMs: Math.round(drivers.get(run)!.journalMs - drivers.get(run)!.kernelMs),
        finalStateHash: reference.finalStateHash,
        journalLatencyMs: summarize(drivers.get(run)!.latencies),
        replay: projection.replay,
      });
    }
    return { runs: results, databases };
  }

  /**
   * The projection checks of one golden run against an existing database (a negative control's
   * scratch copy); returns the failed check IDs, with each detail when `details` is set.
   */
  async scenarioChecks(
    pack: string,
    scenario: string,
    run: string,
    database: string,
    details = false,
  ): Promise<string[]> {
    const reference = (await goldenReference(pack, scenario)).get(run);
    if (reference === undefined) throw new Error(`the ${scenario} golden has no run ${run}`);
    const { checks } = await this.projectionChecks(await this.world(pack), database, reference);
    return checks
      .filter((entry) => !entry.passed)
      .map(
        (entry) =>
          `${run}:${entry.id}${details && entry.detail !== undefined ? ` ${entry.detail}` : ""}`,
      );
  }

  /**
   * Reads one run's database back in a fresh connection and compares it with the reference: the
   * stored state hash, the projection's own verification, random state, remaining schedules, no open
   * continuation, the kernel event stream through `JournalRangeReader`, the product replay from the
   * stored birth to the covered head against the projection, and the exported bundle, verified offline.
   */
  async projectionChecks(
    world: ParityWorld,
    database: string,
    reference: Reference,
  ): Promise<{
    checks: ParityCheck[];
    suffixEvents: number;
    replay: { events: number; ms: number };
  }> {
    const { checks, suffixEvents, replay, bundle } = await withClient(
      this.fixture.environment,
      async (client) => {
        const checks: ParityCheck[] = [];
        let suffixEvents = 0;
        const replay = { events: 0, ms: 0 };
        const { stored, continuation } = await readProjection(client, world);
        checks.push(
          check(
            "state-hash",
            stored.stateHash === reference.finalStateHash,
            `${stored.stateHash} != ${reference.finalStateHash}`,
          ),
          check("continuation", continuation === null, `open continuation ${continuation}`),
        );
        try {
          const decoded = decodePartitionState(stored);
          checks.push(check("projection", true));
          checks.push(
            check(
              "random-state",
              same(describeRandom(decoded.randomState), reference.randomAfter),
              "random state differs",
            ),
          );
          const remaining = decoded.schedules.map((item) => ({
            scheduleId: item.id,
            kind: item.kind,
            dueAt: item.dueAt,
            payload: item.payload,
          }));
          checks.push(
            check("schedules", same(remaining, reference.remaining), "remaining schedules differ"),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          checks.push(check("projection", false, reason));
        }
        const events = new EventStream();
        const reader = new JournalRangeReader(
          new PostgreSqlJournalRangeSource(client, world.authorization),
          JOURNAL_EVENT_REGISTRY,
        );
        const kernelTypes = new Set(WORLD_KERNEL_EVENT_TYPES);
        for (let from = 1n; ; from += EVENT_PAGE) {
          const page = await reader.readStream(
            {
              tenantId: world.authorization.tenantId,
              timelineId: world.partition.target.timelineId,
              streamId: world.partition.route.streamId,
            },
            { from, to: from + EVENT_PAGE - 1n },
          );
          for (const event of page) {
            if (kernelTypes.has(event.type))
              events.add(decodeCanonicalNode((event.payload as Rec).kernelEvent));
          }
          if (BigInt(page.length) < EVENT_PAGE) break;
        }
        checks.push(
          check(
            "event-stream",
            events.digest() === reference.events.digest(),
            `${events.digest()} != ${reference.events.digest()}`,
          ),
        );
        // The product replay, diagnostic: full from the stored birth, the latest snapshot plus its suffix,
        // and every snapshot's recorded hash at its head, all against the live hash.
        const ports = {
          events: reader,
          birth: new PostgreSqlWorldProvisioningStore(client),
          decodeResource,
          snapshots: new PostgreSqlSnapshotStore(client),
          artifacts: new PostgreSqlArtifactStore(client),
        };
        try {
          const started = performance.now();
          const verified = await verifyPartitionReplay(
            world.authorization,
            partitionScope(world),
            "diagnostic",
            ports,
          );
          const { full, fromSnapshot, mismatches } = verified;
          suffixEvents = fromSnapshot?.eventsApplied ?? 0;
          replay.events = full.eventsApplied + suffixEvents;
          replay.ms = Math.round(performance.now() - started);
          checks.push(
            check(
              "replay",
              !mismatches.includes("full-vs-live"),
              `${full.stateHash} != ${verified.liveStateHash}`,
            ),
            check(
              "snapshot-replay",
              fromSnapshot !== undefined &&
                fromSnapshot.eventsApplied > 0 &&
                !mismatches.includes("snapshot-vs-live"),
              `${fromSnapshot?.start}+${suffixEvents}: ${fromSnapshot?.stateHash} != ${verified.liveStateHash}`,
            ),
            check(
              "checkpoints",
              verified.checkpoints.length > 0 && verified.verified,
              mismatches.join(","),
            ),
          );
        } catch (error) {
          const snapshot =
            error instanceof SnapshotIntegrityError || error instanceof SnapshotIncompatibleError;
          checks.push(check(snapshot ? "snapshot-replay" : "replay", false, failure(error)));
        }
        const bundle = await exportBundle(client, world, world.authorization).catch(
          (error: unknown) => error,
        );
        return { checks, suffixEvents, replay, bundle };
      },
      database,
    );
    // The connection is closed: the bundle verifies offline, against the golden's final hash.
    checks.push(await bundleCheck(bundle, reference.finalStateHash));
    return { checks, suffixEvents, replay };
  }

  /** The partition of a pack's world in `database`, exported under `authorization`. */
  async exportBundle(
    pack: string,
    database: string,
    authorization: RuntimeAuthorizationContext,
  ): Promise<Uint8Array> {
    const world = await this.world(pack);
    return withClient(
      this.fixture.environment,
      (client) => exportBundle(client, world, authorization),
      database,
    );
  }
}

function exportBundle(
  client: PostgreSqlClient,
  world: ParityWorld,
  authorization: RuntimeAuthorizationContext,
): Promise<Uint8Array> {
  const ports = {
    snapshots: new PostgreSqlSnapshotStore(client),
    events: new PostgreSqlJournalRangeSource(client, authorization),
    birth: new PostgreSqlWorldProvisioningStore(client),
  };
  return exportReplayBundle(authorization, partitionScope(world), ports).then(({ bytes }) => bytes);
}

/** The `bundle` check: an exported bundle (or the export's error) verified with no database. */
export async function bundleCheck(exported: unknown, finalStateHash: string): Promise<ParityCheck> {
  try {
    if (!(exported instanceof Uint8Array)) throw exported;
    const verified = await verifyReplayBundle(exported, { decodeResource });
    return check(
      "bundle",
      verified.finalStateHash === finalStateHash,
      `${verified.finalStateHash} != ${finalStateHash}`,
    );
  } catch (error) {
    return check("bundle", false, failure(error));
  }
}

/** A replay failure as a check detail: the typed error and its reason (or incompatible field). */
function failure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { reason, field } = error as { readonly reason?: string; readonly field?: string };
  return `${error.name}(${reason ?? field ?? error.message})`;
}

const partitionScope = (world: ProvisionedPartition): WorldPartitionScope => ({
  ...world.partition.target,
  partitionId: world.partition.route.partitionId,
});

/**
 * Step parity: every step outcome of the journal run equals the pure one, except a retry, which the
 * pure kernel refuses as a revision conflict and the Journal answers from the stored receipt.
 */
function stepChecks(pure: readonly Rec[], journal: readonly Rec[]): ParityCheck[] {
  const view = (record: Rec) => ({
    step: record.step,
    role: record.role,
    chunk: record.chunk,
    commandId: record.commandId,
  });
  const differences: string[] = [];
  if (pure.length !== journal.length) differences.push(`${journal.length} steps != ${pure.length}`);
  for (const [index, expected] of pure.entries()) {
    const actual = journal[index];
    if (actual === undefined) break;
    if (!same(view(actual), view(expected))) differences.push(`step ${index} identity differs`);
    else if (expected.role === "retry") {
      if (actual.outcome.status !== "stored" || expected.outcome.code !== "revision-conflict") {
        differences.push(`retry ${String(expected.step)} was ${String(actual.outcome.status)}`);
      }
    } else if (!same(actual.outcome, expected.outcome)) {
      differences.push(`step ${String(expected.step)} outcome differs`);
    }
  }
  return [check("steps", differences.length === 0, differences.join("; "))];
}

/** The stored state row and pending schedule rows, under the runtime role and tenant authorization. */
async function readProjection(
  client: PostgreSqlClient,
  world: ParityWorld,
): Promise<{ stored: EncodedPartitionState; continuation: string | null }> {
  const key = {
    tenantId: world.authorization.tenantId,
    timelineId: world.partition.target.timelineId,
    partitionId: world.partition.route.partitionId,
  };
  await client.query("BEGIN");
  try {
    await installAuthorization(client, world.authorization);
    const result = await client.query(
      `SELECT revision::text AS revision, simulation_time::text AS simulation_time, document_version,
              document, document_hash, state_hash, continuation_command_id
         FROM clockgrove.partition_states
        WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
      [key.tenantId, key.timelineId, key.partitionId],
    );
    const row = result.rows[0] as Rec | undefined;
    if (row === undefined) throw new Error("the partition has no state row");
    const schedules = await readPendingSchedules(client, key);
    await client.query("COMMIT");
    return {
      stored: {
        revision: BigInt(row.revision),
        simulationTime: BigInt(row.simulation_time),
        documentVersion: row.document_version,
        document: row.document,
        documentHash: row.document_hash,
        stateHash: row.state_hash,
        schedules,
      },
      continuation: row.continuation_command_id ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** The failed check IDs of a parity result, for reports and negative controls. */
export function failedChecks(runs: readonly RunParity[]): string[] {
  return runs.flatMap((run) =>
    run.checks.filter((entry) => !entry.passed).map((entry) => `${run.run}:${entry.id}`),
  );
}
