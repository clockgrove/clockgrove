import { decodeOpaqueId } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import type { PostgreSqlClient } from "../src/index.js";
import { PostgreSqlPersistenceTransactionPort } from "../src/index.js";

describe("PostgreSQL transaction-local authorization", () => {
  it("installs all authority with local set_config calls", async () => {
    const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
    const client: PostgreSqlClient = {
      async query(text, values) {
        calls.push([text, values]);
        return { rows: [] };
      },
    };
    const adapter = new PostgreSqlPersistenceTransactionPort(client);
    await adapter.withAuthorization(
      {
        tenantId: decodeOpaqueId("tenant-a", "TenantId"),
        principalId: decodeOpaqueId("principal-a", "PrincipalId"),
        privacyCeiling: {
          version: 1,
          allowedCategories: ["public_scene", "conversation"],
        },
      },
      async () => "ok",
    );

    expect(calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT set_config('app.principal_id', $1, true)",
      "SELECT set_config('app.privacy_ceiling', $1, true)",
      "COMMIT",
    ]);
    expect(calls[3]?.[1]).toEqual([
      '{"version":1,"allowedCategories":["public_scene","conversation"]}',
    ]);
  });

  it("rolls back a failed operation", async () => {
    const calls: string[] = [];
    const client: PostgreSqlClient = {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
    };
    const adapter = new PostgreSqlPersistenceTransactionPort(client);
    await expect(
      adapter.withAuthorization(
        {
          tenantId: decodeOpaqueId("tenant-a", "TenantId"),
          principalId: decodeOpaqueId("principal-a", "PrincipalId"),
          privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
        },
        () => Promise.reject(new Error("failed")),
      ),
    ).rejects.toThrow("failed");
    expect(calls.at(-1)).toBe("ROLLBACK");
  });
});
