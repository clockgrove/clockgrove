import { JournalRevisionConflictError } from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_SCOPE, fixtureRequest } from "../../application/test/journal-request-fixture.js";
import {
  type PostgreSqlClient,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldOwnerReader,
  WORLD_COMMAND_TIMEOUTS,
} from "../src/index.js";

describe("canonical tenant membership", () => {
  it.each([true, false])("reads only the authenticated tenant membership: %s", async (member) => {
    const request = fixtureRequest(FIXTURE_SCOPE, "membership", []);
    const calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const client: PostgreSqlClient = {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows:
            sql.includes("tenant_principals") && member
              ? [{ principal_id: request.authorization.principalId }]
              : [],
        };
      },
    };
    expect(
      await new PostgreSqlWorldOwnerReader(client).isTenantMember(request.authorization, {
        tenantId: request.command.target.tenantId,
        worldId: request.command.target.worldId,
        timelineId: request.command.target.timelineId,
        spaceId: decodeOpaqueId(FIXTURE_SCOPE.spaceId, "SpaceId"),
      }),
    ).toBe(member);
    expect(calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT set_config('app.principal_id', $1, true)",
      "SELECT set_config('app.privacy_ceiling', $1, true)",
      `SELECT principal_id FROM clockgrove.tenant_principals
          WHERE tenant_id = $1 AND principal_id = $2`,
      "COMMIT",
    ]);
    expect(calls[4]?.values).toEqual(["tenant-1", "principal-1"]);
  });
});

describe("native owner's transactional epoch fence", () => {
  it.each([
    { routingEpoch: 1n, authorityEpoch: 2n },
    { routingEpoch: 2n, authorityEpoch: 1n },
  ])("refuses a stale supplied epoch before physical execution", async (fence) => {
    const statements: string[] = [];
    const client: PostgreSqlClient = {
      async query(sql) {
        statements.push(sql);
        if (sql.includes("begin_command")) return { rows: [{ begun: { status: "begun" } }] };
        if (sql.includes("routing_epoch::text")) return { rows: [{ routing_epoch: "2" }] };
        return { rows: [] };
      },
    };
    const step = vi.fn();
    const journal = new PostgreSqlWorldCommandJournal(
      client,
      undefined,
      {},
      WORLD_COMMAND_TIMEOUTS,
      fence,
    );
    await expect(
      journal.executeWorldCommand(fixtureRequest(FIXTURE_SCOPE, "fenced", []), step),
    ).rejects.toEqual(new JournalRevisionConflictError("routing-epoch", 1n, 2n));
    expect(step).toHaveBeenCalledTimes(0);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.filter((sql) => sql.includes("append_command"))).toEqual([]);
  });

  it("returns an exact decided receipt without checking current epochs or running the step", async () => {
    const statements: string[] = [];
    const stored = { value: { complete: false }, events: [], projectionDelta: null };
    const client: PostgreSqlClient = {
      async query(sql) {
        statements.push(sql);
        return sql.includes("begin_command")
          ? { rows: [{ begun: { status: "decided", result: stored } }] }
          : { rows: [] };
      },
    };
    const step = vi.fn();
    const journal = new PostgreSqlWorldCommandJournal(
      client,
      undefined,
      {},
      WORLD_COMMAND_TIMEOUTS,
      { routingEpoch: 1n, authorityEpoch: 1n },
    );
    expect(
      await journal.executeWorldCommand(fixtureRequest(FIXTURE_SCOPE, "decided", []), step),
    ).toEqual(stored);
    expect(step).toHaveBeenCalledTimes(0);
    expect(statements.filter((sql) => sql.includes("routing_epoch::text"))).toEqual([]);
    expect(statements.at(-1)).toBe("COMMIT");
  });
});
