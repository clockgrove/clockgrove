# Rule evaluation (RW-0110)

`evaluateRules(input)` is a pure function that evaluates rules validated by the domain
`validateRuleDefinition` over one kernel transition and returns typed command intents. It reads
no clock or randomness, mutates nothing, executes no command and never evaluates the intents it emits. It
returns `{ok: true, result}` or a frozen `{ok: false, error: {code: "invalid-input", path}}`. Only invalid
caller input is refused; internal defects (any error other than a refusal signal or a rule validation error)
throw out of `evaluateRules` unchanged.

**Input.** Exactly `rules` (unknown values, validated inside against `catalog`), `catalog` (`{type, version}`
entries), `transition`, `cooldowns` and `depth`. `transition` is `{from, to, before, after, events}`: `from` and
`to` are non-negative bigint times with `from <= to`, `before` and `after` are domain `WorldState` values and
`events` are entries with a string `type`, a positive safe-integer `schemaVersion`, a bigint `simulationTime` and
a plain-record `payload`; additional event fields are permitted, so a `WorldSemanticEvent` from
`executeWorldKernel` is accepted unchanged. Every event time must lie within `[from, to]`. `cooldowns` is a list of `{ruleId, ruleVersion, lastFiredAt}`
(bigint) entries strictly sorted by rule id (UTF-16 code units) then version. `depth` is a non-negative safe
integer, 0 for externally caused transitions. An optional `continuation` is an exact
`{schemaVersion: 1, evaluatedThrough}` record (bigint `evaluatedThrough`, `from <= evaluatedThrough < to`).
An optional `holdEnd` is a boolean (absent or `undefined` is `false`). An optional `heldGroup` is an exact
`{schemaVersion: 1, at, schedules, events}` record: `at` is a bigint equal to `transition.from`, `schedules` a
boolean and `events` a list validated like transition events, each with `simulationTime` equal to `at`.
Refusal paths: `input.holdEnd` (not a boolean, including `null`), `input.heldGroup` (not a record),
`input.heldGroup.<field>` (missing or extra field, `schemaVersion` other than 1, `at` not a bigint equal to
`transition.from`, `schedules` not a boolean) and `input.heldGroup.events[i]...` (as for transition events, with
`simulationTime` required to equal `heldGroup.at`). Further paths: `input`, `input.<field>` for a missing or extra
field, `input.transition.from`, `input.transition.events[i]` (not a record), `input.transition.events[i].schemaVersion`,
`input.transition.events[i].simulationTime` (not a bigint, or outside `[from, to]`), `input.transition.before|after.spatialRegions[i]...` (a region the domain `parseSpatialRegion` rejects, at its validator path), `input.depth`, `input.cooldowns[i].lastFiredAt`, `input.rules[i]` followed by the
validator path, and `input.rules[i]` for a duplicate `id` and `version`. `input.continuation` (not a record),
`input.continuation.<field>` (missing or extra field, `schemaVersion` other than 1, or an `evaluatedThrough` that
is not a bigint or lies outside `[from, to)`) and `input.transition` (a single simulation-time group of more than
`RULE_MAX_FIRINGS` firings) are also refused. Long schedule spans are not refused; they are evaluated in bounded
steps (see Bounded evaluation).

**Result.** Exactly `intents`, `trace`, `cooldowns` and `complete`, plus `continuation` exactly when `complete` is
`false`; no world state, schedule mutation or semantic event. A frozen `heldGroup` is present exactly when `holdEnd`
is `true` and `complete` is `true` (never with a `continuation`). It is `{schemaVersion: 1, at, schedules, events}`
where `at` is `transition.to`; `events` are the input `heldGroup` events (only when its `at` equals `transition.to`,
that is `from === to`) followed by the transition events at `transition.to`, in input order; and `schedules` is `true`
when `to > from`, the input `heldGroup.schedules` when `from === to` and a `heldGroup` was supplied, otherwise `false`.

