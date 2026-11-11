# Private conversations

Wave 5 RW-0501, local path (issue 14). A person holds private Caretaker Talk sessions with an
actor such as Stevie. Each session has its own ordered history in PostgreSQL, is attributed to the
person's world persona, and survives browser restarts and runtime owner eviction. Talk is private
to the addressed actor and never becomes spatial speech. Public Say is a separate command.

The HTTP surface is described by [conversations.openapi.json](conversations.openapi.json). The
journey `apps/runtime/test/conversations.journey.postgres.test.ts` checks that the runtime serves
exactly its paths.

The [developer CLI](../runbooks/runtime.md#developer-conversation-cli) uses these authenticated HTTP
routes with explicit `talk` and `say` commands. It does not resolve identity locally or grant access.
Its sessions use the `cli` channel; browser, CLI and deterministic fake threads keep independent
transcripts under the [channel protocol](channels.md).

## Authority

Every route is `POST`, version 1, with the browser scope (tenant, world, timeline and space) in the
body and the bearer credential of a signed-in member. The session routes and Talk need
`runtime:world-observe`, the `conversation` category in the member's privacy ceiling and a resolved
world persona. This is the policy the interaction card's Talk action already reports. Say needs the
observe grant and a persona. A new session and Say address only an actor (an entity with needs)
projected in the request's space. A resource answers `409 talk_unavailable`, and an unknown or
unprojected ID answers `409 selection_unavailable`.

Rows are scoped to the session's participant set in SQL (migration 0034). A member sees and
changes only sessions they participate in, with those sessions' participants, messages and turns,
in their tenant, under a ceiling that holds `conversation`. A member cannot join an existing
session. Another member of the same world gets `404 conversation_not_found` for every
session ID, just as for an unknown one. The run inspector ([runs](runs.md)) keeps this rule: it shows a run's
prompt and reply text only to a participant of the session, and other inspectors see metadata. The attack suite in `tests/database/authorization.sql`
exercises this.

## Sessions, messages and turns

- A **session** has a participant set (`participants`: one entry per human participant, a principal
  and their world persona), one addressed actor, one world timeline, a `browser`, `cli` or `fake` channel and the
  `conversation` privacy class. A Caretaker Talk session has exactly one participant, and no route
  adds another; a later shared session adds entries without changing the shape. It records the partition
  and space where it was opened, and it can be read from any space of its timeline. Its state is
  `active`, `archived`, `locked` (reserved) or `deleted`. `deleted` is terminal.
- Its **voice mode** is `cognitive`, `interpreted` or `canonical` (Wave 5 §6.3), with the matching
  disclosure text. The values are those of the Conversation mode component
  (`clockgrove.conversation-mode`, [component catalog](../../packages/domain/docs/component-catalog.md)).
  No pack object declares that component yet, so every Talk-addressable actor speaks for itself:
  `cognitive`.
- **Messages** are immutable and ordered by `sequence` from 1. A Caretaker message is authored by
  the persona and has no voice mode. An actor message is authored by the actor and carries the
  session's voice mode.
- A **turn** joins one input message to its answer. Without a model key bound, the scripted model
  fixture (`scripted-fixture-v1`) answers deterministically and only from its own session: "you
  have said N things to me in this conversation". With a key, the actor's owner answers through the
  ModelGateway's `actor.pilot` alias and the turn records the route's model name (`^[a-z0-9][a-z0-9._-]{0,127}$`).
  Each turn is a recoverable fiber in the actor's runtime owner
  ([recoverable turn fibers](conversation-fibers.md)).
- A turn's answer may carry one **command proposal**: a typed capability call decided by the actor's
  grants ([capabilities](capabilities.md)). The Talk receipt's optional `command`
  (`TalkCommandOutcome`: `capability`, `commandId` or null, `status` `committed` or `refused`,
  `code`, `summary`) says whether the world committed it or refused it, and why. The proposal text
  itself is a `private_cognition` artifact and is never returned.
- Every Talk attempt that reaches the model is one **run** with its steps and one terminal
  disposition, including retried and abandoned attempts. See [run and step evidence](runs.md).

## Channel threads

Create accepts optional `channel` (`browser`, `cli` or `fake`) and `threadId`. An explicit thread is scoped to the authenticated participant, tenant, world and timeline, and binds to one session. A retry addresses that session's canonical actor; it cannot switch actors or revive a deleted session. Without a thread ID, create retains the existing behavior of opening a new session. Session responses add optional `threadId`; existing response fields remain available.

Talk accepts optional `ingress` metadata for a verified source assertion, same-session reply reference, empty media references and member authority mode. The server resolves the other normalized envelope fields from the authenticated participant and stored session. Nonempty media references are refused. See [channels](channels.md#inbound-envelope) for the exact boundary and retention.

## Talk and Say

`/v1/runtime/talk` (`sessionId`, `messageId`, `text`) accepts the Caretaker message as a turn of
the session's actor owner, and answers once the message and the actor's answer are appended to the
active session together. It returns a `private_caretaker_talk` receipt holding the session, both
messages and the turn. Nothing reaches the scene, the scene stream or the journal. The message ID is
the turn's key, and the answer's ID is the message ID followed by `:reply`, so a client message ID
ending in `:reply` is refused as a bad request. A retry or duplicate delivery of the same message
joins, resumes or answers the same turn and never adds a message; other text under the same ID
answers `409 message_id_reused`. While another turn of the session is running, a new message answers
`409 conversation_busy`; a turn whose request died with a lost owner is resumed and waited for
instead, so the next message follows it. Talk can stream its reply, and a turn can be read and cancelled: see
[recoverable turn fibers](conversation-fibers.md).

`/v1/runtime/say` (`actorId`, `messageId`, `text`) returns a `public_say` receipt. Its
`PublicSpeech` has the actor speak a fixed scripted line, never the caller's words, attributed to
the caller. It is the explicit public action, and it is never stored in a session. Delivering it to
the space's audience is later Wave 5 work.

## Storage, limits and retention

Message and title text are never stored in the conversation tables. Each is a `conversation`-class
artifact, which the artifact store keeps only as AES-256-GCM ciphertext under the tenant and
world's data key ([database runbook](../runbooks/database.md#artifact-store)). A row names its
artifact through a foreign key that pins the class. The runtime binds the `ARTIFACT_KEYRING`
secret. Without it, every conversation route fails closed with `503 conversation_unavailable`.

Decided limits:

| Limit | Value |
| --- | --- |
| Message text | 1024 octets |
| Title | 120 characters |
| Messages per session | 1,000 |
| Sessions that are not deleted, per participant and world timeline | 100 |
| Messages per read page | 100 |

Past these limits a request answers `409 conversation_full` or `409 conversation_limit_reached`.
Delete hides a session and its messages from every route and refuses new messages. Its rows and
ciphertext remain until Wave 9 RW-0902 crypto-shreds the data key (`db/retention.json`).

## Governed outbound boundary

The internal [delivery boundary](channels.md#governed-outbound-delivery) governs both solicited replies and proactive notifications. A direct Talk authorizes its own private response; it never opts the member into proactive delivery. Ordinary reply delivery is committed with the turn and uses its canonical actor, participant, channel binding and encrypted reply artifact. Exact retries reuse the durable request and receipt.

Proactive delivery retains recipient-owned per-actor consent, lifetime reservations and quiet hours in the recipient timezone. Actor activation alarms automatically resume delayed requests, rechecking current authority and consent. Live timelines use the deterministic fake sink; non-live timelines use only the isolated preview sink. Replay reads historical receipts without another send. The combined browser/CLI/fake journey proves separate channel-thread transcripts on the same fixture actor.
