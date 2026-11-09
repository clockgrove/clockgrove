import {
  McpCredentialError,
  type McpCredentialScope,
  McpCredentialVault,
} from "@clockgrove/application";
import { expect, it } from "vitest";
import { PostgreSqlMcpSecretStorage } from "../../../packages/persistence/src/postgres-mcp-secrets.js";
import {
  applyMigrations,
  applySqlFile,
  psqlQuery,
  withDisposableDatabase,
  // @ts-expect-error -- repository-local JavaScript helper has no declaration file.
} from "../../../scripts/database/lib.mjs";
import { connect, type DatabaseFixture } from "./world-fixture.js";

const scope: McpCredentialScope = {
  tenantId: "tenant-j-a",
  worldId: "world-j-a",
  timelineId: "timeline-j-a",
  installationId: "installation-one",
  ownerPrincipalId: "principal-j-a",
};

it("isolates encrypted MCP credentials and preserves revocation across provider loss and takeover", async () => {
  await withDisposableDatabase(async (fixture: DatabaseFixture) => {
    await applyMigrations(fixture.tools, fixture.environment);
    await applySqlFile(fixture.tools, fixture.environment, "tests/database/journal-fixture.sql");
    const truth = async (sql: string) =>
      (await psqlQuery(fixture.tools, fixture.environment, sql)).trim();
    let fault: "none" | "fence" | "commit" = "none";
    const open = async (context = scope, inject = false) => {
      const client = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      await client.query("SET ROLE clockgrove_mcp_secrets");
      if (!inject) return PostgreSqlMcpSecretStorage.open(client, context);
      return PostgreSqlMcpSecretStorage.open(
        {
          async query(sql, values) {
            if (
              fault === "fence" &&
              sql.startsWith("UPDATE clockgrove_mcp.credentials SET revocation_requested")
            ) {
              fault = "none";
              throw new Error("mcp-canary-never-in-journal-or-errors");
            }
            const result = await client.query(sql, values);
            if (fault === "commit" && sql === "COMMIT") {
              fault = "none";
              throw new Error("mcp-canary-never-in-journal-or-errors");
            }
            return result;
          },
          close: () => client.close(),
        },
        context,
      );
    };
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(17),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const keys = new Map([["credential-key-v1", key]]);
    const initialClient = connect(fixture.environment, "clockgrove", "clockgrove_admin");
    await initialClient.query("SET ROLE clockgrove_mcp_secrets");
    const provider = await PostgreSqlMcpSecretStorage.open(initialClient, scope);
    await expect(PostgreSqlMcpSecretStorage.open(initialClient, scope)).rejects.toThrow(
      "MCP credential unavailable",
    );
    const vault = new McpCredentialVault(provider, "credential-key-v1", keys);
    const canary = "mcp-canary-never-in-journal-or-errors";
    try {
      const reference = await vault.store(scope, canary);
      expect(
        await vault.use(
          scope,
          reference,
          async (authorization) => authorization === `Bearer ${canary}`,
        ),
      ).toBe(true);
      expect(
        await truth(
          "SELECT count(*) FROM clockgrove_mcp.credentials WHERE envelope::text LIKE '%mcp-canary%'",
        ),
      ).toBe("0");
      expect(await truth("SELECT envelope->>'keyVersion' FROM clockgrove_mcp.credentials")).toBe(
        "credential-key-v1",
      );
      await expect(open()).rejects.toThrow("MCP credential unavailable");
      for (const context of [
        { ...scope, tenantId: "tenant-j-b" },
        { ...scope, worldId: "other-world" },
        { ...scope, timelineId: "other-timeline" },
        { ...scope, installationId: "other-installation" },
        { ...scope, ownerPrincipalId: "principal-j-b" },
      ]) {
        const other = await open(context);
        try {
          expect(await other.read(reference)).toBeUndefined();
        } finally {
          await other.close();
        }
      }
      const row = (await provider.read(reference))!;
      expect(
        await provider.compareAndSwap(reference, row.revision + 1, {
          ...row,
          revision: row.revision + 2,
        }),
      ).toBe(false);
      expect((await provider.fence(reference))?.revocationRequested).toBe(true);
      const direct = connect(fixture.environment, "clockgrove", "clockgrove_admin");
      try {
        await direct.query("SET ROLE clockgrove_mcp_secrets");
        await direct.query(
          `SELECT set_config('mcp.tenant_id',$1,false),
          set_config('mcp.world_id',$2,false), set_config('mcp.timeline_id',$3,false),
          set_config('mcp.installation_id',$4,false), set_config('mcp.owner_principal_id',$5,false)`,
          [
            scope.tenantId,
            scope.worldId,
            scope.timelineId,
            scope.installationId,
            scope.ownerPrincipalId,
          ],
        );
        await expect(
          direct.query(
            "UPDATE clockgrove_mcp.credentials SET revocation_requested=false WHERE reference=$1",
            [reference],
          ),
        ).rejects.toThrow();
        await expect(
          direct.query("DELETE FROM clockgrove_mcp.credentials WHERE reference=$1", [reference]),
        ).rejects.toThrow();
      } finally {
        await direct.close();
      }
      expect(
        await provider.compareAndSwap(reference, row.revision, {
          ...row,
          revision: row.revision + 1,
        }),
      ).toBe(false);
      await expect(vault.use(scope, reference, async () => true)).rejects.toBeInstanceOf(
        McpCredentialError,
      );
      await vault.revoke(scope, reference);
      expect(
        await truth(
          "SELECT state || '/' || revocation_requested || '/' || (envelope->'ciphertext') || '/' || (envelope->'wrappedKey') FROM clockgrove_mcp.credentials",
        ),
      ).toBe("revoked/true/[]/[]");
      const fresh = await vault.store(scope, canary);
      await provider.close();
      const recovered = await open();
      try {
        expect((await recovered.read(fresh))?.revocationRequested).toBe(true);
        await expect(
          new McpCredentialVault(recovered, "credential-key-v1", keys).use(
            scope,
            fresh,
            async () => true,
          ),
        ).rejects.toThrow("MCP credential unavailable");
        expect(await recovered.compareAndSwap(fresh, null, row)).toBe(false);
      } finally {
        await recovered.close();
      }
      const uncertain = await open(scope, true);
      const uncertainVault = new McpCredentialVault(uncertain, "credential-key-v1", keys);
      const pendingFence = await uncertainVault.store(scope, canary);
      fault = "fence";
      await expect(uncertain.fence(pendingFence)).rejects.toThrow("MCP credential unavailable");
      await expect(uncertain.read(pendingFence)).rejects.toThrow("MCP credential unavailable");
      expect(
        await truth(
          `SELECT revocation_requested FROM clockgrove_mcp.credentials WHERE reference = '${pendingFence}'`,
        ),
      ).toBe("f");
      const reconciled = await open(scope, true);
      expect((await reconciled.read(pendingFence))?.revocationRequested).toBe(true);
      const reconciledVault = new McpCredentialVault(reconciled, "credential-key-v1", keys);
      const pendingRefresh = await reconciledVault.store(scope, canary);
      const active = (await reconciled.read(pendingRefresh))!;
      fault = "commit";
      await expect(
        reconciled.compareAndSwap(pendingRefresh, active.revision, {
          ...active,
          revision: active.revision + 1,
          state: "blocked",
        }),
      ).rejects.toThrow("MCP credential unavailable");
      await expect(reconciled.read(pendingRefresh)).rejects.toThrow("MCP credential unavailable");
      expect(
        await truth(
          `SELECT state FROM clockgrove_mcp.credentials WHERE reference = '${pendingRefresh}'`,
        ),
      ).toBe("blocked");
      const afterRefreshLoss = await open();
      try {
        expect((await afterRefreshLoss.read(pendingRefresh))?.revocationRequested).toBe(true);
      } finally {
        await afterRefreshLoss.close();
      }
      const ordinary = connect(fixture.environment);
      try {
        await expect(ordinary.query("SELECT * FROM clockgrove_mcp.credentials")).rejects.toThrow();
        await expect(ordinary.query("SET ROLE clockgrove_mcp_secrets")).rejects.toThrow();
      } finally {
        await ordinary.close();
      }
      expect(
        await truth(
          "SELECT count(*) FROM clockgrove.events WHERE payload::text LIKE '%mcp-canary%'",
        ),
      ).toBe("0");
    } finally {
      await provider.close();
    }
  });
}, 120_000);
