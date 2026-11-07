import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeOpaqueId } from "@clockgrove/contracts";
import { PostgreSqlPersistenceTransactionPort } from "@clockgrove/persistence";
import { describe, expect, it } from "vitest";
// biome-ignore format: @ts-expect-error covers only the next line, so the import stays on one line.
// @ts-expect-error -- repository-local JavaScript helper has no declaration file.
import { applyMigrations, psql, psqlQuery, withDisposableDatabase } from "../../../scripts/database/lib.mjs";
import { withHyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import { connectionString, type DatabaseFixture } from "./world-fixture.js";

const WAVE0_MIGRATIONS = [
  "0001_wave0_journal.sql",
  "0002_authentication_authority.sql",
  "0003_tenant_scoped_event_ids.sql",
  "0004_world_birth.sql",
  "0005_world_ready_authority.sql",
];

const TARGET = {
  version: 1,
  tenantId: "tenant-legacy",
  worldId: "world-legacy",
  timelineId: "timeline-legacy",
  kind: "space",
  id: "space-legacy",
};
const ROUTE = {
  partitionId: "partition-legacy",
  spaceId: "space-legacy",
  streamId: "stream-legacy",
};

/** A command as Wave 0 and world birth committed it, before attributed receipts existed. */
function legacyCommand(
  commandId: string,
  type: string,
  dispatch: boolean,
  expected: Record<string, unknown>,
) {
  const attribution = {
    effectiveActorId: "space-legacy",
    causalRootActionId: `action-${commandId}`,
  };
  const envelope = {
    schemaVersion: 2,
    commandId,
    type,
    target: TARGET,
    expected,
    issuedAt: "2026-10-01T00:00:00.000Z",
    context: { version: 1, correlationId: `correlation-${commandId}`, requestId: commandId },
    attribution,
    payload: {},
  };
  const eventId = `${commandId}:event`;
  const request = {
    commandId,
    target: TARGET,
    expected,
    route: ROUTE,
    events: [
      {
        schemaVersion: 2,
        eventId,
        type,
        ...ROUTE,
        simulationTime: "0",
        correlationId: `correlation-${commandId}`,
        attribution: { ...attribution, authorityDecisionId: "legacy-shared-authority" },
        policyVersions: {},
        privacyClass: "public_scene",
        payloadHash: `sha256:${commandId}`,
        payload: {},
      },
    ],
    dispatches: dispatch
      ? [
          {
            dispatchId: `dispatch-${commandId}`,
            eventId,
            channel: "world-reactions",
            privacyClass: "public_scene",
            payload: { eventId },
          },
        ]
      : [],
    stableResult: { commandId },
    projectionDelta: null,
  };
  return { commandId, bytes: JSON.stringify(envelope), request, attribution };
}

describe("attributed receipt migration over committed Wave 0 history", () => {
  it("keeps legacy receipts, events and dispatches readable and unchanged and retries them exactly", async () => {
    await withDisposableDatabase(async ({ tools, environment }: DatabaseFixture) => {
      const directory = await mkdtemp(path.join(tmpdir(), "clockgrove-wave0-"));
      try {
        for (const name of WAVE0_MIGRATIONS) {
          await copyFile(
            new URL(`../../../db/migrations/${name}`, import.meta.url),
            path.join(directory, name),
          );
        }
        await applyMigrations(tools, environment, { migrationDirectory: directory });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      await psql(tools, environment, seedSql);

      const runtime = { ...environment, PGUSER: "clockgrove_runtime" };
      const execute = async (command: ReturnType<typeof legacyCommand>, request: unknown) =>
        (
          await psqlQuery(
            tools,
            runtime,
            `BEGIN;
             SELECT set_config('app.tenant_id', 'tenant-legacy', true);
             SELECT set_config('app.principal_id', 'principal-legacy', true);
             SELECT set_config('app.privacy_ceiling', '{"version":1,"allowedCategories":["public_scene"]}', true);
             SELECT 'result:' || clockgrove.execute_journal(convert_to(${literal(command.bytes)}, 'UTF8'), ${literal(JSON.stringify(request))}::jsonb)::text;
             COMMIT;`,
          )
        )
          .split("\n")
          .find((line: string) => line.startsWith("result:"))
          ?.slice("result:".length);

      // Wave 0 history: a runtime no-op with dispatch intent and a world-birth stage without.
      const noOp = legacyCommand("legacy-no-op", "RuntimeNoOpAccepted", true, {
        partitionRevision: "0",
        routingEpoch: 7,
      });
      const genesis = legacyCommand("legacy-genesis", "WorldGenesisCreated", false, {});
      for (const command of [noOp, genesis])
        expect(await execute(command, command.request)).toBeDefined();
      const history = () =>
        psqlQuery(
          tools,
          environment,
          `SELECT jsonb_build_object(
             'receipts', (SELECT jsonb_agg(jsonb_build_array(command_id, status, result::text, encode(command_bytes, 'hex'), request_hash) ORDER BY command_id) FROM clockgrove.command_receipts),
             'events', (SELECT jsonb_agg(jsonb_build_array(event_id, encode(event_bytes, 'hex'), attribution) ORDER BY event_id) FROM clockgrove.events),
             'dispatches', (SELECT jsonb_agg(jsonb_build_array(dispatch_id, event_id, status) ORDER BY dispatch_id) FROM clockgrove.event_dispatches))::text`,
        );
      const before = JSON.parse(await history());
      expect(before.receipts).toHaveLength(2);
      expect(before.dispatches).toHaveLength(1);

      // The attributed-receipt migration applies over that history.
      await applyMigrations(tools, environment);
      expect(JSON.parse(await history())).toEqual(before);
      expect(
        (
          await psqlQuery(
            tools,
            environment,
            "SELECT string_agg(command_id || ':' || provenance, ',' ORDER BY command_id) FROM clockgrove.command_receipts",
          )
        ).trim(),
      ).toBe("legacy-genesis:legacy-wave0,legacy-no-op:legacy-wave0");

      // Legacy receipts decode through the application's receipt port as legacy-wave0.
      const receipts = await withHyperdrivePostgreSqlClient(
        connectionString(environment),
        (client) =>
          new PostgreSqlPersistenceTransactionPort(client).withAuthorization(
            {
              tenantId: decodeOpaqueId("tenant-legacy", "TenantId"),
              principalId: decodeOpaqueId("principal-legacy", "PrincipalId"),
              privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
            },
            async (transaction) => [
              await transaction.getCommandReceipt(decodeOpaqueId("legacy-no-op", "CommandId")),
              await transaction.getCommandReceipt(decodeOpaqueId("legacy-genesis", "CommandId")),
            ],
          ),
      );
      expect(receipts[0]).toMatchObject({
        provenance: "legacy-wave0",
        status: "committed",
        correlationId: "correlation-legacy-no-op",
        expected: { partitionRevision: 0n, routingEpoch: 7 },
        committedEventIds: ["legacy-no-op:event"],
        result: JSON.parse(before.receipts[1][2]),
      });
      expect(receipts[1]).toMatchObject({
        provenance: "legacy-wave0",
        status: "committed",
        expected: {},
      });
      for (const key of ["attribution", "actionId", "authorityDecisionId"]) {
        for (const receipt of receipts) expect(receipt).not.toHaveProperty(key);
      }

      // An exact retry of a legacy command, now carrying an allow decision, returns exactly the
      // stored result and records no decision.
      for (const [index, command] of [genesis, noOp].entries()) {
        const retried = await execute(command, {
          ...command.request,
          attribution: command.attribution,
          correlationId: `correlation-${command.commandId}`,
          authorityDecision: {
            version: 1,
            authorityDecisionId: `authority:${command.commandId}`,
            outcome: "allow",
            tenantId: "tenant-legacy",
            worldId: "world-legacy",
            timelineId: "timeline-legacy",
            commandId: command.commandId,
            actionId: command.attribution.causalRootActionId,
            attribution: command.attribution,
            inputs: {
              roles: [],
              grants: [],
              privacyCeiling: { version: 1, allowedCategories: [] },
            },
          },
          events: command.request.events.map((event) => ({
            ...event,
            attribution: {
              ...event.attribution,
              authorityDecisionId: `authority:${command.commandId}`,
            },
          })),
        });
        expect(retried).toBe(before.receipts[index][2]);
      }
      expect(JSON.parse(await history())).toEqual(before);
      expect(
        (
          await psqlQuery(tools, environment, "SELECT count(*) FROM clockgrove.authority_decisions")
        ).trim(),
      ).toBe("0");
    });
  }, 60_000);
});

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const seedSql = `
INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('tenant-legacy', 'Legacy');
INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('tenant-legacy', 'principal-legacy');
INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('tenant-legacy', 'world-legacy', 'ready');
INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('tenant-legacy', 'world-legacy', 'timeline-legacy');
INSERT INTO clockgrove.timeline_partitions (tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch)
VALUES ('tenant-legacy', 'world-legacy', 'timeline-legacy', 'partition-legacy', 'space-legacy', 7);
INSERT INTO clockgrove.streams (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
VALUES ('tenant-legacy', 'world-legacy', 'timeline-legacy', 'partition-legacy', 'space-legacy', 'stream-legacy');`;
