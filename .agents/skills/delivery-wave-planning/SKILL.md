---
name: delivery-wave-planning
description: How Clockgrove sequences product work into waves, Objectives and exit evidence in clockgrove/clockgrove. Use when amending a wave plan in docs/waves/, writing a factory:objective issue from a wave plan, changing roadmap sequencing, defining exit evidence, or deciding whether a capability belongs in the current wave or only as a seam for later.
---

# Clockgrove Delivery Wave Planning

Clockgrove builds one cumulative path. There are no competing v1/v2 architectures or "try both" experiments on the product path.

## Authority

- `docs/adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md`: what a wave, an Objective and a checkpoint are, readiness versus qualification, how evidence is compared.
- `docs/clockgrove-documentation-index.md` §5 (wave table), §6 (tracks), §10 (baseline revision rule).
- The wave plans in `docs/waves/`, validated by `pnpm run verify:docs`.
- `AGENTS.md`, Delivery record and Validation and completion.

They win over this page.

## The model

- **Tracks:** Waves 0–9 are the technical/open-source track to GA; Waves 10–11 add shared hosted worlds; Wave 12 is optional commercial hosting. Do not relabel waves from an older document.
- **A wave** is a substantial, mostly sequential workstream with numerous Objectives and full exit obligations. It is a qualification boundary, not a sprint.
- **An Objective** is one complete, testable capability with one owner and a declared acceptance surface. The `factory:objective` label goes only on new product work from a wave plan. Gaps, regressions, maintenance, plan amendments and re-qualification are plain `Bug`, `Task` or `Feature` issues.
- **Work packets** (`RW-xxxx` in each plan) describe responsibility and dependencies. They feed Objective planning; they are not one Objective each and their boundaries are not frozen.
- **GitHub is the live status.** Issues and PRs hold scheduling, scope, dependencies and evidence. Plans describe contracts and order, never a second status board.

## Writing an Objective from a plan

Write product intent, not an implementation plan. Include:

- the outcome and its non-goals;
- the owning wave and the packets it draws on;
- observable exit facts, with any required proof stated as part of the fact (an exact value, an independent recomputation, a golden);
- the invariants it must keep;
- its prerequisites, each already on `main`;
- links to the canonical sources;
- open questions only for real material ambiguity.

Leave out likely files, Work Item splits, test design and evidence layouts; they go stale and stop the implementer planning against the code as it is. Set native type and exactly one priority as `AGENTS.md` requires. Put every decision in the issue body before applying the label.

## Readiness

Full qualification of the preceding wave is the default entry condition. The ADR §3 allows a named Objective to consume an already accepted subset of an earlier wave; its issue must name the exact prerequisites and evidence, the pending wave-exit obligations, the test surface and who owns the remaining qualification. A missing safety prerequisite (authorization, privacy, RLS, journal integrity, recovery) is a blocker, not deferred qualification.

Parallelize only independent capabilities with isolated resources. A shared contract that is still moving gets one owner.

## Seam versus premature feature

Ask: what must be true now so the later capability does not force a rewrite of durable identity or canonical history? Build that seam and nothing more. Examples from the plans: renderer-neutral spatial contracts before full 3D; the `ActorProcess` contract before long-running actors; attribution fields before billing; Management/Runtime messages before physical separation.

Before adding work to the current wave, ask whether it proves this wave's outcome, keeps an accepted later capability possible, or is just attractive infrastructure that a fixture, fake or adapter could stand in for. Billing, provisioning and social complexity stay out until the runtime needs them.

Distinguish a **sequencing non-goal** (not yet, but preserved) from a **permanent invariant** (disallowed unless an ADR reopens it). Full 3D is deferred; cross-world live object portability is out of scope by decision.

## Exit evidence

Never exit on "code merged" or on closed child issues. Use the plan's exit checklist and the ADR's comparison rules: exact comparison for artifacts, deterministic serialization, replay hashes and literal citations; declared semantic invariants for capability outcomes. Keep implemented, integrated, locally accepted and fully qualified evidence distinct in GitHub. A checkpoint is not a release.

## Changing the plan

1. Decide whether product intent changed or only ordering.
2. If semantics changed, update the controlling ADR, PRD or architecture first.
3. Update every affected wave plan, not only the current one, and the index version table (index §10).
4. A wave plan never silently overrides an accepted cross-cutting ADR.

## Anti-patterns

Vague mega-packets ("implement memory"), parallel competing architectures, exits proven only by a happy-path demo, building billing or provisioning before the runtime is qualified, and using a later wave to excuse a shortcut that corrupts an earlier durable contract.
