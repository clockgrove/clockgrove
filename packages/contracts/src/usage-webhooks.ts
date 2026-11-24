import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import type { UsageEvent } from "./usage.js";
import { ContractDecodeError, exactKeys, record, string } from "./validation.js";

const MAX_URL_BYTES = 2048;

/** Registers, replaces or (with a `null` URL) disables the caller's usage webhook for one space. */
export interface UsageWebhookRequest {
  readonly version: 1;
  readonly scope: BrowserScope;
  /** Where signed usage events are posted: an `https` URL, or `null` to disable. */
  readonly url: string | null;
}

export interface UsageWebhookRegistration {
  /** Stable across re-registration; sent as the `webhook-id` prefix of every delivery. */
  readonly webhookId: string;
  readonly url: string | null;
  /** The Standard Webhooks signing secret (`whsec_…`); `null` when the webhook is disabled. */
  readonly signingSecret: string | null;
}

/** The JSON body of one delivery: events in `sequence` order. Forwarding one twice is one event (`eventId`). */
export interface UsageWebhookBody {
  readonly type: "usage.events";
  readonly events: readonly UsageEvent[];
}

export function decodeUsageWebhookRequest(value: unknown): UsageWebhookRequest {
  const path = "usageWebhook";
  const v = record(value, path);
  exactKeys(v, ["version", "tenantId", "worldId", "timelineId", "spaceId", "url"], [], path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  const scope = decodeBrowserScope({ tenantId, worldId, timelineId, spaceId });
  let url: string | null = null;
  if (v.url !== null) {
    url = string(v.url, `${path}.url`);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (
      parsed?.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      new TextEncoder().encode(url).length > MAX_URL_BYTES
    )
      throw new ContractDecodeError(`${path}.url`, "expected an https URL of at most 2048 bytes");
  }
  return Object.freeze({ version: 1, scope, url });
}
