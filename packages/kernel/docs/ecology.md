# Resources and growth: food, water, spoilage and cedar growth (RW-0107b)

**Policy and state.** `policy.ecology` (optional, requires `environment`) declares resource
`sources`, `perishables` (food holders with a shelf life) and `plants` (growing light bands and
stages); `state.ecology` tracks each perishable's arrival time and each plant's stage, growing time,
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
changes. `resource.quantity-conservation@1` counts `appeared` as an addition and `spoiled` as a removal
only. The same invariant also balances each holder and resource kind independently against
creation, retirement, offer, transfer, consumption, appearance and spoilage events. A transfer must
debit its source and credit its destination by the journaled quantity; a globally balanced but
unjournaled movement, or a swap of resource kinds between holders, is refused at the affected
holder's `state.entities[i].resource.quantity` path. Genesis quantities are the initial inventory.
This accounting preserves the existing cause kinds; removal of scheduled appearances and the
closed-world policy migration are separate changes.
`resource.event-authority.<world command>@1` allows the four events for the world commands.
`growth.integrated` is incidental: it is emitted wherever `needs.changed` is, so its count depends on
step boundaries.

**Systems.** `world.advance` registers one spoilage system per perishable holder, one appearance
system per source and one growth system per plant through `createCatchUpRegistry`, in the same
`catchUpSchedules` calls as the environment systems. No random stream is drawn. Same-time order:
phase, weather, exposure, spoilage, appearance, stage change, decision, each kind in object-id order.
Time groups are indivisible, so `maxEvents` and continuation behave as for the environment ([see the
bound above in Budgets and continuation](environment.md)), and re-advancing to the same time emits nothing.

**Food and water.** A source places its quantity into its holder (itself) at `firstAtMs + n × periodMs`
only when the holder is empty after any spoilage at that instant; a skipped appearance is not
queued. The holder at that instant includes every change before it in the same call: a decision or
arrival that consumes from a holder re-seeds that holder's spoilage and appearance schedule at its
time, so a source drunk dry inside one `world.advance` appears at its next due time in that call, as
it does across live steps. Perishable food spoils entirely `shelfLifeMs` after it arrived (a transfer from a perishable
keeps the arrival time); consuming to zero clears the arrival. Water does not spoil and rain does not
change it. A perishable holder holds a single batch: `resource.offer` or `resource.transfer` into one
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

**Evidence.** Generated tests (named stream `behavior`, seed `ecology-resources-v1`), targeted tests,
the `material-ecology` pairs `live-steps-vs-fast-forward` and `bounded-continuation-vs-unbounded`, and
the `food-decay-and-conservation` and `cedar-growth` goldens (committed literal hashes) run in Node
and Workers. `fullRuntimeEvidence` adds an `ecology` section; `ecology.json` holds the Node and Workers
bodies and a `comparison` summary, validated by `test/spatial-evidence.ts` (see
[Evidence report files](evidence.md#evidence-report-files)). `identity.events` grows by
exactly the four events; commands, `PERCEIVABLE_EVENT_TYPES`, `examples/world-packs`, the scheduler,
needs arithmetic and the component catalog are unchanged. Outputs for states without `ecology`
(containment and resource command outputs included) are unchanged, and `resource.consume` emits no
new event. Input hashes reuse `containmentInputIdentity`.

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
§7.8 Food, Water and Growth rows): depleted, available and unavailable events; rain refilling water;
growth death and plant removal; eating or harvesting plants; moisture- or temperature-dependent decay;
freshness after food leaves a perishable holder and other food quality; seasons; random appearances and
weather. To Wave 8 RW-0803 ("Household and social routines"; Wave 8 §6, "competition or sharing over
limited resources"): ownership and sharing rules. To Wave 6 RW-0605: perception of the new events (none
is in `PERCEIVABLE_EVENT_TYPES`). No wave plan links appearances or weather to live external data.
