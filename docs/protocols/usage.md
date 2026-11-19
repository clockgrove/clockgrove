# Usage events

Issue 329, part 1. A developer who deploys a world bills their own players from what the world
reports it used. Clockgrove reports usage; it never handles money. No price, rate card, cost,
currency, balance, payment provider, wallet or account is part of a usage event or of the engine
(owner's decision, 2026-11-15: "still just events and hooks. Never dealing with real money or
accounts"). Rating and billing stay with the developer's own provider.

## Where usage comes from

A usage event is derived only from the engine's own durable records, never from what a client
claims. Database triggers in migration 0076 write it in the same transaction as the row that proves
the use; no role, the runtime's included, may insert, update or delete one.

| Category     | Written when                                                      | Source             |
| ------------ | ----------------------------------------------------------------- | ------------------ |
| `model_call` | a run's `model_attempt` step ends, whatever its status            | `run_steps`        |
| `tool_call`  | a run's `tool_execution` step is recorded (remote MCP tools too)  | `run_steps`        |
| `delivery`   | a delivery's sink records its receipt                             | `delivery_sink_receipts` |

Model calls made outside a run (wake triage, moderation shadow) and effect-ledger calls outside a
run are not yet usage events; they come with part 2 of issue 329.

## Shape

| Field         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `eventId`     | Stable identity from the source row's key: `run_step:<runId>:<step>` or `delivery:<sha256>`. |
| `sequence`    | The feed order, a decimal string. It only grows.                                          |
| `worldId`, `timelineId`, `spaceId` | The world it was used in.                                            |
| `category`    | `model_call`, `tool_call` or `delivery`.                                                  |
| `source`      | `run_step` or `delivery_receipt`: the durable record it came from.                        |
| `resource`    | The model, the capability or the delivery sink.                                           |
| `status`, `outcomeCode` | The source's terminal disposition, so a failed or refused call is visible.      |
| `principalId` | The player the use is for: the run's initiating principal or the delivery's recipient.    |
| `personaId`   | The player's persona in the run; `null` for a delivery.                                   |
| `actorId`, `sessionId`, `runId`, `rootRunId` | The actor, session, run and the run's causal root.         |
| `quantities`  | Native quantities only, by category (below).                                              |
| `occurredAt`  | Wall-clock time the use ended (the step's end, the receipt's write).                      |
| `worldTime`   | The world's committed simulation time beside it, a decimal string; `null` without one.   |

Quantities:

- `model_call`: `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens` and `calls`,
  summed over every route attempt of the call (a fallback route's attempt counts). An attempt that
  never reached a provider (breaker open, credential missing) counts nothing.
- `tool_call`: `calls` (1).
- `delivery`: `deliveries` (1).

**Unknown stays unknown.** A quantity is `null` when the engine does not know it: a provider that
did not report a token type, an attempt that billed without reporting usage, or a model step that
ended without a call record. A `null` is never zero, and a consumer must not sum it as zero.

## Identity and forwarding

`eventId` is unique per tenant and derived from the source, so re-deriving or forwarding an event
twice is one event. Forward it as the dedup key of the developer's meter:

- Stripe meter events: `identifier` = `eventId`, `timestamp` = `occurredAt` (Stripe takes timestamps
  within 35 days), one meter event per quantity the meter counts.
- OpenMeter (CloudEvents): `id` = `eventId`, `source` = the world (`clockgrove/<worldId>/<timelineId>`),
  `subject` = `principalId`, `time` = `occurredAt`, `data` = `quantities`; OpenMeter dedupes on
  `source` and `id`.
- Lago: `transaction_id` = `eventId`, `external_subscription_id` = the developer's subscription for
  `principalId`, `timestamp` = `occurredAt`, `properties` = `quantities`.

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

`principalId` is optional (all players). The window is `[from, to)` on `occurredAt`. Events come in
`sequence` order, at most `limit` (decision: 100, as a run walk's page); the answer is
`{ "events": [...], "next": "<sequence>" | null }`, and `next` is passed back as `after` for the next
page. A reader needs the run inspector's grant, `runtime:world-inspect` for that space, and a
ceiling holding `operator_evidence`; every read is audited as subject `usage-events` under the
inspector rate limit. An event holds no conversation content.

## Not telemetry

Usage events are the billing record. OpenTelemetry spans, logs and metrics are observability for
operators: they may be sampled, dropped or aggregated and are never the billing record. Nothing in
the usage path reads telemetry, and telemetry is never reconciled against usage.

## Retention

One immutable row per ended model or tool step and per delivery receipt, kept for the world's life
(`db/retention.json`).
