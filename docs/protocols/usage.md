# Usage events

Issue 329, parts 1 to 4. A developer who deploys a world bills their own players from what the world
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

Not yet a source: the actor-reply shadow (a moderation judgement of a committed reply, made when
`ACTOR_REPLY_SHADOW_CONFIG` is bound) keeps no durable record, only a contentless log line, so its
model call is not a usage event until it does.

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
  A wake-triage or moderation-shadow decision counts what its record's `usage` holds, carried from
  the gateway's decision record: `calls` 1 when the call was sent to the provider, with the input
  and output tokens it reported (`null` when it reported none); `calls` 0 with every token count 0
  when nothing was sent (over budget, no model configured, or the gateway refused before the
  provider: input too large, breaker open, budget); and `null` for every quantity when unknown (an
  interrupted decision, whose replaced owner may have reached the provider). The decisions endpoint
  reports no cache or reasoning tokens, so those are `null` after a call. It has no run: `runId` and `rootRunId` are
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
  `subject` = `principalId`, `time` = `occurredAt`, `data` = the known quantities and the
  attribution; an unknown quantity is left out of `data.quantities`, so a meter reading
  `$.quantities.<name>` never meets a JSON null.
  OpenMeter dedupes on `source` and `id`.
- Lago, `toLagoEvent(event, { externalSubscriptionId, codes })`: `transaction_id` = `eventId`,
  `external_subscription_id` = the developer's subscription for `principalId`, `code` = the
  billable metric for the category, `timestamp` = `occurredAt` in Unix seconds, `properties` = the
  known quantities. Lago takes them one by one or in batches.

None of them carries an unknown (`null`) quantity: it is left out, never billed as zero.

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

It answers `{ "webhookId": "…", "url": "…", "signingSecret": "whsec_…" }`. A webhook makes the
deployment send the space's player usage to a host outside it on a schedule, the egress an
outbound MCP server has, so registering takes the same narrow, owner-held authority: the grant
`runtime:usage-webhook`, beside the usage reader's grant `runtime:world-inspect` and the
`operator_evidence` ceiling (as the query). A world's owner holds `runtime:usage-webhook` by
default and may delegate it by adding it to a member's grants, as `runtime:mcp-install`; as for
that grant, an actor or `system:` identity never qualifies, even holding it explicitly, and
`runtime:world-operate` does not imply it. A
caller without it is refused (403). The caller holds one
webhook per space: registering again replaces its URL and keeps its ID,
cursor and secret; `"url": null` disables it. A new webhook, or a disabled one enabled again,
starts after the space's newest usage event: it posts only usage recorded from then on, and earlier
usage is read with the query (so a forward to Stripe, which takes timestamps within 35 days, never
starts with a backlog it refuses). The URL is `https` to a public host name (no IP
address, single label, or `localhost`, `.local`, `.internal`, `.home`, `.lan`, `.arpa`, `.test` or
`.invalid` name), without credentials, at most 2048 bytes; it is stored, posted to and answered in
its normalised form (`HTTPS://Billing.Example` is `https://billing.example/`), and any other is a
400 `invalid_inspection_request`. A webhook posts only what its registrar may read, as the
registrar: once they lose the inspect grant, `runtime:usage-webhook` (or, for an owner's default,
the owner role) or their membership's `operator_evidence` ceiling, it stops: the next run does not
list it, and within a run the next post's claim is refused. Registering, replacing or disabling is audited as subject
`usage-webhook`, its entry the URL's origin or `disabled` (never the path or query, which may carry
the receiver's own credential), in the registration's own transaction, so no registration happens without its audit row. Audit
rows are kept 90 days, as every inspector access (`db/retention.json`), while the webhook row is
kept for the world's life: for a webhook registered earlier only its row's registrar, current URL
and last update remain, not the earlier URLs it pointed at. A registration that fails is audited `failed`, and a refused one as a
`usage-events` denial.

The deployment sets `USAGE_WEBHOOK_SECRET`; without it the route answers 503 `inspector_unavailable` and nothing is posted.
Each webhook's signing secret is derived from it and the webhook ID (`whsec_` and the base64 of
HMAC-SHA256), so Clockgrove stores none; registering again returns the same secret.

