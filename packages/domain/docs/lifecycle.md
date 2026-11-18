# Lifecycle policy and state (RW-0109)

`WorldBehaviorPolicy.lifecycle` is an optional, versioned record (`LifecyclePolicy`) that requires `wellbeing`. What
an actor follows is a `LifecycleKind`: `stages` (2 to 16 `{name, startsAtAgeMs}` with a first start of `0n`, strictly
increasing starts and unique names), `lifespanMs` (greater than the last stage start, at most 2^53), `deathHealth`
(integer 0 to 10000, below `wellbeing.criticalHealth`), `reproduction` (`fertileStages`, `conceptionIntervalMs`,
`conceptionChance` in basis points, `coParent` `"required" | "none"`, `gestationMs`, `gestationMilestones`
strictly between 0 and `gestationMs`, `cooldownMs`, `maxPopulation` 1 to 128), an optional `seasonal` hook
(`schemaVersion` 1, `yearLengthMs`, `seasons` starting at `0n`, `conceptionSeasons`) and `successorRule`
(`null` or a name). Durations are bigints. `schemaVersion: 1` is the record itself and applies to every Needs actor.
`schemaVersion: 2` is `{kinds}`: 1 to 16 kinds, each a `LifecycleKind` plus `archetypes`, a non-empty list of unique
pinned archetype ids (`id@version`, the `WorldEntity.archetypeId`), none in two kinds. `lifecycleForKind(policy,
archetypeId)` returns the kind an archetype follows, or `undefined`: an actor whose archetype is in no kind keeps its
lifecycle entry, frozen at stage 0, and neither ages, dies through the lifecycle, gestates nor conceives.
`WorldState.lifecycle` (`LifecycleState`) is optional and present
exactly when the policy has `lifecycle`: `{households, entries}` with one entry per Needs actor sorted by object
id, each `{objectId, householdId, parentIds, generation, bornAt, stageIndex, conceptions, lastBirthAt,
gestation, death}`. Without them, encodings and hashes are unchanged; `decodeWorldScenario` accepts both as
optional and sorts entries and households. An optional `lineage` (issue 358) holds the dead that left the counted
state: 1 to `LIFECYCLE_MAX_LINEAGE` (1,024) entries sorted by object id, each an entry with its `archetypeId`, a
`death` and no `gestation`. It is absent until the first move, so earlier states keep their bytes; the scenario
decoder does not accept it, since only births produce it.

`validateLifecyclePolicy(value, wellbeing, path?)` and `validateLifecycleState(value, path?)` throw
`LifecycleValidationError` (`policy.lifecycle...` / `state.lifecycle...`). Four helpers (and `lifecycleForKind`) are pure:
`lifecycleDisagreement(policy, state)` names the first path where the state and policy disagree (presence,
actors one-for-one, stage index, parents, household, death against Lifecycle status);
`deriveLifecycleStage(kind, bornAt, atTime)` returns the stage index reached at that time;
`resolveLifecycleLinks(state, objectId)` resolves an object's entry, parent entries and household members from
`entries` and the lineage, living or dead, and its entity while it has one; `findLifecycleLife(lifecycle, objectId)`
finds an entry in either; `deriveLifecycleSeason` is the seasonal counterpart. `removableLifecycleDead(state)` lists
the dead (a death record and Lifecycle status `dead`) whose object id nothing else in the state names, outside their
own entity, wellbeing entry and the lifecycle record; `moveDeadToLineage(state)` moves exactly those out of
`entities`, wellbeing and `entries` into the lineage, then drops the earliest dead of the earlier lineage that no
entry names as a parent or gestating co-parent until the lineage fits.

Six events at version 1 are reduced by `reduceWorldEvent`, one reducer each: `lifecycle.conceived`
(`{objectId, coParentId, childId, dueAt}`) starts a gestation, `lifecycle.gestation-milestone`
(`{objectId, childId, milestoneIndex, milestoneName}`) advances it, `lifecycle.born`
(`{childId, gestatingParentId, coParentId}`) first applies `moveDeadToLineage` when the record or the
entities hold 128 or more, then adds the child entity (with the gestating parent's archetype, so its kind), wellbeing entry and lifecycle entry and
clears the gestation, `lifecycle.stage-changed` (`{objectId, stageIndex, stageName}`) sets the stage,
`lifecycle.died` (`{objectId, cause, health}`) sets Lifecycle status `dead`, records the death and clears any
gestation, and `lifecycle.successor-intended` (`{objectId, successorId, rule}`) changes nothing. The kernel
owns the systems, ids and checks that use them.
