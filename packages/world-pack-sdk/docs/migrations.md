# Migrations

Schema-2 packs declare `migrations` entries `{ id, version, path, sha256 }`. The resource document
is `{ id, version, fromPackVersion, toPackVersion, steps: [{ key, type, version, payload }] }` with
1 to 256 steps (`INVALID_MIGRATION` when empty, `LIMIT_EXCEEDED` above 256), unique step keys
(`DUPLICATE_IDENTITY`), commands present in `commandCatalog` (`UNKNOWN_COMMAND`) and plain-data
record payloads (`INVALID_MIGRATION`). Extra fields are `UNKNOWN_FIELD`; a document `id`/`version`
that differs from its entry is `RESOURCE_IDENTITY_MISMATCH`; versions are explicit `A.B.C`.

Chain rules: `fromPackVersion` must be below `toPackVersion` and `toPackVersion` must not exceed
`manifest.version` (`INVALID_MIGRATION`); two migrations with one `fromPackVersion` are
`AMBIGUOUS_MIGRATION`; a `toPackVersion` that is neither `manifest.version` nor another
migration's `fromPackVersion` is `MIGRATION_GAP`. So each declared `fromPackVersion` reaches
`manifest.version` through exactly one chain. Manifest order never changes the artifact. Schema 1
still refuses a non-empty list with `UNSUPPORTED_CAPABILITY`.

`planWorldPackMigration(pack, fromPackVersion, completedSteps)` is pure and total. It takes a
`ValidatedWorldPack` and returns `{ ok: true, value }` with the frozen ordered steps
`{ stepId, fromPackVersion, toPackVersion, type, version, payload }`, where `stepId` is
`<migrationId>@<version>/<stepKey>`, or a refusal `{ ok: false, error }`. Planning from
`manifest.version` yields an empty plan; an undeclared version is `UNSUPPORTED_MIGRATION` at
`fromPackVersion`.

Cursor semantics: `completedSteps` counts steps already applied across the whole chain. The plan
is the full plan (cursor 0) with its first `completedSteps` steps removed, so a run can resume
after any step. It must be an integer from 0 to the total step count, else
`INVALID_MIGRATION_CURSOR` at `completedSteps`.
