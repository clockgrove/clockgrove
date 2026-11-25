import { MAX_USAGE_PAGE, type UsageWebhookBody } from "@clockgrove/contracts";
import { type PostgreSqlClient, PostgreSqlUsageWebhooks } from "@clockgrove/persistence";
import { Webhook } from "standardwebhooks";

/** Decision: 100 webhooks listed per sweep; any not reached stay due, the longest-waiting first. */
const SWEEP_LIMIT = 100;
/**
 * Decision: a sweep starts no post after 60 s, a fifth of the 5-minute cron that runs it beside the
 * recoveries. With the 10 s post timeout and the database round trips a sweep ends within about
 * 75 s, whatever the number of webhooks or how far behind they are: first pages and further pages
 * alike. Due webhooks take turns, a page each, so every one gets its first page before any gets a
 * second. At 1 s per post that is 60 posts (6,000 events) per sweep, 17,280 posts a day.
 */
const SWEEP_MS = 60_000;
/** Decision: 300 s, the longest retry wait: a sweep that dies mid-post is retried by then. */
const LEASE_MS = 300_000;
/** Decision: 10 s, so a slow endpoint cannot hold the sweep for the others. */
const POST_TIMEOUT_MS = 10_000;

export interface UsageWebhookSweep {
  /** The deployment's `USAGE_WEBHOOK_SECRET`. */
  readonly secret: string;
  readonly fetch: typeof fetch;
  /** Events per post; `MAX_USAGE_PAGE` unless a test sets fewer to show the drain. */
  readonly pageSize?: number;
}

/**
 * The webhook's signing secret: `whsec_` and the base64 of HMAC-SHA256 keyed by the deployment
 * secret over the webhook ID, so the developer holds one secret per webhook and Clockgrove stores none.
 */
export async function usageWebhookSecret(
  deploymentSecret: string,
  webhookId: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(deploymentSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(webhookId)));
  return `whsec_${btoa(String.fromCharCode(...mac))}`;
}

/**
 * Posts each due webhook's pending usage events, a page at a time, signed as Standard Webhooks, and
 * moves its cursor only on a 2xx answer. One webhook's failure never stops the others.
 */
export async function sweepUsageWebhooks(
  client: PostgreSqlClient,
  options: UsageWebhookSweep,
): Promise<{ readonly delivered: number; readonly failed: number }> {
  const webhooks = new PostgreSqlUsageWebhooks(client);
  let delivered = 0;
  let failed = 0;
  let broken: unknown;
  const deadline = Date.now() + SWEEP_MS;
  const pageSize = Math.min(options.pageSize ?? MAX_USAGE_PAGE, MAX_USAGE_PAGE);
  // Round robin: a webhook whose full page was delivered goes to the back for its next page.
  const turns = await webhooks.due(SWEEP_LIMIT);
  for (let key = turns.shift(); key !== undefined && Date.now() < deadline; key = turns.shift()) {
    try {
      const claimed = await webhooks.claim(key, LEASE_MS);
      if (claimed === null) continue;
      // A retry re-sends exactly the refused post's events, so it is the same message (the same
      // `webhook-id` and body) even when usage arrived in between.
      const events = await webhooks.pending(
        key,
        claimed.deliveredThrough,
        pageSize,
        claimed.retryThrough,
      );
      const first = events[0];
      const last = events[events.length - 1];
      if (first === undefined || last === undefined) {
        await webhooks.settle(key, { delivered: true, through: null });
        continue;
      }
      const body = JSON.stringify({ type: "usage.events", events } satisfies UsageWebhookBody);
      const messageId = `${claimed.webhookId}:${first.sequence}:${last.sequence}`;
      // Whole seconds: the timestamp header and the signed content carry the same value.
      const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const secret = await usageWebhookSecret(options.secret, claimed.webhookId);
      const status = await post(options.fetch, claimed.url, body, {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(sentAt.getTime() / 1000),
        "webhook-signature": new Webhook(secret).sign(messageId, sentAt, body),
      });
      if (status === "ok") delivered += 1;
      else failed += 1;
      await webhooks.settle(
        key,
        status === "ok"
          ? { delivered: true, through: last.sequence }
          : { delivered: false, status, through: last.sequence },
      );
      if (status === "ok" && events.length === pageSize) turns.push(key);
    } catch (error) {
      broken ??= error;
    }
  }
  if (broken !== undefined) throw broken;
  return { delivered, failed };
}

async function post(
  send: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<string> {
  try {
    const response = await send(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300 ? "ok" : `http_${response.status}`;
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
  }
}
