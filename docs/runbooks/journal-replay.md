# Journal append and replay

The application package owns the provider-neutral `Journal` and `JournalEventReader` ports.
`PostgreSqlJournal` is the inward-pointing adapter; PostgreSQL is the sole canonical durable history.
The accepted `@clockgrove/contracts` command, event, attribution, actor-address, ordering, privacy,
queue-channel, ID, and upcasting types cross the seam unchanged. SQL/provider client types remain in
the persistence package.

## Canonical transaction

`Journal.execute()` starts a short transaction and installs tenant, principal, and privacy context
with transaction-local `set_config`. Every request carries the command's AuthorityDecision
(`authorityDecision`, an allow or deny decision without `decidedAt`, which the database assigns).
The PostgreSQL append function first refuses a malformed request or decision, and a request whose
event drafts seal another `authorityDecisionId` (`JournalAuthorityDecisionMismatchError`), and checks
that the target world and timeline belong to the authorized tenant (`JournalRouteNotFoundError`
otherwise). It then performs the prescribed sequence: create or lock the attributed command receipt
(attribution, ActionId, target, correlation, causation and expected revisions); compare the SHA-256
and exact accepted command bytes; return an already committed or rejected stable response; record
the decision; for a deny decision, mark the receipt `rejected` with its stable rejection and stop,
appending nothing and moving no head; otherwise lock all required partition heads and then stream heads
in lexical key order; verify the primary stream revision, partition revision, and routing epoch;
validate event drafts against authoritative current routes; allocate per-stream and per-partition
sequences; append version-2 semantic event bytes; write the partition state of a world command;
insert internal/external dispatch intent; and store the complete
stable response and the decision reference on the `committed` receipt. The adapter commits before
invoking the best-effort notification port.

Migration `0007` splits that function in two, and `clockgrove.execute_journal` is now their wrapper,
so world provisioning and the runtime no-op keep one SQL path:

- `clockgrove.begin_command` runs everything up to and including the expected-value checks: request
  and decision validation, the route check, the receipt and byte compare, the stored outcome
  (`{status: 'decided', result}`), the decision, a denial's rejected receipt, and the sorted head
  locks. The lock set is the primary route plus every draft already in the request. It records the
  open command and its lock set transaction-locally (`app.journal_command`) and returns
  `{status: 'begun', aggregate}`; one transaction holds at most one open command.
- `clockgrove.append_command` closes that command: drafts must seal its decision and stay inside its
  lock set (a transaction never widens its locks), then sequences, events and dispatch intent, the
  partition state, and the receipt. Its `rejected` outcome commits a rejected receipt and nothing else.

## World commands

`executeWorldCommand` (application) runs a Wave 1 kernel command through
`PostgreSqlWorldCommandJournal` (persistence) in one transaction: `begin_command` with
`aggregate: true`, one synchronous pure `executeWorldKernel` call, `append_command`, COMMIT. The step
between them is a synchronous callback, so no I/O happens while the receipt, head and state locks
are held; the pack behavior is read before the transaction begins and must match the world's
installed pack (`WorldBehaviorMismatchError` otherwise).

- The live state is one hashed partition-state document per partition (`clockgrove.partition_states`)
  plus its schedule rows (`clockgrove.partition_schedules`, Wave 2 plan §7.3): the document holds the
  kernel's world state, named random state and the hash of the schedule queue as a typed canonical
  node, with the document hash, the simulator's state hash (`sha256(canonicalBytes(state))`), the
  kernel revision and the journal head it covers. The queue is the partition's pending rows in due
  order. A reader verifies both hashes, the revision, each row against its item hash and the rebuilt
  queue against the document's queue hash before using it; any difference is
  `PartitionStateIntegrityError` and nothing runs on it.
- The client-visible partition revision of a world command is the kernel revision (D1, amending Wave 2
  plan §7.2): `expected.partitionRevision` is checked against the locked state's revision, and the
  journal `head_sequence` stays internal. The runtime no-op still compares against the head until
  gateway routing of world commands (Wave 3).
