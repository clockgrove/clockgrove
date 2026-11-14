---
name: journal-replay-causality
description: Clockgrove's rules for the PostgreSQL journal, attribution, authority evidence, projections, replay, snapshots, causal inspection (Why) and preview timelines in clockgrove/clockgrove. Use when adding a command or event family, touching the journal transaction, dispatch or outbox, a projection, the causal inspector, replay or snapshot code, or timeline and branch semantics.
---

# Journal, replay and causality

History must answer: what happened, who or what caused it, which authority allowed or denied it, what evidence existed then, what state followed, and whether replay reproduces it. Why, return summaries, debugging, recovery, timelines and authoring all read the journal.

## Where the contracts live

- `docs/runbooks/journal-replay.md`: the canonical transaction, world commands, dispatch, idempotency and failure semantics, snapshots, the causal inspector, replay.
- `docs/protocols/shared-contracts.md`: IDs, attribution, privacy classes, ordering, upcasting, receipts and the event registry.
- `docs/protocols/realtime-projection.md` and `docs/protocols/runs.md`: projection delivery and run/step evidence.
- The Wave 2 plan in `docs/waves/`; Wave 7 for timelines and preview; `docs/adr/clockgrove-adr-field-guides-and-counterfactual-why.md` for counterfactual Why.

Those documents win over this page.

## Rules

- **PostgreSQL is the only canonical history.** Durable Objects, queues, caches, indexes and browser state are execution or projection state that can be rebuilt.
- **One transaction holds the evidence.** The command receipt, authority decision, events, partition state, schedule changes and dispatch intent commit together. Notification and dispatch happen after commit and are best-effort, so asynchronous delivery is never the only record that work happened.
- **Record denials.** A deny decision commits a rejected receipt with its decision and moves no head. Product and security behaviour depends on seeing refusals, not only successes.
- **Keep IDs distinct.** `commandId` is the idempotent request; `actionId` the attributed action (`attribution.causalRootActionId`); `eventId` a committed fact; `causationId` the command's declared cause; `authorityDecisionId` the immutable allow/deny; `correlationId` groups work and never means causation or authorship; `sessionId` and run IDs are execution context, not authorship.
- **Attribution is resolved server-side.** Clients, models and tools never assert their own principal, persona or authority as trusted fields. Through actor, rule, scheduler and tool layers keep the causal root and change only fields whose meaning changed.
- **History is additive.** Corrections are new events or compensating commands, never edited rows. Version payloads and upcast on read.
- **Projections are derived.** Monotonic revisions per scope, gap detection with backfill or snapshot recovery, deterministic rebuild, audience and privacy filtering before delivery. Optimistic client state never becomes canonical.
- **Replay never repeats side effects.** Replay writes nothing and resends nothing. Recorded nondeterminism (model, tool and provider results) is reused, not re-requested. Snapshots speed replay but never override journal truth.
- **Why reads stored evidence.** The inspector walks recorded receipts, decisions, events, schedules and decision traces; it never reconstructs missing decisions from current state and never exposes model chain-of-thought.
- **Preview stays in its timeline.** Fork at a stable barrier, keep preview mutations and effects timeline-local, and promote by reissuing fresh intent against the current live head. Never copy preview event IDs or stale authority decisions into live history.
- **Uncertain external effects are reconciled, not retried blindly.** Use stable IDs and receipts around every durable boundary.

## Testing

Follow `docs/runbooks/testing.md`: one integration test per claim through PostgreSQL (`*.postgres.test.ts`, run by `pnpm run test:db`), goldens for byte-pinned formats, and the `tests/database/` attack suite for authorization and isolation. Claims worth proving: an exact retry returns the stored outcome, a stale revision writes nothing, replay from birth and from a snapshot match the live hash, a denial leaves its evidence, and privacy filtering holds per audience.

## Reject

- Mutable history rows standing in for corrections.
- Attribution added "later" or taken from the client.
- Causal explanations generated from current state.
- Branch promotion by copying events.
- Replay that re-executes money, email or tool side effects.
- Projections that cannot be rebuilt.

## For a new event family or workflow, state

The command, action and event IDs, attribution and causal links, the transaction boundary, projection behaviour, replay semantics, failure and retry rules, the privacy class, and the test that proves reconstruction.
