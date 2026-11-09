# Decision shadow

The decision-model tier of the [decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md), in shadow mode. Code: `packages/application/src/decision-shadow.ts`; the gateway adapter is `apps/runtime/src/decision-shadow.ts`; the model call is `ModelGateway.decide` ([model gateway](../../packages/model-gateway/docs/model-gateway.md#decide)).

## Declaration

Points are pack data under `policy.utility.decisionPoints` ([domain contract](../../packages/domain/docs/utility.md#decision-points)). `decisionShadowDeclarations(policy)` returns them with the ambiguity declaration, or `undefined` (tier off).

Sampling and classification are separate. The `ambiguity` declaration samples: the kernel raises a planning request only where one of its conditions holds. The optional `cohortMargin` classifies: a record is within the margin when its top-two score gap is at most it, else outside. Without `cohortMargin` the ambiguity's score-margin bound classifies, which in a running world is the world's declared margin; `null`, or no score-margin condition, leaves records unclassified.

## Run

`runDecisionShadow({subjects, declarations, decider})` takes committed decisions (`{commandId, trace}`) and returns `DecisionShadowRecord`s. It never writes the world.

1. A decision that is not utility-tier, or has fewer than two eligible candidates, gets no record. Otherwise the kernel's `planningRequestFor` is re-derived from the trace and ambiguity declaration; no request means no record. The request's candidates are the kernel's valid set.
2. The first point whose actor/archetype scope matches and whose trigger holds is used (`score-margin` needs the request margin within `maxMargin`; `declared-ambiguity` takes any request, an unperceived-target request included).
3. A point over its per-run `maxCalls` or `maxMicrousd` records `over-budget` (detail `calls` or `spend`) with no call. Spend counts each call's measured cost; an unknown cost counts at the call's reservation (`reservedMicrousd`), or, when the decider reports none, exhausts the point's spend budget. Unknown cost is never free budget.
4. The decider is asked a bounded choice among candidate action keys plus the reserved `cant_tell` option (the gateway has no native abstain), with only the point's candidate features and the actor's recorded needs/weather/health state. Every value is shown with its scale from the kernel's `UTILITY_FEATURE_SCALES`: a share as `3372/10000 (33.72%)`, a flag as `yes`/`no`, a duration in `ms`, another range stated; a closing legend gives each shown feature's unit, range and meaning. A feature without a declared scale is refused, never shown bare. Candidate keys are ordered lexically, independently of scores. Utility scores, the selected fallback and ranking are never sent to the model.
5. Outcomes: `picked` (confidence at or above `confidenceThreshold`), `low-confidence` (a candidate below it, or no confidence), `cant-tell` (the model chose `cant_tell`), `failed` (gateway failure or an unknown label), `over-budget` with detail `shared-budget` (the decider answered `budget_exceeded`: a budget beyond the point, the gateway's or an operator run's cap, refused the call before any provider call; it is not a failure and uses none of the point's budget). Low-confidence and `cant-tell` are counted apart so the threshold can be calibrated. Every outcome other than `picked` falls back to the utility choice, which was already taken.

With no decider (models off) it returns nothing, so the world runs exactly as without the tier.

`decisionShadowSkips({subjects, declarations})` lists every decision step 1 or 2 gave no record, with its reason: `not-utility-tier`, `single-candidate`, `no-ambiguity-condition`, `out-of-point-scope` (no point's scope admits the actor) or `trigger-not-met` (a point admits it, but no admitting point's trigger holds). It calls no model.

## Record

`DecisionShadowRecord` is plain JSON: `pointId`, `requestId`, `signature`, `objectId`, `commandId`, `simulationTime` and `policyVersion`; the `trigger` with its margin; `candidates` (`key`, `score`, shown `features`, all as strings); the `utilityChoice` taken; `utilityMargin` with the top-two gap, the classification bound (`maxMargin`, null when there is none) and whether the gap is within it (`withinDeclaredMargin`); the `shadow` result (`status`, `choice`, `confidenceBp` in basis points, `detail`); the model alias, threshold, `model`, `latencyMs` and `costMicrousd` (null when unknown); and `llm: {status: "not-run"}`, the slot for what an LLM planning request would have chosen once that path runs.

The `signature` hashes the point id, the actor (or its archetype when the point's `signatureScope` is `archetype`), the sorted candidate option ids, the utility choice and the margin bucket (`none`, `small` or `large` for the top-two score gap, with boundaries in the point's `marginBuckets`). Scores, shown features, the model's label, confidence, latency and cost drift per tick, so they stay out of the hash and sit beside it as evidence (with `marginBucket`). A repeat is therefore a recurring kind of situation, not an exact match.

## Journal

`journalDecisionShadow` appends the record as one `DecisionShadowRecorded` event (schema 2, `operator_evidence`) under a trusted command `trusted:decision-shadow:<digest>`, derived from request, actor, time and point, with no projection delta. An exact retry is answered from the stored receipt. Partition replay ignores the event type, so state hashes are unchanged, and replay never calls a model.

## Report

`decisionShadowReport(records, skips)` gives, per point, decisions, answered, agreed, agreement rate, low-confidence, `cant-tell`, failed, over-budget, total cost, mean, p50 and p95 latency (nearest rank over measured calls; `decisionShadowLatency` computes the same for any set of records); unknown-cost calls; separate `withinMargin`, `outsideMargin` and `unclassifiedMargin` agreement summaries; `skipped`, the skipped decisions with a count for every reason; up to ten differing examples; and `review`: signatures seen at least twice where the tier did not simply agree with utility (it disagreed, answered `cant_tell` or fell below the confidence threshold), listed apart for human review.

Agreement is comparison with the deterministic policy, never accuracy. Each summary counts candidate answers, including low-confidence answers, with abstentions and failures shown separately. Historical records without margin evidence are unclassified. Known cost is summed separately from unknown-cost calls; an uncalled over-budget record is not an unknown-cost call.

The supported [offline shadow command](../runbooks/runtime.md#offline-decision-shadow-day) runs a selected pack and a labelled native-scored fixture reference set under one conservative spend cap. It samples broadly by default and still classifies by the pack's declared margin, and reports world and reference latency apart. The reference report includes expected picks, one-line reasons, coverage and accuracy independently of utility agreement; those labels and reasons never reach the model.

## Proof

`apps/runtime/test/decision-evidence/shadow.postgres.test.ts`: PostgreSQL, the native owner and a scripted decider, including a cohort margin between two real gaps. `packages/simulator/test/decision-shadow.journey.test.ts`: the offline command on the fixture pack (sampling against cohorts, skips, budgets, scales, latency). A real-model run on an operator-selected world is a maintainer step; its numbers go on issue 76.

## Wake triage

Wake triage is a separate shadow decision point at the actor's model-escalation boundary
(issue 111). Application code is `packages/application/src/wake-triage.ts`; it reuses
`ShadowDecider` and the runtime gateway adapter rather than asking a generation model to judge.
The optional `WAKE_TRIAGE_CONFIG` binding supplies the policy version, model alias/model,
confidence threshold and world/day decision budget. Absence disables triage. Configuration and
report usage are in the [runtime runbook](../runbooks/runtime.md#wake-triage-shadow-report).

The bounded choices are `suppress`, `compiled_routine`, `full_turn` and `cant_tell`. The current
full turn always runs after an admitted model escalation, including when triage is disabled,
unavailable, over budget, low confidence or abstaining. `cant-tell` and `low-confidence` are
separate statuses; failures retain their reason. No enforcing mode exists. Direct messages are
included and marked as messages from people; a later enforcing mode must never suppress them
(owner decision, 2026-11-09).

Each record identifies the actor, session/message, activation reason, canonical simulation time,
policy/model configuration, label, confidence in basis points, latency and nullable measured cost.
The signature hashes the activation reason, actor, suppression cause and policy/model versions.
A repeated miss or a repeated low-confidence signature (at least two occurrences) appears in
`review` for human attention. Wake input and assembled context are model evidence, not authority.
Journaled cognitive evidence has no physical projection delta; replay reads history without a model.

The durable budget reserves the configured per-call ceiling before the decision call, shared by
actors in the same world, timeline and simulated day, using the pack's environment day length
(or 86,400,000 ms when absent). Reservations survive recovery and are not refunded,
including when the model reports a lower or unknown cost. The budget therefore bounds reserved
opportunities conservatively; measured report spend remains separate from that ledger.

`wakeTriageReport` compares the decision with the turn's stored final disposition, command proposal
and output message. A proposed command is material even if refused; a reply to a person is
material. Autonomous text alone is not a reply to a person. Unfinished turns are counted apart.
The report is scoped to the operator's authorized space and returns classifications and cognitive
evidence, without disclosing private input, prompt or output artifact contents. It provides
per-reason labels, confidence, latency, costs, agreement and bypass share,
with abstentions separate from low-confidence answers. A `suppress` or `compiled_routine` answer
on a material turn is a miss; examples and recurring signatures remain visible. Savings are
counterfactual full-turn spend for confident bypass labels, with triage spend subtracted for net
savings. Direct-message wakes are excluded from safe bypass/savings while their raw labels and
misses remain visible. Unknown costs remain counted as unknown, and a savings figure does not establish that
bypassing the missed work would be acceptable.
