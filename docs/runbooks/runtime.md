# Local runtime composition

`apps/runtime` is the Wave 0 local runtime composition surface. It exercises a Worker-style request,
the `WorldDO`, `SpaceDO`, and `ActorAgentDO` ownership shells, and the accepted PostgreSQL journal.
Tests include portable local/emulated bindings and a genuine pinned Workers journey through
the production default Worker/authentication composition and native Durable Object adapters over
an isolated PostgreSQL 18.6 database. This is not a cloud deployment or staging qualification.

## Placement and authority

### Authenticated world commands

`POST /v1/runtime/commands` accepts a strict version-1 envelope containing the four `RuntimeScope`
IDs, decimal-string routing and authority epochs, and `command: encodeCanonicalNode(CommandEnvelope)`.
The canonical-node `WorldCommandResult` uses 200 for committed results, 409 for kernel refusals,
403 for authorization refusals and 401 for authentication refusals. Boundary failures use the stable
codes in the protocol; `durable_state_corrupt` means stored state failed verification, while
`world_command_failed` and `owner_unavailable` are server or configuration failures. See the
[cross-package protocol](../protocols/runtime-world-commands.md) for the complete boundary.

Committed world participation and `runtime:world-command` authorize physical execution. Clock
controls (`PauseWorld`, `ResumeWorld`, `SetClockPolicy`) require `runtime:world-clock` instead;
`runtime:world-command` alone cannot pause or re-speed a world. Grant `runtime:world-clock` in the
member's `clockgrove.world_memberships.grants` to allow clock control. Workspace
administration, `runtime:no-op` and caller authority fields cannot substitute. Authenticated tenant
members receive `409 world_not_ready` before readiness without projection or execution. Unauthenticated
callers and principals outside the tenant cannot discover readiness or world data through this endpoint.

WorldDO resolves canonical placement to the single partition SpaceDO; opaque owner route names
survive runtime replacement. A successful response follows PostgreSQL commit of the receipt,
authority decision, events, partition state and schedules. Each persistence invocation owns one
runtime connection for its reads and journal work, with unconditional transaction/connection cleanup.
Both supplied epochs fence undecided commands transactionally against the shared durable epoch.
Exact decided retries retain stored-outcome semantics after epoch changes. Preserve accepted
bytes and authenticated metadata; changing bytes under an existing command ID refuses.

`complete: false` preserves the existing bounded application continuation semantics. Only trusted
owner work resumes the stored continuation through the same physical owner; public commands cannot
choose trusted chunk IDs. Restart or native local-storage loss hydrates state, schedules and named
random state from PostgreSQL, which supersedes local projection disagreement. Corrupt durable state
fails closed as a server integrity failure.

The finite native world-owner tests provide local safety evidence using the production Worker,
native adapters, immutable installed behavior and real disposable PostgreSQL. Their reusable harness
supports authenticated submission, trusted continuation, runtime replacement and durable comparison.
Hosted qualification and the remaining Wave 3 exit evidence stay pending.

### Physical owner mailbox

SpaceDO admits all its partition work (client commands, continuation resume, inspection, alarms,
alarm reconciliation and catch-up steps) through one FIFO mailbox (`apps/runtime/src/mailbox.ts`,
Wave 3 plan §8). Route and authorization checks run before enqueue, so a refused request never
occupies it. Every entry carries its kind, enqueue order, enqueue time, deadline and start time.
What else it carries depends on its kind:

- a client command: its scope, command ID, request ID and correlation ID (the trusted trace
  context) and route epoch;
- continuation resume and inspection: their scope, request ID and correlation ID. They carry no
  command, and the owner holds no route epoch for them without another read;
- a catch-up step: its Workflow's `applicationRunId` as the request ID;
- an alarm or alarm reconciliation: its kind only. One runs at a time and reads its scope inside
  the entry.

Mailbox order is admission order only; PostgreSQL assigns canonical order at commit.

- **Depth:** a client request that would exceed `maxDepth` entries (active included) is refused
  before enqueue with 503 `owner_mailbox_full`.
- **Deadline:** a client request must start and answer within `requestDeadlineMs` of enqueue. One
  still waiting then is dropped with 503 `owner_mailbox_expired`: no kernel call, no journal write.
  One already running is answered 503 `owner_mailbox_timeout` but keeps its place and runs on, so it
  may commit and later entries still wait for it; the exact retry returns the stored receipt. If it
  then fails, no caller sees the failure, so the owner logs it as `world_owner_failed` with the
  entry's IDs.
- **Cancellation:** in Wave 3 cancellation means the deadline drop of a waiting entry. A started
  entry always runs to its journal outcome, and a caller that disconnects does not stop its entry.
  A dropped, failed or timed-out entry releases the lane to the next entry; none strands its
  successors.
- **Clock work** (alarm, alarm reconciliation, catch-up) is admitted at any depth and has no
  deadline: one native alarm and one Workflow step at a time bound it, each with its provider's
  retry, and refusing it would stall the clock. It counts toward depth.
