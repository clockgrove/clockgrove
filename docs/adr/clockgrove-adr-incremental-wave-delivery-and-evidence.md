# ADR: Incremental Wave Delivery and Proportionate Evidence

**Status:** Accepted  
**Version:** 1.0  
**Date:** October 01, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.8, [clockgrove-cloudflare-implementation-plan.md](../clockgrove-cloudflare-implementation-plan.md) v3.9, and implementation Waves 0–12
**Scope:** Delivery ordering, Objective acceptance, early product checkpoints, and qualification evidence

---

## Context

The original wave plans describe substantial cumulative capabilities. Foundation delivery now includes real contracts, a pure kernel seam, and a PostgreSQL journal; subsequent work should consume those accepted implementations rather than rebuild scaffolding. Product feedback must arrive before the complete neighborhood, and required cognitive documents, bounded compiled policies, external observations, and actor research need explicit implementation ownership.

Plans must also avoid two failures: comparisons that mistake incidental evidence differences for product failures, and release plans whose parallelism or expanding scope costs more than it proves.

## Decision

### 1. Waves are substantial sequential workstreams

Waves 0–12 remain the canonical sequence and retain their full exit obligations. A wave contains numerous Objectives, and an Objective contains the Work Items needed for one complete, testable capability. A wave is neither one giant Objective nor a release per Work Item.

The detailed work packets describe responsibility and dependencies. They are inputs to Objective planning, not an instruction to create one Objective per packet or to freeze the original packet boundaries forever. Group closely related implementation, tests, and integration into a capability with one owner and a declared acceptance surface. Split when ownership, evidence, resources, or a real dependency requires it.

Advance the ordinary path first: deterministic world behavior, durable commits, runtime ownership, observation and Why, durable conversation, recognizable learning, and safe authoring. Complete broader scenarios within their owning wave. Do not promote unusual compounded outages, extra polish, or newly imagined cases into an earlier checkpoint's critical path.

GitHub Issues and PRs record current scheduling, approved Objective scope, dependencies, acceptance, and exact evidence. Repository plans describe contracts and delivery order, not a second live status board. Completed child Issues alone do not prove an Objective; an accepted Objective alone does not prove its whole wave.

### 2. Early checkpoints expose the product thesis

| Checkpoint | Owning workstream | Minimum product proof |
| --- | --- | --- |
| First living yard | Waves 1–4, in sequence | Rain changes hunger/shelter decisions; ordinary journal and runtime paths preserve them; browser selection and a text/Why view explain the causal chain |
| First cognitive actor | Wave 5 | One private attributed Caretaker session uses authorized perception and a bounded real model route to propose an ordinary validated command, with durable evidence and recovery |
| First recognizable learning | Wave 6 | A controlled experience changes a later choice; contradiction revises it; a learned `SKILL.md` yields a governed bounded policy, stable reuse avoids a model call, and novelty or invalidation returns to cognition |
| First safe authored change | Wave 7 | A hand-authored typed changeset is validated, previewed with effect isolation, compared, and reauthorized against the current live head before promotion; natural-language compilation follows |
| Integrated neighborhood | Wave 8 | Earlier checkpoints combine with lifecycle, ecology, art, live external observation, governed actor research, and the complete causal learning/policy trace |

These are intermediate acceptance checkpoints, not replacements for full wave exits or release gates. Extend the tiny non-raccoon, alternate spatial/scene, and `ActorProcess` conformance fixtures as their first consumers arrive; do not build a second engine or discover portability only at GA.

At the first relevant checkpoint, declare the intended audience and hypothesis, evaluation rubric, recording/replay conditions, and cost envelope. Waves 4, 5, and 6 respectively measure understandable observation/Why, useful conversation with truthful disclosure, and recognizable behavior change. Pilot evidence informs scope and later evaluation; it does not silently redefine acceptance after results arrive.

### 3. Readiness and qualification are distinct

Full preceding-wave qualification remains the default entry condition. The following bounded local-development exception is accepted: a named Objective may consume an already accepted subset of a preceding wave before that wave's remaining staging, load, or full release qualification finishes.

Before starting that consumer, its Issue must identify the exact prerequisite capabilities and evidence, the pending wave-exit obligations, the local or isolated test surface, the consumer's acceptance, and the owner of the remaining qualification. This permits only the named subset and does not authorize completing a later wave wholesale in parallel.

