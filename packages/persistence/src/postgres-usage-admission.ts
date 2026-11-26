import {
  InspectorRateLimitedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import type { BrowserScope, UsageBudget } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

/**
 * Budgets and the admission hook (0084, `docs/protocols/usage.md`, "Admission before spend"). Each
 * change runs as the caller, and its audit row commits in the same transaction, so a limit never
 * changes without a record.
 */
export class PostgreSqlUsageAdmission {
  constructor(private readonly client: PostgreSqlClient) {}

  /** Sets one budget of the space and lists all of them. */
  async setBudget(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    budget: UsageBudget,
  ): Promise<UsageBudget[]> {
    const { scope: who, category, quantity, period, limit } = budget;
    const rows = await this.within(authorization, async (query) => {
      const found = await query(
        "SELECT * FROM clockgrove.set_usage_budget($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          who,
          category,
          quantity,
          period,
          limit,
        ],
      );
      await query(
        "SELECT clockgrove.record_inspector_access($1, $2, $3, NULL, 'allow', 'served', 'usage-budget', $4)",
        [
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          `${who}:${category}:${quantity}:${period}`,
        ],
      );
      return found;
    });
    return rows.map((row) => ({
      scope: row.scope as UsageBudget["scope"],
      category: row.category as UsageBudget["category"],
      quantity: row.quantity as UsageBudget["quantity"],
      period: row.period as UsageBudget["period"],
      limit: row.max_quantity === null ? null : Number(row.max_quantity),
    }));
  }

  /** Registers, replaces or (with a `null` URL) disables the space's hook; returns its ID. */
  async registerHook(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    url: string | null,
    auditEntry: string,
  ): Promise<string> {
    const rows = await this.within(authorization, async (query) => {
      const found = await query(
        "SELECT clockgrove.register_usage_admission_hook($1,$2,$3,$4,$5) AS id",
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId, url],
      );
      await query(
        "SELECT clockgrove.record_inspector_access($1, $2, $3, NULL, 'allow', 'served', 'usage-admission-hook', $4)",
        [scope.worldId, scope.timelineId, scope.spaceId, auditEntry],
      );
      return found;
    });
    return String(rows[0]?.id);
  }

  private within(
    authorization: RuntimeAuthorizationContext,
    operation: (
      query: (text: string, values: readonly unknown[]) => Promise<Row[]>,
    ) => Promise<Row[]>,
  ): Promise<Row[]> {
    return withClientTransaction(this.client, { authorization }, () =>
      operation(async (text, values) => (await this.client.query(text, values)).rows as Row[]),
    ).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "CG013") throw new InspectorRateLimitedError();
      throw error;
    });
  }
}
