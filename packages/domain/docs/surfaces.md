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

**Recovery** is how a channel heals or washes away on its own: `{driver: "none"}` or
`{driver: "time", amount, periodMs}`, falling by `amount` (a positive safe integer) every
`periodMs` (a positive bigint of at most 2^53 milliseconds). The speed is pack data: a pack
chooses whether a scratch weathers in hours or in weeks.

**Zones.** A zone is hosted on an object (`{kind: "object", objectId}`) or a spatial region
(`{kind: "region", regionId}`). It lists 1–16 distinct declared channels, each with an `initial`
value in `[0, channel.max]`, and a `markCapacity` from 0 to 32.

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

`surfaceValueAt(channel, entry, at)` evaluates a channel lazily:
`total = (at - settledAt) * amount + remainder`, the value falls by `total / periodMs` (never below
zero) and the new remainder is `total % periodMs` (zero once the value is zero). Settling at any
intermediate instant and continuing gives the same value and remainder as one evaluation, so the
result does not depend on how time was advanced.

`nextSurfaceCrossing(channel, entry)` is the first instant at which the channel's band set
changes as it heals (the value drops below a band's `min` or to a band's `max`), or `null` when
it never will. `dueSurfaceCrossings(policy, state)` returns the earliest such instant over every
zone and the zone channels crossing then. `planSurfaceCrossing` settles one channel at that
instant and returns the `surface.band-crossed` payload. Only those crossings are journaled while
time passes; there are no per-tick events.

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
the same before and after. Its drains are the channel's declared recovery and the owner's repair,
both journaled.

When the interaction `leavesMark` and the zone's `markCapacity` is positive, a mark recording who,
when, where and how hard is pushed onto the ring. When the ring is full, its oldest mark leaves it
(`folded`) and survives only in the channel's level, which already includes its effect.

`planSurfaceRepair(policy, state, {zoneId, reason}, at)` settles the zone and returns the amount of
each non-zero channel it removes; the event resets every channel of the zone to zero and clears its
marks.

## Events and reducers

| Event (version 1) | Payload |
| --- | --- |
| `surface.interacted` | `{actorId, zoneId, interactionId, intensity, point, channels, carried, mark, folded}`: the zone's settled channels after the effects, the acting actor's new amount for each carried channel touched (0 removes the row), the pushed mark or `null`, the folded mark or `null` |
| `surface.band-crossed` | `{zoneId, channel, value, remainder, bands, previousBands}` |
| `surface.repaired` | `{zoneId, reason, removed: [{channel, amount}]}` |

`reduceSurfaceEvent` applies them; `reduceWorldEvent` routes the three types to it. A
`surface.interacted` event must list the zone's channels in order and may only fold the ring's
oldest mark. `surfaceDisagreement(policy, state)` reports the first path at which a state does not
match its policy: zone or channel order, a value above `max`, a remainder that cannot exist, a
settlement or mark in the future, marks out of order or over capacity, a crossing already due, or a
carried row that is unsorted, on an uncarried channel or held by an unknown actor.

## Commands

`surface.interact@1` `{schemaVersion: 1, actorId, zoneId, interactionId, intensity, point: {u, v}}`
and `surface.repair@1` `{schemaVersion: 1, zoneId, reason}` join the containment command family.
Their identifiers are opaque ids; `intensity` and the point coordinates are integers in the ranges
above. Scenarios decode `policy.surfaces` and `initialState.surfaces` with bigints written as
decimal strings.
