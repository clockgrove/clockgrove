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

Four events at version 1 are reduced by `reduceWorldEvent`: `resource.appeared` (adds a source's
quantity), `resource.spoiled` (removes a holder's food), `growth.stage-changed` and
`growth.integrated`. The offer, transfer, consume and retire reducers keep perishable arrival times.
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
