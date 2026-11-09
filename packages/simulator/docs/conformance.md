# Pack conformance

One shared suite, `packages/simulator/test/conformance/`, runs under `pnpm test` and proves every
committed world pack. Packs are data under `worlds/`. The suite is not a production loader; the
`clockgrove pack` commands ([CLI](cli.md)) read the same layout byte-exact.

## External worlds from a pinned checkout

An external world consumes a Clockgrove source checkout at an exact commit; no npm publishing
is required. Use the Node and pnpm versions pinned in that checkout's `mise.toml` and
`package.json`. Install its locked dependencies with lifecycle scripts disabled:

```sh
git clone https://github.com/clockgrove/clockgrove.git clockgrove
git -C clockgrove checkout <full-clockgrove-commit>
pnpm --dir clockgrove install --frozen-lockfile --ignore-scripts
```

Keep this checkout separate from the world repository. From the world repository, invoke the
checkout's conformance entry point with the world's pack and asset-manifest directories:

```sh
node ../clockgrove/scripts/check-world-pack.mjs \
  --pack worlds/sample --assets assets/manifests
```

Both options are required exactly once; paths are absolute or relative to the caller's working
directory. For a pack without presentation metadata, pass an existing empty asset-manifest
directory. The command never discovers or tests Clockgrove's committed packs. It reads the selected
pack in the layout below and reuses the shared validation/build, reproducibility, immutability,
genesis, contract coverage, presentation binding and scenario/golden-layout checks. Every selected
scenario runs in Node and actual workerd, including parity, assertions, goldens, rule intents and
runtime observations. Presentation manifests resolve under the explicit `--assets` directory.
Engine-source neutrality remains a platform repository check; external world source is allowed
to contain its own identities.

Successful runs print the existing `conformance-run` observation lines followed by
`{"status":"ok","reports":[...]}`. Exit code 0 means all checks passed, 1 means a conformance
failure, 2 means invalid arguments or a directory option that is missing or not a directory,
and 70 means an unexpected internal error. Failures print their diagnostic to stderr. A missing
manifest in an existing pack directory is a `load-pack` conformance failure. Golden mismatches
use the same `.actual.json` review workflow below; committed goldens are never rewritten.
Temporary Workers resources are disposed on success and failure.

This entry point supports the same dependency-free packs as the shared suite. It does not
run `long-runs/`, publish static assets or start the web shell. CI in an external repository can
install a pinned checkout and invoke this command on every PR without copying the world into
Clockgrove or publishing workspace packages.

## World-repository CI recipe

Keep the full 40-character Clockgrove commit in the world repository's CI configuration as
`CLOCKGROVE_COMMIT`; update it deliberately when upgrading the platform. After CI checks out
the world repository, the following commands install the separate pinned platform and validate
Raccoon World's actual repository layout:

```sh
git clone https://github.com/clockgrove/clockgrove.git ../clockgrove
git -C ../clockgrove checkout --detach "${CLOCKGROVE_COMMIT:?set the pinned platform commit}"
pnpm --dir ../clockgrove install --frozen-lockfile --ignore-scripts
node ../clockgrove/scripts/check-world-pack.mjs \
  --pack worlds/raccoons --assets assets/manifests
```

Provision the pinned Node and pnpm versions before installation, on a runner supported by the
checkout's workerd toolchain. This single check validates the pack, runs every committed scenario
in both runtimes, and compares every golden; a nonzero exit must fail the CI job. For another
world, change only the two world-relative input paths. The world remains the current directory.
The check needs asset manifests, not hydrated art bytes. Rendering needs the reviewed art hydrated
through the world repository's Git LFS setup.

