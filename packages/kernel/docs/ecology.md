# Resources and growth: food, water, spoilage and cedar growth (RW-0107b)

**Policy and state.** `policy.ecology` (optional, requires `environment`) declares resource
`sources`, `perishables` (food holders with a shelf life), `plants` (growing light bands and
stages), and optional `waterHolders` (rain collectors with capacity and evaporation); `state.ecology` tracks each perishable's arrival time and each plant's stage, growing time,
wetness and integration time. Refusals are `invalid-input` at `pack.pack.policy.ecology...` or
`partition.state.ecology...`. `ecology.state-matches-policy@1` is a precondition and a post-state
invariant of every command; policies without ecology behave and encode byte-identically. A movement or portal command that moves the world time emits the spoilage, appearance and stage
changes it passes ([spatial movement](spatial-movement.md#world-time-a-move-passes)).

**Schema version and validation rules.** The policy is `schemaVersion: 1` (any other version is
refused). Each list (`sources`, `perishables`, `plants`) holds at most 64 entries, a plant declares 1
to 64 `growingLightBands` and 2 to 16 stages; the first stage threshold is 0 and thresholds are
strictly increasing; stage names, source ids, perishable ids and plant ids are each unique; every
duration (`firstAtMs`, `periodMs`, `shelfLifeMs`, `thresholdMs`) is a bigint of at most 2^53 (`firstAtMs`,
`periodMs` and `shelfLifeMs` are positive) and `quantity` is a positive safe integer; a plant is neither
a source nor a perishable holder; every growing light band is declared by an environment phase; the
record has no missing or extra fields. `state.ecology` is absent exactly when the policy has no
`ecology`; when present its perishable and plant entries follow the policy order, a perishable's
`arrivedAt` is `null` exactly when its holder is empty, and a plant's `stage` equals the stage its
`growingMs` reaches.

**Events.** `resource.appeared` (`{objectId, kind, quantity}`: adds the quantity to the source holder
and sets a perishable holder's arrival time to the event time), `resource.spoiled` (`{objectId, kind:
"food", quantity}`: removes the holder's whole food quantity and clears its arrival time),
`growth.stage-changed` (`{objectId, stageIndex, stageName}`: sets the plant's stage, which must
advance) and `growth.integrated` (`{objectId, growingMs, wetness, wetnessRemainder, integratedAt}`:
replaces the plant's integration fields, which must move forward), each at version 1 with exactly one
reducer. The offer, transfer, consume and retire reducers maintain arrival times without payload
changes. `resource.quantity-conservation@1` counts appearance and declared plant yield as additions,
spoilage as a removal, and weather collection/evaporation as additions/removals. The same invariant
also balances each holder and resource kind independently against creation, retirement, offer,
transfer, consumption, appearance, spoilage, growth yield and weather events. A transfer must
debit its source and credit its destination by the journaled quantity; a globally balanced but
unjournaled movement, or a swap of resource kinds between holders, is refused at the affected
holder's `state.entities[i].resource.quantity` path. Genesis quantities are the initial inventory.
This accounting preserves the existing cause kinds; removal of scheduled appearances and the
closed-world policy migration are separate changes.
`resource.event-authority.<world command>@1` allows the ecology events for the world commands.
`growth.integrated` is incidental: it is emitted wherever `needs.changed` is, so its count depends on
step boundaries.

**Systems.** `world.advance` registers one spoilage system per perishable holder, one appearance
system per source and one growth system per plant through `createCatchUpRegistry`, in the same
`catchUpSchedules` calls as the environment systems. No random stream is drawn. Same-time order:
phase, weather, exposure, spoilage, appearance, stage change, decision, each kind in object-id order.
Weather water scheduling is placed after appearances and before stage changes; integration at a
weather boundary records the interval under its previous rain before the transition.
Time groups are indivisible, so `maxEvents` and continuation behave as for the environment ([see the
bound above in Budgets and continuation](environment.md)), and re-advancing to the same time emits nothing.

**Food and water.** A source places its quantity into its holder (itself) at `firstAtMs + n × periodMs`
only when the holder is empty after any spoilage at that instant; a skipped appearance is not
queued. The holder at that instant includes every change before it in the same call: a decision or
arrival that consumes from a holder re-seeds that holder's spoilage and appearance schedule at its
time, so a source drunk dry inside one `world.advance` appears at its next due time in that call, as
it does across live steps. Perishable food spoils entirely `shelfLifeMs` after it arrived (a transfer from a perishable
keeps the arrival time); consuming to zero clears the arrival. Water does not spoil. Rain changes only holders declared in `waterHolders`
(see Weather water holders below). A perishable holder holds a single batch: `resource.offer` or `resource.transfer` into one
that holds food is refused with `precondition-failed`, check `resource.perishable-single-batch@1`, at
`payload.objectId` or `payload.toObjectId`. `foodFreshnessBasisPoints` and `resourceAvailability` are
exported pure functions of the domain package. Freshness is `floor(10000 × remaining / shelfLifeMs)`
with `remaining = arrivedAt + shelfLifeMs - now` clamped to `0..shelfLifeMs`, so it is 10000 on arrival
and 0 at spoilage, and `null` for an empty holder. Availability is `available` when the resource
quantity is positive and `unavailable` otherwise (derived, no event). A transfer into an empty
perishable holder from a perishable holder keeps that holder's arrival time; from any other holder
it uses the transfer's event time.

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
missing holder and material-range refusals, and rejection of forged journal quantities. Scheduled
source removal and fixture migration remain separate work; the additive growth, weather and process
causes alone do not establish the complete closed-world contract.

**Weather water holders (closed-world part 3).** Optional `ecology.waterHolders` entries declare
`{objectId, capacity, catchment, evaporationPerHour}`. Capacity is a positive safe integer; rates
are nonnegative safe integer water units per hour. Catchment is the collection rate at rain intensity
10000 and shelter protection 0; actual collection scales by both rain and the unprotected fraction.
The holder must hold water, and cannot also be a source or plant. Zero catchment models no
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
incidental because command boundaries vary. The existing `material-ecology` comparisons below
cover their original scenarios, which do not declare weather water holders.

Policies without `waterHolders` preserve their state and event representation. The additive event
registry changes simulator bundle identities even for those policies; reviewed fixture goldens
record that registry change separately from the later physical source migration. Scheduled sources
remain until the source-removal and fixture migration part of issue 187. Genesis resources are
the initial inventory; full closed-world validation across all reference and long runs remains a
later part.

**Evidence.** Generated tests (named stream `behavior`, seed `ecology-resources-v1`), targeted tests,
the `material-ecology` pairs `live-steps-vs-fast-forward` and `bounded-continuation-vs-unbounded`, and
the `food-decay-and-conservation` and `cedar-growth` goldens (committed literal hashes) run in Node
and Workers. `fullRuntimeEvidence` adds an `ecology` section; `ecology.json` holds the Node and Workers
bodies and a `comparison` summary, validated by `test/spatial-evidence.ts` (see
[Evidence report files](evidence.md#evidence-report-files)). `identity.events` grows by
the four original ecology events plus `resource.weather-integrated@1`; commands, `PERCEIVABLE_EVENT_TYPES`, `examples/world-packs`, the scheduler,
needs arithmetic and the component catalog are unchanged. Outputs for states without `ecology`
(containment and resource command outputs included) are unchanged. For policies without weather
holders, `resource.consume` emits no new event. Input hashes reuse `containmentInputIdentity`.

**`material-ecology` equivalence.** Compares the ordered `environment.phase-changed`,
`weather.transitioned`, `exposure.threshold-crossed`, `resource.spoiled`, `resource.appeared`,
`growth.stage-changed` and `routine.selected` events by type, simulation time and payload, plus the
final state with `revision` set aside. `needs.changed`, `growth.integrated` and `time.advanced`
events and `revision` are declared incidental because their count depends on step boundaries. Pairs
proved equal: `live-steps-vs-fast-forward` and `bounded-continuation-vs-unbounded`. The fixture-hall
one-year long run (`worlds/fixture/reference/long-runs/long-run-one-year.json`) walks an actor to the
water source, whose decisions drink it dry; its `small-step-vs-aggregate` equivalence compares the
resource events as well, and both runs assert the refill at the next due time after the first drain.

**Goldens.** `food-decay-and-conservation`: food and water appear on schedule, a partial and a
full consume, a refused offer into a holder that still has food, food that spoils entirely at
`arrivedAt + shelfLifeMs`, a refill, rain that changes no resource, and totals that equal the recorded
additions and removals; live steps, one fast-forward and a bounded chain agree and a re-advance emits
nothing. `cedar-growth`: an exposed and a fully sheltered cedar over three days of rain and light; the
exposed plant passes every stage at the first millisecond its growing time reaches the threshold, the
sheltered plant never leaves stage 0, and the three execution shapes agree. Both hashes (material
events, final state) are committed literals asserted in Node and Workers.

**Ecology refusals** (frozen, returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.ecology` or a field below it: null or wrong type; missing or extra field; unknown `schemaVersion`; no `environment`; a non-positive, wrong-typed or out-of-range `firstAtMs`, `periodMs`, `shelfLifeMs`, source `quantity` (zero, negative, wrong type or beyond the safe-integer range) or `thresholdMs`; more than 64 entries or bands; no bands; fewer than 2 or more than 16 stages; first threshold not 0 or thresholds not increasing; duplicate stage names or ids; a plant that is also a source or perishable; an undeclared light band | - |
| `invalid-input` | `partition.state.ecology` or a field below it (null, wrong type, missing, extra or wrong-typed field) | - |
| `precondition-failed` | `state.ecology`, `state.ecology.perishables[i]`, `state.ecology.plants[i]` and `policy.ecology.sources[i]` (record and policy disagree) | `ecology.state-matches-policy@1` |
| `precondition-failed` | `payload.objectId` (offer) or `payload.toObjectId` (transfer) into a perishable holder that holds food | `resource.perishable-single-batch@1` |
| `invariant-violated` | the same `state.ecology...` paths | `ecology.state-matches-policy@1` (a post-state invariant for every command) |
| `invalid-input` | `payload.maxEvents` (a group cannot fit an empty budget) | - |

**Deferred.** To Wave 8 RW-0804 ("Environment and ecology depth"; Wave 8 §7.2 and the parent plan
§7.8 Food, Water and Growth rows): depleted, available and unavailable events;
growth death and plant removal; eating or harvesting plants beyond ordinary transfers of declared stage yields; moisture- or temperature-dependent decay;
freshness after food leaves a perishable holder and other food quality; seasons; random appearances and
weather. To Wave 8 RW-0803 ("Household and social routines"; Wave 8 §6, "competition or sharing over
limited resources"): ownership and sharing rules. To Wave 6 RW-0605: perception of the new events (none
is in `PERCEIVABLE_EVENT_TYPES`). No wave plan links appearances or weather to live external data.

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
transfers at and just after that epoch. Scheduled sources, fixture physical migration and the final
all-scenario closed-world proof remain later parts of issue 187. This part schedules processes
inside native advances and movement commands. The durable runtime currently plans autonomous wakes
from indexed schedule rows; bridging process cursors to that wake path remains required before a
process-only world can wake itself, or a process can wake ahead of the next actor decision.
