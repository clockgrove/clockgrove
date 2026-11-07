# @clockgrove/simulator

Deterministic world simulation: seeds genesis bundles from validated world-pack artifacts, runs
declarative scenarios against the kernel and checks committed packs for conformance. The `clockgrove`
CLI exposes these headlessly.

## Package boundary

The simulator may depend only on these workspace packages: `@clockgrove/contracts`,
`@clockgrove/domain`, `@clockgrove/kernel` and `@clockgrove/world-pack-sdk`.

## API

- `createSimulatorPackPorts({ sha256 })` returns the `WorldPackPorts` artifacts for seeding must be
  built with: kernel `canonicalBytes`, the supplied `sha256` and a `commandCatalog` taken from
  `worldRegistryIdentity().commands`.
- `seedGenesis(input, { sha256 })` takes exactly `{ artifact, source }` and resolves to
  `{ ok: true, value: { bundle, bytes } }` or `{ ok: false, error: { code, path, message } }`. It never
  throws, executes no pack-supplied code and uses no clock, randomness or I/O. `bundle` is deeply
  frozen and `bytes` is the kernel `canonicalBytes(bundle)`.
- `previewSeedProjection(source, { sha256 })` resolves to `{ ok: true, value: { actual } }` with the
  seed projection hash the source actually produces, ignoring its recorded
  `expectedSeedProjectionHash`; it is how a pack author records that hash. Refusals have the same shape
  as for `seedGenesis`.

- `verifyGenesisBundle(input, { sha256 })`: see [Verification](docs/verification.md).
- `runScenario({ artifact, source, scenario }, { sha256 })`: runs a declarative scenario and returns a
  canonical scenario bundle; see [Scenarios](docs/scenarios.md).

## Subsystem contracts

- [Genesis](docs/genesis.md): the genesis bundle, seeding and the seed projection.
- [Verification](docs/verification.md): verifying a genesis bundle.
- [Scenarios](docs/scenarios.md): the scenario document, steps, variants, assertions and the scenario bundle.
- [Pack conformance](docs/conformance.md): the committed pack layout under `worlds/`, the shared
  conformance suite, the golden review workflow and runtime observations.
- [CLI](docs/cli.md): the `clockgrove` executable, its output envelope, exit codes, the pack artifact file,
  the `pack validate`, `pack build` and `pack test` commands, the `simulate scenario` and `simulate diff`
  commands, and the session commands `simulate seed`, `command`, `advance` and `verify`.
- [Refusal codes](docs/refusal-codes.md): the stable refusal codes.

## Package boundary notes

`scripts/check-boundaries.mjs` applies the ambient-nondeterminism check to
`packages/simulator/src`, and dependency-cruiser enforces the inward-only rule
`simulator-depends-only-inward`.

The `clockgrove` CLI lives in `cli/`, outside `src/`, and may perform I/O. Dependency-cruiser enforces
`cli-depends-only-inward`: it may import only its own files, shared contracts, domain, kernel, the
world-pack SDK, the simulator sources, Node built-ins and the root `wrangler`; a committed negative fixture
proves `@clockgrove/testkit`, `@clockgrove/application`, `@clockgrove/persistence` and `apps/` are rejected.
