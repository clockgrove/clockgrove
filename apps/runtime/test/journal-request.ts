import type { JournalExecuteRequest } from "@clockgrove/application";
import type { PostgreSqlJournal } from "@clockgrove/persistence";
import {
  applyMigrations,
  applySqlFile,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import type { HyperdrivePostgreSqlClient } from "../src/hyperdrive-postgres.js";
import { connect, type DatabaseFixture, holdCluster, truthOf } from "./world-fixture.js";

// Journal requests over the two tenants of tests/database/journal-fixture.sql. Each request commits
// one event and one `world-reactions` dispatch, `dispatch-<name>-j-<side>`, of the given privacy class.

export type Category =
  | "public_scene"
  | "private_cognition"
  | "conversation"
  | "credential"
  | "operator_evidence";
export type Side = "a" | "b";

export function authorization(side: Side, ceiling: Category[]): TestRequest["authorization"] {
  return {
    tenantId: `tenant-j-${side}`,
    principalId: `principal-j-${side}`,
    privacyCeiling: { version: 1, allowedCategories: ceiling },
  };
}

export function journalRequest(
  side: Side,
  name: string,
  privacyClass: Category,
  ceiling: Category[],
  options: { bytes?: string; eventId?: string; payload?: unknown } = {},
): TestRequest {
  const suffix = `j-${side}`;
  const commandId = `command-${name}`;
  const eventId = options.eventId ?? `event-${name}-${suffix}`;
  const route = {
    partitionId: `partition-${suffix}`,
    spaceId: `space-${suffix}`,
    streamId: `stream-${suffix}`,
  };
  return {
    authorization: authorization(side, ceiling),
    command: {
      schemaVersion: 2,
      commandId,
      type: "JournalIsolationFixture",
      target: {
        version: 1,
        tenantId: `tenant-j-${side}`,
        worldId: `world-${suffix}`,
        timelineId: `timeline-${suffix}`,
        kind: "world",
        id: `world-${suffix}`,
      },
      expected: {},
      issuedAt: "2026-10-01T00:00:00.000Z",
      context: { version: 1, correlationId: `correlation-${name}`, requestId: `request-${name}` },
      attribution: { effectiveActorId: `world-${suffix}`, causalRootActionId: `action-${name}` },
      payload: {},
    },
    commandBytes: new TextEncoder().encode(options.bytes ?? `${name}-bytes`),
    route,
    authorityDecision: {
      version: 1,
      authorityDecisionId: `authority-${name}`,
      outcome: "allow",
      tenantId: `tenant-j-${side}`,
      worldId: `world-${suffix}`,
      timelineId: `timeline-${suffix}`,
      commandId,
      actionId: `action-${name}`,
      attribution: { effectiveActorId: `world-${suffix}`, causalRootActionId: `action-${name}` },
      inputs: { roles: [], grants: [], privacyCeiling: { version: 1, allowedCategories: ceiling } },
    },
    events: [
      {
        schemaVersion: 2,
        eventId,
        type: "JournalIsolationRecorded",
        ...route,
        simulationTime: "42",
        correlationId: `correlation-${name}`,
        attribution: {
          effectiveActorId: `world-${suffix}`,
          causalRootActionId: `action-${name}`,
          authorityDecisionId: `authority-${name}`,
        },
        policyVersions: { fixture: "1" },
        privacyClass,
        payloadHash: `sha256:${name}`,
        payload: options.payload ?? { name },
      },
    ],
    dispatches: [
      {
        dispatchId: `dispatch-${name}-${suffix}`,
        eventId,
        channel: "world-reactions",
        privacyClass,
        payload: { eventId },
      },
    ],
    stableResult: { accepted: name },
    projectionDelta: null,
  };
}

export interface TestRequest {
  authorization: {
    tenantId: string;
    principalId: string;
    privacyCeiling: { version: 1; allowedCategories: Category[] };
  };
  command: { commandId: string; target: Record<string, unknown> } & Record<string, unknown>;
  commandBytes: Uint8Array;
  route: { partitionId: string; spaceId: string; streamId: string };
  authorityDecision: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  stableResult: unknown;
  projectionDelta: unknown;
}

export function run(journal: PostgreSqlJournal, request: TestRequest) {
  return journal.execute(request as unknown as JournalExecuteRequest);
}

/** `truth` runs SQL as the admin; `clients` are runtime-role connections; `close` removes it all. */
export interface JournalDatabase {
  readonly truth: (sql: string) => Promise<string>;
  readonly clients: readonly HyperdrivePostgreSqlClient[];
  readonly close: () => Promise<void>;
}

/** A disposable migrated database with the journal fixture, held open across tests until `close`. */
export async function openJournalDatabase(connections: number): Promise<JournalDatabase> {
  const cluster = await holdCluster(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
  });
  const clients = Array.from({ length: connections }, () => connect(cluster.fixture.environment));
  return {
    truth: truthOf(cluster.fixture),
    clients,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
      await cluster.close();
    },
  };
}
