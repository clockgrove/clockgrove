# Ecology policy and state (RW-0107b)

`WorldBehaviorPolicy.ecology` is an optional, versioned record (`EcologyPolicy`, `schemaVersion: 1`)
that requires an `environment`: up to 64 each of `perishables` (`{objectId, shelfLifeMs}`; food holders) and `plants`
(`{objectId, growingLightBands, stages}` with 2 to 16 stages `{name, thresholdMs}`, the first at 0 and
the rest strictly increasing). `WorldState.ecology` (`EcologyState`) holds each perishable's
`arrivedAt` (`null` when empty) and each plant's `stage`, `growingMs`, `wetness`, `wetnessRemainder`
and `integratedAt`; it is present exactly when the policy has one, and without it encodings and hashes
are unchanged. `validateEcologyPolicy` and `validateEcologyState` throw `EcologyValidationError`
(`policy.ecology...` / `state.ecology...`); `ecologyDisagreement(policy, state)` names the first
differing path.

Current ecology events at version 1 are reduced by `reduceWorldEvent`: `resource.spoiled` (removes a holder's food), `growth.stage-changed` and
`growth.integrated`, and `resource.weather-integrated` (collects and evaporates water while
recording fractional integration state). The transfer, consume and retire reducers keep perishable arrival times. Legacy appearance and offer
reducers remain available for historical replay; new execution cannot emit them.
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
Plants remain separate from perishable holders; ordinary resource transfers can move
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
also be a plant.

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
representation and behavior. Scheduled sources are not part of the ecology contract.

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
ordering, event budgets and the native process proofs. Durable runtime wake planning includes the
earliest non-null process cursor, even without actors; PostgreSQL derives that deadline from the
canonical state rather than adding process commands to the actor schedule queue.

## Closed-world resource causes

Genesis quantities are declared initial inventory. Every later increase in a food or water holder
requires a journaled rain collection, finite plant-stage yield, or ordinary transfer debiting an
existing holder. Actors and processes use the same transfer validation; no declared principal
can bypass finite availability, destination bounds or perishable batch checks. Spoilage,
evaporation, consumption and explicit discard remain journaled removals.

The ecology policy has no `sources` field. A legacy source declaration is refused during pack
validation, including an empty list; it is not silently ignored. Runtime `resource.offer` and
`object.create` with a positive resource quantity cannot create material. Rule declarations cannot
introduce those unbacked causes either. Create an empty holder and transfer existing inventory,
or declare weather collection or plant yield. The journal's transfer source, growth plant/stage
and weather holder identify the physical cause; command attribution identifies the actor or
declared process. Historical event reduction does not grant new execution authority.
