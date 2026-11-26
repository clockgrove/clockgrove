import {
  InspectorRateLimitedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import {
  type BrowserScope,
  ContractDecodeError,
  type UsageBudget,
  type WorldModeState,
  type WorldOffer,
  type WorldOfferRequest,
} from "@clockgrove/contracts";
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

  /** Sets the space's mode (0085), audited as `world-mode` with the mode, and answers it. */
  async setMode(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    state: WorldModeState,
  ): Promise<WorldModeState> {
    const rows = await this.within(authorization, async (query) => {
      const found = await query("SELECT * FROM clockgrove.set_world_mode($1,$2,$3,$4,$5,$6)", [
        scope.tenantId,
        scope.worldId,
        scope.timelineId,
        scope.spaceId,
        state.mode,
        state.reason,
      ]);
      await query(
        "SELECT clockgrove.record_inspector_access($1, $2, $3, NULL, 'allow', 'served', 'world-mode', $4)",
        [scope.worldId, scope.timelineId, scope.spaceId, state.mode],
      );
      return found;
    });
    return {
      mode: rows[0]?.mode as WorldModeState["mode"],
      reason: (rows[0]?.reason as string | null | undefined) ?? null,
    };
  }

  /**
   * Sets or (with `offer: null`) withdraws one offer of the space (0086), audited as `world-offer`
   * with the offer's ID, and answers the space's offers. A space holds at most 100 offer ids, withdrawn ones included.
   */
  async setOffer(
    authorization: RuntimeAuthorizationContext,
    request: WorldOfferRequest,
  ): Promise<WorldOffer[]> {
    const { scope, offerId, offer } = request;
    const rows = await this.within(authorization, async (query) => {
      const found = await query(
        "SELECT * FROM clockgrove.set_world_offer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          offerId,
          offer?.actorId ?? null,
          offer?.title ?? null,
          offer?.text ?? null,
          offer?.checkoutUrl ?? null,
          offer === null,
        ],
      );
      await query(
        "SELECT clockgrove.record_inspector_access($1, $2, $3, NULL, 'allow', 'served', 'world-offer', $4)",
        [scope.worldId, scope.timelineId, scope.spaceId, offerId],
      );
      return found;
    }).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "54000")
        throw new ContractDecodeError(
          "worldOffer.offerId",
          "at most 100 offer ids a space, withdrawn ones included: set a withdrawn id again to reuse it",
        );
      throw error;
    });
    return rows.map(worldOfferOf);
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

/** An offer row of `space_offers`, `show_offers` or `choose_offer`. */
export function worldOfferOf(row: Row): WorldOffer {
  return {
    offerId: String(row.offer_id),
    actorId: String(row.actor_id),
    title: String(row.title),
    text: String(row.body),
    checkoutUrl: row.checkout_url === null ? null : String(row.checkout_url),
  };
}
