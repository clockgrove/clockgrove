# Clockgrove Wave 7: Rules, Preview Timelines, and Conversational Authoring

**Status:** Coding-agent implementation specification  
**Version:** 1.8  
**Date:** October 19, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Wave:** 7 of 13  
**Assumptions:** Waves 0–6 are qualified; physical and cognitive replay are stable  
**Development tooling:** external tools such as `clockgrove/factory` may execute this wave; their planning state and product preview timelines are distinct authorities and data planes.  

---

## 1. Outcome

Wave 7 implements the safe live-authoring thesis: deterministic rules, first-class preview timelines, branch-local simulation/cognition, external-effect isolation, typed natural-language changesets, semantic/visual diff, fast-forward, rebase, and intent-only promotion.

The wave exits only when:

> An authorized creator can ask Clockgrove to add or change a world behavior, inspect assumptions and typed operations, validate it, run it in an isolated accelerated preview, talk to branch actors, compare causal consequences, resolve live-head conflicts, and promote only newly authorized intent—without copying synthetic history or sending preview effects.

Natural language is a compiler input and collaboration surface, never database authority.

Preview branches include branch-local world memberships, personas, persona inventories, containment, possession, and mobility-policy revisions. Objects inherited at fork retain their logical IDs on the branch; branch-created objects do not exist on live or sibling timelines. Promotion reapplies authorized semantic intent and never copies branch inventory state, custody history, or synthetic transfer events into live.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First deliver a hand-authored typed `WorldChangeSet` through validation, preview isolation, deterministic consequence inspection/diff, current-live-head revalidation and authorized promotion. Prove this path before using a model as the authoring compiler.

Then add natural-language compilation and compare its usefulness/error rate with structured editing under a predeclared rubric. Complete broader triggers/rule reactions, branch-local cognition/inventory, fast-forward, retention/export and all scenarios through later Objectives. Extend the tiny agency/conformance fixture as these contracts gain consumers.

A legitimate semantic rebase need not preserve unrelated repository or live-world state byte for byte. Preserve accepted intent and revalidate authority and current invariants; exact replay, canonical ordering, effect isolation and the prohibition on copying synthetic preview results remain mandatory.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 6 qualification manifest is green.
- Canonical physical and private cognitive streams snapshot, replay, branch, migrate, and hash correctly.
- WorldDO branch-barrier and typed Workflow skeletons are available.
- World packs expose versioned entities, archetypes, components, systems, rules, assets, anchors, and policy references.
- Inspector can traverse events, decisions, runs, memories, capabilities, and projection revisions.
- Web shell contains operator-only timeline/authoring placeholders.
- Preview effect policy and fake channel/MCP sinks exist.

Amended (2026-10-19): Wave 2 does not deliver branching. The timeline and fork foundation (Wave 2 §10), multi-partition head vectors and experimental re-execution (Wave 2 §9.3) are built in this wave, next to preview branches. Wave 2 provides `live` and `branch` timeline kinds and exact or diagnostic replay of one partition. Migration comes from RW-0209 in Wave 3.

Amended (2026-10-19): Wave 3 does not stub the WorldDO branch barrier or the authoring and pack-upgrade Workflows. This wave builds them, as their first consumer; Wave 3 delivers only the provisioning, readiness and catch-up Workflows.

---

## 3. Fixed authoring and timeline invariants

1. A live timeline remains canonical until typed commands commit.
2. Rule evaluation is deterministic at pinned version and input order.
3. Every firing has causal identity, dedupe, budget, and evidence.
4. Preview timelines have independent events, schedules, actors, sessions, cognition, PRNG state, and projections after the fork.
5. Preview timelines cannot access live credentials or send live effects by default.
6. Fast-forward uses the same kernel and declared aggregation policy.
7. Promotion never copies preview event history, model/tool results, messages, memories, or deliveries.
8. Promotion recompiles/revalidates semantic intent against the current live head.
9. Conflicts are typed and visible; no last-write-wins semantic merge.
10. Creator/operator authority remains separate from ordinary actor/player influence.

