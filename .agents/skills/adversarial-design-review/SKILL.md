---
name: adversarial-design-review
description: A structured attempt to break a Clockgrove design before it is built. Use before freezing a consequential design, adopting a new framework or provider, changing a durable contract or ADR, or when a proposal looks elegant but may hide authority, failure, scale, scope, privacy or product risks.
---

# Clockgrove Adversarial Design Review

Try to break the proposal while change is still cheap. Attack assumptions, not style. Assume a competent author who may still be wrong.

## Inputs

Read the proposal, the documents it claims to follow (the relevant ADRs, PRD and architecture sections, wave plan and package contract from the Documentation map in `AGENTS.md`), and `architecture-guardian` for the boundaries. Check every claim against those documents, not against memory. Supporting reviews are rationale, not authority (`docs/clockgrove-documentation-index.md` §2).

Start with four questions:

- What must be true for this to work, and which of those things are unproven?
- What happens when each dependency is unavailable, duplicated, stale or slow?
- Which responsibility is still ours after adopting the proposed framework or service?
- What complexity is moved rather than removed?

## Pressure tests

Run the ones that apply.

1. **Product.** Which user outcome improves? Does the current wave need it, or is it "we might need it someday"? Then prefer a seam. Does it drift Clockgrove toward a generic agent framework, game backend or billing system?
2. **Authority.** Draw the fact-ownership map. Look for two writers of one fact, a cache, Durable Object or provider becoming accidental authority, Management writing world truth, a UI, model or tool mutating directly, or tool state leaking into world state. If it is unclear which side wins a disagreement, the design is incomplete.
3. **Failure.** Inject failure at each interruption point in `architecture-guardian`, plus lease or epoch change, partition and partial batch completion. Does any retry duplicate money, messages, objects, actors, genesis, memories or events?
4. **Durability.** What lives only in memory or on local disk? Can a blank process rebuild safely? Are durable IDs independent of runtime instances? Can old history still be read after a schema or provider change?
5. **Scale.** Logical versus active population, hot partitions, fan-out. Can a broad event avoid one write per dormant actor? Where is global coordination hidden? What measured threshold triggers partitioning? A logical population target is not a reason to give every actor a process.
6. **Framework or provider.** What does it delete? Does it add a second state machine, retry or recovery model? Are its durability semantics compatible with ours? Can it sit behind a project-owned adapter? Is its behaviour backed by current primary documentation? What is the way out?
7. **Data model.** Find overloaded concepts. The index §9 terms must stay distinct: workspace versus world membership, principal versus persona versus presence, mobility versus use, attribution versus sponsorship, event versus projection, logical actor versus runtime process, world time versus wall time, desired versus applied lifecycle.
8. **Security and privacy.** Who can forge each identity or permission field? Are trusted fields resolved server-side? Can projection leak private cognition or hidden presence (only `public_scene` enters shared projection)? Can guessed IDs cross a world or tenant boundary? Does an admin or provider role grant in-world power? Is a denial response safe for the caller?
9. **Replay and timelines.** Can the result be rebuilt? Which nondeterministic inputs are recorded? Does replay resend external effects? Can a preview branch leak into live state? Are corrections append-only?
10. **Simplicity.** Propose at least one smaller alternative (logical boundary before a service, an adapter with a fake before a provider integration, a project-owned state machine before a framework). State what it cannot do. If nothing important is lost, prefer it.

## Kill criteria

Recommend rejecting or deferring when the design creates conflicting authority, its recovery cannot be specified, it expands scope without proving the wave outcome, it leaks provider semantics into durable identity, it duplicates an existing retry or durability model, it needs global coordination for a local fact, it cannot be qualified with realistic evidence, or it solves a speculative problem better left as a seam.

## Output

1. Proposal in one sentence
2. What it gets right
3. Hidden assumptions
4. Authority risks
5. Failure and recovery risks
6. Scale and cost risks
7. Product and scope risks
8. Provider and lock-in risks
9. Smaller alternative
10. Recommendation: accept, accept with changes, defer, or reject
11. Changes required before implementation
12. Evidence that would prove the review wrong

Do not recommend building competing architectures side by side unless an experiment is explicitly wanted and has a bounded decision criterion.
