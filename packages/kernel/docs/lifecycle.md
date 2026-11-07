# Lifecycle: reproduction, aging and death (RW-0109)

An optional, versioned lifecycle layer on top of needs, comfort and health. It is active exactly when
`policy.lifecycle` is present, which also requires `policy.wellbeing`. The domain types and validators live
in `packages/domain/src/lifecycle/` (see [the domain README](../../domain/docs/lifecycle.md)); the kernel owns the systems, events and checks.

**Policy and state.** `LifecyclePolicy` (`schemaVersion` 1) holds `stages` (2 to 16 named stages whose
`startsAtAgeMs` start at `0n` and strictly increase), `lifespanMs` (above the last stage start, at most 2^53),
`deathHealth` (0 to 10000 and below `wellbeing.criticalHealth`), `reproduction` (`fertileStages`,
`conceptionIntervalMs`, `conceptionChance` in basis points, `coParent` `required` or `none`, `gestationMs`,
`gestationMilestones` strictly between 0 and `gestationMs`, `cooldownMs`, `maxPopulation` 1 to 128), an optional
`seasonal` hook (`yearLengthMs`, `seasons`, `conceptionSeasons`) and `successorRule` (`null` or a name).
`LifecycleState` is `state.lifecycle`: `households` and one `entries[i]` per Needs actor (sorted by object id),
each with `bornAt`, `stageIndex`, `householdId`, `parentIds`, `generation`, `gestation`, `conceptions`,
`lastBirthAt` and `death`. All times are bigint `SimTimeMs`; there is no floating-point arithmetic. The input
order of entities, entries and households does not matter: they are sorted on decoding.

**Events** (all version 1, one reducer each, owner `clockgrove.world`, allowed by
`resource.event-authority.<world command>@1` for the world commands):

