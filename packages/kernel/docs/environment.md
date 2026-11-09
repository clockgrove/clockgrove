# Environment: day/night, weather and exposure (RW-0107a)

A world behavior policy may carry an optional, versioned `environment` record. `world.advance`
then emits the day/night phase changes, the authored weather transitions and the moisture
exposure crossings through the RW-0106 engine. A movement or portal command that moves the world
time emits the phase changes, weather transitions and exposure crossings it passes the same way
([spatial movement](spatial-movement.md#world-time-a-move-passes)). Policies and states without it are
unchanged.

**Environment policy** (`policy.environment`, validated in the domain by
`validateEnvironmentPolicy`). Fields, all required, no others: `schemaVersion` (`1`; any other
version is refused), `dayLengthMs` (positive bigint, at most 2^53), `phases` (1 to 64 records
`{name, startMs, lightBand}`), `weatherSegments` (1 to 64 records `{durationMs, rainIntensity,
temperatureBand}`), `wetThreshold` and `discomfortThreshold` (integer basis points 1 to 10000).
The first phase starts at 0, phase starts strictly increase and stay below the day length, phase
names are unique, a segment duration is a positive bigint of at most 2^53 and a rain intensity is
an integer from 0 to 10000. Phase, light band and temperature band names are pack data (nonempty,
at most 512 characters, no outer whitespace), so a pack other than the raccoon one needs no engine
change. Both cycles are anchored at simulation time 0.

**Environment state** (`state.environment`). Present exactly when the policy has an
`environment`; absent otherwise. It holds `phase`, `lightBand`, `nextPhaseBoundary`,
`segmentIndex`, `temperatureBand` and `nextWeatherBoundary` (bigint times). Its shape is checked by
`validateEnvironmentState`; its agreement with the policy is checked by
`environment.state-matches-policy@1` (below).

**Boundary derivation.** `deriveEnvironmentState(policy, time)` is the record the policy implies at
`time`. The phase is the last one whose start is at or before `time mod dayLengthMs`, and its
boundary is the next phase start of that day, or the end of the day. The weather segment is found
in the repeating cycle of segment durations by `time mod cycleLength`, and its boundary is the end
of that segment. A boundary event is emitted at every phase start of every day (a day wrap
included, even with one phase) and at the start of every segment of every cycle, at exactly the
derived time. Only bigints and integers are used.

**Events** (version 1, exactly one reducer each, owner `clockgrove.world`):

| Event | Payload | Reducer effect |
| --- | --- | --- |
| `environment.phase-changed` | `phase`, `lightBand`, `nextPhaseBoundary` | updates `environment.phase`, `lightBand`, `nextPhaseBoundary`; the event time must equal the record's boundary |
| `weather.transitioned` | `segmentIndex`, `rainIntensity`, `temperatureBand`, `nextWeatherBoundary`, `rainChange` (`began`, `ended`, `changed` or `unchanged`) | updates the record and sets `weather.rainIntensity`; `rainChange` must describe the intensity in force against the new one (`began` from 0, `ended` to 0, `changed`, `unchanged`) |
| `exposure.threshold-crossed` | `objectId`, `threshold` (`wet` or `uncomfortable`), `direction` (`entered` or `left`), `wetness` | changes no physical field; continuous wetness stays in the needs projection |

**Exposure crossing rule.** An `entered` crossing is emitted at the first millisecond at which the
existing needs integrator's wetness is at or above the threshold, and a `left` crossing at the
first millisecond it is below it, using the rain intensity and shelter protection in force during
each interval. The exposure system calls the same `integrateNeedsWith` function that
`integrateNeeds` uses (the arithmetic body of `integrateNeeds`, extracted unchanged and exported);
there is no second wetness formula. Wetness is monotonic over an interval of constant rain and
protection, so the system bisects over that function: the crossing time is the smallest
millisecond at which it holds, and the millisecond before it does not. The `wetness` payload is
the integrator's value at the crossing. Before a weather boundary changes the rain, every needs
actor is integrated to the boundary (`needs.changed`), as `world.weather.set` does.

**Engine call.** With an environment, `world.advance` builds the phase system, the weather system
and one exposure system per needs actor (`environment.phase@1`, `environment.weather@1`,
`environment.exposure:<objectId>@1`), registers them through `createCatchUpRegistry` and calls
`catchUpSchedules` for each leg between decision due times (the first leg starts at the state's
simulation time, the last ends at the target). It adds no schedule item and no second threshold
loop and leaves decision-queue validation unchanged. (Since RW-0108a, `world.advance` drains
`world.decision` items through `catchUpSchedules` with a handler registered through
`createCatchUpRegistry`; [see the RW-0108a section](wellbeing.md).)
An exposure system also reports a non-material `horizon` waypoint at its own weather boundary; it
is dropped. Events are in simulation-time order; at equal time they are phase, weather, then
exposure crossings, then the decision due at that time (`needs.changed` and `time.advanced` are
incidental to the order). A time group (the integrations, phase, weather and crossings at one
time) is emitted whole or not at all, so every stopping point leaves the record agreeing with the
policy at the state's simulation time.

**Budgets and continuation.** Environment events count toward `maxEvents` exactly as other events.
When the next time group does not fit in what is left of `maxEvents`, the call returns
`complete: false` with the existing continuation and the chained calls produce the same material
events as one unbounded call. A group that cannot fit an empty budget (at most `3 * actors + 2`
events: one integration per actor, a phase, a weather event and two crossings per actor) is refused
with `invalid-input` at `payload.maxEvents`. The bound is `3 × actors + 2` without ecology and
`3 × actors + 2 × plants + perishable holders + sources + 2` with ecology; a budget smaller than the
next indivisible time group is refused with `invalid-input` at `payload.maxEvents`.
`maxInputs` counts decisions only.

**`world.weather.set` override.** With an environment the command emits its existing
`weather.changed` event. The intensity it sets holds until the next weather boundary, where
the authored segment's intensity takes over (the exposure systems model the held intensity until
the record's `nextWeatherBoundary`).

**`material-threshold` equivalence.** Compares the ordered `environment.phase-changed`,
`weather.transitioned`, `exposure.threshold-crossed` and `routine.selected` events by type,
simulation time and payload, plus the final state with `revision` set aside. `needs.changed` and
`time.advanced` events and `revision` are declared incidental because their count depends on step
boundaries. Pairs proved equal: `live-steps-vs-fast-forward` (advances of at most one decision
interval versus one advance over the same span) and `bounded-continuation-vs-unbounded` (chained
calls with a small `maxEvents` versus one call). Generated environment policies, shelter
placements and step sequences use the named stream `behavior` (seed `environment-thresholds-v1`),
never `weather`, and assert boundary times, first-millisecond crossings with the one-millisecond
earlier control, same-time order, both equivalences and seed replay.

**`rain-shelter-comfort` golden.** One exposed and one fully sheltered actor, a five-phase day and a
dry, rain, dry weather series over one 24 000 ms day. It proves the exposed actor enters and leaves
`wet` and `uncomfortable`, the sheltered actor emits no crossing, every phase and weather boundary
is emitted once, and live steps, one fast-forward and a bounded chain agree. The material-event and
final-state hashes are committed literals asserted in Node and Workers; `examples/world-packs/`
is unchanged.

**Refusals** (frozen, returned, never thrown):

| Code | Path | Check |
| --- | --- | --- |
| `invalid-input` | `pack.pack.policy.environment` or a field below it (null, wrong type, missing or extra field; unknown `schemaVersion`; non-positive or out-of-range `dayLengthMs` or `durationMs`; 0 or more than 64 phases or segments; first phase not at 0; starts not increasing or not below the day; duplicate phase names; rain or thresholds outside their basis-point range) | - |
| `invalid-input` | `partition.state.environment` or a field below it (null, wrong type, missing or extra field) | - |
| `invalid-input` | `payload.maxEvents` (a time group cannot fit an empty budget) | - |
| `precondition-failed` | `state.environment` (record without a policy environment, or the reverse), `state.environment.<field>` (phase, lightBand, segmentIndex, temperatureBand, nextPhaseBoundary or nextWeatherBoundary differs from the policy's value at the state's simulation time) | `environment.state-matches-policy@1` |
| `invariant-violated` | `state.environment`, `state.environment.<field>` | `environment.state-matches-policy@1` (a post-state invariant for every command) |
| `check-error` | `request.systems[i]` (an environment system throws or returns a non-integer) | `catch-up.system@1`, `catch-up.system-integrate@1` |
| `handler-failed` | `handler` (a handler exception) | - |
| `reducer-failed` | `events[i]` (a reducer exception) | - |

The post-state invariant has no access to the pack, so `executeWorldKernel` (and
`checkWorldInvariants`, through its optional policy argument) hold the policy of the running call in a
module slot for the duration of that synchronous call only.
`resource.event-authority.<world command>@1` allows the three new events for the world commands.

**Unchanged.** For a policy without `environment`, `world.advance` and `world.weather.set` outputs
are byte-identical, the example packs decode through the historical schema-v1 decoder, the
needs integrator's arithmetic and `scheduler.ts` and `scheduler/` are untouched. A
`kind: "scheduled"` stimulus was refused with `unsupported-input` here; RW-0108a now accepts the
`world.decision` scheduled input ([see below](wellbeing.md)). `identity.events` gains the three events at version 1;
no command is added.

**Evidence.** The shared `fullRuntimeEvidence` adds an `environment` section (seed, targeted,
refusal and generated entries with input identity and output identity, the two pairs with
equivalence and equal hashes, and the golden's hashes), identical in Node and Workers, plus a
bounded `comparison` summary, all in `environment.json` and validated by `test/spatial-evidence.ts`; see
[Evidence report files](evidence.md#evidence-report-files).
Input hashes reuse `containmentInputIdentity` (`clockgrove-canonical-v1` or
`clockgrove-malformed-input-v1`).

Food, water, spoilage and growth are built in [resources and growth](ecology.md) (RW-0107b); needs,
comfort, health and threshold-driven decision timing in [needs, comfort and health](wellbeing.md)
(RW-0108a).

Deferred (not part of RW-0107a): random weather, seasons and temperature effects on needs and comfort
(Wave 8 RW-0804, "Environment and ecology depth"; Wave 8 §7.1); perception of environment events
(Wave 6 RW-0605, "Perception and episode pipeline": no environment event is in
`PERCEIVABLE_EVENT_TYPES`). No wave plan links weather to live external data.