**Ordering.** Firings are grouped by simulation time (a group is every firing of every rule at one time). Groups
are processed in ascending time; inside a group rules run in `id` (UTF-16 code units) then `version` order and each
rule's firings in firing order (events in input order, threshold and geofence subjects by object id). Intents and
trace entries follow that order, so permuting `rules` does not change the output. The `intentKey` ordinal counts
the rule's firings at that same simulation time from 0.

**Step independence.** Cooldown is threaded in time order inside one call: an emitting firing sets the rule's last
firing time immediately, so later firings in the same call (and the same group) see it. `maxFanout` applies per
rule per simulation time: if a rule's firings at one time would emit more than `maxFanout` intents, those firings
are traced `fanout-exceeded`, emit nothing and leave the rule's last firing time as it was before that time; its
firings at other times still emit. Consequently event- and schedule-triggered output (intents, trace and returned
`cooldowns`) is identical across step sizes when each event is supplied with the transition whose `(from, to]`
contains its time (an event at the span start goes to the first transition) and the returned `cooldowns` are passed
to the next call. When a `world.advance` continuation splits a same-time group, see **World continuation.**

**World continuation.** A `world.advance` that stops on its budget returns an incomplete result whose next call
starts at the time of the last group, so one same-time group is split across two transitions. The caller supplies
each event with the world call that emitted it (unchanged, in emission order), sets `holdEnd` exactly when the
world result is incomplete, and passes the returned `heldGroup` and `cooldowns` to the next call. With `holdEnd`,
event- and schedule-triggered firings at `transition.to` are deferred (not traced, not counted by cooldown) and
returned as `heldGroup`. The next call evaluates the group at its `from` whole: the held events, then its own
events at `from`, plus schedule occurrences at `from` if and only if `heldGroup.schedules`; with `holdEnd` and
`from === to` the group is merged into a new `heldGroup` instead. Occurrences in `(from, to]` behave as without a
`heldGroup`. `threshold` and `geofence` firings stay transition-relative endpoint predicates at the `to` of the
call that receives the transition and are never held. The resulting intents, trace and `cooldowns` of event- and
schedule-triggered rules are identical to those of one uninterrupted transition, so `maxFanout`, cooldown and
`intentKey` ordinals match. A bounded call (`complete: false`) returns no `heldGroup`; resume it with the same
input, the returned `continuation` and `cooldowns`. A merged group above `RULE_MAX_FIRINGS` is refused at
`input.transition` when it is evaluated.

**Endpoint predicates.** `threshold` and `geofence` triggers are transition-relative endpoint predicates: they
compare `before` and `after` and fire at `transition.to`, so their results depend on the step size. For exact
crossing times use the `movement.region-entered`, `movement.region-exited` and `needs.threshold-crossed` event
triggers.

**Bounded evaluation.** One call traces at most `RULE_MAX_FIRINGS` (4096) firings, always whole simulation-time
groups. When the next group would exceed the bound, the call stops with `complete: false` and a frozen
`continuation` `{schemaVersion: 1, evaluatedThrough}`, where `evaluatedThrough` is the time of the last processed
group; otherwise `complete` is `true`. To resume, call again with the same transition, the returned `cooldowns` and
the returned `continuation`; groups at or before `evaluatedThrough` are skipped. Repeat until `complete` is `true`;
the concatenated output equals the output of consecutive smaller transitions.

**Firing semantics.**

- `event`: one firing per entry of `transition.events` whose `type` equals `eventType` and `schemaVersion` equals
  `eventVersion`, both read through the replay upcast (`upcastEventRecord`, domain): a historic event is read
  at its current version and a trigger names its current version too, so `routine.selected@1` and `@2` triggers
  match `@1` and `@2` events alike (`@2` is emitted only for a material decision since issue 629; pack lint flags a
  trigger on a superseded version, see world-pack-sdk `lintWorldPack`), in event order, with `at` and `firedAt` equal to that event's own `simulationTime` (not
  `transition.to`) and the payload available to `field` nodes. A `field` node needs an own payload property of
  its declared type, otherwise the firing is `binding-failed`.