Every 5 minutes (the runtime's recovery cron) the due webhooks, at most 100, take turns
(a webhook is due only with an event after its cursor, so an idle one takes none of the 100): each gets
its next events after its cursor, at most 100 per post, and one whose full page was delivered goes
to the back for its next page, so every due webhook gets its first page before any gets a second.
The run starts no post after 60 s, a fifth of the cron interval, so with the 10 s post timeout it
ends within about 75 s however many webhooks are due; one not reached stays due and is first in the
next run. At 1 s per post that is 6,000 events per run, 1,728,000 a day:

```json
{ "type": "usage.events", "events": [ { "eventId": "…", "sequence": "42", … } ] }
```

signed per [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`,
`webhook-timestamp`, `webhook-signature`), so the developer verifies it with any Standard Webhooks
library and the signing secret, for example `new Webhook(secret).verify(body, headers)`.
`webhook-id` is `<webhookId>:<first sequence>:<last sequence>`. A 2xx answer moves the cursor past
the post; any other answer, no answer within 10 s, or a network failure keeps it and records the
post's last sequence, and the retry is the same message: exactly the same events, the same body and
the same `webhook-id`, even when usage was recorded in between (that usage follows in later posts).
It is due again after 2, 4, 8 … seconds, at most 300, and posted by the first cron run after that:
at least once, in order, none skipped. A receiver dedupes on `eventId` (or on `webhook-id`, which a retry keeps), so a post delivered
twice counts once.

## Admission before spend

Issue 329, part 3. A developer limits spend before it happens, with durable budgets, an admission
hook, or both. Before every model call and every tool execution of a turn (a Talk turn or an
autonomous activation, both turn fibers), and before the model call of each shadow beside a turn
(the wake triage and the moderation shadow before the reply, the actor-reply shadow after it), the
engine asks: first the space's budgets, then the hook. A tool call is asked once, before its effect
intent is recorded; a later pass of the same call only reads its recorded result.

A refused model call is never sent: the turn ends with the service outcome `usage_refused`, shown to
the player as a service disposition, never as the character refusing; the run's model step ends
`failed` with outcome code `usage_refused` and a summary naming the cause, which the run inspector
shows; and the step's usage event reads `outcomeCode: "usage_refused"` with zero quantities. A
refused tool call is not executed: it is recorded `refused` with code `usage_refused`, the model
reads that as the tool's result, its run step's summary names the cause (`Usage refused: <cause>`),
and its usage event reads `status: "refused"` and `calls` 0. A refused shadow makes no call: its
decision fails with the code `usage_refused:<cause>`, and its usage event (the wake triage's and the
moderation shadow's) reads `calls` 0. A turn refused this way is found by the run inspector's turn
entry, as the other service outcomes are.

| Cause                          | When                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `usage_budget_exhausted`       | a budget would be passed by one more call (or its tokens are used up) |
| `usage_budget_unknown`         | a budget's tally met an unknown quantity since the budget was last set |
| `usage_admission_refused`      | the hook answered `{ "admit": false, "reason": … }`; the reason follows the cause |
| `usage_admission_unavailable`  | the hook did not answer a valid 2xx within 2 s, or its registrar no longer holds the authority to register it |

### Budgets

`POST /v1/runtime/usage/budget` sets one budget of a space and answers all of them:

```json
{ "version": 1, "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "budget": { "scope": "player", "category": "model_call", "quantity": "calls",
              "period": "day", "limit": 200 } }
```

`{ "budgets": [ { "scope": "player", "category": "model_call", "quantity": "calls", "period": "day", "limit": 200 } ] }`

- `scope`: `world` (the whole world), `player` (each player apart, across the world) or `session`
  (each session apart). A `world` or `player` budget counts the use of every space and timeline of
  the world; it is set in a space and refuses calls in that space, so a world-wide limit is set in
  each space it should hold in.
- `category` and `quantity`: `model_call` with `calls`, `inputTokens` or `outputTokens`; `tool_call`
  with `calls`. Native quantities only: no price, cost or currency.
- `period`: `day`, the UTC calendar day of the usage event's `occurredAt`, or `total`.
- `limit`: the most the scope may use in the period; `null` turns the budget off. Setting the same
  scope, category, quantity and period again replaces its limit.

A space holds at most 24 budgets, one per combination. Setting one needs `runtime:world-operate`
beside the usage reader's `runtime:world-inspect` and `operator_evidence` ceiling: it restricts the
world's spend and sends nothing outside. It is audited as subject `usage-budget`, the entry
`<scope>:<category>:<quantity>:<period>`.

A budget counts usage events from the time its scope and period were first budgeted in any space of
the world (in the space, for a session; earlier usage is read with the query), and keeps counting
while it is off, so turning it on again holds what was used meanwhile.

**Reserve, execute, then capture or release.** Admission takes a lock per world, checks every budget
of the call's category, and, when all admit, reserves one call for the session, category and
asking source (the turn's run step, the wake triage or the moderation shadow). The call runs. When
its usage event commits, in the same transaction and under the same lock, the tally gains the
event's real quantities and the reservation of the event's own source goes (capture): a shadow's
event never releases the turn's call. A refused or failed call's event captures what it used, often
nothing. A reservation never captured (an owner that died mid-call) lapses after 300 s, the
recovery cron's cadence. A `calls` budget counts the tally, every other reservation held in its
scope and the call asked for, so concurrent calls never pass it. The actor-reply shadow writes no
usage event, so it is asked and reserves nothing. Tokens are known only
after a call, so a token budget admits while its tally is below the limit, and the call it admits
may pass it.

**Unknown stays unknown.** A tally sums known quantities and records when an unknown (`null`) one
entered it (a model step that ended without usage, an interrupted shadow decision). A budget whose
tally met an unknown quantity since the budget was last set refuses (`usage_budget_unknown`) rather
than count it as zero. Its operator ends that by setting the budget again, which is audited: from
then it counts the known part, and a later unknown refuses again. A `day` budget's tally starts
fresh each UTC day.

### Admission hook

`POST /v1/runtime/usage/admission-hook` registers the space's hook (`"url": null` disables it):

```json
{ "version": 1, "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "url": "https://billing.example/clockgrove/admit" }
```

It answers `{ "hookId": "…", "url": "…", "signingSecret": "whsec_…" }`. A space has one hook; a
later registration replaces its URL and registrar and keeps its ID and secret. The hook posts a
space's player usage requests to a host outside the deployment, the egress of a usage webhook, so
registering takes the same authority: `runtime:usage-webhook` (a world's owner by default,
delegable) beside the usage reader's grant and ceiling, with the same URL rules, and it is audited
as subject `usage-admission-hook`, the entry the URL's origin or `disabled`. The hook is asked only
while its registrar still holds that authority; while they do not, every call of the space is
refused (`usage_admission_unavailable`) rather than lose the limit, until a holder registers or
disables it. Without `USAGE_WEBHOOK_SECRET` the route answers 503 `inspector_unavailable`.

Each admission the budgets let through is posted to it, signed per Standard Webhooks with the
signing secret (derived from `USAGE_WEBHOOK_SECRET` and the hook ID, as a webhook's):

```json
{ "type": "usage.admission",
  "admission": { "category": "model_call", "source": "run_step", "resource": "…",
                 "worldId": "…", "timelineId": "…",
                 "spaceId": "…", "principalId": "…", "personaId": "…", "actorId": "…",
                 "sessionId": "…", "runId": "…" } }
```

`source` is what asks: `run_step` (the turn's model or tool call), `wake_triage`,
`moderation_shadow` or `actor_reply_shadow`. The hook answers 2xx with `{ "admit": true }`, or `{ "admit": false, "reason": "subscription_lapsed" }`
(a reason of 1 to 64 `a-z`, `0-9` or `_`). Any other answer, no answer within 2 s (decision: the hook
sits before each model call, in the player's wait), or a network failure refuses the spend
(`usage_admission_unavailable`): the hook exists to stop spend, so its silence never admits it.

## World modes

Issue 329, part 4. The developer's server sets each space's mode, for example when a player's
subscription lapses, and the world shows it with its reason:

| Mode         | Refused                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `active`     | nothing                                                                  |
| `restricted` | every model and tool call: play and world commands go on without spend   |
| `read_only`  | every world command and Influence, and every new turn (Talk or a wake) |
| `paused`     | everything `read_only` refuses, and every model and tool call            |

`POST /v1/runtime/world-mode` sets it:

```json
{ "version": 1, "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "mode": "restricted", "reason": "subscription_lapsed" }
```

It answers `{ "mode": "restricted", "reason": "subscription_lapsed" }`. The reason is a code of 1 to
64 `a-z`, `0-9` or `_`, or `null`; `active` takes none. It is a code, not text, because every
observer of the world is shown it. A mode holds in the space it is set in, as a budget does: a
member's authority is per space, so a mode set in one space never binds a space its setter holds no
authority in, and a developer who restricts a whole world sets it in each of its spaces. Setting
it needs `runtime:world-operate` beside the usage reader's `runtime:world-inspect` and
`operator_evidence` ceiling: it restricts the world and sends nothing outside. Each change is
audited as subject `world-mode`, the entry the mode.

**Where it holds.**

- A model or tool call, a turn's or a shadow's, is asked admission first: in a `restricted` or
  `paused` space it is refused before any budget or the hook, with cause `world_mode_restricted` or
  `world_mode_paused`, and it shows as every refusal of [admission](#admission-before-spend) does
  (the turn's `usage_refused` service outcome, its run step, its usage event with zero quantities).
- In a `read_only` or `paused` space, Talk answers `409 world_mode_refused` before a turn starts,
  as a mute does. A wake (scheduled, proactive or an operator's) starts no turn either, but it is
  held, not lost: it stays pending, as a wake waiting on a busy conversation does, and runs at the
  actor's first alarm once the space is `active` or `restricted` again. A turn accepted before the
  mode finishes (in a `paused` space, its next model or tool call is refused).
- In a `read_only` or `paused` space, a world command or Influence (not a
  [purchase](#purchase-grants)) answers
  `409 { "error": "world_mode_refused", "mode": "read_only", "reason": "maintenance" }`. A replay of
  a command decided before is still answered.
- Reads are served in every mode: the scene, the world status, inspection and usage.

**What it never touches.** A mode is an admission policy, never world truth: it writes no journal
event and never moves the world's clock, so a replay never depends on it. `PauseWorld`,
`ResumeWorld` and `SetClockPolicy` stay the owner's journaled clock controls and are admitted in
every mode; a `paused` world stops actions and spend, not simulated time, and an owner who wants
both also pauses its clock. Pausing the clock is `runtime:world-clock`'s, which no other grant
implies ([world commands](runtime-world-commands.md#authority-and-readiness)), so a mode set with
`runtime:world-operate` cannot do it. The HUD names the mode "Play paused" beside the clock's own
"Running" or "Paused", so the two are never confused.

**How it is shown.** The world status read (`POST /v1/runtime/world-status`) carries
`"mode": { "mode": …, "reason": … }` while the space is not `active`, and the scene's HUD names
the mode and its reason beside the clock. A mode writes no revision, so the browser reads the status
again every 10 s while observing, and at once after a `world_mode_refused` answer.

## Purchase grants

Issue 329, part 5. After the developer's own checkout, their server reports the purchase and the
engine puts the item into the world once per purchase id. The engine never sees a price, currency,
balance or payment account: a purchase is a quantity of a world resource and an id.

`POST /v1/runtime/purchases` grants:

```json
{ "version": 1, "tenantId": "…", "worldId": "…", "timelineId": "…", "spaceId": "…",
  "action": "grant", "purchaseId": "cs_test_1", "principalId": "<player>",
  "objectId": "fixture.household-food", "resourceKind": "food", "quantity": 2 }
```

It answers `200` with the receipt
`{ "purchaseId": "cs_test_1", "action": "grant", "commandId": "purchase:cs_test_1", "status": "committed", "revision": "…", "quantity": 2 }`.

- **The item.** `quantity` (1 to 1,000,000) of `food` or `water` placed in the existing resource
  holder `objectId` the developer names, under the checks a transfer's target meets (the holder's
  kind, a perishable holder's single batch). A player has no in-world inventory of their own, so the
  developer chooses the holder that stands for the player's item. `principalId` is the player the
  purchase is for; it is recorded in the journal, not shown on the scene or in Why.
- **Exactly once.** The server builds the world command, as it builds an Influence intent; its
  command ID is `purchase:<purchaseId>` and the kernel refuses any other pairing, so the journal's
  command-ID identity grants a purchase once. The same request again (the same scope and fields,
  from any holder of the grant) answers the stored receipt; a different request under the same
  purchase id is `409 command_id_reused`. A purchase id is 1 to 128 of `A-Z`, `a-z`, `0-9`, `.`,
  `_`, `:` or `-`, unique per tenant, as command IDs are: once used in one world, timeline or space
  of a tenant, the same id answers `409 command_id_reused` in every other, and its refund
  `purchase_not_granted`. A developer selling in several worlds of one tenant uses ids unique
  across them, as a checkout's session or order id is. A grant the world refuses
  (no such holder, another kind, a perishable holder already holding food) answers `409` with
  `"status": "rejected"` and its reason, and stays refused for that purchase id.
- **Its cause.** The grant journals `resource.purchase-granted@1`
  `{purchaseId, principalId, objectId, kind, quantity}`. It is one of the closed world's checked
  causes of an increase ([kernel ecology](../../packages/kernel/docs/ecology.md)), so a replay
  reproduces it and Why's recorded resource causes explain the material as `"cause": "purchase"`,
  without the player. The world's feed narrates "An outside purchase brought 2 food into …".
- **Refunds.** `"action": "refund"` with the grant's fields journals
  `resource.purchase-refunded@1` under `purchase-refund:<purchaseId>`, once. It removes what is left
  of the grant in its holder, never more than was granted and never below zero (a consumed item is
  not taken back from elsewhere); the receipt's `quantity` and the event's are what it removed, 0
  when nothing is left. A refund needs the purchase's committed grant with the same scope and fields (who sent
  the grant or the refund is not one of them: an owner refunds what a delegate granted), else
  `409 purchase_not_granted`, answered only to a caller holding `runtime:world-purchase`. Why shows a removal as `"cause": "refund"`.
- **Authority.** A purchase needs `runtime:world-purchase`. A world's owner holds it by default
  and may delegate it, as `runtime:usage-webhook` and `runtime:mcp-install`: purchases are the
  developer's own commerce, and the world's owner is the developer. No other grant implies it
  (`runtime:world-command`, `runtime:world-operate` and `runtime:world-clock` never do), and an
  actor or system identity never holds it by ownership ([capabilities](capabilities.md)). A
  refused caller gets `403`, before anything is said about the purchase, and no receipt is written,
  so no one without the grant in some world of the tenant can take a purchase id before the
  developer's server. Purchase ids are per tenant, so a holder in one of the tenant's worlds can
  use an id first; the tenant's worlds are one developer's, who chooses its holders.
  `POST /v1/runtime/commands` refuses both command types and their command IDs (`400
  invalid_world_command`), and an actor's `world.command` cannot name them (the kernel's ID pairing).
- **Modes.** No [world mode](#world-modes) refuses a purchase or a refund: they record the
  developer's outside bookkeeping, as clock controls are exempt, so a refund is recorded while play
  is paused.

## Not telemetry

Usage events are the billing record. OpenTelemetry spans, logs and metrics are observability for
operators: they may be sampled, dropped or aggregated and are never the billing record. Nothing in
the usage path reads telemetry, and telemetry is never reconciled against usage.

## Retention

One immutable row per ended model or tool step, per delivery receipt and per finished shadow
decision, kept for the world's life; one webhook row per registrar and space; at most 24 budgets
and one admission hook per space, and a budget tally per world, budgeted scope, subject and day, kept
for the world's life; one reservation per session, category and asking source, gone when captured; one mode per space,
updated in place (`db/retention.json`).
