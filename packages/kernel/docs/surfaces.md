# Graded surface state

The kernel executes the pack-declared surface model of [domain surfaces](../../domain/docs/surfaces.md):
actors mark zones, zones heal in closed form, and the owner's repair is journaled. A world whose
policy declares no `surfaces` behaves and encodes exactly as before.

## Commands

| Command | Payload | Journals |
| --- | --- | --- |
| `surface.interact@1` | `{schemaVersion: 1, actorId, zoneId, interactionId, intensity, point: {u, v}}` | one `surface.interacted` |
| `surface.repair@1` | `{schemaVersion: 1, zoneId, reason}` | one `surface.repaired` |

Both run through the containment command path at the partition's current simulation time, with
the ordinary revision check and sealed command attribution. `surface.interact` runs only as its
acting actor: the effective actor must equal `actorId`, and the actor must be active and within
reach of the zone (in the host object's space, or inside the host region). `surface.repair` is an
ordinary kernel command; it records the stated `reason` and the amounts it removed under the
issuing command's attribution. Which principals may issue it (the owner, through the world steward)
is decided by the runtime's grants, not by the kernel.

Refusals are `precondition-failed` with these checks (version 1), and change nothing:

| Check | Path and condition |
| --- | --- |
| `surface.zone@1` | `payload.zoneId`: the world declares no surfaces, the zone is undeclared, or its host object is gone or no longer active (retired) |
| `surface.interaction@1` | `payload.interactionId`: undeclared, or an effect names a channel the zone lacks |
| `surface.actor@1` | `payload.actorId`: unknown or inactive actor, or not the effective actor |
| `surface.reach@1` | `payload.actorId`: the actor cannot reach the zone |

Malformed payloads are `invalid-input` at `payload.<field>`. A pack whose surface declarations
exceed its own budget is refused before any command runs: `invalid-input` at
`pack.pack.policy.surfaces.zones` (more zones than `budgets.zones`) or
`pack.pack.policy.surfaces.zones[i].markCapacity` (more than `budgets.marksPerZone`), carrying
`check: "surface.budget@1"` so a caller can tell an exceeded budget from a malformed declaration at
the same path (which carries no check). Nothing is silently dropped.

## Healing under the catch-up contract

The state stores, per zone channel, only the value, the remainder and when it last settled. A
channel heals lazily: any command that touches it settles it in closed form at its own instant.
While time passes, the only events are band crossings. `world.advance` (and every time-passing
move) treats the earliest due crossing as a barrier in its existing loop: at that instant it runs
after the instant's physical causes and before declared processes, and journals one
`surface.band-crossed` for each zone channel crossing then, settling that channel. A crossing
group counts against `maxEvents` as a whole: an advance that cannot fit it after earlier events
stops incomplete before the instant, and one whose whole budget cannot fit it is `invalid-input`
at `payload.maxEvents`.
Because the math is closed-form and the barrier is the same at every step size, a one-call advance,
a chain of advances and many small advances journal identical events and reach the same state.

Rain and growth channels heal the same way: their clocks are closed-form over the environment's
own cycles, so phase changes settle nothing and journal no surface event, and the barrier only ever
fires at a band crossing. Rain heals under the rain the world holds: while a `world.weather.set`
override differs from the schedule, crossings are computed under it until the next weather
boundary. Its `weather.changed`, and the `weather.transitioned` that ends it, carry the rain
channels settled at that instant in an optional `surfaces` field (no new event). A crossing due
exactly as a hold ends is journaled under the held rain just before that `weather.transitioned`, and
counts in its environment group under `maxEvents`.

## Wear by movement

Every `movement.region-entered` the kernel journals, from a moving command, a `world.advance` or
a time-passing move alike, passes one funnel that asks `planSurfaceTraffic` what the entry does to
the region's `traffic` zones at the entry instant and, when anything, attaches it as the event's
`surfaces` field. A walk therefore wears a path, or tracks mud from one region onto the next, with
exactly the entry events the route already implies and no event per step.

## Notices

The same funnel asks `planSurfaceNotices` what the entering object perceives, from the state before
the entry's traffic applies, and attaches it as an optional `notices` field on the
`movement.region-entered`, only when non-empty. A zone's band is a standing signal to the
modalities the band and the observer's archetype share, so a scratched post is noticed by sight,
or a muddy yard by smell, on entering, journaled like any other event, with no event of its own and
no state. A zone on an object is noticed only while that object stands in the region, in the
observer's space and not put inside a container. Once the zone heals below the signalling band, a
new entry carries no notice.

## Carried matter on death

When an actor dies holding carried matter, one `surface.carried-drained` with `cause: "died"`
follows its `lifecycle.died` at the same instant and removes every row it held, so lifecycle
compaction can later remove the actor without leaving matter behind. A retired actor keeps its
rows. The drain counts toward the death's lifecycle group under `maxEvents`, including rows the
actor's pending crossings pick up through traffic just before it dies, so a chained catch-up with
the same budget passes the death exactly as one unbounded call does.

## Invariants

- `surface.state-matches-policy@1`, both a precondition on the incoming partition and a post-state
  invariant for every command, reports the first `state.surfaces...` path that disagrees with the
  policy (see `surfaceDisagreement` in the domain contract), including a crossing that is already due
  but unjournaled.
- `surface.journaled@1` replays every `surface.*` event a command emits from the policy and the
  prior state: each interaction and repair must equal its plan, and each crossing must be due at its
  instant with the planned payload. Every `movement.region-entered` must carry exactly the
  planned traffic and the planned notices (or none of either), and every `weather.changed` or
  `weather.transitioned` exactly the planned rain settlement (or none). A drain must remove exactly the actor's rows and follow its death at
  the same instant, and a death of an actor holding matter must be followed by its drain. A forged,
  missing or reordered surface effect is `invariant-violated` at `events[i]`.

Replaying the journal through `reduceWorldEvent` reproduces the surface state exactly; the kernel
journey test (`packages/kernel/test/surface.journey.test.ts`) proves the mark ring, attribution,
every refusal above (reach for an object host in another space and for a ground region the actor
stands outside, and a retired host), a scratch on a ground-region zone, healing in every advance
shape, rain and growth healing at hand-computed instants in every advance shape, rain healing under a
dry and a wet `world.weather.set` override with a crossing at the hold's end, a walk that wears
a porch and tracks mud onto it, another actor's scratch on a post noticed by sight or by smell on entering
(the band's first modality the observer shares named), and not once healed, by an actor without
that sense, or with the post in a container or another space, the drain of a dying actor's mud, carried-matter conservation,
repair, the budget refusal and scenario decoding.

## Not yet here

The why path from a zone to its cause, the presentation binding, and the runtime's owner repair
route are later parts of issue #267. A zone's moments (the events above that changed it) are
already listed for flashbacks by `POST /v1/runtime/flashback/marks`
([observation protocol](../../../docs/protocols/living-yard-observation.md#flashback-marks)).