- Each kernel event becomes one journal event of the same type on the command's route, privacy
  `public_scene`, ID `<commandId>:event:<index>`, payload `{kernelEvent: <typed canonical node of the
  complete kernel event>}`. The kernel event types are registered in `JOURNAL_EVENT_REGISTRY` at
  schema version 2; the kernel event's own version stays in the payload. Kernel IDs derive from the
  command ID and the stream `WORLD_COMMAND_ID_STREAM` (the simulator's), and the kernel attribution
  is the command's sealed with the journal decision, so one command through the Journal is the same
  pure kernel call.
- A committed command with at least one event writes one outbox intent in the same transaction: one
  `world-reactions` dispatch for the whole command, anchored on its first event, ID
  `<commandId>:dispatch:world-reactions`, privacy `public_scene`, status `pending`. Each due-work or
  continuation chunk is its own command and gets its own dispatch. A refusal, a denial, an exact retry
  and every fault stage write none.
- The kernel's new queue is diffed against the locked rows: occurrences that left or changed become
  `done` (with the command ID), new or changed ones are inserted `pending`, in the command's
  transaction with its events and state.
- A kernel refusal commits a rejected receipt under the allow decision with
  `{status: 'refused', refusal}`. A stale expected revision raises `JournalRevisionConflictError` and
  writes no receipt. A denial commits its rejected receipt without loading state or running the
  kernel. An exact retry returns the stored outcome and runs the kernel zero times. An event ID that
  already exists is `JournalEventIdCollisionError` (`CG010`, or `23505` when a concurrent insert wins).
- `executeWorldCommand` refuses a client command ID in the trusted namespace (`trusted:`) with
  `TrustedCommandIdRefusedError` before reading or writing anything, as the runtime no-op decoder does
  for command and event IDs. Trusted world commands (due-work advances and continuation chunks) are
  minted only by application code, so no tenant member can squat their receipt, decision or event IDs.
- Test-only fault points cover `after-receipt`, `after-head-locks`, `after-kernel` (adapter side),
  `after-events`, `after-dispatches`, `after-schedules`, `after-state` and `before-commit`, plus
  response loss after COMMIT.

### Timeline clock policy journal

`PauseWorld`, `ResumeWorld` and `SetClockPolicy` use the existing command envelope and canonical-node
codec. Their accepted transaction records the receipt, allow decision, `ClockPolicyChanged` event
and resulting timeline policy together. Exact retries return the stored outcome with no second
policy mutation. Denials use the existing decision/refusal path. Clock controls preserve the
physical state hash, kernel revision, schedule queue and named random state; they change time policy
rather than advancing the kernel.

`TimelineClockPolicy`, exported by the application package, carries the committed policy version,
running state, simulation/wall mapping, speed and catch-up cap. Ready worlds start paused using the
installed genesis speed and a cap of 86400000 simulation milliseconds. First resume uses current
canonical simulation time and trusted server wall time, excluding elapsed time since the pack's
`wallEpoch`. Pause retains earned simulation time and pending work but accrues no paused wall time.
Resume and speed changes retain earned backlog; a speed change preserves time earned at the previous
speed before establishing the new mapping. The cap bounds each activation without discarding
unconsumed earned time.

The version is checked at trusted physical commit authority, preventing an advancement computed
under a superseded policy from committing after the clock change. Trusted execution is scoped to
its ready tenant/world/timeline and needs no retained browser credential. Runtime-local loss
reconstructs policy and version from canonical history; corrupt stored policy is an integrity
failure rather than invalid client input. `ResumeWorld` changes running state; the existing
`continueWorldCommand` operation resumes a physical continuation chunk and does not unpause the
clock. Autonomous alarm delivery is a separate capability.

Transaction bounds. `PostgreSqlWorldCommandJournal` sets, transaction-locally,
`lock_timeout = 3s` (a wait on another command's receipt, head or state lock fails with a retryable
`JournalTimeoutError('lock')`, SQLSTATE `55P03`), `statement_timeout = 10s`
(`JournalTimeoutError('statement')`, `57014`) and `idle_in_transaction_session_timeout = 30s`. The kernel
call runs while the transaction is idle between begin and append, so the last bound caps how long one
kernel call holds the partition's locks: past it PostgreSQL ends the session (FATAL `25P03`), the
command fails with `JournalTimeoutError('idle')` and nothing commits. The client often sees only the
closed socket, so the adapter also maps a connection failure after a kernel step that outlasted the
bound to that error. The kernel admits calls of up to 4096 events, about 5 s on an idle host and
several times that on a shared CPU, so the idle bound matches the Workers 30 s invocation CPU limit.
The defaults are `WORLD_COMMAND_TIMEOUTS`; tests pass shorter ones. The owner logs the cause of any
failure it reports as `world_command_failed`.

Continuations. A kernel result with `complete: false` commits its chunk and persists the kernel's
continuation on the partition state, with the origin command and its kernel attribution (the kernel
binds a continuation to both) and the trusted ID of the next chunk,
`trusted:continue:<originCommandId>:<n>`. While it is open the partition accepts only that chunk
(`WorldContinuationPendingError` otherwise, nothing written). Each chunk is its own transaction: it
calls the kernel with the origin command, attribution and ID seed plus the continuation, journals its
events under its own ID and decision, and writes the next continuation or clears it. Every byte of a
chunk derives from the stored record, so its retry returns the stored outcome.

Clearing a blocked continuation. If the kernel refuses a chunk, the chunk commits a rejected receipt
and the continuation stays open. Every later `advanceDueWork` call then returns `refused` with the
stored outcome of the same `trusted:continue:` receipt, and the partition accepts no other command.

1. Diagnose from the rejected receipt. Its result holds the kernel refusal:

   ```sql
   SELECT state.continuation_command_id, receipt.status, receipt.result->'value'->'refusal'
     FROM clockgrove.partition_states AS state
     JOIN clockgrove.command_receipts AS receipt
       ON receipt.tenant_id = state.tenant_id AND receipt.command_id = state.continuation_command_id
    WHERE state.tenant_id = :'tenant' AND state.timeline_id = :'timeline'
      AND state.partition_id = :'partition';
   ```

2. Fix the cause (for example a behavior pack that changed under the open chain). The state stays at
   the last committed chunk, which is a complete kernel state; only the rest of the origin command is
   lost.
3. As the migrator role, clear the three continuation columns together, guarded by the blocked chunk
   ID so a chain that moved on is left alone:

   ```sql
   BEGIN;
   SET LOCAL ROLE clockgrove_migrator;
   UPDATE clockgrove.partition_states
      SET continuation = NULL, continuation_hash = NULL, continuation_command_id = NULL,
          updated_at = statement_timestamp()
    WHERE tenant_id = :'tenant' AND timeline_id = :'timeline' AND partition_id = :'partition'
      AND continuation_command_id = :'blocked_chunk_id';
   COMMIT;
   ```

   The state document, its hash and the schedule rows are untouched. The next `advanceDueWork` issues
   a fresh trusted advance from the stored revision.

Due work. `PostgreSqlDueWorkReader` answers the next-deadline query (`pendingWork`: revision,
simulation time, earliest pending `due_at`, open continuation) and the due query (`dueSchedules`:
pending occurrences due through a time, in the kernel queue's order) from the due index.
`advanceDueWork` (application) first runs the chunks of an open continuation, then, while a schedule
is due at or before `through`, issues one trusted `world.advance` to `through` through the
world-command path, with ID `trusted:advance:<timelineId>:<partitionId>:<revision>:<targetTime>`,
expected revision `<revision>` and kernel budget `DUE_WORK_ADVANCE_BUDGET` (16 inputs, 4096 events),
so one kernel call stays short and the rest runs as chunks. A stale revision re-reads and retries; the
expected revision and the trusted IDs make a retried call append nothing twice. `continueWorldCommand`
runs one chunk. Wave 3 alarms call the same use case.

The birth-to-live handoff: the `WorldReady` transaction also writes the world's initial partition
state (the verified post-seed state, schedules and random state) on the partition of the first
declared space, covering the head `WorldReady` reached. A Wave 1 world has one kernel partition, homed
there.

Trusted code mints each decision's ID from the command identity (`authority:<commandId>`), so a
retry derives the same ID and client input never chooses it. The runtime builds allow and deny
decisions from the trusted authorization result and its inputs; world provisioning records one
allow decision per stage command. A rejected result is `{value, events: [], projectionDelta,
outcome: "rejected"}`; a committed result keeps the Wave 0 shape. `AuthorizedPersistenceTransaction`
reads receipts and decisions back decoded with `decodeCommandReceipt` and `decodeAuthorityDecision`.

Canonical event payloads are immutable. Stream sequence orders one stream, partition sequence orders
one partition, and journal position records ingestion order without claiming universal causality.
The JSONB-to-UTF-8 encoding used for stored event bytes and the SHA-256 request-hash spelling are
engineering choices, not additions to the shared taxonomy.

No model, MCP, R2, Queue publication, telemetry, provider/network call, or long computation occurs
inside the transaction. External effects exist only as transactional outbox intent and require
application-level idempotency when delivered at least once. A notification failure cannot alter the
commit: the dispatch rows are canonical, and the next sweep finds every due one.

## Dispatch delivery

`sweepDispatches` (packages/application/src/dispatch.ts) delivers committed dispatch intent for one
tenant's channel under that tenant's normal RLS authorization. It claims due rows through
`PostgreSqlDispatchStore` (migration `0009`, see `docs/runbooks/database.md`), publishes each as a
`QueueEnvelope` with `messageId = dispatchId`, `sourceEventId`, `correlationId` and
`attemptHint = attempt`, and settles it: `delivered` when the publish succeeds; when it throws,
`retry` after `retryAfterMs`, or `failed` (with `last_error_class`) once the attempt reaches
`maxAttempts`. It repeats until nothing is due.

`DispatchHintNotifier` is the post-commit hint: passed as the `notifier` of `PostgreSqlJournal` or
`PostgreSqlWorldCommandJournal`, it wakes the sweep of a committed result's tenant. Its failure is
swallowed. A lost hint (a crash after COMMIT, or a failing notifier) costs latency only.

Delivery is at least once and one semantic dispatch per `messageId`:

- each dispatch is published by one claim holder at a time, because concurrent sweeps claim disjoint
  rows;
- a crash between publish and settle leaves the lease to expire, and the next sweep republishes under
  the same `messageId` with the next `attemptHint`; consumers dedupe on `messageId`;
- a holder whose lease was reclaimed cannot settle: its attempt is stale.

Wave 2 has no Queue publisher or cross-tenant sweeper, and no production composition builds the
notifier yet. `apps/runtime/test/dispatch-delivery.postgres.test.ts` proves the claims above with a
fake publisher.

## Idempotency, conflicts, and failure semantics

A receipt is scoped by tenant and command ID. Exact command bytes are stored in `bytea`, and their
database-computed SHA-256 is stored beside them. A concurrent contender waits on the same receipt.
Identical bytes receive the stored response; different bytes fail with the accepted
`CommandIdempotencyInvariantError` behavior. Expected stream, partition, and routing-epoch values are
checked only after deterministic head locking and return typed application conflicts.

Domain and authority denials commit a stable `rejected` receipt with their deny decision. An exact
retry of a decided command, allowed or denied, returns the stored outcome and inserts no decision,
whatever decision the retry carries. `PostgreSqlJournal.storedOutcome` (the optional
`JournalOutcomeReader` port) reads that outcome without deciding anything, and the runtime gateway
uses it before authorization, so an exact retry does not run the authority-decision step again.
Receipts committed before migration `0006` are `legacy-wave0`: they have no attribution, ActionId or
decision, and their exact retries return their stored result. Revision conflicts and infrastructure
failures roll back the receipt, decision, events and dispatches together and stay retryable, so no
Wave 2 path writes a `failed` receipt.

The crash contract is:

- before commit, receipt/decision/event/head/outbox changes all roll back;
- after commit but before reply, an exact retry returns the stored complete response without another
  event or dispatch;
- a lost post-commit hint leaves pending dispatch intent for the next sweep;
- any future Durable Object cache disagreement resolves in favor of PostgreSQL revisions.

The adapter exposes bounded fault points solely for database tests and a post-commit response-loss
hook. These are not fields in a command and do not grant runtime mutation authority.

## Payload hashes, the event registry and verified appends

`computePayloadHash(payload)` is `sha256:` followed by the lowercase hex SHA-256 of the kernel
`canonicalBytes(payload)`. World provisioning records the same spelling, and the stored
`payloadHash` of an event is always this value for its stored payload.

`JOURNAL_EVENT_REGISTRY` is the `@clockgrove/contracts` event type registry of the types this
repository writes: `WorldGenesisCreated`, `WorldSeedCommandApplied`, `WorldProjectionVerified`,
`WorldReady`, `RuntimeNoOpAccepted` and every Wave 1 kernel event type (`WORLD_KERNEL_EVENT_TYPES`),
each at schema version 2. A registry lists `(type,
schemaVersion)` pairs; `resolveEventType` distinguishes an unknown type from a known type at an
unknown version.

`verifyJournalRequest(request, registry)` is the single application-layer check of a journal request
and has no side effects. It checks every draft and throws `JournalDraftRefusedError` (with `reason`
and `eventId`) for the first refused one, so a request with one invalid draft writes nothing:

- `unknown-event-type`: the draft type is not in the registry;
- `unknown-event-version`: the type is registered, but not at the draft's `schemaVersion`;
- `payload-not-json-stable`: the canonical bytes of the payload differ from the canonical bytes of
  the payload after the stored JSON round trip (`JSON.parse(JSON.stringify(payload))`), for example a
  `bigint`, `Map` or `Set`, or a value canonical bytes cannot encode;
- `payload-hash-mismatch`: `payloadHash` differs from `computePayloadHash(payload)`.

`VerifiedJournal` wraps a `Journal` and a registry and applies `verifyJournalRequest` before
delegating. The runtime space owner wraps its supplied journal this way, and every world-provisioning
stage request is verified when it is built, before the persistence port writes it, so a stage's case
update and its events still commit or roll back together. `PostgreSqlJournal` stays a trusted adapter
that stores the verified bytes and hash.

## Range reads

`JournalRangeReader` serves `readStream({tenantId, timelineId, streamId}, range?)` and
`readPartition({tenantId, timelineId, partitionId}, range?)`. `range` is `{from?, to?}`, inclusive;
`from` defaults to 1 and `to` to the current head. The result is the events in ascending
`streamSequence` (respectively `partitionSequence`), each upcast through `upcastEventBytes` and
checked against the reader's registry and `computePayloadHash(payload)`. A read returns the whole
range or throws `JournalReadIntegrityError`; there is no partial result. Its `reason` is one of:

- `sequence-gap`: a sequence number in the range is missing, duplicated or out of order, including a
  missing tail up to the head;
- `payload-hash-mismatch`: a stored payload does not match its `payloadHash`;
- `unknown-event-type` / `unknown-event-version`: the stored event is not in the reader's registry
  (the version checked is the upcast one);
- `malformed-event`: the bytes do not decode, or the event lies outside the requested scope.

`PostgreSqlJournalRangeSource` supplies the raw rows and the head in one transaction under
`installAuthorization`, so tenant and privacy row-level security apply. Another tenant's events are
never returned, and events hidden by the privacy ceiling are absent rows, which makes the range fail
with `sequence-gap` instead of being skipped.

## Snapshots

A snapshot is a verified copy of one partition's stored projection at a committed head: the
document, its pending schedule rows and the head it covers (RW-0208, issue 677). It is acceleration only;
nothing writes it back to the live projection.

- **Create:** `createPartitionSnapshot(authorization, scope, ports)`, never inside a journal
  transaction. `PostgreSqlSnapshotStore.readCommitted` reads the state row, its schedules, the pack
  hash and the route stream's coverage in one repeatable-read transaction. An open continuation is
  `SnapshotNotQuiescentError`; retry later. The read is decoded and verified before it is stored as
  one `public_scene` artifact (`<snapshotId>:artifact:<compatibility>`) and indexed by a `snapshots`
  row. Both IDs derive from the covered head, so a retry after a crash at any point gives one artifact
  and one row. The artifact ID also carries the first 16 hex digits of the SHA-256 of the canonical
  compatibility: after a kernel registry change (migration 0029) the same head encodes differently,
  and the old artifact at that head stays, because artifacts are append-only.
- **Restore:** `loadPartitionSnapshot(authorization, ref, packContentHash, ports)` checks, in order:
  - the artifact's length and hash (`ArtifactIntegrityError`);
  - the format and every document hash (`SnapshotIntegrityError` with the reason);
  - the row against the content: scope, stream, both covered heads, state hash and compatibility
    (`row-mismatch`);
  - compatibility with the current pack (`SnapshotIncompatibleError`).

  It returns the document only after all four checks pass, and never falls back to another snapshot.
  Callers choose full replay explicitly. `replayToSequence` and `verifyPartitionReplay` start only from
  a snapshot whose row names the current compatibility set (`isSnapshotCompatible`): one written under
  another kernel registry or pack, such as the previous runtime writes before a deploy, is passed over
  for an older compatible snapshot or the birth, and is neither loaded nor reported.
- **Reads** are under RLS. Another tenant or a ceiling without `public_scene` lists nothing and gets
  `ArtifactNotFoundError` on load.
- **Scheduled job:** the runtime's snapshot Cron Trigger, every 5 minutes in its own invocation,
  runs `sweepPartitionSnapshots` (`apps/runtime/src/cloudflare-entry.ts`, issue 843). For up to 4
  partitions per run that have no compatible snapshot or whose head is 2,000 events past their latest
  one, least recently attempted first, it reads the committed partition once, verifies that read with
  `verifyPartitionReplay` in `exact` mode, then snapshots exactly the verified head
  (`maintainPartitionSnapshot`, `packages/application/src/snapshot-maintenance.ts`). A verification
  failure writes no snapshot and is reported, never repaired. Cadence, bounds and the operator's view
  are in [runtime.md](runtime.md#scheduled-snapshots-and-verification-replay).

`apps/runtime/test/partition-snapshot.postgres.test.ts` runs in `test:db`;
`apps/runtime/test/runtime-snapshots.postgres.test.ts` runs the scheduled job natively in
`test:runtime`.

## Causal inspector

`inspectCommand(authorization, commandId, ports)` reads one command's causal chain (RW-0210, issue 686).
It is an application call with a PostgreSQL adapter and writes nothing. Operators reach it through
the audited `POST /v1/runtime/causal-chain` endpoint ([runtime runbook](runtime.md#causal-chain-inspector), issue 701);
there is no CLI.

- **View:** the receipt (without its event IDs), the authority decision, the events, the schedule
  rows the command scheduled or consumed, its dispatches, and `links`. Walk the chain by inspecting
  `links.parents` and `links.children`.
  - Parents are the declared immediate cause and the commands that scheduled the rows this one
    consumed.
  - Children are the commands that consumed rows this one scheduled, and its continuation chunks.
    Chunks are found by their trusted IDs (`trusted:continue:<origin>:<n>`), one key lookup each,
    so a client command cannot pose as a chunk by declaring a correlation or cause.
- **Reads:** `getCommandLinks` runs in the same authorized transaction as the receipt and the
  decision. Events then come only through `JournalRangeReader.readPartition`, under the same
  principal. They must equal the receipt's `committedEventIds`, or the call fails with
  `InspectionIntegrityError("events")`. A corrupt event fails as `JournalReadIntegrityError`.
- **Retained routine decisions:** newly committed world commands keep the original kernel
  `decisionDrafts` of kind `routine` in their immutable receipt result's projection metadata, including every decision
  in a multi-decision command and each continuation chunk. Evidence has the receipt's lifetime
  (no independent expiry), commits atomically, and exact retries read the same stored evidence.
  No physical event, state, schedule or random-state encoding changes. The ordinary command
  response omits this inspector evidence.
  Under `public_scene`, `decisionTraces` is `{ status: "available", drafts }`, where `drafts` is
  the canonical node of the original ordered routine drafts (including an empty array).
  Decode it with `decodeCanonicalNode`: each draft contains the original `DecisionTrace`, with
  object identity, input revision, simulation time, policy, candidates, features/scores, selected
  action, perception/belief/memory references, random draws and outcome links. A draft is addressed
  by its receipt command ID and array index; receipt attribution and verified events retain action
  and causal identities. Chunk receipts retain their own drafts and link to their origin.
  The stored canonical encoding and SHA-256 are checked; corruption raises
  `InspectionIntegrityError("traces")`, which HTTP reports as `inspection_failed` (500), distinct
  from `invalid_inspection_request` (400). Historical receipts without the field return
  `{ status: "unavailable" }`; inspection never reconstructs missing decisions.
  Without `public_scene`, both the receipt result and `decisionTraces` are omitted.
  The audited HTTP endpoint returns this same view, as a canonical node, using the existing
  scoped `runtime:world-inspect` grant, rate limit and access audit. This authorized inspector
  evidence is not a public browser representation: access does not authorize copying its raw
  response into a shared browser view. Public rendering needs its own audience-safe projection.
- **Projection link:** under `public_scene`, `projection` holds the revision and state hash that the
  command recorded at its last event. With `{ verifyProjection: ports }`,
  `replayToSequence` replays the partition up to that event, starting from the latest compatible
  snapshot at or before it (or from birth), with the pack hash from `readCommitted`. `replay.verified` is false
  when the replayed hash differs from the recorded hash. A corrupt birth, event or snapshot throws
  its typed error. Nothing is written.
- **Authorization:** each call installs the caller's principal; nothing is cached.
  - Another tenant's command and an unknown ID give the same `InspectedCommandNotFoundError`.
  - A ceiling without `public_scene` sees the receipt identity and the decision only. The
    application hides `result`, schedules and children (the kernel state is `public_scene`); RLS
    hides the events and dispatches.

- **Evidence classes:** every view has an `evidence` map from the closed
  `INSPECTOR_EVIDENCE_CLASSES` (owned by `@clockgrove/contracts`), `COMMAND_VIEW_EVIDENCE`:
  - `canonical`: receipt, decision, events, decision traces, schedules and projection, as read.
  - `derived`: links and the replay comparison, computed from those reads.
  - `operational`: dispatch delivery status.

  Nothing is labelled counterfactual.
- **Other entry points (issue 819, Wave 4 §11.1):** both need a `scope` and answer an unknown entry, one outside
  the scope, or one the principal cannot read as not found.
  - `inspectEvent(authorization, eventId, ports, { scope })` returns `CausalEventView`. It contains
    the event, its command's view, `parentEvents` and `childEvents`, and `projections`. The parent
    and child events are the readable events of each parent and child command, read in the same
    scope; a linked command that is not readable there is omitted. `projections` is the command's
    projection link. The error is `InspectedEventNotFoundError`. The journal has no
    event-to-event cause, because `causationId` is the command's declared cause.
  - `inspectSchedule(authorization, { scheduleId, idempotencyKey }, ports, { scope })` returns
    `CausalScheduleView`. It contains the schedule row of the scope's space, which carries the
    deadline `dueAt`, and the `trigger` command (the one that scheduled the row). It also contains
    the `completion` command that consumed the row, with its events, or `null` while the row is
    pending. It needs `public_scene`, the class of the schedule rows. The error is
    `InspectedScheduleNotFoundError`.

`apps/runtime/test/causal-inspector.postgres.test.ts` runs in `test:db`.

## Replay and acceleration metadata

Replay reads `event_bytes` in increasing journal position and calls the accepted pure
`upcastEventBytes` path. Version 1's `policyVersion` becomes version 2's
`policyVersions.default`; the `WeatherChanged` type, payload, identity, attribution, ordering, and
privacy meaning remain unchanged. Deterministic replay evidence includes event count, final journal
position, and stable key-sorted state serialization with decimal bigint strings.

A world partition replays from its stored birth (`partition-replay.ts`). `replayBirth` reads the birth
with `readBirth`, rebuilds its state with `reconstructBirthState` and requires that the rows still
reproduce the stored `seedProjectionHash`; otherwise it throws `ReplayIntegrityError("birth")`.
`replayPartition` then reads the partition with `readPartition` from the start's covered sequence plus
one, in pages of 2,000, skips provisioning events by type and folds the kernel events with
`replayWorldEvents`. A domain refusal becomes `ReplayIntegrityError("replay-threw")`; range-read
integrity errors propagate unchanged, and a partition that ends before the target sequence throws
`ReplayIntegrityError("truncated")`. Replay writes nothing, so a rerun gives the identical result.

`verifyPartitionReplay(authorization, scope, mode, ports)` verifies the live projection and writes
nothing. It reads the committed row once (`readCommitted`); its covered head, state hash and the
**current** pack hash fix the target, so concurrent commands cannot race the comparison. It then runs:

- a full replay from the stored birth to the head;
- a snapshot replay from the latest snapshot below the head (`loadPartitionSnapshot`) plus the suffix
  events after it;
- in mode `diagnostic` only, a pause of the full replay at every listed snapshot to compare its
  recorded `state_hash`. These checkpoints localize the first divergence.

Mode `exact` compares the full replay, the snapshot replay and the live hash. A hash disagreement is
reported in `mismatches` (`full-vs-live`, `snapshot-vs-live`, `checkpoint:<snapshotId>`) with
`verified: false`. A corrupt birth, event or snapshot throws its typed error. A snapshot load that
fails is never skipped in favour of an older one: it fails explicitly, and callers choose full replay.
Snapshots never replace, repair or override journal truth; Wave 2 rebuild is this verification only
(plan §9.4).

The journal-parity harness snapshots each run before its first kernel call and after calls 1, 2, 4,
8, …, then runs `verifyPartitionReplay` in mode `diagnostic`. Checks `replay`, `snapshot-replay` (with
at least one suffix event) and `checkpoints` must pass, and its negative controls must fail: a
tampered birth, a corrupt snapshot byte, a forged snapshot state hash and a truncated suffix.

A partition snapshot is format v1 (`packages/application/src/snapshots.ts`): the canonical bytes of
its scope, route stream, covered partition and stream sequences, compatibility set and stored state
document (`application/json`). The golden `packages/application/test/goldens/partition-snapshot-v1.json`
pins the bytes; changing them needs a new version. `decodePartitionSnapshot` accepts only canonical v1
bytes (`SnapshotIntegrityError` `malformed`) and re-verifies every document hash
(`decodePartitionState`'s reasons). `requireSnapshotCompatibility` compares the codec, document
version, canonical encoding, random contract, kernel registry hash and pack content hash with the
current set and names the first difference (`SnapshotIncompatibleError`). No code hash is included, so
a deploy alone never invalidates snapshots.

## Replay bundle

A replay bundle (`replay-bundle.ts`, issue 686) carries one partition of one timeline out of PostgreSQL
so it can be verified with no database and no credentials. v1 is public events only, never redacted,
hashed and **unsigned**.

- **Format v1:** the canonical bytes of `{ kind: "clockgrove.replay-bundle", version: 1, manifest,
  birth, events }`. `birth` is the stored birth with seed resource bytes in hex; `events` are the
  partition's `event_bytes` 1 through the head as UTF-8 text. The manifest records the scope, the
  head, the snapshot compatibility set, the privacy classes included and omitted (always none), the
  expected final state hash and the SHA-256 of each section. The bundle ID is the hash of the
  manifest. Event bytes carry `recordedAt` and `journalPosition`, so bundle bytes differ between
  databases; the final state hash does not.
- **Export:** `exportReplayBundle(authorization, scope, ports)` reads only: `readCommitted` fixes the
  head and the final hash, then `readBirth`, then the event rows in pages of 2,000, all under the
  caller's authorization. A ceiling that hides events leaves a gap, so its bundle never verifies.
  Export writes nothing; rerun it after a crash.
- **Verify:** `verifyReplayBundle(bytes, { decodeResource })` checks, in order: the format
  (`ReplayBundleIntegrityError("malformed")`), the section hashes (`"section-hash"`), the
  compatibility set (`ReplayBundleIncompatibleError(field)`), then replays the birth and every event
  through `replayBirth`, `replayPartition` and `JournalRangeReader` over in-memory ports (their typed
  errors propagate), and requires the manifest's final hash (`"final-state"`) and privacy classes
  (`"privacy"`).
- **Authenticity:** a hashed bundle proves integrity, not origin. Compare the returned
  `finalStateHash` with an independent reference, such as the committed scenario golden.

The journal-parity harness exports every run, closes the connection, verifies the bundle and
requires the golden's final hash (check `bundle`). Its negative controls must fail by name: an
altered event, an altered payload with resealed sections, reordered events, an altered final hash,
an altered compatibility set, a truncated bundle, a tampered birth and an export under a ceiling
without `public_scene`.

## World birth events

World provisioning commits its events through `clockgrove.execute_journal` only; there is no other
journal or event table. A birth commits, in order: `WorldGenesisCreated` (stage = the genesis
command id), one `WorldSeedCommandApplied` per seed command (stage = the seed command id),
`WorldProjectionVerified` (stage `<genesisCommandId>:projection-verified`) and `WorldReady` (stage
`<genesisCommandId>:world-ready`). Each journal command ID is `trusted:world-provisioning:<stage>`
and its event ID is `<command ID>:event`. IDs starting with `trusted:` are minted only by
application code: the runtime gateway refuses a request whose command or event ID uses that prefix
before authorization records anything, so a client can never take a stage's receipt or event ID.
All four go to the first declared space's partition and stream
with privacy class `public_scene` and no dispatches. Each is its own transaction, so replaying a
retried stage returns the stored receipt. A world without a committed `WorldReady` event is not
ready.

## Evidence commands

From the repository root, after installing the pinned toolchain and dependencies:

```bash
pnpm run test:db
pnpm run test:replay
pnpm run db:verify
```

Journal parity (`apps/runtime/test/journal-parity.ts`) runs a committed Wave 1 scenario through the
simulator's own scenario engine, with a kernel driver that sends each kernel call through
`executeWorldCommand` (a continuation chunk through `continueWorldCommand`) against real PostgreSQL.
Each run (main and every variant) has its own database, cloned from a template where the pack's world
is provisioned, because the pack's genesis fixes the tenant, world and command IDs. Each run is then
read back in a fresh connection and checked: the stored state hash against the committed golden's
`finalStateHash` (or the pure run's, for a long run), the projection's own verification, random state,
remaining schedules, no open continuation, the kernel event stream read through `JournalRangeReader`
(kernel event types only, `authorityDecisionId` set aside) against the pure run's, the replay of those
events from the seed state against the projection, and each step's outcome (a retry is answered from
the stored receipt where the pure kernel refuses it as a revision conflict). `pnpm run test:db` runs
four scenarios and the negative controls (one corrupted projection byte, one dropped schedule row);
`pnpm test:long-run` runs all committed scenarios, the 30-day long runs and the raccoons one-year run.
Its scenarios are the `SCENARIOS` list of `apps/runtime/test/journal-long-runs.ts`; `test:db` fails
when a scenario under `worlds/<pack>/scenarios/` is neither on it nor in its written
`SCENARIO_EXCLUSIONS`.

The database test uses independently connected real PostgreSQL sessions for concurrent identical and
conflicting submissions, byte mismatch, revision conflicts, every pre-commit fault point, lost
response retry, atomic outbox writes, and runtime-role tenant isolation. The replay command directly
executes the replay tests and accepted contract goldens. Repository checks remain `pnpm check`,
`pnpm test`, and `pnpm run verify:docs`.
