import {
  InspectorRateLimitedError,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import type { BrowserScope, PrincipalId, TenantId, UsageEvent } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** One webhook: the space and the principal who registered it. */
export interface UsageWebhookKey {
  readonly tenantId: string;
  readonly principalId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly spaceId: string;
}

export interface ClaimedUsageWebhook {
  readonly webhookId: string;
  readonly url: string;
  /** The sequence of the last event already delivered. */
  readonly deliveredThrough: string;
}

export type UsageWebhookOutcome =
  /** Every event up to `through` was delivered; `null` when there was none to send. */
  | { readonly delivered: true; readonly through: string | null }
  /** `status` is `http_<code>`, `timeout` or `network`. */
  | { readonly delivered: false; readonly status: string };

/** The sweep acts as the registrar: row-level security then holds it to what they may read. */
export function usageWebhookAuthorization(key: UsageWebhookKey): RuntimeAuthorizationContext {
  return {
    tenantId: key.tenantId as TenantId,
    principalId: key.principalId as PrincipalId,
    privacyCeiling: { version: 1, allowedCategories: ["operator_evidence"] },
  };
}

/**
 * Usage webhooks (0083): registration, the due-webhook scan, and the cursor and retry state of a
 * delivery. Every read and write runs as the registrar under row-level security.
 */
export class PostgreSqlUsageWebhooks {
  constructor(private readonly client: PostgreSqlClient) {}

  /**
   * Registers or replaces the webhook, keeping its ID and cursor; `null` disables it. The
   * `usage-webhook` audit row (`auditEntry`: the URL's origin or `disabled`) is written in the same
   * transaction, so a standing export never exists without its audit row.
   */
  async register(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    url: string | null,
    auditEntry: string,
  ): Promise<string> {
    const found = await this.within(authorization, async (query) => {
      const rows = await query(
        `INSERT INTO clockgrove.usage_webhooks
           (tenant_id, world_id, timeline_id, space_id, principal_id, webhook_id, url)
         VALUES ($1, $2, $3, $4, $5, gen_random_uuid()::text, $6)
         ON CONFLICT (tenant_id, world_id, timeline_id, space_id, principal_id) DO UPDATE
           SET url = excluded.url, attempts = 0, next_attempt_at = statement_timestamp(),
               last_status = NULL, updated_at = statement_timestamp()
         RETURNING webhook_id`,
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          authorization.principalId,
          url,
        ],
      );
      await query(
        "SELECT clockgrove.record_inspector_access($1, $2, $3, NULL, 'allow', 'served', 'usage-webhook', $4)",
        [scope.worldId, scope.timelineId, scope.spaceId, auditEntry],
      );
      return rows;
    }).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "CG013") throw new InspectorRateLimitedError();
      throw error;
    });
    return String(found[0]?.webhook_id);
  }

  /** Webhooks whose turn has come, the longest-waiting first. */
  async due(limit: number): Promise<UsageWebhookKey[]> {
    const found = await this.client.query(
      "SELECT tenant_id, principal_id, world_id, timeline_id, space_id FROM clockgrove.due_usage_webhooks($1)",
      [limit],
    );
    return (found.rows as Row[]).map((row) => ({
      tenantId: String(row.tenant_id),
      principalId: String(row.principal_id),
      worldId: String(row.world_id),
      timelineId: String(row.timeline_id),
      spaceId: String(row.space_id),
    }));
  }

  /**
   * Takes the webhook for `leaseMs` unless another sweep holds it, it is not yet due, or its
   * registrar lost `runtime:usage-webhook` since the due listing.
   */
  async claim(key: UsageWebhookKey, leaseMs: number): Promise<ClaimedUsageWebhook | null> {
    const found = await this.within(usageWebhookAuthorization(key), (query) =>
      query(
        `UPDATE clockgrove.usage_webhooks
            SET lease_until = statement_timestamp() + make_interval(secs => $6::double precision / 1000)
          WHERE ${KEY} AND url IS NOT NULL AND next_attempt_at <= statement_timestamp()
            AND (lease_until IS NULL OR lease_until <= statement_timestamp())
        RETURNING webhook_id, url, delivered_through::text AS delivered_through`,
        [...keyValues(key), leaseMs],
      ),
    ).catch(notDue);
    const row = found[0];
    return row === undefined
      ? null
      : {
          webhookId: String(row.webhook_id),
          url: String(row.url),
          deliveredThrough: String(row.delivered_through),
        };
  }

  /** The space's usage events after the cursor, in sequence order. */
  async pending(
    key: UsageWebhookKey,
    deliveredThrough: string,
    limit: number,
  ): Promise<UsageEvent[]> {
    const rows = await this.within(usageWebhookAuthorization(key), (query) =>
      query(
        `SELECT event_id, sequence::text AS sequence, world_id, timeline_id, space_id, category,
                source, resource, status, outcome_code, principal_id, persona_id, actor_id,
                session_id, run_id, root_run_id, quantities,
                to_char(occurred_at AT TIME ZONE 'UTC', ${ISO}) AS occurred_at,
                world_time::text AS world_time
           FROM clockgrove.usage_events
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
            AND sequence > $5::bigint
          ORDER BY sequence LIMIT $6`,
        [key.tenantId, key.worldId, key.timelineId, key.spaceId, deliveredThrough, limit],
      ),
    );
    return rows.map(eventOf);
  }

  /**
   * Records a delivery's end and releases the lease. A registrar who lost `runtime:usage-webhook`
   * since the due listing changes nothing: the cursor stays and the lease runs out. Success moves the cursor and is due again at
   * once; failure keeps the cursor and waits 2^attempts seconds, at most 300.
   */
  async settle(key: UsageWebhookKey, outcome: UsageWebhookOutcome): Promise<void> {
    const authorization = usageWebhookAuthorization(key);
    await this.within(authorization, (query) =>
      outcome.delivered
        ? query(
            `UPDATE clockgrove.usage_webhooks
                SET delivered_through = coalesce($6::bigint, delivered_through), attempts = 0,
                    next_attempt_at = statement_timestamp(), last_status = 'delivered',
                    lease_until = NULL, updated_at = statement_timestamp()
              WHERE ${KEY}`,
            [...keyValues(key), outcome.through],
          )
        : query(
            `UPDATE clockgrove.usage_webhooks
                SET attempts = attempts + 1,
                    next_attempt_at = statement_timestamp()
                      + make_interval(secs => least(power(2, least(attempts + 1, 9)), 300)),
                    last_status = $6, lease_until = NULL, updated_at = statement_timestamp()
              WHERE ${KEY}`,
            [...keyValues(key), outcome.status],
          ),
    ).catch(notDue);
  }

  private within(
    authorization: RuntimeAuthorizationContext,
    operation: (
      query: (text: string, values: readonly unknown[]) => Promise<Row[]>,
    ) => Promise<Row[]>,
  ): Promise<Row[]> {
    return withClientTransaction(this.client, { authorization }, () =>
      operation(async (text, values) => (await this.client.query(text, values)).rows as Row[]),
    );
  }
}

