import { resolve } from "node:path";

import type {
  ProvisioningArtifact,
  ProvisionWorldRequest,
  RuntimeAuthorizationContext,
  WorldBehaviorSource,
  WorldCommandRequest,
  WorldGenesisPort,
  WorldKernel,
  WorldPartitionRequest,
} from "@clockgrove/application";
import {
  allowDecision,
  denyDecision,
  provisionWorld,
  WORLD_COMMAND_ID_STREAM,
} from "@clockgrove/application";
import type { CommandEnvelope } from "@clockgrove/contracts";
import {
  decodeAttributionEnvelope,
  decodeOpaqueId,
  decodePrivacyCeiling,
} from "@clockgrove/contracts";
import type { WorldState } from "@clockgrove/domain";
import {
  canonicalBytes,
  createDeterministicIdSource,
  createScheduleQueue,
  executeWorldKernel,
  restoreNamedRandomState,
  type ScheduleQueue,
  serializeNamedRandomState,
  type WorldContinuation,
  type WorldKernelInput,
  type WorldScheduledPayload,
} from "@clockgrove/kernel";
import { PostgreSqlWorldProvisioningStore } from "@clockgrove/persistence";
import { createSimulatorPackPorts } from "@clockgrove/simulator";
import { buildWorldPack, decodeResource, validateWorldPack } from "@clockgrove/world-pack-sdk";
import { readPackDirectory, sdkSource } from "../../../packages/simulator/cli/pack-source.js";
import { REPO_ROOT } from "../../../packages/simulator/cli/repo.js";
import { behaviorPackOf } from "../../../packages/simulator/src/genesis.js";
import {
  buildLampHallSource,
  EXPECTED_SEED_PROJECTION_HASHES,
  sha256Hex,
} from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import {
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import { seedProvisioningBirth as seedBirth } from "../src/workflows.js";

// Shared by the PostgreSQL integration tests: clusters held across a file's tests, connections, the
// shipped and lamp packs as provisionable worlds, and the pure kernel model a Journal run must match.

export interface DatabaseFixture {
  readonly tools: { readonly psql: string };
  readonly environment: Readonly<Record<string, string>>;
}

export interface PackSource {
  readonly manifest: unknown;
  readonly resources: Readonly<Record<string, Uint8Array>>;
  readonly dependencyArtifacts: readonly unknown[];
}

const hashPorts = { sha256: sha256Hex };

export function connectionString(
  environment: Readonly<Record<string, string>>,
  database = "clockgrove",
  role = "clockgrove_runtime",
): string {
  // Loopback mode (scripts/database/lib.mjs) listens on 127.0.0.1 with the run's password.
  if (environment.PGPASSWORD !== undefined) {
    const url = new URL(`postgres://${role}@127.0.0.1:${environment.PGPORT}/${database}`);
    url.password = environment.PGPASSWORD;
    url.searchParams.set("sslmode", "disable");
    return url.toString();
  }
  const url = new URL(`postgres://${role}@localhost/${database}`);
  url.searchParams.set("host", `\0${environment.PGHOST!.slice(1)}/.s.PGSQL.${environment.PGPORT}`);
  return url.toString();
}

/** A connection to `database` (the migrated `clockgrove` database by default), as the runtime role by default. */
export function connect(
  environment: Readonly<Record<string, string>>,
  database = "clockgrove",
  role = "clockgrove_runtime",
): HyperdrivePostgreSqlClient {
  return new HyperdrivePostgreSqlClient(connectionString(environment, database, role));
}

export async function withClient<T>(
  environment: Readonly<Record<string, string>>,
  operation: (client: HyperdrivePostgreSqlClient) => Promise<T>,
  database = "clockgrove",
  role = "clockgrove_runtime",
): Promise<T> {
  const client = connect(environment, database, role);
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

/** Admin SQL against `database`, trimmed. */
export function truthOf(
  fixture: DatabaseFixture,
  database = "clockgrove",
): (sql: string) => Promise<string> {
  return async (sql) =>
    (await psqlQuery(fixture.tools, { ...fixture.environment, PGDATABASE: database }, sql)).trim();
}

/** Fail admission receipt insertion in this disposable database, then remove the fault. */
export async function withAdmissionInsertFailure<T>(
  sql: ReturnType<typeof truthOf>,
  operation: () => Promise<T>,
): Promise<T> {
  await sql(
    "CREATE FUNCTION clockgrove.fail_admission_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'admission failure' USING ERRCODE = 'XX998'; END $$; CREATE TRIGGER fail_admission_test BEFORE INSERT ON clockgrove.clock_admissions FOR EACH ROW EXECUTE FUNCTION clockgrove.fail_admission_test()",
  );
  try {
    return await operation();
  } finally {
    await sql(
      "DROP TRIGGER fail_admission_test ON clockgrove.clock_admissions; DROP FUNCTION clockgrove.fail_admission_test()",
    );
  }
}

/** A disposable cluster held open across a file's tests until `close`; `setup` runs once. */
export function holdCluster(
  setup: (fixture: DatabaseFixture) => Promise<void>,
): Promise<{ readonly fixture: DatabaseFixture; readonly close: () => Promise<void> }> {
  let ready!: (held: { fixture: DatabaseFixture; close: () => Promise<void> }) => void;
  const opened = new Promise<{ fixture: DatabaseFixture; close: () => Promise<void> }>(
    (resolve) => (ready = resolve),
  );
  const done: Promise<void> = withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await setup(fixture);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    ready({ fixture, close: () => (release(), done) });
    await held;
  });
  return Promise.race([
    opened,
    done.then(() => Promise.reject(new Error("database closed early"))),
  ]);
}