For example, pure kernel work can use accepted foundation contracts and deterministic tooling while deployment qualification remains pending. A local projection consumer can use accepted journal and runtime paths while broader runtime load/fault qualification remains pending. The selected path's authorization, privacy, RLS, journal integrity, ownership, and recovery requirements must already pass. A missing safety prerequisite is a blocker, not deferred qualification.

A checkpoint may be implemented, integrated, or locally accepted while its wave remains unqualified. No public activation or release may claim readiness beyond its actual evidence. Full wave and GA requirements remain release blockers at their declared milestone. This decision creates no provider-spend, deployment, publication, or new-target authority.

### 4. Freeze a capability and verify proportionately

Before implementation, declare the capability, owner, source scope, dependencies, acceptance scenarios, explicit non-goals, commands, and applicable resource/provider bounds.

Use focused checks during implementation and repair. Freeze one intended final candidate before coordinated qualification; run the complete applicable gate on that candidate and install its exact passing artifact. A changed source or artifact invalidates evidence that depends on it. Rerun those checks and perform full qualification at the next stable candidate boundary; do not reinstall, invoke live providers, or repeat broad gates after every helper fix.

One qualification owner runs the ordinary acceptance path in a straightforward sequence. Independent review remains required. Parallelize only independent capabilities or checks with explicit ownership and isolated resources, when doing so actually reduces time without obscuring evidence or creating collisions. A dependency diagram permits concurrency; it does not require maximum concurrency or additional work to occupy agents.

Separate ordinary acceptance, fault injection, and capacity scenarios. Record candidate, host, scenario, provenance, actual usage and resource bounds; unknown accounting remains unknown. On failure, preserve identities and evidence, classify the cause, and choose a meaningful correction before a bounded rerun. Do not endlessly rescue a damaged run or let a qualification fixture become the roadmap. Reuse accepted work only when its contract and real evidence still apply.

### 5. Compare the property the gate is meant to prove

| Property | Required comparison |
| --- | --- |
| Immutable artifact, protected baseline contents, accepted commit identity or installed release | Exact identity/digest and provenance |
| Deterministic canonical serialization, prescribed ordering, replay/state hash | Exact contract-defined representation/result |
| A required literal citation | Literal span from the supplied evidence, unchanged |
| Capability outcome, authority/isolation, or preservation through a legitimate rebase | Declared semantic invariants over the relevant inputs, effects, changes, and resulting state |
| Incidental wall-clock times, host paths, transport metadata or unordered completion | Exclude or normalize only fields the contract explicitly declares incidental |

Declare the comparison domain before qualification. A legitimate rebase need not preserve an entire repository tree containing unrelated integrated changes; prove preservation of the accepted change and required behavior, then review and validate the resulting candidate. Never use normalization to hide a substantive difference, relax deterministic ordering, repair a rejected quote, or weaken security, attribution, idempotency, privacy, ledger conservation, or other correctness boundaries.

Evidence proves only its candidate, host, and scenario. Sharing compatible receipts across requirements is useful; relabeling a local/scripted check as cloud/live qualification is not.

### 6. Keep implementation and product decisions small

Retain the two kernels, PostgreSQL authority, opaque logical identities, Management/Runtime separation, and initially modular deployment. Add no service, durable sidecar, sharding layer, vector dependency, general code generator, 3D engine, or recovery framework without a current requirement or measured supported-path need.

Use the supported deterministic database fixture, including an isolated native PostgreSQL fixture where the repository supports it; Docker is not itself the acceptance property. Check current provider/runtime compatibility at the first consumer and pin the chosen supported versions. Freshness review does not mean upgrading working pins to the newest release or importing provider SDK types into shared contracts.

Human-owned choices remain explicit at the first consumer: pilot audience/rubric, simulation-time mapping, model and observation routes within existing authority, cognitive-document size/write/retention and inspection policy, and license before public contributions. Keep existing accepted decisions; request only an actual unresolved product or authority boundary.

## Consequences and retained obligations

Waves remain substantial and mostly sequential, with multiple accepted capabilities before full qualification. Early feedback can change later Objective scope without creating a competing roadmap. The wave-local sequencing notes identify first and subsequent capabilities; detailed packets, failure matrices, full exits, and release requirements remain applicable at their stated milestone.

Waves 0–9 deliver technical/open-source GA. Waves 10–11 are the separate hosted/shared-world continuation. Wave 12 is optional commercial hosting; Redis, money collection, and Stripe do not move onto the earlier product path. No runtime behavior, provider configuration, existing Objective, or release validator changes merely because this planning decision is accepted.
