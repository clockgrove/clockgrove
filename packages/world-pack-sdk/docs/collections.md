# Spaces, rules, capabilities and seed commands

**Command catalog port.** `WorldPackPorts.commandCatalog` is an optional
`readonly { type: string; version: number }[]` (the simulator passes the kernel's
`worldRegistryIdentity().commands`). An absent catalog is treated as empty, so any rule intent,
capability command or seed command is then `UNKNOWN_COMMAND` / `INVALID_RULE`.

**Space** (resource listed in `manifest.spaces`): `{ id, version, frame, regions, anchorGraph }`.
`frame` is a domain `SpatialFrame` (bigints as `$bigint`) checked by `validateSpatialFrame`;
`regions` are at most 64 domain regions in that frame (`parseSpatialRegion`); `anchorGraph` is
`null` or `parseAnchorGraph` input in that frame. Domain refusals are `INVALID_SPACE` at
`manifest.spaces[i]#frame...`, `#regions[j]...` or `#anchorGraph...`. `id`/`version` must equal
the manifest entry (`RESOURCE_IDENTITY_MISMATCH`); extra fields are `UNKNOWN_FIELD`; a non-record
document is `MALFORMED_RESOURCE`. An optional `parent: { id, version }` names the space's semantic
parent, another space of the pack (a malformed one is `INVALID_SPACE` at `manifest.spaces[i].parent...`);
it is exposed as `SpaceEntry.parent` (`null` when absent). Regions may carry the domain's `parent` and
`dwell` fields ([spatial contracts](../../domain/docs/spatial.md#semantic-hierarchy-and-dwell)). Across
the whole pack the hierarchy must name only declared places and be acyclic: an unknown parent is
`UNKNOWN_PARENT` at `manifest.spaces[i].parent` or `manifest.spaces[i]#regions[j].parent.regionId`
(`.version` for another version of a declared region), and a cycle is `PARENT_CYCLE` at the first
space or region on it in that order. A region may name a region of another space of the pack. Whether
a parent's `worldId` and `timelineId` name the seeded world is checked by the domain at genesis.

**Rule** (resource listed in `manifest.rules`): a domain `RuleDefinition` document checked by
`validateRuleDefinition(doc, commandCatalog, "rule")`. A `RuleValidationError` becomes
`INVALID_RULE` at `manifest.rules[i]#<error.path>`, for example
`manifest.rules[0]#rule.intents[0].commandType`. `ValidatedWorldPack.rules` holds the frozen domain
definitions sorted by id then version, with `ruleEntries` giving their resource entries.
`lintWorldPack(validated)` returns advisory `{ code, path, message }` findings that never refuse a
pack: `SUPERSEDED_EVENT_VERSION` at `<resource path>#rule.trigger.eventVersion` when an event trigger
names a historic event version (for example `routine.selected@1`). The rule still fires, since rule
evaluation reads events at their current version; name the current version at the rule's next version.

**Capability** (inline in `manifest.capabilities`): `{ id, version, kind, commands: [{ type,
version }] }`. `kind` is `inspect`, `embodied-dialogue`, `interpreted-perspective`, `influence`
or `operator-authoring` (`INVALID_CAPABILITY`). Every command must be in the catalog
(`UNKNOWN_COMMAND`); a repeated id and version is `DUPLICATE_IDENTITY`; at most 256 capabilities.

**Seed command** (inline in `manifest.seedCommands`, in execution order, at most 1024):
`{ key, type, version, payload }`. `key` uses the identity format and is unique
(`DUPLICATE_IDENTITY`); type and version must be in the catalog (`UNKNOWN_COMMAND` at `.type`);
`payload` is required (`MISSING_FIELD`) and must be a plain data record that
`ports.canonicalBytes` encodes (`INVALID_SEED_COMMAND`). More than 1024 is `LIMIT_EXCEEDED`.
Order is preserved and hashed; nothing is executed here.

**Actor placement and capability bindings.** Actor documents list `capabilities` as declared
`{ id, version }` refs (`UNKNOWN_CAPABILITY` otherwise) and may carry
`placement: { space: { id, version }, coordinates: [bigint...] }`. An undeclared space is
`UNKNOWN_SPACE`; a coordinate count differing from the frame dimensions, a non-bigint, or (when the
space declares regions) coordinates outside every region of the space (boundaries are inside) is
`INVALID_PLACEMENT`. Documents without placement and with empty capabilities remain valid.
They may also carry `lifecycle: { householdId, parentIds, generation, bornAt }`: a nonempty
`householdId`, `parentIds` as sorted unique object ids, a nonnegative safe-integer `generation` and a
nonnegative bigint `bornAt`. It is exposed as `definitions.actors[i].lifecycle` (`null` when absent).
`lifecycle: null` or another non-record is `MALFORMED_RESOURCE` at `manifest.actors[i]#lifecycle`; a
wrong-typed or out-of-range field (a number `bornAt`, a negative `generation` or `bornAt`, unsorted or
duplicate `parentIds`) is `MALFORMED_RESOURCE` at `manifest.actors[i]#lifecycle.<field>`; a missing
field is `MISSING_FIELD` and an extra field `UNKNOWN_FIELD`, both at that path.

**Commands through a capability binding.** `checkCapabilityCommand(validated, { actorId, capability: {
id, version }, type, version })` is pure and decides whether a command submitted through an actor's
binding is accepted: the actor in `definitions.actors` must hold the binding (`CAPABILITY_NOT_HELD` at
`capability` otherwise, also for an undeclared actor), and the bound capability must declare the command's
type and version (`CAPABILITY_COMMAND_UNDECLARED` at `type`). It returns `{ ok: true, value: { actorId, id,
version, kind } }` or `{ ok: false, error: { code, path, message } }`, with paths naming the request field.
It does not authorize the submitter; the scenario runner uses it for `via` steps.

**Behaviour policy.** A policy resource `{ type: "clockgrove.world-behavior-policy", policy }`
whose `policy` is a domain `WorldBehaviorPolicy` accepted by `validateWorldBehaviorPack`
(`INVALID_POLICY` at `manifest.policies[i]#policy...`). The policy sections are closed: an unknown or
misspelt section is `INVALID_POLICY` at `manifest.policies[i]#policy.<section>` and never reaches a
content hash. The SDK takes every domain path from `DomainValidationError.path`, never from message
text. A second one is `DUPLICATE_POLICY`; other
policy types are `UNSUPPORTED_POLICY`. It is exposed as `ValidatedWorldPack.behaviorPolicy`
(`null` when absent).

**`ValidatedWorldPack.definitions`** holds the decoded, frozen `traits`, `archetypes` and `actors`
documents (actors include `capabilities`, `placement` and `lifecycle`, `null` when absent), sorted by id and
version, so a consumer can resolve effective objects without re-decoding resources. It is not part
of any hash document.
