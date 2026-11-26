import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import {
  ContractDecodeError,
  exactKeys,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
  utcTimestamp,
} from "./validation.js";

/** Decision: 100 events per page, as a run walk's page (`MAX_WALK_RUNS`). */
export const MAX_USAGE_PAGE = 100;
const MAX_SEQUENCE = 2n ** 63n - 1n;

export const USAGE_CATEGORIES = [
  "model_call",
  "tool_call",
  "delivery",
  "offer_shown",
  "offer_chosen",
] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];
export const USAGE_SOURCES = [
  "run_step",
  "delivery_receipt",
  "wake_triage",
  "moderation_shadow",
  "offer_presentation",
  "actor_reply_shadow",
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * The usage events of one player in a half-open window `[from, to)` of `occurredAt`. Without a
 * window the query is the feed: every event of the scope after `after`, in sequence order.
 */
export interface UsageQueryRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  /** The player; absent means every player of the scope. */
  readonly principalId?: string;
  readonly from?: string;
  readonly to?: string;
  /** A decimal sequence: only events after it. */
  readonly after?: string;
  readonly limit: number;
}

/** A billing-grade usage event; a `null` quantity is unknown, never zero. */
export interface UsageEvent {
  readonly eventId: string;
  readonly sequence: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly spaceId: string;
  readonly category: UsageCategory;
  readonly source: UsageSource;
  readonly resource: string | null;
  readonly status: string;
  readonly outcomeCode: string | null;
  readonly principalId: string;
  readonly personaId: string | null;
  readonly actorId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly rootRunId: string | null;
  readonly quantities: Readonly<Record<string, number | null>>;
  readonly occurredAt: string;
  readonly worldTime: string | null;
}

export interface UsagePage {
  readonly events: readonly UsageEvent[];
  /** The last event's sequence when the page is full; pass it as `after`. */
  readonly next: string | null;
}

export function decodeUsageQueryRequest(value: unknown): UsageQueryRequest {
  const path = "queryUsage";
  const v = record(value, path);
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId"],
    ["from", "to", "principalId", "after", "limit"],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  const scope = decodeBrowserScope({ tenantId, worldId, timelineId, spaceId });
  const limit = v.limit === undefined ? MAX_USAGE_PAGE : nonNegativeInteger(v.limit, path);
  if (limit < 1 || limit > MAX_USAGE_PAGE)
    throw new ContractDecodeError(`${path}.limit`, "limit out of range");
  if ((v.from === undefined) !== (v.to === undefined))
    throw new ContractDecodeError(`${path}.from`, "give both from and to, or neither");
  let from: string | undefined;
  let to: string | undefined;
  if (v.from !== undefined && v.to !== undefined) {
    from = utcTimestamp(v.from, `${path}.from`);
    to = utcTimestamp(v.to, `${path}.to`);
    if (Date.parse(from) > Date.parse(to))
      throw new ContractDecodeError(`${path}.to`, "window ends before it starts");
  }
  let after: string | undefined;
  if (v.after !== undefined) {
    const text = string(v.after, `${path}.after`);
    if (unsignedDecimal(text, `${path}.after`) > MAX_SEQUENCE)
      throw new ContractDecodeError(`${path}.after`, "sequence out of range");
    after = text;
  }
  let principalId: string | undefined;
  if (v.principalId !== undefined) {
    principalId = string(v.principalId, `${path}.principalId`);
    if (
      principalId === "" ||
      principalId.trim() !== principalId ||
      new TextEncoder().encode(principalId).length > 1024
    )
      throw new ContractDecodeError(`${path}.principalId`, "ID length out of range");
  }
  return Object.freeze({
    version: 1,
    scope,
    ...(principalId === undefined ? {} : { principalId }),
    ...(from === undefined || to === undefined ? {} : { from, to }),
    ...(after === undefined ? {} : { after }),
    limit,
  });
}
