import type {
  EventEnvelope,
  EventTypeRegistry,
  PartitionId,
  StreamId,
  TenantId,
  TimelineId,
} from "@clockgrove/contracts";
import {
  EventTypeResolutionError,
  resolveEventType,
  upcastEventBytes,
} from "@clockgrove/contracts";

import { computePayloadHash } from "./journal-verification.js";
import { actorDecodeOptions } from "./replay.js";

export type StoredEvent = EventEnvelope<string, unknown>;

export interface StreamScope {
  readonly tenantId: TenantId;
  readonly timelineId: TimelineId;
  readonly streamId: StreamId;
}

export interface PartitionScope {
  readonly tenantId: TenantId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
}

/** Inclusive sequence range. `from` defaults to 1 and `to` to the current head. */
export interface SequenceRange {
  readonly from?: bigint;
  readonly to?: bigint;
}

/** Raw stored rows of one range read, in ascending sequence order, with the head they were read against. */
export interface JournalRangeRows {
  readonly head: bigint;
  readonly eventBytes: readonly Uint8Array[];
}

/** Persistence port. It reads under the caller's transaction-local authorization and does not interpret rows. */
export interface JournalRangeSource {
  readStreamRows(scope: StreamScope, range: SequenceRange): Promise<JournalRangeRows>;
  readPartitionRows(scope: PartitionScope, range: SequenceRange): Promise<JournalRangeRows>;
}

export type JournalReadIntegrityReason =
  | "sequence-gap"
  | "payload-hash-mismatch"
  | "unknown-event-type"
  | "unknown-event-version"
  | "malformed-event";

export class JournalReadIntegrityError extends Error {
  constructor(
    readonly reason: JournalReadIntegrityReason,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`journal read failed integrity verification (${reason}): ${detail}`, options);
    this.name = "JournalReadIntegrityError";
  }
}

/** Range reads that return ordered, upcast, hash-verified events or fail closed. */
export class JournalRangeReader {
  constructor(
    private readonly source: JournalRangeSource,
    private readonly registry: EventTypeRegistry,
  ) {}

  async readStream(scope: StreamScope, range: SequenceRange = {}): Promise<StoredEvent[]> {
    const normalized = normalizeRange(range);
    const rows = await this.source.readStreamRows(scope, normalized);
    return this.verify(
      rows,
      normalized,
      (event) =>
        event.tenantId === scope.tenantId &&
        event.timelineId === scope.timelineId &&
        event.streamId === scope.streamId,
      (event) => event.streamSequence,
    );
  }

  async readPartition(scope: PartitionScope, range: SequenceRange = {}): Promise<StoredEvent[]> {
    const normalized = normalizeRange(range);
    const rows = await this.source.readPartitionRows(scope, normalized);
    return this.verify(
      rows,
      normalized,
      (event) =>
        event.tenantId === scope.tenantId &&
        event.timelineId === scope.timelineId &&
        event.partitionId === scope.partitionId,
      (event) => event.partitionSequence,
    );
  }

  private verify(
    rows: JournalRangeRows,
    range: SequenceRange & { readonly from: bigint },
    inScope: (event: StoredEvent) => boolean,
    sequenceOf: (event: StoredEvent) => bigint,
  ): StoredEvent[] {
    const last = range.to === undefined || range.to > rows.head ? rows.head : range.to;
    const events: StoredEvent[] = [];
    let expected = range.from;
    for (const bytes of rows.eventBytes) {
      const event = this.decode(bytes);
      if (!inScope(event)) {
        throw new JournalReadIntegrityError(
          "malformed-event",
          `${event.eventId} is outside the requested scope`,
        );
      }
      if (sequenceOf(event) !== expected) {
        throw new JournalReadIntegrityError(
          "sequence-gap",
          `expected sequence ${expected}, read ${sequenceOf(event)}`,
        );
      }
      expected += 1n;
      events.push(event);
    }
    if (expected <= last) {
      throw new JournalReadIntegrityError("sequence-gap", `sequence ${expected} is missing`);
    }
    return events;
  }

  private decode(bytes: Uint8Array): StoredEvent {
    let event: StoredEvent;
    let hash: string;
    try {
      event = upcastEventBytes(bytes, actorDecodeOptions(bytes));
      hash = computePayloadHash(event.payload);
    } catch (error) {
      if (error instanceof Error) {
        throw new JournalReadIntegrityError("malformed-event", error.message, { cause: error });
      }
      throw error;
    }
    try {
      resolveEventType(this.registry, event.type, event.schemaVersion);
    } catch (error) {
      if (error instanceof EventTypeResolutionError) {
        throw new JournalReadIntegrityError(
          error.reason === "unknown-type" ? "unknown-event-type" : "unknown-event-version",
          `${event.eventId} has ${event.type} at schema version ${event.schemaVersion}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (event.payloadHash !== hash) {
      throw new JournalReadIntegrityError(
        "payload-hash-mismatch",
        `${event.eventId} hashes to ${hash}`,
      );
    }
    return event;
  }
}

function normalizeRange(range: SequenceRange): SequenceRange & { readonly from: bigint } {
  const from = range.from ?? 1n;
  if (from < 1n) throw new RangeError("range.from must be at least 1");
  return range.to === undefined ? { from } : { from, to: range.to };
}
