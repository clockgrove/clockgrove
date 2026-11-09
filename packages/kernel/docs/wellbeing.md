# Needs, comfort and health (RW-0108a)

**Policy and state.** `policy.wellbeing` (optional, requires `environment`; see [the domain package
README](../../domain/docs/wellbeing.md)) is `schemaVersion: 1` with `thirstPerInterval`, `healthLossPerInterval`,
`healthRecoveryPerInterval` (basis points per decision interval, 0 to 10000) and `urgentHunger`,
`urgentThirst`, `criticalHealth` (basis points, 1 to 10000); the record has no missing or extra field. `state.wellbeing`
holds one entry per needs actor in object-id order (`thirst`, `thirstRemainder`, `health`,
`healthRemainder`, `comfort`, `integratedAt`), is present exactly when the policy has one, and its
`integratedAt` equals the actor's `needs.integratedAt`. Refusals are `invalid-input` at
`pack.pack.policy.wellbeing...` or `partition.state.wellbeing...`.
`wellbeing.state-matches-policy@1` is a precondition and a post-state invariant of every command.

**Rules.** Thirst rises and health moves with the same floor-with-remainder arithmetic as hunger and
wetness, clamped to 0 through 10000; hunger and wetness always come from the unchanged
`integrateNeedsWith`. An actor is uncomfortable when hunger is at least `urgentHunger`, thirst at least
`urgentThirst` or wetness at least the environment's `discomfortThreshold`; causes (`hungry`, `thirsty`,
`wet`) are sorted. Health falls by `healthLossPerInterval` per decision interval while uncomfortable and
rises by `healthRecoveryPerInterval` while comfortable, and is critical below `criticalHealth`. No named
random stream is drawn. Every crossing is emitted at its first millisecond (the first time the quantity
reaches or passes the threshold), found by bisection over the integration's own functions.

**Events** (version 1, one reducer each): `wellbeing.integrated`
(`{objectId, thirst, thirstRemainder, health, healthRemainder, integratedAt}`: replaces the entry's
fields, moving forward), `needs.threshold-crossed` (`{objectId, need, value}` for `hunger` or `thirst`
reaching its urgent level: no state change), `comfort.changed` (`{objectId, comfort, causes}`: sets the
entry's comfort) and `health.threshold-crossed` (`{objectId, threshold: "critical", direction:
"entered" | "left", health}`: no state change). `wellbeing.integrated` is incidental, emitted wherever
`needs.changed` is. `resource.event-authority.<world command>@1` allows the four events for the world
commands. `identity.events` and `PERCEIVABLE_EVENT_TYPES` change only as declared: the four events are
registered and none is perceivable.

**Systems and decisions.** `world.advance` registers one wellbeing system per needs actor and the
`world.decision` payload handler through `createCatchUpRegistry`, and drains `world.decision` items
through `catchUpSchedules` in the same engine calls as the environment, ecology and wellbeing systems.
A decision is brought forward when a hunger or thirst crossing, a change to uncomfortable or an
entry into critical health happens for its actor before the queued due time: the engine call reports the
crossing, the decision is moved to that time by a single upsert, the same saved system states are drained
again, and the decision then runs at the crossing time with the unchanged `chooseRoutine`. The next
decision is due one `decisionIntervalMs` after the time it ran. A decision is never moved later. A
movement or portal command that moves the world time runs these systems for the time it passes, except
that the mover's decision waits for its end
([spatial movement](spatial-movement.md#world-time-a-move-passes)).
Same-time order: phase, weather, exposure, spoilage, appearance, stage change, needs crossings (hunger
before thirst, each in object-id order), comfort changes, health crossings, decision.

**`maxEvents`.** The exact minimum is `perActor*actors + plants + 1`, with `perActor` 2 with wellbeing
(`needs.changed` and `wellbeing.integrated` per actor) and 1 without; a smaller value is `invalid-input`
at `payload.maxEvents`, as is a group that cannot fit an empty budget. Time groups are indivisible: a
crossing group counts its integrations (`perActor` per concerned actor), its crossings, comfort and
health events and its environment and ecology events; a decision group counts the actor's integration
events, the plants' integrations and `routine.selected`, and is empty for an unchanged decision (issue 629, see
[utility decisions](utility-decisions.md)); the final group counts `perActor*actors + plants
+ 1` for `time.advanced`. A call that cannot fit its next group stops before it with a continuation, and a
brought-forward upsert made before that stop persists in the returned schedules.

**Scheduled input.** `kind: "scheduled"` carries `scheduled: { schemaVersion: 1, scheduleId, commandId,
type: "world.decision", payload: { schemaVersion: 1, objectId } }` and nothing else. `dispatchWorldDecision(item)`
returns the exact input the engine dispatches for a queue item, including its `commandId`, and
`ids.seed.commandId` must equal it. The decision must be the first item due, with an unchanged due time;
the call runs the one `world.advance` step that stops after it (no `time.advanced`) and has no continuation.
A continuation is refused. Output is the same as advancing with one input, without `time.advanced`; an
unchanged decision is a declared idempotent no-op with zero events, its trace and its next schedule.

**Refusals** (frozen, returned, never thrown; the envelope is unchanged):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.wellbeing` or a field below it (null, wrong type, missing or extra field, unknown `schemaVersion`, no `environment`, a rate outside 0 to 10000 or non-integer, a threshold outside 1 to 10000) | - |
| `invalid-input` | `partition.state.wellbeing` or a field below it (null, wrong type, missing, extra or wrong-typed field, entries out of order, unsupported comfort) | - |
| `precondition-failed` | `state.wellbeing`, `state.wellbeing.entries`, `state.wellbeing.entries[i].objectId`, `.integratedAt`, `.thirstRemainder`, `.healthRemainder`, `.comfort` | `wellbeing.state-matches-policy@1` |
| `invariant-violated` | `state.wellbeing.entries[i].comfort` and the other paths above | `wellbeing.state-matches-policy@1` (a post-state invariant for every command) |
| `invalid-input` | `input.scheduled`, `input.scheduled.<key>` (missing or extra key, payload not an object, extra payload key), `input.scheduled.scheduleId` (unknown schedule), `input.scheduled.commandId` (not the engine's, or a retry after the decision ran), `input.scheduled.payload.schemaVersion`, `input.scheduled.payload.objectId` (not the item's actor), `ids.seed.commandId`, `continuation`, `schedules` | - |
| `unknown-command-version` | `input.scheduled.type`, `input.scheduled.schemaVersion` | - |
| `precondition-failed` | `input.scheduled.scheduleId` (not first due, or the engine brought it forward) | `world.decision.first-due@1` |
| `unsupported-input` | `input.kind` (any stimulus other than `command` and the scheduled input) | - |
| `invalid-input` | `payload.maxEvents` (below the minimum above or a group cannot fit) | - |
| `check-error` | `request.systems[i]` (a wellbeing system throws) | `catch-up.system@1` |
| `handler-failed` | `handler` | - |
| `reducer-failed` | `events[i]` | - |

