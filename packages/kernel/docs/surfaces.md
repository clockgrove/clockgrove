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
| `surface.zone@1` | `payload.zoneId`: the world declares no surfaces, the zone is undeclared, or its host object is gone |
| `surface.interaction@1` | `payload.interactionId`: undeclared, or an effect names a channel the zone lacks |
| `surface.actor@1` | `payload.actorId`: unknown or inactive actor, or not the effective actor |
| `surface.reach@1` | `payload.actorId`: the actor cannot reach the zone |

Malformed payloads are `invalid-input` at `payload.<field>`. A pack whose surface declarations
exceed its own budget is refused before any command runs: `invalid-input` at
`pack.pack.policy.surfaces.zones` (more zones than `budgets.zones`) or
`pack.pack.policy.surfaces.zones[i].markCapacity` (more than `budgets.marksPerZone`); the domain
validation error behind it names `surface.budget@1`. Nothing is silently dropped.

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

## Invariants

- `surface.state-matches-policy@1`, both a precondition on the incoming partition and a post-state
  invariant for every command, reports the first `state.surfaces...` path that disagrees with the
  policy (see `surfaceDisagreement` in the domain contract), including a crossing that is already due
  but unjournaled.
- `surface.journaled@1` replays every `surface.*` event a command emits from the policy and the
  prior state: each interaction and repair must equal its plan, and each crossing must be due at its
  instant with the planned payload. A forged or reordered surface event is `invariant-violated` at
  `events[i]`.

Replaying the journal through `reduceWorldEvent` reproduces the surface state exactly; the kernel
journey test (`packages/kernel/test/surface.journey.test.ts`) proves the mark ring, attribution,
refusals, healing in every advance shape, carried-matter conservation, repair and the budget
refusal.

## Not yet here

Rain and growth recovery drivers, wear carried by movement events, perception of a zone's state as
a standing signal, the why path from a zone to its cause, the presentation binding, and the runtime's
owner repair route are later parts of issue #267. No `surface.*` event is perceivable yet.
