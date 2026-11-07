# Runtime world commands

`POST /v1/runtime/commands` submits one bounded world command through the authenticated Worker,
native WorldDO coordinator and the world's single partition SpaceDO. PostgreSQL owns physical
commit authority. Native memory and SQLite hold only recoverable projection state.

## Request

Send a Bearer session credential and a strict JSON envelope:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `tenantId`, `worldId`, `timelineId`, `spaceId` | Opaque `RuntimeScope` IDs |
| `routingEpoch`, `authorityEpoch` | Nonnegative decimal strings |
| `command` | `encodeCanonicalNode(CommandEnvelope)` |

The command targets the outer world scope. The gateway uses the shared canonical-node and command
decoders; unknown fields refuse. Caller attribution and context are data, never authority. Public
commands cannot use the reserved `trusted:` command-ID namespace.

## Route names and epochs

For an undecided command, `routingEpoch` and `authorityEpoch` must both equal the partition's single
durable `routing_epoch`. By design the authority epoch is the routing epoch (2026-10-27): that one epoch fences routes and writers, and no separate authority epoch is planned. Stale
runtime incarnations are fenced by owner generation ([Autonomous alarm
bounds](#autonomous-alarm-bounds)).

The Worker routes to Durable Objects named by `stableRuntimeRouteName`: `v1-<kind>-<SHA-256 hex>`
over `ROUTE_VERSION` (`clockgrove-route-v1`), the kind and the length-framed opaque IDs. Clients
never see or supply these names. `ROUTE_VERSION` versions the derivation, and the `v1-` prefix
versions the name format. The [runtime runbook](../runbooks/runtime.md#route-name-version-policy)
holds the full policy:

- Changing either renames every Durable Object, and changing a kind's ID tuple renames every
  object of that kind. New instances rehydrate from PostgreSQL; storage under the old names is only
  rebuildable runtime state (Wave 3 plan §7.2).
- Under the new code, every owner entry point that can claim or commit recomputes its own name and
  refuses a mismatch (`RuntimeRouteKeyMismatchError`), so an old-name instance does no work, even
  when its leftover native alarm fires.
- If old and new code overlap (a gradual deployment or a rollback), owner generation lets at most
  one SpaceDO incarnation of either name commit at a time; it does not stop an old-name
  incarnation that claims later. A version bump deploys as one non-gradual deployment.
- After a rename, a running world's clock advances again only when its new-name SpaceDO is next
  reached by a world command or an open catch-up. The bump either wakes every ready partition or
  records the maintainer's acceptance of that stall.
- A version bump is a reviewed change that updates the literal golden route vectors in the same
  change. Every call site names its object through one per-kind function, `runtimeRouteName`, so
  the vectors pin the derivation and every kind's ID tuple.

## Timeline clock controls

The same `CommandEnvelope` transport accepts these command types and payloads; the complete
command, including bigint payload values, is encoded with `encodeCanonicalNode`:

| Command type | Payload |
| --- | --- |
| `PauseWorld` | `{ schemaVersion: 1 }` |
| `ResumeWorld` | `{ schemaVersion: 1 }` |
| `SetClockPolicy` | `{ schemaVersion: 1, simulationMillisecondsPerWallMillisecond, catchUpCapMs }` |

`simulationMillisecondsPerWallMillisecond` is an integer from 1 through 1000000.
`catchUpCapMs` is a positive signed-64-bit bigint in simulation milliseconds (maximum
9223372036854775807). Invalid payloads receive `400 invalid_world_command`. A committed
`WorldCommandResult` includes the committed `clockPolicy` in `value`, with its monotonic version,
running state, simulation/wall mapping, speed and activation cap. These controls use the same
readiness, epoch fencing and command-ID retry rules as physical commands. They require committed
world participation and their own grant, `runtime:world-clock`; `runtime:world-command` alone is
refused with reason `runtime-grant-missing`, so pausing or re-speeding a world is a separate right.

A ready world starts paused. Its speed comes from its installed `GenesisClockPolicy`, and its
initial activation cap is 86400000 simulation milliseconds. The first `ResumeWorld` anchors current
canonical simulation time to trusted server wall time; it does not accrue time since the pack's
`wallEpoch`. While running, elapsed trusted wall time earns simulation time at the committed speed.
`PauseWorld` retains earned time and pending work, excludes paused wall time, and stops further
autonomous advancement after already admitted physical work finishes. `ResumeWorld` continues that
mapping without losing backlog. `SetClockPolicy` preserves time earned at the old speed before
anchoring the new speed, so changing speed neither rewinds time nor creates a discontinuity.
Each activation durably admits at most `catchUpCapMs` of previously unadmitted earned simulation
horizon. Admission does not mutate physical state or its revision. Unused admitted horizon and
remaining earned backlog survive sleep, restart, compatible replacement and runtime-local loss.
The cap does not bound the committed physical `simulationTime` delta. Viewer presence does not
change speed.

The policy fields are `schemaVersion`, `version`, `running`, `simulationAnchor`, `wallAnchor`,
`simulationMillisecondsPerWallMillisecond` and `catchUpCapMs`. Anchors and cap use bigint
milliseconds; `wallAnchor` is server Unix time. The uncapped earned target while running is
`simulationAnchor + max(0, now - wallAnchor) * simulationMillisecondsPerWallMillisecond`.
An autonomous activation accumulates admission up to that earned target. New physical commands
use durable schedule boundaries, independently of the cap and alarm delivery time. A paused policy
admits no horizon and runs no autonomous physical commands.

**Client commands run at earned time.** On a running clock the owner first runs the overdue
due work (due at or before earned time), one deadline per transaction through the due-work path,
exactly as the alarm would. The command then runs at earned time in its own transaction. Canonical
time moves with the command's own events (a time-only move): no needs, wellbeing or plant
integration is written, because those are stored lazily with an `integratedAt`. Environment
boundaries (phase and weather changes, deliveries, spoilage, growth stages, threshold crossings)
are state changes only an advance emits and are not in the alarm plan. When a pure lazy probe in
the command's transaction finds boundaries at or before earned time (or cannot complete within its
event budget), catch-up first commits one trusted lazy advance through them (boundary events only,
no per-actor integration) and the command then runs at earned time: it never stops short. Time
never moves backwards. A paused
clock earns nothing: the command runs at the current time and no catch-up runs. Normally nothing is
overdue because the alarm keeps up; the fast path is one owner read, with no extra transaction.
More than 8 steps in all (due deadlines, continuation chunks and boundary advances) refuse the
command with a retryable 503 `world_catching_up` and `Retry-After`, with nothing of it recorded;
a refused or incomplete boundary advance refuses the same way. The alarm and catch-up path drain
the rest. Progress by a concurrent alarm counts, and a pause between steps is
re-read. If catch-up changed the state a client relied on, `expected.partitionRevision` conflicts
as it does after an alarm: nothing is rebased. Catch-up and the command carry the alarm's owner
generation and policy version, so a superseded incarnation is fenced before it writes.

Reads return the stored state unchanged plus a derived, non-canonical `earned` view
(`canonical: false`): needs, wellbeing and plant growth integrated to earned time by the kernel's
lazy integration, computed on read and never written.

`world.weather.set` v2 has the payload `{ schemaVersion: 2, rainIntensity }` and applies at the
command's own time. v1 is retired: replay is event-sourced and never re-executes commands, so new
commands (client or rule) at v1 are refused with `unknown-command-version`. `world.advance` accepts
an optional `lazy: true` that moves time without integrating every actor and plant at the target.

Clock commands atomically commit a receipt, authority decision, `ClockPolicyChanged` event and
resulting timeline policy. They preserve the physical world hash, kernel revision, schedule queue
and named random state. An exact retry returns the stored result without another policy change.
The committed policy version fences trusted autonomous physical commits: a superseded version
cannot commit after a clock change. Runtime-local loss reconstructs policy and version from
canonical history; corrupt stored policy is `durable_state_corrupt`, never a client-input refusal.
`TimelineClockPolicy` is the provider-neutral application contract consumed by runtime owners.
Trusted advancement uses that committed policy within its ready tenant/world/timeline scope and
requires no live browser session or retained session credential. It acts as the world's system
principal `system:world:<worldId>`, created with the world row and never a member: its authority
decisions record that principal with no roles, grants, World membership or persona, and its
commands keep the `clockgrove:due-work` effective actor. Adding or removing members never changes
it. A successful resume reconciles
the single native SpaceDO alarm; WorldDO routes to that partition owner.

`ResumeWorld` changes the timeline clock's running state. The existing continuation-resume
operation executes another bounded chunk of an already accepted physical command; it does not
resume a paused clock.

## Authority and readiness

Execution requires committed participation in the requested world and `runtime:world-command`;
clock controls require `runtime:world-clock` instead. Neither grant implies the other.
Workspace administration, workspace grants and `runtime:no-op` never grant physical mutation.
Authentication failures return HTTP 401. Principals outside the named tenant receive no world data
or readiness disclosure. An authenticated tenant member receives HTTP 409 with
`{"error":"world_not_ready"}` before world readiness, without a projection or physical execution.
The existing `/v1/runtime/no-op` authorization and retry contract remains separate.

## Result and retry identity

Results are `encodeCanonicalNode(WorldCommandResult)`, preserving `commandId`, `outcome`, `value`
and `events`. Committed results use HTTP 200; kernel refusals use 409; authorization refusals use
403; authentication refusals use 401. Boundary conflicts use stable JSON `error` codes.

Boundary failures return JSON `{"error": code}` with a stable code, never an exception name:

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_world_command` | The envelope or command does not decode |
| 401 | `authentication_refused` | No valid session |
| 403 | `authorization_refused` | Outside the tenant, or owner scope refused |
| 404 | `space_not_found` | An authorized caller named a space that is not the world's partition |
| 409 | `world_not_ready` | Tenant member, world not ready |
| 409 | `world_command_conflict` (+ `kind`) | Stale epoch or revision; nothing written |
| 409 | `command_id_reused` | Same command ID with different accepted bytes |
| 409 | `world_continuation_pending` | The partition's open continuation runs first |
| 503 | `world_catching_up` | More than 8 catch-up steps (or a boundary advance over budget); retry after `Retry-After` |
| 500 | `durable_state_corrupt` | Stored state failed decoding or verification |
| 500 | `world_command_failed` | Server failure; the commit outcome may be unknown |
| 503 | `owner_unavailable` | The owner could not be reached; the commit outcome may be unknown |
| 503 | `owner_mailbox_full` (+ `retryAfterSeconds`) | The space owner's mailbox is at its depth bound; refused before enqueue, nothing ran |
| 503 | `owner_mailbox_expired` (+ `retryAfterSeconds`) | The request's deadline passed while it waited; dropped unstarted, nothing ran |
| 503 | `owner_mailbox_timeout` (+ `retryAfterSeconds`) | The deadline passed after the command started; it may still commit |

The three `owner_mailbox_*` answers carry `Retry-After` and the same hint in `retryAfterSeconds`.
None reports failure: retry with the same accepted bytes after the hint, and a command that
committed meanwhile returns its stored outcome.

On a 5xx, retry with the same accepted bytes: a committed command returns its stored outcome. A
caller without world authority who names an unknown space receives the same denial result as for
a known one, so placement is not disclosed.

A successful response follows the PostgreSQL commit of the receipt, authority decision, events,
partition state and schedule changes. SpaceDO serializes admitted physical work through one FIFO
mailbox, after authorization; its order is admission order only, and PostgreSQL assigns canonical
order at commit. Its bounds and answers are in the
[runtime runbook](../runbooks/runtime.md#physical-owner-mailbox). Receipt identity
includes the accepted command and both epoch preconditions. Preserve the accepted bytes and
authenticated request metadata for an exact retry after response loss. Such a retry returns the
stored result after authentication and scope verification even if the durable epoch has changed,
without another authority decision, kernel call or durable effect. Reusing the command ID with
different accepted bytes refuses.

Both epoch preconditions fence undecided commands transactionally against the currently shared
durable epoch, including canonical placement changes after hydration. Each command-owner
persistence invocation owns one runtime PostgreSQL connection for reads and journal work. Concurrent
invocations share neither transactions nor transaction-local authority; cleanup releases the
connection on success, failure and cancellation.

## Autonomous alarm bounds

Each SpaceDO owns at most one physical alarm. WorldDO coordinates routing and does not advance
partition-local physical state. One activation starts at most four command attempts, and starts no
further attempt after 250 milliseconds of elapsed activation time. Each trusted kernel call retains
`DUE_WORK_ADVANCE_BUDGET` (16 inputs and 4096 events). These limits also apply to continuation chunks.
An accepted continuation runs first through `continueWorldCommand`/`advanceDueWork`, retaining its
origin attribution, random state, durable cursor and immutable target. Its completion may exceed
the admission cap, including after a reduction to 1 ms.

Admission is a policy-version-fenced PostgreSQL transaction with an activation receipt. Duplicate
admission returns the same horizon; retries of physical commands and chunks use existing journal
identities and revision checks. Pause, resume and policy changes supersede local alarm intent;
obsolete handlers cannot admit or commit under a superseded policy. Each native incarnation claims
one durable owner generation, held in place on the partition row. Every claim attempt of an
incarnation carries the generation it observed before its first attempt: a response-loss retry
recovers its own claim, and an incarnation that a newer one claimed after supersedes is refused at
any retry delay, never stealing the newer owner's authority. A fenced owner never claims again.
Admission and physical commits fence that generation; local storage transactions guard alarm
reconciliation and cleanup against a newer generation. A native owner keeps one activation in flight
and replays only that one, so each new admission deletes every other receipt of the partition.

Runnable work leaves one near-term continuation alarm. Otherwise the alarm maps the next durable
simulation deadline under the committed speed. Paused or exhausted owners retain no polling alarm.
A recovery alarm is installed before canonical operations; a failure or interruption between journal
commit and reconciliation retries from committed admission, schedules and continuation state.
Database failure never rolls back an earlier committed chunk or admission.

Excess earned due backlog after the bounded ordinary activation escalates to
`WORLD_CATCH_UP_WORKFLOW` (`WorldCatchUpWorkflow`) without further client traffic. Its strict
version-1 `CatchUpWorkflowEnvelope` is `{ version: 1, tenantId, worldId, timelineId, spaceId,
applicationRunId }`. PostgreSQL binds the accepted run to its scope and fixed trusted wall-time
target. The reference carries no physical state, caller authority or continuation. Catch-up invokes
the same physical owner and world system principal; every activation retains the bounds above.
Admission caps bound new horizon, never backlog retention or physical integration boundaries.
Policy and owner-generation fences also protect late results, failures and alarm cleanup.

The per-partition operational link is tenant-isolated and updated in place, including completion and
supersession; retries do not append operational history. Scheduled reconciliation recovers eligible
accepted operations independently of native execution status, including after exhausted native
retries once infrastructure returns. Failed candidates are isolated from other catch-up and
provisioning/readiness candidates. See the [runtime runbook](../runbooks/runtime.md#durable-sleeping-world-catch-up)
for durable identity, retirement and local-versus-hosted qualification boundaries.

## Continuation and recovery

A committed `value.complete: false` is the existing application's bounded continuation result.
The public operation does not promise completion of the whole chain. Trusted owner work resumes
the stored continuation through the same physical owner using application-minted chunk IDs.
Clients cannot supply trusted chunk IDs or inject continuation state.

Native restart and local-storage loss hydrate the journal-backed partition state, schedules and
named random state. PostgreSQL supersedes stale runtime-local projection state. Hash verification
fails closed on corrupt durable state; corruption is a server integrity failure rather than
malformed client input.

## Local qualification

Finite native tests exercise the production Worker, native Durable Object adapters, installed
immutable pack behavior, stored-session authentication and real disposable PostgreSQL. The reusable
test surface supports authenticated submission, trusted continuation, runtime replacement and
durable-state comparison, with owned subprocess/database cleanup and `TMPDIR` support.

`apps/runtime/test/world-owner/native-harness.ts` packages that local surface for dependent native suites.
The parent owns the disposable database, bundle, loopback bridge and bounded child process. The
child uses `withNativeWorldOwner` to submit authenticated HTTP requests, invoke the test entry's
trusted continuation route, inspect hydrated state and replace the native runtime with retained
or discarded local storage. Its ordinary command requests delegate to the production Worker.

Native autonomous parity runs every scenario and variant in `SCENARIOS` under continuous headless
application execution (`advanceClock` under the same autonomous policy and inputs), frequent alarms,
bounded catch-up after sleep, durable `workflow-catch-up`, redelivery, restart between batches and
compatible runtime replacement.
Each run must finish without an open continuation. It is compared in three ways:
- with the headless run on the full `worldStateHash`, the named random state and the schedule queue
  hash, which is rebuilt from the stored schedule rows;
- with an independent reference, the pure kernel advancing each scenario step through its due
  deadlines only (no runtime code), on the same hashes without revision. Revision counts transport
  commands, which the reference chunks differently. Every mode is checked, headless included.
- with the journal on revision: the stored revision must equal the birth revision plus the
  partition's journaled world kernel events, since each applied event increments it once.

Reports print pack/scenario/run/mode identities and both pairs of hashes. Scenario command outcomes
and semantic event envelopes also match the headless run; incidental journal `recordedAt` timestamps
are excluded from that response comparison. That comparison is relative: headless shares the client
command path with every mode, so a response defect common to that path passes it. A shared defect
that changes state still fails the independent reference. Generated partition revision guards
preserve their live/stale relationship to the scenario's command history. Existing command-path
golden parity remains a separate comparison.
Ordinary runtime validation exercises a representative alarm safety matrix; `test:long-run` runs
the complete autonomous matrix using bounded native processes and disposable PostgreSQL.

This is local evidence. Hosted deployment and hosted alarm delivery/limits, Queue delivery,
cross-space transfer and complete Wave 3 qualification remain outside this capability's claim.
