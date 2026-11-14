---
name: architecture-guardian
description: Clockgrove's architecture boundaries and how to design within them. Use when proposing or changing authority, persistence, durable identity, provider placement, concurrency, recovery, scaling, or any cross-package or cross-plane design in clockgrove/clockgrove, and when deciding whether a change needs an ADR.
---

# Clockgrove Architecture Guardian

Architecture here exists to keep semantics intact under failure, scale and provider replacement. Prefer the smallest design that keeps the invariants.

## Read the owning authority first

Resolve authority in the order of `docs/clockgrove-documentation-index.md` §2: accepted ADRs in `docs/adr/`, then the PRD (`docs/clockgrove-prd-v0.5.md`), then the architecture plan (`docs/clockgrove-cloudflare-implementation-plan.md`), then the current wave plan in `docs/waves/`. Then read the package contract from the Documentation map in `AGENTS.md`. Where this skill and those documents differ, they win. If they conflict with each other, surface the conflict; do not pick the convenient one.

## Start with authority, not technology

For every new fact or state transition, name:

- the fact and its single authoritative owner;
- its durable identifier, independent of runtime placement or provider IDs;
- the revision, fencing or idempotency key when retries or concurrency matter;
- the source it is rebuilt or reconciled from;
- the typed command that changes it.

Reason: two systems that can each claim the same fact will eventually disagree, and nobody can say which one is right.

## Boundaries to preserve

The full list is `docs/clockgrove-documentation-index.md` §7. The ones most often broken:

- **Models and tools propose; typed authorized application paths mutate.** No untyped shortcut to canonical state.
- **PostgreSQL is canonical world history.** Durable Objects, queues, workflows, caches, indexes, Redis and browser state are execution or rebuildable projection.
- **Management Plane and World Runtime Plane stay separate**, even inside one deployable. Management never writes world truth; Runtime never holds payment-provider state (see the Management/Runtime ADR).
- **Logical identity is not placement.** An actor or object does not imply a resident process, model call or Durable Object; a runtime instance ID is diagnostic only.
- **Provider identity is not domain identity.** Provider SDK types stay behind project-owned adapters and composition roots (`AGENTS.md`, Product and capability boundaries).
- **The platform is world-agnostic.** Platform code names no world except `worlds/fixture`; `scripts/world-boundaries.json` enforces the identifiers.
- **Development tools are external.** `clockgrove/factory` may operate the repository but is never a build or runtime dependency.

## Logical before physical

A logical boundary does not need a service boundary. Reach first for a package, schema, adapter, check or test boundary. Add a service, database, queue or sidecar only when availability, scale, credential isolation, transactional semantics or deployment cadence actually require it, with measured evidence. The incremental-delivery ADR §6 lists what not to add without a current requirement.

## Provider placement

Cloudflare, PostgreSQL, model providers, auth providers, Stripe and renderers are implementations at named seams. Before a provider concept enters a durable contract, ask:

- Is it intrinsic to Clockgrove semantics, or one provider's shape?
- Could another provider implement the same contract?
- Would replay, export and local operation still make sense without it?
- Does it remove a responsibility, or add another overlapping state or retry model?

Use a provider's native feature when it truly deletes our responsibility; keep the semantics outside its objects. For protocols, formats and codecs, follow the Dependencies rules in `AGENTS.md` (existing SDK or library first; an ADR for any hand-written exception).

## Failure-first design

For each write or external-effect path, walk the interruption points:

1. before the authoritative commit;
2. after commit, before dispatch or response;
3. after an external side effect, before acknowledgement;
4. duplicate or reordered delivery;
5. stale work after a revision, lease or routing change;
6. process, host or provider loss;
7. rebuild and reconciliation.

State for each operation whether it is idempotent, deduplicated, fenced, reconciled, deliberately at-most-once, or explicitly unknown. An unknown remote outcome needs reconciliation, not an optimistic retry.

## Scaling

Work should scale with activity, not population: dormant logical actors, sparse schedules, aggregation, rebuildable indexes, and partitioning only at a measured threshold. One million logical actors per world is a qualification target; active, visible and cognitive work stays bounded. No global ordering or lock for a locally scoped fact.

## Design checklist and ADRs

Every change answers the six questions in `docs/runbooks/design-checklist.md` (authority, growth, attribution, hot-path cost, test independence, sourced numbers) before code and again at handoff.

Write an ADR in `docs/adr/` (validated by `pnpm run verify:docs`) when a change alters authoritative ownership, durable identity, the Management/Runtime split, replay or memory semantics, provider dependency posture, consistency or fencing, recovery, public compatibility, or another invariant in index §7. Follow the baseline revision rule in index §10 so every affected document moves together. Ordinary local implementation choices need no ADR.

## Output

For a design or review, state: the owning authority and documents, fact owners and durable IDs, state and evidence flow, failure and recovery behaviour, provider-specific versus semantic parts, scaling implications, the simpler alternatives considered, documents that must change, and the evidence that would prove it. End by naming the smallest architecture that keeps the invariants.

For a hostile pass over a finished proposal, use `adversarial-design-review`.
