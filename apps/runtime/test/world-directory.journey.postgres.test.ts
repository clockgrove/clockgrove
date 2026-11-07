import { decodeWorldDirectory } from "@clockgrove/contracts";
import { expect, it, vi } from "vitest";
import {
  applyMigrations,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { DeterministicTestAuthProvider, LOCAL_TEST_PRINCIPALS } from "../local/test-auth.js";
import { readWorldDirectory } from "../src/observation.js";
import { RuntimeWorker } from "../src/worker.js";
import { observationAuthenticator } from "./living-yard-fixture.js";
import { type DatabaseFixture, truthOf, withClient } from "./world-fixture.js";

// Privacy and authority: the directory lists only the principal's own committed, unrevoked
// runtime:world-observe memberships in ready worlds, read as the world reader through 0032.
// "Den" sorts before "attic" in byte order, which the directory uses whatever the collation.
it("lists exactly the authenticated principal's observable scopes in byte order, after authentication only", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    const observer = LOCAL_TEST_PRINCIPALS.observer.principalId;
    const other = LOCAL_TEST_PRINCIPALS.operator.principalId;
    const membership = (scope: string, principal: string, grant: string, extra = "now(), NULL") =>
      `('tenant-d', ${scope}, '${principal}', 'membership', 'persona',
        '{}', ARRAY['${grant}'], '{"version":1,"allowedCategories":["public_scene"]}', ${extra})`;
    await truthOf(fixture)(
      `INSERT INTO clockgrove.tenants VALUES ('tenant-d', 'Tenant D');
       INSERT INTO clockgrove.tenant_principals VALUES ('tenant-d', '${observer}'), ('tenant-d', '${other}');
       INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
         VALUES ('tenant-d', 'world-b', 'ready'), ('tenant-d', 'world-a', 'ready'),
                ('tenant-d', 'world-c', 'provisioning');
       INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id)
         VALUES ('tenant-d', 'world-a', 'timeline-a'), ('tenant-d', 'world-b', 'timeline-b'), ('tenant-d', 'world-c', 'timeline-c');
       INSERT INTO clockgrove.world_memberships (tenant_id, world_id, timeline_id, space_id,
         principal_id, membership_id, persona_id, roles, grants, privacy_ceiling, committed_at, revoked_at)
       VALUES ${[
         membership("'world-b', 'timeline-b', 'yard'", observer, "runtime:world-observe"),
         membership("'world-a', 'timeline-a', 'attic'", observer, "runtime:world-observe"),
         membership("'world-a', 'timeline-a', 'Den'", observer, "runtime:world-observe"),
         membership(
           "'world-a', 'timeline-a', 'revoked'",
           observer,
           "runtime:world-observe",
           "now(), now()",
         ),
         membership(
           "'world-a', 'timeline-a', 'future-commit'",
           observer,
           "runtime:world-observe",
           "now() + interval '1 day', NULL",
         ),
         membership("'world-a', 'timeline-a', 'commands-only'", observer, "runtime:no-op"),
         membership("'world-c', 'timeline-c', 'unready'", observer, "runtime:world-observe"),
         membership("'world-a', 'timeline-a', 'other'", other, "runtime:world-observe"),
       ].join(",")}`,
    );
    const provider = new DeterministicTestAuthProvider(() => 100);
    for (const role of ["observer", "operator"] as const)
      provider.createRoleSession(role, { revision: 1, expiresAt: 200 });
    const resolveWorld = vi.fn();
    const directory = {
      worldDirectory: (principalId: typeof observer) =>
        withClient(
          fixture.environment,
          (client) => readWorldDirectory(client, principalId),
          "clockgrove",
          "clockgrove_world_reader",
        ),
      getSpace: () => {
        throw new Error("the directory must not route to an owner");
      },
    };
    const log = vi.fn();
    const worker = new RuntimeWorker(
      observationAuthenticator(provider, { resolveWorld }),
      directory,
      {
        log,
      },
    );
    const unmapped = new RuntimeWorker(
      observationAuthenticator(
        provider,
        { resolveWorld },
        { resolvePrincipal: async () => undefined },
      ),
      directory,
      { log },
    );
    const read = (authorization?: string, body = '{"version":1}', target = worker) =>
      target.fetch(
        new Request("http://local.test/v1/runtime/world-directory", {
          method: "POST",
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
      );
    const entry = (worldId: string, spaceId: string) => ({
      tenantId: "tenant-d",
      worldId,
      timelineId: worldId.replace("world", "timeline"),
      spaceId,
      worldLabel: worldId,
      spaceLabel: spaceId,
    });

    const response = await read("Bearer local-observer");
    expect(response.status).toBe(200);
    expect(decodeWorldDirectory(await response.json())).toEqual({
      version: 1,
      entries: [entry("world-a", "Den"), entry("world-a", "attic"), entry("world-b", "yard")],
    });
    const otherResponse = await read("Bearer local-operator");
    expect(decodeWorldDirectory(await otherResponse.json()).entries).toEqual([
      entry("world-a", "other"),
    ]);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      event: "scene_observation_answered",
      status: 200,
      authorization: "authorized",
      outcome: "read",
    });

    // Authentication reads no body: the refusal wins over an unparsable one.
    for (const [authorization, target] of [
      [undefined, worker],
      ["Basic local-observer", worker],
      ["Bearer", worker],
      ["Bearer expired-or-unknown", worker],
      ["Bearer local-observer", unmapped],
    ] as const) {
      const refused = await read(authorization, "not json", target);
      expect([refused.status, await refused.text()]).toEqual([
        401,
        '{"error":"authentication_refused"}',
      ]);
    }
    for (const body of ["not json", '{"version":1,"tenantId":"tenant-d"}', "{}"]) {
      const invalid = await read("Bearer local-observer", body);
      expect([invalid.status, await invalid.json()]).toEqual([
        400,
        { error: "invalid_inspection_request" },
      ]);
    }
    expect(resolveWorld).not.toHaveBeenCalled();
  });
});
