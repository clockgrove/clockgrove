# Utility decisions and movement choice (RW-0108b)

**Policy and scripted records.** `policy.utility` (optional, requires `wellbeing`; see [the domain
package README](../../domain/docs/utility.md)) is `schemaVersion: 1`, `scorer: "clockgrove.routine-utility"`, `scorerVersion: 1`,
`thirstWeight`, `expectationWeight`, `travelWeight` (basis points, 0 to 10000), `unitsPerSecond`
(positive fixed-point bigint), `perceptionRange` (nonnegative fixed-point bigint), `biteQuantity`
(positive safe integer) and `hungerReliefPerUnit`, `thirstReliefPerUnit` (1 to 10000). `state.scriptedCognition`
(optional, requires `utility`) is `{schemaVersion: 1, source: "scripted", entries}` with at most 64
entries sorted by unique `ref` (prefix `scripted:`): `kind` (`belief` or `memory`), `actorId` (a needs
actor), `targetObjectId` (an active food or water holder or shelter), `value` (0 to 10000) and
`effectiveAt`. Every entry is scripted, not observed; the record is marked `source: "scripted"`. Absent
records keep their encodings and hashes.

**Attributed evidence.** A `belief` entry may carry `attributedTo` (the object id of another needs actor the
evidence came from; refused for `memory`, for the entry's own actor and for non-ids, and named by the
disagreement check when unknown or without needs). Scoring counts such an entry only when `effectiveAt` is at
or before the decision time and the attributing actor had not died before `effectiveAt` (lifecycle
`death.diedAt`): `effectiveAt == diedAt` is effective, `effectiveAt > diedAt` is never effective at any later
decision. An entry effective at or before the death keeps contributing afterwards; its ref stays in
`beliefRefs` and the state keeps the attribution. Without lifecycle state nobody dies. The rule reads only
state, so live steps and one fast-forward decide identically. Session, private-memory, relationship and
knowledge-access policy at death is built by Wave 8 RW-0802 (Wave 8 §5.1, "Death").

**Registry, features and scoring.** Under a `utility` policy every due decision uses the versioned
registry (`stay@1`, `seek-food@1`, `seek-water@1`, `seek-shelter@1`, scorer `clockgrove.routine-utility@1`)
instead of `chooseRoutine`. Candidates are `stay`, then one seek per active food holder, water holder and
shelter, in object-id order. Features are bigints: `hunger`, `thirst`, `wetness`, `rain`, `health`,
`uncomfortable` (10000 or 0) and `U` (10000 when comfortable, else `20000 - health`); a seek adds `travelMs`,
`perceived` (10000 or 0) and `expectation` (the sum of the effective scripted values for the actor and target,
capped at 10000); food adds `freshness`, shelter `protection`. Score: stay 0; a seek scores
`need*U/10000 + expectation*expectationWeight - travelMs*travelWeight*10000/decisionIntervalMs`, floor
division, with `need` `hunger*hungerWeight*freshness/10000` for food, `thirst*thirstWeight` for water and
`(wetness+rain)*protection*shelterWeight/10000` for shelter. A candidate is excluded for the first applicable
of `outside-current-space-or-frame`, `not-perceived` (not within `perceptionRange` and no effective scripted
entry), `unavailable` (quantity 0), `no-rain-protection` and `unreachable` (no plan). The reflex (wetness at
least 9000 limits the pool to eligible shelters) and the `actionKey` tie order are preserved. No random
stream is drawn. `seek-water` is a new action kind and requires a target; `seek-food` may carry its target.

**Trace.** The `DecisionTrace` keeps its shape: `policyVersion` is `<policy.version>/clockgrove.routine-utility@1`,
every candidate carries features, score and exclusion, `perceptionRefs` are `perceived:<objectId>@<time>`,
`beliefRefs` and `memoryRefs` are the sorted effective scripted refs, `randomDraws` is empty and
`outcomeLinks` are `plan:<objectId>@<time>` and the movement id when a plan starts, replans or completes at once.

