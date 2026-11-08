# Decision shadow

The decision-model tier of the [decision ladder](../adr/clockgrove-adr-actor-decision-ladder.md), in shadow mode. Code: `packages/application/src/decision-shadow.ts`; the gateway adapter is `apps/runtime/src/decision-shadow.ts`; the model call is `ModelGateway.decide` ([model gateway](../../packages/model-gateway/docs/model-gateway.md#decide)).

## Declaration

Points are pack data under `policy.utility.decisionPoints` ([domain contract](../../packages/domain/docs/utility.md#decision-points)). `decisionShadowDeclarations(policy)` returns them with the ambiguity declaration, or `undefined` (tier off).

## Run

`runDecisionShadow({subjects, declarations, decider})` takes committed decisions (`{commandId, trace}`) and returns `DecisionShadowRecord`s. It never writes the world.

1. The kernel's `planningRequestFor` is re-derived from the trace and ambiguity declaration; no request or fewer than two eligible candidates means no record. The request's candidates are the kernel's valid set.
2. The first point whose trigger holds is used (`score-margin` needs the request margin within `maxMargin`; `declared-ambiguity` takes any request).
3. A point over its per-run `maxCalls` or `maxMicrousd` records `over-budget` with no call.
4. The decider is asked a bounded choice among candidate action keys plus the reserved `cant_tell` option (the gateway has no native abstain), with only the point's features (fixed-point values as text).
5. Outcomes: `picked` (confidence at or above `confidenceThreshold`), `low-confidence` (a candidate below it, or no confidence), `cant-tell` (the model chose `cant_tell`), `failed` (gateway failure or an unknown label). Low-confidence and `cant-tell` are counted apart so the threshold can be calibrated. Every outcome other than `picked` falls back to the utility choice, which was already taken.

With no decider (models off) it returns nothing, so the world runs exactly as without the tier.

## Record

`DecisionShadowRecord` is plain JSON: `pointId`, `requestId`, `signature`, `objectId`, `commandId`, `simulationTime` and `policyVersion`; the `trigger` with its margin; `candidates` (`key`, `score`, shown `features`, all as strings); the `utilityChoice` taken; the `shadow` result (`status`, `choice`, `confidenceBp` in basis points, `detail`); the model alias, threshold, `model`, `latencyMs` and `costMicrousd` (null when unknown); and `llm: {status: "not-run"}`, the slot for what an LLM planning request would have chosen once that path runs.

The `signature` hashes the point, the actor, the shown candidates with scores and the utility choice, and not the time, so the same situation repeats the same signature.

## Journal

`journalDecisionShadow` appends the record as one `DecisionShadowRecorded` event (schema 2, `operator_evidence`) under a trusted command `trusted:decision-shadow:<digest>`, derived from request, actor, time and point, with no projection delta. An exact retry is answered from the stored receipt. Partition replay ignores the event type, so state hashes are unchanged, and replay never calls a model.

## Report

`decisionShadowReport(records)` gives, per point, decisions, answered, agreed, agreement rate, low-confidence, `cant-tell`, failed, over-budget, total cost, mean and p95 latency; up to ten differing examples; and `review`: signatures seen at least twice whose answers were low-confidence, `cant-tell` or disagreeing, listed apart for human review.

## Proof

`apps/runtime/test/decision-evidence/shadow.postgres.test.ts`: PostgreSQL, the native owner and a scripted decider. A real-model run on the Raccoon World long run is a maintainer step; its numbers go on issue 76.
