# Ecology policy and state (RW-0107b)

`WorldBehaviorPolicy.ecology` is an optional, versioned record (`EcologyPolicy`, `schemaVersion: 1`)
that requires an `environment`: up to 64 each of `sources` (`{objectId, kind: "food" | "water",
firstAtMs, periodMs, quantity}`), `perishables` (`{objectId, shelfLifeMs}`; food holders) and `plants`
(`{objectId, growingLightBands, stages}` with 2 to 16 stages `{name, thresholdMs}`, the first at 0 and
the rest strictly increasing). `WorldState.ecology` (`EcologyState`) holds each perishable's
`arrivedAt` (`null` when empty) and each plant's `stage`, `growingMs`, `wetness`, `wetnessRemainder`
and `integratedAt`; it is present exactly when the policy has one, and without it encodings and hashes
are unchanged. `validateEcologyPolicy` and `validateEcologyState` throw `EcologyValidationError`
(`policy.ecology...` / `state.ecology...`); `ecologyDisagreement(policy, state)` names the first
differing path.

Five events at version 1 are reduced by `reduceWorldEvent`: `resource.appeared` (adds a source's
quantity), `resource.spoiled` (removes a holder's food), `growth.stage-changed` and
`growth.integrated`, and `resource.weather-integrated` (collects and evaporates water while
recording fractional integration state). The offer, transfer, consume and retire reducers keep perishable arrival times.
`foodFreshnessBasisPoints(holder, now)` returns `floor(10000 × remaining shelf life / shelf life)`
(0 at `arrivedAt + shelfLifeMs`, `null` for an empty holder) and `resourceAvailability(resource)`
returns `"available"` for a positive quantity and `"unavailable"` otherwise.

## Finite plant yield

A noninitial plant stage may declare `yield: { quantity }`. The quantity is a positive safe
integer of food, produced once when growth enters that stage, in the plant's own `food` resource
holder. The initial stage cannot yield; a plant's total declared yield must fit the safe-integer
material range. A yielding plant requires a food resource holder, and its current inventory plus
all remaining stage yields must fit that range (`ecologyDisagreement` returns the plant's policy
object path for a missing/incompatible holder, or its state stage path for insufficient headroom).
Plants remain separate from source and perishable holders; ordinary resource transfers can move
their food to a perishable holder.

The existing `growth.stage-changed@1` event carries optional `yield: { quantity }` alongside its
plant `objectId`, `stageIndex` and `stageName`. The reducer increases that plant's food quantity
atomically with the stage change, rejects unsafe amounts and requires a yield-bearing transition
to enter the next stage. Historic events and policies without yield retain their representation.
The event is the food's cause: growth, rather than a timer refill or an external offer. The last
stage never repeats, so waiting longer or emptying the plant never creates another yield.


## Weather water holders

The optional `waterHolders` list in `EcologyPolicy` declares up to 64 collectors as
`{objectId, capacity, catchment, evaporationPerHour}`. Capacity is a positive safe integer;
catchment and evaporation are nonnegative safe integer water units per hour. Catchment is measured at
rain intensity 10000 with shelter protection 0. Collection scales by rain intensity and by
`10000 - protection`, each in basis points. A zero catchment collects nothing; declaring a
positive catchment models an open collector. The holder must have a water resource and cannot
also be a scheduled source or a plant.

The matching optional `EcologyState.waterHolders` list follows policy order (including an explicit
empty list when the policy declares one) and records
`{objectId, collectionRemainder, evaporationRemainder, integratedAt}`. Remainders and integration
time are bigints. Integer arithmetic retains fractional collection and evaporation between
commands. Collection cannot exceed capacity: overflow and its fractional collection remainder
are discarded at full capacity. Evaporation removes existing water only and clears its remainder
at empty, so an empty holder accrues no future evaporation debt. Collection precedes evaporation
when both become due at the same millisecond. Ordinary commands can move or consume this water.

`resource.weather-integrated@1` carries `{objectId, collected, evaporated, collectionRemainder,
evaporationRemainder, integratedAt}` and atomically applies the quantity changes and integration
state. Weather is the journaled cause of collection; evaporation is a journaled removal. Initial
genesis quantities are the initial inventory. Policies without `waterHolders` retain their
representation and behavior. Scheduled sources remain supported temporarily while issue 187
migrates fixture policies and removes sources; additive weather and process causes alone do not establish the
complete closed-world contract.

Weather-holder `integratedAt` must equal the world simulation time, including after a bounded
advance. Ordinary commands therefore change inventory only after all prior weather is accounted.

## Declared process inventory causes

Optional world-level `policy.processes` describes scheduled off-screen principals. Each process has
an id, `principalId`, positive bigint `firstAtMs` and `periodMs` (at most 2^53), and an ordinary
`resource.transfer` command with its version-1 payload. Lists hold at most 64 entries; ids are unique
and share the command object-id text bound. Matching optional `state.processes` entries hold
`{processId, nextAt}` in policy order. Genesis chooses the first cadence instant at or after its epoch.

`process.command-attempted@1` advances that cursor, recording the ordinary command identity and
its refusal or success. Success journals the ordinary transfer, debiting existing inventory; failure
changes no quantities. The kernel validates these occurrences with the ordinary command path and
attributes them to the declared principal. See [kernel ecology](../../kernel/docs/ecology.md) for
ordering, event budgets and the native process proofs. This additive cause does not yet remove
scheduled sources or establish the final closed-world policy restriction.
