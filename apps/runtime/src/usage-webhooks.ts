import { MAX_USAGE_PAGE, type UsageWebhookBody } from "@clockgrove/contracts";
import { type PostgreSqlClient, PostgreSqlUsageWebhooks } from "@clockgrove/persistence";
import { Webhook } from "standardwebhooks";

/** Decision: 100 webhooks per sweep, one page of events each, so a sweep is bounded work. */
const SWEEP_LIMIT = 100;
/** Decision: 300 s, the longest retry wait: a sweep that dies mid-post is retried by then. */
const LEASE_MS = 300_000;
/** Decision: 10 s, so a slow endpoint cannot hold the sweep for the others. */
const POST_TIMEOUT_MS = 10_000;

export interface UsageWebhookSweep {
  /** The deployment's `USAGE_WEBHOOK_SECRET`. */
  readonly secret: string;
  readonly fetch: typeof fetch;
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
 * Posts each due webhook's next page of usage events, signed as Standard Webhooks, and moves its
 * cursor only on a 2xx answer. One webhook's failure never stops the others.
 */
export async function sweepUsageWebhooks(
  client: PostgreSqlClient,
  options: UsageWebhookSweep,
): Promise<{ readonly delivered: number; readonly failed: number }> {
  const webhooks = new PostgreSqlUsageWebhooks(client);
  let delivered = 0;
  let failed = 0;
  let broken: unknown;
  for (const key of await webhooks.due(SWEEP_LIMIT)) {
    try {
      const claimed = await webhooks.claim(key, LEASE_MS);
      if (claimed === null) continue;
      const events = await webhooks.pending(key, claimed.deliveredThrough, MAX_USAGE_PAGE);
      const first = events[0];
      const last = events[events.length - 1];
      if (first === undefined || last === undefined) {
        await webhooks.settle(key, { delivered: true, through: null });
        continue;
      }
      const body = JSON.stringify({ type: "usage.events", events } satisfies UsageWebhookBody);
      const messageId = `${claimed.webhookId}:${first.sequence}:${last.sequence}`;
      const signer = new Webhook(await usageWebhookSecret(options.secret, claimed.webhookId));
      const now = new Date();
      const status = await post(options.fetch, claimed.url, body, {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signer.sign(messageId, now, body),
      });
      if (status === "ok") delivered += 1;
      else failed += 1;
      await webhooks.settle(
        key,
        status === "ok"
          ? { delivered: true, through: last.sequence }
          : { delivered: false, status },
      );
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
