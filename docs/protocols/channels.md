# Channels and governed delivery

Issue 168 delivers the Wave 5 §13 boundary in parts. This document records the current implementation and the remaining contract, without treating the latter as available API.

## Implemented surface

Browser chat is the production surface. The developer/operator CLI, `node scripts/runtime-chat.mjs`, calls the existing authenticated HTTP conversation routes and the separate public Say route. See the [CLI runbook](../runbooks/runtime.md#developer-conversation-cli) and [conversation protocol](conversations.md).

The server resolves the bearer credential to the Clockgrove principal and world persona, verifies membership and existing grants, and routes Talk to the session's canonical actor owner. The CLI cannot assert a principal or create a new actor. It supplies the same tenant/world/timeline/space scope as the browser.

Commands select their semantic action explicitly: `talk` uses a private conversation session; `say` uses public spatial speech. Neither falls back to the other. A caller supplies the message ID for retries; Talk's existing persisted turn key collapses an exact duplicate and refuses different text under the same key. Session transcripts retain the existing participant-set isolation and encrypted storage.

At this stage the CLI uses the existing HTTP contract, whose session channel is `browser`. Separate `cli` and `fake` channel bindings, normalized inbound envelopes, consent records and governed outbound delivery are not implemented by this first part. No external messaging provider is installed or contacted.

## Remaining boundary

The subsequent parts of issue 168 implement:

- A normalized inbound envelope with source identity assertion, resolved principal, world/timeline/actor, participant set, channel/thread, privacy policy, content parts/media references, reply metadata, authority mode and idempotency key. Unmapped or unverified identities are refused.
- One session per channel thread, sharing the canonical actor and participant-set session model across browser, CLI and deterministic fake adapters, with private Talk and public Say preserved at ingress.
- `DeliveryRequested` carrying actor/session/recipient, channel binding, reason event/goal/promise/subscription, urgency, content artifact, privacy classification, consent/policy version, dedupe key, quiet-hour behavior and budget reservation.
- Policy approval, delay, deduplication, downgrade and rejection after budget reservation. Proactive consent defaults off per actor, and quiet hours use the recipient's own timezone. The actor's proactive capability requests delivery; it never invokes a provider directly.
- Historical replay records without resend, and an isolated preview sink on non-live timelines. Bindings, consent and deliveries require tenant/world/timeline RLS, retention entries and attack-suite proofs.

These are the owner's recorded decisions, not configurable alternatives. The final part proves the complete browser/CLI/fake experience through PostgreSQL, the actor runtime and the scripted fixture model.