/**
 * Adapts the simulator's genesis seeding to the application's genesis port: it seeds whatever pack
 * it is given, counts calls through `onSeed` and reports the first `defects` calls as defects.
 */
export function genesisPort(
  options: { onSeed?: () => void; defects?: number } = {},
): WorldGenesisPort {
  let defects = options.defects ?? 0;
  return {
    async seed({ artifact, source }) {
      options.onSeed?.();
      if (defects === 0) return seedBirth(artifact, source as PackSource);
      defects -= 1;
      return {
        ok: false,
        refusal: { code: "MALFORMED_INPUT", path: "genesis", message: "injected defect" },
        defect: true,
      };
    },
  };
}

/** A pack source and the artifact it builds. */
export async function packArtifact(
  source: PackSource,
): Promise<{ source: PackSource; artifact: ProvisioningArtifact }> {
  const built = await buildWorldPack(source, createSimulatorPackPorts(hashPorts));
  if (!built.ok) throw new Error(`pack build failed: ${built.error.code}`);
  return { source, artifact: built.value.artifact };
}

/** A pack source as a provisionable world: its built artifact, genesis birth and behavior. */
export async function packWorld(source: PackSource) {
  const { artifact } = await packArtifact(source);
  const validated = await validateWorldPack(source, createSimulatorPackPorts(hashPorts));
  if (!validated.ok) throw new Error(`pack validation failed: ${validated.error.code}`);
  const seeded = await seedBirth(artifact, source);
  if (!seeded.ok) throw new Error(`seeding refused: ${seeded.refusal.code}`);
  const { birth } = seeded;
  const genesis: WorldGenesisPort = { seed: async () => ({ ok: true, birth }) };
  return { source, artifact, birth, genesis, behavior: behaviorPackOf(validated.value, artifact) };
}

/** The lamp-hall fixture pack source at `version`, projecting to its committed hash unless overridden. */
export function lampSource(
  version = "1.0.0",
  expectedSeedProjectionHash?: string,
): Promise<PackSource> {
  return buildLampHallSource({
    version,
    expectedSeedProjectionHash:
      expectedSeedProjectionHash ?? EXPECTED_SEED_PROJECTION_HASHES[version] ?? "",
  });
}

