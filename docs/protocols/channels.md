# Channels and governed delivery

Issue 168 delivers the Wave 5 §13 boundary in parts. Browser chat is the production surface; the developer CLI and deterministic fake adapter exercise the same canonical actor and participant-set session model. Part 3 adds the durable governed-delivery boundary below; the proactive actor capability and complete runtime journey remain Part 4.

## Implemented surface

Browser chat is the production surface. The developer/operator CLI, `node scripts/runtime-chat.mjs`, calls the existing authenticated HTTP conversation routes and the separate public Say route. See the [CLI runbook](../runbooks/runtime.md#developer-conversation-cli) and [conversation protocol](conversations.md).

The server resolves the bearer credential to the Clockgrove principal and world persona, verifies membership and existing grants, and routes Talk to the session's canonical actor owner. The CLI cannot assert a principal or create a new actor. It supplies the same tenant/world/timeline/space scope as the browser.

Commands select their semantic action explicitly: `talk` uses a private conversation session; `say` uses public spatial speech. Neither falls back to the other. A caller supplies the message ID for retries; Talk's existing persisted turn key collapses an exact duplicate and refuses different text under the same key. Session transcripts retain the existing participant-set isolation and encrypted storage.

Each channel thread has its own session and transcript. Channel identity assertions are verified against the authenticated Clockgrove principal and its world persona; a caller cannot select a different principal or clone an actor. Existing browser requests retain their wire format. No external messaging provider is installed or contacted.

## Inbound envelope

The server normalizes each accepted Talk or Say into `InboundEnvelope` (`packages/contracts/src/channels.ts`):

| Field | Source and meaning |
| --- | --- |
| `sourceIdentityAssertion` | Verified bearer session's external identity link; never the bearer token. |
| `resolvedPrincipal` | Clockgrove principal resolved by the existing identity mapping. |
| `scope`, `actorId` | Authorized tenant/world/timeline/space and canonical addressed actor. Talk resolves the actor from its session. |
| `participants` | Session participant set for Talk; authenticated principal/persona for Say. |
| `channel`, `threadId` | `browser`, `cli` or `fake`, with an independent thread binding for private sessions. |
| `action`, `privacyPolicy` | Explicit `talk`/`conversation` or `say`/`public_scene`; neither is inferred from text. |
| `contentParts`, `mediaReferences` | Text references the encrypted input artifact for Talk. Say carries its ephemeral text. Media references are currently empty; nonempty media is refused. |
| `replyMetadata` | Optional same-session message reference for Talk, otherwise null. |
| `authorityMode`, `idempotencyKey` | Member authority and caller's stable message ID. |

All HTTP adapters use the existing verified bearer credential. An invalid credential or an external identity without a principal mapping is refused before ingress. Optional `ingress.sourceIdentityAssertion` may assert `{kind: "authenticated_session", subject: "external-identity-link-id"}`; it must match the verified bearer identity. A request cannot mark itself verified, choose a resolved principal, or obtain a new grant. Internal authorized store calls without an external identity use an explicitly marked `runtime_principal` source.

`POST /v1/runtime/conversations/create` additionally accepts `channel` and `threadId`. Omitting channel selects `browser`; omitting thread creates a new thread. Explicit thread retries return the same session. The binding includes tenant, world, timeline, principal, channel and thread; another member or scope cannot reuse it to read a transcript. Bindings do not move a conversation between channels or create another actor.

Talk accepts optional `ingress` metadata: source assertion, empty `mediaReferences`, `replyMetadata` (`{messageId}` or null), and `authorityMode: "member"`. The remaining envelope fields come from server-owned session and authentication data. The encrypted envelope is retained alongside the existing encrypted message artifact; retries compare the normalized metadata as well as text. The idempotency key is scoped to its session/channel thread. A changed message under the same key is refused with `message_id_reused` and never starts a second turn.

Say additionally accepts `channel`, `threadId` and `ingress`; omitted channel is `browser`, and its ephemeral thread defaults to the addressed actor ID. Say refuses private reply targets. It normalizes to `action: "say"` with `public_scene` privacy and never enters a private transcript. Say remains the existing ephemeral scripted receipt: it does not persist a conversational message or turn, send a provider notification, or implement governed outbound delivery.

Channel bindings are immutable and protected by tenant/world/timeline/participant RLS. Bindings grow with sessions under the existing session limits and are registered in `db/retention.json`. Envelope artifact IDs are deterministic per attempted session/message key; an attempt interrupted or refused after artifact creation can leave an orphan, just as the existing text-artifact path can. These artifacts share conversation retention and privacy: deleting a session hides them through the conversation surface, with later crypto-shredding under Wave 9 RW-0902.

## Deterministic fake adapter

`FakeConversationAdapter` in `apps/runtime/src/channel-adapters.ts` takes a caller-supplied authenticated POST transport and an authorized scope. Its `create(actorId, threadId)`, `talk(sessionId, messageId, text, ingress?)` and `say(actorId, threadId, messageId, text)` methods call the same HTTP routes as browser and CLI. It selects the `fake` channel at thread creation and public ingress; private Talk resolves channel/thread from the stored session. It owns no actor, credential or transcript store.

The retained `channel-conversations.journey.postgres.test.ts` drives this adapter through the native actor owner and PostgreSQL on `fixture/reference`, checks literal scripted replies and decrypts the accepted envelope for an exact field comparison. The browser journey remains the production UI regression; the fake transport is not a substitute for it.

## Governed outbound delivery

Part 3 introduces an internal `DeliveryRequested` boundary. It carries the authorized scope, canonical actor and session, recipient principal and channel binding, reason (event, goal, promise or subscription), urgency, encrypted content artifact, privacy classification, consent and policy versions, dedupe key, quiet-hour behavior, and budget reservation. No actor calls a provider, and no new public HTTP endpoint or external provider is installed.

The recipient opts in separately for each actor and world timeline. Consent defaults off. Delivery validates the session, participant, binding, current world membership and scoped encrypted content artifact. In this part, content must be an existing actor message artifact from that same session; knowing an artifact ID from another private session grants no delivery access. The proactive producer must persist its note with explicit session/recipient provenance in Part 4. A private delivery retains conversation privacy throughout policy evaluation and sink recording; an urgency downgrade never makes Talk public Say.

A request reserves durable delivery units before evaluating policy or recording a sink receipt. These units bound this internal delivery surface; they are not a monetary wallet. An exact retry reuses its reservation and outcome. Reusing its dedupe key for changed content or metadata is refused. Policy can approve, delay through quiet hours, downgrade urgency, or reject, including absent/revoked consent and exhausted budget. Delayed requests recheck the recipient's current consent and membership before dispatch. Quiet hours use the recipient's IANA timezone, including overnight intervals. Equal start/end minutes disable quiet hours. Delay stores a pending decision; explicit resume re-evaluates the current local time rather than promising a scheduled send instant.

The only implemented destinations are deterministic PostgreSQL sink receipts. Canonical live timelines use the fake sink; canonical branch timelines use the isolated preview sink. The caller cannot turn a branch into a live send. Historical replay reads the durable receipt and never reserves again or inserts a sink receipt. No real messaging provider runs.

Consent, reservations and deliveries are scoped by tenant, world, timeline, actor and recipient, with RLS and explicit retention entries. Sink history references encrypted artifacts rather than storing message plaintext. Part 4 will wire this boundary to the proactive actor capability and prove the full scripted-model completion experience. Existing browser responses continue through the conversation runtime until that integration lands; this part does not claim that every actor response already uses outbound delivery.

## Delivery parts and evidence

Part 1 proves the CLI subprocess through PostgreSQL and the actor runtime on the scripted model. Its second session is created over HTTP; the session's `browser` channel label does not establish a browser UI proof.

| Part | Remaining acceptance and proof |
| --- | --- |
| 2 (merged) | Normalized inbound envelope and verified channel threads; PostgreSQL and actor-owner proofs, with binding RLS, retention and database attacks. |
| 3 (this part) | Governed delivery with budget reservation, consent and quiet hours; replay without sends; isolated preview sink; delivery and consent RLS, retention and database attacks. |
| 4 | Proactive actor delivery producer and the complete browser UI, CLI and fake-adapter experience through PostgreSQL and the actor runtime on the scripted model. |

The Objective remains incomplete until Part 4 lands and its real-path proofs pass.
