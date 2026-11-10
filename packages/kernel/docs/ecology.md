# Resources and growth: food, water, spoilage and cedar growth (RW-0107b)

**Policy and state.** `policy.ecology` (optional, requires `environment`) declares
`perishables` (food holders with a shelf life), `plants` (growing light bands and stages), and
optional `waterHolders` (rain collectors with capacity and evaporation). `state.ecology` tracks
perishable arrival times, plant stage/growing time/wetness and collector fractional integration.
Refusals are `invalid-input` at `pack.pack.policy.ecology...` or `partition.state.ecology...`.
`ecology.state-matches-policy@1` is a precondition and post-state invariant of every command.
Movement and portal commands account for physical causes at every instant they pass
([spatial movement](spatial-movement.md#world-time-a-move-passes)).

**Schema and validation.** The policy is `schemaVersion: 1`. Required lists `perishables` and
`plants` hold at most 64 entries each. Plants declare 1–64 growing light bands and 2–16 uniquely
named stages; the first threshold is 0 and later thresholds strictly increase. Shelf life is a
positive bigint and stage thresholds are nonnegative bigints, at most 2^53 milliseconds. A plant
cannot also be a perishable; growing light bands must be declared by the environment. The record
has no missing or extra fields: legacy `sources`, including an empty list, is refused at pack
validation. State entries follow policy order, arrival time is null exactly when food is empty,
and plant stage agrees with growing time.

**Closed world and journal accounting.** Genesis quantities are the declared initial inventory.
Later increases require `resource.weather-integrated@1` collection, a declared
`growth.stage-changed@1` yield, or `resource.transferred@1` debiting an existing holder.
`resource.quantity-conservation@1` balances every holder and resource kind, as well as global
food and water totals, against the command's journal events. An unjournaled movement, kind swap
or increase is refused at the affected `state.entities[i].resource.quantity` path. The ecology
invariant additionally checks weather quantities and plant yields against their declared policy.
A globally balanced but unsupported event cannot authorize new material.

`resource.offer` is retained in the command catalogue for a stable refusal, but cannot mint food
or water. `object.create` may create an empty holder; positive resource inventory is refused.
Both commands return `precondition-failed` with check `resource.closed-world@1`: offers at
`payload.quantity`, positive creation at `payload.object.resource.quantity`. The matching
`resource.closed-world@1` invariant rejects new offered, appeared or positive-created events
at `events[i].type`, independently of conservation totals. Policy rules cannot declare unbacked
creation. Historical `resource.appeared`,
`resource.offered` and resource-bearing `object.created` reducers remain for replay compatibility;
new execution cannot use them to increase inventory. Source schedules do not exist.

**Systems and ordering.** `world.advance` registers spoilage, weather-water and plant growth
systems through the existing catch-up registry alongside environment systems. Same-time physical
order is phase, weather, exposure, spoilage, weather water, then plant stage change, each kind
in object-id order; declared processes follow before actor decisions. Weather-boundary integration
records the prior interval before the weather transition. Time groups are indivisible: event
budgets and continuation retain the environment contract. Re-advancing to the same time creates
nothing. `growth.integrated` and zero-delta weather integration are incidental boundary events.

**Food and water.** Food spoils entirely `shelfLifeMs` after arrival. Consuming to zero clears
arrival time. A transfer from a perishable preserves arrival time; a transfer from another holder
uses the transfer instant. A transfer into a perishable holder that already holds food is refused
by `resource.perishable-single-batch@1` at `payload.toObjectId`. Water does not spoil. Rain
changes only declared `waterHolders`; ordinary commands move or consume that finite water.
`foodFreshnessBasisPoints` returns floor(10000 × remaining / shelf life), clamped to 0–10000,
or null for an empty holder. `resourceAvailability` is derived as available or unavailable.

**Cedar growth.** A plant's wetness is integrated wherever needs actors are integrated and before
`world.weather.set` changes rain, with the unchanged `integrateNeedsWith`. A millisecond `[t, t+1)`
counts as growing when the light band at `t` is one of the plant's bands and wetness at `t` is at
least `wetThreshold`. A `growth.stage-changed` event is emitted at the first millisecond growing time
reaches a stage threshold, after the plant's `growth.integrated` event; the last stage stays.

**Finite plant yield (closed-world part 2).** A noninitial stage may opt into
`yield: { quantity }`, producing that many food units in the plant's own food resource holder once
when growth enters the stage. Yield quantities are positive safe integers and their sum cannot
exceed the material range. A yielding plant must have a food resource holder, and current inventory
plus all remaining yields must fit that range; otherwise `ecology.state-matches-policy@1` refuses
the state at `policy.ecology.plants[i].objectId` or `state.ecology.plants[i].stage`, respectively.
Malformed quantities and initial-stage yields are refused as `invalid-input` under the stage's
`policy.ecology.plants[i].stages[j].yield` path (prefixed `pack.pack.` at kernel pack validation).

Yield is optional data on `growth.stage-changed@1`, alongside the plant id, stage index and name.
The event atomically advances the plant and credits its food inventory. The ecology invariant
checks sequential stage entry and exact agreement of the event's yield with the declared policy
for yielding plants. Resource conservation credits both the global food total and the individual
plant holder. Yield follows existing stage-change ordering and instant boundaries, including time
passed by movement and portal commands, and needs no extra scheduled event or event-budget slot.
The journal retains the plant and stage as the physical cause; ordinary transfers can move the
food elsewhere. The initial stage and already reached stages never yield; the final stage stays
and does not regenerate food after consumption. Existing plants without yield preserve their
events and hashes. Plants still cannot be perishable holders; spoilage applies after transfer to
a declared perishable holder.

`test/plant-yield.journey.test.ts` proves literal yields at 1000 and 2000 ms, live versus aggregate
and bounded continuation, native replay, movement-time yield, no repeat/refill, malformed policy,
missing holder and material-range refusals, and rejection of forged journal quantities.

**Weather water holders (closed-world part 3).** Optional `ecology.waterHolders` entries declare
`{objectId, capacity, catchment, evaporationPerHour}`. Capacity is a positive safe integer; rates
are nonnegative safe integer water units per hour. Catchment is the collection rate at rain intensity
10000 and shelter protection 0; actual collection scales by both rain and the unprotected fraction.
The holder must hold water, and cannot also be a plant. Zero catchment models no
collection. Declaring positive catchment models an open collector; no new container-opening
command or authority is introduced.

An explicitly empty policy list requires an explicitly empty state list. The matching optional
state list records each holder's `objectId`, `collectionRemainder`,
`evaporationRemainder` and `integratedAt`. Every completed or bounded advance settles all water holders to the returned
world time, so a subsequent inventory command cannot apply new water retroactively. Integer arithmetic retains fractions so live steps and
one aggregate advance reach the same integer-unit instants. Collection is clamped at capacity,
discarding overflow; evaporation is clamped at empty without accumulating debt. At a shared
integer instant collection precedes evaporation. Existing shelter protection applies to collection.

`resource.weather-integrated@1` carries `{objectId, collected, evaporated, collectionRemainder,
evaporationRemainder, integratedAt}`. Its reducer credits collected water, debits evaporated water
and records integration state atomically. Per-holder and global resource accounting include both
deltas. The ecology invariant validates weather integration against the declared policy, preventing
a forged collection event from authorizing unrelated creation. The journal identifies weather and
the collecting holder as the cause. No new command or principal is added.

Weather holders use the existing catch-up path, including weather boundaries and time passed by
movement or portals. Material water changes occur at their first due millisecond; fractional
integration at other command boundaries may emit zero-delta incidental events. A weather override
is integrated under the previous rain before the new intensity takes effect. Ordinary resource
commands preserve integration up to their instant and the next advance starts from the changed
inventory, including a holder drained during one advance. Re-advancing to the same time creates no
water. `test/weather-water.journey.test.ts` is the native executor proof for this optional cause,
with literal quantities and times, execution-shape parity and journal replay. Material comparison
includes weather events with nonzero collection or evaporation; zero-delta integration events are
incidental because command boundaries vary. Material equivalences compare physical collection/evaporation while ignoring zero-delta integration
whose presence depends on command boundaries.

Policies without `waterHolders` preserve their state representation. Weather, plant and process
causes are platform kinds; the fixture chooses quantities, cadence, catchment and capacities.

**Evidence and goldens.** Native plant, weather and process journey tests prove literal instants,
quantities, ordinary command refusals, bounded continuation and journal replay. Reference scenario
and long-run checks exercise the same native invariant on every accepted command. Scenario
equivalences compare live small steps with aggregate advances, and replay reproduces final state.
Physical fixture changes and exact generated golden bytes are reviewed through the simulator's
[golden review workflow](../../simulator/docs/conformance.md#golden-review-workflow); a changed
hash alone is not approval of changed physical assertions.

**`material-ecology` equivalence.** Material events include environment transitions, exposure
thresholds, spoilage, resource transfers, plant stage changes and routine selections, with
simulation times and payloads. The weather and process journey tests additionally compare their
own material cause events, including nonzero collection/evaporation and process attempts. Needs/growth
integration, zero-delta weather integration, time advancement and revision are incidental to
step boundaries. Each scenario declares the exact comparison fields and expected equivalences.

**Ecology refusals** (frozen, returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.ecology` or a field below it: null or wrong type; missing or extra field; unknown `schemaVersion`; no `environment`; a non-positive `shelfLifeMs`, negative `thresholdMs`, or wrong-typed or out-of-range duration; more than 64 entries or bands; no bands; fewer than 2 or more than 16 stages; first threshold not 0 or thresholds not increasing; duplicate stage names or ids; a plant that is also a perishable; an undeclared light band | - |
| `invalid-input` | `partition.state.ecology` or a field below it (null, wrong type, missing, extra or wrong-typed field) | - |
| `precondition-failed` | `state.ecology`, `state.ecology.perishables[i]`, `state.ecology.plants[i]` and corresponding policy object paths (record and policy disagree) | `ecology.state-matches-policy@1` |
| `precondition-failed` | `payload.toObjectId` (transfer) into a perishable holder that holds food | `resource.perishable-single-batch@1` |
| `invariant-violated` | the same `state.ecology...` paths | `ecology.state-matches-policy@1` (a post-state invariant for every command) |
| `invalid-input` | `payload.maxEvents` (a group cannot fit an empty budget) | - |

**Deferred.** To Wave 8 RW-0804 ("Environment and ecology depth"; Wave 8 §7.2 and the parent plan
§7.8 Food, Water and Growth rows): depleted, available and unavailable events;
growth death and plant removal; eating or harvesting plants beyond ordinary transfers of declared stage yields; moisture- or temperature-dependent decay;
freshness after food leaves a perishable holder and other food quality; seasons and richer weather. To Wave 8 RW-0803 ("Household and social routines"; Wave 8 §6, "competition or sharing over
limited resources"): ownership and sharing rules. To Wave 6 RW-0605: perception of the new events (none
is in `PERCEIVABLE_EVENT_TYPES`). No wave plan links weather to live external data.

**Declared world processes (closed-world part 4).** Optional `policy.processes` declares up to
64 processes, using the ecology list bound to cap work at an instant. Each entry is
`{id, principalId, firstAtMs, periodMs, command: {type: "resource.transfer", payload}}`.
The payload is the ordinary version-1 resource-transfer payload, including `schemaVersion`.
Ids use the command object-id text bound (1–512 characters without surrounding whitespace);
process ids are unique. First time and period are positive bigint milliseconds at most 2^53,
matching ecology duration bounds. Unknown fields, command kinds and malformed payloads are
refused at the corresponding `pack.pack.policy.processes...` path. An explicitly empty list
requires an explicitly empty `state.processes` list; absent lists preserve existing encoding.

The matching state entries are `{processId, nextAt}` in policy order. Genesis seeds the first
cadence instant at or after its epoch; earlier occurrences are not run retroactively. Null
`nextAt` means the next occurrence would overflow the existing simulation-time range. Each
`process.command-attempted@1` records process id, deterministic command id, next instant and
an exact ordinary refusal or null for success. The reducer advances the cursor even on refusal.
Successful occurrences immediately journal the ordinary `resource.transferred@1` event. Both
events name the declared principal, use `process:<id>` as effective actor and link the command
identity as immediate cause. The time-advance authority decision and causal root are retained;
this kernel attribution does not create an application capability grant.

At each instant, physical environment/ecology/growth events precede processes; processes run
in id order before actor decisions. Every attempt passes through the production resource command
executor, with its normal reference, inventory, single-batch and post-state checks. Transfers debit
finite source inventory; no process-specific quantity reducer exists. Refusals consume the occurrence,
change no inventory and stay inspectable in the journal. Process attempts and their possible transfer
reserve an indivisible event group within the existing `maxEvents` budget; `maxInputs` continues to
bound actor decisions. The scheduler rebuilds from changed inventories before passing more time,
including time passed by movement. The process invariant replays the prefix and checks the declared
cadence, identity, exact transfer/refusal and cursor updates against the ordinary resource checks.

`test/world-process.journey.test.ts` proves exact weather-before-process ordering, same-time process
id ordering, finite transfer/refusal results, live/aggregate/bounded parity, native replay, movement-time
transfer and spoilage, repeated-time no-op and forged journal/cursor refusal. The simulator's
`test/world-process-genesis.journey.test.ts` proves SDK build, nonzero-epoch genesis and subsequent
transfers at and just after that epoch.

The durable runtime also wakes for process deadlines, including worlds without actors and processes
due before an actor decision. PostgreSQL derives `next_process_due_at` from the earliest non-null
canonical process cursor at birth and after every state-document update. The optional process cursor
list is preserved in reconstructable birth sections, including an explicitly empty list.
A database trigger maintains the stored derived column on inserts and document or hint updates.
Expansion adds an ordinary nullable column without rewriting existing rows. Before the migration
runner returns and deadline readers switch, it fills and verifies existing rows through the bounded,
checkpointed `runBackfill` path; interrupted runs resume after the last committed batch.
It is scheduling metadata: it changes no canonical state, queue, event or hash. Due-work, clock-owner and
runtime-operation reads take the earlier of this deadline and the indexed pending schedule deadline.
The existing autonomous clock principal admits the advance; process attempts still execute ordinary
validated transfers attributed to the declared process principal. Actor schedule rows remain the
input to `dueSchedules`; process execution stays inside the native advance and movement paths.

`apps/runtime/test/world-process-wake.postgres.test.ts` proves SDK-built process worlds through
PostgreSQL provisioning, the clock owner's alarm plan and advance, all three deadline readers,
finite transfer and refusal, fresh-client recovery and duplicate-call no-op. It covers both an
actorless world and a process due before the next actor decision.
