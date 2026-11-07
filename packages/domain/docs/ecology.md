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
