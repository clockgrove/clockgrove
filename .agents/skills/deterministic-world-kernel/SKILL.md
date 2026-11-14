---
name: deterministic-world-kernel
description: Clockgrove's rules for the deterministic physical kernel in clockgrove/clockgrove (packages/kernel, packages/domain, packages/simulator and the world commands that drive them). Use when implementing or reviewing simulation time, schedules and catch-up, named randomness, spatial movement, containment and resources, rules, lifecycle, utility decisions, or anything that must stay deterministic and replayable.
---

# Deterministic world kernel

The kernel answers **what actually happened**. Cognition may perceive, interpret and propose; it never bypasses the kernel.

## Where the contracts live

Start from the `Documentation map` in `AGENTS.md` and read only the subsystem you touch:

- `packages/kernel/docs/`: executor, random streams, scheduler, containment, spatial movement, perception, environment, ecology, wellbeing, utility decisions, lifecycle, rules.
- `packages/domain/docs/`: the matching domain contracts and the component catalog.
- `packages/simulator/docs/`: genesis, scenarios, verification, pack conformance, CLI.
- Cross-wave authority: `docs/clockgrove-cloudflare-implementation-plan.md`, the Wave 1 plan in `docs/waves/`, and `docs/adr/clockgrove-adr-actor-decision-ladder.md`.
- The closed-world resource decision: `docs/clockgrove-documentation-index.md` (section "Closed-world resource decision").

Those documents win over this page.

## Rules

- **The kernel is pure.** No clock, entropy, environment or I/O; return typed refusals instead of throwing. Replay, scenario goldens and Node/Workers parity all depend on it.
- **Mutation goes through typed commands.** A world change enters through the executor and is committed through the journal (`executeWorldCommand`). Never mutate canonical state from UI reducers, model or tool callbacks, Durable Object memory, cron handlers or migration scripts; those paths skip validation, attribution and replay.
- **Models propose, the kernel commits.** Revalidate every proposal at commit time, because the actor's perception may be stale. Under the decision ladder, tiers 1 to 3 (reflex, utility, compiled policy) decide the world with no model available, and a decision model only picks among candidates the kernel already made valid.
- **Closed world.** No resource appears from nowhere. Every increase has a journaled cause: rain collection, plant yield, an actor or declared process transfer, or a declared boundary trip. The scenario runner refuses a transition without one (`RESOURCE_CAUSE_INVARIANT`); genesis quantities are declared initial inventory.
- **Randomness is data.** Draw only from named random streams. Persist the serialized state and restore it; never initialize again on restart. Model output is a recorded input, not kernel randomness.
- **Simulation time is not wall time.** Schedules carry simulation deadlines. Catch-up (`catchUpSchedules`) is bounded per call and versioned; chained bounded calls must equal one unbounded call. Compute the next deadline instead of ticking dormant actors. A frozen world must not accrue unbounded catch-up debt.
- **The world can sleep.** Awake and asleep runs must reach the declared same result. An aggregate approximation is declared, engine-versioned and covered by goldens.
- **Spatial identity is semantic.** World, timeline, space, region and object IDs are durable. The loose-quadtree index is rebuildable routing state and Three.js is presentation; neither leaks identifiers into domain contracts.
- **Containment invariants hold.** One canonical placement per object per timeline; no cross-world or cross-timeline edges; acyclic, bounded nesting; possession is not ownership; mobility is not use authorization; concurrent moves resolve to one winner through expected revisions.
- **Rules are bounded data.** Versioned, deterministic, cooldown- and fan-out-bounded, and they emit typed command intents (`evaluateRules`). No arbitrary code in pack data.
- **Platform, not world.** No world-specific branches in the kernel. `worlds/fixture` must keep running unchanged; it is the portability proof.

## Testing

Follow `docs/runbooks/testing.md`: scenario goldens and replay/parity runs prove determinism across every scenario; keep one integration test per claim. Pure, tricky algorithms (canonical hashing, codecs, random streams) may keep unit tests only in the `unitTestAreas` of `scripts/test-budget.json`. Goldens are reviewed artifacts: copy a reviewed `*.actual.json` over the golden yourself (see "Golden review workflow" in `packages/simulator/docs/conformance.md`); the suite never rewrites them.

## Reject

- "The model decides the final state."
- Hidden wall-clock reads or unrecorded randomness in reducers.
- Per-frame canonical writes, or continuously ticking every dormant actor.
- Resource creation without a journaled cause.
- Renderer, index, Cloudflare or provider identifiers in domain contracts.
- Database edits that bypass command and event semantics.

## For a kernel change, state

The command and its authoritative inputs, the invariants, the deterministic transition, emitted events and schedules, replay and catch-up behaviour, the concurrency rule, and the golden or integration test that proves it.