/** A shipped pack name or absolute external pack directory with its behavior. */
export async function testWorld(name = "fixture") {
  const world = await packWorld(
    name === "lamp-hall"
      ? await lampSource()
      : (sdkSource(await readPackDirectory(resolve(REPO_ROOT, "worlds", name))) as PackSource),
  );
  if (world.behavior === null) throw new Error(`worlds/${name} has no behavior policy`);
  return { ...world, behavior: world.behavior };
}

export type TestWorld = Awaited<ReturnType<typeof testWorld>>;

/** A provisioned world's request scope: authorization, partition route and behavior. */
export interface ProvisionedPartition {
  readonly world: TestWorld;
  readonly authorization: RuntimeAuthorizationContext;
  readonly partition: WorldPartitionRequest;
  readonly behavior: WorldBehaviorSource;
}

/** The same authorized birth request used by direct and native Workflow integration fixtures. */
export function provisioningRequest(
  world: TestWorld,
  principal: string,
  caseId: string,
): ProvisionWorldRequest {
  return {
    authorization: {
      tenantId: decodeOpaqueId(world.birth.world.tenantId, "TenantId"),
      principalId: decodeOpaqueId(principal, "PrincipalId"),
      privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
    },
    caseId,
    artifact: world.artifact,
    source: world.source,
  };
}

/** Admits `principal` to the world's tenant and provisions the world, in `database`. */
export async function provisionTestWorld(
  fixture: DatabaseFixture,
  world: TestWorld,
  principal: string,
  database = "clockgrove",
): Promise<ProvisionedPartition> {
  const { tenantId, worldId, timelineId, partitionId: worldPartition } = world.birth.world;
  await truthOf(
    fixture,
    database,
  )(
    `INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('${tenantId}', 'test') ON CONFLICT DO NOTHING;
     INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${tenantId}', '${principal}') ON CONFLICT DO NOTHING`,
  );
  const request = provisioningRequest(world, principal, `case-${worldId}`);
  const { authorization } = request;
  await withClient(
    fixture.environment,
    (client) =>
      provisionWorld(request, {
        store: new PostgreSqlWorldProvisioningStore(client),
        genesis: world.genesis,
        decodeResource,
      }),
    database,
  );
  const spaceId = world.birth.spaces[0]!.spaceId;
  const partitionId = `${worldPartition}:${spaceId}`;
  return {
    world,
    authorization,
    partition: {
      authorization,
      target: {
        tenantId: authorization.tenantId,
        worldId: decodeOpaqueId(worldId, "WorldId"),
        timelineId: decodeOpaqueId(timelineId, "TimelineId"),
      },
      route: {
        partitionId: decodeOpaqueId(partitionId, "PartitionId"),
        spaceId: decodeOpaqueId(spaceId, "SpaceId"),
        streamId: decodeOpaqueId(`${partitionId}:stream`, "StreamId"),
      },
    },
    behavior: { behaviorFor: async () => world.behavior },
  };
}

/** A world command request under an allow decision, or a deny decision with `deny` as its reason. */
export function commandRequest(
  { authorization, partition }: ProvisionedPartition,
  command: CommandEnvelope<string, unknown>,
  options: { readonly bytes?: Uint8Array; readonly deny?: string } = {},
): WorldCommandRequest {
  const scope = {
    ...partition.target,
    commandId: command.commandId,
    attribution: command.attribution,
    inputs: {
      principalId: authorization.principalId,
      roles: [],
      grants: [],
      privacyCeiling: authorization.privacyCeiling,
    },
  };
  return {
    authorization,
    command,
    commandBytes: options.bytes ?? canonicalBytes(command),
    route: partition.route,
    authorityDecision:
      options.deny === undefined ? allowDecision(scope) : denyDecision(scope, options.deny),
  };
}

