import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  PostgreSqlManagementReaders,
  PostgreSqlWorldAuthorizationReader,
} from "@clockgrove/persistence";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- shared repository-local catalog query has no declarations.
import { databaseIsolationQuery } from "../../../scripts/database/isolation.mjs";
import {
  applyMigrations,
  psql,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { composeReferenceAuthentication } from "../src/better-auth-adapter.js";
import {
  composeRuntime,
  injectRuntimeComposition,
  type RuntimeEnvironment,
} from "../src/cloudflare-entry.js";
import {
  HyperdrivePostgreSqlClient,
  withHyperdrivePostgreSqlClient,
} from "../src/hyperdrive-postgres.js";
import { LocalRuntimeOwnerBindings, RuntimeWorker } from "../src/index.js";
import { TrustedRuntimeRequestAuthenticator } from "../src/trusted-composition.js";
import { authenticationRequest } from "./auth-fixture.js";
import { connectionString } from "./world-fixture.js";

interface DatabaseFixture {
  readonly tools: { readonly psql: string };
  readonly environment: Readonly<Record<string, string>>;
}

describe("Hyperdrive PostgreSQL adapter", () => {
  it("composes fresh stored-session authentication and durable authority over isolated PostgreSQL", async () => {
    await withDisposableDatabase(async ({ tools, environment }: DatabaseFixture) => {
      await applyMigrations(tools, environment);
      const connection = (role: string) => connectionString(environment, "clockgrove", role);
      const isolation = () =>
        withHyperdrivePostgreSqlClient(connection("clockgrove_admin"), async (client) => {
          await client.query("SET ROLE clockgrove_migrator");
          return (await client.query(databaseIsolationQuery)).rows[0] as Record<string, unknown>;
        });
      expect(Object.values(await isolation()).every((value) => value === true)).toBe(true);
      // Negative control: a reader that inherits the runtime role is reported.
      await psql(tools, environment, "GRANT clockgrove_runtime TO clockgrove_world_reader");
      expect(await isolation()).toMatchObject({
        readers_scoped_select: false,
        readers_cannot_write: false,
      });
      await psql(tools, environment, "REVOKE clockgrove_runtime FROM clockgrove_world_reader");
      await psql(tools, environment, seedSql);
      await psql(
        tools,
        environment,
        await readFile(
          new URL("../../../db/fixtures/authentication-readers.sql", import.meta.url),
          "utf8",
        ),
      );
      injectRuntimeComposition(undefined);
      const fixtureSecret = "local-reader-verification".repeat(2);
      const fixtureCredential = ["local", "reader", "session"].join("-");
      const env = {
        HYPERDRIVE: { connectionString: connection("clockgrove_runtime") },
        AUTH_DATABASE_URL: connection("clockgrove_auth_verifier"),
        MANAGEMENT_DATABASE_URL: connection("clockgrove_management_reader"),
        WORLD_AUTHORIZATION_DATABASE_URL: connection("clockgrove_world_reader"),
        BETTER_AUTH_SECRET: fixtureSecret,
        AUTH_ORIGIN: "https://auth.example.test",
        PROVIDER_ENVIRONMENT: "local",
      } as RuntimeEnvironment;
      const dependencies = composeRuntime(env);
      const authenticator = new TrustedRuntimeRequestAuthenticator(dependencies.authentication);
      const worker = new RuntimeWorker(
        authenticator,
        new LocalRuntimeOwnerBindings(dependencies.canonical, dependencies.journal),
      );
      for (const [consumer, channel] of [
        [dependencies.consumers.worldReactions, "world-reactions"],
        [dependencies.consumers.cognitiveIndexing, "cognitive-indexing"],
        [dependencies.consumers.externalEffects, "external-effects"],
      ] as const)
        await expect(
          consumer.consume(
            {
              schemaVersion: 2,
              messageId: "later-wave",
              channel,
              tenantId: "tenant-runtime",
              correlationId: "correlation-runtime",
              attemptHint: 1,
              payload: {},
            },
            (value) => value,
          ),
        ).rejects.toMatchObject(
          channel === "world-reactions"
            ? { name: "QueueMessageRefusedError", code: "inconsistent" }
            : { message: "runtime queue effect is unavailable in Wave 0" },
        );
      const request = (overrides = {}) => {
        const input = authenticationRequest(overrides);
        input.headers.set("authorization", `Bearer ${fixtureCredential}`);
        input.headers.set("x-correlation-id", "correlation-runtime");
        return input;
      };
      const authority = await authenticator.authenticate(request());
      expect(authority.principalId).toBe("principal-runtime");
      expect(authority.workspaceMembershipId).toBeUndefined();
      expect(authority.roles).toEqual(["world-member"]);
      expect(authority.privacyCeiling.allowedCategories).toEqual(["operator_evidence"]);
      const accepted = await worker.fetch(request());
      expect(accepted.status).toBe(200);
      const duplicate = await worker.fetch(request());
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(await accepted.json());
      expect((await worker.fetch(request({ actionId: "conflict" }))).status).toBe(409);
      expect(
        (
          await psqlQuery(tools, environment, "SELECT correlation_id FROM clockgrove.events")
        ).trim(),
      ).toBe("correlation-runtime");
      for (const field of ["tenantId", "worldId", "timelineId", "spaceId"])
        expect((await worker.fetch(request({ [field]: "different" }))).status).toBe(403);
      await psql(
        tools,
        environment,
        `INSERT INTO clockgrove_management.workspace_memberships VALUES ('tenant-runtime', 'principal-runtime', 'admin-membership', ARRAY['workspace-admin'], ARRAY['runtime:no-op'], NULL)`,
      );
      expect((await authenticator.authenticate(request())).workspaceMembershipId).toBe(
        "admin-membership",
      );
      // Blocks the event loop until the matched idle backend has exited, so its termination is
      // still unread when cleanup ends the connection.
      const terminate = (backend: string) =>
        spawnSync(
          tools.psql,
          [
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--command",
            `SELECT pg_terminate_backend(pid, 10000) FROM pg_stat_activity WHERE ${backend}`,
          ],
          { env: environment, encoding: "utf8", timeout: 30_000 },
        ).stdout;
      let terminated = "";
      const observedFailure = composeReferenceAuthentication(fixtureSecret, {
        baseURL: env.AUTH_ORIGIN!,
        environment: "local",
        connectionString: env.AUTH_DATABASE_URL!,
        resolveIdentity: async (environmentName, subject) => {
          const identity = await withHyperdrivePostgreSqlClient(
            env.MANAGEMENT_DATABASE_URL!,
            (client) =>
              new PostgreSqlManagementReaders(client, "local").resolveIdentity(
                environmentName,
                subject,
              ),
          );
          terminated = terminate("usename = 'clockgrove_auth_verifier'");
          return identity;
        },
      });
      await expect(observedFailure.authenticate(fixtureCredential)).rejects.toThrow(
        "authentication refused",
      );
      expect(terminated).toBe("t\n");
      // An operation-owned client that confirms, as authentication reads do, refuses the same
      // ordering after its last query.
      await expect(
        withHyperdrivePostgreSqlClient(
          connection("clockgrove_world_reader"),
          async (client) => {
            const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
            terminated = terminate(`pid = ${(rows[0] as { pid: number }).pid}`);
          },
          { confirm: true },
        ),
      ).rejects.toMatchObject({ message: "PostgreSQL connection failed", code: "08006" });
      expect(terminated).toBe("t\n");
      const principal = decodeOpaqueId("principal-runtime", "PrincipalId");
      const scope = {
        tenantId: authority.tenantId,
        worldId: authority.worldId!,
        timelineId: authority.timelineId!,
        spaceId: authority.spaceId!,
      };
      // Composed authority reads confirm: the same termination after a World read's COMMIT refuses.
      const query = HyperdrivePostgreSqlClient.prototype.query;
      const afterCommit = vi
        .spyOn(HyperdrivePostgreSqlClient.prototype, "query")
        .mockImplementation(async function (this: HyperdrivePostgreSqlClient, text, values) {
          const result = await query.call(this, text, values);
          if (text === "COMMIT") terminated = terminate("usename = 'clockgrove_world_reader'");
          return result;
        });
      await expect(
        dependencies.authentication.world.resolveWorld(principal, scope),
      ).rejects.toThrow("authentication refused");
      afterCommit.mockRestore();
      expect(terminated).toBe("t\n");
      const outage = new URL(env.AUTH_DATABASE_URL!);
      outage.searchParams.set("host", "\0clockgrove-nonexistent-owned-test-socket");
      const unavailable = composeRuntime({ ...env, AUTH_DATABASE_URL: outage.toString() });
      expect(
        (
          await new RuntimeWorker(
            new TrustedRuntimeRequestAuthenticator(unavailable.authentication),
            new LocalRuntimeOwnerBindings(unavailable.canonical, unavailable.journal),
          ).fetch(request())
        ).status,
      ).toBe(401);
      await psql(
        tools,
        environment,
        "UPDATE clockgrove_management.workspace_memberships SET revoked_at = now()",
      );
      expect((await authenticator.authenticate(request())).workspaceMembershipId).toBeUndefined();
      // Each revocation, expiry or malformed authority refuses: 401 for authentication, 403 (a new
      // command each, since an exact retry would return the stored outcome) for world authority.
      for (const [sql, status, commandId] of [
        ["UPDATE clockgrove_management.principals SET revoked_at = now()", 401],
        [
          `UPDATE clockgrove_management.principals SET revoked_at = NULL; UPDATE clockgrove_auth.session SET "expiresAt" = now() - interval '1 second'`,
          401,
        ],
        [
          `UPDATE clockgrove_auth.session SET "expiresAt" = now() + interval '1 hour'; UPDATE clockgrove.world_memberships SET roles = ARRAY['duplicate', 'duplicate']`,
          403,
          "command-duplicate-roles",
        ],
        [
          "UPDATE clockgrove.world_memberships SET roles = ARRAY['world-member'], grants = '{}'",
          403,
          "command-no-grant",
        ],
        [
          `UPDATE clockgrove.world_memberships SET grants = ARRAY['runtime:no-op'], privacy_ceiling = '{"version":1,"allowedCategories":["unknown"]}'`,
          403,
          "command-bad-ceiling",
        ],
        [
          `UPDATE clockgrove.world_memberships SET privacy_ceiling = '{"version":1,"allowedCategories":["operator_evidence"]}', revoked_at = now()`,
          403,
          "command-revoked",
        ],
        ["UPDATE clockgrove_management.identity_links SET revoked_at = now()", 401],
        [
          "UPDATE clockgrove_management.identity_links SET revoked_at = NULL, environment = 'staging'",
          401,
        ],
        [
          "UPDATE clockgrove_management.identity_links SET environment = 'local'; DELETE FROM clockgrove_auth.session",
          401,
        ],
      ] as const) {
        await psql(tools, environment, sql);
        expect(
          (await worker.fetch(request(commandId === undefined ? {} : { commandId }))).status,
        ).toBe(status);
      }
      for (const invalid of [
        { AUTH_ORIGIN: "http://auth.example.test" },
        { AUTH_DATABASE_URL: connection("clockgrove_runtime") },
        { MANAGEMENT_DATABASE_URL: "" },
        {
          MANAGEMENT_DATABASE_URL: connection("clockgrove_management_reader").replace(
            "/clockgrove?",
            "/other?",
          ),
        },
        { AUTH_DATABASE_URL: `${env.AUTH_DATABASE_URL}&user=clockgrove_migrator` },
        { BETTER_AUTH_SECRET: "" },
      ]) {
        const config = composeRuntime({ ...env, ...invalid });
        const denied = new RuntimeWorker(
          new TrustedRuntimeRequestAuthenticator(config.authentication),
          new LocalRuntimeOwnerBindings(config.canonical, config.journal),
        );
        expect((await denied.fetch(request())).status).toBe(401);
      }
      await withHyperdrivePostgreSqlClient(
        connection("clockgrove_management_reader"),
        async (client) => {
          const reader = new PostgreSqlManagementReaders(client, "local");
          expect(await reader.resolveIdentity("staging", "local-subject")).toBeUndefined();
          expect(await reader.resolveIdentity("local", "unmapped-subject")).toBeUndefined();
          expect(
            await reader.resolvePrincipal({
              externalIdentityId: decodeOpaqueId("unknown", "ExternalIdentityId"),
            }),
          ).toBeUndefined();
          const cleared = await client.query(
            "SELECT nullif(current_setting('lookup.environment', true), '') AS environment",
          );
          expect(cleared.rows).toEqual([{ environment: null }]);
          await expect(
            client.query(
              "INSERT INTO clockgrove.tenant_principals VALUES ('tenant-runtime', 'unauthorized')",
            ),
          ).rejects.toThrow();
        },
      );
      await withHyperdrivePostgreSqlClient(
        connection("clockgrove_world_reader"),
        async (client) => {
          expect(
            await new PostgreSqlWorldAuthorizationReader(client).resolveWorld(principal, scope),
          ).toBeUndefined();
          expect(
            (await client.query("SELECT count(*)::int AS count FROM clockgrove.world_memberships"))
              .rows,
          ).toEqual([{ count: 0 }]);
          await expect(
            client.query("UPDATE clockgrove_management.identity_links SET revoked_at = NULL"),
          ).rejects.toThrow();
          await expect(
            client.query("UPDATE clockgrove.world_memberships SET revoked_at = NULL"),
          ).rejects.toThrow();
        },
      );
      await withHyperdrivePostgreSqlClient(
        connection("clockgrove_auth_verifier"),
        async (client) => {
          await expect(client.query("DELETE FROM clockgrove_auth.session")).rejects.toThrow();
          await expect(
            client.query("SELECT * FROM clockgrove_management.identity_links"),
          ).rejects.toThrow();
        },
      );
      // A failed operation still releases its connection.
      await expect(
        withHyperdrivePostgreSqlClient(connection("clockgrove_runtime"), async (client) => {
          await client.query("BEGIN");
          throw new Error("operation failure");
        }),
      ).rejects.toThrow("operation failure");
      expect(
        (
          await psqlQuery(
            tools,
            environment,
            "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('clockgrove_runtime', 'clockgrove_auth_verifier', 'clockgrove_management_reader', 'clockgrove_world_reader')",
          )
        ).trim(),
      ).toBe("0");
    });
  }, 60_000);
});

const seedSql = `
INSERT INTO clockgrove.tenants (tenant_id, display_name)
VALUES ('tenant-runtime', 'Runtime Test');
INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
VALUES ('tenant-runtime', 'principal-runtime');
INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
VALUES ('tenant-runtime', 'world-runtime', 'ready');
INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
VALUES ('tenant-runtime', 'world-runtime', 'timeline-runtime');
INSERT INTO clockgrove.timeline_partitions (
  tenant_id, world_id, timeline_id, partition_id, space_id, routing_epoch
) VALUES (
  'tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime', 'space-runtime', 7
);
INSERT INTO clockgrove.streams (
  tenant_id, world_id, timeline_id, partition_id, space_id, stream_id
) VALUES (
  'tenant-runtime', 'world-runtime', 'timeline-runtime', 'partition-runtime',
  'space-runtime', 'stream-runtime'
);`;
