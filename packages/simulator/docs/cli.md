# CLI

`clockgrove` is the headless command-line entry to the simulator library. It composes
`validateWorldPack`/`buildWorldPack`, `seedGenesis`, `verifyGenesisBundle` and `runScenario`; it defines no
world semantics. Its sources are `packages/simulator/cli/`; `src/` stays pure.

## Invocation

The executable is `packages/simulator/cli/clockgrove.mjs`, declared as the `bin` named `clockgrove` of
`@clockgrove/simulator`. After `pnpm install --frozen-lockfile --ignore-scripts`, Node 24.21.0 runs it
directly, with no build step:

```text
node packages/simulator/cli/clockgrove.mjs <group> <command> [--option value]...
```

The `.mjs` entry registers a module hook that maps the repository's `./x.js` import specifiers to
`./x.ts` and transforms the TypeScript sources on load, then imports `main.ts`. Node may print its
`ExperimentalWarning` for that transform to stderr.

Every option takes exactly one value and is required. An unknown group or command, a missing, unknown or
duplicate option, an option without a value (or whose value starts with `--`), an empty value, or an
`--out` path that already exists is a usage error.

## Output envelope

stdout carries exactly one JSON document in SDK `encodeResource` encoding followed by a newline:

```text
{ kind: "clockgrove.cli-result", version: 1, command: "<group> <command>", status, exitCode,
  result, refusal, observations }
```

- `command` is the first two arguments joined by a space (fewer when fewer were given).
- `status` is `ok`, `failed`, `usage` or `unreadable`; `exitCode` is its exit code.
- `result` is the command's evidence, or `null`. It holds no runtime identifier, wall-clock value, file
  path or other host measurement.
- `refusal` is `{ code, path, message }`, or `null`.
- `observations` is `{ runtime, durationMs, peakMemoryBytes, peakMemoryNullReason }`, measured by the host
  (`runtime` is `node/<version>`; `peakMemoryBytes` is the process high-water resident set size).

For identical inputs everything except `observations` is byte-identical, and so is every written file.

## Exit codes

| Code | `status` | Meaning |
| --- | --- | --- |
| 0 | `ok` | The command succeeded. |
| 1 | `failed` | The inputs were read but the outcome is negative: an SDK or library refusal (its `code` and `path` unchanged), or a failed check. |
| 2 | `usage` | Unknown command, a missing, unknown or duplicate option, a malformed option value, or an `--out` path that already exists or cannot be created. |
| 3 | `unreadable` | An input path is missing or unreadable, or is not the expected encoding or document kind. `refusal.path` is the option that named it. |
| 70 | none | An internal defect: an exception that is not a refusal. A diagnostic goes to stderr and nothing to stdout; it is never reported as `failed` or `unreadable`. |

A command that does not exit 0 writes no file.

Usage codes: `MISSING_COMMAND`, `UNKNOWN_COMMAND`, `UNKNOWN_OPTION`, `DUPLICATE_OPTION`, `MISSING_VALUE`,
`MALFORMED_VALUE`, `MISSING_OPTION`, `MISSING_ARGUMENT`, `OUT_EXISTS`, `OUT_UNWRITABLE`, `STATE_UNWRITABLE`; `refusal.path` is the option (or
`command`). Unreadable codes: `INPUT_UNREADABLE`, `NOT_CANONICAL_BYTES`, `NOT_PACK_ARTIFACT`,
`NOT_PACK_SOURCE`, `NOT_SIMULATION_STATE`.

## Pack artifact file

`pack build --out` writes, and `pack test --artifact` reads, a file of kernel `canonicalBytes` of this
closed document:

```text
{ kind: "clockgrove.pack-artifact", version: 1,
  artifact: WorldPackArtifactRef,
  source: { manifest: <base64>, resources: { <manifest path>: <base64> } },
  scenarios: [{ name, bytes: <base64> }], goldens: [{ name, bytes: <base64> }],
  bundleHash }
```

`artifact` holds `packId`, `version`, `contentHash`, `engineCompatibility`, `resourceManifestHash`,
`assetManifestHash`, `migrationSetHash` and `buildToolVersion`. `source` holds the exact manifest bytes and
resource bytes; `scenarios` and `goldens` hold the pack's `scenarios/*.json` and `goldens/*.json` bytes as
committed, in name order. `bundleHash` is the SHA-256 of the canonical bytes of the document without that
field. The file is read strictly: bytes that are not exactly the canonical encoding of the document, a
different `kind`, or a document that is not closed are unreadable.

