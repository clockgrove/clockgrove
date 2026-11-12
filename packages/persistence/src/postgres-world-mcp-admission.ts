import type { WorldMcpAdmissionStore } from "@clockgrove/application";
import type { PrincipalId } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export class PostgreSqlWorldMcpAdmission implements WorldMcpAdmissionStore {
  constructor(private readonly client: PostgreSqlClient) {}

  async reserve(
    principalId: PrincipalId,
    phase: "exchange" | "body",
    workUnits: number,
  ): Promise<boolean> {
    return withClientTransaction(this.client, {}, async () => {
      await this.client.query("SELECT set_config('app.principal_id', $1, true)", [principalId]);
      const result = await this.client.query(
        "SELECT clockgrove.reserve_world_mcp_request($1, $2) AS admitted",
        [phase, workUnits],
      );
      return (result.rows[0] as { admitted?: unknown } | undefined)?.admitted === true;
    });
  }
}