| Event | Payload |
| --- | --- |
| `lifecycle.conceived` | `{objectId, coParentId, childId, dueAt}`; `randomDraws` holds the conception draw |
| `lifecycle.gestation-milestone` | `{objectId, childId, milestoneIndex, milestoneName}` at `conceivedAt + atMs` |
| `lifecycle.born` | `{childId, gestatingParentId, coParentId}` at `dueAt`; adds the child entity (active Lifecycle, the parent's space, archetype and pose, zero needs integrated at the birth time), a wellbeing entry and a lifecycle entry |
| `lifecycle.stage-changed` | `{objectId, stageIndex, stageName}` at `bornAt + startsAtAgeMs`, one per stage in index order |
| `lifecycle.died` | `{objectId, cause: "health" \| "lifespan", health}`; sets Lifecycle status `dead`, records `death: {diedAt, cause}` and clears any gestation |
| `lifecycle.successor-intended` | `{objectId, successorId, rule}` immediately after each death when `successorRule` is not `null` |

**Systems.** Conception is attempted at every positive multiple of `conceptionIntervalMs` (anchored at time 0)
for each living actor in object-id order. The first applicable exclusion wins, in this order:
`not-fertile-stage`, `gestating`, `cooldown`, `out-of-season`, `no-co-parent`, `population-cap`. An excluded
candidate draws nothing; every other candidate draws exactly one value from the `lifecycle` stream and conceives
exactly when `BigInt.asUintN(32, rawValue) % 10000n < BigInt(conceptionChance)`. Every attempt is a
`lifecycle.conception` decision draft recording the candidate, its exclusion or draw and the outcome. Health
death happens at the first millisecond health is at or below `deathHealth`; lifespan death at
`bornAt + lifespanMs`; when both coincide the cause is `health`. A death cancels the actor's `world.decision`
schedule item, interrupts an active movement (`movement.interrupted` immediately before `lifecycle.died`) and
removes the actor from every later system. Each birth upserts the child's `world.decision` item due at
`bornAt + decisionIntervalMs`. The dead stay in `state.entities` with unchanged `objectId` and `archetypeId`
and their lifecycle entry is kept. Only the `lifecycle` stream advances; without `policy.lifecycle` the returned
random state equals the input.

**Ids.** `lifecycleChildId(gestatingParentId, ordinal)`, `lifecycleScheduleId(childId)` and
`lifecycleSuccessorId(predecessorId, rule)` are pure functions of their arguments, independent of the command id,
step shape, chaining and runtime. `requestSuccessorIntent(state, policy, deceasedId)` returns a frozen
`{schemaVersion: 1, kind: "lifecycle.successor", predecessorId, successorId, rule}` or a frozen `{code, path}`
refusal (never a throw) for a living actor, an unknown id or a `null` rule. A successor id never names an entity.

**Same-time order.** Health crossings (RW-0108b order), then `lifecycle.died` (each followed by its
`lifecycle.successor-intended`), `lifecycle.stage-changed`, `lifecycle.gestation-milestone`, `lifecycle.born` and
`lifecycle.conceived` (each kind in object-id order), then routine region crossings, arrivals and decisions.

**`maxEvents` group sizes.** A lifecycle time group is atomic: its size is one event per lifecycle action, plus
one per death for the successor intent, plus, for an actor with an active movement, its pending crossings and one
`movement.interrupted`. A group that does not fit is not emitted and the stopped call rolls back the `lifecycle`
stream with it; an empty budget that cannot fit one group is refused at `payload.maxEvents`. Chained bounded calls
emit each `lifecycle.born` exactly once and equal one unbounded call.

**Continuation identity.** A continuation's input identity covers every named random stream, including
`lifecycle`. A stopped call records it over its kept random state, the `updatedRandomState` after unemitted
lifecycle groups are rolled back, so only a continuation presenting exactly that lifecycle position is accepted;
a re-rolled or advanced stream is refused (`invalid-input` at `continuation`). No committed golden changed because
identity bytes changed: the lifecycle goldens hash material events, final state and stream summaries, not
continuation identities, and packs without `policy.lifecycle` keep identical identity bytes.

**Event-volume bound.** Lifecycle adds no per-step event. For `calls` kernel calls, `D` routine decisions (at
most one per living actor per decision interval, counted from the traces) and `M` material lifecycle events, a
long run emits at most `calls + 4 * D + 2 * M` events. Living population never exceeds `maxPopulation`, so `D`
is bounded by living actors times decision intervals. Since issue 629 only a material decision journals events (see
[utility decisions](utility-decisions.md)), so the bound is far from tight when routines repeat.

**Refusals** (frozen, returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.lifecycle` or a field below it (null, non-record, missing, extra or wrong-typed field, unknown `schemaVersion`, no `wellbeing`, a number where a bigint is required, stage count outside 2 to 16, first stage not `0n`, stages not increasing or duplicated, `lifespanMs` too small or above 2^53, `deathHealth` out of range or not below `criticalHealth`, `conceptionChance` outside 0 to 10000 or non-integer, `maxPopulation` outside 1 to 128, empty or unknown `fertileStages`, milestones at `0n` or `gestationMs`, bad `coParent`, bad seasonal hook, bad `successorRule`) | - |
| `invalid-input` | `partition.state.lifecycle` or a field below it (null, missing, extra or wrong-typed field, entries out of order or duplicated) | - |
| `invalid-input` | `randomState.lifecycle` (a lifecycle policy without the stream) | - |
| `invalid-input` | `continuation` (a continuation whose lifecycle stream position differs from the recorded one) | - |
| `invalid-input` | `input.scheduled.scheduleId` (a scheduled decision of a dead actor) | - |
| `precondition-failed` | `state.lifecycle`, `state.lifecycle.entries`, `.entries[i].stageIndex`, `.parentIds`, `.householdId`, `.death` | `lifecycle.state-matches-policy@1` |
| `invariant-violated` | the same paths (a post-state invariant for every command) | `lifecycle.state-matches-policy@1` |
| `invariant-violated` | `state.entities[i]` (a result changes a dead entity) | `object.lifecycle@1` |
| `invariant-violated` | `events[i].payload.successorId` (a successor id names an entity) | `lifecycle.successor-distinct@1` |
| `reducer-failed` | `events[i]` (a birth onto a state that already has the child) | - |

**Evidence.** Targeted exact-time tests with one-millisecond-earlier negatives, the `material-lifecycle`
equivalence with the pairs `live-steps-vs-fast-forward`, `bounded-continuation-vs-unbounded`,
`single-season-vs-no-hook` and `weather-perturbed-vs-baseline`, the test-owned `household-generations` golden
(committed material-event and final-state hash literals) and the long runs `lifecycle-30-day` and
`lifecycle-one-year` (30 and 365 environment days, committed population, lifecycle and resource summary hashes),
all in `mode: "test"`, in Node and Workers. `fullRuntimeEvidence` adds a `lifecycle` section, written only to
`lifecycle.json` (summaries and hashes for long runs, never per-call event lists; see
[Evidence report files](evidence.md#evidence-report-files)). Each run entry also records its `finalProjection` (final
time, entities with archetype and lifecycle status, households and every lifecycle entry) and each
`conception` tuple ends with the candidate's decision features `[stageIndex, stageName, conceptionChance]`.
The fixture stages are `newborn`, `juvenile`, `adult` and `elder`.

**Unchanged.** Outputs without `policy.lifecycle` are byte-identical; the `rain-shelter-comfort`,
`food-decay-and-conservation`, `cedar-growth`, `comfort-and-health` and `favorite-snack-house` golden hashes were
unchanged by this layer (issue 629 later moved their material-event hashes; see [utility decisions](utility-decisions.md)). `PERCEIVABLE_EVENT_TYPES`, the command and scheduled identities, the catalog and
`examples/world-packs/` are untouched; Lifecycle component version 1 is unchanged.

**Deferred.** To Wave 8 RW-0802 ("Lifecycle product UX"; Wave 8 §5.1): instantiating a successor (the intent
only records an id) and mating choice. To Wave 8 RW-0803 ("differentiated schedules/needs"): age-dependent
needs. To Wave 8 RW-0804 ("Environment and ecology depth", with the population envelopes of Wave 8 §7.3):
population dynamics beyond the cap and seasonal effects other than the conception gate. To Wave 6 RW-0605: perception of lifecycle events (none is in
`PERCEIVABLE_EVENT_TYPES`).

**Not planned.** Inheritance of traits and genetics: Wave 1 §12 excludes genetic simulation, and the parent
plan §7.8 says reproduction "is not a genetic simulator".
