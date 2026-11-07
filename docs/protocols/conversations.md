# Private conversations

Wave 5 RW-0501, local path (issue 14). A person holds private Caretaker Talk sessions with an
actor such as Stevie. Each session has its own ordered history in PostgreSQL, is attributed to the
person's world persona, and survives browser restarts and runtime owner eviction. Talk is private
to the addressed actor and never becomes spatial speech. Public Say is a separate command.

The HTTP surface is described by [conversations.openapi.json](conversations.openapi.json). The
journey `apps/runtime/test/conversations.journey.postgres.test.ts` checks that the runtime serves
exactly its paths.

## Authority

Every route is `POST`, version 1, with the browser scope (tenant, world, timeline and space) in the
body and the bearer credential of a signed-in member. The session routes and Talk need
`runtime:world-observe`, the `conversation` category in the member's privacy ceiling and a resolved
world persona. This is the policy the interaction card's Talk action already reports. Say needs the
observe grant and a persona. A new session and Say address only an actor (an entity with needs)
projected in the request's space. A resource answers `409 talk_unavailable`, and an unknown or
unprojected ID answers `409 selection_unavailable`.

Rows are scoped to the participant in SQL (migration 0034). A member sees and changes only
sessions, messages and turns that name their own principal, in their tenant, under a ceiling that
holds `conversation`. Another member of the same world gets `404 conversation_not_found` for every
session ID, just as for an unknown one. The attack suite in `tests/database/authorization.sql`
exercises this.

## Sessions, messages and turns

- A **session** is one participant (principal and persona), one addressed actor, one world
  timeline, the `browser` channel and the `conversation` privacy class. It records the partition
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
- A **turn** joins one input message to its answer. The scripted model fixture
  (`scripted-fixture-v1`) answers in the same request, deterministically and only from its own
  session: "you have said N things to me in this conversation". RW-0503 and RW-0504 replace it with
  recoverable turn fibers and the ModelGateway.

## Talk and Say

`/v1/runtime/talk` (`sessionId`, `messageId`, `text`) appends the Caretaker message and the actor's
answer to an active session in one transaction, and returns a `private_caretaker_talk` receipt
holding the session, both messages and the turn. Nothing reaches the scene, the scene stream or the
journal. The message ID is an idempotency key: an exact retry answers the stored message, reply and
turn, and other text under the same ID answers `409 message_id_reused`. A concurrent message that
won the session's next sequence answers `409 conversation_busy`.

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
