# Recoverable turn fibers

Wave 5 §7 and RW-0503, local path (issue 18). This also builds the `ActorAgentDO` foundation
(RW-0307) that Wave 3 moved here. Each Caretaker Talk message becomes a turn. A turn is a fiber run
by its actor's runtime owner, `ActorAgentDO`, and it checkpoints every phase in PostgreSQL. It
streams its reply, can be cancelled, and resumes or retries after the owner is evicted or crashes
at any phase boundary. A duplicate wakeup never duplicates a message, a run commit or a turn. The
routes are in [conversations.openapi.json](conversations.openapi.json). Sessions, messages and
limits are described in [private conversations](conversations.md), and runs in
[run and step evidence](runs.md).

## The owner

`ActorAgentDO` (`apps/runtime/src/cloudflare-adapters.ts`) extends `Agent` from the Agents SDK,
pinned at `agents` 0.33.0 (`apps/runtime/package.json`). It is addressed by
`runtimeRouteName("actor-agent", scope, actorId)`, so one owner serves one actor of a world
timeline. The portable half is in `apps/runtime/src/actor-agent.ts`.

- **Initialization.** It checks the route key against the request's scope and the canonical
  world's readiness (the Wave 0 shell), once for each incarnation.
- **Logical session routing.** Each session has its own lane. A session's turns run one after
  another, and other sessions' lanes run at the same time.
- **Perception inbox.** It keeps a deduplicated set of the last 256 activations, keyed
  `direct_message:<session>:<message>` (Wave 5 §5.2). A duplicate is not admitted again: a Talk
  the inbox did not admit joins the owner's acceptance or run of that message without accepting it
  again. One the owner is not handling falls to the turn's key in PostgreSQL, which answers the
  stored receipt or resumes the turn. Decision: 256 entries. What makes any duplicate harmless is
  that key, so forgetting an entry is safe.
- **Capability revision hook.** `reconcileCapabilities(revision)` records the newest revision, and
  the revision only moves forward. Each later claim of a turn stores the revision it ran under
  (`capability_revision`). RW-0506 will announce grant changes through this hook.
- **Recovery metadata.** The owner records its incarnation, how many incarnations it has had, the
  capability revision and how many turns this incarnation resumed.

The owner's local storage holds only what can be rebuilt: the Wave 0 runtime state, the inbox, the
recovery metadata and the SDK's own fiber rows. Losing all of it loses no turn.

## Phases

```text
accepted → context_pending → context_ready → model_running → proposal_validating
         → committing → finalizing → completed
terminal: rejected | cancelled | failed | abandoned
```

A turn is one `conversation_turn_fibers` row (migration 0038), keyed by session and message ID.
Its phase is its checkpoint. The phases do this:

- `accepted`: the message's text is stored as its input artifact.
- `context_pending`, then `context_ready`: fixes the session revision the turn reads. Each claim
  assembles its attempt's context ([context assembly](context-assembly.md)) with its run, since
  the run's prompt and manifest are that context.
- `model_running`: streams and stores the answer as a protected artifact. A document proposal
  (issue 17) is stored beside it as a `private_cognition` artifact (`proposal_artifact_id`), so a
  recovered attempt commits the same proposal. This checkpoint is the `proposal_validating` move.
- `proposal_validating`: the scripted model proposes no command or effect. A document proposal is
  validated where it commits.
- `committing`: appends the Caretaker message, the reply, the conversation turn, any document
  change set and the run's commit step, and moves the fiber to `finalizing`, all in one
  transaction. The runtime reads the checkpointed proposal back under the same one-call
  `private_cognition` ceiling it wrote it with; no route returns it to the participant.
- `finalizing`: releases the turn.

SQL guards (`guard_turn_fiber`) enforce these rules for every writer:

- A turn starts `accepted`.
- Its phase moves only forward.
- A finished turn never changes.
- A checkpointed answer never changes, and a proposal is checkpointed only with its answer.
- The lease epoch never decreases.

