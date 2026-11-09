import type {
  GenesisBirth,
  ProvisionedWorld,
  RuntimeAuthorizationContext,
  WorldGenesisPort,
  WorldProvisioningPorts,
} from "@clockgrove/application";
import {
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  PackVersionConflictError,
  ProvisioningCaseConflictError,
  provisionWorld,
  reconstructSeedProjectionHash,
  WorldGenesisDefectError,
  WorldProvisioningRefusedError,
  worldProvisioningCommandId,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import {
  installAuthorization,
  type PostgreSqlClient,
  PostgreSqlJournal,
  PostgreSqlJournalRangeSource,
  PostgreSqlWorldProvisioningStore,
  type PostgreSqlWorldProvisioningTestHooks,
  type ProvisioningFaultPoint,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPECTED_SEED_PROJECTION_HASHES } from "../../../packages/simulator/test/fixtures/lamp-hall.js";
import {
  applyMigrations,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import type { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import {
  LocalRuntimeOwnerBindings,
  PostgreSqlCanonicalRuntimeStateSource,
  RuntimeWorker,
} from "../src/index.js";
import { authenticationFixture, authenticationRequest } from "./auth-fixture.js";
import {
  type DatabaseFixture,
  genesisPort,
  holdCluster,
  lampSource,
  packArtifact,
  packWorld,
  testWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

const BIRTH_TABLES = [
  "pack_artifacts",
  "pack_artifact_resources",
  "provisioning_cases",
  "pack_installations",
  "world_birth_states",
  "birth_state_sections",
  "birth_space_state",
  "birth_schedules",
  "birth_random_streams",
  "birth_cognitive_seed_refs",
];
const SNAPSHOT_TABLES = [
  "clockgrove.worlds",
  "clockgrove.timelines",
  "clockgrove.timeline_partitions",
  "clockgrove.streams",
  "clockgrove.events",
  "clockgrove.command_receipts",
  "clockgrove.authority_decisions",
  ...BIRTH_TABLES.map((table) => `clockgrove_birth.${table}`),
];
const VOLATILE_COLUMNS = [
  "recorded_at",
  "created_at",
  "updated_at",
  "committed_at",
  "decided_at",
  "installed_at",
  "stored_at",
  "journal_position",
  "event_bytes",
  "result",
  "attempts",
  "last_failure",
  "content",
];
// Every seed and projection boundary of a birth, each interrupted before and after its commit.
const FAULT_POINTS: readonly ProvisioningFaultPoint[] = [
  "genesis",
  "seed-command-0",
  "seed-command-1",
  "projection-verified",
  "ready",
];
const OTHER_TENANT = "tenant-other";
const PRINCIPAL = "principal-provisioner";

type Truth = (sql: string) => Promise<string>;

// One migrated cluster; every test provisions into its own database cloned from the migrated one.
let cluster: Awaited<ReturnType<typeof holdCluster>>;
let databases = 0;
beforeAll(async () => {
  cluster = await holdCluster((fixture: DatabaseFixture) =>
    applyMigrations(fixture.tools, fixture.environment),
  );
}, 60_000);
afterAll(() => cluster?.close());

/** A fresh migrated database with the given tenants admitting the provisioning principal. */
async function freshDatabase(tenants: readonly string[]) {
  const name = `provisioning_${++databases}`;
  await truthOf(cluster.fixture, "postgres")(`CREATE DATABASE ${name} TEMPLATE clockgrove`);
  const truth = truthOf(cluster.fixture, name);
  for (const tenant of tenants) {
    await truth(
      `INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('${tenant}', '${tenant}');
       INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${tenant}', '${PRINCIPAL}')`,
    );
  }
  return {
    truth,
    withClient: <T>(operation: (client: HyperdrivePostgreSqlClient) => Promise<T>) =>
      withClient(cluster.fixture.environment, operation, name),
  };
}

function authorization(tenantId: string): RuntimeAuthorizationContext {
  return {
    tenantId: decodeOpaqueId(tenantId, "TenantId"),
    principalId: decodeOpaqueId(PRINCIPAL, "PrincipalId"),
    privacyCeiling: decodePrivacyCeiling({ version: 1, allowedCategories: ["public_scene"] }),
  };
}

function portsOver(
  client: PostgreSqlClient,
  options: { hooks?: PostgreSqlWorldProvisioningTestHooks; genesis?: WorldGenesisPort } = {},
): WorldProvisioningPorts {
  return {
    store: new PostgreSqlWorldProvisioningStore(client, options.hooks),
    genesis: options.genesis ?? genesisPort(),
    decodeResource,
  };
}

/** The provisioning request of a pack under a case, in the pack's own tenant unless given another. */
function requestOf(
  pack: { artifact: GenesisBirth["artifact"]; source: unknown },
  caseId: string,
  tenantId: string,
) {
  return {
    authorization: authorization(tenantId),
    caseId,
    artifact: pack.artifact,
    source: pack.source,
  };
}

/** Every provisioning-owned row of a tenant, without volatile columns. */
async function snapshot(truth: Truth, tenantId: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const table of SNAPSHOT_TABLES) {
    // Events and receipts keep their documents minus the per-database recordedAt and journalPosition.
    const source =
      table === "clockgrove.events"
        ? `(SELECT e.*, convert_from(e.event_bytes, 'UTF8')::jsonb - 'recordedAt' - 'journalPosition' AS event_document FROM clockgrove.events e)`
        : table === "clockgrove.command_receipts"
          ? `(SELECT r.*, regexp_replace(r.result::text, '"(recordedAt|journalPosition)": "[^"]*",? ?', '', 'g') AS result_document FROM clockgrove.command_receipts r)`
          : table;
    result[table] = JSON.parse(
      await truth(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) - ARRAY[${VOLATILE_COLUMNS.map((c) => `'${c}'`).join(",")}] ORDER BY to_jsonb(t)::text), '[]'::jsonb)
           FROM ${source} t WHERE tenant_id = '${tenantId}'`,
      ),
    );
  }
  return result;
}

async function eventTypes(truth: Truth, tenantId: string): Promise<string[]> {
  const out = await truth(
    `SELECT event_type FROM clockgrove.events WHERE tenant_id = '${tenantId}' ORDER BY journal_position`,
  );
  return out === "" ? [] : out.split("\n");
}

const count = (truth: Truth, table: string, where = "true") =>
  truth(`SELECT count(*) FROM ${table} WHERE ${where}`);

async function caught(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to be refused");
}

/** Runs one statement as the runtime role for a tenant inside a transaction that is always rolled back. */
async function probe(
  client: PostgreSqlClient,
  tenantId: string,
  sql: string,
  values: readonly unknown[] = [],
) {
  await client.query("BEGIN");
  try {
    await installAuthorization(client, authorization(tenantId));
    return await client.query(sql, values);
  } catch (error) {
    return { state: (error as { code?: string }).code };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function reconstructStored(
  client: PostgreSqlClient,
  world: ProvisionedWorld,
): Promise<string> {
  const stored = await new PostgreSqlWorldProvisioningStore(client).readBirth({
    authorization: authorization(world.tenantId),
    worldId: world.worldId,
    timelineId: world.timelineId,
  });
  return reconstructSeedProjectionHash(stored.birth, stored.seedResources, decodeResource);
}

/** The journal command IDs of every birth stage, in the trusted namespace. */
function stageCommandIds(birth: GenesisBirth): string[] {
  return [
    birth.genesisCommandId,
    ...birth.seedCommands.map((seed) => seed.commandId),
    `${birth.genesisCommandId}:projection-verified`,
    `${birth.genesisCommandId}:world-ready`,
  ].map((stage) => worldProvisioningCommandId(stage));
}

function expectedEventTypes(birth: GenesisBirth): string[] {
  return [
    "WorldGenesisCreated",
    ...birth.seedCommands.map(() => "WorldSeedCommandApplied"),
    "WorldProjectionVerified",
    "WorldReady",
  ];
}

describe("world provisioning into PostgreSQL", () => {
  it("births shipped and fixture worlds idempotently, immutably and tenant-isolated", async () => {
    const packs = {
      residents: await testWorld("fixture/reference"),
      fixture: await testWorld("fixture"),
      lamp: await packWorld(await lampSource()),
    };
    const lamp = packs.lamp;
    const lampTenant = lamp.birth.world.tenantId;
    const { truth, withClient } = await freshDatabase([
      ...Object.values(packs).map((pack) => pack.birth.world.tenantId),
      OTHER_TENANT,
    ]);
    // Migrations alone leave every new table and worlds empty.
    for (const table of [
      ...BIRTH_TABLES.map((name) => `clockgrove_birth.${name}`),
      "clockgrove.worlds",
    ]) {
      expect(await count(truth, table)).toBe("0");
    }

    await withClient(async (client) => {
      let seeds = 0;
      const ports = portsOver(client, { genesis: genesisPort({ onSeed: () => (seeds += 1) }) });
      const worlds = new Map<string, ProvisionedWorld>();
      for (const [name, pack] of Object.entries(packs)) {
        const { birth } = pack;
        const tenantId = birth.world.tenantId;
        const world = await provisionWorld(requestOf(pack, `case-${name}`, tenantId), ports);
        worlds.set(name, world);

        // One ready world, one case, one installation.
        expect(world).toEqual({
          tenantId,
          caseId: `case-${name}`,
          worldId: birth.world.worldId,
          timelineId: birth.world.timelineId,
          installationId: `installation:case-${name}`,
          packId: pack.artifact.packId,
          packVersion: pack.artifact.version,
          contentHash: pack.artifact.contentHash,
          lifecycleStatus: "ready",
        });
        expect(
          await truth(
            `SELECT lifecycle_status FROM clockgrove.worlds WHERE tenant_id = '${tenantId}'`,
          ),
        ).toBe("ready");
        expect(
          await count(
            truth,
            "clockgrove_birth.provisioning_cases",
            `tenant_id = '${tenantId}' AND status = 'ready'`,
          ),
        ).toBe("1");
        expect(
          await count(truth, "clockgrove_birth.pack_installations", `tenant_id = '${tenantId}'`),
        ).toBe("1");

        // Canonical events, readable through the range reader, and one receipt per stage command.
        expect(await eventTypes(truth, tenantId)).toEqual(expectedEventTypes(birth));
        const partitionId = await truth(
          `SELECT DISTINCT partition_id FROM clockgrove.events WHERE tenant_id = '${tenantId}'`,
        );
        const birthEvents = await new JournalRangeReader(
          new PostgreSqlJournalRangeSource(client, authorization(tenantId)),
          JOURNAL_EVENT_REGISTRY,
        ).readPartition({
          tenantId: decodeOpaqueId(tenantId, "TenantId"),
          timelineId: decodeOpaqueId(birth.world.timelineId, "TimelineId"),
          partitionId: decodeOpaqueId(partitionId, "PartitionId"),
        });
        expect(birthEvents.map((event) => event.type)).toEqual(expectedEventTypes(birth));
        expect(
          await truth(
            `SELECT command_id FROM clockgrove.command_receipts WHERE tenant_id = '${tenantId}' ORDER BY command_id`,
          ),
        ).toBe(stageCommandIds(birth).sort().join("\n"));
        // Every stage is its own command with its own allow decision, minted from its command ID,
        // referenced by its attributed receipt and sealed by its event.
        const stages = birth.seedCommands.length + 3;
        expect(
          await truth(
            `SELECT count(*) FILTER (WHERE receipt.provenance = 'attributed'
                      AND receipt.authority_decision_id = 'authority:' || receipt.command_id
                      AND decision.outcome = 'allow'
                      AND event.attribution->>'authorityDecisionId' = decision.authority_decision_id)
                    || '/' || count(*) || '/' || count(DISTINCT decision.authority_decision_id)
               FROM clockgrove.command_receipts AS receipt
               JOIN clockgrove.authority_decisions AS decision USING (tenant_id, command_id)
               JOIN clockgrove.events AS event USING (tenant_id, command_id)
              WHERE receipt.tenant_id = '${tenantId}'`,
          ),
        ).toBe(`${stages}/${stages}/${stages}`);

        // Reconstruction reads only stored rows and equals the pack's expected hash.
        expect(await reconstructStored(client, world)).toBe(birth.expectedSeedProjectionHash);
        // One partition per declared space, seeds only as references into the artifact.
        expect(
          await count(truth, "clockgrove.timeline_partitions", `tenant_id = '${tenantId}'`),
        ).toBe(String(birth.spaces.length));
        expect(
          await truth(
            `SELECT string_agg(seed_id || '@' || seed_version || ':' || sha256, ',' ORDER BY ordinal)
               FROM clockgrove_birth.birth_cognitive_seed_refs WHERE tenant_id = '${tenantId}'`,
          ),
        ).toBe(
          birth.cognitiveSeeds.map((seed) => `${seed.id}@${seed.version}:${seed.sha256}`).join(","),
        );
      }
      expect(seeds).toBe(3);

      const lampWorld = worlds.get("lamp")!;
      const uninterrupted = await snapshot(truth, lampTenant);
      // The same case with the same request is a no-op returning the same world.
      expect(await provisionWorld(requestOf(lamp, "case-lamp", lampTenant), ports)).toEqual(
        lampWorld,
      );
      expect(seeds).toBe(3);
      // A reused case identity with a different request is a typed conflict that changes nothing.
      const conflicting = { ...lamp, artifact: { ...lamp.artifact, contentHash: "f".repeat(64) } };
      expect(
        await caught(provisionWorld(requestOf(conflicting, "case-lamp", lampTenant), ports)),
      ).toBeInstanceOf(ProvisioningCaseConflictError);
      expect(await snapshot(truth, lampTenant)).toEqual(uninterrupted);

      // The same pack id and version with different content under a new case is a typed conflict:
      // only the failed case is recorded.
      const altered = await packArtifact(await lampSource("1.0.0", "0".repeat(64)));
      expect(altered.artifact.contentHash).not.toBe(lamp.artifact.contentHash);
      const conflict = await caught(
        provisionWorld(requestOf(altered, "case-lamp-altered", lampTenant), ports),
      );
      expect(conflict).toBeInstanceOf(PackVersionConflictError);
      expect(conflict).toMatchObject({
        code: "PACK_VERSION_CONFLICT",
        path: "artifact.contentHash",
      });
      const { "clockgrove_birth.provisioning_cases": cases, ...rest } = await snapshot(
        truth,
        lampTenant,
      );
      const { "clockgrove_birth.provisioning_cases": _cases, ...uninterruptedRest } = uninterrupted;
      expect(rest).toEqual(uninterruptedRest);
      expect(
        (cases as { case_id: string; status: string }[])
          .map((row) => `${row.case_id}:${row.status}`)
          .sort(),
      ).toEqual(["case-lamp-altered:failed", "case-lamp:ready"]);

      // A changed pack under a new case gets its own installation and world; the old ones stay identical.
      const before = await snapshot(truth, lampTenant);
      const lampNext = await packWorld(await lampSource("1.1.0"));
      await truth(
        `INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('${lampNext.birth.world.tenantId}', 'next');
         INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${lampNext.birth.world.tenantId}', '${PRINCIPAL}')`,
      );
      const next = await provisionWorld(
        requestOf(lampNext, "case-lamp-next", lampNext.birth.world.tenantId),
        ports,
      );
      expect(next).toMatchObject({
        installationId: "installation:case-lamp-next",
        worldId: lampNext.birth.world.worldId,
        lifecycleStatus: "ready",
      });
      expect(next.worldId).not.toBe(lampWorld.worldId);
      expect(await reconstructStored(client, next)).toBe(EXPECTED_SEED_PROJECTION_HASHES["1.1.0"]);
      expect(await snapshot(truth, lampTenant)).toEqual(before);

      // Artifact, installation and birth rows cannot be changed, even by the owner role, and the
      // runtime role cannot even try.
      for (const statement of [
        `UPDATE clockgrove_birth.pack_artifacts SET build_tool_version = 'x' WHERE tenant_id = '${lampTenant}'`,
        `DELETE FROM clockgrove_birth.pack_artifacts WHERE tenant_id = '${lampTenant}'`,
        `TRUNCATE clockgrove_birth.pack_artifacts CASCADE`,
        `UPDATE clockgrove_birth.pack_installations SET status = 'installed' WHERE tenant_id = '${lampTenant}'`,
        `DELETE FROM clockgrove_birth.pack_installations WHERE tenant_id = '${lampTenant}'`,
        `TRUNCATE clockgrove_birth.pack_installations CASCADE`,
        `UPDATE clockgrove_birth.world_birth_states SET birth_version = 2 WHERE tenant_id = '${lampTenant}'`,
      ]) {
        await expect(truth(statement)).rejects.toThrow(/rows are immutable/u);
      }
      for (const table of ["pack_artifacts", "pack_installations"]) {
        expect(
          await probe(
            client,
            lampTenant,
            `UPDATE clockgrove_birth.${table} SET tenant_id = tenant_id`,
          ),
        ).toEqual({ state: "42501" });
      }

      // PostgreSQL rejects out-of-set values (23514) and cross-scope references (23503): a birth row
      // naming another tenant's timeline, a space row naming an undeclared partition.
      const { worldId, timelineId } = lampWorld;
      const { packId, version, contentHash } = lamp.artifact;
      for (const [tenant, sql, values, state] of [
        [
          lampTenant,
          `UPDATE clockgrove.worlds SET lifecycle_status = 'bogus' WHERE world_id = $1`,
          [worldId],
          "23514",
        ],
        [
          lampTenant,
          `UPDATE clockgrove.timelines SET kind = 'bogus' WHERE world_id = $1`,
          [worldId],
          "23514",
        ],
        [
          lampTenant,
          `UPDATE clockgrove.timelines SET state = 'bogus' WHERE world_id = $1`,
          [worldId],
          "23514",
        ],
        [
          lampTenant,
          `INSERT INTO clockgrove_birth.provisioning_cases (tenant_id, case_id, request_hash, pack_id, pack_version, content_hash, status)
           VALUES ($1, 'case-bogus', $2, 'p', '1', $2, 'bogus')`,
          [lampTenant, "a".repeat(64)],
          "23514",
        ],
        [
          lampTenant,
          `INSERT INTO clockgrove_birth.pack_installations (tenant_id, installation_id, case_id, world_id, pack_id, pack_version, content_hash, status)
           VALUES ($1, 'installation:bogus', 'case-lamp', $2, $3, $4, $5, 'bogus')`,
          [lampTenant, worldId, packId, version, contentHash],
          "23514",
        ],
        [
          OTHER_TENANT,
          `INSERT INTO clockgrove_birth.birth_schedules (tenant_id, world_id, timeline_id, birth_version, ordinal, node)
           VALUES ($1, $2, $3, 1, 99, '["null"]'::jsonb)`,
          [OTHER_TENANT, worldId, timelineId],
          "23503",
        ],
        [
          lampTenant,
          `INSERT INTO clockgrove_birth.birth_space_state (tenant_id, world_id, timeline_id, birth_version, partition_id, space_id,
             element_kind, element_key, ordinal, node)
           VALUES ($1, $2, $3, 1, 'no-such-partition', 'no-such-space', 'entity', 'ghost', 99, '["null"]'::jsonb)`,
          [lampTenant, worldId, timelineId],
          "23503",
        ],
      ] as const) {
        expect(await probe(client, tenant, sql, values)).toEqual({ state });
      }

      // Every new table carries tenant_id with forced RLS, and another tenant sees none of the rows.
      expect(
        await truth(
          `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'clockgrove_birth' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')`,
        ),
      ).toBe(String(BIRTH_TABLES.length));
      for (const table of BIRTH_TABLES) {
        expect(
          await probe(
            client,
            OTHER_TENANT,
            `SELECT count(*)::text AS n FROM clockgrove_birth.${table}`,
          ),
        ).toEqual({ rows: [{ n: "0" }] });
      }
      expect(
        await probe(
          client,
          lampTenant,
          `SELECT count(*)::text AS n FROM clockgrove_birth.world_birth_states`,
        ),
      ).toEqual({
        rows: [{ n: "1" }],
      });
    });
  }, 240_000);

  it("refuses runtime commands that name trusted provisioning IDs before recording anything, and the birth still succeeds", async () => {
    const lamp = await packWorld(await lampSource());
    const tenantId = lamp.birth.world.tenantId;
    const { truth, withClient } = await freshDatabase([tenantId]);
    // A tenant member without world participation, and an existing world of the tenant, so an
    // authorization denial in that scope would otherwise be recorded.
    const auth = authenticationFixture();
    auth.removeWorkspace();
    auth.removeWorld();
    await truth(`INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${tenantId}', 'principal-runtime');
      INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('${tenantId}', 'world-existing', 'ready');
      INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('${tenantId}', 'world-existing', 'timeline-existing');`);
    const scope = {
      tenantId,
      worldId: "world-existing",
      timelineId: "timeline-existing",
      spaceId: "space-existing",
    };
    await withClient(async (client) => {
      const worker = new RuntimeWorker(
        auth.authenticator,
        new LocalRuntimeOwnerBindings(
          new PostgreSqlCanonicalRuntimeStateSource(client),
          new PostgreSqlJournal(client),
        ),
      );
      const stages = stageCommandIds(lamp.birth);
      for (const overrides of [
        ...stages.map((commandId) => ({ commandId })),
        { commandId: "command-client", eventId: `${stages[0]}:event` },
      ]) {
        expect((await worker.fetch(authenticationRequest({ ...scope, ...overrides }))).status).toBe(
          403,
        );
      }
      expect(await count(truth, "clockgrove.command_receipts", `tenant_id = '${tenantId}'`)).toBe(
        "0",
      );
      expect(
        await count(truth, "clockgrove.authority_decisions", `tenant_id = '${tenantId}'`),
      ).toBe("0");
      // Control: the same refusal under a client command ID is recorded.
      expect(
        (await worker.fetch(authenticationRequest({ ...scope, commandId: "command-client" })))
          .status,
      ).toBe(403);
      expect(
        await truth(
          `SELECT string_agg(command_id || ':' || status, ',') FROM clockgrove.command_receipts WHERE tenant_id = '${tenantId}'`,
        ),
      ).toBe("command-client:rejected");

      expect(
        (await provisionWorld(requestOf(lamp, "case-lamp", tenantId), portsOver(client)))
          .lifecycleStatus,
      ).toBe("ready");
      expect(
        await count(
          truth,
          "clockgrove.command_receipts",
          `tenant_id = '${tenantId}' AND status = 'committed'`,
        ),
      ).toBe(String(stages.length));
    });
  }, 120_000);

  it("keeps genesis outside transactions and retries a defect to the same ready world", async () => {
    const lamp = await packWorld(await lampSource());
    const tenantId = lamp.birth.world.tenantId;
    const { truth, withClient } = await freshDatabase([tenantId]);
    await withClient(async (inner) => {
      let open = false;
      const states: boolean[] = [];
      const client: PostgreSqlClient = {
        async query(text, values) {
          const result = await inner.query(text, values);
          if (text.trim() === "BEGIN") open = true;
          if (text.trim() === "COMMIT" || text.trim() === "ROLLBACK") open = false;
          return result;
        },
      };
      const ports = portsOver(client, {
        genesis: genesisPort({ onSeed: () => states.push(open), defects: 1 }),
      });
      // A defect records attempt evidence on the case and leaves no ready world.
      expect(
        await caught(provisionWorld(requestOf(lamp, "case-lamp", tenantId), ports)),
      ).toBeInstanceOf(WorldGenesisDefectError);
      expect(
        await truth(
          `SELECT status || '|' || attempts || '|' || (last_failure->>'code') FROM clockgrove_birth.provisioning_cases WHERE tenant_id = '${tenantId}'`,
        ),
      ).toBe("requested|1|WorldGenesisDefectError");
      expect(await count(truth, "clockgrove.worlds", `tenant_id = '${tenantId}'`)).toBe("0");

      expect(
        (await provisionWorld(requestOf(lamp, "case-lamp", tenantId), ports)).lifecycleStatus,
      ).toBe("ready");
      // Genesis seeding ran with no transaction open, on both attempts.
      expect(states).toEqual([false, false]);
      expect(
        await truth(
          `SELECT status || '|' || attempts FROM clockgrove_birth.provisioning_cases WHERE tenant_id = '${tenantId}'`,
        ),
      ).toBe("ready|2");
      expect(await eventTypes(truth, tenantId)).toEqual(expectedEventTypes(lamp.birth));
    });
  }, 120_000);

  it("refuses an artifact that differs from the built source and a foreign tenant, leaving the world non-ready", async () => {
    const lamp = await packWorld(await lampSource());
    const tenantId = lamp.birth.world.tenantId;
    const { truth, withClient } = await freshDatabase([tenantId, OTHER_TENANT]);
    await withClient(async (client) => {
      const tampered = { ...lamp, artifact: { ...lamp.artifact, contentHash: "f".repeat(64) } };
      const mismatch = await caught(
        provisionWorld(requestOf(tampered, "case-tampered", tenantId), portsOver(client)),
      );
      expect(mismatch).toBeInstanceOf(WorldProvisioningRefusedError);
      expect(mismatch).toMatchObject({ code: "ARTIFACT_MISMATCH", path: "artifact.contentHash" });
      expect(
        await truth(
          `SELECT status || '|' || attempts || '|' || (failure->>'code') FROM clockgrove_birth.provisioning_cases WHERE case_id = 'case-tampered'`,
        ),
      ).toBe("failed|1|ARTIFACT_MISMATCH");
      expect(
        await caught(
          provisionWorld(requestOf(lamp, "case-foreign", OTHER_TENANT), portsOver(client)),
        ),
      ).toMatchObject({
        code: "TENANT_MISMATCH",
        path: "authorization.tenantId",
      });
      expect(await count(truth, "clockgrove.worlds")).toBe("0");
      expect(await count(truth, "clockgrove_birth.provisioning_cases", "status = 'failed'")).toBe(
        "2",
      );
    });
  }, 120_000);

  it("converges on the uninterrupted world after interruption before and after every boundary commit", async () => {
    const lamp = await packWorld(await lampSource());
    const tenantId = lamp.birth.world.tenantId;
    const request = requestOf(lamp, "case-lamp", tenantId);
    const reference = await freshDatabase([tenantId]);
    await reference.withClient((client) => provisionWorld(request, portsOver(client)));
    const uninterrupted = await snapshot(reference.truth, tenantId);
    for (const point of FAULT_POINTS) {
      const { truth, withClient } = await freshDatabase([tenantId]);
      await withClient(async (client) => {
        for (const when of ["before-commit", "after-commit"] as const) {
          const interrupted = await caught(
            provisionWorld(request, portsOver(client, { hooks: { fault: { point, when } } })),
          );
          expect(interrupted).toMatchObject({
            name: "ProvisioningFaultInjectedError",
            point,
            when,
          });
        }
        const world = await provisionWorld(request, portsOver(client));
        expect(world.lifecycleStatus).toBe("ready");
        expect(await reconstructStored(client, world)).toBe(
          EXPECTED_SEED_PROJECTION_HASHES["1.0.0"],
        );
      });
      expect(await eventTypes(truth, tenantId)).toEqual(expectedEventTypes(lamp.birth));
      expect(await snapshot(truth, tenantId)).toEqual(uninterrupted);
    }
  }, 240_000);
});
