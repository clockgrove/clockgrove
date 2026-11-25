import type { UsageCategory, UsageEvent } from "./usage.js";

/** The quantity names a usage event may carry (`docs/protocols/usage.md`). */
export const USAGE_QUANTITY_NAMES = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningTokens",
  "calls",
  "deliveries",
] as const;
export type UsageQuantityName = (typeof USAGE_QUANTITY_NAMES)[number];

export interface StripeMeterEvent {
  readonly event_name: string;
  readonly identifier: string;
  readonly timestamp: number;
  readonly payload: { readonly stripe_customer_id: string; readonly value: string };
}

export interface StripeMeterOptions {
  readonly customer: string;
  readonly meters: Partial<Record<UsageQuantityName, string>>;
}

export interface CloudEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly data: {
    /** Known quantities only: an unknown one is left out, never sent as null or zero. */
    readonly quantities: Readonly<Record<string, number>>;
    readonly resource: string | null;
    readonly status: string;
    readonly personaId: string | null;
    readonly actorId: string;
    readonly sessionId: string;
    readonly runId: string | null;
    readonly rootRunId: string | null;
    readonly spaceId: string;
    readonly worldTime: string | null;
  };
}

export interface LagoEventOptions {
  readonly externalSubscriptionId: string;
  readonly codes: Partial<Record<UsageCategory, string>>;
}

export interface LagoEvent {
  readonly transaction_id: string;
  readonly external_subscription_id: string;
  readonly code: string;
  readonly timestamp: number;
  readonly properties: Readonly<Record<string, number>>;
}

/** One Stripe meter event per metered quantity with a known value; unknown is never sent as zero. */
export async function toStripeMeterEvents(
  event: UsageEvent,
  options: StripeMeterOptions,
): Promise<StripeMeterEvent[]> {
  const out: StripeMeterEvent[] = [];
  for (const name of USAGE_QUANTITY_NAMES) {
    const meter = options.meters[name];
    const value = event.quantities[name];
    if (meter === undefined || value === null || value === undefined) continue;
    out.push({
      event_name: meter,
      identifier: await sha256Hex(`${event.eventId}:${name}`),
      timestamp: unixSeconds(event.occurredAt),
      payload: { stripe_customer_id: options.customer, value: String(value) },
    });
  }
  return out;
}

/**
 * CloudEvents 1.0 structured JSON; OpenMeter deduplicates on `source` and `id`. An unknown quantity
 * is left out, so a meter reading `$.quantities.<name>` never meets a JSON null.
 */
export function toCloudEvent(event: UsageEvent): CloudEvent {
  return {
    specversion: "1.0",
    id: event.eventId,
    source: `clockgrove/${event.worldId}/${event.timelineId}`,
    type: `clockgrove.usage.${event.category}`,
    subject: event.principalId,
    time: event.occurredAt,
    datacontenttype: "application/json",
    data: {
      quantities: knownQuantities(event),
      resource: event.resource,
      status: event.status,
      personaId: event.personaId,
      actorId: event.actorId,
      sessionId: event.sessionId,
      runId: event.runId,
      rootRunId: event.rootRunId,
      spaceId: event.spaceId,
      worldTime: event.worldTime,
    },
  };
}

/** A Lago event, or null when the category has no billable metric code. */
export function toLagoEvent(event: UsageEvent, options: LagoEventOptions): LagoEvent | null {
  const code = options.codes[event.category];
  if (code === undefined) return null;
  return {
    transaction_id: event.eventId,
    external_subscription_id: options.externalSubscriptionId,
    code,
    timestamp: unixSeconds(event.occurredAt),
    properties: knownQuantities(event),
  };
}

/** The event's quantities without the unknown (null) ones. */
function knownQuantities(event: UsageEvent): Record<string, number> {
  const known: Record<string, number> = {};
  for (const [name, value] of Object.entries(event.quantities))
    if (value !== null && value !== undefined) known[name] = value;
  return known;
}

function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** SHA-256 hex through WebCrypto, which browsers, Node and Workers all provide. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
