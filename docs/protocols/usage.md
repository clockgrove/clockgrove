# Usage events

Issue 329, parts 1 and 2. A developer who deploys a world bills their own players from what the world
reports it used. Clockgrove reports usage; it never handles money. No price, rate card, cost,
currency, balance, payment provider, wallet or account is part of a usage event or of the engine
(owner's decision, 2026-11-15: "still just events and hooks. Never dealing with real money or
accounts"). Rating and billing stay with the developer's own provider.

## Where usage comes from

A usage event is derived only from the engine's own durable records, never from what a client
claims. Deferred database triggers in migration 0076 write it when the transaction that wrote the
row proving the use commits; no role, the runtime's included, may insert, update or delete one.

| Category     | Written when                                                      | Source             |
| ------------ | ----------------------------------------------------------------- | ------------------ |
| `model_call` | a run's `model_attempt` step ends, whatever its status            | `run_steps`        |
| `tool_call`  | a run's `tool_execution` step is recorded (remote MCP tools too)  | `run_steps`        |
| `delivery`   | a delivery's sink records its receipt                             | `delivery_sink_receipts` |
| `model_call` | a wake-triage decision outside any run is finished                | `wake_triage`      |
| `model_call` | a moderation-shadow decision outside any run is finished          | `moderation_shadow` |

A remote MCP call is an effect in the effect ledger, and every effect the runtime records belongs
to a run: it is counted once, by that run's `tool_execution` step.

## Shape

| Field         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `eventId`     | Stable identity from the source row's key: `run_step:<runId>:<step>`, `delivery:<sha256>`, or `wake_triage:<sha256>` / `moderation_shadow:<sha256>` of the turn's `[sessionId, messageId]`. |
| `sequence`    | The feed order, a decimal string. Within a timeline it is taken in commit order, so a reader paging by it never passes an event that commits later. |
| `worldId`, `timelineId`, `spaceId` | The world it was used in.                                            |
| `category`    | `model_call`, `tool_call` or `delivery`.                                                  |
| `source`      | `run_step`, `delivery_receipt`, `wake_triage` or `moderation_shadow`: the durable record it came from. |
| `resource`    | The model, the capability or the delivery sink.                                           |
| `status`, `outcomeCode` | The source's terminal disposition, so a failed or refused call is visible. A tool call refused before dispatch or simulated reads `refused` or `simulated`. |
| `principalId` | The player the use is for: the run's initiating principal or the delivery's recipient.    |
| `personaId`   | The player's persona in the run or turn; `null` for a delivery.                           |
| `actorId`, `sessionId`, `runId`, `rootRunId` | The actor, session, run and the run's causal root. A response delivery's run is the run that committed the reply to the message it responds to, whether it completed or failed with an outcome code such as `model_unavailable`; a delivery for no message has `null` run and root. |
| `quantities`  | Native quantities only, by category (below).                                              |
| `occurredAt`  | Wall-clock time the use ended (the step's end, the receipt's write).                      |
| `worldTime`   | The world's committed simulation time beside it, a decimal string; `null` without one.   |

Quantities:

- `model_call`: `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`,
  `reasoningTokens` and `calls`, summed over every route attempt of the call (a fallback route's
  attempt counts). An attempt that never reached a provider (breaker open, credential missing)
  counts nothing, and an attempt that committed a checkpointed answer again counts no call.
  A wake-triage or moderation-shadow decision counts `calls` 1 when it reached the model (its record
  measured a latency) and 0 when it did not (over budget, no model configured); its token counts are
  `null`, since the decisions endpoint reports none. It has no run: `runId` and `rootRunId` are
  `null`, and `status` is the decision's (`picked`, `cant_tell`, `low_confidence`, `over_budget`,
  `failed`, …).
  **Parts, not siblings:** `inputTokens` is the whole input, and `cachedInputTokens` (read from the
  provider's prompt cache) and `cacheWriteInputTokens` (written to it) are parts of it;
  `reasoningTokens` is a part of `outputTokens`. Input not served from or written to the cache is
  `inputTokens − cachedInputTokens − cacheWriteInputTokens`; visible output is
  `outputTokens − reasoningTokens`. Never add a part to its total.
- `tool_call`: `calls`: 1 for a tool the engine dispatched; 0 for one it refused before dispatch or
  only simulated.
- `delivery`: `deliveries` (1).

**Unknown stays unknown.** A quantity is `null` when the engine does not know it: a provider that
did not report a token type, an attempt that billed without reporting usage, or a model step that
ended without a call record. A `null` is never zero, and a consumer must not sum it as zero.

## Identity and forwarding

`eventId` is unique per tenant and derived from the source, so re-deriving or forwarding an event
twice is one event. Forward it as the dedup key of the developer's meter. `@clockgrove/contracts`
builds each platform's request body from an event; the developer's own client sends it:

- Stripe meter events, `toStripeMeterEvents(event, { customer, meters })`: one meter event per
  quantity that has a meter and a known value, `identifier` = SHA-256 hex of `<eventId>:<quantity>`
  (stable, and under Stripe's 100 characters), `timestamp` = `occurredAt` in Unix seconds (Stripe
  takes timestamps within 35 days), `payload` = `{ stripe_customer_id, value }`. A meter that
  prices cached or reasoning tokens apart meters the disjoint quantities (uncached input, cache
  read, cache write; visible output, reasoning), never a total and its part, or those tokens bill
  twice.
- OpenMeter, `toCloudEvent(event)`: a CloudEvents 1.0 structured event, `id` = `eventId`,
  `source` = `clockgrove/<worldId>/<timelineId>`, `type` = `clockgrove.usage.<category>`,
  `subject` = `principalId`, `time` = `occurredAt`, `data` = the quantities and attribution.
  OpenMeter dedupes on `source` and `id`.
- Lago, `toLagoEvent(event, { externalSubscriptionId, codes })`: `transaction_id` = `eventId`,
  `external_subscription_id` = the developer's subscription for `principalId`, `code` = the
  billable metric for the category, `timestamp` = `occurredAt` in Unix seconds, `properties` = the
  known quantities. Lago takes them one by one or in batches.

None of them carries an unknown (`null`) quantity as a value: unknown is never billed as zero.

## Query

`POST /v1/runtime/usage/query` reads one space's usage for reconciliation, by player and time window:

```json
{
  "version": 1,
  "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "principalId": "principal-…",
  "from": "2026-11-01T00:00:00.000Z",
  "to": "2026-12-01T00:00:00.000Z",
  "after": "41",
  "limit": 100
}
```

`principalId` is optional (all players). The window is `[from, to)` on `occurredAt`; `from` and `to`
are given together or not at all. Events come in
`sequence` order, at most `limit` (decision: 100, as a run walk's page); the answer is
`{ "events": [...], "next": "<sequence>" | null }`, and `next` is passed back as `after` for the next
page. A reader needs the run inspector's grant, `runtime:world-inspect` for that space, and a
ceiling holding `operator_evidence`; every read is audited as subject `usage-events` under the
inspector rate limit. An event holds no conversation content.

## Feed

Without a window the query is the feed: every event of the space (of the player, with
`principalId`) after the cursor `after`, in `sequence` order. A reader keeps the last `sequence` it
took and passes it back; within a timeline a later commit never takes a lower sequence, so the feed
never skips an event, and a reader that re-reads a page sees the same `eventId`s.

## Webhooks

`POST /v1/runtime/usage/webhook` registers where the space's usage is posted:

```json
{ "version": 1, "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "url": "https://billing.example/clockgrove" }
```

It answers `{ "webhookId": "…", "url": "…", "signingSecret": "whsec_…" }`. The caller needs the
usage reader's grant and ceiling (as the query) and holds one webhook per space: registering again
replaces its URL and keeps its ID, cursor and secret; `"url": null` disables it. The URL is
`https`. A webhook posts only what its registrar may read, as the registrar: once they lose the
grant or the ceiling, it stops. Registration is audited as subject `usage-events`.

The deployment sets `USAGE_WEBHOOK_SECRET`; without it the route answers 404 and nothing is posted.
Each webhook's signing secret is derived from it and the webhook ID (`whsec_` and the base64 of
HMAC-SHA256), so Clockgrove stores none; registering again returns the same secret.

Every 5 minutes (the runtime's recovery cron) each due webhook gets its next events after its
cursor, at most 100 per post:

```json
{ "type": "usage.events", "events": [ { "eventId": "…", "sequence": "42", … } ] }
```

signed per [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`,
`webhook-timestamp`, `webhook-signature`), so the developer verifies it with any Standard Webhooks
library and the signing secret, for example `new Webhook(secret).verify(body, headers)`.
`webhook-id` is `<webhookId>:<first sequence>:<last sequence>`. A 2xx answer moves the cursor past
the post; any other answer, no answer within 10 s, or a network failure keeps it, and the same
events are due again after 2, 4, 8 … seconds, at most 300, and posted by the first cron run after
that: at least once, in order, none skipped. A receiver dedupes on `eventId`, so a post delivered twice counts once.

## Not telemetry

Usage events are the billing record. OpenTelemetry spans, logs and metrics are observability for
operators: they may be sampled, dropped or aggregated and are never the billing record. Nothing in
the usage path reads telemetry, and telemetry is never reconciled against usage.

## Retention

One immutable row per ended model or tool step, per delivery receipt and per finished shadow
decision, kept for the world's life; one webhook row per registrar and space (`db/retention.json`).
