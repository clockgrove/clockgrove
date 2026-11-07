import {
  InspectorRateLimitedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

export type InspectorAccessReason =
  | "served"
  | "not-found"
  | "failed"
  | "world-participation-absent"
  | "runtime-grant-missing"
  | "authority-mismatch";

/**
 * One inspector access. Tenant and principal come from the installed authorization only. The
 * causal chain names its command; a runtime-state access (0031), a client view (0033) and a run
 * walk or search (0036) name none; an event or scheduled-action entry (0033) names the entry it
 * started from.
 */
export type InspectorAccess = {
  readonly worldId: string;
  readonly timelineId: string;
  readonly spaceId: string;
  readonly decision: "allow" | "deny";
  readonly reasonCode: InspectorAccessReason;
} & (
  | { readonly subject?: "causal-chain"; readonly commandId: string }
  | {
      readonly subject: "runtime-state" | "client-view" | "agent-runs";
      readonly commandId?: undefined;
      readonly entryId?: undefined;
    }
  | {
      readonly subject: "event" | "scheduled-action";
      readonly commandId?: undefined;
      readonly entryId: string;
    }
);

/**
 * Appends the audit row through `record_inspector_access` (migrations 0022, 0031, 0033) in its own
 * transaction, so a denial or a failed read is still recorded. The runtime role cannot read the
 * table. Both calls enforce the per-principal rate limit (migration 0028), shared by every subject,
 * with `InspectorRateLimitedError`.
 */
export class PostgreSqlInspectorAudit {
  constructor(private readonly client: PostgreSqlClient) {}

  /** Refuses a tenant member over the limit before anything is read. */
  async admit(authorization: RuntimeAuthorizationContext): Promise<void> {
    const admitted = await withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        "SELECT clockgrove.inspector_access_admitted() AS admitted",
      );
      return (result.rows[0] as { admitted?: unknown } | undefined)?.admitted;
    });
    if (admitted !== true) throw new InspectorRateLimitedError();
  }

  async record(authorization: RuntimeAuthorizationContext, access: InspectorAccess): Promise<void> {
    try {
      await withClientTransaction(this.client, { authorization }, async () => {
        await this.client.query(
          "SELECT clockgrove.record_inspector_access($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            access.worldId,
            access.timelineId,
            access.spaceId,
            access.commandId ?? null,
            access.decision,
            access.reasonCode,
            access.subject ?? "causal-chain",
            "entryId" in access ? (access.entryId ?? null) : null,
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "CG013") throw new InspectorRateLimitedError();
      throw error;
    }
  }
}