Local verification used Raccoon World commit
`bfb69ada45a0ac549d5fceec5e42add26b7aa33e` against Clockgrove commit
`86a4e14e59dddf2a342a7b6febcf03b4233faeca`: all 24 Node/workerd reports passed.
This is local conformance evidence, not an external CI result. The world maintainer adds the
workflow to that repository and pins the delivered platform commit. For a themed browser build
and a complete local runtime session, use the
[external shell commands](../../../docs/protocols/world-presentation.md#external-local-session).

## Pack directory layout

```text
worlds/<dir>/manifest.json                    the SDK source manifest
worlds/<dir>/resources/<manifest path>        the exact resource bytes
worlds/<dir>/scenarios/<scenario-name>.json   scenario documents ([Scenarios](scenarios.md))
worlds/<dir>/goldens/<scenario-name>.json     the exact canonical bundle bytes runScenario returns
worlds/<dir>/long-runs/<scenario-name>.json   long-horizon qualification scenarios (not part of the pack)
worlds/<dir>/presentation.json             optional presentation metadata (not part of the pack)
worlds/<dir>/README.md
```

`long-runs/` holds the summarised 30-day and one-year scenario documents that `pnpm run
qualify:wave1:long-runs` runs in the qualification workflow. Neither this suite nor the CLI reads them, they
have no goldens and they are not in the pack artifact.

`manifest.json` and the scenario files use the SDK resource JSON conventions (`encodeResource` /
`decodeResource`: key-sorted JSON, bigints written as `{"$bigint":"n"}`). Resource files are the bytes the
manifest `sha256` values cover, stored under `resources/` at the manifest `path`. A golden is not JSON text
but the kernel `canonicalBytes` of the scenario bundle, byte for byte. The committed packs are
`worlds/fixture/` (`clockgrove.test-world@1.1.0`) and `worlds/fixture/reference/`
(`clockgrove.fixture-hall@1.1.0`).

## Discovery

Every directory recursively under `worlds/` that contains a `manifest.json` is a committed pack. Nothing
else is discovered; there is no registry or configuration. The suite loads the manifest, every file under
`resources/`, every `scenarios/*.json` and every `goldens/*.json` byte-exact (copies, never rewritten) and
builds the SDK source `{ manifest, resources, dependencyArtifacts: [] }`; packs with dependencies are not
supported by the suite. When no pack is committed (or `worlds/` is absent) only the engine-neutrality check
runs and the suite passes. A changed file under `worlds/` invalidates the cached Turbo `test` result,
because the task inputs include `$TURBO_ROOT$/worlds/**`.

## Checks

Failures are `pack "<dir>": check "<check>": <detail>`, one line per problem.

| Check | Proves |
| --- | --- |
| `load-pack` | the manifest and scenario files decode as SDK resource JSON |
| `validate-and-build` | `validateWorldPack` and `buildWorldPack` with `createSimulatorPackPorts` succeed |
| `reproducible-build` | building the same source twice and from a reordered copy gives identical artifact references (content, resource-manifest, asset-manifest and migration-set hashes) and identical artifact bytes |
| `artifact-immutability` | the built artifact and bytes record are frozen and cannot be changed by the caller, mutating returned bytes does not affect a later build, and building leaves the loaded source (manifest and resources) unchanged |
| `seed-genesis` | the recorded `expectedSeedProjectionHash` equals the actual seed projection, `seedGenesis` succeeds and `verifyGenesisBundle` verifies the genesis bundle |
| `contract-coverage` | at least one space; a placed mobile subject with needs; a stationary conversational object (a placed actor without needs bound to an `embodied-dialogue` or `interpreted-perspective` capability); a resource holder (a `clockgrove.resource` component); a need (a `clockgrove.needs` component); a scripted memory entry (`kind: "memory"` in a `clockgrove.scripted-cognition` seed); a rule; a capability |
| `scenario-golden-layout` | at least one scenario; every scenario file has exactly one golden and every golden exactly one scenario; no other entries in `scenarios/` or `goldens/` |
| `node-workers-parity` | each scenario runs in Node and in actual workerd and yields byte-identical bundles with equal bundle hashes |
| `workers-runtime` | workerd (Miniflare from the pinned root Wrangler, bundled with `wrangler deploy --dry-run`) starts and answers as `Cloudflare-Workers`; the resolved Wrangler equals the root `package.json` pin |
| `scenario-assertions` | every assertion recorded in the bundle passed |
| `golden-match` | the bundle bytes equal the committed golden |
| `rule-intent-coverage` | at least one of the pack's rules emits an intent in some committed scenario (rule intents are recorded by the runner and never executed) |
| `run-observations` | every run has a runtime identifier, duration and peak memory (or a stated reason for null), next to its bundle hash |
| `presentation-bindings` | when the pack has `presentation.json`, it decodes as `PackPresentation` ([shared contracts](../../../docs/protocols/shared-contracts.md#asset-manifests-and-pack-presentation)), names the pack's id and version, binds only declared actors, and every binding and effect resolves to a decodable `assets/manifests/<assetId>/<family>.json` that depicts that actor (its `semantic.entity`) or, for a shared variant with a null entity, the actor's archetype. The file is outside the pack source, so `seed-genesis` and `golden-match` prove the state hashes do not depend on it |
| `engine-neutrality` | no engine source under the `contracts`, `domain`, `kernel`, `world-pack-sdk` and `simulator` `src` directories contains, outside comments, an identity declared by a committed pack (its id and the ids of its archetypes, traits, spaces, actors, rules, capabilities, policies, cognitive seeds and assets) or a reference-world name (`raccoon`, `stevie`, `gracie`, `green-lake`, case-insensitive). A comment that mentions one is not a violation |

Both runtimes receive the same committed bytes, decode them with the SDK, build the artifact and call
`runScenario`; only the runtime differs. The suite compares the decoded Node bundle bytes with the Workers
bytes and with the golden.

## Golden review workflow

Goldens are reviewed artifacts: the suite never writes, rewrites or deletes a committed file under
`worlds/`. On a mismatch or a missing golden the check fails with a semantic difference (the differing
top-level bundle fields and the first differing paths) and writes the actual bundle, in exact canonical
bytes, next to the golden as `worlds/<dir>/goldens/<scenario-name>.actual.json`, whose path is part of the
message (`... was written to <path>`). `*.actual.json` files are git-ignored, are never loaded as goldens,
and are removed by the next run in which that golden matches. Workers and temporary directories are
disposed in a `finally`, including when a check fails.

The CLI's `simulate scenario` resolves named scenarios from the committed packs only (`worlds/`) and runs the
same scenario execution path as this suite; it reports a golden mismatch but never writes a golden or an
actual bundle. The golden review workflow above is unchanged.

## Authoring values from failures

A pack author who can only run `pnpm test` and read the checkout gets every value to commit from the
failure output; the test still fails until the values are committed.

1. Run `pnpm test`.
2. `validate-and-build` failures end with `actual values:`: each manifest resource `sha256` (and asset
   `byteLength`) that differs from the bytes under `resources/`, and the actual
   `expectedSeedProjectionHash` (use any 64-hex placeholder until then). A wrong but well-formed seed
   projection hash fails `seed-genesis` with the actual value.
3. A `golden-match` failure names `goldens/<scenario-name>.actual.json`. Review it and the reported
   difference, then copy its bytes unchanged to `goldens/<scenario-name>.json`.
4. Rerun `pnpm test` until it passes, then commit the pack.

## Runtime observations

Each run is reported as one `conformance-run {...}` log line and as a `RunReport`:
`{ pack, scenario, runtime, bundleHash, durationMs, peakMemoryBytes, peakMemoryNullReason }`. They are
measured by the harness, never by simulator sources, and are not part of the hashed bundle or the golden:

- Node: `runtime` is `node/<version>`, `durationMs` is wall time around the run, `peakMemoryBytes` is the
  process high-water RSS (`process.resourceUsage().maxRSS`).
- workerd: `runtime` is `Cloudflare-Workers (workerd)`, `durationMs` is the host-side round trip of the
  request, and `peakMemoryBytes` is `null` with `peakMemoryNullReason` stating that workerd has no
  in-isolate memory API. Measuring it from the host is left to wave qualification.

The `run-observations` check fails when a runtime identifier, duration, peak memory (a number, or null
with a reason) or bundle hash is missing.

## Negative controls

`negative-controls.test.ts` runs the same checks against temporary pack directories written from the
section-hall simulator fixture (`fixture-pack.ts`) and requires each planted defect to fail with a message
naming the pack and the check: a mismatched golden, a missing golden, and an engine source that uses a
pack identity or a reference-world name.