A session holds at most one open turn, enforced by a unique index. A different message sent while
one is open answers `409 conversation_busy`. That is what orders a session's turns.

## Leases, attempts and recovery

The owner claims a turn before running it, and each claim bumps `lease_epoch` and `attempt`. Every
checkpoint and the commit are fenced by the epoch and the phase this holder last saw. When the
fence fails, a cancel or a newer claim has overtaken this holder, and it stops. A commit that has
been fenced out rolls back, messages included.

Every claim before `finalizing` opens a new run (0036). A claim closes the previous holder's open
run as `abandoned` with outcome `owner_lost`, so every abandoned attempt is recorded. If the answer
was already checkpointed, the new run's model step succeeds with that same artifact, and the turn
commits it without asking the model again (resume). Before that point the model runs again
(retry). A claim at `finalizing`, after the commit, only finalizes and opens no run.

A Durable Object has a single live instance, so a new incarnation of the same owner takes over a
turn at once. These paths resume a turn:

- The SDK's interrupted-fiber recovery (`onFiberRecovered`), started by the next request or by the
  owner's persisted keep-alive alarm. The SDK row's snapshot names the participant and the turn.
- The participant's next call to the owner (Talk, status or cancel). Once per incarnation, it
  resumes that participant's open turns with this actor from PostgreSQL. This covers an owner that
  lost its local storage, and the SDK rows with it.
- A Talk retry with the same message ID, which joins the running fiber or resumes it.

Within one incarnation, an activation that is already running joins that run instead of starting
another. A new message of a session with an open turn reads that turn from PostgreSQL. If a live
Talk request is running it in this owner, the message answers `409 conversation_busy`. Otherwise
its request died with a lost owner: the message resumes (or joins) that turn, waits for it to
settle, then takes its turn, so a member's next message after a dead request is not refused.
Decision: at most 3 resumptions before answering busy, since each one claims the turn under a new
attempt and one normally settles it. The fiber row's key decides between incarnations. Recovery acts as the stored participant,
whose accepted message started the turn.

## Streaming, status and cancel

`/v1/runtime/talk` answers when the turn commits: the same receipt as before. Sent with
`Accept: application/x-ndjson`, it streams `TalkStreamFrame` lines instead: `delta` tokens, then
one `receipt` or `refused` frame. Deltas are presentation only. They are never stored, and a client
must not treat them as the reply. An owner that fails mid-turn ends the stream without a final
frame, or answers `503 turn_interrupted`. The turn is durable, so the client resends the same
message ID, or reads its status.

`/v1/runtime/turns/status` (`sessionId`, `messageId`) answers the durable `TurnStatus`: `phase`,
`attempt` and `outcomeCode`. A reconnecting browser reads the status, then the transcript, instead
of replaying tokens.

`/v1/runtime/turns/cancel` cancels a turn that has not started committing. The turn ends
`cancelled` with outcome `cancel_requested`, its run ends `cancelled`, and no message is stored. A
later Talk with that message ID answers `409 turn_cancelled`. A turn that is already committing or
finished keeps its phase, and cancel answers its status unchanged.

Status and cancel use Talk's authority (`runtime:world-observe`, the `conversation` category and a
persona) and its row policy. Only the session's participant sees or moves its turns. An unknown
message answers `404 turn_not_found`.

## ActorProcess

`ActorProcess` (`packages/contracts/src/turn-fibers.ts`) is the contract for long-lived actor work
(Wave 5 §1). A process has a stable ID for its actor's life, one objective, a checkpoint, a lease
epoch, and a sequence of bounded run segments (`actor_processes` and `actor_process_segments`,
0038).

- `ActorAgentDO.advanceProcess` runs one segment. It claims the next lease epoch, then appends one
  segment from the current checkpoint.
- The segment trigger refuses a write under an older epoch or holder (`CG022`). It also refuses a
  write that does not continue the checkpoint, and it moves the checkpoint itself.
- Decision: at most 64 segments a process.
- The only objective today is the `fixture-tally` fixture. Only the native test entry calls it.
- Proactive activations use the same turn fiber, as described below.