- **Integer convention.** Rule integers are bigints. An `integer` `field` node and the threshold quantities
  (`needs.hunger`, `needs.wetness`, `resource.quantity`) read a bigint unchanged and a safe-integer number as the
  equal bigint (`3` is `3n`); any other number gives `binding-failed` for a field and is skipped for a threshold.
- `schedule`: one firing per `offsetMs + k * everyMs` in the half-open interval `(from, to]` (an occurrence at
  `to` fires, one at `from` does not), with `at` the occurrence time and `occurrence` the value of `k`.
- `threshold`: per entity present in both states (all, or only `objectId`; in object id order), `rising` fires
  when the quantity is below `value` before and at or above `value` after; `falling` when above before and at or
  below after. Entities or quantities absent from either state are skipped. `at = to`, `subject` is the object id
  and `value` the quantity after.
- `geofence`: per entity present in both states, `entered` fires when the pose is outside the named
  `state.spatialRegions` region before and inside after, `left` when inside before and outside after, decided by
  the domain `regionContains`. An entity whose pose frame differs from the region frame, or a region missing from
  either state, never fires.

Bindings evaluate in declared order with bigint integer arithmetic only. A false condition gives
`condition-false`.

**Intent.** A frozen `RuleCommandIntent` with exactly `schemaVersion` (1), `ruleId`, `ruleVersion`,
`commandType`, `commandVersion`, evaluated `payload`, `firedAt`, `depth` (input depth plus one) and `intentKey`
(`<ruleId>@<ruleVersion>/<firedAt>/<firing ordinal>/<intent index>`).

**Trace.** One `{ruleId, ruleVersion, firedAt, outcome}` entry per firing; `outcome` is `emitted`,
`condition-false`, `binding-failed`, `fanout-exceeded` (the rule's firings at that simulation time would emit
more than `maxFanout` intents, so they emit none), `depth-exceeded` (input `depth` at or above `maxDepth`) or `cooldown` (the firing is
earlier than `lastFiredAt + cooldownMs`).

**Fuzz.** `test/rules-fuzz.test.ts` generates 300 valid rules and one single-fault variant of each
from the named random stream `fuzz` (installation seed `rule-ast-fuzz-v1`, declared as
`ruleFuzzSeed`). The rules cover every trigger kind and its variables, every operator, every literal
and field type, the 256-node and 16-level bounds exactly, integer literals at +/-2^53, binding order
and the fanout, depth and cooldown budget ranges. Every variant (unknown field, operator or type
name, missing field, wrong literal or operand type, non-boolean condition, out-of-range literal or
budget, unknown trigger kind or command, later or unknown binding reference, too many intents, nodes
or levels) is refused by `validateRuleDefinition` with a `RuleValidationError` whose code and path
are the ones the fault requires. Every valid rule evaluates identically twice, one level below and
at its `maxDepth`, and its trace and intents (`firedAt`, `depth`, payload values) equal the ones a
test-side interpreter derives from this document's expression, cooldown, fanout and depth rules.

**Cooldowns.** The returned `cooldowns` equal the input entries with the last emitting firing time of every
rule that emitted (emissions dropped by `fanout-exceeded` do not count); a rule that emitted nothing keeps its
entry. The input is never changed.

**Where rules run.** Nothing here executes intents. Packs declare rules
([collections](../../world-pack-sdk/docs/collections.md)), and the simulator's scenario runner evaluates them
and records their intents without executing them ([scenarios](../../simulator/docs/scenarios.md)). The live
runtime does not evaluate rules.

**Deferred.** To Wave 7 RW-0702 ("Durable rule reactions"): durable reaction dispatch and live activation
(rule indexes, Queue dispatch, firing identity and command submission), loop and cycle limits across firings,
and the local, world and global kill switches. To Wave 7 RW-0706 and RW-0707 (changeset compiler and
`AuthoringWorkflow`), with RW-0701's authoring serialization: rule authoring.
