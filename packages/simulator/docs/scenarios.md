# Scenarios

`runScenario({ artifact, source, scenario }, { sha256 })` runs a declarative scenario document against a
built pack artifact. It is pure and total: no clock, randomness or I/O. It resolves to
`{ ok: true, value: { bundle, bytes } }` or `{ ok: false, error: { code, path, message } }`. The bundle is
deeply frozen, `bytes` is the kernel `canonicalBytes(bundle)`, and `bundle.bundleHash` is the SHA-256 of the
canonical bytes of the bundle without that field. Refusal codes are in [Refusal codes](refusal-codes.md).

The pack is seeded with `seedGenesis` (its refusals pass through unchanged), then each plan runs against the
kernel from the genesis state. The native executor checks the world invariants before every
accepted result, including per-holder resource accounting and closed-world cause validation.
Results supplied by an external driver can combine overdue catch-up and a client command.
`checkWorldTransitionInvariants` independently checks every command-independent invariant in that
registry before recording; each native command still checks its own command-specific authority and
payload. An inconsistent result is refused as `RESOURCE_CAUSE_INVARIANT`; the same check runs
in full and summarised recordings, so reference scenarios and long runs cover every transition.
Runtime identifiers, durations, peak memory, wall-clock values and host paths
are never part of the bundle.

## Scenario document

