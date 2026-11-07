import { JournalRouteNotFoundError } from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { withClientTransaction } from "@clockgrove/persistence";
import { expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local database lifecycle helper has no declarations.
} from "../../../../scripts/database/lib.mjs";
import { withCommandOwner } from "../../src/cloudflare-entry.js";
import { withHyperdrivePostgreSqlClient } from "../../src/hyperdrive-postgres.js";
import {
  connectionString,
  type DatabaseFixture,
  provisionTestWorld,
  testWorld,
  truthOf,
} from "../world-fixture.js";

it("gives each production owner invocation one connection across canonical reads and releases it on every exit", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const world = await testWorld();
    const provisioned = await provisionTestWorld(fixture, world, "connection-owner");
    const truth = truthOf(fixture);
    await truth(`INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('foreign', 'Foreign');
      INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('foreign', 'foreign-principal')`);
    const scope = { ...provisioned.partition.target, spaceId: provisioned.partition.route.spaceId };
    const foreign = {
      tenantId: decodeOpaqueId("foreign", "TenantId"),
      principalId: decodeOpaqueId("foreign-principal", "PrincipalId"),
      privacyCeiling: decodePrivacyCeiling({
        version: 1,
        allowedCategories: ["operator_evidence"],
      }),
    };
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const release = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    const operations = [
      withCommandOwner(connectionString(fixture.environment), async (owner) => {
        expect(await owner.reader.isReady(provisioned.authorization, scope)).toBe(true);
        const hydrated = await owner.reader.hydrate(provisioned.authorization, scope);
        expect(hydrated.document.randomState).toBe(world.birth.randomState);
        expect(
          (await owner.reader.installedResources(provisioned.authorization, scope)).contentHash,
        ).toBe(world.artifact.contentHash);
        gates[0].resolve();
        await release.promise;
      }),
      withCommandOwner(connectionString(fixture.environment), async (owner) => {
        expect(await owner.reader.isReady(foreign, scope)).toBe(false);
        await expect(owner.reader.hydrate(foreign, scope)).rejects.toEqual(
          new JournalRouteNotFoundError(scope.spaceId),
        );
        await expect(owner.reader.installedResources(foreign, scope)).rejects.toEqual(
          new JournalRouteNotFoundError(scope.worldId),
        );
        expect(await owner.reader.isReady(foreign, scope)).toBe(false);
        gates[1].resolve();
        await release.promise;
        cancelled.signal.throwIfAborted();
      }),
    ];
    const settled = Promise.allSettled(operations);
    try {
      await Promise.race([Promise.all(gates.map((gate) => gate.promise)), ...operations]);
      expect(
        await truth(`SELECT count(*) || '|' || count(DISTINCT pid) || '|' ||
        count(*) FILTER (WHERE backend_xid IS NULL) FROM pg_stat_activity
        WHERE usename = 'clockgrove_runtime' AND state = 'idle'`),
      ).toBe("2|2|2");
      cancelled.abort(new Error("owner invocation cancelled"));
    } finally {
      release.resolve();
      await settled;
    }
    expect(await settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: new Error("owner invocation cancelled") },
    ]);
    await expect(
      withCommandOwner(connectionString(fixture.environment), (owner) =>
        owner.reader.hydrate(foreign, scope),
      ),
    ).rejects.toEqual(new JournalRouteNotFoundError(scope.spaceId));
    expect(
      await truth("SELECT count(*) FROM pg_stat_activity WHERE usename = 'clockgrove_runtime'"),
    ).toBe("0");
  });
}, 30_000);

it("isolates overlapping runtime connections and cleans up success, failure and cancellation", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const truth = truthOf(fixture);
    await truth(`INSERT INTO clockgrove.tenants (tenant_id, display_name)
      VALUES ('connection-a', 'A'), ('connection-b', 'B');
      INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id)
      VALUES ('connection-a', 'principal-a'), ('connection-b', 'principal-b')`);
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const release = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const operations = (["a", "b"] as const).map((suffix, index) =>
      withHyperdrivePostgreSqlClient(connectionString(fixture.environment), async (client) => {
        const authorization = {
          tenantId: decodeOpaqueId(`connection-${suffix}`, "TenantId"),
          principalId: decodeOpaqueId(`principal-${suffix}`, "PrincipalId"),
          privacyCeiling: decodePrivacyCeiling({
            version: 1,
            allowedCategories: suffix === "a" ? ["public_scene"] : ["operator_evidence"],
          }),
        };
        await withClientTransaction(client, { authorization }, async () => {
          await client.query("SELECT pg_current_xact_id()");
          expect(
            (await client.query("SELECT tenant_id, principal_id FROM clockgrove.tenant_principals"))
              .rows,
          ).toEqual([{ tenant_id: `connection-${suffix}`, principal_id: `principal-${suffix}` }]);
          expect(
            (
              await client.query(`SELECT current_setting('app.tenant_id') AS tenant,
                current_setting('app.principal_id') AS principal,
                current_setting('app.privacy_ceiling')::jsonb AS privacy`)
            ).rows,
          ).toEqual([
            {
              tenant: authorization.tenantId,
              principal: authorization.principalId,
              privacy: authorization.privacyCeiling,
            },
          ]);
          const gate = gates[index];
          if (gate === undefined) throw new Error("connection gate missing");
          gate.resolve();
          await release.promise;
          if (suffix === "b") cancellation.signal.throwIfAborted();
        });
        expect(
          (
            await client.query(`SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant,
              nullif(current_setting('app.principal_id', true), '') AS principal,
              nullif(current_setting('app.privacy_ceiling', true), '') AS privacy`)
          ).rows,
        ).toEqual([{ tenant: null, principal: null, privacy: null }]);
      }),
    );
    const settled = Promise.allSettled(operations);
    const bothReady = Promise.all(gates.map((gate) => gate.promise));
    try {
      // If an invocation fails before reaching its gate, propagate it without stranding the peer.
      await Promise.race([bothReady, ...operations]);
      expect(
        await truth(`SELECT count(*) || '|' || count(DISTINCT pid) || '|' ||
          count(DISTINCT backend_xid::text) FROM pg_stat_activity
          WHERE usename = 'clockgrove_runtime' AND state = 'idle in transaction'`),
      ).toBe("2|2|2");
      cancellation.abort(new Error("owned operation cancelled"));
    } finally {
      release.resolve();
      await settled;
    }
    expect(await settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: new Error("owned operation cancelled") },
    ]);
    await expect(
      withHyperdrivePostgreSqlClient(connectionString(fixture.environment), async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT 1 / 0");
      }),
    ).rejects.toMatchObject({ code: "22012" });
    expect(
      await truth("SELECT count(*) FROM pg_stat_activity WHERE usename = 'clockgrove_runtime'"),
    ).toBe("0");
  });
}, 30_000);
