# Utility policy and scripted cognition (RW-0108b)

`WorldBehaviorPolicy.utility` is an optional, versioned record (`UtilityPolicy`, `schemaVersion: 1`) that
requires `wellbeing`: `scorer` `"clockgrove.routine-utility"`, `scorerVersion` 1, `thirstWeight`,
`expectationWeight` and `travelWeight` (integer basis points, 0 to 10000), `unitsPerSecond` (positive
fixed-point bigint), `perceptionRange` (nonnegative fixed-point bigint), `biteQuantity` (positive safe
integer) and `hungerReliefPerUnit`, `thirstReliefPerUnit` (integers, 1 to 10000). `WorldState.scriptedCognition`
(`ScriptedCognitionState`) is optional, requires the `utility` policy and is `{schemaVersion: 1, source:
"scripted", entries}`: up to 64 entries sorted by unique `ref` (prefix `scripted:`), each `{ref, kind:
"belief" | "memory", actorId, targetObjectId, value (0 to 10000), effectiveAt}`. The `source` marks every
entry as scripted rather than observed. Without them, encodings and hashes are unchanged.
`validateUtilityPolicy` and `validateScriptedCognition` throw `UtilityValidationError`
(`policy.utility...` / `state.scriptedCognition...`) and `scriptedCognitionDisagreement` names the first
entry whose actor is unknown or has no needs, or whose target is not an active food or water holder or
shelter.

**Death.** An entry whose `actorId` names an actor that has died (`lifecycle.status` `"dead"`) no longer
applies: the actor never decides again, so `scriptedCognitionDisagreement` skips the entry and it never makes
a later kernel call refuse. The entry stays in the record. An actor that is unknown, has no needs or is
retired is still named at `...actorId`.

**Attribution.** An entry may carry an optional `attributedTo` (an object id) naming the actor the evidence
came from. Entries without it keep their encodings and hashes. `validateScriptedCognition` refuses, at
`state.scriptedCognition.entries[i].attributedTo`, a value that is not an object id, that equals the entry's
own `actorId`, or that accompanies kind `memory` (attributed evidence is never a copied firsthand episode).
`scriptedCognitionDisagreement` names `...attributedTo` when that actor is unknown or has no needs.
Effectiveness: an attributed entry counts at a decision only when `effectiveAt` is at or before the decision
time and the attributing actor had not died before `effectiveAt` (its lifecycle `death.diedAt`; `effectiveAt >
diedAt` is never effective). Without a lifecycle policy nobody dies. Session, private-memory, relationship
and knowledge-access policy at death is built by Wave 8 RW-0802 (Wave 8 §5.1, "Death").

`RoutineAction.kind` gains `seek-water` (a target is required) next to `stay`, `seek-food` (an optional
food target) and `seek-shelter`. Two events at version 1 are reduced by `reduceWorldEvent`, one reducer each:
`location.changed` (`{objectId, locationId | null, planId}`) sets the location of any object (an actor, a
sheltered plant, any moved object) and `needs.relieved`
(`{objectId, need, sourceObjectId, quantity, value, planId}`) sets the named need. The kernel owns the
registry, scorer and movement systems that use them.

`routine.selected` is version 2: the kernel emits it only for a material decision, and
`reduceWorldEvent` accepts each event type at its current version only (`worldEventVersion(type)`).
`upcastWorldEvent` reads a historic `routine.selected@1` as version 2 with the same payload (one upcast table;
`upcastEventRecord` is the same read for rule evaluation), and
`replayWorldEvents` upcasts every event it reduces; `currentWorldEventVersion(type, version)` names the
version a historic one reads as.

## Ambiguity declaration

`UtilityPolicy.ambiguity` (`AmbiguityDeclaration`, issue 844) is optional; without it the policy keeps its
encoding and hash and no planning request is ever produced. It is `{schemaVersion: 1, conditions}`, where
`conditions` holds one to two conditions from the closed set `AMBIGUITY_CONDITION_KINDS`, at most one per kind
and sorted by kind: `{kind: "score-margin", maxMargin}` (a bigint from 0 to `FIXED_POINT_LIMIT`, the bound
every fixed-point policy bigint carries: the two best eligible candidates are ambiguous when their scores differ
by at most it, so 0 declares exact ties, broken only by the action key, ambiguous) and `{kind:
"unperceived-target"}` (a novelty condition: the selected seek's target is not perceived, so the choice rests
on scripted evidence alone). `validateUtilityPolicy` refuses a malformed declaration with
`UtilityValidationError` at `policy.utility.ambiguity` or below: a missing or extra field, an unknown
`schemaVersion`, an empty, sparse or over-long `conditions` (`...conditions`), a condition that is not an
object (`...conditions[i]`), an unknown, repeated or out-of-order kind (`...conditions[i].kind`) and a
`maxMargin` that is missing, not a bigint or out of range (`...conditions[i].maxMargin`). The kernel reports
these as `invalid-input` under `pack.pack.`. `decodeWorldScenario` reads the declaration with `maxMargin` as a
decimal string. The kernel owns the planning request it describes ([utility decisions](../../kernel/docs/utility-decisions.md)).

## Decision points

`UtilityPolicy.decisionPoints` (`DecisionPointsDeclaration`, issue 92) declares where the decision-model tier of
the [decision ladder](../../../docs/adr/clockgrove-adr-actor-decision-ladder.md) runs in shadow mode. It is optional and
requires `ambiguity`; without it the policy keeps its encoding and hash and no shadow tier runs. It is
`{schemaVersion: 1, points}`, with one to `MAX_DECISION_POINTS` (8) points sorted by unique `id`. A point is
`{id, trigger, candidates, features, modelAlias, confidenceThreshold, budget, fallback}`:

- `id` is a lowercase identifier of at most 64 characters (`routine.close-call`).
- `trigger` is `{kind: "score-margin", maxMargin}` (a bigint from 0 to `FIXED_POINT_LIMIT`; fires on a planning
  request whose margin is at most it) or `{kind: "declared-ambiguity"}` (fires on any planning request the
  `ambiguity` declaration raised). `DECISION_TRIGGER_KINDS` is the closed set.
- Optional `scope: {actorIds?, archetypes?}` selects actor ids or archetypes. Each supplied selector list is nonempty, unique and lexically sorted; identifiers are trimmed nonempty strings of at most 256 characters (decision: a bounded pack identifier, not a provider name). Either list matching admits the actor. Omitted scope preserves universal matching and canonical bytes; an empty scope is invalid.
- `candidates` is always `"kernel-valid"`: the model chooses among the kernel's eligible candidates and never adds one.
- `signatureScope` (`"actor"` or `"archetype"`) says whose repeats share a signature, and `marginBuckets`
  `{noneMax, smallMax}` (bigints, `noneMax < smallMax`) bucket the top-two score gap as `none`, `small` or `large`
  for it. Both are policy data, never hard-coded.
- `features` are the feature names shown to the model, sorted and unique, at most 16.
- `modelAlias` names a configured model alias; the model is configuration, never pack or code.
- `confidenceThreshold` is an integer from 0 to 10000 basis points; a lower-confidence answer abstains.
- `budget` is `{maxCalls, maxMicrousd}` per run.
- `fallback` is always `"utility-top-pick"`: the choice utility already took.

`validateUtilityPolicy` refuses a malformed declaration with `UtilityValidationError` at
`policy.utility.decisionPoints` or below. `decodeWorldScenario` and the pack decoder read `maxMargin` as a decimal
string. The application owns the runner ([decision shadow](../../../docs/protocols/decision-shadow.md)).
