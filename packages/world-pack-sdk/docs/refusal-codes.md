# Refusal codes

`MALFORMED_SOURCE`, `UNKNOWN_FIELD`, `MISSING_FIELD`, `UNSUPPORTED_SCHEMA_VERSION`,
`INVALID_IDENTITY`, `INVALID_VERSION`, `INVALID_VERSION_RANGE`, `ENGINE_INCOMPATIBLE`,
`MISSING_DEPENDENCY`, `INCOMPATIBLE_DEPENDENCY`, `AMBIGUOUS_DEPENDENCY`, `DEPENDENCY_CYCLE`,
`DUPLICATE_IDENTITY`, `UNKNOWN_COMPONENT_VERSION`, `UNDECLARED_COMPONENT`,
`UNSUPPORTED_CAPABILITY`, `INVALID_RESOURCE_PATH`, `MISSING_RESOURCE`, `UNREFERENCED_RESOURCE`,
`HASH_MISMATCH`, `ASSET_LENGTH_MISMATCH`, `INVALID_LICENSE`, `MALFORMED_RESOURCE`,
`RESOURCE_IDENTITY_MISMATCH`, `MISSING_CLOCK_POLICY`, `DUPLICATE_CLOCK_POLICY`,
`INVALID_CLOCK_POLICY`, `MISSING_RANDOM_STREAM`, `UNSUPPORTED_RANDOM_ALGORITHM`,
`INVALID_RANDOM_STREAM`, `INVALID_ASSET`, `INVALID_PROVENANCE`, `INVALID_HASH`, `LIMIT_EXCEEDED`, `INVALID_SPACE`, `INVALID_RULE`, `INVALID_CAPABILITY`,
`UNKNOWN_CAPABILITY`, `UNKNOWN_COMMAND`, `INVALID_SEED_COMMAND`, `INVALID_POLICY`,
`INVALID_MIGRATION`, `AMBIGUOUS_MIGRATION`, `MIGRATION_GAP`, `UNSUPPORTED_MIGRATION`,
`INVALID_MIGRATION_CURSOR`, `DUPLICATE_POLICY`, `UNKNOWN_SPACE`, `INVALID_PLACEMENT`, `UNSUPPORTED_POLICY`,
`UNKNOWN_PARENT`, `PARENT_CYCLE` (the semantic place hierarchy, see [collections](collections.md)), plus the domain composition codes
(`MISSING_DEFINITION`, `DEFINITION_CYCLE`, `INVALID_OVERRIDE`, ...). Paths locate the cause, for
example `manifest.actors[0].archetype` or `manifest.archetypes[0]#traits[["routine.ghost",1]]`.

`checkCapabilityCommand` refuses with `CAPABILITY_NOT_HELD` at `capability` and
`CAPABILITY_COMMAND_UNDECLARED` at `type` ([collections](collections.md)).

`HASH_MISMATCH` and `ASSET_LENGTH_MISMATCH` messages state the declared and actual values
(`declared hash differs from the supplied bytes: expected <sha256>, actual <sha256>`).

`MISSING_RANDOM_STREAM` is refused at `manifest.randomStreams` when the manifest declares no named stream.
`UNSUPPORTED_RANDOM_ALGORITHM` is refused at `manifest.randomStreams[i].algorithm` or `.algorithmVersion`
when a stream names an algorithm or version other than the one the kernel supports.

Closed-world validation uses `INVALID_POLICY` at
`manifest.policies[i]#policy.ecology.sources` for a legacy source field, even an empty list.
A rule that offers unbacked inventory is `INVALID_RULE` at
`manifest.rules[i]#rule.intents[j].commandType` (domain reason `rule.closed-world`).
Ordinary runtime offers and positive-inventory object creation are kernel
`precondition-failed` refusals with check `resource.closed-world@1`; see
[containment](../../kernel/docs/containment.md).

Seed commands that offer unbacked material or create an object with positive resource inventory
are `INVALID_SEED_COMMAND` at `manifest.seedCommands[i].payload`. Initial inventory belongs in
declared actor resource components.
