# Lifecycle policy and state (RW-0109)

`WorldBehaviorPolicy.lifecycle` is an optional, versioned record (`LifecyclePolicy`, `schemaVersion: 1`) that
requires `wellbeing`: `stages` (2 to 16 `{name, startsAtAgeMs}` with a first start of `0n`, strictly increasing
starts and unique names), `lifespanMs` (greater than the last stage start, at most 2^53), `deathHealth` (integer
0 to 10000, below `wellbeing.criticalHealth`), `reproduction` (`fertileStages`, `conceptionIntervalMs`,
`conceptionChance` in basis points, `coParent` `"required" | "none"`, `gestationMs`, `gestationMilestones`
strictly between 0 and `gestationMs`, `cooldownMs`, `maxPopulation` 1 to 128), an optional `seasonal` hook
(`schemaVersion` 1, `yearLengthMs`, `seasons` starting at `0n`, `conceptionSeasons`) and `successorRule`
(`null` or a name). Durations are bigints. `WorldState.lifecycle` (`LifecycleState`) is optional and present
exactly when the policy has `lifecycle`: `{households, entries}` with one entry per Needs actor sorted by object
id, each `{objectId, householdId, parentIds, generation, bornAt, stageIndex, conceptions, lastBirthAt,
gestation, death}`. Without them, encodings and hashes are unchanged; `decodeWorldScenario` accepts both as
optional and sorts entries and households.

`validateLifecyclePolicy(value, wellbeing, path?)` and `validateLifecycleState(value, path?)` throw
`LifecycleValidationError` (`policy.lifecycle...` / `state.lifecycle...`). Four helpers are pure:
`lifecycleDisagreement(policy, state)` names the first path where the state and policy disagree (presence,
actors one-for-one, stage index, parents, household, death against Lifecycle status);
`deriveLifecycleStage(policy, bornAt, atTime)` returns the stage index reached at that time;
`resolveLifecycleLinks(state, objectId)` resolves an object's entity, entry, parent entities and household
members, living or dead; `deriveLifecycleSeason` is the seasonal counterpart.

Six events at version 1 are reduced by `reduceWorldEvent`, one reducer each: `lifecycle.conceived`
(`{objectId, coParentId, childId, dueAt}`) starts a gestation, `lifecycle.gestation-milestone`
(`{objectId, childId, milestoneIndex, milestoneName}`) advances it, `lifecycle.born`
(`{childId, gestatingParentId, coParentId}`) adds the child entity, wellbeing entry and lifecycle entry and
clears the gestation, `lifecycle.stage-changed` (`{objectId, stageIndex, stageName}`) sets the stage,
`lifecycle.died` (`{objectId, cause, health}`) sets Lifecycle status `dead`, records the death and clears any
gestation, and `lifecycle.successor-intended` (`{objectId, successorId, rule}`) changes nothing. The kernel
owns the systems, ids and checks that use them.
