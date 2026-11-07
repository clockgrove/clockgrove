import type { EventEnvelope, TenantId, TimelineId } from "@clockgrove/contracts";
import { decodeActorTargetBinding, upcastEventBytes } from "@clockgrove/contracts";

export interface JournalReplayScope {
  readonly tenantId: TenantId;
  readonly timelineId: TimelineId;
}

/** Journal bytes are read in PostgreSQL ingestion order. */
export interface JournalEventReader {
  readEventBytes(scope: JournalReplayScope): AsyncIterable<Uint8Array>;
}

export interface ReplayEvidence<TState> {
  readonly state: TState;
  readonly eventCount: number;
  readonly lastJournalPosition?: bigint;
  readonly serializedState: string;
}

export async function replayJournal<TState>(
  reader: JournalEventReader,
  scope: JournalReplayScope,
  initialState: TState,
  reduce: (state: TState, event: EventEnvelope<string, unknown>) => TState,
): Promise<ReplayEvidence<TState>> {
  let state = initialState;
  let eventCount = 0;
  let lastJournalPosition: bigint | undefined;
  for await (const bytes of reader.readEventBytes(scope)) {
    const event = upcastEventBytes(bytes, actorDecodeOptions(bytes));
    if (event.tenantId !== scope.tenantId || event.timelineId !== scope.timelineId) {
      throw new Error("journal reader returned an event outside the requested replay scope");
    }
    if (lastJournalPosition !== undefined && event.journalPosition <= lastJournalPosition) {
      throw new Error("journal reader returned non-increasing ingestion positions");
    }
    state = reduce(state, event);
    eventCount += 1;
    lastJournalPosition = event.journalPosition;
  }
  return {
    state,
    eventCount,
    ...(lastJournalPosition === undefined ? {} : { lastJournalPosition }),
    serializedState: deterministicSerialize(state),
  };
}

export function actorDecodeOptions(bytes: Uint8Array) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const actor = (parsed as Record<string, unknown>).actor;
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return {};
  const value = actor as Record<string, unknown>;
  return {
    actorBinding: decodeActorTargetBinding({
      tenantId: value.tenantId,
      worldId: value.worldId,
      timelineId: value.timelineId,
      kind: value.kind,
      id: value.id,
    }),
  };
}

/** Engineering choice: sorted JSON keys and decimal bigint strings. */
export function deterministicSerialize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}