/** A client `world.advance` command; `expected` null sends no expected revision. */
export function advanceCommand(
  world: TestWorld,
  key: string,
  targetTime: bigint,
  expected: bigint | null,
  budget: Readonly<{ maxInputs: number; maxEvents: number }> = { maxInputs: 64, maxEvents: 256 },
): CommandEnvelope<string, unknown> {
  const { tenantId, worldId, timelineId } = world.birth.world;
  return {
    schemaVersion: 1,
    commandId: decodeOpaqueId(key, "CommandId"),
    type: "world.advance",
    target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
    expected: expected === null ? {} : { partitionRevision: expected },
    issuedAt: world.birth.clock.wallEpoch,
    context: { version: 1, correlationId: `correlation-${key}`, requestId: key },
    attribution: { effectiveActorId: "integration-test", causalRootActionId: `action-${key}` },
    payload: { schemaVersion: 1, targetTime, ...budget },
  } as unknown as CommandEnvelope<string, unknown>;
}

/** The pure model a Journal run must match: state, queue and random state after each kernel call. */
export interface KernelModel {
  state: WorldState;
  schedules: ScheduleQueue<WorldScheduledPayload>;
  random: string;
}

export function kernelModel(world: TestWorld): KernelModel {
  return {
    state: world.birth.state,
    schedules: createScheduleQueue(world.birth.schedules as ScheduleQueue<WorldScheduledPayload>),
    random: world.birth.randomState,
  };
}

/** One pure kernel call from the model, as the Journal makes it; the model advances. */
export function pureStep(
  world: TestWorld,
  model: KernelModel,
  command: CommandEnvelope<string, unknown>,
  origin: CommandEnvelope<string, unknown> = command,
  continuation?: WorldContinuation,
) {
  const outcome = executeWorldKernel({
    partition: {
      schemaVersion: 1,
      partitionId: model.state.partitionId,
      revision: model.state.revision,
      state: model.state,
    },
    input: { kind: "command", command: origin },
    simulationTime: model.state.simulationTime,
    attribution: decodeAttributionEnvelope({
      ...origin.attribution,
      authorityDecisionId: `authority:${origin.commandId}`,
    }),
    policies: {
      schemaVersion: 1,
      policyVersions: { routine: world.behavior.policy.version },
      policy: world.behavior.policy,
    },
    pack: {
      schemaVersion: 1,
      packId: world.behavior.packId,
      packVersion: world.behavior.packVersion,
      pack: world.behavior,
    },
    randomState: restoreNamedRandomState(model.random),
    ids: createDeterministicIdSource({
      commandId: origin.commandId,
      eventIndex: 0,
      randomStream: WORLD_COMMAND_ID_STREAM,
    }),
    schedules: model.schedules,
    ...(continuation === undefined ? {} : { continuation }),
  } as unknown as WorldKernelInput);
  if (!outcome.ok)
    throw new Error(
      `pure kernel refused ${command.commandId}: ${outcome.error.code} ${outcome.error.path}`,
    );
  model.state = outcome.result.state;
  model.schedules = outcome.result.schedules;
  model.random = serializeNamedRandomState(outcome.result.updatedRandomState);
  return outcome.result;
}

export const stateHash = (state: WorldState): Promise<string> => sha256Hex(canonicalBytes(state));

/** `receipts|decisions|events` of one command. */
export function commandCounts(
  truth: (sql: string) => Promise<string>,
  commandId: string,
): Promise<string> {
  return truth(
    `SELECT (SELECT count(*) FROM clockgrove.command_receipts WHERE command_id = '${commandId}') || '|' ||
            (SELECT count(*) FROM clockgrove.authority_decisions WHERE command_id = '${commandId}') || '|' ||
            (SELECT count(*) FROM clockgrove.events WHERE command_id = '${commandId}')`,
  );
}

/** A counting double around the pure kernel. */
export function countingKernel(): { kernel: WorldKernel; calls: () => number } {
  let calls = 0;
  return {
    kernel: (input) => {
      calls += 1;
      return executeWorldKernel(input);
    },
    calls: () => calls,
  };
}
