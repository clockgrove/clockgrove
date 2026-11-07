# Refusal codes

- `MALFORMED_INPUT`, `MISSING_FIELD`, `UNKNOWN_FIELD`: input shape (`input`, `input.artifact`,
  `input.source`, `input.<extra>`).
- `ENGINE_INCOMPATIBLE`: `artifact.engineCompatibility` excludes the engine version.
- `ARTIFACT_MISMATCH`: `artifact.<field>` differs from the artifact built from `source`.
- Every SDK refusal code, such as `HASH_MISMATCH` at `manifest.assets[0].sha256`, with the SDK path.
- `MISSING_BEHAVIOR_POLICY` at `manifest.policies`: seed commands without a behaviour policy.
- `INVALID_COGNITIVE_SEED`: a `clockgrove.scripted-cognition` cognitive seed that cannot be applied. At
  `manifest.cognitiveSeeds[<index>]` when the policy has no `utility`; at
  `manifest.cognitiveSeeds[<index>]#<field>` for a missing, extra or wrong-typed field (`schemaVersion`,
  `entries`); at `manifest.cognitiveSeeds[<index>]#<domain path>` (for example `#state.scriptedCognition.entries[0].value`) for an
  entry the domain validator refuses; at `manifest.cognitiveSeeds[<index>]#entries[<n>]` for a `ref`
  already seeded by an earlier seed; at `manifest.cognitiveSeeds[<index>]#entries[<n>].actorId` or
  `.targetObjectId` for an entry that names no usable actor or target.
- `INVALID_SEED_COMMAND` at `manifest.seedCommands[<index>].payload`: a payload that is not plain data
  (for example a function) or whose `schemaVersion` differs from the seed version; raised before any
  kernel execution.
- `INVALID_INITIAL_STATE`: the initial world state or schedules cannot be built. With a `lifecycle` policy
  also at `manifest.actors[<index>]#lifecycle` (a needs actor without a lifecycle seed),
  `manifest.actors[<index>]#lifecycle.parentIds` (a parent that is not another declared needs actor) and
  `manifest.actors[<index>]#lifecycle.bornAt` (after the clock epoch).
- `SEED_COMMAND_REFUSED` at `manifest.seedCommands[<index>]`: the kernel refused the command.
- `SEED_PROJECTION_MISMATCH` at `manifest.expectedSeedProjectionHash`; the message states the expected and
  actual hashes.
- `MALFORMED_BUNDLE` at `bundle`: bundle bytes that are not strictly canonical.
- `UNSUPPORTED_BUNDLE_VERSION` at `bundle.kind` or `bundle.version`.
- `BUNDLE_HASH_MISMATCH` at `bundle.bundleHash`: the recorded hash differs from the recomputed one.
- `BUNDLE_FIELD_MISMATCH` at `bundle.<field>`: the field differs from a fresh re-seeding.

## `runScenario`

Input-shape paths are rooted at `input` (`input`, `input.<extra>`, `input.scenario`); refusals inside the
scenario document are rooted at `scenario` (for example `scenario.steps[2].kind`). `MALFORMED_INPUT`,
`MISSING_FIELD`, `UNKNOWN_FIELD` and every `seedGenesis` refusal (passed through unchanged) keep the
meaning above. `MISSING_BEHAVIOR_POLICY` is raised at `scenario.steps` when the pack has no behaviour
policy but a plan has steps. New codes, see [Scenarios](scenarios.md):

- `UNSUPPORTED_SCENARIO_KIND` at `scenario.kind`; `UNSUPPORTED_SCENARIO_VERSION` at `scenario.schemaVersion`.
- `PACK_MISMATCH` at `scenario.pack`: the pack identity differs from the artifact.
- `UNKNOWN_STEP_KIND` at `...steps[<n>].kind`.
- `UNCATALOGUED_COMMAND` at `...steps[<n>].type` (or `.version`): not in the kernel command catalogue.
- `INVALID_STEP`: a step with a bad key, a non-increasing target time, a bad mode, a retry reference or a
  payload, a `world.advance` command step, or a `via.capability` that is not `id@version`.
- `INVALID_VARIANT`, `INVALID_EQUIVALENCE`, `INVALID_PERCEPTION`, `INVALID_ASSERTION`: the matching section is invalid.
- `SCENARIO_BOUND_EXCEEDED`: a documented step, variant, equivalence, assertion, budget or depth bound is exceeded.

A command step submitted through a capability binding ([Capability steps](scenarios.md#capability-steps))
that the pack refuses is recorded as that step's outcome, `{ status: "refused", code, path, calls: 0,
events: 0 }`, and the run continues:

- `CAPABILITY_NOT_HELD` at `...steps[<n>].via.capability`: the actor does not hold that binding (including
  an actor the pack does not declare).
- `CAPABILITY_COMMAND_UNDECLARED` at `...steps[<n>].type`: the bound capability does not declare the
  command's type and version.

A failing assertion or a non-equivalent variant is recorded in the bundle and is never a refusal. An
internal defect is rethrown, never reported as a refusal; this includes a `seedGenesis` failure flagged
`defect: true` (the `MALFORMED_INPUT` at `input` catch-all for an exception that is not a refusal), which
`runScenario` rethrows because it has already validated the input shape. `seedGenesis` sets `defect` only on
that catch-all, so callers never tell a defect from a refusal by its message. A pack without a behaviour
policy runs a scenario whose plans have no steps.
