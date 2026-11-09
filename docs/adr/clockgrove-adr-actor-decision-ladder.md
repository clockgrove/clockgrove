# ADR: Actor Decision Ladder

**Status:** Accepted  
**Version:** 1.0  
**Date:** November 07, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.10, [raccoon-world-cloudflare-implementation-plan.md](https://github.com/clockgrove/raccoon-world/blob/main/docs/raccoon-world-cloudflare-implementation-plan.md) v3.12, and implementation Waves 1, 5, 6, 7 and 8
**Scope:** How an actor's decisions move from deterministic tiers to model tiers, and the bounded decision-model tier between compiled policy and open-ended LLM cognition

---

## Context

Wave 1 §5.7 orders routine choices as reflex, then utility scoring, then an LLM planning request for policy-declared ambiguity or novelty. Wave 6 §12.2 adds compiled policy: learned `SKILL.md` compiled to a bounded policy that decides without a model call. Between compiled policy and an open-ended LLM run there was no middle step. Many questions that reach the LLM are a pick among options the kernel already made valid: which of two close-scoring routines, whether a wake is worth a turn, which belief a perception bears on. An open-ended LLM run is slow and costly for that. A bounded decision call (a Choice, Score or Boolean over given options, for example through Vercel AI Gateway's decisions endpoint) answers in about 150 ms for fractions of a cent. Issue 76 tracks validating such models.

The owner decided on 2026-11-07 to adopt the actor decision ladder below as Clockgrove's actor decision design.

## Decision

### 1. Five tiers, each able to abstain to the next

| Tier | Where | What it decides |
| --- | --- | --- |
| 1. Reflex | Kernel, deterministic | Invariants and reflexes (Wave 1 §5.7) |
| 2. Utility scoring | Kernel, deterministic, per tick | Bounded utility over valid candidates ([utility decisions](../../packages/kernel/docs/utility-decisions.md)) |
| 3. Compiled policy | Deterministic, no model call | Learned `SKILL.md` compiled to a bounded policy (Wave 6 §12.2) |
| 4. **Decision model** (new) | Bounded model call | A Choice, Score or Boolean among options the kernel already made valid |
| 5. LLM cognition | Open-ended model run | Speech, novel plans, authoring, conversations |

A tier that cannot decide abstains, with its reason recorded, and the next tier takes the question. A lower tier never needs a higher one to run: tiers 1 to 3 decide the world alone when no model is available.

### 2. Decision points are declared in actor policy

A decision point is pack data in actor policy (Wave 5 §5.1). It declares:

- **trigger:** a score margin, a policy-declared ambiguity, or a gate (for example wake triage);
- **candidate source:** always the kernel's valid candidate set; the model never adds an option;
- **features shown:** the declared features of each candidate, nothing else;
- **model alias:** a configured alias (Wave 5 §10), never a provider/model string in code;
- **confidence threshold:** below it the answer is not used;
- **budget:** calls and spend per actor and per world;
- **deterministic fallback:** the pick used when the model abstains, falls below threshold, exceeds budget or is unavailable (for routine ambiguity, utility's top pick).

### 3. Invariants

- **Models propose, never commit.** Every decision-model answer is journaled as cognitive evidence (decision point, candidates, features, alias, label, confidence, latency, cost). Any command it leads to passes the ordinary validator and Journal, like every other proposal.
- **Replay reads the journal.** Replay and verification never call a model; they read the recorded answer.
- **Models-unavailable continuity.** With models off or failing, every decision point takes its deterministic fallback and the world keeps running.
- **Deterministic stays deterministic.** Kernel per-tick physics and utility, rules, belief-update policy, and grants, authorization and approvals never go through a decision model.
- **Repeat-signature escalation.** Each decision records a signature. A signature labelled ignorable or flaky twice goes to a human or a deterministic check, not to a third model call (the lesson from issue 80).

### 4. Learning loop: the world gets cheaper

Logged decision-model choices, with their features, are training data for Wave 6's compiler. It may distill a stable pattern into deterministic compiled policy (tier 3), so actors form habits and repeat decisions stop costing a model call. Distilled policy is governed like any other compiled policy: source citation, governed adoption, invalidation, abstention and shadow comparison (Wave 6 §12.2).

### 5. Where the decision model fits, and where it does not

Fits:

- ambiguity among valid options, such as close utility scores or policy-declared ambiguity (the first shadow experiment);
- tier gates: wake triage (is this wake worth an LLM turn) and the compiled-policy novelty check;
- conversation-turn decomposition: intent, then capability, then target, with the LLM writing only the speech;
- classification: salience, belief relation, moderation;
- consolidation steps in dreaming (§6);
- social reactions (Waves 6–8).

Does not fit:

- the per-tick kernel loop;
- open-ended generation (speech, plans, authoring);
- authority of any kind (grants, approvals, authorization).

### 6. Dreaming uses the same ladder

Dreaming and consolidation (PRD §12.10, Wave 6 §11) is mostly bounded decisions, so most of its steps are decision points:

| Consolidation step | Decision shape |
| --- | --- |
| Episode keep or decay | Score |
| Clustering | Choice of theme |
| Evidence against a belief | Choice of supports, contradicts or unrelated; the belief-update maths stays deterministic |
| Relationship shift | Choice of warmer, cooler or unchanged; the update follows deterministic policy |
| Surprise or unresolved goal | Boolean or Score |
| Is this repeated behaviour worth a skill? | Boolean |

The LLM (tier 5) writes only the summaries and `SKILL.md` drafts, and repairs genuinely contradictory memories. This follows the PRD §10.4 routing rule: low-consequence classification, salience and memory-candidate selection use the least expensive qualified route, and a routing LLM is not required.

Dreaming is also where the learning loop of §4 runs: consolidation distills logged decision-model choices into compiled policy. The §3 invariants apply unchanged: every output is journaled, exact replay reuses the recorded outputs, each decision point has a deterministic fallback, and dreaming never rewrites canonical world truth or silently alters old evidence.

## Rollout

Shadow mode first. The first decision point runs beside today's path: the decision model's pick is journaled and compared, and never changes the physical decision. Judgement, cost and latency numbers are reported on issue 76 before any default changes. The owner decided on 2026-11-09 (issue 115) to hide utility scores and ranking from the decision request: the model receives actor state and declared candidate features in score-independent order. Utility agreement is a comparison, never accuracy; reports separate cases whose top-two utility gap is within the declared margin from other cases. Accuracy is measured separately against a small authored reference set of ambiguous fixture situations, each with an expected pick and a one-line reason withheld from the model. Unknown model costs remain unknown and are counted. The [runtime runbook](../runbooks/runtime.md) documents the bounded offline shadow command. Shadow mode remains in force until the owner reads these numbers. The implementation Objective is [issue 92](https://github.com/clockgrove/clockgrove/issues/92) (decision-model tier, `decide` port and shadow-mode ambiguity decisions).

## Ownership

| Workstream | Capability |
| --- | --- |
| Wave 1 | Planning requests on ambiguity may first go to a policy-declared decision point, with deterministic fallback (§5.7 amendment) |
| Wave 5 | Actor policy declares decision points; `ModelGateway` gains `decide` (§5 and §10 amendments) |
| Wave 6 | Distillation of decision-model choices into compiled policy; the novelty check may be a decision point (§12.2 amendment); consolidation steps run as decision points and dreaming runs the distillation (§11 amendment) |
| Waves 6–8 | Social-reaction decision points, each behind shadow evidence first |

## Consequences

- Every existing wave acceptance stays as written. This decision adds a tier; it removes none and changes no checklist.
- The `ModelGateway` port gains a bounded `decide` request beside `stream` and `generateObject`, with a scripted decider for tests.
- No decision point changes behaviour until its shadow numbers are read and the owner changes the default.
- This acceptance does not start an Objective, call a provider or activate a deployment.
