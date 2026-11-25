import { MAX_USAGE_PAGE, type UsageWebhookBody } from "@clockgrove/contracts";
import { type PostgreSqlClient, PostgreSqlUsageWebhooks } from "@clockgrove/persistence";

/** Decision: 100 webhooks per sweep, so a sweep is bounded work. */
const SWEEP_LIMIT = 100;
/**
 * Decision: 60 s per sweep for posting further pages of a webhook that is behind, a fifth of the
 * 5-minute cron. Each due webhook gets at least one page; then each full page delivered is followed
 * by the next until a short page, a failure or this budget. At 1 s per page that is 6,000 events per
 * sweep, 1,728,000 a day, for the space being drained.
 */
const DRAIN_MS = 60_000;
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
  const deadline = Date.now() + DRAIN_MS;
  const pageSize = Math.min(options.pageSize ?? MAX_USAGE_PAGE, MAX_USAGE_PAGE);
  for (const key of await webhooks.due(SWEEP_LIMIT)) {
    try {
      // Drain: a full page delivered is followed by the next while the sweep's time lasts.
      for (;;) {
        const claimed = await webhooks.claim(key, LEASE_MS);
        if (claimed === null) break;
        const events = await webhooks.pending(key, claimed.deliveredThrough, pageSize);
        const first = events[0];
        const last = events[events.length - 1];
        if (first === undefined || last === undefined) {
          await webhooks.settle(key, { delivered: true, through: null });
          break;
        }
        const body = JSON.stringify({ type: "usage.events", events } satisfies UsageWebhookBody);
        const messageId = `${claimed.webhookId}:${first.sequence}:${last.sequence}`;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const secret = await usageWebhookSecret(options.secret, claimed.webhookId);
        const status = await post(options.fetch, claimed.url, body, {
          "content-type": "application/json",
          "webhook-id": messageId,
          "webhook-timestamp": timestamp,
          "webhook-signature": await signature(secret, messageId, timestamp, body),
        });
        if (status === "ok") delivered += 1;
        else failed += 1;
        await webhooks.settle(
          key,
          status === "ok"
            ? { delivered: true, through: last.sequence }
            : { delivered: false, status },
        );
        if (status !== "ok" || events.length < pageSize || Date.now() >= deadline) break;
      }
    } catch (error) {
      broken ??= error;
    }
  }
  if (broken !== undefined) throw broken;
  return { delivered, failed };
}

/**
 * The Standard Webhooks `v1` signature: base64 HMAC-SHA256, keyed by the base64 part of the
 * `whsec_` secret, over `<id>.<timestamp>.<body>`.
 */
async function signature(
  webhookSecret: string,
  messageId: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const raw = Uint8Array.from(atob(webhookSecret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const content = new TextEncoder().encode(`${messageId}.${timestamp}.${body}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
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
