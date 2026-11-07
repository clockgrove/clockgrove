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
      // Decode only to locate the visible singleton. JournalRangeReader then verifies its scope,
      // sequence, registry and payload hash before any caller can use it.
      const sequence = upcastEventBytes(bytes, actorDecodeOptions(bytes)).partitionSequence;
      if (sequence <= previous || sequence < from || sequence > to)
        throw new TypeError("history source returned an invalid sequence");
      previous = sequence;
      const verified = new JournalRangeReader(
        {
          readPartitionRows: async () => ({ head: sequence, eventBytes: [bytes] }),
          readStreamRows: async () => {
            throw new TypeError("history reads partition sequences");
          },
        },
        JOURNAL_EVENT_REGISTRY,
      );
      events.push(...(await verified.readPartition(scope, { from: sequence, to: sequence })));
    }
    return { events: events.reverse(), beforeSequence: from > 1n ? from : null };
  }
}
