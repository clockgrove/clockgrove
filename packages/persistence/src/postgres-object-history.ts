import {
  actorDecodeOptions,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  type PartitionScope,
  type RuntimeAuthorizationContext,
  type StoredEvent,
} from "@clockgrove/application";
import { upcastEventBytes } from "@clockgrove/contracts";
import { PostgreSqlJournalRangeSource } from "./postgres-journal-range.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

// Decision (issue 354): at most the newest 10,000 sequences below the head are scanned, bounding the
// work on the unique (tenant, timeline, partition, partition_sequence) index without a migration;
// that covers 40 ticks of 50 actors writing 5 events each.
const MATERIAL_SCAN_SEQUENCES = 10_000n;
// Each further page doubles, up to this cap, so a read that keeps little reaches the floor in a
// bounded number of round trips: 100, 200, 400, 800, 1,600 then 2,000-row pages, at most 9 queries
// for the 10,000-sequence window.
const MATERIAL_PAGE_CAP = 2_000;

/** Bounded public windows; privacy-hidden sequence gaps are not fabricated missing events. */
export class PostgreSqlObjectHistoryReader {
  constructor(private readonly client: PostgreSqlClient) {}

  async read(
    authorization: RuntimeAuthorizationContext,
    scope: PartitionScope,
    beforeSequence: bigint,
  ): Promise<{ events: readonly StoredEvent[]; beforeSequence: bigint | null }> {
    // Implementation work bound, not a lifetime retention policy: continue through older windows.
    const windowSize = 100n;
    const to = beforeSequence - 1n;
    if (to < 1n) return { events: [], beforeSequence: null };
    const from = to >= windowSize ? to - windowSize + 1n : 1n;
    const rows = await new PostgreSqlJournalRangeSource(
      this.client,
      authorization,
    ).readPartitionRows(scope, { from, to });
    const events: StoredEvent[] = [];
    let previous = from - 1n;
    for (const bytes of rows.eventBytes) {
      const sequence = this.sequenceOf(bytes);
      if (sequence <= previous || sequence < from || sequence > to)
        throw new TypeError("history source returned an invalid sequence");
      previous = sequence;
      events.push(...(await this.verify(scope, bytes, sequence)));
    }
    return { events: events.reverse(), beforeSequence: from > 1n ? from : null };
  }

  /**
   * The newest visible events of the given types that `keep` accepts, in the bounded scan below
   * `beforeSequence`, newest first. Privacy-hidden rows are absent. Rows `keep` refuses do not
   * count toward `limit`: the read continues down to the scan floor until `limit` are kept.
   */
  async readTypes(
    authorization: RuntimeAuthorizationContext,
    scope: PartitionScope,
    beforeSequence: bigint,
    eventTypes: readonly string[],
    limit: number,
    keep: (event: StoredEvent) => boolean = () => true,
  ): Promise<readonly StoredEvent[]> {
    const floor = beforeSequence - MATERIAL_SCAN_SEQUENCES;
    const lowest = floor < 1n ? 1n : floor;
    const events: StoredEvent[] = [];
    await withClientTransaction(this.client, { authorization }, async () => {
      let cursor = beforeSequence;
      let page = limit;
      while (events.length < limit && cursor > lowest) {
        const rows = await this.client.query(
          `SELECT event_bytes FROM clockgrove.events
            WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3
              AND partition_sequence < $4::bigint AND partition_sequence >= $5::bigint
              AND event_type = ANY($6::text[])
            ORDER BY partition_sequence DESC LIMIT $7`,
          [
            scope.tenantId,
            scope.timelineId,
            scope.partitionId,
            String(cursor),
            String(lowest),
            [...eventTypes],
            page,
          ],
        );
        for (const row of rows.rows) {
          const bytes = (row as { event_bytes?: unknown }).event_bytes;
          if (!(bytes instanceof Uint8Array))
            throw new TypeError("PostgreSQL returned malformed event bytes");
          const sequence = this.sequenceOf(bytes);
          if (sequence >= cursor || sequence < lowest)
            throw new TypeError("history source returned an invalid sequence");
          cursor = sequence;
          for (const event of await this.verify(scope, bytes, sequence))
            if (events.length < limit && keep(event)) events.push(event);
        }
        if (rows.rows.length < page) break;
        page = Math.min(page * 2, Math.max(MATERIAL_PAGE_CAP, limit));
      }
    });
    return events;
  }

  private sequenceOf(bytes: Uint8Array): bigint {
    // Decode only to locate the visible singleton; verify() then checks it before any use.
    return upcastEventBytes(bytes, actorDecodeOptions(bytes)).partitionSequence;
  }

  private verify(
    scope: PartitionScope,
    bytes: Uint8Array,
    sequence: bigint,
  ): Promise<readonly StoredEvent[]> {
    // JournalRangeReader verifies scope, sequence, registry and payload hash.
    return new JournalRangeReader(
      {
        readPartitionRows: async () => ({ head: sequence, eventBytes: [bytes] }),
        readStreamRows: async () => {
          throw new TypeError("history reads partition sequences");
        },
      },
      JOURNAL_EVENT_REGISTRY,
    ).readPartition(scope, { from: sequence, to: sequence });
  }
}