**Unchanged.** For policies without `wellbeing`, encodings, outputs and hashes are byte-identical;
the `rain-shelter-comfort`, `food-decay-and-conservation` and `cedar-growth` golden hashes were
unchanged by this layer (issue 629 later moved material-event hashes), `scheduler.ts`, `scheduler/`, `integrateNeedsWith`, `chooseRoutine` and `WorldNeeds` are untouched, and
the example packs decode as before.

**Evidence.** Seeded generated tests (named stream `behavior`, seed `wellbeing-thresholds-v1`), targeted
first-millisecond tests, the `material-wellbeing` pairs `live-steps-vs-fast-forward`,
`bounded-continuation-vs-unbounded` and `scheduled-decisions-vs-advance`, and the `comfort-and-health`
golden (committed literal material-event and final-state hashes) run in Node and Workers.
`material-wellbeing` compares the ordered wellbeing, environment, ecology and `routine.selected` events by
type, time and payload plus the final state with `revision` set aside; `needs.changed`,
`growth.integrated`, `wellbeing.integrated` and `time.advanced` events are incidental. The golden has
an exposed and a sheltered raccoon: comfort changes for hunger, thirst and wet, health enters and
leaves critical for the exposed one only, and the three execution shapes agree. `fullRuntimeEvidence` adds
a `wellbeing` section: `wellbeing-node.json` and `wellbeing-workers.json` hold each runtime's body, and
its summary stays at `comparison.json`'s `wellbeing`, validated by `test/spatial-evidence.ts`. Every call
of every listed run has one entry (365 at the time of writing), and the component evidence again records
both source images and the initial state; each file stays within its own 1 MiB bound (see
[Evidence report files](evidence.md#evidence-report-files)).

Death from health is built by the lifecycle layer ([lifecycle](lifecycle.md), RW-0109: `lifecycle.died`
with cause `health`).

**Deferred.** Rest, safety, social and curiosity needs, and injury (Wave 8 RW-0801, which completes the
pack's systems per the parent plan §7.8 Needs and Health/comfort rows, and RW-0803, "Household and social
routines"); temperature effects on comfort (Wave 8 RW-0804, "Environment and ecology depth"); perception of
the new events (Wave 6 RW-0605; none is in `PERCEIVABLE_EVENT_TYPES`).
