import { provisionWorld } from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCeiling } from "@clockgrove/contracts";
import { constructTrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  PostgreSqlWorldAuthorizationReader,
  PostgreSqlWorldProvisioningStore,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { PostgreSqlCanonicalRuntimeStateSource } from "../src/index.js";
import { RuntimeRouteNotFoundError } from "../src/types.js";
import {
  type DatabaseFixture,
  lampSource,
  packWorld,
  truthOf,
  withClient,
} from "./world-fixture.js";

const PRINCIPAL = "principal-provisioner";
const OTHER_TENANT = "tenant-other";
const OTHER_WORLD = "world-other";
const NON_READY_STATUSES = ["initializing", "provisioning", "archived"] as const;

describe("readiness gating of runtime entry and world authority reads", () => {
  it("refuses every non-ready lifecycle and admits the world once provisioning completes", async () => {
    await withDisposableDatabase(async (fixture: DatabaseFixture) => {
      const { environment } = fixture;
      await applyMigrations(fixture.tools, environment);
      const truth = truthOf(fixture);
      const lamp = await packWorld(await lampSource());
      const { tenantId, worldId, timelineId } = lamp.birth.world;
      const spaceId = lamp.birth.spaces[0]!.spaceId;

      for (const tenant of [tenantId, OTHER_TENANT]) {
        await truth(
          `INSERT INTO clockgrove.tenants (tenant_id, display_name) VALUES ('${tenant}', '${tenant}')`,
        );
        await truth(
          `INSERT INTO clockgrove.tenant_principals (tenant_id, principal_id) VALUES ('${tenant}', '${PRINCIPAL}')`,
        );
      }

      const privacyCeiling = decodePrivacyCeiling({
        version: 1,
        allowedCategories: ["public_scene"],
      });
      const scope = {
        tenantId: decodeOpaqueId(tenantId, "TenantId"),
        worldId: decodeOpaqueId(worldId, "WorldId"),
        timelineId: decodeOpaqueId(timelineId, "TimelineId"),
        spaceId: decodeOpaqueId(spaceId, "SpaceId"),
      };
      const context = constructTrustedExecutionContext({
        version: 1,
        ...scope,
        principalId: PRINCIPAL,
        roles: [],
        grants: [],
        privacyCeiling,
        correlationId: "correlation-readiness",
        requestId: "request-readiness",
        codeVersion: "test",
        protocolVersion: 1,
      });
      const request = {
        authorization: {
          tenantId: decodeOpaqueId(tenantId, "TenantId"),
          principalId: decodeOpaqueId(PRINCIPAL, "PrincipalId"),
          privacyCeiling,
        },
        caseId: "case-readiness",
        artifact: lamp.artifact,
        source: lamp.source,
      };

      /** Every row of every canonical and birth table, for before/after comparison. */
      const canonicalRows = async () => {
        const tables = (
          await truth(
            "SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname IN ('clockgrove', 'clockgrove_birth') ORDER BY 1",
          )
        ).split("\n");
        const rows: string[] = [];
        for (const table of tables) {
          rows.push(
            await truth(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM ${table} t`,
            ),
          );
        }
        return rows;
      };

      const enter = () =>
        withClient(environment, (client) =>
          new PostgreSqlCanonicalRuntimeStateSource(client).loadReadyRuntimeState(context, scope),
        );
      const asWorldReader = <T>(operation: Parameters<typeof withClient<T>>[1]) =>
        withClient(environment, operation, "clockgrove", "clockgrove_world_reader");
      const resolve = () =>
        asWorldReader((client) =>
          new PostgreSqlWorldAuthorizationReader(client).resolveWorld(
            decodeOpaqueId(PRINCIPAL, "PrincipalId"),
            scope,
          ),
        );
      const expectRefused = async () => {
        const before = await canonicalRows();
        await expect(enter()).rejects.toBeInstanceOf(RuntimeRouteNotFoundError);
        expect(await resolve()).toBeUndefined();
        expect(await canonicalRows()).toEqual(before);
      };

      // An interrupted provisionWorld leaves the world mid-provisioning, with its journal rows committed.
      const interrupted = await withClient(environment, (client) =>
        provisionWorld(request, {
          store: new PostgreSqlWorldProvisioningStore(client, {
            fault: { point: "seed-command-1", when: "after-commit" },
          }),
          genesis: lamp.genesis,
          decodeResource,
        }).catch((error: unknown) => error),
      );
      expect(interrupted).toMatchObject({
        name: "ProvisioningFaultInjectedError",
        point: "seed-command-1",
        when: "after-commit",
      });
      const midProvisioning = await truth(
        `SELECT lifecycle_status FROM clockgrove.worlds WHERE tenant_id = '${tenantId}' AND world_id = '${worldId}'`,
      );
      expect(midProvisioning).toBe("provisioning");
      await truth(
        `INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
         VALUES ('${tenantId}', '${worldId}', '${timelineId}', '${spaceId}', '${PRINCIPAL}', 'membership-readiness', 'persona-readiness',
                 ARRAY['world-member'], ARRAY['runtime:no-op'], '{"version":1,"allowedCategories":["public_scene"]}', now())`,
      );
      await expectRefused();

      // Every other non-ready lifecycle the schema permits is refused as well.
      for (const status of NON_READY_STATUSES) {
        await truth(
          `UPDATE clockgrove.worlds SET lifecycle_status = '${status}' WHERE tenant_id = '${tenantId}' AND world_id = '${worldId}'`,
        );
        await expectRefused();
      }
      await truth(
        `UPDATE clockgrove.worlds SET lifecycle_status = '${midProvisioning}' WHERE tenant_id = '${tenantId}' AND world_id = '${worldId}'`,
      );

      // Retrying the same case completes provisioning; the same entry and authority read now succeed.
      const retried = await withClient(environment, (client) =>
        provisionWorld(request, {
          store: new PostgreSqlWorldProvisioningStore(client),
          genesis: lamp.genesis,
          decodeResource,
        }),
      );
      expect(retried.lifecycleStatus).toBe("ready");
      const entered = await enter();
      expect(entered).toMatchObject({
        ...scope,
        lifecycleStatus: "ready",
        fidelity: "hot",
      });
      expect(await resolve()).toMatchObject({
        ...scope,
        principalId: PRINCIPAL,
        membershipId: "membership-readiness",
        personaId: "persona-readiness",
        roles: ["world-member"],
        grants: ["runtime:no-op"],
        privacyCeiling,
      });

      // The world reader still reads nothing but memberships.
      await asWorldReader(async (client) => {
        await expect(client.query("SELECT 1 FROM clockgrove.worlds")).rejects.toThrow();
      });

      // Another tenant's and another world's memberships stay invisible to the world reader.
      await truth(
        `INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status) VALUES ('${OTHER_TENANT}', '${OTHER_WORLD}', 'ready'),
                                                                                    ('${tenantId}', '${OTHER_WORLD}', 'ready');
         INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ('${OTHER_TENANT}', '${OTHER_WORLD}', 'timeline-other-tenant'),
                                                                                  ('${tenantId}', '${OTHER_WORLD}', 'timeline-other-world');
         INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id, principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at)
         VALUES ('${OTHER_TENANT}', '${OTHER_WORLD}', 'timeline-other-tenant', '${spaceId}', '${PRINCIPAL}', 'membership-other-tenant', 'persona-other', ARRAY[]::text[], ARRAY[]::text[], '{"version":1,"allowedCategories":["public_scene"]}', now()),
                ('${tenantId}', '${OTHER_WORLD}', 'timeline-other-world', '${spaceId}', '${PRINCIPAL}', 'membership-other-world', 'persona-other', ARRAY[]::text[], ARRAY[]::text[], '{"version":1,"allowedCategories":["public_scene"]}', now())`,
      );
      await asWorldReader(async (client) => {
        await client.query("BEGIN");
        try {
          for (const [key, value] of Object.entries({
            "app.tenant_id": tenantId,
            "app.principal_id": PRINCIPAL,
            "app.world_id": worldId,
            "app.timeline_id": timelineId,
            "app.space_id": spaceId,
          }))
            await client.query("SELECT set_config($1, $2, true)", [key, value]);
          const scoped = await client.query(
            "SELECT membership_id FROM clockgrove.world_memberships ORDER BY membership_id",
          );
          expect(scoped.rows).toEqual([{ membership_id: "membership-readiness" }]);
        } finally {
          await client.query("ROLLBACK");
        }
      });
      await asWorldReader(async (client) => {
        const visible = await client.query(
          "SELECT membership_id FROM clockgrove.world_memberships",
        );
        expect(visible.rows).toEqual([]);
      });
    });
  }, 120_000);
});
