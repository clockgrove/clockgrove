import { canonicalBytes } from "@clockgrove/kernel";
import type { StreamSummary } from "./bundle.js";
import { compareText, plain, type Rec } from "./support.js";

/** Records hashed per batch. Batches cut by record index, so call and chunk boundaries do not matter. */
export const STREAM_BATCH = 1024;

/**
 * A bounded stand-in for an ordered record list: the record count and a chained SHA-256 digest
 * `digest = sha256(canonicalBytes([previous, batch]))` over consecutive batches of `STREAM_BATCH`
 * records (`previous` starts as null; the last, possibly empty, batch closes the chain). Two equal
 * record lists always give equal digests, however they were pushed.
 */
export class DigestStream {
  private digest: string | null = null;
  private pending: unknown[] = [];
  private count = 0;

  constructor(private readonly sha256: (bytes: Uint8Array) => Promise<string>) {}

  push(record: unknown): void {
    this.pending.push(record);
    this.count += 1;
  }

  /** Hashes every complete batch, keeping at most `STREAM_BATCH - 1` records pending. */
  async drain(): Promise<void> {
    let offset = 0;
    while (this.pending.length - offset >= STREAM_BATCH) {
      await this.fold(this.pending.slice(offset, offset + STREAM_BATCH));
      offset += STREAM_BATCH;
    }
    if (offset > 0) this.pending = this.pending.slice(offset);
  }

  /** Closes the chain with the remaining records and returns `{ count, digest }`. */
  async finish(): Promise<StreamSummary> {
    await this.drain();
    await this.fold(this.pending);
    this.pending = [];
    return { count: this.count, digest: this.digest };
  }

  private async fold(batch: readonly unknown[]): Promise<void> {
    this.digest = await this.sha256(canonicalBytes([this.digest, batch]));
  }
}

interface SubjectEntry {
  count: number;
  first: bigint;
  last: bigint;
}

/**
 * Per subject object and event type: how many events, and the first and last simulation time. Its
 * size grows with the objects and event types of the world, not with the horizon.
 */
export class SubjectTable {
  private readonly subjects = new Map<string, Map<string, SubjectEntry>>();

  add(objectId: string, type: string, time: bigint): void {
    let byType = this.subjects.get(objectId);
    if (byType === undefined) {
      byType = new Map();
      this.subjects.set(objectId, byType);
    }
    const entry = byType.get(type);
    if (entry === undefined) byType.set(type, { count: 1, first: time, last: time });
    else {
      entry.count += 1;
      entry.last = time;
    }
  }

  toRecords(): readonly Rec[] {
    return [...this.subjects]
      .sort(([left], [right]) => compareText(left, right))
      .map(([objectId, byType]) =>
        plain({
          objectId,
          events: [...byType]
            .sort(([left], [right]) => compareText(left, right))
            .map(([type, entry]) => ({ type, ...entry })),
        }),
      );
  }
}