---

## 4. Owned code and configuration

```text
apps/runtime/src/rules/
apps/runtime/src/timelines/
apps/runtime/src/authoring/
apps/runtime/src/workflows/authoring/
apps/web/src/rules/
apps/web/src/timelines/
apps/web/src/authoring/
apps/web/src/diff/
packages/contracts/src/rules/
packages/contracts/src/timelines/
packages/contracts/src/changesets/
packages/contracts/src/diff/
packages/application/src/rules/
packages/application/src/timelines/
packages/application/src/authoring/
packages/application/src/promotion/
packages/domain/src/rules/
packages/persistence/src/timelines/
packages/persistence/src/branches/
packages/authoring/
packages/testkit/src/rules/
packages/testkit/src/branches/
packages/testkit/src/authoring/
world-packs/fixtures/mirror-room/
tests/evals/authoring/
tests/security/preview/
docs/protocols/{rules,timelines,changesets,promotion}.md
```

The authoring package emits typed domain contracts. It cannot write PostgreSQL, DO storage, R2, or world-pack files directly.

---

## 5. Rule model

### 5.1 Typed rule definition

```ts
interface RuleDefinition {
  ruleId: RuleId;
  version: number;
  enabled: boolean;
  scope: RuleScope;
  trigger: RuleTrigger;
  bindings: BindingSpec[];
  condition?: ExpressionAst;
  actions: RuleAction[];
  priority: number;
  cooldown?: DurationSpec;
  budgets: RuleBudgets;
  effective: EffectiveRange;
  policyVersion: string;
}
```

Triggers:

- semantic event pattern;
- geofence/portal enter/leave/dwell;
- simulation schedule/calendar;
- threshold crossing with hysteresis;
- explicit authorized invocation.

Expressions are pure, typed, bounded, and deterministic. They cannot call models, network, MCP, wall clock, unseeded randomness, or arbitrary code.

Actions emit typed commands, schedules, rule-control operations, actor activation requests, notifications/delivery intents, or Workflow starts. Every action passes ordinary authorization/kernel/capability validation.

### 5.2 Ordering and budgets

At one causal point, firings order by event sequence, priority, rule ID, binding key, and action index. Persist firing identity and input hash before asynchronous reaction.

Enforce per-firing/per-root limits for actions, fanout, causal depth, wall/sim horizon, actor/model/tool wakes, delivery intents, and cost. Cooldown, hysteresis, cycle detection, local disable, world kill switch, and global kill switch are outside model text.

---

## 6. Durable rule reaction

Post-commit world-reaction dispatch resolves candidate rules from versioned indexes, evaluates against the event-time projection and scope, writes firing/suppression evidence, and submits resulting commands with causal IDs.

Duplicate Queue delivery resolves to the same firing ID and dispositions. A crash after command commit queries the receipt before retry. A rule may not read a later projection while claiming it evaluated the earlier event.

Inspector shows source definition/version, trigger event, bindings, condition values, budget/cooldown/cycle decision, proposed actions, command receipts, and descendant causal tree.

---

## 7. Timeline fork barrier

### 7.1 Barrier procedure

1. authorize fork and reserve branch budget;
2. ask WorldDO to begin a barrier at declared live head;
3. drain/mark in-flight physical and cognitive commits to a stable partition-head vector;
4. capture world/timeline policy, world-pack/schema versions, named PRNG state, schedules, projections, private cognitive stream heads, actor/runtime placements, and asset manifest;
5. create immutable fork manifest and base snapshot references;
6. create preview timeline identity and effect policy;
7. release live barrier;
8. hydrate branch actors/spaces lazily from base plus overlay.

The live world pauses only for bounded barrier work. Failure creates no partial usable branch.

### 7.2 Branch identity

Logical entity IDs remain stable across timelines; every address and key includes timeline ID. Branch-created entities use new IDs. External references must include timeline. UI never shows a preview entity as live without a prominent timeline state.

---

## 8. Branch storage, replay, and cognition

