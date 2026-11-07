# Verification

`verifyGenesisBundle({ bundle, artifact, source }, { sha256 })` takes exactly those three fields, with
`bundle` a `Uint8Array`, and resolves to `{ ok: true, value: { bundleHash } }` or
`{ ok: false, error: { code, path, message } }`. It never throws. A bundle verifies only when every
field equals a fresh re-seeding of the artifact. It stops at the first failing check, in this order:

1. Input shape: a plain record with exactly `bundle`, `artifact` and `source` (`MALFORMED_INPUT` at
   `input` or `input.bundle`, `UNKNOWN_FIELD` at `input.<extra>`, `MISSING_FIELD` at `input.<field>`).
2. Strict decode of the `clockgrove-canonical-v1` bytes (UTF-8, every kernel tag); bytes whose
   re-encoding differs from the input, such as added whitespace, are `MALFORMED_BUNDLE` at `bundle`.
3. Closed field set (`UNKNOWN_FIELD` at `bundle.<field>`, `MISSING_FIELD` at `bundle.<field>`), then
   `kind` and `version` (`UNSUPPORTED_BUNDLE_VERSION` at `bundle.kind` or `bundle.version`).
4. `bundleHash` is recomputed from the bundle without it: `BUNDLE_HASH_MISMATCH` at `bundle.bundleHash`.
5. The artifact and source are re-seeded with `seedGenesis`; its refusals (for example
   `ARTIFACT_MISMATCH` at `artifact.<field>`) pass through.
6. Top-level fields are compared in the documented bundle order by canonical encoding; the first
   difference is `BUNDLE_FIELD_MISMATCH` at `bundle.<field>`.