- **Retry hint:** every mailbox answer carries `Retry-After` and `retryAfterSeconds`.
- **Runtime state:** the owner keeps depth, oldest-entry age, the active entry and admission state
  (`open` or `full`) in memory (`mailboxState()`), for tests and the runtime inspector. It is never
  persisted and never canonical (plan §7.2); a replaced owner starts empty. Each settled entry's
  wait and service time are the `mailbox_wait_ms` and `mailbox_service_ms` [metrics](#metrics).

The bounds are `SPACE_MAILBOX_BOUNDS`. Each default is a decision; the
[load curves](#runtime-budgets-and-load-curves) measure where each trips, and the defaults stand on
that evidence.

| Bound | Default | Source |
| --- | --- | --- |
| `requestDeadlineMs` | 30000 | Decision: the same 30 s as one kernel call's idle bound (`WORLD_COMMAND_TIMEOUTS.idleInTransactionTimeoutMs`, the Workers default CPU limit of one invocation). That bound covers one kernel call, not a whole entry: queue wait, statements (10 s each), lock waits (3 s each) and inline overdue steps add to it, so a slow but healthy command can outlast 30 s. It is then answered `owner_mailbox_timeout` and runs on, and its caller loses only a retry. Measured: not reached; a full mailbox's oldest entry waited 1.4 to 1.7 s |
| `maxDepth` | 32 | Decision: a client command runs at most 8 overdue steps inline (`OVERDUE_DEADLINE_LIMIT`, 280 to 419 ms measured), so 32 such entries drain in under 14 s, well inside the deadline. Measured: a burst of 32 concurrent clients fills it unrefused; 48, the next level, is the first refused |
| `retryAfterSeconds` | 1 | Decision: the hint `world_catching_up` already gives. Measured: a full mailbox frees about 24 entries a second (41 to 43 ms per command, p50) |

### Causal-chain inspector

`POST /v1/runtime/causal-chain` takes `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }`
plus exactly one entry and returns the application inspector's view of that entry as a canonical node
(see the [journal runbook](journal-replay.md#causal-inspector)):

- `commandId` returns `CausalCommandView` (`inspectCommand`).
- `eventId` returns `CausalEventView` (`inspectEvent`, issue 819): the event, its command, the parent and
  child events, and the affected projection.
- `scheduleId` with `idempotencyKey` returns `CausalScheduleView` (`inspectSchedule`, issue 819): the
  trigger and deadline, then the command that consumed the row, with its events.

Each view labels its parts with evidence classes. It needs committed world
participation in that exact scope and its own grant, `runtime:world-inspect`; `runtime:world-command`
and `runtime:world-clock` do not imply it. `runtime:world-observe` does not authorize this operator
view or the runtime-state inspector below; decoded authenticated denials retain the same audit rules.
The view also needs an `operator_evidence` privacy ceiling, and the caller's ceiling redacts it as
in the application call. `PostgreSqlCausalInspector` checks the grant and ceiling itself, whatever
its caller checked, and audits a refusal before throwing it: an inspect-grant caller without
`operator_evidence` receives 403 `authorization_refused` and a `deny`/`authority-mismatch` row.
Projection replay
(`verifyProjection`) is not offered over HTTP.

Public `/v1/runtime/scene`, `/v1/runtime/entity`, `/v1/runtime/why`, `/v1/runtime/viewed-space` reads and the `/v1/projection`
scene connection require the independent scoped `runtime:world-observe` grant, current membership
and a `public_scene` privacy allowance. These reads do not change canonical world state.
`runtime:world-inspect` does not imply observation (2026-10-30): inspect-only callers
receive 403 `authorization_refused` from those public reads and scene admission. Operators need
both grants to observe and inspect. Public Why retains its closed vocabulary, linked-command
authorization, audit, rate-limit and failure semantics without exposing `CausalCommandView` or
inspector audit internals. See [living-yard observation](../protocols/living-yard-observation.md).
`/v1/runtime/viewed-space` answers a `ChangeViewedSpace` with a follow disposition and never
commits a command; see [viewed spaces](../protocols/realtime-projection.md#viewed-spaces-and-follow-decisions).
`/v1/runtime/influence` submits an interaction card's typed Influence intent as a server-built
`resource.offer` world command under `runtime:world-command`. `/v1/runtime/conversations/*` and
`/v1/runtime/talk` serve private conversation sessions under observation, the `conversation`
category and a resolved persona, and they need the `ARTIFACT_KEYRING` secret, without which they
answer `503 conversation_unavailable`. `/v1/runtime/say` is public scripted speech that stores
nothing. Talk turns, `/v1/runtime/turns/status` and `/v1/runtime/turns/cancel` run in the session
actor's `ActorAgentDO`; see [recoverable turn fibers](../protocols/conversation-fibers.md),
[private conversations](../protocols/conversations.md) and
[interaction cards](../protocols/realtime-projection.md#interaction-cards).
`/v1/runtime/runs/inspect` and `/v1/runtime/runs/search` walk and search the run and step evidence
of those attempts under `runtime:world-inspect` and an `operator_evidence` ceiling, audited with
subject `agent-runs`. Payload text needs the `conversation` category too. See
[run and step evidence](../protocols/runs.md).
`/v1/runtime/context/inspect` answers a turn's context manifest under the same grant and ceiling,
audited with subject `context-manifest`. `/v1/runtime/actor-documents/read` (under
`runtime:world-inspect` and `private_cognition`) and `/v1/runtime/actor-documents/change` (under
`runtime:actor-govern` and `private_cognition`) read and govern an actor's documents, audited with
subject `actor-documents`. See [context assembly](../protocols/context-assembly.md).

- **Scope:** only a command of the requested world, timeline and space is found. The space is the
  one the command's events were committed in, so a command without events the caller may read
  (a rejected command, or a ceiling without `public_scene`) answers 404. The check runs in the first
  read transaction, before any event is read.
- **Codes:** 200 view, 400 `invalid_inspection_request` (also a malformed `x-correlation-id`),
  401 `authentication_refused`, 403 `authorization_refused`, 404 `command_not_found` (an unknown
  ID and another tenant's, world's, timeline's or space's command are one answer), 500
  `inspection_failed`, 503 `inspector_unavailable`. An unknown or foreign event answers 404
  `event_not_found`; a schedule row answers 404 `schedule_not_found`. A schedule entry under a
ceiling without `public_scene`, the class of schedule rows, is refused 403 `authorization_refused`
and audited `deny`, not answered as unknown. No exception names. `inspector_unavailable`
  also answers while the canonical database is unreachable (failure class `database_unavailable`):
  no view is returned and no audit row can be written, so the access is refused, not served, and
  may be retried.
- **Audit:** every authenticated, decodable request writes one immutable row to
  `clockgrove.inspector_accesses` before it answers: tenant, principal, world, timeline, space,
  command ID, time, `allow` (`served`, `not-found`, `failed`) or `deny` (the authorization reason, or
  `authority-mismatch`). An event or schedule entry is recorded with `subject` `event` or
  `scheduled-action` and its `entry_id` (migration `0033`), not a command ID. The linked reads
  inside one causal-chain traversal (an event's parent and child commands, a schedule row's trigger
  and completion) are part of that one access: one row and one rate-limit admission, whatever the
  number of links. Public Why instead reads its entry's one command under the entry's access and
  each linked command as its own access, so a Why from an event or schedule row writes as many
  rows as a Why from its command: one for the entry and one per linked command. A schedule entry whose JSON `entry_id` exceeds the
  column's 2100 octets is refused as undecodable, without a row. A denial is recorded under the requested tenant even for a non-member, if
  that tenant exists; a denial naming no stored tenant gets the same 403 and writes no row. If the
  row cannot be written, the request fails. Authentication refusals and undecodable requests,
  including a malformed `x-correlation-id` and IDs over 1024 octets, are refused without a row. The runtime role writes only through
  `clockgrove.record_inspector_access` and cannot read the table; operators read it with an
  administrative role.
- **Retention:** rows are kept for 90 days per tenant, matching the three-month retention of the
  Analytics Engine metrics. Each access retires up to 100 of its tenant's older rows in the same
  transaction (migration `0023`), so a tenant's expired rows go on its next access. Rows are never
  updated, and nothing but that function can delete them: no role holds DELETE on the table.

### Runtime-state inspector

`POST /v1/runtime/runtime-state` takes `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId }`
and returns, as a canonical node, what one scope's runtime is doing (Wave 3 plan §14, the fields that
exist in Wave 3; `RuntimeStateView` in `apps/runtime/src/inspector.ts`). It reuses the causal-chain
inspector above unchanged: the grant `runtime:world-inspect` in that exact scope, the per-principal
rate limit, the codes (400 `invalid_inspection_request`, 401, 403 `authorization_refused`, 429
`inspection_rate_limited`, 500 `inspection_failed`, 503 `inspector_unavailable`) and one
`clockgrove.inspector_accesses` row per authenticated, decodable request, with `subject =
'runtime-state'` and no command ID (migration `0031`). A scope with no partition answers 404
`space_not_found` (`allow`/`not-found`). The read writes nothing else.

Every value carries its evidence class from the closed set `canonical`, `derived`, `transient`,
`operational` (`INSPECTOR_EVIDENCE_CLASSES`, `packages/contracts/src/browser-protocol.ts`, re-exported by
`@clockgrove/application`; issue 819 labels the causal chain, Why, selection and client-view views with the
same set). `canonical` values are one REPEATABLE READ read of
PostgreSQL under the caller's own authority. `operational` values carry `observedAt` (epoch ms) and
`mayBeStale: true`: the owner and provider state they show can change the moment after. `authority:
"journal"` says what wins: nothing here supersedes journal inspection (the causal chain).

| Field | Class | What it shows |
| --- | --- | --- |
| `placement` | canonical | partition and space, routing epoch, the journal head, and the partition-state projection's revision and the head it covers |
| `clock` | canonical | policy version, running, speed, simulation time, admitted horizon, the clock owner generation, the next simulation deadline (earliest pending schedule) and whether a continuation is open |
| `catchUp` | canonical | the open catch-up operation: application run, step (its cursor), target wall time, owner generation and policy version; null when none |
| `worldReactions` | canonical | the scope's unconsumed `world-reactions` messages: counts by publication status and the oldest 20 (`UNCONSUMED_PAGE`, a page an operator reads at once), each with its message ID, status, attempts, `last_error_class`, times and, where the consumer recorded it, the DLQ reason (`deadLetter`: failure class and time) |
| `runtime` | operational | the serving release's `codeVersion`, the runtime local-storage schema it reads and writes (`localSchemaVersion`), `ROUTE_VERSION` and the route-name prefix (the Durable Object name version; no name, key or ID tuple) |
| `owner` | operational | the space owner incarnation's own state: its instance ID and start, how it found its local storage (`rehydrated`, `reconciled` or `unchanged`: the last restart, rehydration or reconcile cause), its hydration revision (`hydration`: the partition revision its last committed world command, resume, alarm or catch-up step returned, and when; compare it with `placement.projectionRevision`; null before its first commit), the alarm generation its storage claimed, the native alarm time and the wall time it was mapped to with why (`planned`, `recovery`), and its mailbox depth, oldest age, active entry and admission state |
| `catchUpWorkflow` | operational | the native catch-up Workflow instance of the open operation and the status the provider answered, `unavailable` if it did not; null when no operation is open |

- **Scene connections.** The owner's `connections` list exposes exactly `principalId`,
  `acknowledgedRevision` (null before any applied acknowledgement) and `connectionVersion` for
  each live native hibernatable socket. It excludes audience, scope, provider identity, session
  credentials, assertions and trusted contexts. This is operational metadata under the same
  runtime-state authorization, audit and rate limit; listing connections never enters the mailbox.
  The scene upgrade itself requires `runtime:world-observe` and `public_scene`, verifies the
  provider session on every upgrade, and shares the physical mailbox admission bound. See the
  [scene transport contract](../protocols/realtime-projection.md#authorized-scene-connection-transport).
- **Owner state without the mailbox.** The owner's part is read by `SpaceDO.runtimeState`, which reads
  only memory and local storage, claims nothing and touches no partition, so it is not a mailbox
  entry: a full or stuck mailbox stays inspectable, and the reading does not count itself.
- **Hydration revision.** Each world command hydrates its partition from PostgreSQL inside its own
  transaction, so the owner holds no cached state to fall behind. A `hydration.revision` below the
  canonical `projectionRevision` means the partition has advanced since that commit, not that a cache
  is stale. It is kept in memory only and starts null in each incarnation.
- **Redaction.** World-reactions dispatches are `public_scene`. Under a ceiling without it,
  `worldReactions` is `redacted: true` with `unconsumed: null` and no rows, so a hidden backlog never
  reads as an empty one; row-level security hides them anyway.
- **Cost.** The unconsumed list reads through the partial index `event_dispatches_unconsumed_world_reactions`
  (0031), which holds only rows not yet consumed, so the read does not grow with the world's history.
  Each dispatch insert adds one entry to it in the command transaction, and its consumption removes it.

### Runtime operator actions

`POST /v1/runtime/actions` takes `{ schemaVersion: 1, tenantId, worldId, timelineId, spaceId,
action, messageId }`, where `action` is `repair-publication` or `replay-message` and `messageId` is a
world-reactions message's semantic ID, its dispatch ID (`<commandId>:dispatch:world-reactions`, as the
runtime-state view and the publication alert show it). Both run under their own grant,
`runtime:world-operate` (`OPERATE_GRANT`, `apps/runtime/src/inspector.ts`; 2026-10-27, issue 852).
`runtime:world-inspect` stays read-only: a caller holding only it or `runtime:world-observe` is refused both
actions with 403 `authorization_refused`. The observer/operator split reuses this grant and
defines no other operator grant.

- **Repair** (`repair-publication`) returns a `failed` publication of the scope to `pending`, due now,
  under its unchanged message ID (`repair_world_reaction_publication`, 0031). It changes only the
  dispatch row's status and lease fields (`status`, `lease_owner`, `next_attempt_at`, `settled_at`);
  `attempts` keeps counting, so the attempt fence stays monotonic and the next sweep makes one more
  publication attempt, publishing it once. A row that is not `failed`, or whose batch was already
  consumed (`consumed_at` wins), answers 409 `publication_not_failed`; correct the cause first, or a
  repaired publication fails again.
- **Replay** (`replay-message`) sends a published message through its source Queue again, under its
  original message ID. What it sends is the canonical envelope the publisher sent, rebuilt from the
  dispatch row and its source event, never caller bytes: the body the physical DLQ holds, without the
  operator fetching it. The consumer verifies it as any delivery; if the message was already
  consumed, the duplicate leaves the successful disposition unchanged. It changes no row; a message
  not yet published answers 409 `message_not_published` (repair or the sweep publishes it). Correct
  the consumer's failure first, or the replay dead-letters again.
- **Codes.** 200 `{ action, messageId, outcome }` with `repaired` or `replayed`, 400
  `invalid_runtime_action`, 401, 403 `authorization_refused`, 404 `message_not_found` (unknown, another
  scope's or tenant's, or hidden by the ceiling), 409 as above, 429 `runtime_action_rate_limited`, 500
  `runtime_action_failed`, 503 `runtime_action_unavailable` (also while PostgreSQL is unreachable).
- **Audit.** Every authenticated, decodable action writes one immutable row to
  `clockgrove.runtime_operator_actions` (0031): tenant, principal, world, timeline, space, action,
  message ID, time, and `allow` with the outcome (`repaired`, `replayed`, `not-found`, `not-failed`,
  `not-published`, or `failed` for a server failure) or `deny` with the authorization reason. The row
  commits in the same transaction as the repair, and before the replay's send, which a failed send
  rolls back with it (then recorded as `failed`), so no action changes anything without its row.
  Denials follow the inspector audit's rules: recorded under an existing requested tenant, none for an
  invented one. The runtime role writes only through `record_runtime_operator_action` and cannot read
  the table. This audit lives in that dedicated table in the canonical database, outside the world
  journal: an action writes no event, command receipt or authority decision, so it never enters
  command history or replay, and its rows are retired after 90 days (below), unlike journal records.
- **Limits and retention.** 300 actions per principal per tenant in any trailing hour, and 90 days of
  rows per tenant, each action retiring up to 100 expired ones: the inspector audit's numbers and
  reasons (migration `0031` records the decision).

`apps/runtime/test/operator-inspector.postgres.test.ts` (`test:runtime`) proves the inspector and both
actions in the native workerd/PostgreSQL harness: it injects a failed publication (a payload over the
Queue's 128 KB message limit, so every send fails) and a poison message (a consumption that fails as
an internal defect on every delivery, so the native Queue dead-letters it), diagnoses both through
the endpoint, repairs the publication and replays the message, and asserts the alert records, the
refusals, the redaction and every audit row.

### Timeline clock operation

Submit `PauseWorld` and `ResumeWorld` with `{ schemaVersion: 1 }`, or `SetClockPolicy` with
`{ schemaVersion: 1, simulationMillisecondsPerWallMillisecond, catchUpCapMs }`, through the existing
`POST /v1/runtime/commands` canonical-node `CommandEnvelope`. Speed is an integer from 1 through
1000000; the cap is a positive signed-64-bit bigint in simulation milliseconds. Successful results
return the committed `clockPolicy` in `WorldCommandResult.value`. Preserve the complete accepted
bytes for retries, including the cap's canonical bigint encoding.

Ready worlds initially remain paused, using their installed `GenesisClockPolicy` speed and an
activation cap of 86400000 simulation milliseconds. First resume anchors the current canonical
simulation time to trusted server wall time, excluding time since the pack's `wallEpoch`. Running
wall time earns simulation time at the committed speed. Pause excludes paused wall time and retains
pending work and earned backlog; already admitted physical work finishes first. Resume preserves
that backlog. A speed change first retains time earned at the old speed and anchors the new mapping
without a jump or rewind. The cap bounds newly admitted earned simulation horizon per activation;
it does not bound committed physical simulationTime delta. Unused admitted progress and unadmitted
backlog remain durable independently of physical state and revision.
Viewer presence does not change speed.

Client commands run at earned time (issue 740, Wave 3 section 10.1: canonical time moves through Journal
commands). Before a client command on a running clock the owner runs overdue due work as the alarm
would, one deadline per transaction, then runs the command at earned time in its own transaction as
a time-only move: no per-actor integration events, needs stay lazy. Environment boundaries up to
earned time are committed first as one trusted lazy advance (they are not in the alarm plan), so the
command always runs at earned time. The fast path is the owner's one clock read. A paused
clock runs the command at its current time. More than 8 steps (deadlines, chunks, boundary advances;
`OVERDUE_DEADLINE_LIMIT`, see [Runtime budgets and load curves](#runtime-budgets-and-load-curves))
refuse with a retryable 503 `world_catching_up` (`Retry-After: 1`); the alarm and catch-up workflow
drain the backlog. No revision is rebased: state changed by catch-up gives the client the normal 409.
Inspection returns
the stored state plus a non-canonical `earned` view of the continuous values at earned time.
Headless, alarm, sleep, catch-up and restart modes share this owner path, and `autonomous-parity`
checks them against a pure reference that applies the same rule.

The application exports `TimelineClockPolicy` for runtime owners. PostgreSQL commits clock policy,
monotonic version, receipt, authority decision and `ClockPolicyChanged` together; local runtime state
is recoverable. Clock changes preserve physical state, kernel revision, schedules and named random
state. Trusted autonomous commits check the committed policy version at commit authority, so work
using a superseded policy cannot commit after the change. Trusted execution uses the ready scoped
world policy without a browser session or retained session credential, attributed to the world's
system principal `system:world:<worldId>` (migration `0017_world_system_principal.sql`), not to a
tenant member. Corrupt durable policy
fails as server integrity failure rather than malformed client input.

`ResumeWorld` is a clock control. Continuation resume runs the next bounded chunk of a previously
accepted physical command and does not enable the clock. Resume reconciles one native SpaceDO
alarm without requiring further client traffic. WorldDO routes commands to the world's single
partition SpaceDO, which alone advances physical state.

Each activation starts at most four command attempts, with no new attempt starting after 250 ms
(`OWNER_ACTIVATION_BUDGET`). Trusted advances retain `DUE_WORK_ADVANCE_BUDGET` (16 inputs, 4096
events). [Runtime budgets and load curves](#runtime-budgets-and-load-curves) gives the sources and
where each trips. New commands target
durable schedule deadlines, so cap and delivery lateness do not introduce physical boundaries.
Accepted continuations run first with their original target, attribution, random state and cursor;
completion can exceed the cap even after a reduction to 1 ms. Every chunk still checks current
policy authority and obeys activation and kernel budgets.

PostgreSQL stores admitted horizon and idempotent activation receipts. Admission cannot exceed
elapsed earned time; pause excludes paused wall time and preserves both kinds of backlog. Policy
versions and durable owner generations fence admission and physical commands. A native incarnation
claims one generation on the partition row, carrying the generation it observed before its first
attempt. A lost-response retry recovers its own claim; once a replacement claims, the superseded
incarnation is refused at any retry delay and never claims again, so it cannot overwrite the newer
owner's alarm. The claim keeps no history, and a native owner's new admission deletes every other
receipt, so both stay at one row per partition.
Native serialization and storage transactions prevent stale completion or cleanup from replacing
newer alarm intent. A recovery alarm precedes canonical
work, covering failures and interruption between commit and alarm reconciliation. Its 1 s delay is
a decision, not a platform limit: it outlasts the 250 ms alarm work budget, so a healthy call
replaces it first, and it bounds a lost reconciliation to about 1 s of stalled clock. On recovery,
rehydrate committed policy, admission, schedules and open continuation before attempting more work.
Duplicate delivery and response loss reuse committed admission and journal identities.

When work remains runnable, retain one continuation alarm; otherwise map the earliest durable
simulation deadline. Paused and exhausted owners do not poll. Ordinary `test:runtime` covers a
representative safety matrix; `test:long-run` compares every SCENARIOS variant across headless
application execution, frequent alarms, sleep, Workflow catch-up, redelivery, restart and compatible runtime
replacement, using real disposable PostgreSQL and owned process cleanup. Every mode must match the
headless run on the full state hash plus random state and schedule queue. Every mode, headless
included, must also match the independent pure-kernel due-work reference on those hashes without
revision. Reports identify each pack/scenario/run/mode and print both pairs of hashes; an
intentional mismatch must fail. Scenario command responses compare semantic outcomes and events with
the headless run, excluding incidental journal `recordedAt` timestamps. Generated revision guards
retain their live/stale meaning. The explicit command-path golden comparison stays separate.
These local compatible-redeployment checks do not establish hosted alarm delivery or limits,
hosted deployment acceptance or full Wave 3 qualification. See the [clock command
protocol](../protocols/runtime-world-commands.md#timeline-clock-controls) for payloads and retry rules.

### Durable sleeping-world catch-up

When earned due work remains after an ordinary bounded alarm activation, SpaceDO registers a
catch-up operation and launches `WORLD_CATCH_UP_WORKFLOW` (`WorldCatchUpWorkflow`). Further client
traffic is unnecessary. The accepted operation fixes the trusted wall-time target; it drains that
accepted backlog instead of continually extending its own target as wall time passes. New earned
work remains subject to normal clock admission and alarm reconciliation.

The strict version-1 `CatchUpWorkflowEnvelope` contains only `{ version: 1, tenantId, worldId,
timelineId, spaceId, applicationRunId }`, using the existing opaque IDs. PostgreSQL binds the
application run to its accepted partition scope, clock-policy version and owner generation.
`stableWorkflowInstanceId` derives native execution identity from the application run. Compatible
replacement preserves that reference and derivation. The envelope contains neither physical state
nor caller authority or continuation state; native Workflow status cannot authorize physical work.
Each step routes to the partition's SpaceDO and rehydrates committed progress. The existing
`PostgreSqlCommandOwner`, `advanceDueWork` and `continueWorldCommand` paths remain the only physical
execution path, using the world's system principal and scoped trusted clock authority.

Each owner activation retains the ordinary four-command-attempt and 250 ms start bounds
(`OWNER_ACTIVATION_BUDGET`), and each kernel call retains `DUE_WORK_ADVANCE_BUDGET` (16 inputs, 4096
events). The cap limits newly admitted
earned horizon. It never discards backlog, truncates an accepted continuation or inserts physical
integration boundaries. Catch-up reuses the provisioning/readiness native step retry policy: five
retries with an initial 10000 ms exponential delay and ten-minute timeout per attempt. Native
redelivery, interruption after canonical commit and loss of local storage resume PostgreSQL
admission and journal identities without duplicating receipts, events or schedules.

Pause or clock-policy replacement supersedes obsolete catch-up work while retaining earned backlog.
Owner-generation fencing prevents replaced owners from admitting or committing; local intent checks
also fence late results, failures and alarm cleanup. A replacement rehydrates canonical policy,
schedules, admission and continuation before reconciling its own alarm intent.

The scheduled handler reconciles eligible accepted catch-up operations after infrastructure returns,
even after native retries exhaust. It recreates missing native execution or restarts failed or
terminated execution for the accepted application run, using canonical progress independently of
provider history. Reconciliation also compares the accepted operation's owner generation with the
current physical owner. A replacement restarts even a native execution still marked running;
claiming the new owner alone does not acknowledge a restarted step, so a lost restart response
remains recoverable. Only an actual catch-up activation rebinds the operation to the new owner.
Candidate processing isolates failures and bounds each sweep so a failing candidate
does not strand others or prevent provisioning/readiness recovery. Recovery requires no browser
request or manual Workflow restart.

Operational linkage occupies at most one row per partition, updated in place with tenant-scoped
access. Completed or superseded operations retire in place; a later accepted operation replaces the
link rather than appending per-retry history. Canonical admission, journal receipts and world state
remain the progress authority; Workflow history and Durable Object storage remain recoverable.

Representative `test:runtime` journeys use real native Workflows and disposable PostgreSQL with
bounded process cleanup. The complete autonomous `test:long-run` matrix includes
`workflow-catch-up`, preserving the independent pure-kernel comparisons, journal-revision checks,
semantic-event comparisons and deliberate mismatch detection. Native-local evidence establishes
local behavior only. Hosted delivery, deployed compatibility and full Wave 3 qualification require
separate hosted evidence.

### Native-owner scenario parity

Wave 1 scenarios run through the native owner and must end on the golden's final state hash (or the
pure run's, for a long run). Commands go to `POST /v1/runtime/commands`, continuation chunks to the
trusted owner RPC, and restart steps replace the runtime with its local storage lost. Each run starts
from a fresh copy of the provisioned database. Each run prints its coverage identity
(`pack/scenario:run`), its command, chunk, retry and restart counts, and the actual and expected
hashes.

- **Per PR:** `test:db` runs `native-parity.postgres.test.ts`. It runs one raccoons scenario per
  command path (new command and restart, exact retry) plus a mismatched-hash control, in about 16 s.
- **Exhaustive:** `test:long-run` runs `native-parity.long-run.test.ts`. It runs every committed
  scenario and variant of both packs, plus each pack's 30-day run (the fixture pack's run is the one
  that chains continuation chunks). It takes about 75 s, with one native process per pack, in
  parallel.
- **Budget:** whoever merges checks Quality's wall time against the roughly two-minute budget. The
  tests don't measure it.

This is native-local evidence (workerd through Miniflare). Hosted qualification is a separate,
deferred step.

From [docs/clockgrove-cloudflare-implementation-plan.md](../clockgrove-cloudflare-implementation-plan.md), heading **4.3 Logical placement table**:

Logical world identity is never a synonym for a live server process. Placement is explicit:

```ts
interface RuntimePlacement {
  worldId: WorldId;
  timelineId: TimelineId;
  spaceId: SpaceId;
  runtimeCellId: RuntimeCellId;
  runtimeInstanceId: RuntimeInstanceId;
  routingEpoch: bigint;
  authorityEpoch: bigint;
  fidelity: "hot" | "warm" | "dormant";
}
```

`runtimeCellId` is an opaque, movable logical execution placement. It never embeds a quadtree/octree code in a public domain identifier. `runtimeInstanceId` identifies one disposable process/DO incarnation. `routingEpoch` invalidates stale routes, while `authorityEpoch` fences stale writers. PostgreSQL stores the canonical placement and epochs; replacement, migration, eviction, repartition, or spatial-index migration must not change durable world, timeline, space, actor, presence, or object identity.

The initial Wave 0 PostgreSQL schema stores the ready-world state, logical partition placement,
routing epoch, and authoritative stream/partition revisions. By design, the authority epoch is that
routing epoch (2026-10-27). The single durable `routing_epoch` of the partition
fences both routes and writers: the owner and the journal transaction check each supplied epoch
against it. Stale runtime incarnations are fenced by owner generation ([Timeline clock
operation](#timeline-clock-operation)). No separate authority epoch or migration is planned.
Runtime instance identity and local hydration metadata remain disposable. Initialization performs
only canonical reads. A missing ready route fails closed and never creates a world, timeline,
partition, stream, or other canonical state.

Durable Object names use a versioned, length-framed SHA-256 digest over opaque canonical IDs. Public
requests carry explicit routing and authority epochs. The Worker authenticates through the trusted
composition boundary; decoded request or Queue data never becomes trusted merely by decoding.

### Route-name version policy

`stableRuntimeRouteName` (`apps/runtime/src/routing.ts`) names a `world`, `space` or `actor-agent`
Durable Object `v1-<kind>-<SHA-256 hex>`. The digest covers `ROUTE_VERSION`
(`clockgrove-route-v1`), the kind and the opaque IDs, each framed as `<UTF-8 byte length>:<value>`
and joined by `|`, so two different ID tuples never share a digest input. `ROUTE_VERSION` versions
the derivation: what enters the digest and how it is framed. The `v1-` prefix versions the visible
name format. Both are at version 1. Each kind's ID tuple is part of the derivation too:
`[tenantId, worldId, timelineId]` for `world`, plus `spaceId` for `space`, plus the subject ID for
`actor-agent`. The tuples are written once, in `runtimeRouteName` (same file), which maps a kind,
a `RuntimeScope` and, for `actor-agent`, a subject ID to the name. Every route call site uses it
(`owners.ts`, `worker.ts`, `cloudflare-adapters.ts` and `cloudflare-entry.ts`).

- **A change renames Durable Objects.** Changing `ROUTE_VERSION`, the `v1-` prefix or the framing
  gives every world, space and actor-agent a new name, and so a new, empty instance; changing a
  kind's tuple does so for every object of that kind. New instances rehydrate from PostgreSQL, as
  after runtime-local loss. Storage left under the old names is only rebuildable runtime state
  ([Wave 3 plan
  §7.2](../waves/clockgrove-wave-3-actor-fabric-implementation-plan.md#72-allowed-local-sqlite-state)).
  It is never canonical and is never migrated. A rename leaves the routing epoch unchanged, so the
  epoch does not fence old names.
- **Under the new code, an old-name instance refuses before it claims.** Every owner entry point
  that can claim or commit recomputes the object's own name under the deployed derivation and
  throws `RuntimeRouteKeyMismatchError` on a mismatch: SpaceDO and WorldDO commands, inspection,
  alarm reconciliation, the native alarm and catch-up, and owner initialization (which no-op
  commands use). So an old-name instance does no work, even when a native alarm it left behind
  fires.
- **Overlapping code is serialized by owner generation, not stopped.** If old and new Worker code
  run at once (a gradual deployment or a rollback), each passes its own route check, so an
  old-name and a new-name SpaceDO can both reach one partition. Each SpaceDO incarnation claims the
  partition's next owner generation before its first command, alarm or catch-up step, and every
  admission and physical commit checks it in its PostgreSQL transaction. So at most one
  incarnation of either name commits at a time. An old-name incarnation that claims later
  legitimately supersedes the new-name one and commits; only retiring the old code stops that.
  Deploy a version bump as one non-gradual deployment, and treat rolling it back as a second
  rename.
- **A running clock waits for its new-name SpaceDO.** The scheduled Worker never visits running
  partitions: it publishes world reactions and reconciles open provisioning and open catch-up. So
  after a rename a running world's clock advances again only when its new-name SpaceDO is next
  reached, by a world command through WorldDO or by an already-open catch-up. A no-op command does
  not wake the clock. The version-bump change therefore either wakes every ready partition's
  new-name SpaceDO (for example a reviewed one-off sweep that calls `reconcileAlarm` for each), or
  its PR records the maintainer's acceptance of the stall until each world's next command.
- **A version bump is a reviewed change.** It updates the literal golden route vectors in the local
  composition journey (`apps/runtime/test/runtime.postgres.test.ts`) in the same change, computed
  independently of `stableRuntimeRouteName`, and its PR states which Durable Objects are renamed.
  The vectors call `runtimeRouteName` with literal inputs for `world`, `space` and `actor-agent`,
  and `stableRuntimeRouteName` for the framing cases, against literal names. So they pin every
  kind's tuple as well as `ROUTE_VERSION`, the prefix, the framing and the digest, and a tuple
  change fails them like any other rename.

## Scheduled snapshots and verification replay

Every `infra/wrangler/*.json` declares two Cron Triggers, both every 5 minutes
(`runtimeBindingManifest.crons` in `apps/runtime/src/cloudflare-entry.ts`; `pnpm check` refuses a
manifest that differs). `*/5 * * * *` runs the world-reactions sweep and the provisioning and catch-up
reconcilers; each settles on its own, so one failing does not stop the others.
`2,7,12,17,22,27,32,37,42,47,52,57 * * * *` runs only `sweepPartitionSnapshots`, which keeps
every partition's snapshots fresh and verifies its live state by replay. It is a separate invocation
with its own limits, so a replay cut off at the CPU limit takes no recovery with it.

- **What is due.** `clockgrove.snapshot_due_partitions` (migration 0030) lists partitions of ready
  worlds with no open continuation that have no compatible snapshot (a new world, every world after
  migration 0029 emptied the index, or a world whose snapshots were written under another kernel
  registry or pack) or whose committed head is at least 2,000 events past their latest compatible
  snapshot. The head must also be past every snapshot the partition has, because a snapshot's ID and
  index slot derive from its head. 2,000 is the replay page (`REPLAY_PAGE`), so replay from the latest
  snapshot reads about one page of suffix.
- **Order and fairness.** Least recently attempted first, then most behind. The listing stamps each
  partition it returns (`partition_states.snapshot_attempted_at`) before any work starts. A partition
  that keeps failing, or whose run was cut off, therefore goes behind every due partition attempted
  less recently, so failing partitions take turns with the rest instead of every slot.
- **Bounds.** At most 4 partitions per run, one after another on one PostgreSQL connection, and none
  starts once the run is 20 s old (two thirds of the 30 s CPU limit of a Cron Trigger with an interval
  under an hour). The ones it did not start are counted `deferred` and rejoin the rotation. Each
  partition costs an exact replay of its whole journal from birth and one snapshot write, so a
  partition's verification work over its life grows with the square of its journal (about N²/4,000
  event applications for N events). A partition whose single replay exceeds the CPU limit is cut off
  on every attempt: Workers Logs shows that run's outcome as `exceededCpu` and the partition never
  regains a snapshot until the replay cost is reduced. Nothing runs inside a journal transaction, and
  nothing writes canonical state: the job appends only `snapshots` rows and snapshot artifacts, and
  updates the attempt stamp. The interval, limit and start deadline are reviewed constants beside the
  sweep, changed by a code deploy like the other cron bounds.
- **Authority.** Each partition is processed as its world's system principal
  (`system:world:<worldId>`, migration 0017) with a `public_scene` ceiling, the class of snapshots and
  of the events they copy. RLS governs every read and write.
- **Per partition** (`maintainPartitionSnapshot`, `packages/application/src/snapshot-maintenance.ts`):
  the committed partition is read once. An open continuation is counted `notQuiescent` before any
  replay. Otherwise `verifyPartitionReplay` in `exact` mode compares full replay from the stored
  birth, and the latest compatible snapshot below the head plus its suffix, with that read's state
  hash. Only a verified read is snapshotted, at exactly the head it verified
  (`createPartitionSnapshot`, idempotent per head); commands committed meanwhile wait for a later
  snapshot. A snapshot under another compatibility set is passed over, never loaded or reported.
- **Verification cadence.** Verification runs before each snapshot, so once per partition per 2,000
  events, on the first run after a partition has no compatible snapshot, and again on its turns while
  it keeps failing. A partition whose head does not move and that has a snapshot at its head is not
  re-verified.
- **Result.** The snapshot trigger's handler returns `snapshots: { written, notQuiescent,
  verificationFailures, partitionFailures, deferred }`.

How an operator sees a verification failure: a hash mismatch, or a typed integrity error from the
birth, an event, a snapshot or its artifact, writes one `partition_replay_verification_failed` record
(level `error`) per finding, with `tenantId`, `worldId`, `timelineId`, `partitionId`,
`failureClass: integrity`, `integrityCheck` (`full-vs-live`, `snapshot-vs-live`, `replay`,
`snapshot`, `artifact` or `journal`), `disposition: reported-not-repaired` and, for a typed error,
its class name and redacted message. Nothing is repaired and no snapshot is written; the partition
stays due and is reported again on each of its turns until an operator acts, while the other
partitions keep their turns. Filter Workers Logs on that event. Any other failure of one partition (a
database error, a missing artifact) writes `partition_snapshot_failed` (level `warn`) with the same
IDs, its failure class and `disposition: retried-by-cron`; the other partitions still run unless the
connection itself is gone.

`apps/runtime/test/runtime-snapshots.postgres.test.ts` (`test:runtime`) proves it in the native
workerd/PostgreSQL harness, firing the snapshot Cron Trigger:

- after world commands a run writes a snapshot at the live head, and a second run at that head
  writes nothing;
- a later sweep replays that snapshot plus its suffix to the live hash (`replay_events_per_second`
  points labelled `birth` and `snapshot`, counting the kernel events read from PostgreSQL);
- an index emptied as 0029 does regains a snapshot;
- a snapshot rewritten to another kernel registry hash is passed over (only a `birth` replay runs)
  and replaced once the head moves, with no failure;
- an open continuation is not listed and runs no replay;
- four partitions that fail on every run and are 100,000 events further behind take only the first
  run; the second run snapshots the healthy partition;
- a tampered snapshot and then a tampered event are reported as `snapshot` and `journal` failures with
  nothing written;
- the first sweep records, through the composed `METRICS`, `replay_events_per_second`,
  `snapshot_age_events`, `replay_mismatches`, `snapshot_verification` (`verified`, later `snapshot`
  and `journal` for the tampered runs), `artifact_bytes` (`inline`), `snapshot_bytes` and
  `snapshot_create_ms`; the composed artifact store records a spilled put, another tenant's refused
  read and a corrupt R2 object; every point has the Analytics Engine shape below and a closed label.

The staging round trip stays pending on issue 3.

## Runtime budgets and load curves

Wave 3 §19 asks for measured budgets and the first hot-space and catch-up-storm curves. Run
them with:

```bash
pnpm run qualify:wave3:load-curves [<evidence-dir>]
```

`scripts/ci/qualify-wave3-load-curves.mjs` runs `apps/runtime/test/load-curves.long-run.test.ts`
alone, under `apps/runtime/vitest.load-curves.config.ts`, so no other suite shares the CPU or
PostgreSQL while it measures. Neither Quality nor `pnpm test:long-run` runs it; Qualification's
`wave3-load-curves` job runs it alone on its runner and retains the result with its receipt for the
Wave 3 evidence manifest (issue 853; see [development.md](development.md)). It writes
`wave3-load-curves.json` to the directory (a new temp directory without one; it refuses to
overwrite an earlier result) and exits 0 only if the fixture passed within its wall-time bound.

The fixture drives the native workerd/PostgreSQL owner path of the other native tests (the
production Worker, `WorldDO`, `SpaceDO` and catch-up Workflow in Miniflare, over one disposable
PostgreSQL 18 cluster) and adds no instrumentation to the runtime: every number comes from the
[metrics](#metrics) the owners record into `InMemoryRuntimeMetrics`, the `world_command_answered`
[records](#structured-logs), the in-memory `mailboxState()` and canonical rows. Reading
`mailboxState()` during a hot-space burst is one request every 10 ms through the same workerd
process, so the workerd peak memory includes that sampling.

- **Hot space:** 1, 2, 4, 8, 16, 32, 48, 64 and 96 clients send `world.weather.set` to one SpaceDO
  at once (a paused clock), at least 32 commands per level. Each level records command service time
  and mailbox wait p50/p95/max (`mailbox_service_ms`, `mailbox_wait_ms`), the largest mailbox depth
  and oldest-entry age sampled every 10 ms while the burst runs, outcomes by code from the answered records
  (the admission refusals `owner_mailbox_full`, `owner_mailbox_expired`, `owner_mailbox_timeout`),
  and the journal transaction time and lock wait of each command (`journal_latency_ms`,
  `lock_wait_ms`).
- **Inline catch-up:** one client command after its world's clock ran unattended for 2, 4, 6, 8 and
  16 minutes: the overdue due-work steps it ran first and its service time, up to
  `world_catching_up`.
- **Catch-up storm:** one world asleep for 2 minutes to 16 hours, then 1, 2, 4 and 8 worlds asleep
  one hour, whose alarms come due together (speed 1, catch-up Workflow on). Each world's clock is
  resumed, and the points of those two clock commands discarded, before the wake, so a level counts
  only the wake and its catch-up. Each records alarm
  lateness (`alarm_lateness_ms`), alarm batches (`alarm_batch_ms`: count, duration, commands and
  why they stopped), catch-up Workflow steps (`catch_up_step_ms`: count, duration, commands) and
  time to caught-up: from the wake until the world has no catch-up run, no continuation and no
  pending deadline at or before the time it had earned at the wake, polled every 20 ms.
- **Decisions due together** (`sweep: "keepers"`, issue 900): one world of 16, 64 and 96 keepers (the
  fixture pack at version `2.0.<n>`, its keeper and n - 1 copies) asleep 2 minutes, then woken as
  above. Every keeper's decision falls due at each of the 3 deadlines, so each deadline's advance
  dispatches one input per keeper, up to `DUE_WORK_ADVANCE_BUDGET.maxInputs`, and a continuation
  chunk runs the rest. Every storm level records its autonomous kernel calls' inputs
  (`inputsPerAdvance`, the `count` of `command_events_written`) and transaction ms (`advanceMs`,
  `journal_latency_ms`).

The result is `{ kind: "clockgrove.wave3-load-curves", version: 1, candidate, execution, host,
startedAt, completedAt, peakMemory, wallTime, status, loadCurves, resourceCounters, budgets,
partitionSeams }`. `loadCurves` holds `hotSpace`, `catchUpStorm` and `overdueInline`, one entry per
level; `resourceCounters` holds each level's summed activation counters (`activation_commands`,
`activation_journal_ms`, `activation_db_transactions`: activations, commands, advances, journal
ms, events, transactions, statements). The Wave 3 manifest takes these two as its "load
curves" and "resource/cost counters". `host` records the platform, CPU, memory, Node, Miniflare
and workerd versions and the harness's connection limits; `peakMemory` the workerd and fixture
process resident-set high-water marks, as the Wave 1 long runs do. Each entry of `budgets` has a
`status`: `tripped` (with `tripsAt`, the smallest measured load that tripped it), `not-reached`,
`not-observable` (the fixture cannot see it) or `hint` (not a bound); `tripsAt` is null unless
tripped.

Five runs on bdff285 (24-thread AMD Ryzen 9 5900XT, 46 GiB, Linux, load average under 2; 116.5,
118.6, 116.7, 118.7 and 120.7 s; workerd peak 376 to 390 MiB, fixture process 493 to 534 MiB).
The figures below are the ranges those runs observed, not bounds. The keepers sweep, the
`maxInputs` row and the `maxEvents` maximum come from three later runs on 41228ab (issue 900; same host,
load average under 2.3; 140.5, 141.7 and 143.2 s; workerd peak 383 to 385 MiB, fixture process 513
to 531 MiB). Their other budgets tripped at the loads below, except that `startWithinMs` also
tripped for a lone world after a 4-hour sleep in one run and a 16-hour sleep in another:

| Budget | Default | Source | Where it trips |
| --- | --- | --- | --- |
| `OWNER_ACTIVATION_BUDGET.maxCommands` (`owner-activation.ts`) | 4 | Decision, from the about 75 ms kernel call measured in issue 663 | Every run: a sleep of 4 minutes (5 overdue advances), where the alarm runs 4 and hands the rest to catch-up; after 2 minutes (3 advances) it drains. An alarm batch of 4 commands took 166 to 258 ms |
| `OWNER_ACTIVATION_BUDGET.startWithinMs` | 250 | As above | Varies from run to run, because 4 commands take about as long as the bound and a step's time counts from its mailbox enqueue: 4 worlds waking together in four runs and 2 in the fifth. Per run, batches and steps that stopped short of 4 commands: 0 for a lone world, 0 to 1 for 2 worlds, 4 to 6 for 4 worlds and 138 to 166 for 8; the keepers levels, whose single advances took 0.4 to 4.4 s at the former `maxInputs` of 64, stopped short 2, 2 and 5 times at 16, 64 and 96 keepers (`sweep: "keepers"` in `observed.catchUpSteps`), and do not count toward `tripsAt`. In three of eight earlier runs of this fixture (ff1d4bd, 60e48ae; some on a host with load average 3 to 10) it also tripped for a lone world after a 1-hour or 4-hour sleep |
| `DUE_WORK_ADVANCE_BUDGET.maxEvents` (`@clockgrove/application`) | 4096 | The kernel's per-call maximum (`packages/kernel/src/world.ts`) | Not reached: at most 646 events per due-work advance (the first 64 decisions of 96 keepers, at the former `maxInputs` of 64); 11 for the fixture pack's one keeper |
| `DUE_WORK_ADVANCE_BUDGET.maxInputs` | 16 | Decision, from issue 900's measurements here | At issue 900's former default of 64, every run: 96 keepers due together (`tripsAt` `{ keepers: 96, inputsPerAdvance: 64 }`), where each deadline's advance stops at 64 with work left and a continuation chunk runs the other 32; with 64 each advance dispatches all 64, reaching the bound without stopping; 16 dispatch 16. An advance's transaction (`journal_latency_ms`, which spans the kernel call) took a median of 350 to 363 ms for 16 inputs and 1.98 to 1.99 s for 64 (at most 2.52 to 2.60 s); the first 64 of 96 keepers took at most 4.29 to 4.40 s, so the time per input grows with the keepers in the world. One such advance holds the partition lock for about 8 to 18 times `startWithinMs`, which is checked only between commands. At 16 (one run on 3e074fc, on a host loaded by other test runs, so its times are not comparable): 64 keepers (`tripsAt` `{ keepers: 64, inputsPerAdvance: 16 }`), where each deadline's advance runs as 4 chunks of 16, 12 advances for 64 keepers and 18 for 96 instead of 3 and 6, and every level drained |
| `OVERDUE_DEADLINE_LIMIT` (`world-commands.ts`) | 8 | Decision: 8 steps keep a command's extra latency to a few hundred milliseconds | Every run: a sleep of 8 minutes, where the command runs 8 steps and is refused (280 to 419 ms); after 6 minutes it runs 7 in 280 to 462 ms |
| `SPACE_MAILBOX_BOUNDS.maxDepth` (`mailbox.ts`) | 32 | [Physical owner mailbox](#physical-owner-mailbox) | Every run: a burst of 48 clients (16 refused); 32 fill it unrefused |
| `SPACE_MAILBOX_BOUNDS.requestDeadlineMs` | 30000 | As above | Not reached: a full mailbox's oldest entry waited 1.4 to 1.7 s |
| `SPACE_MAILBOX_BOUNDS.retryAfterSeconds` | 1 | As above | A hint, not a bound: a full mailbox frees about 24 entries a second |

Each trips where its source expects, and none trips early. One default changed after these runs:
`maxInputs` is 16, not 64. An advance of 64 inputs held the partition lock for about 2 s,
and the first 64 of 96 keepers about 4.3 s, while other commands on that world waited. One of 16
took about 0.36 s, near `startWithinMs`, but that was measured only in a world of 16 keepers. The
time per input grows with the keepers in the world, so by issue 900's figures 16 inputs of 96 keepers
should take about 1 s: a quarter of the hold at 64, still about 4 times `startWithinMs`. Nothing
has measured 16 above 16 keepers on a quiet host yet. The trade-off is more continuation chunks,
each its own transaction and catch-up step: a world with n decisions due together advances in
about n / 16 kernel calls per deadline instead of n / 64, so its catch-up takes more steps while
each holds the lock for less time.

**Partition and promotion seams (§19).** Wave 3 adds no shards. The result records the loads that
would call for the existing seams:

- *Space partition:* one SpaceDO lane serves 23 to 24 commands a second (1000 ms over the p50
  service time at one client, 41 to 43 ms); bursts committed at most 16 to 18 a second end to end (a burst's wall time
  also covers each request's authentication and routing, on the same workerd process), and 48
  concurrent clients reach the depth bound. A space that sustains more, or bursts more, needs its
  lane split (more object partitions, §8).
- *Catch-up promotion:* one world drains 23 to 24 due-work advances a second through alarms and
  catch-up steps (after a 16-hour sleep); 8 worlds waking together drained 67 to 70 a second
  between them and all caught up in 7.0 to 7.2 s. A world whose clock earns due work faster than its owner drains it (for the fixture
  pack, one deadline per simulated minute, a speed above about 1,400) never catches up and needs a
  dedicated process owner.

**Harness facts.** One workerd process runs every Durable Object, the Worker and the Workflows, so
worlds waking together share one isolate's CPU, and PostgreSQL runs on the same host. Requests
authenticate through readers that each open their own PostgreSQL connection
([Better Auth reference composition](development.md#better-auth-reference-composition)), so a burst
needs a connection per in-flight request: in a trial run with the harness's default 16 loopback
connections, 28 of 32 commands at 16 clients were refused `authentication_refused` before reaching
the mailbox. The fixture therefore allows 384 loopback connections (four per client at 96) and
PostgreSQL 400
(`runNativeWorldOwnerProcess` `connections`). Hosted CPU, memory, subrequest and wall-time limits,
Hyperdrive pooling and the hosted connection budget stay with staging.

**Wall time.** The fixture takes about 2 minutes 20 seconds on the host above with the keepers
sweep (about two minutes before it). Its bound is `WALL_TIME_BOUND_MS`, 10 minutes, a decision:
about four times the slowest run with the keepers sweep (143.2 s; it was five times the 120.7 s
before), since the fixture runs its points one after another and a host with slower cores
stretches it. The first run of Qualification's `wave3-load-curves` job, on the `QUALITY_RUNNER`
class, re-sources it.

## Metrics

The Wave 2 §16 metrics deferred to Wave 3 and the Wave 3 §20 runtime signals go to Workers
Analytics Engine.
The application port is `RuntimeMetrics` (`packages/application/src/metrics.ts`); `analyticsEngineMetrics`
in `cloudflare-metrics.ts` writes to the `METRICS` dataset binding (`rw-<environment>-metrics`), and
`NO_METRICS` or `InMemoryRuntimeMetrics` serve local runs and tests. Each point is
blobs `[name, tenantId, worldId, label]`, doubles `[value, count]`, index `tenantId`.
`RUNTIME_METRIC_LABELS` declares every name with its closed label set, and the point type accepts
only those labels. A count of 0 below means the point carries none.

| Metric | Emitted at | Label | `value` / `count` |
| --- | --- | --- | --- |
| `journal_latency_ms` | world-command transaction end (`postgres-world-command.ts`) | command family: `world`, `clock` or `autonomous` | transaction ms / 0 |
| `lock_wait_ms` | `begin_command` round trip, which takes the receipt, head and state locks | command family | ms / 0 |
| `command_events_written` | each world command whose step ran and committed (committed or rejected), from the append in memory | command family | events written / kernel inputs (scheduled decisions) its committed kernel call dispatched, the quantity `DUE_WORK_ADVANCE_BUDGET.maxInputs` bounds; none for a clock command or a rejected one |
| `command_projection_rows_written` | as above | command family | partition-state rows written: 1, or 0 for a rejected command (the state document is the one projection, plan §7.1 amendment) / 0 |
| `command_schedules_written` | as above | command family | schedule rows completed plus rows put / 0 |
| `command_dispatches_written` | as above | command family | dispatch rows written / 0 |
| `transaction_retries` | each command transaction run again: in `advanceDueWork` after a partition conflict or open continuation, when the call has another attempt left (the owner's due-work step allows one, so its refused step returns `pending` uncounted); in the owner's catch-up, boundary and command steps after a revision conflict; and a client command after its boundary step (`world-commands.ts`) | failure class: `revision_conflict`, `continuation_pending`, or `catching_up` for a client command run again after the environment boundaries it found pending | 1 / 0 |
| `autonomous_conflicts` | each revision conflict of an `autonomous` command (alarm, catch-up, due work, continuation chunk) that the journal finds (`postgres-world-command.ts`), and each owner-generation or clock-policy conflict of an alarm or catch-up activation's own checks and admission before its due-work step (`advanceClock`, `world-commands.ts`) | conflict kind: `stream`, `partition`, `routing-epoch`, `clock-policy` or `owner-generation` | 1 / 0 |
| `dispatch_backlog_age_ms` | each dispatch claim, per world (`postgres-dispatches.ts`) | queue channel | oldest claimed age ms / claimed rows |
| `replay_events_per_second` | each `replayPartition` | `birth` or `snapshot` | events per s / events |
| `replay_mismatches` | each `verifyPartitionReplay` | replay mode: `exact` or `diagnostic` | hash mismatches (0 when verified) / checkpoints compared |
| `snapshot_age_events` | each `verifyPartitionReplay` | `snapshot`, or `none` without a compatible snapshot | partition events the latest compatible snapshot trails the head by (the head when none) / 0 |
| `snapshot_verification` | each verification of the snapshot sweep (`maintainPartitionSnapshot`), one point per verification; a snapshot that fails its own check after a `verified` replay is in the failure log record only | `verified`, `mismatch`, or the typed failure: `replay`, `snapshot`, `artifact`, `journal` | 1 / 0 |
| `snapshot_bytes` | each `createPartitionSnapshot` | `written` | snapshot bytes / partition events covered |
| `snapshot_create_ms` | as above | `written` | ms of the encoding, artifact put and snapshot row write, plus the committed read when the caller passes none (the sweep passes its own) / 0 |
| `artifact_bytes` | each artifact row inserted (`postgres-artifacts.ts`) | placement: `inline` or `spill` | stored bytes / 0 |
| `artifact_integrity_failures` | each artifact get whose bytes fail verification | `missing`, `size`, `hash` or `decrypt` | 1 / 0 |
| `rls_denials` | the artifact store: a put PostgreSQL refuses with SQLSTATE 42501, and a get of another tenant's locator, which RLS hides | `artifact_write` or `artifact_read` | 1 / 0 |
| `projection_lag_ms` | each clock advance (`world-commands.ts`) | `partition-state` | wall ms the state trails earned due work / simulated ms |
| `alarm_lateness_ms` | each `SpaceDO` alarm delivery whose scope is stored (`cloudflare-adapters.ts`) | the alarm it delivers: `planned` (set to the wall time `clockAlarmPlan` mapped the durable plan to) or `recovery` (the 1 s recovery alarm installed before work, which fires only when the reconciliation after that work was lost or the work outlasted it) | wall ms from the time the alarm was set for to its delivery / 0 |
| `alarm_batch_ms` | each alarm activation that ran its due-work batch | why the batch stopped: `drained` (an attempt found no admitted due work), `refused` (the kernel refused its command), `continued` (its four-attempt or 250 ms budget, with work possibly left for the next alarm), or `catch-up` (as `continued`, with the remaining earned work handed to the catch-up Workflow) | batch wall ms / due-work commands it ran |
| `catch_up_step_ms` | each catch-up Workflow step (`SpaceDO.catchUp`) | its disposition: `continue`, `complete`, `superseded`, or `failed` for a step that threw (its Workflow retries it) | wall ms from the step's mailbox enqueue to its settlement / due-work commands it ran |
| `owner_initializations` | once per owner incarnation (`cloudflare-adapters.ts`): its first runtime-owner initialization (`owners.ts`), or for a `SpaceDO` its first clock-owner claim, which compares the local generation with the one it claimed, whichever settles first; later requests check local state again but record nothing | `RuntimeInitializationDisposition`: `rehydrated` (no local state: a new owner or lost local storage), `reconciled` (local state from an earlier incarnation or placement, replaced from PostgreSQL) or `unchanged` | 1 / 0 |
| `mailbox_wait_ms` | each `SpaceDO` mailbox entry that settles with a known scope (`owner-activation.ts`) | entry kind: `command`, `resume`, `inspect`, `alarm`, `reconcile-alarm` or `catch-up` | ms from enqueue to start / 0 |
| `mailbox_service_ms` | as above | entry kind | ms from start to settlement / 0 |
| `activation_commands` | as above: one owner activation is the work of one entry | entry kind | world-command transactions that ran to a result / the autonomous ones among them (due-work and boundary advances, continuation chunks) |
| `activation_journal_ms` | as above | entry kind | their summed `journal_latency_ms`, which spans each kernel call / events they wrote |
| `activation_db_transactions` | as above | entry kind | explicit PostgreSQL transactions (`BEGIN`) on the entry's owner connections / statements sent |

Every value comes from work the path already does; no metric adds a query or round trip. The write
counts and dispatched inputs (its routine decision drafts) come from the append the step already built, conflicts and retries from the error the path
already caught, and artifact and snapshot sizes from the bytes already in hand. An activation's
counters tally the points its work records and the statements its connections send, in memory.
Alarm lateness reads the mark (`clock-alarm-at`: the wall time and why) that the owner writes beside
its native alarm in the local storage transactions that set it (`retainAlarm`, `reconcile`), and
reads it as the alarm is delivered, before the delivery waits in the mailbox, where an entry ahead of
it may set the next alarm; Cloudflare's `alarm()` is not told when it was due. These are Durable
Object local storage operations, not PostgreSQL queries or network round trips. Kernel time is inside `activation_journal_ms`: the kernel
call is synchronous inside the journal transaction, and a Worker's clocks do not advance during
synchronous execution ([Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)),
so it cannot be timed on its own. Its CPU is in each invocation's `CPUTimeMs`, which Workers reports
itself ([Workers Trace Events](https://developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/)). Labels are closed
sets, never caller text, so dimensions grow only with tenants and worlds. An RLS denial is
attributed to the refused principal's tenant and the world it named; every other point to its own
tenant and world. Recording never throws into its caller: every site goes through `recordMetric`,
which drops a point whose sink throws, and `analyticsEngineMetrics` drops a refused write. Points are
not sampled in code: Analytics Engine samples per index under load and records `_sample_interval`, so
weight queries by it. A committed command writes six points, and its mailbox entry five more (one
more for an incarnation's first initialization); a client command with the 8 inline catch-up steps
`OVERDUE_DEADLINE_LIMIT` allows, each one transaction, writes about 66, and an alarm or catch-up
step of four due-work commands about 35, under the 250 data points Analytics Engine accepts per
Worker invocation
([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)); points over that
limit are dropped like any refused write. Telemetry is not canonical.

The owners (`cloudflare-adapters.ts`) compose `analyticsEngineMetrics` over `METRICS` for commands,
alarms and catch-up steps; so do the cron
world-reactions sweep and the scheduled snapshot sweep, whose artifact store (`composeArtifactStore`)
records the artifact metrics too. `replay_events_per_second` is emitted for every verification
replay: label `birth` for the full replay, and `snapshot` for the replay from the latest snapshot
once one exists. The post-commit hint sweep and the causal inspector's replay record no metrics.

Wave 2 §16 signals that are not metrics, by decision (2026-10-27): optimistic conflicts,
idempotent receipt hits, request-hash mismatches and failures by stable error code on
Worker-answered requests are evidenced by the `world_command_answered` and `noop_command_answered`
records of [Structured logs](#structured-logs): their `outcome` (`conflict`, `replayed`), `code`
(for example `command_id_reused` for a request-hash mismatch) and `failureClass`. Those records cover
only requests the Worker answers, so conflicts of autonomous commands are `autonomous_conflicts`.
Outbox backlog is `dispatch_backlog_age_ms`; migration and backfill checkpoints are the migration
harness's output, not live metrics.

Wave 3 §20 signals that are not metrics, by decision (2026-10-27): gateway results by
stable error code, stale route and authority-epoch rejections included (`stale_epoch`,
`world_command_conflict`), and mailbox timeouts and refusals (`owner_mailbox_full`,
`owner_mailbox_expired`, `owner_mailbox_timeout`) are evidenced by the same `world_command_answered`
and `noop_command_answered` records: their `outcome`, `code` and `failureClass`.

`owner-metrics.postgres.test.ts` (`test:runtime`) asserts the exact points of the physical owner in
the native workerd/PostgreSQL harness, with `InMemoryRuntimeMetrics`: two clock commands, a late
alarm whose batch hands its remaining work to catch-up, one catch-up step, and, after local storage
loss, a no-op and a command whose new incarnation records one rehydration.
`alarm-safety.test.ts` measures an alarm delivered behind a running entry against its own mark.

## Structured logs

Server log lines are structured records (issue 701, issue 839; Wave 0 §14, Wave 3 §20). The application port
is `RuntimeLogger` (`packages/application/src/logging.ts`); `consoleRuntimeLogger` in
`cloudflare-logs.ts` passes each record as one object to `console.error`/`warn`/`log`, which
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) indexes
field by field and Logpush exports in `workers_trace_events` `Logs` (`observability` is enabled in
every `infra/wrangler/*.json`). `InMemoryRuntimeLogger` serves tests.

`composeRuntime` wraps the sink in `releaseRuntimeLogger`, so every record carries the release and
environment that served it: `codeVersion` (the composition's, today `wave0`) and `environment` (the
canonical `PROVIDER_ENVIRONMENT`: `local`, `ci`, `development`, `staging` or `production`, else
`unconfigured`). The Worker, the owners, the Queue consumer and the scheduled recoveries all log
through it.

A record is `{ schemaVersion, level, event, timestamp, codeVersion, environment }` plus, where known,
these fields, and nothing else:

- IDs: `tenantId`, `worldId`, `timelineId`, `spaceId`, `partitionId`, `correlationId`, `requestId`,
  `commandId`, `runId` (an application run), `transportMessageId` (the Queue's own message ID),
  `messageId` (a world-reactions message's semantic ID, its dispatch ID: canonical in the publication
  alert, the operator's target in an action record).
- Request: `authorization` (`authorized`, `denied`, `unauthenticated`, or `not_evaluated` when the
  request was answered before authorization), `outcome` (`committed`, `rejected`, `replayed`,
  `conflict`, `refused`, `unavailable`, `failed`, `read`), `code` (the stable error code the
  response returned), `status` (HTTP), `routingEpoch` (its authority epoch is equal, issue 713) and
  `revision` (the partition revision a committed or replayed world command left).
- Failure: `failureClass` and `retryable`. The class comes from typed errors and structured driver
  codes, never exception text: `revision_conflict` (a stream, partition, clock-policy or
  owner-generation fence), `epoch_conflict` (a stale routing or authority epoch, from the owner or
  the journal), `idempotency_conflict`, `continuation_pending`, `catching_up`, `lock_timeout`, `statement_timeout`, `idle_timeout`
  (SQLSTATE 55P03, 57014, 25P03), `serialization_failure` (class 40), `database_unavailable`
  (classes 08, 53, 57 and socket errors; a connection that never opened is 08001 unless the
  server sent its own SQLSTATE), `owner_unavailable`, `owner_mailbox` (an
  `owner_mailbox_*` answer from the space owner's mailbox), `integrity`, `internal`, and for
  Queue work `malformed`, `inconsistent`, `transient`. `retryable` is fixed per class
  (`RUNTIME_FAILURE_RETRYABLE`): false only for `idempotency_conflict`, `integrity`, `internal`,
  `malformed` and `inconsistent`.
- Envelope: `channel`, `attempt`, `trigger` (`hint` or `cron`), `disposition`.
- Verification: `integrityCheck`, which replay verification failed (see
  [Scheduled snapshots and verification replay](#scheduled-snapshots-and-verification-replay)).
- Adapter call: `port` (`model`, `tool` or `mcp`), `step` (bounded runs only), with `runId` (none
  for MCP discovery) and `outcome` (`succeeded`, `refused`, `failed`).
- `error`: a server failure's class name and redacted, capped message and stack.

The event set is closed. `schemaVersion` is 6 (3 added the two snapshot-sweep events,
`partitionId` and `integrityCheck`; 4 was assigned on two parallel branches to different sets, so 5
is their union: the scene observation answered and failure events
(`scene_observation_answered`, `scene_observation_failed`), the runtime-state and operator-action
routes' events (`runtime_state_inspection_answered`, `runtime_state_inspection_failed`,
`runtime_action_answered`, `runtime_action_failed`), the two world-reactions alert events
(`world_reactions_dead_lettered`, `world_reactions_publication_failed`) and `messageId`; 6 added
`activation_hint_failed` and its `recovered-by-poll` disposition); it
increases whenever an event or field is added,
removed or changes meaning, so queries can tell record shapes apart. Filter Workers Logs by
`correlationId` or `commandId` to follow one request across the Worker and its owners.

| `event` | Written by | IDs and fields |
| --- | --- | --- |
| `scene_observation_answered` | the Worker, once per answered scene observation | authorized scope and generated request/correlation IDs; authorization, outcome, code, status, failure class; no command ID |
| `scene_observation_failed` | the Worker, once per caught scene server failure | scope and request/correlation IDs where known; failure class and redacted error; no command ID |
| `world_command_answered` | the Worker, once per answered world command | scope, the command's correlation, request and command IDs once decoded; authorization, outcome, code, status, routing epoch, revision, failure class |
| `noop_command_answered` | the Worker, once per answered no-op command | scope, the request's correlation and request IDs and command ID once decoded; authorization, outcome, code, status, routing epoch, failure class |
| `causal_chain_inspection_answered` | the Worker, once per answered inspection | scope and inspected command ID; correlation once authorized; authorization, outcome, code, status, failure class |
| `world_owner_failed` | the `WorldDO` or `SpaceDO` that caught a world-command or no-op server failure | scope, trusted correlation and request IDs, command ID (none for alarm clock advances); failure class, error |
| `world_command_failed` | the Worker, for a server failure outside the owners | as `world_command_answered`; failure class, error |
| `noop_command_failed` | the Worker, for a no-op server failure outside the owners | as `noop_command_answered`; failure class, error |
| `causal_chain_inspection_failed` | the Worker, for an inspector server failure | as `causal_chain_inspection_answered`; failure class, error |
| `runtime_state_inspection_answered` | the Worker, once per answered runtime-state inspection | scope; correlation once authorized; authorization, outcome, code, status, failure class |
| `runtime_state_inspection_failed` | the Worker, for a runtime-state inspection server failure | as `runtime_state_inspection_answered`; failure class, error |
| `runtime_action_answered` | the Worker, once per answered operator action | scope, `messageId`; correlation once authorized; authorization, outcome (`committed` for a repair or replay done), code, status, failure class |
| `runtime_action_failed` | the Worker, for an operator action server failure | as `runtime_action_answered`; failure class, error |
| `world_reactions_delivery_failed` | the Queue consumer, per failed delivery | `channel`, `transportMessageId`, `attempt`, failure class, `disposition: retry-or-dlq` |
| `world_reactions_dead_lettered` | the Queue consumer, per failed last delivery attempt (`attempt` above the consumer's `max_retries`, 3), which sends the message to the DLQ: an alert | `channel`, `transportMessageId`, `attempt`, failure class, `disposition: awaiting-replay` |
| `world_reactions_publication_failed` | the hint or cron publication sweep, per publication it settles `failed` after its attempt budget: an alert | `tenantId`, `worldId`, `timelineId`, `messageId`, `channel`, `attempt`, failure class, `disposition: awaiting-repair` |
| `world_reactions_sweep_failed` | the hint or cron publication sweep, per failed principal | `channel`, `trigger`, failure class, `disposition: recovered-by-cron` |
| `activation_hint_failed` | the post-commit activation hint, per failed pass over a world timeline | `tenantId`, `worldId`, `timelineId`, failure class, `disposition: recovered-by-poll` |
| `world_provisioning_reconcile_failed` | the cron provisioning reconcile, per failed case | `tenantId`, `runId`, failure class, `disposition: retried-by-cron` |
| `world_catch_up_reconcile_failed` | the cron catch-up reconcile, per failed case | scope, `runId`, failure class, `disposition: retried-by-cron` |
| `partition_replay_verification_failed` | the cron snapshot sweep, per mismatch or typed integrity error | `tenantId`, `worldId`, `timelineId`, `partitionId`; `failureClass: integrity`, `integrityCheck`, `disposition: reported-not-repaired`, error for a typed error |
| `partition_snapshot_failed` | the cron snapshot sweep, per partition that failed otherwise | `tenantId`, `worldId`, `timelineId`, `partitionId`; failure class, `disposition: retried-by-cron` |
| `capability_adapter_called` | `runBoundedCapabilityFixture` (testkit), per model or tool call, and `ScriptedMcpTransport` (testkit), per MCP discovery or invocation, when given a logger | `runId`, `port`, `step`, `outcome` |

- **One request, one answered record.** Every request the Worker answers on the six runtime routes
  writes exactly one `*_answered` record after its response is built, whatever the outcome; a
  request to an unknown route writes none.
- **One failure, one record.** The component that catches a server failure's cause logs it with the
  error. Owners above it and the Worker relay `world_command_failed` without logging the cause
  again; only its class crosses RPC, for the answered record.
- **Redaction.** Records carry opaque IDs, closed event names and codes, numbers and, for a server
  failure, the error's class name, message and stack. Never pass payloads, request or response
  bodies, headers, credentials, connection strings, display names or caller text to the logger; its
  record type has no field for them, and `runtimeLogRecord` copies only the named fields, strings as
  strings and numbers as finite numbers. Error text drops URLs (connection strings), bearer tokens
  and `password=`/`secret=`/`token=`/`key=` values, and is capped at 1024 (message) and 4096 (stack)
  characters, under the 256 KB Workers Logs and 16,384-character Logpush limits. Causes go to the
  server log only; responses name only the stable code.
- **Cost.** A request on the success path writes at most one record, its answered record, with no
  I/O beyond the one `console` call: every field is already in memory. Failure paths add the one
  failure record. Queue failures produce one transport-only record per failed delivery as described
  below, and the last attempt's failure one alert record more; successful deliveries produce no log. Production model and tool adapters do not exist yet
  (Wave 5); only the testkit fixture writes adapter-call records.

## No-op gateway refusals and decisions

The Worker separates authentication (`TrustedRuntimeRequestAuthenticator.identify`: session and
principal mapping) from authorization (`authorize`: workspace and world authority). Every command
that reaches the journal carries an AuthorityDecision built here; its ID is minted as
`authority:<commandId>` and the request's `authorityDecisionId` field is ignored. Retry lookups and
denial records use the bindings' journal (`RuntimeOwnerBindings.journal`) and create no runtime
owner; bindings without a journal skip both.

- An exact retry (same tenant, command ID and command bytes) of a decided command is answered from
  its stored outcome before authorization: 200 with the stored response for a committed command,
  403 with the stored rejection for a rejected one. Authority is not resolved again and no
  decision is built, even if grants changed. The bytes include the principal, and row-level
  security admits only a member of the tenant, so only that principal's own command matches.
- An allowed command commits with an allow decision holding the resolved authorization inputs.
- An authorization refusal (403) of a request that decodes into a runtime no-op is recorded: a
  rejected receipt plus a deny decision with the refused inputs and a reason code
  (`world-participation-absent` when no ready world participation resolves, `runtime-grant-missing`
  when the participation lacks `runtime:no-op`). No event or dispatch is written.
- These refusals keep their status and write nothing: authentication refusals (401); requests that
  do not decode into a runtime no-op, including any whose command or event ID starts with the
  trusted prefix `trusted:` (reserved for IDs minted by application code, such as world-provisioning
  stages); refusals where an authority source contradicted the request
  (a membership or participation for another principal, tenant or scope); scopes that name no world
  and timeline of the authenticated tenant (the journal finds no such timeline under the tenant's
  row-level security); and a command ID already committed with different bytes.
- Responses name stable codes only, never exception class names or error text: 401
  `authentication_refused`, 403 `authorization_refused` (also the stored rejection), 400
  `invalid_noop_command`, 409 `stale_epoch` (with `kind`), `noop_command_conflict` (with `kind`) or
  `command_id_reused`, 404 `space_not_found`, 500 `durable_state_corrupt` or `noop_command_failed`,
  and 503 `owner_unavailable`. Owner refusals cross Durable Object RPC as typed replies.

## Local recovery evidence

`pnpm run test:runtime` uses the accepted disposable PostgreSQL helper and covers two independent
starting conditions:

1. destroyed runtime-local state is rehydrated from ready PostgreSQL world/placement/projection
   state, with a `rehydrated` disposition and unchanged authoritative rows; and
2. deliberately stale persisted runtime-local placement, projection, fidelity, routing epoch, and
   authority epoch are replaced from PostgreSQL, with a `reconciled` disposition and unchanged
   authoritative rows.

A separate case rejects stale request routing and authority epochs. Repeated initialization and
delivery assert one canonical command receipt, one semantic event, and one dispatch effect. The
Worker response and PostgreSQL event retain the same correlation identity.

## World-reactions Queue lifecycle

The production world-command journal wakes `DispatchHintNotifier` only after commit. Commands
with no events and rejected commands send nothing. The notifier schedules, with the owner's
`waitUntil`, a `sweepDispatches` for the committing world's system principal only (16 rows per
claim) through `WORLD_REACTIONS_QUEUE`; the command never awaits it. The configured five-minute
scheduled handler independently sweeps every due principal after a lost or failed hint or isolate
replacement. Each principal is isolated: a failure logs `world_reactions_sweep_failed`
(`trigger`, `failureClass`) and the others continue. Neither recovery path needs browser traffic.
`cognitive-indexing` and `external-effects` retain refusing consumers.

Publication and consumption are separate. `event_dispatches.status = 'delivered'` means Queue
publication succeeded, while `consumed_at` means the committed batch was durably verified.
A publish/settle crash leaves the lease recoverable; a consume/ack crash causes harmless redelivery.
The consumer compares the envelope with the canonical dispatch and the complete ordered command
batch before writing its one successful disposition. It performs no simulation, perception,
cognition or external effects. Independent commands need no FIFO ordering.

Publication claims use the existing store maximum of 1000 rows and a lease matching the existing
five-minute reconciliation cadence. Publication permits an initial attempt plus three retries,
aligned with the unchanged physical Queue `max_retries: 3`. Retry delay starts at the existing
native owner's one-second recovery delay and doubles per publication attempt, capped at the
store's existing one-day delay ceiling. A terminal publication failure stays `failed` with
`last_error_class` for operator recovery and writes the `world_reactions_publication_failed` alert
record. Attempts fence settlement: an expired holder cannot settle a newer claim.

Consumption retries each failed message independently, with delays 1, 2 and 4 seconds under the
same configured Queue retry budget. Malformed envelopes, canonical inconsistencies, transient
storage failures and internal defects have distinct classifications. Decoding failures are
classified only at the envelope boundary; a handler exception keeps its operational/internal
classification. Success is acknowledged after the durable transaction and client cleanup; a failed
sibling is retried without discarding successful messages.

After exhaustion, Cloudflare routes the original message to the configured physical
`rw-<environment>-world-reactions-dlq`. The failure of the last attempt (the fourth: `max_retries`
3, `QUEUE_MAX_RETRIES` in `cloudflare-entry.ts`) writes the `world_reactions_dead_lettered` alert
record beside its `world_reactions_delivery_failed` record (`channel`, `transportMessageId`,
`failureClass`, `attempt`). Logs contain no envelope, payload, error message or connection
information. Where the body names a world-reactions dispatch, the consumer also records the failure
class on it (`dead_letter_class`, `dead_lettered_at`, migration 0031), so the
[runtime-state inspector](#runtime-state-inspector) shows the message with its DLQ reason; a
malformed body has no trusted semantic identity and is known by its transport ID only. Recording it
is best effort and changes neither publication nor consumption.

Where each failure lives: a publication failure (the Queue send) stays in PostgreSQL as the
dispatch row's `failed` status and `last_error_class`, the database dead letter. A consumer poison
message (the Queue consume) goes to the physical Queue DLQ above. Neither is copied to the other.

Operators diagnose and recover both through the authenticated runtime API, without the Queue
dashboard or a database role:

1. **Alert.** Each terminal failure writes one `error` record: `world_reactions_publication_failed`
   (with the message ID) or `world_reactions_dead_lettered` (with the transport ID). The operator
   alert counts records whose `event` is either name in Workers Logs, or in the Logpush
   `workers_trace_events` export, per environment, and fires at 1 or more in any 5-minute window.
   Decision: one is enough, because each is a failure that no retry recovers and that waits for an
   operator; 5 minutes is the recoveries cron's interval. Delivering the alert to a notification
   destination is pending on issue 1 and issue 2.
2. **Diagnose.** `POST /v1/runtime/runtime-state` for the scope lists its unconsumed messages: a
   failed publication (`status: failed`, its attempts and `last_error_class`) and a dead-lettered one
   (`status: delivered`, `deadLetter` with the failure class), with the message IDs the actions take.
   A due pending row or an expired lease needs nothing: the next cron recovers it.
3. **Correct the cause**, then **recover** with `POST /v1/runtime/actions`: `repair-publication`
   returns a failed publication to pending for the next sweep, and `replay-message` sends a
   dead-lettered message through its source Queue again under its original message ID (see
   [Runtime operator actions](#runtime-operator-actions)). Duplicate successful dispositions stay
   unchanged. Nothing regenerates a command or its canonical events, and replay never forwards
   caller bytes: it rebuilds the canonical envelope the publisher sent.

The physical DLQ keeps its copy of the body; draining or deleting it there is not needed for
recovery, and its private bodies stay restricted to authorized operators.

Consumption state lives on its source dispatch, one immutable successful timestamp and world-system
principal per dispatch. Keep it for the full life of that source: dispatch rows are append-only and
not retired. Duplicates append no rows and do not update the successful disposition. Background
authority comes from canonical world system principals and scoped public-scene facts, with
transaction-local authorization; Queue data supplies no grants or selected member identity.

Native local Queue/PostgreSQL tests exercise the production composition, physical DLQ, retries,
crash windows and recovery with fixture-owned cleanup. These checks establish local implementation
evidence, not hosted deployment or full Wave 3 qualification.

### Durable world provisioning and readiness

`WorldProvisioningWorkflow` and `WorldReadinessWorkflow` run through native Cloudflare Workflows.
They share one canonical provisioning case: provisioning installs the pinned artifact, commits
genesis and seed commands through Journal and verifies the stored seed projection; readiness then
commits the verified birth-to-live handoff and `WorldReady`. The readiness Workflow cannot create
an independent world or bypass projection verification. Existing direct `provisionWorld` callers
retain the complete `ProvisionedWorld` result, birth state, schedules and named random state.

The production Worker exports `WorldProvisioningEntrypoint.launch(request: ProvisionWorldRequest,
applicationRunId: string)` for a private Management service binding targeting the named
`WorldProvisioningEntrypoint` entrypoint. It returns the existing `launchWorldProvisioning`
reconciliation result. Management must already have validated tenant/grant/quota, reserved world
and timeline identity and pinned the artifact. Ordinary Runtime membership, clock grants and
caller-supplied authority do not grant access to this binding. The Runtime HTTP router exposes
no world-creation API. Workflow execution itself confers no authority.

Registration persists the accepted request and immutable application-run link on the canonical case.
Concurrent delivery and exact retries preserve the same case, request and application run, including
tenant, source and artifact; they converge on the same canonical world and deterministic provisioning
and readiness Workflow identities. Conflicting identity, tenant, artifact, source or run refuses
without replacing the accepted registration or advancing another case.

Provider input is the strict version-1 reference `{ version: 1, tenantId, caseId,
applicationRunId }`. Workers reload the accepted request, including losslessly encoded source
bytes, from PostgreSQL. Inputs and provider results are versioned serializable values; provider
SDK types stay in the Cloudflare adapters. Permanent case, installation, receipt and event evidence
remain authoritative. The additional source/request/run fields occupy one registration per case
and are retained with that case, rather than appending an operational record per delivery.

Use `reconcileWorldProvisioning(env, envelope)` after a failed launch or compatible runtime
replacement. It reconciles canonical status with deterministic provisioning and readiness
instance IDs derived from the same application run. Repeated delivery resumes committed stages;
existing installations, seed receipts, schedules and readiness effects are reused.
If provider launch fails after accepted registration, the existing scheduled provisioning reconciler
recovers the case without resubmitting creation or requiring an operator.
Reconciliation returns the canonical case status, world ID and committed birth receipt command IDs,
alongside the native execution status; a missing execution history never substitutes for those links.
Canonical readiness is the ready case and its single committed `WorldReady`, backed by the canonical
installation and birth receipts. Management projects that result rather than declaring readiness
from a successful launch or provider execution status.
Compatible replacement must preserve the envelope version, accepted case/request identity, artifact and
stable instance-ID derivation. Native execution history and runtime-local storage may disappear;
the canonical case and receipts still determine recovery and readiness. A terminal provider
execution can be restarted for that same case; it does not authorize a competing run or artifact.

Birth steps explicitly pin the [native retry defaults](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/):
five retries, a 10000 ms initial exponential delay and a ten-minute timeout per attempt.
The finite local fault tests retain the retry count and timeout while removing the retry delay.

A provisioning refusal is a terminal canonical case outcome, distinguishable from an infrastructure
failure eligible for bounded provider retry and an internal genesis defect. Failed or exhausted
native attempts are operational failures and cannot imply canonical readiness. Inspect the case
and provider execution status before reconciliation. Call `cancelWorldProvisioning(env, envelope)`
to record canonical cancellation before terminating provider execution. This trusted helper fences the case; it does not terminate native instances.
Cancellation and readiness serialize on the case: a committed ready case stays ready, while a
cancelled case refuses subsequent advancement. Terminating only native execution stops that
attempt; it does not erase a canonical outcome or prevent a later trusted reconciliation.

Before readiness, authenticated tenant members receive `409 world_not_ready` from
`POST /v1/runtime/commands` without executing the command. Authentication and tenant membership
checks precede readiness disclosure. Unauthenticated callers and tenant outsiders cannot use that
response to discover world state.

The remaining six Workflow classes preserve their shell-only deterministic identity behavior:
`WorldPackUpgradeWorkflow`, `IngestionWorkflow`, `ConsolidationWorkflow`, `AuthoringWorkflow`,
`AgentJobWorkflow` and `TransferRecoveryWorkflow`. Their later domain jobs are not implemented.

Finite native-local Workflow/PostgreSQL tests use production adapters and disposable resources to
check canonical recovery, counts and hashes. They establish local implementation evidence only;
Cloudflare hosted behavior, deployment compatibility qualification and the full Wave 3 exit remain
separate obligations. No Workflow history, transport, cache or local Durable Object storage is
canonical world truth.

## Failure and recovery matrix

[Wave 3 plan §17](../waves/clockgrove-wave-3-actor-fabric-implementation-plan.md#17-failure-and-recovery-matrix)
lists the faults to inject. `scripts/ci/wave3-fault-matrix.json` maps each of its twelve rows, as
amended on 2026-10-19, to one or more cases. Each case carries its §17 `row`, a `case` description
and a `disposition`:

- `tested`, with the `file` and exact `test` name that prove it and the canonical `command` that runs
  that file (`test`, `test:db` or `test:runtime`), so the Wave 3 manifest can take the
  case's result from that command's receipt: the command fails if any of its tests fails;
- `deferred`, with the owning `wave`: the ActorAgentDO row to Wave 5 and the transfer row to Wave
  11 (plan §9.3, §13);
- `pending`, with the owning `issue`: hosted Cloudflare behavior (eviction and deployment, Hyperdrive
  latency and pool reuse, a deployed route-name version change, Workflow deployment) on issue 3.

`test` is the title as written in the file, not Vitest's full name, which adds the `describe`
titles; an `it.each` title keeps its `%s`. A Vitest JSON report is not a per-case result: a test in
the native workerd harness runs in a child process that writes no report, so the command's report
lists it as skipped and only the file's parent test, the one that calls
`runNativeWorldOwnerProcess`, as passed.

`pnpm check` runs `scripts/check-fault-matrix.mjs`. It reads the §17 bullets from the plan and fails
when a row has no case, a case names something that is not a §17 row, a cited file or test name no
longer exists outside comments, or a case's command is not the one that runs its file. A deleted,
renamed or commented-out test therefore cannot leave its case silently unproven. The matrix cites
tests that already prove a case rather than repeating them.

### Canonical-database outage

`apps/runtime/test/canonical-outage.postgres.test.ts` (in `test:runtime`) takes PostgreSQL away from
the canonical role `clockgrove_runtime`, the Hyperdrive path, in the native workerd/PostgreSQL
harness. A trigger holds the role's next journal write open; then the role's connection limit is
set to 0, so every new connection is refused (SQLSTATE 53300), and its open connections are
terminated mid-transaction (57P01). The authentication and authorization readers keep their own
roles, so requests still reach the owners; when PostgreSQL is down for them too, authentication
refuses first with 401 (`hyperdrive.postgres.test.ts`). Restoring the limit ends the outage.

- **World command before its journal commit:** the held transaction is terminated. The client gets
  500 `world_command_failed`, and so does its exact retry while the outage lasts. Nothing is written.
  Once PostgreSQL returns, the exact retry commits once.
- **World command after its commit, before its response:** the owner's next read waits behind a
  lock until the outage ends its connection. The command committed once; its client gets the same
  500 `world_command_failed` and, once PostgreSQL returns, its exact retry returns the stored receipt
  with no new write.
- **Recovery without client traffic:** the recovery alarm the owner set before journal work fails
  while PostgreSQL is away, then completes and reconciles once it returns.
- **Inspector request:** 503 `inspector_unavailable`, no view and no audit row; once PostgreSQL
  returns, the same request is served and audited once.
- **Alarm activation and catch-up Workflow step:** the held due-work transaction is terminated and
  every retry is refused, with no canonical change. Once PostgreSQL returns, the alarm resumes the
  clock; the catch-up Workflow, whose native retries are exhausted, is restarted by the scheduled
  reconciler, with no manual Workflow restart. Each run's state hash, semantic events and dispatch
  intents equal an uninterrupted run's.

These are local results. Real Hyperdrive refusal, pooling and latency, and Cloudflare eviction and
deployment, stay pending on issue 3.

## Remaining qualification

Cloud deployment, staging behavior and human-authentication qualification remain with their owning
Objectives. The world-command service above provides bounded local physical execution. The retained
Wave 0 recovery evidence stays distinct from that capability and from browser/cognition capability,
hosted production readiness and whole-wave acceptance.

W0-010 `qualify:wave0` selects the existing Worker/journal recovery journey with real restored
PostgreSQL history. Its exact complete canonical-row snapshot stays fixed through portable
runtime-local destruction/hydration and ordinary duplicate-command submission; receipt/event/
dispatch counts remain 1/1/1. The safe local-recovery.json records the candidate commit and tree
separately and the comparison hash. This is local/emulated evidence. The separate native-local journey establishes actual native storage loss; successful
missed/duplicate/reordered Queue or webhook effects and hosted qualification remain pending.

## Native local recovery qualification

Existing `test:runtime` discovery runs `test/native.postgres.test.ts`; offline runtime tests
exclude PostgreSQL journeys. Wrangler 4.156.2 bundles the production entry and adapters into
lockfile-selected Miniflare 5.20261102.0-beta / workerd 1.20261102.1 with `nodejs_compat`.
The host Vitest alias is never passed to Wrangler. The test-only inspection entry delegates
ordinary no-op requests directly to the production Worker; inspection authenticates through the
same default stored-session and least-privilege authority readers before initializing the three
production owner classes. Controlled disposable rows prove reader behavior, not enrollment.

The journey initializes all three native owners, commits one ordinary no-op, closes workerd,
and inspects actual SQLite-backed `runtime-local-state` values. It restarts over retained storage,
then closes workerd and deletes its uniquely owned persistence directory. Absence is checked
before creating a replacement runtime. Read-only initialization rehydrates all three owners.
A separate stopped-runtime fault edits only those native KV values to stale placement, epochs,
fidelity and projection metadata, then proves reconciliation. Runtime incarnation UUIDs change;
canonical opaque route identities, partition placement and the Wave 0 shared epoch fence remain.
Stale routing/authority requests and invalid stored sessions refuse without canonical mutation. A
request for a non-ready world of the tenant is an authorization refusal: it records exactly one
rejected receipt and deny decision and changes no other row, and its exact retry returns the stored
403 after the world is ready again. Exact command retries retain the original response, correlation identity and
one receipt/event/dispatch intent. A dispatch intent does not prove a successful Queue effect.

Complete comparisons include every row in `clockgrove`, `clockgrove_auth` and
`clockgrove_management`, ordered by table and exact PostgreSQL JSONB row representation. Only
comparison hashes enter retained evidence. The parent owns PostgreSQL, bridge and storage;
a separate bounded Vitest child owns Miniflare/workerd. After seventy seconds, or cancellation,
the parent terminates that entire child process group, escalates to SIGKILL and verifies execution
has ceased before closing the bridge and database. A stalled runtime disposal cannot strand
workerd. The parent has a 120-second cancellation deadline beneath its 150-second test limit;
requests retain 45-second aborts and bridge sockets 35-second idle limits, both longer than the
owner's 30-second kernel bound. Each request opens its own connection: workerd closes idle
keep-alive connections after five seconds, and a reused one races that close when an in-process
kernel step has blocked the test's event loop longer. The shared owned subprocess runner bounds
Wrangler and database tools at thirty seconds. Database cleanup has an independent twelve-second
stop deadline even after cancellation. A real `pg_sleep` failure proves
that the owned database stops and its directory is removed; a termination-resistant descendant
probe proves the CI deadline closes its listener without recording a passing receipt.

At a clean frozen candidate `qualify:wave0` additionally records `native-recovery.log`, the exact
command receipt and `native-recovery.json`. The proof binds commit/tree, lockfile and bundle hashes,
actual tool/runtime versions, storage removal, comparison identities and duplicate counts. The
manifest's optional `nativeRecovery` summary stays distinct from portable `recovery` and hosted
`cloudQualification`. Recipes require matching candidate/command/log/proof identities and refuse
unsupported positive claims. The literal runtime-local checklist row can pass from this native
proof; owner setup, enrollment/grants/privacy handoff, protected staging deployment, authenticated
staging correlation, successful Queue/webhook effects, independent review and full Wave 0 acceptance
remain separate obligations. Operator-appointed independent exact-candidate review and fresh
published-head Quality/browser/artifact evidence are still required before integration/acceptance.

## Stevie's model route and commands

`ActorAgentDO` answers Talk through the `stevie.pilot` model alias when `ANTHROPIC_API_KEY` or
`AI_GATEWAY_API_KEY` is bound, and from the scripted fixture otherwise. The responder perceives the
member's authorized public scene, asks for a structured `{reply, command}`, and the turn's
`proposal_validating` phase decides the command against the member-bounded grants and submits an
accepted `resource.offer` to the world owner ([capabilities](../protocols/capabilities.md)). The
owner holds the latest Talk request's trusted context only in memory: a recovered turn without it
abandons its attempt and the client's retry resumes. The pilot's rubric and cost envelope are in
[the Stevie pilot](https://github.com/clockgrove/raccoon-world/blob/main/docs/runbooks/stevie-pilot.md).

## Recoverable scene streams

The native `/v1/projection` stream resumes from the acknowledged native attachment and PostgreSQL.
The [delivery contract](../protocols/realtime-projection.md#bounded-native-delivery-and-recovery)
records the 64-event history budget, four outstanding projection frames and
four lagging publication turns. Clients apply only compatible contiguous patches, then acknowledge
the delivered endpoint with their connection version. Snapshot fallback is normal after a gap,
unsupported history or excessive lag. A `recovery/backpressure` notice followed by close 1013,
sent for a full frame ledger or a refused owner mailbox read, requires reconnect/resume; sending
alone never advances the recovery cursor. The browser client reconnects with bounded backoff, and
an upgrade beyond `SCENE_SOCKET_BOUNDS` answers 503 `scene_connections_full`.

Native qualification lives in `apps/runtime/test/scene-delivery.postgres.test.ts`. It is local
workerd/PostgreSQL evidence, not hosted eviction or redeploy evidence. The partial
[Wave 4 manifest](../waves/clockgrove-wave-4-runtime-evidence.json) keeps actual Cloudflare hibernation,
restart and redeploy pending on issue 3, blocked on issue 1 and issue 2. No staging qualification is claimed.

## Proactive actor activation

The [turn fiber contract](../protocols/conversation-fibers.md#proactive-activation) documents the
operator's configure/wake routes and activation inspector. Configure a bounded daily scheduled
intention using `scheduled_intention`, an epoch-millisecond `nextWakeAt` and `intervalMs: 86400000`;
configure event subscriptions with `subscription` and their event type. An optional heartbeat is
an opportunity for policy and compiled checks, and can record a no-op without calling a model.
The activation inspector reports each causal reason and the next scheduled wake, including
budget-deferred evidence. The existing native owner executes admitted work through its recoverable
turn fiber, retaining PostgreSQL as authority. No continuous per-actor process is required.

## Wake-triage shadow report

Bind `WAKE_TRIAGE_CONFIG` to a JSON object to enable wake triage. Omit the binding to disable it;
`{}` selects these conservative pilot defaults (issue 111 implementation choices):

```json
{
  "policyVersion": "wake-triage@1",
  "modelAlias": "wake.triage",
  "model": "perplexity/pplx-decider-v1.2",
  "confidenceThreshold": 6500,
  "dailyBudgetMicrousd": 100000,
  "maxCostMicrousd": 1000
}
```

The threshold is 65% in basis points. The budget is $0.10 per world per simulated day and reserves
$0.001 for each decision opportunity. Full reservations remain spent, including lower measured
cost, unknown cost and interrupted calls; the default admits at most 100 reserved opportunities
in a day. All actors in the world and timeline share the durable budget. Day boundaries follow
the pack's declared environment day length, with an 86,400,000 ms fallback when absent.
These are conservative operator policy choices,
not measured model prices. Change the configured model to `openai/gpt-6-luna-decisions` or
`baseten/mammoth-1` to measure the owner's other candidates through the same alias. Bind
`AI_GATEWAY_API_KEY` for the live decision adapter; credentials never belong in the JSON policy.

Triage runs after the existing activation policy and compiled checks. Its `suppress`,
`compiled_routine`, `full_turn` or `cant_tell` answer is journaled evidence: the full turn still runs.
Missing credentials, exhausted budget, errors, abstention and low confidence retain that path.
Direct messages are triaged and marked apart. No enforcing mode is enabled, and a future enforcing
mode must never suppress a person's message (owner decision, 2026-11-09).

For a bounded local measurement, run the operator entry point from this checkout:

```sh
node scripts/wake-triage-report.mjs --output "$TMPDIR/wake-triage-fixture.json"
```

It provisions disposable PostgreSQL and the native actor runtime, derives an actor from the pack,
advances one pack simulated day in 24 checkpoints, and sends seven probes through the real HTTP
paths: one direct message and one of each perception, scheduled intention, subscription, threshold,
heartbeat and tool-completed wake. It writes the same report to a new file with private permissions
and removes the temporary world. The file must not exist. This bounded probe workload is not an
exhaustive day's natural traffic. The default uses `ScriptedDecider` and scripted full turns;
`measurement: "scripted"` identifies synthetic labels/costs, which are not model-quality evidence.
No provider key is forwarded by default, even when one is present in the caller's environment.

From an external world repository, invoke the separate checkout pinned at the intended platform
commit, using an absolute pack path:

```sh
node /path/to/pinned/clockgrove/scripts/wake-triage-report.mjs \
  --pack "$PWD/worlds/sample" --output "$PWD/wake-triage-report.json"
```

Add `--live` to opt into forwarding `AI_GATEWAY_API_KEY` to both decision and actor full-turn
adapters. This runs at most seven full turns plus their bounded triage calls, subject to the
configured budgets and the runner's ten-minute execution bound. Supply the key through the
maintainer's existing environment; never put it in a command or policy file. `--live` without a key
writes an explicit `measurement: "model-unavailable"` fallback report without a provider call.
The runner's local authenticated fixture principal is scoped to its disposable world and allowed
operator evidence; it changes neither the interactive hall's observation credential nor a hosted
world's grants. The selected pack must support the existing native harness and have a needs-bearing
actor in its first space.

After exercising a persistent world for the desired simulated day, use its authenticated runtime connection
to POST `/v1/runtime/activations/triage-report` with the existing activation address shape:

```json
{
  "version": 1,
  "scope": {
    "tenantId": "<tenant>",
    "worldId": "<world>",
    "timelineId": "<timeline>",
    "spaceId": "<space>"
  },
  "actorId": "<actor>"
}
```

Use a principal authorized by the existing world-command grant and both `conversation` and
`operator_evidence` privacy ceilings. The actor identifies the authorized route; the report covers evidence in the authorized
space of that world and timeline.
Read counts, labels, confidence, mean/p95 latency and measured cost by activation reason, followed
by each turn's final disposition, proposed command, output message and reply-to-person classification.
Abstentions, low confidence, failures, budget refusals and unfinished turns have separate counts.
The report includes agreement, confident bypass share, counterfactual gross/net savings, miss
examples and recurring miss/low-confidence signatures for human review. Nullable cost means unknown;
reserved budget is not measured spend. Safe bypass/savings exclude direct-message wakes; their
raw bypass labels and misses remain visible. Proposed suppression of material work remains a miss even
if it makes the counterfactual savings look attractive. See the
[ground-truth and signature contract](../protocols/decision-shadow.md#wake-triage).

The same endpoint and policy apply to the fixture world and an external world installed through
the [pinned-checkout path](../../packages/simulator/docs/conformance.md#external-worlds-from-a-pinned-checkout).
Select the external world's pack and shell through the existing
[external local session inputs](../protocols/world-presentation.md#external-local-session); platform
code does not embed world content. The observation-only local hall credential does not grant
report access: use the authorized runtime/operator setup above. A maintainer runs each candidate
against the chosen simulated-day workload with a real gateway key and records its alias, policy,
world revision, counts, misses, latency and costs on issue 76 before considering any enforcement.

## Offline decision shadow day

Run this from a Clockgrove checkout pinned to a full commit with its frozen dependencies installed.
The pack may live in another repository; paths resolve from the caller's working directory,
following the [external pinned-checkout procedure](../../packages/simulator/docs/conformance.md#external-worlds-from-a-pinned-checkout).
The command reads the selected pack, runs the native pure simulation for the requested span,
verifies event replay without a model, then asks the configured decision alias beside utility.
It never changes a running world or starts a hosted service.

Create a local alias JSON file (credential **reference**, never a credential value):

```json
{"alias":"operator.shadow","model":"perplexity/pplx-decider-v1.2","credential":"AI_GATEWAY_API_KEY","maxCostMicrousd":1000}
```

With the referenced provider credential in the environment:

```sh
pnpm shadow:decision --pack worlds/fixture/reference --alias /absolute/path/shadow-alias.json \
  --span-ms 86400000 --spend-microusd 100000 --out /absolute/path/shadow-report.json
```

From an external world repository, invoke the same pinned platform command directly:

```sh
node ../clockgrove/scripts/decision-shadow.mjs --pack worlds/sample --alias shadow-alias.json \
  --span-ms 86400000 --spend-microusd 100000 --out shadow-report.json
```

Span and spend are required. Span is elapsed simulation milliseconds from pack genesis, rather than
an absolute timestamp. Alias configuration accepts `decisionAlias` options, including explicit token
prices, byte bound, timeout, and per-call ceiling. The shown span is one day; the shown cap is $0.10
and each reservation is $0.001. These are example operator choices, not deployment policy. The
kernel's existing 1024-input/4096-event chunk limits and simulator finite-plan limits bound each
simulation.

Sampling (which decisions are asked) and cohorts (which count as close calls) are separate, so one
run gives both cohorts:

- **Sampling.** `--margin <gap>` samples decisions whose top-two utility score gap is at most it;
  the pack's novelty conditions (an unperceived target) still apply, and so do world decision-point
  scopes and triggers. Without `--margin`, a pack that declares decision points samples exactly as
  they and its ambiguity declaration say. Otherwise the default samples every utility decision with
  two or more eligible candidates (the margin is the span's largest top-two gap). The report's
  `sampling` names the rule (`operator-margin`, `pack-decision-points` or `every-decision`) and margin.
- **Cohorts.** A record is within the margin when its gap is at most the pack's declared score-margin
  (`policy.utility.ambiguity`), else outside it. `--cohort-margin <gap>` states another bound for
  classification only. With neither, records are unclassified. The report's `cohortMargin` names the
  bound and its `source` (`pack`, `operator` or `none`).

Without world points, the command adds an operator-only observation point showing all native
features. It takes every decision the sampling raises, unperceived-target ones included.

Every committed decision is either a record or counted in `utilityAgreement.skipped` with its reason
(`not-utility-tier`, `single-candidate`, `no-ambiguity-condition`, `out-of-point-scope`,
`trigger-not-met`); the top-level `skipped` lists each one. The model sees each feature with its
unit and range (shares of 10000 with their percentage, yes/no flags, milliseconds) and a legend of
their meanings, never scores or ranking.

The spend cap is shared by the labelled reference cases and the world observations. Each attempted
call permanently reserves its configured ceiling for this run, including calls whose actual cost
is unknown or lower. Reference cases run first. After the cap is reserved no further provider call
is made: each later sampled decision is recorded `over-budget` with detail `shared-budget`, never as a
failed call. A call whose cost is unknown counts against its point's spend budget at the per-call
ceiling. A ceiling is a configured provider-cost bound, not a guarantee against a provider charging
more than configured; actual measured spend and unknown-cost counts are reported separately.
`--models-off` writes the same simulation/replay result with no provider calls and no judgement
accuracy. A zero cap is valid and permits no calls. No real provider invocation is required for an
offline command smoke check.

`latency.world` and `latency.reference` give the measured calls, mean, p50 and p95 (nearest rank, ms)
of the world observations and the reference cases apart; each point in `utilityAgreement` also
carries its mean, p50 and p95.

The JSON report separates `utilityAgreement` from `reference.accuracy`. Utility agreement is never
accuracy. The three labelled references are generated in code from fixture state using the native
utility scorer: a wet actor seeking shelter in rain, staying in dry weather, and avoiding a trip for
negligible protection. Explicit counterfactual weather, needs, shelter protection and travel-weight
settings make the score gap no more than the fixed declared reference margin of 2. Scores are
computed by the native scorer, never assigned by the reference builder. Expected choices and one-line
reasons are authored separately and excluded from model input; one case deliberately disagrees with
utility's tie-breaking choice. These three calibration cases are a small judgement reference, not
a claim of broad model accuracy. `--reference-pack` may select a compatible fixture copy; it needs
an actor with needs/wellbeing and a reachable shelter away from it. The default reference fixture
ships with the pinned platform. No selected external world's names are built into the runner.

Reference calibration uses a confidence threshold of zero basis points, so any reported confidence
can count as an answered pick. Missing confidence remains low-confidence. Reference accuracy counts
answered picks, reports coverage separately, and is null when no case was answered.

## Remote MCP installation readiness

Issue 164's [MCP foundation](../protocols/mcp.md) is an application-level transport and credential
boundary with an isolated PostgreSQL secret adapter. It is not composed into the deployed Worker, and there is no installation endpoint or
capabilities screen yet. Do not grant actor access by inserting remote names into internal grants.

Before enabling the operator flow, compose the internal canonical installation/review service with
binding events, trusted secret-provider ownership and lifetime,
the actor capability revision hook and the operator browser journey. Verify Cloudflare egress
behavior at that consumer; DNS preflight alone does not prove address pinning. A local fixture
adapter must never become a production loopback switch.

The completed operator procedure must connect the installation owner's OAuth account or static
token through the isolated credential provider, inspect identity/protocol and schema hashes,
review and enable only selected tools, and bind them through scoped grants. Refresh must disable
only drifted versions; revoke must invalidate grants immediately and keep uncertain credentials
unusable. These procedures remain pending integration, rather than commands available today.

The secret adapter is deliberately session-owned: provider takeover fences all existing credentials
in its installation scope, and operators must reconnect them. Never construct it per request or
allow a connection pool to reconnect behind it. Provisioning prerequisites and the isolated role
are documented in the [database runbook](database.md#mcp-secret-provider-prerequisite). The
PostgreSQL secret proof does not establish that the operator/runtime flow is ready.

Part 3 supplies internal canonical installation governance under `runtime:mcp-install`, held
by world owners by default. The PostgreSQL service records discovery, exact-schema review,
refresh drift and terminal revocation with atomic attributed Journal events and scoped RLS.
It does not perform the network request, connect an OAuth account, revoke a credential or
notify actors. Those steps must be composed before exposing an installation endpoint.
There is still no capabilities-screen procedure available to operators. Do not treat a
reviewed database candidate as a callable actor grant.
