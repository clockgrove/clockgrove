import type { RuntimeAuthorizationContext } from "@clockgrove/application";
import type { UsageEvent, UsagePage, UsageQueryRequest } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * Reads usage events for an inspector. Row visibility is the policy of 0076 (a member of the exact
 * space holding `runtime:world-inspect` under an `operator_evidence` ceiling); this adds the world,
 * timeline and space scope, the player, the optional half-open window (none is the feed) and the sequence cursor.
 */
export class PostgreSqlUsageReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async query(
    authorization: RuntimeAuthorizationContext,
    input: UsageQueryRequest,
  ): Promise<UsagePage> {
    const { scope } = input;
    const rows = await withClientTransaction(this.client, { authorization }, async () => {
      const found = await this.client.query(
        `SELECT event_id, sequence::text AS sequence, world_id, timeline_id, space_id, category,
                source, resource, status, outcome_code, principal_id, persona_id, actor_id,
                session_id, run_id, root_run_id, quantities,
                to_char(occurred_at AT TIME ZONE 'UTC', ${ISO}) AS occurred_at,
                world_time::text AS world_time
           FROM clockgrove.usage_events
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
            AND ($5::text IS NULL OR principal_id = $5)
            AND ($6::timestamptz IS NULL OR occurred_at >= $6::timestamptz)
            AND ($7::timestamptz IS NULL OR occurred_at < $7::timestamptz)
            AND ($8::bigint IS NULL OR sequence > $8::bigint)
          ORDER BY sequence LIMIT $9`,
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.spaceId,
          input.principalId ?? null,
          input.from ?? null,
          input.to ?? null,
          input.after ?? null,
          input.limit,
        ],
      );
      return found.rows as Row[];
    });
    const events = rows.map(eventOf);
    return {
      events,
      // Decision: a page holds at most 100 events, as a run walk's page (MAX_WALK_RUNS).
      next: events.length === input.limit ? (events[events.length - 1]?.sequence ?? null) : null,
    };
  }
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
