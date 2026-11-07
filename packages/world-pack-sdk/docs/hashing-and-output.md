# Hashing and output

## Hash inputs

Each hash is `sha256(canonicalBytes(document))` over a `{ kind, version: 1, ... }` document.

| Hash | Inputs |
| --- | --- |
| `resourceManifestHash` | archetype, trait, actor, policy, cognitive-seed, space and rule entries: field, id, version, path, sha256, each list sorted by id/version |
| `assetManifestHash` | complete asset entries (path, sha256, byte length, media type, license, provenance, `generation`, `dimensions`, `anchors`, `footprint`) |
| `migrationSetHash` | the normalized migration entries sorted by `fromPackVersion`: id, version, path, sha256, `fromPackVersion`, `toPackVersion` and the ordered steps (key, type, version, payload); an empty set hashes exactly as before |
| `contentHash` | schema version, id, version, engine range, build tool version, resolved dependencies, components, the three hashes above, random streams, seed projection hash, clock policy, capabilities (sorted), seed commands (in execution order) and the behaviour policy |

Lists are normalized (sorted) before hashing, so manifest key and list order, and resource
inventory order, never change a hash. Any changed resource byte, license, version or dependency
does.

## Immutable output

`buildWorldPack` returns `{ artifact, bytes }`. `artifact` is a frozen `WorldPackArtifactRef`
(`packId`, `version`, `contentHash`, `engineCompatibility`, `resourceManifestHash`,
`assetManifestHash`, `migrationSetHash`, `buildToolVersion`). `bytes` are the exact canonical bytes
that were hashed (typed arrays cannot be frozen; treat them as read-only). Inputs are never mutated.