**Planning requests.** Routine choice order is reflex, then utility scoring, then a planning request
only for policy-declared ambiguity or novelty (Wave 1 plan §5.7). Under `policy.utility.ambiguity` (see
[the domain contract](../../domain/docs/utility.md#ambiguity-declaration)) every dispatched `utility`-tier
decision is checked after its trace is final; a `reflex` decision never is. The declared conditions are tried
in kind order and the first that holds is recorded: `score-margin` when at least two candidates are eligible
and the best score minus the second best (in selection order) is at most `maxMargin`; `unperceived-target`
when the selected action is a seek whose target's `perceived` feature is 0, so the choice rests on scripted
evidence alone. The decision then pushes a second decision draft, kind `planning-request`, directly after its
`routine` draft, with the decision `{schemaVersion: 1, requestId, status: "recorded", objectId,
simulationTime, commandId, policyVersion, ambiguityVersion: 1, condition, candidates, fallbackAction}`:
`commandId` is the dispatched `world.decision` command of the trace it belongs to and `requestId` is
`planning_<fnv1a64>` of `["clockgrove-planning-request-v1", commandId]`, so it derives from the schedule
identity only; `policyVersion` is the trace's; `condition` is `{kind: "score-margin", maxMargin, margin}` or
`{kind: "unperceived-target", targetObjectId}`; `candidates` are the trace's eligible candidates in trace
order with their fixed-point features and scores; `fallbackAction` is the trace's `selectedAction`. The
request is data: the same call has already selected, journaled and planned the fallback, it draws no random
number and emits no event, schedule or state change, and no `inputRevision` or wall-clock value is in it, so
live steps and one fast-forward record identical requests. Like a routine draft it is always kept, also when a
stopped call's state time lies before it. Nothing in Wave 1 executes, dispatches or consumes it; the Wave 5
`ActorAgentDO` model-escalation path is its consumer (Wave 5 plan: policy checks and compiled routines run
before model escalation). Without the declaration no request is ever produced and outputs are byte-identical.
`WorldKernelResult.decisionDrafts` keeps its declared `DecisionDraft<DecisionTrace>` type; readers select by
`kind` (the application keeps only `routine` drafts as receipt evidence). Evidence: `green-lake-yard@1` opts
in. Its committed `cedar-growth` scenario compares small-step with aggregate progression: the live run
(12-hour steps) records Stevie's and the kit's `unperceived-target` requests in calls 2 and 6, the
fast-forward run records both in its one call 0, and the scenario pins each record literally in both runs
together with those call indexes. `street-dwell` pins Gracie's `score-margin` tie request literally in both
of its runs, which both reach it in their opening fast-forward step. The conformance suite reproduces these
bytes in Node and workerd. Opting in changed no raccoon golden's events, schedules, random state or final
state, only its artifact hashes and recorded decisions.
The malformed declarations are named refusal cases of the decisions evidence.

**Plans and arrival.** An actor already at the target's coordinates arrives immediately. Otherwise the
decision emits `location.changed` to null when the actor is located, then `movement.started` through
`planMovement` (anchor-at-target destination, else the target pose; `unitsPerSecond`; `movementIdFor` of the
dispatch command id). The same action continues silently, a different seek replans
(`movement.replanned`) and `stay` interrupts (`movement.interrupted`). `world.advance` registers one movement
system per moving actor and emits region crossings and `movement.completed` at the exact times, reusing
`expectedCrossings` and `movementCompletionTime`. `utility.plan-matches-action@1` is a precondition and a
post-state invariant of every command. Arrival effects: food and water take `q = min(biteQuantity, holder
quantity)`, emit `resource.consumed {objectId: holder, kind, quantity}` then `needs.relieved` with
`value = max(0, current - q*reliefPerUnit)`, and emit neither when `q` is 0; shelter emits `location.changed`
unless the actor is already there. Actors are integrated before a location change, later exposure, comfort and
health use the new protection, and relieved needs re-arm threshold crossings.

**Events** (version 1, one reducer each): `location.changed` (`{objectId, locationId | null, planId}`: sets
the actor's location) and `needs.relieved` (`{objectId, need, sourceObjectId, quantity, value, planId}`: sets the
need). `resource.event-authority.<world command>@1` allows the movement events, `resource.consumed` and both
new events. `identity.events` and `reducers` grow by two, `identity.utility` is new, and
`PERCEIVABLE_EVENT_TYPES` is unchanged.

**Material decisions.** Every due decision is scored, traced and rescheduled, with or without
`utility`, but it journals events only when it is material: it selects an action other than the actor's
`selectedAction` (a different kind or target, or the actor's first selection), or its plan emits an event (a
movement event, a location change or an arrival effect). A decision that repeats the actor's action with an
event-free plan (a silent continue, a stay without movement, or an immediate arrival with nothing to consume
or relocate) emits nothing: no `needs.changed`, `wellbeing.integrated`, `growth.integrated` or
`routine.selected`. Needs, wellbeing and plants are integrated by the next group, decision or final group
that journals them, and integration is independent of where it is split, so material events and the final state
are unchanged; only `revision` and the incidental integration events differ. The decision is made on the
actor's integrated view, so its trace equals the journaled case except for `inputRevision`, the revision of
the state it read. Its draft is kept even when a stopped call's state time lies before it, and a scheduled
`world.decision` that is unchanged is an idempotent no-op (zero events, one schedule upsert). It does not advance
`simulationTime`: state time moves only with a journaled event, so a projection (needs, wellbeing, plants) integrates
forward from its own `integratedAt` to the time it reads, never from the last decision. Wave 2 projection writers
rely on this.

**`routine.selected@2`.** The selection event is version 2: emitted once per material decision, with the same
payload `{objectId, action}` and reducer (sets `selectedAction`) as version 1, which was emitted for every
decision. Only version 2 is registered and reduced. A historic version 1 event is read through
`upcastWorldEvent` (domain), which sets `schemaVersion` to 2 and keeps everything else; `replayWorldEvents`
upcasts every event, so a version 1 stream replays to the state it once produced and, with `revision` set
aside, to the state the version 2 stream reaches (the committed `event-fixtures/routine-selected-v1-stream.json`
proves both). Rule evaluation reads events through the same upcast (`upcastEventRecord`, the one upcast table), so a trigger on `routine.selected@1` or `@2` matches both versions. Every other event keeps
version 1: `needs.changed`, `wellbeing.integrated` and `growth.integrated` keep their meaning (the integrated
values at their time) and were already emitted only when an integration was journaled. The change moved the
committed material-event hashes of the test-owned `rain-shelter-comfort`, `food-decay-and-conservation`,
`comfort-and-health`, `favorite-snack-house` and `household-generations` goldens (fewer selections); their
final-state and trace hashes are unchanged.

**Same-time order.** RW-0108a's order through health crossings, then routine region crossings, then arrivals in
object-id order (`movement.completed`, `location.changed`, `resource.consumed`, `needs.relieved`, then
`comfort.changed`), then decisions (`routine.selected`, `location.changed`, the movement event, then any
immediate arrival). Arrivals never bring a decision forward.

**`maxEvents`.** The exact minimum is unchanged by utility: `perActor*actors + plants + 1`, with `perActor` 2
(`needs.changed` and `wellbeing.integrated` per actor, utility requires wellbeing); a smaller value is
`invalid-input` at `payload.maxEvents`. Indivisible-group formulas, computed exactly before any event is
emitted. Decision group at time t for due actor a: 0 for an unchanged decision, else
`integrationEvents(a, t) + pendingPlants(t) + 1 + planEvents`.
`integrationEvents(a, t)` is 0 to `perActor` for the due actor only (`needs.changed` when its needs change, plus
`wellbeing.integrated` when its entry is not already integrated at t); `pendingPlants(t)` counts the active plants
not yet integrated at t (at most `plants`); the 1 is `routine.selected`; `planEvents` is the unlocate (1 when a seek
starts and the actor has a location, else 0) plus the movement event (1 for `movement.started`,
`movement.replanned` or `movement.interrupted`; 0 for a silent continue or a stay without movement) plus the
immediate-arrival events. Arrival or crossing group at time t: `RW-0108a group size + routineCrossings + the sum
over arriving actors b of (integrationEvents(b, t) when b is not already integrated in the group, else 0, plus 1 +
arrivalEvents(b))`, where the 1 is `movement.completed`; for a shelter `arrivalEvents(b)` is `location.changed`
(0 when already there); for food or water it is `resource.consumed` + `needs.relieved` + any `comfort.changed`
the relief causes, with consume and relieve both 0 when `q` is 0. Final group: unchanged
`perActor*actors + plants + 1`. New events count toward `maxEvents` in indivisible
groups with the existing continuation: a group or decision that cannot fit an empty command is `invalid-input` at
`payload.maxEvents`; otherwise the call stops before it with a continuation. The scheduled `world.decision`
contract is unchanged.

**Refusals** (frozen, returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.utility` or a field below it (null, wrong type, missing or extra field, unknown `schemaVersion`, `scorer` or `scorerVersion`, no `wellbeing`, a weight outside 0 to 10000 or non-integer, a non-positive `unitsPerSecond` or `biteQuantity`, a negative `perceptionRange`, a relief outside 1 to 10000, wrong types) | - |
| `invalid-input` | `pack.pack.policy.utility.ambiguity` or a field below it (not an object, missing or extra field, unknown `schemaVersion`, `conditions` empty, longer than the closed set or not a dense array; at `conditions[i].kind` an unknown kind or a kind out of order or repeated; at `conditions[i].maxMargin` a value that is not a bigint from 0 to `FIXED_POINT_LIMIT`; an extra field of a condition at its name) | - |
| `invalid-input` | `partition.state.scriptedCognition` or a field below it (null, wrong type, missing, extra or wrong-typed field, unknown `schemaVersion`, `source` other than `scripted`, more than 64 entries, `ref` without the `scripted:` prefix or out of order or duplicated, unsupported `kind`, value outside 0 to 10000, negative `effectiveAt`), the record without a `utility` policy, an `actorId` that is unknown, has no needs or is retired (an `actorId` whose actor has died is not refused: the entry no longer applies and is kept) and a `targetObjectId` that is not an active food or water holder or shelter | - |
| `precondition-failed` | `state.entities[i].movement` (an active movement disagrees with the selected action) | `utility.plan-matches-action@1` |
| `invariant-violated` | `state.entities[i].movement` | `utility.plan-matches-action@1` (a post-state invariant for every command) |
| `check-error` | `request.systems[i]` (a movement system throws) | `catch-up.system@1` |
| `handler-failed` | `handler` (a candidate or the scorer throws) | - |
| `reducer-failed` | `events[i]` | - |
| `invalid-input` | `payload.maxEvents` (a group or decision cannot fit an empty budget) | - |

**Unchanged.** Outputs without `utility` are byte-identical; the `rain-shelter-comfort`,
`food-decay-and-conservation`, `cedar-growth` and `comfort-and-health` golden hashes were unchanged by this layer
(issue 629 later moved material-event hashes), and
`integrateNeedsWith`, `chooseRoutine`, `scheduler/`, the movement reducers, the catalog and
`examples/world-packs/` are untouched.

**Evidence.** Seeded generated tests (named stream `behavior`, seed `decisions-utility-v1`), targeted
exact-time tests with one-millisecond-earlier negatives, the `material-decisions` class and its pairs
`live-steps-vs-fast-forward`, `bounded-continuation-vs-unbounded` and `scheduled-decisions-vs-advance`, and
the test-owned `favorite-snack-house` golden (committed material-event, trace and final-state hash literals)
run in Node and Workers. `material-decisions` compares the ordered material events by type, time and payload,
the ordered traces with `inputRevision` set aside and the final state with `revision` set aside. In the golden
the raccoon eats at the trash bin early; once the scripted memory and belief take effect, a hungry decision
picks the snack house despite longer travel and its trace links the `expectation` feature to the refs; a
control run without `scriptedCognition` picks the bin at that decision; thirst leads to the bowl; rain leads to
the den, where wetness stops rising; totals are conserved. `fullRuntimeEvidence` adds a `decisions` section,
written only to `decisions.json` (see [Evidence report files](evidence.md#evidence-report-files)). Every candidate's
exclusion reason (or its absence) is verified against world facts at decision time: movement planning
(`planMovement` with the anchor-at-target destination rule), distance against the perception range, shelter
rain protection and the first-applicable order, without reading the recorded features. Relief is verified by
exact `max(0, prior − quantity × reliefPerUnit)` arithmetic for hunger and thirst, with the prior need taken from
the start state reduced through the preceding events. A separate coverage generator (seed
`decisions-coverage-v1`, not part of `decisions.json`) proves each reason, eligible candidates and both reliefs
are exercised.

Death from health is built by the lifecycle layer ([lifecycle](lifecycle.md), cause `health`).

**Deferred.**

- Rest, safety, social and curiosity needs; injury; harvesting, ownership and contention: Wave 8 RW-0801
  (the parent plan §7.8 Needs, Food and Health/comfort rows) and RW-0803 ("Household and social routines";
  Wave 8 §6, "competition or sharing over limited resources").
- Danger, social-comfort and uncertainty features (parent plan §7.11): Wave 6 RW-0606 and RW-0607, which give
  beliefs and relationships their decision features.
- Executing planning requests (the request contract above is recorded only): the Wave 5 `ActorAgentDO`
  model escalation (Wave 5 §5.2, "Activation reasons", and RW-0503).
- Random draws: Wave 8 RW-0803 (Wave 8 §6: "named deterministic random streams produce diversity").
- Real cognition: Wave 6 RW-0605 and RW-0606, replacing the scripted inputs (Wave 1 plan RW-0108).
- Temperature effects on comfort: Wave 8 RW-0804 ("Environment and ecology depth").
- Perception of the new events: Wave 6 RW-0605 (none is in `PERCEIVABLE_EVENT_TYPES`).
- Mobility policy: Wave 11 §7 ("Object mobility and personal inventory").