Store base snapshot/fork manifest plus branch-local append-only event/cognitive streams, projections, schedules, dispatch/effects, runs, sessions, artifacts, indexes, and snapshots.

Replay modes:

- exact: replay recorded canonical events only;
- diagnostic: replay with extra invariant/trace output and no semantic change;
- experimental: re-execute policies/models/rules from a declared base, producing a new timeline.

Preview actor sessions, beliefs, relationships, memories, skills, heartbeats, and promises are timeline-local. No branch cognition leaks into live retrieval. Branch model/tool activity uses branch budgets and isolated/simulated effects.

---

## 9. Preview effect isolation

Default preview policy:

- external MCP writes blocked or simulated;
- outbound messaging delivered only to an isolated preview inbox;
- emails/Slack/messages never sent to real recipients;
- webhooks and external callbacks use fixtures;
- production credentials are unavailable;
- read-only external context may use captured/pinned data or explicitly authorized current data;
- model calls are allowed within preview budgets and labeled nondeterministic inputs;
- replay never re-dispatches recorded results.

Adversarial tests attempt credential reference guessing, provider-ID substitution, nested tool calls, redirects, channel binding reuse, approval replay, and promotion-time effect smuggling.

---

## 10. Changeset schema and compiler

### 10.1 Changeset

```ts
interface WorldChangeset {
  changesetId: ChangesetId;
  source: AuthoringSource;
  base: TimelineRevisionRef;
  intentSummary: string;
  assumptions: Assumption[];
  questions: ClarificationQuestion[];
  operations: ChangesetOperation[];
  requiredGrants: GrantRequirement[];
  expectedEffects: ExpectedEffect[];
  risks: AuthoringRisk[];
  validation: ValidationResult[];
  compiler: VersionRef;
}
```

Typed operations include create/update/remove entity/component/relationship/rule/schedule/space/portal/asset binding/policy reference; move with occupancy handling; seed resource/environment; and import world-pack fragment.

Operations use IDs and symbolic references resolved against a declared base. They never contain raw SQL, arbitrary TypeScript, prompt-as-rule, provider credentials, or unvalidated executable expressions.

### 10.2 Compilation

1. classify request and authority;
2. retrieve authorized world/schema/archetype/rule context;
3. identify ambiguity and assumptions;
4. generate typed changeset through structured output;
5. normalize and validate schemas/references/invariants/grants/budgets;
6. run static rule/cycle and spatial checks;
7. produce human-readable semantic summary and questions;
8. require creator confirmation where policy says;
9. create preview and apply via ordinary commands;
10. retain run/evidence/citations.

Compiler output is untrusted until all validators pass.

---

## 11. AuthoringWorkflow

```text
requested
  → compiling
  → clarification_wait
  → validating
  → preview_creating
  → preview_applying
  → preview_ready
  → review_wait
  → rebasing
  → promotion_wait
  → promoting
  → completed

terminal: rejected | cancelled | failed | expired | conflicted
```

Each step is idempotent, durable, evidence-linked, resumable across deployment, and cancellable. Human waits use explicit Workflow events. A failed/expired workflow leaves preview data governed by retention and never half-applies live intent.

---

## 12. Fast-forward and comparison

Preview controls support pause/resume, declared speed, step-to-next-material-event, step-to-time, bounded fast-forward, and cancel. Acceleration uses the same exact/aggregate kernel semantics and honors model/tool/rule budgets.

Comparison layers:

- semantic changeset diff before simulation;
- structural world/entity/component/rule diff;
- visual scene overlay/split/ghost diff;
- event and causal-tree diff;
- population/resource/environment metrics;
- actor decision/memory/relationship divergence;
- schedule and expected-consequence diff;
- cost/nondeterminism/effect-simulation report.

The UI distinguishes intended operations, observed simulated consequences, and model-generated hypotheses.

---

### 12.1 Counterfactual Why

