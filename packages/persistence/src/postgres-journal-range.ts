import type {
  JournalRangeRows,
  JournalRangeSource,
  PartitionScope,
  RuntimeAuthorizationContext,
  SequenceRange,
  StreamScope,
} from "@clockgrove/application";

import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

/**
 * Supplies raw event rows of one stream or partition under the transaction-local tenant and
 * privacy authorization. Rows hidden by the privacy ceiling are simply absent; the application
 * layer turns that into a sequence gap.
 */
export class PostgreSqlJournalRangeSource implements JournalRangeSource {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly authorization: RuntimeAuthorizationContext,
  ) {}

  readStreamRows(scope: StreamScope, range: SequenceRange): Promise<JournalRangeRows> {
    return this.read(
      `SELECT current_sequence::text AS head FROM clockgrove.streams
        WHERE tenant_id = $1 AND timeline_id = $2 AND stream_id = $3`,
      "stream_sequence",
      [scope.tenantId, scope.timelineId, scope.streamId],
      "stream_id",
      range,
    );
  }

  readPartitionRows(scope: PartitionScope, range: SequenceRange): Promise<JournalRangeRows> {
    return this.read(
      `SELECT head_sequence::text AS head FROM clockgrove.timeline_partitions
        WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
      "partition_sequence",
      [scope.tenantId, scope.timelineId, scope.partitionId],
      "partition_id",
      range,
    );
  }

  private async read(
    headSql: string,
    sequenceColumn: "stream_sequence" | "partition_sequence",
    scope: readonly [string, string, string],
    scopeColumn: "stream_id" | "partition_id",
    range: SequenceRange,
  ): Promise<JournalRangeRows> {
    const [head, rows] = await withClientTransaction(
      this.client,
      { authorization: this.authorization },
      async () => [
        await this.client.query(headSql, scope),
        await this.client.query(
          `SELECT event_bytes FROM clockgrove.events
            WHERE tenant_id = $1 AND timeline_id = $2 AND ${scopeColumn} = $3
              AND ${sequenceColumn} >= $4::bigint
              AND ($5::bigint IS NULL OR ${sequenceColumn} <= $5::bigint)
            ORDER BY ${sequenceColumn}`,
          [...scope, String(range.from ?? 1n), range.to === undefined ? null : String(range.to)],
        ),
      ],
    );
    return { head: decodeHead(head.rows[0]), eventBytes: rows.rows.map(decodeEventBytes) };
  }
}

function decodeHead(row: unknown): bigint {
  if (row === undefined) return 0n;
  if (typeof row !== "object" || row === null || !("head" in row) || typeof row.head !== "string") {
    throw new TypeError("PostgreSQL returned a malformed journal head");
  }
  return BigInt(row.head);
}

function decodeEventBytes(row: unknown): Uint8Array {
  if (
    typeof row !== "object" ||
    row === null ||
    !("event_bytes" in row) ||
    !(row.event_bytes instanceof Uint8Array)
  ) {
    throw new TypeError("PostgreSQL returned malformed event bytes");
  }
  return row.event_bytes;
}