## Pack commands

A pack source directory has the layout in [Pack conformance](conformance.md#pack-directory-layout) and is
read byte-exact (`goldens/*.actual.json` review copies are ignored).

- `pack validate --pack <dir>`: runs `validateWorldPack` and `lintWorldPack`. `result` is
  `{ packId, version, findings }`; `findings` are the lint's advisory issues and never change the exit code. An SDK
  refusal (for example `HASH_MISMATCH` with its manifest path) exits 1 with `refusal` unchanged. A
  directory without a readable `manifest.json`, or whose manifest is not SDK resource JSON, is unreadable
  (`--pack`).
- `pack build --pack <dir> --out <file>`: runs `buildWorldPack` and writes the pack artifact file
  exclusively (an existing `--out` exits 2 and is left unchanged; nothing is read first). `result` is
  `{ artifact, bundleHash }`: the artifact reference and the file's `bundleHash`. An SDK refusal exits 1
  and writes no file. The same pack builds to a byte-identical file from any directory path.
- `pack test --artifact <file>`: rebuilds the embedded source and runs the checks below. `result` is
  `{ artifact, bundleHash, checks }`; each check is `{ name, scenario, status, refusal, evidence }` with
  `status` `passed`, `failed` or `skipped`. The exit code is 0 only when every check passed; otherwise 1
  with `refusal` null and the failing checks named in `result`.

| Check | Scope | Passes when |
| --- | --- | --- |
| `artifact-integrity` | pack | the file's `bundleHash` matches its contents, the embedded source builds, and every `artifact` field equals the rebuilt reference (`BUNDLE_HASH_MISMATCH`, the SDK refusal, or `ARTIFACT_MISMATCH` at `artifact.<field>`) |
| `seed-genesis` | pack | `seedGenesis` succeeds and `verifyGenesisBundle` verifies its bundle |
| `scenario-assertions` | each scenario | `runScenario` succeeds and every recorded assertion passed (`ASSERTION_FAILED`) |
| `golden-match` | each scenario | the scenario bundle bytes equal the embedded golden (`GOLDEN_MISMATCH`, `GOLDEN_MISSING`) |

Checks run in the order `artifact-integrity`, `seed-genesis`, then `scenario-assertions` and `golden-match`
per scenario in name order. When the embedded source cannot be rebuilt, every later check is `skipped`; a
scenario that is not SDK resource JSON or that `runScenario` refuses fails `scenario-assertions` and skips
`golden-match`.

## Simulation state file

`simulate seed --out` writes, and `simulate command`, `simulate advance` and `simulate verify` read, a file of
kernel `canonicalBytes` of this closed document:

```text
{ kind: "clockgrove.simulation-state", version: 1,
  pack: <the pack artifact document>, genesis: <the genesis bundle>,
  scenarioName: "session", steps: [<step>...], run: <run record>, finalStateHash, bundleHash }
```

- `pack` is the `clockgrove.pack-artifact` document (see above) of the seeded pack, embedded in full.
- `genesis` is the `seedGenesis` bundle for that pack.
- `steps` are the applied steps in scenario step form, in order: `{ kind: "command", key, type, version,
  payload }` or `{ kind: "advance", key, to, mode: "fast-forward" }`. Step `n` (from 1) has the key `step-<n>`.
  The state holds at most 256 steps; a step beyond that is refused `SCENARIO_BOUND_EXCEEDED`.
- `scenarioName` is the scenario name command ids are derived from (`session`).
- `run` is the main run record of [`runScenario`](scenarios.md#bundle) for the scenario named `scenarioName`
  in `pack`, whose steps are exactly `steps`. That is the definition of the state: after N steps it is the
  `runScenario` main run of a scenario with those N steps, so the `finalStateHash` and the run evidence are the
  same however many invocations produced the steps. A freshly seeded state has no steps.
- `finalStateHash` is `run.finalStateHash`; `bundleHash` is the SHA-256 of the canonical bytes of the document
  without that field.

A file that is missing, not strict canonical bytes, or not a closed document of this kind is unreadable
(`INPUT_UNREADABLE`, `NOT_CANONICAL_BYTES`, `NOT_SIMULATION_STATE`; `refusal.path` is `--state` or
`--bundle`). Command issue times come from the pack clock policy and command ids from the pack identity and
`scenario:session:<step key>`; no file or result holds a host clock value.

## Scenario and diff

Both commands take positional arguments before their options; a missing one is a usage error
(`MISSING_ARGUMENT`, `refusal.path` the argument name).

### `simulate scenario <name> --runtime node|workers`

`<name>` is the stem of `worlds/<dir>/scenarios/<name>.json`. The executable resolves it among the committed
packs of the `worlds/` directory of the checkout containing the CLI; there is no option or environment
variable to change that. A name in no pack exits 1 with `UNKNOWN_SCENARIO`; a name in several packs exits 1
with `AMBIGUOUS_SCENARIO` (both at `refusal.path` `<name>`). A `--runtime` other than `node` or `workers` is a
usage error (`MALFORMED_VALUE` at `--runtime`). There is no golden-update option and nothing under `worlds/`
is written, rewritten or deleted.

Both runtimes receive the pack's committed bytes, decode them with the SDK, build the artifact and call
`runScenario`. `workers` runs actual workerd, bundled with the pinned root Wrangler and run with Miniflare;
its worker and temporary directories are disposed on success and on failure, and a workerd that cannot start
exits 1 with `WORKERS_UNAVAILABLE` at `--runtime`.

`result` is exactly:

```text
{ pack, scenario, bundleHash, bundle, assertions, golden: { status, difference } }
```

- `pack` is the pack's directory name; `scenario` is `<name>`.
- `bundle` is the decoded scenario bundle and `bundleHash` its hash (see `scenarios.md`). Per run it exposes the
  versions and content hashes, random states before and after, ordered commands and scheduled inputs, events
  with reducer versions, schedule mutations and remaining deadlines, the final state and its hash, event
  counts by type, and, for a scenario that declares perception, decision candidates, features, exclusions,
  draws and selection, and perception reasons, perceptions and client-interest hashes. Assertion results and
  equivalence declarations are in `assertions` and `bundle.equivalences`.
- `golden.status` is `match`, `mismatch` or `missing`. For a `mismatch`, `golden.difference` is `{ fields,
  paths }`: the sorted differing top-level bundle fields and at most 8 first differing paths (rooted at
  `bundle`); otherwise it is `null`.

The result has no runtime field. The runtime is reported only in `observations.runtime`: `node/<version>` with
the measured duration and peak memory for `node`; `Cloudflare-Workers (workerd)` with `peakMemoryBytes` null
and a stated `peakMemoryNullReason` for `workers`. Observations never enter `result`, the bundle or its hash,
so the whole `result` document is byte-identical between `--runtime node` and `--runtime workers` for the same
scenario; only `observations` differ.

Exit 0 means every assertion passed and the golden matches. A golden `mismatch` or `missing`, or a failing
assertion, exits 1 (`status` `failed`, `refusal` null, `result` populated). A refusal of the scenario or of the
pack build exits 1 with its code and path unchanged and a null `result`.

### `simulate diff <a> <b>`

Compares two kernel `canonicalBytes` files read strictly, such as state bundles, pack artifacts, goldens or
scenario bundles. `result` is `{ identical, fields, paths }`: the sorted differing top-level fields and at
most 8 first differing paths, rooted at `document`. Identical files exit 0 with `{ identical: true, fields: [],
paths: [] }`; files that differ exit 1. A missing or unreadable file, or one that is not strict canonical bytes,
exits 3 with `refusal.path` `<a>` or `<b>`.

## Simulate commands

- `simulate seed --pack <pack> --out <bundle>`: `<pack>` is a pack artifact file or a pack source directory.
  A directory is built with `buildWorldPack` (an SDK refusal exits 1). The pack is seeded with `seedGenesis`
  (its refusal, for example `SEED_PROJECTION_MISMATCH`, exits 1 with code and path unchanged) and the state
  file is written exclusively. Seeding an artifact file and the directory it was built from writes
  byte-identical files. `result` carries the genesis bundle's `artifact` (including `contentHash`,
  `resourceManifestHash`, `assetManifestHash`, `migrationSetHash`), `epoch`, `clock`, `cognitiveSeeds`,
  `genesisCommandId`, `seedCommands`, `schedules`, `events`, `decisionTraces`, `seedProjection`
  (`{ expected, actual }`), `randomState`, `counters`, `initialStateHash`, `finalStateHash` and `bundleHash`
  (the genesis bundle's), plus `stateBundleHash` (the written file's).
- `simulate command --state <bundle> --command '<json>'`: applies one command at the current simulated time and
  replaces the state file. `result` is `{ commandId, outcome, events, decisionTraces, scheduleMutations,
  randomState, counters, finalStateHash, stateBundleHash }`; `events`, `decisionTraces` and
  `scheduleMutations` are those this step added.
- `simulate advance --state <bundle> --to <sim-time>`: advances simulated time to `<sim-time>` in fast-forward
  mode and replaces the state file. `result` is `{ to, commandId, outcome, scheduledInputs, events,
  decisionTraces, scheduleMutations, ruleEvaluations, ruleIntents, ruleDisposition, remainingSchedule,
  nextDueAt, randomState, counters, finalStateHash, stateBundleHash }`. Those lists hold what this step added;
  `ruleEvaluations` and `ruleIntents` are recorded and never executed (`ruleDisposition` is
  `recorded-not-executed`); `remainingSchedule` and `nextDueAt` are the schedule after the step.
- `simulate verify --bundle <bundle>`: `result` is `{ bundleHash, finalStateHash, steps }` of the state file.

`counters` is `{ steps, commands, events, decisions, scheduleMutations, scheduledInputs, ruleEvaluations,
remainingSchedule }`: cumulative counts over the run record.

`command` and `advance` first verify the state file as `verify` does and refuse to extend one that does not
verify; the file is replaced only when the step is accepted.

### Value forms

- `--command` is inline JSON text `{ "type": <string>, "version": <integer>, "payload": <object> }` in SDK
  resource JSON conventions: a bigint is written `{"$bigint":"<n>"}`, numbers are safe integers. Text that is
  not such JSON, or not an object with exactly those three members, is a usage error (`MALFORMED_VALUE` at
  `--command`). An uncatalogued command (`UNCATALOGUED_COMMAND`) or one the kernel refuses (its code and path)
  exits 1.
- `--to` is an absolute decimal integer of simulation milliseconds (`0` or digits without a leading zero). Any
  other text is a usage error (`MALFORMED_VALUE` at `--to`). A target that is not after the current simulated
  time exits 1 with `TARGET_NOT_AFTER_CURRENT` at `--to`.

### Exit codes

| Command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `seed` | state written | SDK or seed refusal | `--out` exists or cannot be created | `--pack` missing, not canonical bytes, not a pack artifact |
| `command` | step applied, file replaced | library or kernel refusal, state does not verify | `--command` malformed | `--state` missing, not canonical bytes, not a state |
| `advance` | step applied, file replaced | target not after current time, library or kernel refusal, state does not verify | `--to` malformed, `--state` cannot be replaced | as `command` |
| `verify` | state verifies | verification failure | none | `--bundle` missing, not canonical bytes, not a state |

A failed `command` or `advance` leaves the state file byte-unchanged.

### Verification

`verify` checks, in order, and stops at the first failure:

1. `bundleHash` against the file contents: `BUNDLE_HASH_MISMATCH` at `bundle.bundleHash`.
2. The embedded `pack` against its artifact reference (hash, embedded source rebuilt with `buildWorldPack`,
   every reference field): `BUNDLE_FIELD_MISMATCH` at `bundle.pack`.
3. The embedded `genesis` with `verifyGenesisBundle` against the embedded pack. `BUNDLE_HASH_MISMATCH` and
   `BUNDLE_FIELD_MISMATCH` are reported at `bundle.genesis.<field>`; every other refusal passes through
   unchanged.
4. The recorded steps re-executed with `runScenario` (its refusals pass through unchanged): `run` differing is
   `BUNDLE_FIELD_MISMATCH` at `bundle.run`, `finalStateHash` differing is `BUNDLE_FIELD_MISMATCH` at
   `bundle.finalStateHash`.
