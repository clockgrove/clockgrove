# Shared identity, authority, and protocol contracts

**Status:** Wave 0 protocol baseline  
**Package:** `@clockgrove/contracts`  
**Current protocol version:** 1  
**Current command, event, and Queue schema version:** 2  
**Prior compatible command, event, and Queue schema version:** 1

## Purpose and boundary

`packages/contracts/` owns provider-neutral wire and domain vocabulary. It has no filesystem, network, database, queue-provider, Cloudflare, browser, model, authentication-provider, or other I/O authority. Provider SDK identifiers and types remain in adapters. An authentication-provider subject is data inside an external-identity reference; it is never a `PrincipalId`. Runtime placement, database keys, model call identifiers, and queue delivery identifiers likewise cannot substitute for branded Clockgrove domain IDs.

All Clockgrove IDs are opaque branded strings. Callers may compare or transport them but must not infer scope or provider placement from their bytes. Externally initiated IDs are UUIDv7 and are validated with `decodeExternallyInitiatedId`. IDs created within deterministic execution come from an injected `DeterministicIdSource` whose declared seed is the command ID, event index, and named random stream. The contracts package defines that seam and does not choose randomness, read a clock, or generate an ID itself.

## Actor addresses and scope

Actor addresses use version 1 and the six canonical variants: `world`, `space`, `subject`, `process`, `session`, and `presence`. Their common scope is tenant, world, and timeline. Because IDs are deliberately opaque, decoding an address requires an `ActorTargetBinding` resolved by trusted application authority. The decoder compares all four relevant identities—the variant ID and tenant/world/timeline scope—and rejects any mismatch. A world actor's variant ID must also equal its world-scope ID. No provider routing identifier is accepted as scope evidence.

## Execution context trust boundary

`decodeExecutionContext` is an untrusted, strict decoder. It preserves every field from the source `ExecutionContext`, rejects unknown fields, supports only execution-context version 1 and protocol version 1, and enforces structural scope dependencies. In particular, timeline-local fields require a world and space/session/subject fields require a timeline; a persona requires a world membership.

Decoding never creates trusted authority. Trusted gateway/application composition imports the deliberately separate `@clockgrove/contracts/trusted` entrypoint to:

- construct a `TrustedExecutionContext` only after authentication and authorization;
- derive the small `ExecutionContextRef` carried by commands;
- narrow an existing trusted context.

Narrowing may remove roles, grants, world/timeline/actor/session scope, or privacy categories. It cannot add or change them. Tenant, principal, external identity, workspace membership, correlation/causation, request, code, and protocol identity remain immutable. The TypeScript trusted brand prevents ordinary decoded values from satisfying trusted APIs. The dependency-cruiser rule `pure-packages-cannot-mint-trusted-context` lets the domain, kernel, world-pack SDK and simulator (`src` and `cli`) import only the public `@clockgrove/contracts` entry. It refuses, type-only imports included, the trusted entrypoint and any deep `packages/contracts/src` module, such as `execution-context.ts`, which holds the trusted brand and its cast; `pnpm check` proves it rejects each package's negative fixture. `apps/runtime` is the trusted composition that imports the entrypoint today. `packages/application` is outside the rule, but the capability boundary in `scripts/capability-boundaries.mjs` limits its sources to the root `@clockgrove/*` entries, so it cannot import the trusted entrypoint either. Clients, models, tools, Queue messages, and MCP servers are untrusted inputs and cannot invoke that authority path.

## Approved privacy concretization

The version-1 privacy vocabulary is exactly:

- `public_scene`
- `private_cognition`
- `conversation`
- `credential`
- `operator_evidence`

An individual record has one `PrivacyClass` category. A `PrivacyCeiling` is represented as `{ version: 1, allowedCategories: PrivacyCategory[] }`; the container and field names are this package's concrete wire choice. There is no scalar ordering. Ceiling comparison is explicit set inclusion, and narrowing may only retain or remove categories. Unknown categories, duplicate categories, malformed containers, unknown versions, and attempted broadening fail deterministically.