/**
 * Row-level security refused the update (`42501`): the registrar lost `runtime:usage-webhook` after
 * the due listing, so the webhook is no longer due. It changes nothing, as an unlisted one would.
 */
function notDue(error: unknown): Row[] {
  if ((error as { code?: unknown }).code === "42501") return [];
  throw error;
}

const KEY =
  "tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4 AND principal_id = $5";

function keyValues(key: UsageWebhookKey): string[] {
  return [key.tenantId, key.worldId, key.timelineId, key.spaceId, key.principalId];
}

function eventOf(row: Row): UsageEvent {
  return {
    eventId: String(row.event_id),
    sequence: String(row.sequence),
    worldId: String(row.world_id),
    timelineId: String(row.timeline_id),
    spaceId: String(row.space_id),
    category: row.category as UsageEvent["category"],
    source: row.source as UsageEvent["source"],
    resource: nullable(row.resource),
    status: String(row.status),
    outcomeCode: nullable(row.outcome_code),
    principalId: String(row.principal_id),
    personaId: nullable(row.persona_id),
    actorId: String(row.actor_id),
    sessionId: String(row.session_id),
    runId: nullable(row.run_id),
    rootRunId: nullable(row.root_run_id),
    quantities: row.quantities as UsageEvent["quantities"],
    occurredAt: String(row.occurred_at),
    worldTime: nullable(row.world_time),
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