After the ordinary typed preview/diff path passes, deliver one complete capability Objective for supported deterministic kernel utility or bounded compiled-policy decisions. Reproduce the recorded pre-decision baseline from its captured physical/cognitive inputs, manifest, evaluator/policy/document versions, clock and named random state. Change one schema-validated hypothetical input; keep the rest fixed and show compared candidates/features/results.

Use existing scoped preview/evaluation authority and branch-local evidence. Capture source decision, baseline/input hashes, intervention, versions, result and budget disposition. One selected input receives one bounded comparison; unchanged results are valid. Missing/deleted/unauthorized/incompatible inputs or unsupported interventions/evaluators return explicit unavailable/unsupported states, and baseline mismatch fails rather than inventing an explanation.

Authorize source inspection and preview execution separately; hypothetical input cannot widen authority or reveal hidden cognition. Label actual versus hypothetical results in both visual and text Why views, with the evaluator's limited scope. No hidden-model-reasoning claim, fresh-model counterfactual search or automatic multi-variable sweep is required. Outbox effects and guide sharing remain isolated; synthetic history or memories never enter live canon or promotion. See the [accepted topic ADR](../adr/clockgrove-adr-field-guides-and-counterfactual-why.md).

## 13. Rebase and promotion

Promotion starts from semantic operations and declared intent, not branch history.

Procedure:

1. compare changeset base to current live head;
2. classify conflicts: deleted/moved/modified reference, occupancy, rule/policy incompatibility, permission, asset version, schema migration, world-pack change, budget;
3. automatically re-resolve only safe identity-preserving references;
4. ask creator for semantic conflict choices;
5. compile a new candidate against current live state;
6. validate and optionally create a new preview;
7. authorize exact live operations;
8. submit fresh commands to Journal;
9. record promotion case linking branch evidence but copying none of its synthetic outcomes;
10. schedule/deliver live effects only from newly committed live events.

### 13.1 World-pack upgrades and reusable exports

An installed world pack is immutable provenance, not a mutable directory. A pack upgrade pins a new `WorldPackArtifactRef`, compiles its migrations into a typed changeset, previews that changeset against the current live head, surfaces semantic conflicts, and promotes only freshly authorized commands. The prior installation hash remains inspectable forever; promotion records the new applied installation and migration receipts.

World-local authoring does not silently edit or republish the source pack. A creator may explicitly export a reviewed changeset or branch as a reusable pack fragment/source patch with dependency, license, provenance, schema, and migration metadata. Publishing that artifact is a separate review and signing action.

---

## 14. Authoring web experience

Add an operator/creator workspace without displacing the living-world view:

- natural-language authoring input and source attachments;
- mode/authority disclosure;
- assumptions and clarification questions;
- typed operation list with entity/rule/spatial references;
- validation errors and required grants;
- create preview, branch label, status, budget, TTL;
- fast-forward controls and material-event feed;
- talk to branch actors using branch-scoped sessions;
- scene overlay/split view and semantic/causal diff;
- approve/reject/revise/rebase/promote;
- immutable audit/history and export.

Ordinary observer/caretaker influence remains in the entity rail and cannot silently enter operator authoring.

---

## 15. Evergreen agency conformance fixture

Add a tiny non-raccoon `mirror-room@1` world pack used in tests, not as the primary demo:

- an inanimate clue with inspectable physical traces;
- a reactive grandfather clock with deterministic state;
- a cognitive magic mirror with perception, memory, goals, and disclosure policy;
- one interpreted nonsentient room/object surface;
- partial witness observations and one fixed causal event;
- a rule that can destroy a noncritical clue while preserving a solvable path;
- preview branch used to test alternate investigator action.

The fixture proves inspection, reaction, cognition, interpretation, evidence, deception, and branching remain engine-level capabilities rather than raccoon-specific code. It does not require a complete murder-mystery game in this wave.

---

## 16. Detailed work packets

### RW-0701 — Rule AST and evaluator

Implement schemas, pure expressions, typed bindings, event/geofence/schedule/threshold triggers, deterministic ordering, static validation, golden evaluation, and authoring serialization.

