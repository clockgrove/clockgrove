import { RESOURCE_KINDS, type WorldState } from "@clockgrove/domain";
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

  toRecords(idKey = "objectId"): readonly Rec[] {
    return [...this.subjects]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, byType]) =>
        plain({
          [idKey]: id,
          events: [...byType]
            .sort(([left], [right]) => compareText(left, right))
            .map(([type, entry]) => ({ type, ...entry })),
        }),
      );
  }
}

const RESOURCE_TYPES = new Set([
  "object.created",
  "object.retired",
  "resource.offered",
  "resource.consumed",
  "resource.appeared",
  "resource.spoiled",
  "resource.weather-integrated",
  "growth.stage-changed",
  "resource.boundary-exchanged",
]);

const big = (value: unknown): bigint => BigInt(value as number | bigint | string);

/**
 * The simulator's own ledger of resource quantity, kept apart from the kernel's conservation
 * invariant: per event type, the net signed quantity it added to the world's total of each resource
 * kind. Transfers move quantity between holders and net zero, so they are not recorded.
 */
export class ResourceLedger {
  private readonly causes = new Map<string, Map<string, bigint>>();
  private readonly initial: Record<string, bigint>;

  constructor(seed: WorldState) {
    this.initial = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, 0n]));
    for (const entity of seed.entities)
      if (entity.resource !== undefined)
        this.initial[entity.resource.kind] =
          (this.initial[entity.resource.kind] ?? 0n) + big(entity.resource.quantity);
  }

  add(event: { readonly type: string; readonly payload: unknown }): void {
    if (!RESOURCE_TYPES.has(event.type)) return;
    const payload = event.payload as Rec;
    let kind = payload.kind as string | null | undefined;
    let delta: bigint;
    switch (event.type) {
      case "object.created": {
        const resource = (payload.object as Rec).resource as Rec | undefined;
        if (resource === undefined) return;
        kind = resource.kind as string;
        delta = big(payload.quantityAdded);
        break;
      }
      case "object.retired":
        delta = -big(payload.quantityRemoved);
        break;
      case "resource.consumed":
      case "resource.spoiled":
        delta = -big(payload.quantity);
        break;
      case "resource.weather-integrated":
        kind = "water";
        delta = big(payload.collected) - big(payload.evaporated);
        break;
      case "growth.stage-changed": {
        const produced = payload.yield as Rec | undefined;
        if (produced === undefined) return;
        kind = "food";
        delta = big(produced.quantity);
        break;
      }
      case "resource.boundary-exchanged":
        delta = big(payload.quantity) * (payload.direction === "import" ? 1n : -1n);
        break;
      default:
        delta = big(payload.quantity);
    }
    if (kind === undefined || kind === null) return;
    const byType = this.causes.get(kind) ?? new Map<string, bigint>();
    byType.set(event.type, (byType.get(event.type) ?? 0n) + delta);
    this.causes.set(kind, byType);
  }

  toRecords(): readonly Rec[] {
    return RESOURCE_KINDS.map((kind) => ({
      kind,
      initial: this.initial[kind] ?? 0n,
      causes: [...(this.causes.get(kind) ?? [])]
        .sort(([left], [right]) => compareText(left, right))
        .map(([type, quantity]) => ({ type, quantity })),
    }));
  }
}
