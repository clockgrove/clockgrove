# Source and compatibility

## Source

`source = { manifest, resources, dependencyArtifacts }`.

- `manifest` is the PRD 24.5 manifest. Source uses `id`; only the built artifact has `packId`.
- `resources` maps normalized relative paths (no `..`, no leading `/`, at most 256 bytes) to
  `Uint8Array` bytes (at most 256 resources of 1 MiB each). Every resource must be referenced by
  exactly one manifest entry and match its declared `sha256`.
- `dependencyArtifacts` are the only dependency candidates. Nothing is looked up implicitly.

### Resource encoding

Definition, policy and cognitive-seed resources are compact UTF-8 JSON with keys sorted by
UTF-16 order. Integers are safe JSON numbers and `bigint` values are written as
`{"$bigint":"123"}`. Decoding is strict: invalid UTF-8, invalid JSON, non-integer numbers and
malformed `$bigint` text are `MALFORMED_RESOURCE`. Use `encodeResource` / `decodeResource`.

## Compatibility rules

- `schemaVersion` is `1` (upcast) or `2`; the engine version is `1.0.0`.
- `engineCompatibility` and dependency `versionRange` use only `>=A.B.C <D.E.F`. The engine must
  be in range (`ENGINE_INCOMPATIBLE`).
- Pack versions are explicit `A.B.C`. A plan or document names a pack by id and major version
  (`fixture-hall@1`, `test-world@1`).
- A content change bumps the pack version: once a committed pack's content differs from what was
  qualified or released under its version, the change raises the minor version (`1.0.0` to `1.1.0`,
  decided by the maintainer on 2026-10-27 in issue 802). The major version, and with it the `@1` pin, stays. The
  version is part of the seed projection and of every identity a world derives from it, so the same
  change re-records `expectedSeedProjectionHash`, updates the `pack.version` of the pack's scenario
  and long-run documents, and regenerates its goldens through the golden review workflow
  ([pack conformance](../../simulator/docs/conformance.md#golden-review-workflow)).
- A dependency is resolved from the supplied artifacts: none for the id is `MISSING_DEPENDENCY`,
  none in range is `INCOMPATIBLE_DEPENDENCY`, several in range is `AMBIGUOUS_DEPENDENCY`, and a
  pack naming itself is `DEPENDENCY_CYCLE`. The chosen version and content hash are pinned.
- Declared components must exist at the declared version in the domain component registry, and
  every component used by a trait, archetype or actor override must be declared.
- Every archetype and actor is resolved by the domain resolver against the registered traits, so
  missing definitions, cycles and invalid overrides are caught at build time.
- Exactly one clock policy and at least one named random stream are required. Random streams use
  `pure-rand@8.4.2/xoroshiro128plus` version 1, four int32 words, not all zero.
  `expectedSeedProjectionHash` must be a lowercase SHA-256 and is copied verbatim; it is no
  longer compared with the random-stream hash (it becomes the simulator genesis projection hash).
- Schema 2 declares spaces, rules, capabilities and seed commands ([see collections](collections.md)). `migrations` (see
  [Migrations](migrations.md)); a schema-1 manifest predates these collections, so a non-empty one is refused there
  with `UNSUPPORTED_CAPABILITY`.
- At most one `clockgrove.world-behavior-policy` resource is allowed next to the clock policy.
- Assets need a media type, exact byte length, SPDX-style license and provenance, plus four
  required schema-2 keys:
  - `generation`: `null` or `{ provider, model, parametersSha256 }` (64 lowercase hex characters,
    else `INVALID_PROVENANCE`); any other type is `INVALID_PROVENANCE`.
  - `dimensions`: `null` or `{ width, height }`, positive safe integers up to 16384
    (`INVALID_ASSET`).
  - `anchors`: at most 64 `{ name, x, y }` entries (`LIMIT_EXCEEDED` beyond that); integers in
    `0..width` and `0..height`; unique names (`DUPLICATE_IDENTITY`); non-empty only when
    `dimensions` is set (`INVALID_ASSET`).
  - `footprint`: `null` or `{ width, depth }`, positive integers up to 256 (`INVALID_ASSET`).

## Schema versions and upcasting

`WORLD_PACK_SCHEMA_VERSION` is `2`. Schema 2 has the same top-level manifest fields as schema 1;
each asset additionally carries `generation`, `dimensions`, `anchors` and `footprint`.
`upcastWorldPackManifest(manifest)` is pure and synchronous and never mutates its input. For a
schema-1 manifest it sets `schemaVersion: 2` and, for every asset, adds `generation: null`,
`dimensions: null`, `anchors: []` and `footprint: null`, keeping every other field. Other
manifests are returned unchanged. `buildWorldPack` and `validateWorldPack` upcast schema 1 first,
so a validated pack always has `schemaVersion: 2`, and every schema-1 refusal keeps its code and
path. Any other `schemaVersion` is `UNSUPPORTED_SCHEMA_VERSION` at `manifest.schemaVersion`.

An upcast schema-1 pack must re-record `expectedSeedProjectionHash` (the simulator-computed genesis
projection hash) before seeding.

`test/historic-upcast.test.ts` upcasts committed fixtures under `test/fixtures/historic/`: a
schema-1 manifest, a `clockgrove.needs` version-1 component snapshot and a version-1 event. Each
result is compared with a committed literal SHA-256.

## Asset style presentation data

A world's `reference/asset-style.json` sits beside `reference/presentation.json`, outside
`source.resources` and the simulation manifest. It is versioned independently with
`styleProfileVersion: 1`; changing it does not change the pack content hash or simulation
goldens. Tools can read it with `decodeAssetStyleProfile` from `@clockgrove/contracts`.
See the [complete format](../../../docs/protocols/shared-contracts.md#world-asset-style-profile)
for alpha modes and bounds thresholds, palette strictness, edge kinds and limits for
actor, object, terrain and effect frames. The fixture profile is the pixel-art example.

The asset validator and fixture CLI now enforce this declaration, including soft alpha,
world palette strictness, edge rules and role limits. Assets without a declared profile are
refused with `STYLE_PROFILE_REQUIRED`; malformed profile data is `STYLE_PROFILE_INVALID`.
Manifest v2 permits frame edges up to the 2048 px platform envelope, within the profile's
role limits and atlas strip budget. Generated art requires the complete provenance and provider
grant described in the [manifest contract](../../../docs/protocols/shared-contracts.md#generated-provenance). External
asset commands support validation, atlas builds and golden review from a pinned checkout.
This presentation profile does not replace the SDK's
simulation asset-resource provenance and dimension fields described above.


Asset presentation is separate from simulation content. Declare
`reference/asset-style.json` using the versioned
[style-profile contract](../../../docs/protocols/shared-contracts.md#world-asset-style-profile).
World-location validation, atlas builds and golden review use the
[external asset commands](../../assets/docs/pipeline.md#external-world-commands)
from a pinned Clockgrove checkout; no world npm package is needed.