Required: `kind` (`"clockgrove.scenario"`), `schemaVersion` (`1`), `name`, `pack` (`{ id, version }`, which
must equal the artifact's), `steps`. Optional: `variants`, `equivalences`, `perception`, `assertions`,
`recording` (`"full"` or `"summarised"`, see [Summarised recording](#summarised-recording); any other value
is `MALFORMED_INPUT` at `scenario.recording`). Unknown fields are refused. A document without `recording`
records in full and decodes, and therefore bundles, exactly as before the field existed.

Bounds (`SCENARIO_LIMITS`): 256 steps per plan, 8 variants, 16 equivalences, 64 assertions, 4096 kernel
chunks per advance, a maximum input/event budget of 100000, and nesting depth 32 for supplied data.
Exceeding one is `SCENARIO_BOUND_EXCEEDED`. The step, variant, equivalence and assertion bounds are
checked while decoding; the chunk bound is checked while running: a live advance that would need more than
4096 chunks refuses at `scenario.steps[<n>].stepMs`, and a step whose kernel continuation chain exceeds
4096 calls (a small `maxInputs`/`maxEvents` over a long span) refuses at the step (`...maxInputs` for an
advance).

## Steps

Every step has a unique `key` within its plan.

- `command`: `{ kind, key, type, version, payload, via? }`. `type` must be in the kernel command catalogue
  (otherwise `UNCATALOGUED_COMMAND`); `world.advance` is catalogued but refused as `INVALID_STEP` (use
  `advance`). `payload.schemaVersion` is added when absent. See [Capability steps](#capability-steps) for
  `via`.
- `advance`: `{ kind, key, to, mode, stepMs?, maxInputs?, maxEvents? }`. `mode` is `live` (chunks of
  `stepMs`, required) or `fast-forward` (one kernel call, continued until complete; `stepMs` is refused).
  `maxInputs` defaults to 1024 and `maxEvents` to 4096 (each at most 100000). `to` must be strictly greater
  than the previous advance target in the same plan (`INVALID_STEP` otherwise) and must not precede the
  current simulation time.
- `retry`: `{ kind, key, of }` resubmits the earlier command `of` unchanged. The kernel outcome
  (accepted, or refused with code and path) is recorded.
- `restart`: `{ kind, key }` round-trips state, schedules, random state, cooldowns and held rule groups
  through canonical bytes and records the byte length, bytes hash and state hashes before and after.

### Capability steps

`via: { actor, capability }` submits the command through an actor's capability binding: `actor` is a pack
actor id and `capability` is the binding as `id@version` (otherwise `INVALID_STEP` at `...via.capability`).
A step without `via` decodes, runs and bundles exactly as before the field existed. The pack decides with the
world-pack SDK's pure `checkCapabilityCommand` ([collections](../../world-pack-sdk/docs/collections.md)):
the command is accepted only when the actor holds that binding and the bound capability declares the
command's type and version.

- Accepted: the command runs, and its kernel attribution is `effectiveActorId: <actor>`, `initiatorId:
  "simulator-scenario"` (every other command keeps `effectiveActorId: "simulator-scenario"`). The command
  record carries `via: { actorId, id, version }` and `capability: { actorId, id, version, kind }`.
- Refused: the kernel is not called and nothing changes. The record carries the same `via`, `capability:
  null` and the outcome `{ status: "refused", code, path, calls: 0, events: 0 }`, with `code`
  `CAPABILITY_NOT_HELD` at `...via.capability` or `CAPABILITY_COMMAND_UNDECLARED` at `...type`. These are
  recorded outcomes, never `runScenario` refusals.

A `retry` of a capability step repeats its verdict.

Command ids are derived deterministically from the pack identity and the stream name
`scenario:<scenario name>:<step key>` (`<step key>:<chunk>` for advances); the plan name is not part of the
id, so a variant step with the same key as a main step gets the same command id. Unknown step kinds are
`UNKNOWN_STEP_KIND`.

## Kernel driver

`ports.driver` (optional) is `(run) => ({ call, restart? })`, one driver per plan, by run name (`main`
and each variant). Each kernel call of that plan goes to `call(input)` instead of the pure kernel; it
returns the kernel outcome, or `undefined` when the call was answered from a stored outcome (recorded
as `{ status: "stored", calls: 0, events: 0 }`; nothing changes). `restart()` runs at each `restart`
step after the snapshot round trip. A driver that calls the pure kernel leaves the bundle
byte-identical. The Journal parity harness (`apps/runtime/test/journal-parity.ts`) uses it to run the
same plans through the world-command use cases against PostgreSQL. A driver that is not a function is
`MALFORMED_INPUT` at `ports.driver`.

## Variants

`variants` is a list of `{ name, steps }` plans run from the same genesis state. The main plan is named
`main`; variant names are unique and may not be `main`.

## Equivalences

`{ id, left, right, fields, eventTypes?, ignoreEventTypes?, ignoreStatePaths? }` declares that two runs are
materially equivalent over `fields`: `events`, `eventCounts`, `finalState`, `decisions`, `rules`.
`eventTypes` keeps only those event types, `ignoreEventTypes` drops event types, `ignoreStatePaths` removes
state paths (for example `["revision"]`) before comparing. The bundle records the declaration, whether it
holds, and the differing fields. A divergent variant is recorded as `equivalent: false`.
The `events` view excludes `resource.weather-integrated` events whose collected and evaporated
quantities are both zero: those fractional bookkeeping events vary with command boundaries.
It retains every nonzero collection or evaporation, including an event with a zero net change.
Both full and summarised equivalence use this material view; the journal, replay and native
invariant checks retain all events.

## Perception

`perception: { policy, modality?, modalities? }` supplies a kernel audience policy. For every perceivable
event, kernel `resolveAudience` is called and the reasons, perceptions and client-interest hash are
recorded (or the refusal, or `not-addressable`). Without it, `perception` is `[]`.

## Assertions

- `path`: `{ kind, id, run, path, operator, value }` compares a value in a recorded run.
- `eventCount`: `{ kind, id, run, eventType?, from?, to?, where?, operator, value }` counts filtered events.
- `equivalence`: `{ kind, id, equivalence, expect }` checks a declared equivalence.

`operator` is one of `eq ne lt lte gt gte`. Each assertion is recorded as `passed: true|false`; a failing
assertion never causes a refusal.

## Bundle

Closed top-level fields: `kind` (`clockgrove.scenario-bundle`), `version`, `versions` (simulator, pack
engine, canonical encoding, catch-up engine, audience resolver, random contract and algorithm, behaviour
policy, scripted cognition, scenario schema, genesis bundle), `pack`, `artifact` (hashes), `kernel`
(registry identity), `prng` (named streams), `genesis` (initial state hash and seed projection),
`scenario` (the decoded document), `scriptedInputs`, `runs`, `equivalences`, `assertions`,
`replayVerified`, `bundleHash`.

Each entry of `runs` records: `name`; `randomState` before and after; `commands` (ordered, with retry and
restart outcomes); `scheduledInputs`; `scheduleMutations`; `schedule` (initial, remaining, next due);
`events` (with reducer versions); `decisions` (candidates, features, exclusions, draws, selection and
scripted references); `rules` (`evaluated`, intents, trace, cooldowns, `disposition:
"recorded-not-executed"`: pack rules are evaluated over every kernel transition with kernel
`evaluateRules` and no intent is executed); `perception`; `eventCounts`; `startStateHash`; `finalState`;
`finalStateHash`; and `replay`.

`scriptedInputs` lists every scripted cognitive input as `{ scripted: true, origin: "cognitive-seed", ref,
entry }`, so it cannot be mistaken for observed memory. `replay` records whether replaying the semantic
events from the initial state reproduces the final state hash; `replayVerified` is true when it does for
every run.

## Summarised recording

`recording: "summarised"` is an opt-in for long-horizon qualification runs (a simulated year of
`clockgrove.test-world@1` is about 1.6 million events). It changes only how each run is recorded, never what
the kernel does, so the final state, its hash and the random state equal those of a full recording. Memory
then grows with the world (objects, schedules, the document's steps) and one kernel call's output, not with
the horizon. No pack scenario under `scenarios/` uses it; the Wave 1 long-run qualification documents under
`worlds/<dir>/long-runs/` do. The bundle `kind`, `version` and `versions` are unchanged;
the document recorded in the bundle says which mode produced it. The bundle is canonical and hashed as
usual, so Node and workerd produce byte-identical summarised bundles.

In a summarised run, each ordered record list (`events`, `decisions`, `scheduledInputs`,
`scheduleMutations`, `perception`, and `rules.evaluations`, `rules.intents`, `rules.trace`) is replaced by
`{ count, digest }`. `digest` chains SHA-256 over consecutive batches of 1024 records,
`digest = sha256(canonicalBytes([previous, batch]))` from `previous = null`, closed by the last (possibly
empty) batch. It digests the records a full recording would list, so call and chunk boundaries do not
change it. Every other run field (`commands`, `schedule`, `randomState`, `eventCounts`,
`scriptedInputsUsed`, `startStateHash`, `finalState`, `finalStateHash`, `replay`) is the same as in a full
recording. `replay` replays each kernel call's events as they arrive instead of the whole list at the end.
The run also carries `recording: "summarised"` and `summary`:

- `subjects`: per object id (the event payload's `objectId`, else `childId`, else `fromObjectId`, else
  `object.objectId`) and event type, `{ type, count, first, last }` with the first and last simulation time.
- `schedulePeak`: the largest schedule queue after any kernel call; `scheduleDuplicateIds`: schedule entries
  sharing an id, summed over calls.
- `undispatchedDecisions`: consumed `world.decision` schedule entries that could not be dispatched.
- `equivalenceViews`: for each declared equivalence the run takes part in, `{ id, events, decisions, rules }`:
  the `{ count, digest }` of exactly the compared view of that field (`rules` is `{ intents, trace,
  cooldowns }`). Equivalences over `events`, `decisions` and `rules` compare these; `eventCounts` and
  `finalState` compare as in full recording. Each equivalence result equals the full recording's.
- `eventCountAssertions`: `{ id, observed }` for each `eventCount` assertion on the run, counted while
  recording. `path` assertions read the summarised run, so a path into a replaced list finds `{ count,
  digest }`.

What the §9.3 long-run invariants read in a summarised run:

| Invariant | Summarised evidence |
| --- | --- |
| No negative or conjured resources | `finalState`, `eventCounts`, `eventCount` assertions on resource events |
| No orphan active objects or containment cycles | `finalState` |
| No duplicate births, deaths or schedules | `summary.subjects` counts per object, `scheduleDuplicateIds` |
| Event volume bounded relative to semantic transitions | `eventCounts`, per-chunk `commands` (calls and events) |
| Scheduler queue bounded under world policy | `schedulePeak`, `schedule.remaining` |
| Deterministic population, resource and lifecycle summaries | `finalStateHash`, `subjects`, the stream digests |
| Decision and action references resolve | `undispatchedDecisions`, `scriptedInputsUsed`, `replay` |
| No inactive or dead actor acts autonomously | `subjects`: no action event `last` after the actor's death `first` |
| No private perception in public client-view input | `perception` count and digest only; the record contents need a full recording |

Small-step versus aggregate equivalence uses `equivalenceViews`, as above.