Exit: pinned inputs always produce the same firing candidates and actions.

### RW-0702 — Durable rule reactions

Implement indexes, Queue dispatch, firing identity/evidence, dedupe, command submission, cooldown/hysteresis, fanout/depth/cost/cycle limits, local/world/global kill switches, and inspector.

Exit: duplicates/crashes/loops reach one bounded inspectable disposition.

### RW-0703 — Timeline fork barrier

Implement WorldDO barrier, partition/cognitive head vector, snapshot/fork manifest, PRNG/schedule/policy capture, identities, failure cleanup, and bounded pause evidence.

Exit: branch base is a consistent physical+cognitive cut and live resumes safely.

### RW-0704 — Branch storage and replay

Implement base+overlay persistence, branch-local events/projections/schedules/cognition/sessions/runs/indexes, lazy hydration, snapshots/hashes, exact/diagnostic/experimental modes, TTL/export.

Exit: live and branch diverge independently while exact replay matches each timeline.

### RW-0705 — Preview isolation

Implement effect policy, credential exclusion, fake MCP/channel sinks, budget/TTL, captured external reads, approvals, adversarial leakage suite, and operator kill switch.

Exit: no preview or replay path can reach a protected live effect.

### RW-0706 — Changeset schema and compiler

Implement typed operations, assumptions/questions, structured model output, schema/reference/spatial/rule/grant validation, normalization, citations, risk summary, and deterministic fixture compiler.

Exit: ambiguous or invalid intent cannot become an applicable changeset without explicit resolution.

### RW-0707 — AuthoringWorkflow

Implement compile/clarify/validate/preview/apply/review/revise/rebase/promote states, waits, retries, cancellation, expiry, deployment compatibility, evidence, and web status.

Exit: every crash/wait resumes safely with no partial live application.

### RW-0708 — Semantic/visual diff and fast-forward

Implement time controls, bounded acceleration, structural/semantic/event/visual/cognitive metrics, split/overlay UI, nondeterminism/effect report, comparison export, and one bounded counterfactual Why path as in Section 12.1.

Exit: creator can distinguish intended edit from simulated consequence; a supported deterministic decision reproduces its baseline and shows the declared changed-input comparison without live or private leakage.

### RW-0709 — Promotion and rebase

Implement current-head validation, typed conflicts, safe reference resolution, revised preview, fresh authorization/commands, immutable pack-upgrade installation receipts, explicit reusable-fragment export, intent-only promotion record, and no-history/effect-copy proofs.

Exit: all live mutations arise from newly validated current-head commands.

### RW-0710 — Authoring qualification

Run pond, street buffer, occupied move, death successor, rule loop, live-head conflict, branch cognition, effect leakage, and `mirror-room@1` conformance scenarios.

Exit: publish Wave 7 qualification manifest and satisfy the outcome.

---

## 17. Dependency graph and bounded execution

```text
RW-0701 ─ RW-0702 ────────────────────────────────┐
RW-0703 ─ RW-0704 ─ RW-0705 ────────────────┐     │
RW-0706 ─ RW-0707 ─ RW-0708 ─ RW-0709 ──────┴─────┼─ RW-0710
```

Safe lanes: rule AST/evaluator; branch persistence; isolation security harness; changeset compiler; authoring UI/diff fixtures; mirror-room world pack. Freeze rule, timeline, changeset, and promotion contracts before dependent work.

---

## 18. Test and qualification strategy

```text
pnpm test:rules
pnpm test:timelines
pnpm test:preview-security
pnpm test:authoring
pnpm test:promotion
pnpm test:e2e:authoring
pnpm test:world-pack:mirror-room
pnpm eval:authoring
pnpm qualify:wave7:staging
```

Required scenarios:

