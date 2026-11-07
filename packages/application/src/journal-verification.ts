import type { EventId, EventTypeRegistry } from "@clockgrove/contracts";
import { EventTypeResolutionError, resolveEventType } from "@clockgrove/contracts";
import { canonicalBytes, sha256Hex } from "@clockgrove/kernel";

import type {
  Journal,
  JournalEventDraft,
  JournalExecuteRequest,
  JournalExecuteResult,
} from "./journal.js";

export type JournalDraftRefusalReason =
  | "payload-hash-mismatch"
  | "unknown-event-type"
  | "unknown-event-version"
  | "payload-not-json-stable";

export class JournalDraftRefusedError extends Error {
  constructor(
    readonly reason: JournalDraftRefusalReason,
    readonly eventId: EventId,
  ) {
    super(`journal draft ${eventId} was refused: ${reason}`);
    this.name = "JournalDraftRefusedError";
  }
}

/** `sha256:` plus the lowercase hex SHA-256 of the payload's kernel canonical bytes. */
export function computePayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalBytes(payload))}`;
}

/**
 * The stored form of a payload is its JSON text, so a payload is only storable when its canonical
 * bytes survive that round trip. Values canonical bytes cannot encode are not storable either.
 */
function isJsonStable(payload: unknown): boolean {
  try {
    const before = canonicalBytes(payload);
    const stored: unknown = JSON.parse(JSON.stringify(payload));
    const after = canonicalBytes(stored);
    return before.length === after.length && before.every((byte, index) => byte === after[index]);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function verifyDraft(draft: JournalEventDraft, registry: EventTypeRegistry): void {
  try {
    resolveEventType(registry, draft.type, draft.schemaVersion);
  } catch (error) {
    if (error instanceof EventTypeResolutionError) {
      throw new JournalDraftRefusedError(
        error.reason === "unknown-type" ? "unknown-event-type" : "unknown-event-version",
        draft.eventId,
      );
    }
    throw error;
  }
  if (!isJsonStable(draft.payload)) {
    throw new JournalDraftRefusedError("payload-not-json-stable", draft.eventId);
  }
  if (draft.payloadHash !== computePayloadHash(draft.payload)) {
    throw new JournalDraftRefusedError("payload-hash-mismatch", draft.eventId);
  }
}

/**
 * The single application-layer check of a journal request. It has no side effects and either
 * returns or throws for the first refused draft, so a request is accepted or refused as a whole.
 */
export function verifyJournalRequest(
  request: JournalExecuteRequest<string, unknown, unknown>,
  registry: EventTypeRegistry,
): void {
  for (const draft of request.events) verifyDraft(draft, registry);
}

/** A Journal that verifies every request before the inner Journal sees it. */
export class VerifiedJournal implements Journal {
  constructor(
    private readonly inner: Journal,
    private readonly registry: EventTypeRegistry,
  ) {}

  async execute<TResult>(
    request: JournalExecuteRequest<string, unknown, TResult>,
  ): Promise<JournalExecuteResult<TResult>> {
    verifyJournalRequest(request, this.registry);
    return await this.inner.execute(request);
  }
}