## Proof and fault injection

`apps/runtime/test/turn-fibers.journey.postgres.test.ts` runs the native owner in workerd against
PostgreSQL. Its test owner ends its incarnation (`ctx.abort`) right after a named checkpoint, once
for each turn and phase. Production has no such hook. The journey proves these cases:

- A crash at every boundary, including mid-stream, recovers, and the transcript holds each message
  exactly once.
- The runs show each abandoned attempt.
- Duplicate deliveries coalesce.
- Turns are ordered within a session, and sessions run concurrently.
- A running turn can be cancelled.
- An owner that lost its local storage recovers.
- The capability hook works.
- An `ActorProcess` keeps its ID across segments, owner restarts and lease epochs.

## Known gaps

Local owner recovery does not claim hosted delivery, deployment or eviction qualification.
An owner that loses all local storage needs a subsequent routed call to rebuild its alarm;
PostgreSQL retains its configuration, activation decisions and turn checkpoints.

## Proactive activation

The authenticated Runtime HTTP API exposes three POST routes, each with a JSON body containing
`version: 1`, `scope` (the existing browser scope) and `actorId`:

- `/v1/runtime/activations/configure` additionally takes `configuration` and `policy`.
- `/v1/runtime/activations/wake` additionally takes `wake`.
- `/v1/runtime/activations/inspect` returns the actor's bounded activation evidence, configuration,
  model reservation count and `nextWakeAt`.

Configuration and explicit wakes require `runtime:world-command`. Inspection requires
`runtime:world-observe`. All three require the caller's world persona, the `conversation` privacy
category, matching authorized scope, and an addressable cognitive actor. The caller's identity is
supplied by authentication, never by the body. A configuration belongs to a conversation session
of that participant and actor.

A configuration contains `id`, `sessionId`, `kind`, `nextWakeAt` (epoch milliseconds or null),
`intervalMs` (milliseconds or null, at least 60,000 when set), optional `eventType`, `input`,
`priority` (0–100), `enabled` and
`compiledRoutine` (`noop` or `escalate`). The policy contains `allowModel` and `modelBudget`, a
lifetime model-opportunity allowance (0–1,000) shared across the actor's configurations.
An opportunity is reserved before model escalation; interrupted model retries reserve another. A wake
contains `configurationId`, `causalRoot`, `reason` and `evidence`. Its discriminated reason is one
of Wave 5 §5.2's scheduled intention, subscription, perception, threshold, heartbeat, tool
completion or operator reasons, with the corresponding reason identifier.

The actor's canonical causal-root key coalesces deliveries before escalation. Deterministic
compiled routines and policy run before a model opportunity is reserved; a no-op or deferred
activation records its outcome without opening a model turn. An admitted model activation uses a
stable message ID in the existing recoverable turn fiber. Inspection preserves its reason, causal
root, participant attribution, decision and next wake. Configurations and durable deduplication
receipts are bounded to 64 configurations and 1,000 causal receipts per actor; exhausted
capacity refuses additional admission rather
than forgetting an old receipt and risking duplicate execution.

A compiled `noop` decision disables that configuration and clears its next wake, suppressing
repeated empty opportunities until an operator reconfigures it. Subscription event polling and
recovery checks use a one-minute cadence while configured work remains eligible. These are
explicit local bounds, rather than continuously running actor processes.

Threshold configurations match a canonical threshold-crossing `eventType`; deterministic world
logic owns evaluation of the physical condition. Event cursors start at the journal head when
the actor's policy is first configured. Recurring intentions retain their scheduled cadence and
skip missed opportunities instead of producing an unbounded catch-up burst.

The model boundary rechecks the current policy, compiled decision, membership and fiber lease.
Recovery after the answer checkpoint reuses the answer. Deferred evidence keeps its causal
identity and can resume when an operator changes the policy or allowance.

These routes provide the local operator and inspector surface. The activation journey is intended
for native workerd/PostgreSQL local proof; it does not establish hosted delivery. Wave 5
qualification and hosted delivery remain separate obligations.
