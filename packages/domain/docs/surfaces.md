# Graded surface state

A world can remember what its actors do to it: a scratch on a post, mud on a step, a worn patch
of ground. `packages/domain/src/surface.ts` holds the pack-declared model, its validation, the
closed-form healing math, the pure planners the kernel calls and the event reducer. The kernel
contract (commands, refusals, the advance barrier and invariants) is in
[kernel surfaces](../../kernel/docs/surfaces.md).

Only *material state* lives here: state an actor could notice later or the human could ask
about. A renderer's *derived look* (computed from this state and a seed) and *ephemeral
reactions* are never stored. Nothing in the model names a species or a world.

## Policy: `policy.surfaces`

`WorldBehaviorPolicy.surfaces` is optional. When it is absent the world has no surfaces,
`state.surfaces` must be absent too, and every existing canonical encoding is unchanged. When it
is present, `state.surfaces` must be present and match it. `validateSurfacePolicy` checks the
record exactly (no missing or extra fields); every failure is an `EnvironmentValidationError` at
the `policy.surfaces...` path.

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1` |
| `budgets` | `{zones, marksPerZone}`: the pack's own budget, `zones` 1–256, `marksPerZone` 0–32 |
| `channels` | at most 16 `{id, max, carried, bands, recovery}` |
| `zones` | at most 256 (and at most `budgets.zones`) `{id, host, channels, markCapacity}` |
| `interactions` | at most 64 `{id, effects, leavesMark}` |

**Channels.** `id` is unique, 1–512 characters without surrounding whitespace. `max` is an
integer from 1 to 1,000,000; a channel's value is always an integer in `[0, max]`. `bands` holds
1–16 named ranges `{name, min, max}` with `0 <= min <= max <= channel.max` and unique names.
Bands may overlap and need not cover the range: a value's band set (`surfaceBands`) is every band
containing it, in declaration order, and may be empty. `carried: true` marks matter that moves
(mud and the like): it cannot be raised by `add`, only moved by `pickup` and `deposit`.

**Recovery** is how a channel heals or washes away on its own, tied to a modelled driver:

| Driver | Record | Heals |
| --- | --- | --- |
| `none` | `{driver}` | never |
| `time` | `{driver, amount, periodMs}` | by `amount` every `periodMs` |
| `rain` | `{driver, amount, periodMs}` | by `amount` every `periodMs` of rain at full intensity, scaled by the weather segment's `rainIntensity` (basis points); `periodMs` at most 900,719,925,474 |
| `growth` | `{driver, amount, periodMs, lightBands}` | by `amount` every `periodMs` spent in a day phase whose light band is one of `lightBands` (1–64 unique names), not at all otherwise |

`amount` is a positive safe integer and `periodMs` a positive bigint of at most 2^53 milliseconds
unless stated. A `rain` or `growth` channel needs the policy's `environment`
([environment](environment.md)); without one the world policy is refused at
`policy.surfaces.channels[i].recovery.driver`. Each `growth` light band must be the `lightBand` of
one of the environment's phases, else the policy is refused at
`policy.surfaces.channels[i].recovery.lightBands[k]`. The speed is pack data: a pack chooses whether a
scratch weathers in hours or in weeks.

**Zones.** A zone is hosted on an object (`{kind: "object", objectId}`) or a spatial region
(`{kind: "region", regionId}`). It lists 1–16 distinct declared channels, each with an `initial`
value in `[0, channel.max]`, and a `markCapacity` from 0 to 32. A zone hosted on a region may
also name `traffic`: a declared interaction, all of whose effects are on the zone's own channels,
applied to every object that enters the region (see [Wear by movement](#wear-by-movement)). A zone
without it encodes as before.

**Interactions.** `id` is unique; `effects` holds 1–8 `{channel, kind, amount}` with `amount`
1–1,000,000. `kind` is `add` for an ordinary channel, and `pickup` or `deposit` for a carried one;
any other pairing is refused. `leavesMark` says whether an interaction pushes a recent mark.

**Budgets.** More zones than `budgets.zones`, or a zone whose `markCapacity` exceeds
`budgets.marksPerZone`, is refused with an `EnvironmentValidationError` whose `check` is
`surface.budget@1` (message `surface budget exceeded (surface.budget@1)`) at `policy.surfaces.zones`
or `policy.surfaces.zones[i].markCapacity`; a malformed declaration at those paths carries no
`check`. Nothing is dropped. The
engine ceilings above (`MAX_SURFACE_ZONES`, `MAX_SURFACE_CHANNELS`, `MAX_SURFACE_BANDS`,
`MAX_SURFACE_INTERACTIONS`, `MAX_SURFACE_MARKS`, `MAX_SURFACE_EFFECTS`) bound per-instant work.

## State: `state.surfaces`

`{zones, carried}`, checked by `validateSurfaceState` at `state.surfaces...`:

- `zones[i]` is `{zoneId, channels, marks}`, one per declared zone in declaration order.
- Each channel entry is `{channel, value, remainder, settledAt}`: the value at `settledAt` and the
  bigint recovery progress carried past it. Bands are derived, never stored.
- `marks` is the zone's ring of recent marks, oldest first, at most `markCapacity`:
  `{actorId, interactionId, at, intensity, point: {u, v}}` with `intensity` 1–10,000 and `u`, `v`
  0–10,000 (a position on the zone in ten-thousandths).
- `carried` is one `{objectId, channel, amount}` row per actor and carried channel with a positive
  amount, sorted by object id then channel.

The size of this state depends only on the declarations and the number of actors holding matter;
it never grows with time and is never an edit log. `initialSurfaceState(policy, epoch)` builds the
genesis state: each zone channel at its `initial` value, settled at the world epoch, no marks and
nothing carried. The simulator's genesis seeds it whenever the policy declares surfaces.

## Closed-form healing

Each driver is a clock: a cumulative weight `F(t)` over `[0, t)` and a divisor `D`. For `time`,
`F(t) = t` and `D = periodMs`. For `rain`, `F` integrates `rainIntensity` over the environment's
weather segments and `D = periodMs × 10000`; for `growth`, `F` counts the milliseconds spent in a
listed light band over the environment's day phases and `D = periodMs`. Both environment cycles
are anchored at time 0 and repeat, so `F` is closed-form (whole cycles plus a walk of at most 64
segments), and no phase event needs to settle a channel.

**Held rain.** Rain heals under the rain the world models, `state.weather.rainIntensity`, which a
`world.weather.set` override holds until the next weather boundary. `surfaceRainHold(state,
environment?)` returns `{rainIntensity, until}` while that intensity differs from the current
segment's authored one (`until` is the record's `nextWeatherBoundary`), else nothing. Under a hold,
`F` has slope `rainIntensity` before `until` and follows the schedule from `until`. So that this is
exact, every rain channel with a value settles where a hold begins or ends: a `weather.changed` that
changes the rain, and the `weather.transitioned` that ends a hold, carry an optional `surfaces` field
of `{zoneId, channel, value, remainder}` rows settled at the event under the rain in force before it
(`planSurfaceRainSettlement`); `reduceWorldEvent` applies them through
`reduceSurfaceRainSettlement`, setting `settledAt` to the event time. Without a rain channel with a
value the field is absent and the event encodes as before. Exposure and water collection read the
same held intensity, so surfaces, wetness and collectors agree in one world.

`surfaceValueAt(channel, entry, at, environment?, hold?)` evaluates a channel lazily:
`total = (F(at) - F(settledAt)) × amount + remainder`, the value falls by `total / D` (never below
zero) and the new remainder is `total % D` (zero once the value is zero). Settling at any
intermediate instant and continuing gives the same value and remainder as one evaluation, so the
result does not depend on how time was advanced. A `rain` or `growth` channel evaluated without
an environment throws.

`nextSurfaceCrossing(channel, entry, environment?, hold?)` is the first instant at which the channel's
band set changes as it heals (the value drops below a band's `min` or to a band's `max`): the
smallest `t` at which `F(t)` reaches the weight that drop needs, or `null` when it never will (no
band left to cross, or a cycle with no rain or no listed light). `dueSurfaceCrossings(policy,
state, environment?, hold?)` returns the earliest such instant over every zone and the zone channels
crossing then. `planSurfaceCrossing` settles one channel at that instant and returns the
`surface.band-crossed` payload. Only those crossings are journaled while time passes; there are
no per-tick events. The planners below take the same optional trailing `environment`.

## Interactions, marks and carried matter

`planSurfaceInteraction(policy, state, {actorId, zoneId, interactionId, intensity, point}, at)` is
pure. It refuses an undeclared zone (`surface.zone@1`), an undeclared interaction or one with an
effect on a channel the zone lacks (`surface.interaction@1`), an unknown actor (`surface.actor@1`),
and an actor out of reach (`surface.reach@1`): not in the host object's space, or not standing
inside the host region. Otherwise it settles every zone channel at `at` and applies each effect,
scaled by `max(1, floor(amount * intensity / 10000))`:

- `add` raises the value, capped at `max`.
- `pickup` moves up to the scaled amount from the zone to the actor, capped by what the zone holds.
- `deposit` moves up to the scaled amount from the actor to the zone, capped by what the actor
  carries and by the room below `max`.

Carried matter is therefore only ever moved, never copied: the zone and the actor's totals sum to
the same before and after. Its drains are the channel's declared recovery, the owner's repair and
the death of the actor carrying it (`surface.carried-drained`), each journaled.

When the interaction `leavesMark` and the zone's `markCapacity` is positive, a mark recording who,
when, where and how hard is pushed onto the ring. When the ring is full, its oldest mark leaves it
(`folded`) and survives only in the channel's level, which already includes its effect.

`planSurfaceRepair(policy, state, {zoneId, reason}, at)` settles the zone and returns the amount of
each non-zero channel it removes; the event resets every channel of the zone to zero and clears its
marks.

## Wear by movement

`planSurfaceTraffic(policy, state, actorId, regionId, at, environment?)` returns what an object
entering `regionId` does to the region's `traffic` zones, in declaration order: for each, a
`SurfaceTrafficEntry` `{zoneId, interactionId, channels, carried, mark, folded}` with the same
meaning as in `surface.interacted`. The interaction applies at full intensity (10000), with no
reach check (entering is reach) and a mark, when it leaves one, at the zone's centre
`{u: 5000, v: 5000}`. A later zone on the same region sees the carried amounts an earlier one
left, so an actor that picks mud up in a yard and walks onto a porch deposits it there.

These entries ride on the existing `movement.region-entered` event as its optional `surfaces`
field, present only when non-empty: wear costs no event of its own, never one per step, and an
entry event without the field encodes as before. `reduceWorldEvent` applies them after the
movement reducer through `reduceSurfaceTraffic`.

## Senses and notices

A band may declare `senses`, one or two unique modalities (`sight`, `smell`) to which it is a
standing signal while the channel's value is in it. The policy may declare `senses`, up to 64
entries `{archetypeId, modalities}` with unique archetype ids, matched exactly against an entity's
`archetypeId`. Both are optional; without them nothing is perceivable and every encoding is as
before.

`planSurfaceNotices(policy, state, observerId, regionId, at, environment?)` returns what an observer
entering `regionId` perceives, as `SurfaceNotice` entries `{zoneId, signals, mark}`. It returns none
when the policy has no `senses`, the world has no surface state, the observer is not an entity or
its archetype has no entry. A zone is a candidate when it is hosted by `regionId`, or by an active
object other than the observer that is in the observer's space, is not put inside a container
(`containment.containerId` unset) and whose pose lies inside that region. There is no range or
occlusion beyond that: the region is the range. For each candidate zone, in
declaration order, each channel is settled at `at` (under the rain the world holds), and each band
containing the value that declares `senses` gives one signal `{channel, band, modality}`, with the
first of the band's modalities the observer has. A zone with at least one signal is a notice, whose
`mark` is the last mark of its ring or `null`.

Notices ride on the existing `movement.region-entered` event as its optional `notices` field,
present only when non-empty and computed from the state before the entry's traffic applies. There is
no new event and no state: the reducer ignores the field, a notice costs nothing as time passes, and
an entry event without the field encodes as before.

## Events and reducers

| Event (version 1) | Payload |
| --- | --- |
| `surface.interacted` | `{actorId, zoneId, interactionId, intensity, point, channels, carried, mark, folded}`: the zone's settled channels after the effects, the acting actor's new amount for each carried channel touched (0 removes the row), the pushed mark or `null`, the folded mark or `null` |
| `surface.band-crossed` | `{zoneId, channel, value, remainder, bands, previousBands}` |
| `surface.repaired` | `{zoneId, reason, removed: [{channel, amount}]}` |
| `surface.carried-drained` | `{actorId, removed: [{channel, amount}], cause: "died"}`: every carried row the actor held, in state order; the reducer removes them |

`reduceSurfaceEvent` applies them; `reduceWorldEvent` routes the four types to it. A
`surface.interacted` event must list the zone's channels in order and may only fold the ring's
oldest mark. `surfaceDisagreement(policy, state)` reports the first path at which a state does not
match its policy: zone or channel order, a value above `max`, a remainder that cannot exist, a
settlement or mark in the future, marks out of order or over capacity, a crossing already due, or a
carried row that is unsorted, on an uncarried channel, or held by an unknown or dead actor.

## Commands

`surface.interact@1` `{schemaVersion: 1, actorId, zoneId, interactionId, intensity, point: {u, v}}`
and `surface.repair@1` `{schemaVersion: 1, zoneId, reason}` join the containment command family.
Their identifiers are opaque ids; `intensity` and the point coordinates are integers in the ranges
above. Scenarios decode `policy.surfaces` and `initialState.surfaces` with bigints written as
decimal strings.