Privacy category allowance grants no tenant, world, timeline, actor, or session authority. Those checks remain separate. Only `public_scene` is eligible for a shared-scene projection; all other categories are categorically ineligible. A per-audience scene projection may also carry `private_cognition` fields for an audience the server decided allows them ([realtime projection](realtime-projection.md#audience-assets-and-privacy)); they never enter the shared view.

## Commands and attribution

Command schema versions 1 and 2 are the supported compatible window; version 2 is current. A mutating `CommandEnvelope` preserves command identity, logical target, expected stream/partition/routing values, optional simulation time, issuance time, trusted context reference, typed payload, and immutable `AttributionIntent`. Missing attribution is invalid.

Humans, actors, rules, schedulers, workflows, and tools share the same attribution pair. A principal may be absent for autonomous work. `effectiveActorId` and `causalRootActionId` may not be absent. The pure `sealAttribution` operation produces an `AttributionEnvelope` only by validating the intent and adding an `AuthorityDecisionId`; completed events require that sealed form.

The idempotency conformance helper models, but does not store, command receipts. No stored receipt means execute. The same command ID with byte-identical command bytes returns the stored result. Reusing an ID with different bytes raises `CommandIdempotencyInvariantError`, a security/invariant failure. Canonical persistence is deliberately outside this package.

## Events and ordering

Event schema version 2 is current. Event decoding preserves all event-envelope fields, including sealed attribution, optional causal and decision identities, policy versions, privacy, hash, and typed payload. The following orderings remain distinct:

- `streamSequence` orders one aggregate stream and cannot compare different streams;
- `partitionSequence` orders one physical consistency partition and cannot compare different partitions;
- `journalPosition` compares database ingestion order for search/dispatch and makes no global causal claim;
- `simulationTime` plus a deterministic tie-break key orders scheduled simulation work;
- cross-partition causality is expressed through explicit causal IDs and later transfer/saga state;
- a branch snapshot records a versioned vector of partition heads, not a global world sequence.

The helpers encode these distinctions instead of exposing a misleading universal sequence comparator.

## Queue envelope and delivery

Queue schema versions 1 and 2 are supported. The provider-neutral logical channels are exactly `world-reactions`, `cognitive-indexing`, and `external-effects`. The envelope preserves message, scope, source event, effect, correlation/causation, attempt hint, availability, and payload fields with their source optionality. A timeline requires a world.

Delivery attempts are not semantic actions. `queueSemanticDeduplicationKey` takes the separately authorized semantic `ActionId` and intentionally ignores `messageId` and `attemptHint`. A provider queue's receipt or retry ID never becomes domain identity.

## Versions, upcasting, and goldens

Unknown, non-integer, or malformed versions are rejected. Compatible additive command and Queue consumers accept the current version and one prior version. Event history uses a pure explicit upcast path: version 1's singular `policyVersion` becomes version 2's `policyVersions.default` without changing the event type, payload, identities, attribution, ordering, or privacy meaning. Version 2 is validated directly.

`upcastEventBytes` accepts supplied bytes, performs no I/O, reads no ambient state, and always produces the same validated value for identical bytes. Tests load the fixtures; the upcaster does not. Golden fixtures under `packages/contracts/test/fixtures/` cover both supported event schema versions and assert preservation of the historic `WeatherChanged` meaning. A semantic or required-field change requires a new schema version and golden/upcaster addition; optional additive fields may remain within a version only when older consumers preserve meaning.

## Authority decisions, command receipts, and the event type registry

`decodeAuthorityDecision(value, path?)` decodes a version-1 `AuthorityDecision`: `authorityDecisionId`, `outcome` (`allow` or `deny`), `tenantId`, `worldId`, `timelineId`, `commandId`, `actionId`, `attribution` (an `AttributionIntent`), `inputs`, `decidedAt`, and `reasonCode`. `inputs` is the trusted authorization result the decision used: optional `principalId`, `worldMembershipId` and `personaId`, unique `roles` and `grants`, and a `privacyCeiling`. `reasonCode` is required for `deny` and forbidden for `allow`. `actionId` must equal `attribution.causalRootActionId`. `decidedAt` is an ISO-8601 UTC timestamp. Unknown fields and unknown or malformed versions fail with `ContractDecodeError`. This package does not mint decision IDs; trusted application code does.

`decodeCommandReceipt(value, binding, path?)` decodes a version-1 `CommandReceipt`, decoding `target` with the supplied `ActorTargetBinding` and requiring `tenantId` to equal the target tenant. Fields: `provenance`, `tenantId`, `commandId`, `requestHash`, `status`, `target`, optional `attribution`, `actionId`, `correlationId`, optional `causationId`, `expected` (stream sequence, partition revision, routing epoch, each optional), optional `authorityDecisionId`, `committedEventIds`, optional `result`, `createdAt`, `committedAt`, and `failedAt`.

- An `attributed` receipt always has `attribution` and `actionId` (equal to `attribution.causalRootActionId`), and has `authorityDecisionId` exactly when its status is not `pending`.
- A `legacy-wave0` receipt represents a row committed before the attributed-receipt migration. It has no `attribution`, `actionId` or `authorityDecisionId` and otherwise follows the same status and timestamp rules.

Receipt status machine (`COMMAND_RECEIPT_TRANSITIONS`): `pending` moves to `committed`, `rejected` or `failed`; terminal statuses never change. The decoder validates a stored state, not a transition.

| status | `committedEventIds` | `result` | `committedAt` | `failedAt` |
| --- | --- | --- | --- | --- |
| `pending` | empty | absent | absent | absent |
| `committed` | any (unique) | present | present | absent |
| `rejected` | empty | present | present | absent |
| `failed` | empty | absent | absent | present |

`createdAt` is always present. `result` is a JSON value. Any other combination fails with `ContractDecodeError`.

`createEventTypeRegistry(entries)` builds an `EventTypeRegistry` only from explicitly supplied `{ type, schemaVersion }` entries (positive integer versions) and refuses duplicate entries; the package ships no event-type list. `resolveEventType(registry, type, schemaVersion)` returns the registered entry, or throws `EventTypeResolutionError` (a `ContractDecodeError` subclass) whose `reason` is `unknown-type` for an unregistered type and `unknown-version` for a registered type at an unregistered version.

Goldens for an allow decision, a deny decision, a committed receipt and a rejected receipt live under `packages/contracts/test/fixtures/journal-records/`.

## Verification

The package's strict TypeScript check and Vitest suite cover opaque type separation, UUIDv7 validation, every actor variant, cross-scope rejection, untrusted/trusted execution paths, authority narrowing, exact privacy vocabulary, attribution sealing, envelope fields and versions, ordering distinctions, partition-head vectors, semantic Queue deduplication, byte-level command idempotency, and deterministic golden upcasting. The repository boundary check cruises `packages/contracts/src` and fails any dependency outside that source boundary.

## Living-yard observation vocabulary

The separately versioned HTTP `ObservationRequest` and `LivingScene` vocabulary is defined in
[living-yard observation](living-yard-observation.md). It transports only explicitly enumerated
`public_scene` data, lossless decimal revision/time and renderer-neutral semantic identities,
frames, poses and placeholder bindings. Strict decoders reject additional fields at each nesting
level. The legacy diagnostic `DiagnosticSceneProjection`, `ProjectionMessage` and no-op wire semantics remain
unchanged; an observation request carries no command or authority decision identity.


## Successor realtime scene vocabulary

[Realtime projection](realtime-projection.md) freezes the successor scene envelopes, snapshots,
ordered patches, transient cues, arrival, compatibility, assets and observer navigation contracts.
The successor `SceneProjection` is distinct from diagnostic v1 and the separately versioned
`LivingScene` HTTP observation contract. Decoding a scene never grants viewing or operator authority.

## Asset manifests and pack presentation

`packages/contracts/src/asset-manifest.ts` freezes asset-manifest version 2, the version a scene
snapshot's `compatibility.assetManifestVersion` names. One `AssetManifest` describes one sprite strip,
identified by `assetId` and `animationFamily` (`idle`, `walk`, `sniff`, `eat`, `play`, `shelter`,
`static`, `loop`). It records the Wave 4 plan §12 fields: `source` (kind, path
`assets/source/<assetId>/<animationFamily>.png`, creator, tool), the SPDX `license`, `provenance`
(described below), `review`
(status `pending`, `approved` or `rejected`, the human reviewer's login and time, both null exactly
when pending), `semantic` (role, entity, archetype), `frames` (width and height up to 2048 px, count up to
32, and a duration exactly when animated), `anchor`, `footprint` in millimetres, opaque `bounds`, a sorted
`palette`, the source `contentHash`, the `atlas` location of frame 0 and an `accessibilityLabel`.
`decodeAssetManifest` refuses unknown fields, missing structural fields and non-kebab-case ids.
Version 1 is no longer accepted; repository manifests and presentations use version 2, and scene
snapshots advertise `compatibility.assetManifestVersion: 2`. Simulation-pack versions and hashes
are independent of this presentation migration. The 2048 px frame envelope is WebGL's guaranteed
minimum texture size; each world's style profile and the atlas strip budget impose tighter limits.

#### Generated provenance

Every provenance record keeps `prompt` (generation prompt or serialized generator parameters,
or null) and `references`. A generated asset also records non-empty `model`, `provider`, `route`
and `providerTermsVersion`, plus `outputGrant`. Reference entries are lowercase SHA-256 hashes
of the input references. An empty references array records that no references were used; it does
not replace the prompt or parameters. Authored and imported assets retain the prompt/references
shape without generated fields.

`outputGrant` uses [Assetforge issue 47](https://github.com/clockgrove/assetforge/issues/47)'s field
names directly:

| Field | Meaning |
| --- | --- |
| `license` | SPDX identifier granted by the provider, or `LicenseRef-<provider>-<plan>` for other terms |
| `plan` | Provider plan or route used for this output |
| `commercial` | Boolean: whether the grant permits commercial use |
| `relabel` | Boolean: whether ownership permits declaring the target's own licence |
| `attribution` | Required credit line when the grant requires one; optional otherwise |

The manifest's top-level `license` remains the licence the asset declares. Complete generated
provenance permits MIT only when the commercial provider grant permits relicensing, including
provider ownership terms recorded as a `LicenseRef-<provider>-<plan>`. A
`CC-BY-4.0` grant keeps `CC-BY-4.0` and requires a non-empty attribution; it cannot be declared MIT.
Provider grants may use `AND` expressions: every conjunct applies. A grant that disallows
relabelling permits a declared licence equal to one of its conjuncts when every conjunct is a
permitted licence. A CC-BY conjunct requires licence retention and credit even when the grant
claims `relabel: true`.
Non-commercial and provider-retained grants are refused. The pipeline never silently relabels an
asset. Missing or partial generated provenance is refused by the deploy gate with a stable reason;
malformed field types remain decoder errors. Human review remains a separate requirement.

Generated deploy refusals are:

| Code | Reason |
| --- | --- |
| `GENERATED_PROVENANCE_INCOMPLETE` | Missing prompt, model, provider, route, terms version, grant or required grant fields |
| `OUTPUT_GRANT_NOT_PERMITTED` | Commercial use is false, or the grant permits neither relicensing nor a permitted licence |
| `OUTPUT_GRANT_LICENSE_MISMATCH` | Declared licence is not a conjunct of a grant that disallows relabelling, or a CC-BY grant claims MIT |
| `OUTPUT_GRANT_ATTRIBUTION_REQUIRED` | A CC-BY-4.0 grant has no required credit line |

`assetDeployRefusals` is the deploy gate. It returns `REVIEW_NOT_APPROVED` unless the review is approved,
`REVIEWER_NOT_HUMAN` for a `[bot]` reviewer, and `LICENSE_NOT_PERMITTED` unless the license is `MIT`,
`CC0-1.0` or `CC-BY-4.0` (issue 813 decision: the repository license for original work, and the two
redistributable Creative Commons licenses). The committed negative fixtures
`packages/contracts/test/fixtures/asset-manifest/unreviewed.json` and `unlicensed.json` each fail it.

`PackPresentation` (`presentationVersion: 1`) is a world pack's presentation metadata, stored as
`worlds/<dir>/reference/presentation.json` beside, not inside, the pack source. It declares
`assetManifestVersion: 2` and names the pack's id and
version. Its `bindings` have the wire `ScenePresentationBinding` shape and bind each stable object ID
at most once. Its `effects` bind the scene roles `path`, `rain`, `puddle`, `lantern`, `window` and
`selection` to manifests, optionally at an object. Pack conformance validates it
([presentation-bindings](../../packages/simulator/docs/conformance.md#checks)), and the asset pipeline
([pipeline](../../packages/assets/docs/pipeline.md)) builds, renders and uploads through it.

### World asset style profile

`AssetStyleProfile` is standalone presentation data, decoded by `decodeAssetStyleProfile`.
A world stores `reference/asset-style.json` beside `reference/presentation.json`; it is
not a simulation-pack resource and does not participate in the pack content hash.
`styleProfileVersion` is `1`. Unknown fields, missing fields, unsupported versions and
invalid values are refused with `ContractDecodeError` carrying the exact field path.

| Field | Values |
| --- | --- |
| `alpha` | `{ "mode": "binary" }` or `{ "mode": "soft", "boundsThreshold": 16 }`; soft threshold is an integer from 1 through 255 |
| `colour` | `{ "mode": "unrestricted" }` or `{ "mode": "palette", "colours": ["#202020", "#808080"], "strictness": "exact" }` |
| `edge` | `unrestricted`, `transparent-pixel` or `transparent-border` |
| `sizes` | All four keys `actor`, `object`, `terrain`, `effect`, each with integer `maxWidth` and `maxHeight` |

Binary alpha means 0 or 255 and uses 255 for bounds. Soft alpha allows every byte value;
bounds include pixels whose alpha is at least `boundsThreshold`. Palette colours are
non-empty, sorted, unique lowercase `#rrggbb` values. Strictness applies to the whole world,
not to each asset: `subset` allows the world's assets to use any subset of the declared colours;
`exact` also requires every declared colour to appear in at least one of the world's assets.
Each asset may use any subset of the palette under either strictness. Colour membership
concerns every pixel with nonzero alpha, including antialiased pixels below the bounds threshold.
`transparent-pixel` requires at least one fully transparent pixel in each non-terrain strip,
preserving the existing pixel-art rule; `transparent-border` requires all border pixels of
each frame to be fully transparent, including terrain. `unrestricted` adds no edge constraint.

Role limits apply to frame dimensions. `object` covers props and `terrain` covers environment
art. Widths are in 1..1024 (the existing issue-813 atlas shelf budget); heights are in
1..2048 (WebGL's guaranteed minimum texture size). These are the platform envelope, not a
world's mandatory values. These are per-frame limits; a horizontal strip's width is
`frames.width * frames.count` and must separately fit the 2048 px atlas-page envelope.
The packer uses a 1024 px baseline shelf width, widening a logical group for larger strips and
splitting it into pages no taller than 2048 px; see the
[packing contract](../../packages/assets/docs/pipeline.md#packing). The fixture profile declares
256 by 256 for every role (the issue 813 pixel-art decision), binary
alpha, transparent-pixel edges and its existing exact two-colour palette. All 36 fixture
manifests currently declare that same palette.

The asset source validator and fixture CLI enforce this profile. Palette profiles retain
manifest palette inventory checks; unrestricted colour profiles do not require a full-colour
inventory in the manifest. Missing world profiles are refused with `STYLE_PROFILE_REQUIRED`,
malformed ones with `STYLE_PROFILE_INVALID`; rule failures use `STYLE_ALPHA`, `STYLE_PALETTE`,
`STYLE_EDGE` and `STYLE_SIZE`. Manifest version 2 admits frames up to the 2048 px platform
envelope; the fixture's pixel-art profile supplies its 256 px limits. Bounded multi-atlas packing
is implemented. Worlds outside this repository run the same checks through the
[external-world commands](../../packages/assets/docs/pipeline.md#external-world-commands).
