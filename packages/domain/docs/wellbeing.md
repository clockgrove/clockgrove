# Wellbeing policy and state (RW-0108a)

`WorldBehaviorPolicy.wellbeing` is an optional, versioned record (`WellbeingPolicy`, `schemaVersion: 1`)
that requires an `environment`: `thirstPerInterval`, `healthLossPerInterval` and
`healthRecoveryPerInterval` (integer basis points per decision interval, 0 to 10000) and `urgentHunger`,
`urgentThirst` and `criticalHealth` (integer basis points, 1 to 10000). `WorldState.wellbeing`
(`WellbeingState`) holds one entry per needs actor in object-id order, up to 128: `{objectId, thirst,
thirstRemainder, health, healthRemainder, comfort, integratedAt}`. It is present exactly when the policy
has one, and without it encodings and hashes are unchanged. `validateWellbeingPolicy` and
`validateWellbeingState` throw `WellbeingValidationError` (`policy.wellbeing...` / `state.wellbeing...`);
`wellbeingDisagreement(policy, state)` names the first differing path (entry count, object id,
`integratedAt` equal to the actor's `needs.integratedAt`, remainders below the decision interval, and the
comfort the needs derive) and `deriveComfort` is the single comfort rule: an actor is `uncomfortable`
with sorted causes `hungry` (hunger at or above `urgentHunger`), `thirsty` (thirst at or above
`urgentThirst`) and `wet` (wetness at or above the environment's `discomfortThreshold`).

Four events at version 1 are reduced by `reduceWorldEvent`, one reducer each: `wellbeing.integrated`
(replaces an entry's thirst, health, their remainders and `integratedAt`, which must move forward),
`needs.threshold-crossed` (`{objectId, need: "hunger" | "thirst", value}`) and `health.threshold-crossed`
(`{objectId, threshold: "critical", direction: "entered" | "left", health}`) change no physical field,
and `comfort.changed` (`{objectId, comfort, causes}`) sets the entry's comfort. The kernel owns the
systems that emit them.