- add a pond and preview ecological/traffic consequences;
- add street-safety geofence/rule with deterministic ordering;
- move an occupied den and surface semantic conflict;
- change death successor policy without rewriting existing history;
- mutually triggering rules hit budgets and kill switch;
- live head changes during review and requires typed rebase;
- pack upgrade previews migrations, preserves the prior install hash, and promotes a new installation receipt;
- world-local authoring remains local until an explicit reviewed export creates a reusable pack fragment;
- branch actor forms memory and sends only to preview sink;
- promote intent proves no branch memory/message/tool result copied;
- fork before/after random event yields declared PRNG behavior;
- fast-forward and continuous preview reach material equivalence;
- mirror room distinguishes clue inspection, clock reaction, mirror testimony, and interpreted narration.

Authoring eval measures compile validity, clarification quality, unsupported assumption rate, preview success, conflict correctness, promotion safety, task completion time, creator comprehension, and cost.

---

## 19. Failure, security, and recovery matrix

Inject barrier timeout, partition failure, snapshot/R2 failure, branch hydration failure, rule Queue duplicates, rule-loop storm, model compiler interruption, Workflow deploy/wait/cancel, preview credential attack, fake sink failure, fast-forward budget exhaustion, live-head change, promotion crash before/after commit, and retention cleanup interruption.

Assert consistent live head, isolated branch state, idempotent commands/firings, explicit status, safe recovery, zero unauthorized effect, no copied history, complete audit, and reproducible exact replay.

---

## 20. Observability and budgets

Measure rules evaluated/fired/suppressed, causal depth/fanout/cooldown/cycle trips, fork pause/size/duration, branch storage/activation/model cost, preview time advanced, effect blocks/simulations, compilation runs/tokens/validity, clarification count, validation failures, diff size, rebase conflicts, promotion commands, and retention cleanup.

Analytics record opaque categories and outcomes, not private prompt/branch cognition. Every preview surface prominently identifies timeline kind and effect policy.

---

## 21. Explicit non-goals

Wave 7 does not implement:

- arbitrary code/SQL generation or direct table editing;
- merging preview history into live;
- real external effects from preview by default;
- a general Git-like event merge algorithm;
- unconstrained model-created rules;
- complete murder-mystery gameplay;
- final neighborhood content, visuals, lifecycle, or ecological polish;
- business billing or marketplace authoring.

---

## 22. Exit evidence checklist

- [ ] RW-0701 through RW-0710 are merged.
- [ ] Counterfactual Why exactly reproduces a supported deterministic baseline, evaluates one declared input change and shows a changed or unchanged result through authorized visual/text views.
- [ ] Unsupported/unavailable inputs, baseline mismatch, scope denial and budget exhaustion fail honestly; counterfactual guide/memory/effect output stays branch-local with no real delivery.
- [ ] Rule evaluation/order/dedupe are deterministic and bounded.
- [ ] Fork manifest is a consistent physical+cognitive cut.
- [ ] Branch schedules, actors, sessions, memory, PRNG, and projections are independent.
- [ ] Preview/replay effects and credentials are isolated under adversarial tests.
- [ ] Changesets are typed, cited, validated, and assumption-aware.
- [ ] AuthoringWorkflow survives waits, crashes, cancellation, expiry, and deployment.
- [ ] Fast-forward uses production kernel semantics and budgets.
- [ ] Semantic/visual/causal diff distinguishes intent from consequence.
- [ ] Rebase exposes typed current-head conflicts.
- [ ] Promotion submits fresh authorized commands and copies no synthetic history.
- [ ] `mirror-room@1` proves four entity interaction modes without engine changes.
- [ ] Local, eval, security, replay, UI, and staging qualifications pass.

The manifest records commit, schema/rule/compiler/world-pack versions, fork/base hashes, scenario seeds, isolation attack results, authoring eval, preview costs, promotion proofs, UI/accessibility evidence, staging qualification, and exit decision.

---

## 23. Handoff to Wave 8

Wave 8 uses authoring and rules to complete `green-lake-yard@1`, not to bypass world-pack review. It fills lifecycle, households, ecology, summaries, object/space conversation, art/audio, and the north-star causal chain. The Wave 7 preview path becomes the content team’s normal validation loop and the demo’s creator-facing proof.
