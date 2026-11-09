# Realtime scene projection

`@clockgrove/contracts` owns a closed successor scene vocabulary. This schema freeze defines
messages and strict codecs. The native transport below implements authorized admission and bounded projection delivery;
the pure browser convergence reducer is available independently of transport integration, asset delivery and product navigation. PostgreSQL and typed simulation/application
paths retain canonical physical authority. A decoder validates structure and compatibility, never
permission.

## Lanes and identity

`SceneEnvelope<T>` carries protocol version, message identity, lane, message type, world/timeline/space
identity, optional projection revision, send timestamp, optional traceparent and typed payload.
`SceneLane` is exactly `projection`, `transient` or `operator`. `sentAt`, like a cue's `expiresAt`
and the `sentAt` of public speech and private Caretaker talk, is an RFC 3339 UTC timestamp: a real
calendar date and time with the `Z` suffix and an optional fraction of up to nine digits. A
`traceparent` is a W3C trace-context `traceparent` (lowercase hex, version other than `ff`,
non-zero trace and parent IDs).

Projection messages represent monotonic, durable-derived, gap-detectable state. Transient cues
may be dropped and never repair canonical state. Operator messages require `runtime:world-inspect`
and are unavailable through public observer streams. This read-only operator grant does not imply
the independent `runtime:world-observe` grant. Private conversations do not enter any of these three lanes.
An observer decoder rejects operator messages and private Caretaker talk.

The operator lane has one message type, `connections`, the authorized diagnostic of plan §6.1
that the runtime inspector shows. Its payload is exactly `connections`, a list of
`SceneConnectionMetadata`: the opaque `principalId`, `acknowledgedRevision` (null or a lossless
decimal revision) and `connectionVersion` of each connection, and nothing else: no audience,
credential, provider identity or event data. These are the hibernation attachment's fields without
its audience. `decodeOperatorSceneMessage` decodes it with the shared envelope rules and refuses
every other lane and type; `decodeObserverSceneMessage` refuses it. Decoding grants no inspection
authority. After each fanout turn SpaceDO encodes one `connections` message for the resident
sockets and sends it only to sockets whose last decided audience includes the operator interest
(see [Server-decided audiences](#server-decided-audiences)).

## Snapshots and ordered patches

`SceneProjection` carries scope and revision, simulation clock and weather, visible spatial
hierarchy, renderer-neutral 2D/3D spatial frames and poses, entities, presentation bindings,
interaction summaries, material-feed cursor, audience hash and projection, asset-manifest and
client compatibility versions. Frame identities, units, axes, origins, gravity and parent transforms
retain the `LivingSpatialFrame` semantics; a renderer does not become spatial authority.
A snapshot is internally consistent: frames and entities are distinct, each presentation binding
and interaction summary names a distinct projected entity, so none is labelled for a hidden one, and
the visible hierarchy holds distinct spaces, including the projected space, whose parents are all
in the hierarchy and lead to a root without a cycle.

The runtime fills `presentationBindings` from the installed pack's `presentation.json`
([pack presentation](shared-contracts.md#asset-manifests-and-pack-presentation)). It matches the
pack by the id that the world's hydrate read already joins, not by version: a world installed at
an earlier version of a shipped pack draws that pack's shipped file, and a binding for an object the
world does not project is dropped. It holds the committed files of the shipped packs (`apps/runtime/src/scene-presentation.ts`). Each binding decodes through
the `clockgrove.presentation` component ([component catalog](../../packages/domain/docs/component-catalog.md)).
Only projected entities get a binding. Presentation is not world truth, so a pack without the file
projects none and state hashes never depend on it. A bound actor whose binding family is an actor
family (`idle`, `walk`, `sniff`, `eat`, `shelter`) carries the family of its committed activity:
- an `active` movement is `walk`;
- a `seek-shelter` routine is `shelter`;
- a `seek-food` or `seek-water` routine is `eat` once the actor stands on its target's pose (where
  the seek's movement ends), and `sniff` before then or when a `seek-food` has no target;
- otherwise the binding's own family applies.
A family is chosen only when the reviewed atlas (`assets/reviewed`) holds that strip for the asset;
if it does not, the binding's family is kept. No Wave 4 routine maps to `play`. Patches upsert a
binding whose family changed, as they do any presentation.

The runtime also places the pack's `puddle`, `lantern` and `window` presentation effects as the
optional `SceneProjection.effects`, each a `role`, `assetId`, `animationFamily` and `pose`. They
follow the issue 813 golden scene's rules (`packages/assets/src/scene.ts`):
- one puddle sits at the integer midpoint of each anchor-graph edge in a projected frame;
- a lantern or window sits at the pose of its effect's `objectId`, and only when that object is
  projected, so no effect names a hidden one.

Effects are where an effect may show, not whether it shows: the client shows puddles while the
projected weather rains and lights at the projected clock's night (see the
[isometric scene](../../apps/web/docs/scene.md#isometric-rules-92)). The field is absent when the
pack places none. The patch operation `set_effects` replaces the whole list, and every successor
patch carries it.

`effects` and `set_effects` are projection version 2. Strict version-1 decoders refuse both as
unknown, so the runtime now declares projection version 2. Decoders accept the current version 2
and the one prior version 1. A version-1 snapshot must not carry `effects`, and a patch declaring
version 1 through `set_compatibility` must not carry `set_effects`. Any other projection version is
refused with `unsupported_projection_version`. A version-1 client therefore refuses a version-2
snapshot or patch with that stable code and its recovery surface, instead of a generic field error.

A successor patch carries `fromRevision`, `toRevision`, ordered closed operations, authorized
source event IDs and audience hash. Revisions must advance. Operations name the public snapshot
fields they change; arbitrary JSON extensions and whole-entity-list replacements are excluded.
The convergence reducer applies only a patch whose starting revision matches the current
projection, ignores duplicate/stale state, and recovers from a gap through bounded backfill
followed by snapshot fallback. Each contiguous patch is applied to a candidate and decoded as a
complete `SceneProjection` before publication; a partial operation sequence is never committed.

Revision and simulation-time values travel as decimal strings so JSON cannot round them.
Envelope timestamps retain their supplied UTC representation. Serialization preserves identity,
operation order and lossless values.

## Pure projection convergence

`apps/web/src/convergence.ts` exports `initialConvergence(scope)` and
`reduceProjection(state, action)`. The reducer has no React, Phaser, socket, clock or network
dependency. It consumes the real observer contracts through `decodeObserverSceneMessage` and
reuses `applyScenePatch`, which `projection.ts` reexports for the existing consumer. Transport
execution remains separate: returning a recovery request neither reconnects nor sends a control.
These functions confer no canonical mutation or authorization power.

The actions are `{ type: "message", message, intent, elapsedMs, budget }`,
`{ type: "reconnect", scope, audienceHash, elapsedMs, budget }` and
`{ type: "elapsed", intent, elapsedMs, budget }`. Reconnect, scope mismatch and audience
replacement increment the state's `intent`;
message and elapsed actions carry the intent captured by their caller. Obsolete intents return
unchanged state and no requests, fencing late input from a retired connection. `message` enters as unknown input and must pass the
observer decoder. `ContractDecodeError` identifies malformed schema input;
`SceneCompatibilityError` identifies unsupported contract versions. Unexpected implementation
errors propagate instead of being relabelled as malformed input.

Each action supplies its budget explicitly: `maxBufferedPatches` limits the number of pending
patch messages, `maxRevisionGap` is the bigint revision-distance ceiling for repair, and
`gapTimeoutMs` is the elapsed duration an unresolved gap may wait before requesting backfill.
`elapsedMs` supplies elapsed duration, not wall-clock time. There are no ambient defaults or
random choices. Accumulated gap time saturates at the supplied timeout.
Callers choose these engineering budgets for available memory, repair cost and
latency; the reducer does not invent a product retry threshold.

State carries the viewed scope, nullable committed projection, nullable audience hash, bounded
pending patches, accumulated gap elapsed time, one outstanding recovery request and one nullable
discarded-revision obligation (audience hash and greatest observed `toRevision`). The result
is `{ state, requests }`; `requests` contains only newly requested recovery. A snapshot request
is `{ type: "snapshot", scope, audienceHash }`. A backfill request also carries `fromRevision`
and `toRevision`, identifying the missing revision interval. Requests preserve the supplied
scope and audience identities; an audience hash itself grants no viewing permission.

Buffered patches are ordered by numeric `fromRevision`, numeric `toRevision`, then lexical
`messageId`. When the count exceeds `maxBufferedPatches`, retain the earliest messages in that
order and request a snapshot. This eviction depends on buffered inputs and the supplied budget,
not arrival order. Compatible contiguous buffered patches drain in that order. Duplicate or
stale patches and snapshots do not lower or change committed acknowledged state.

An unresolved gap means a buffered patch has missing predecessors; it requests backfill when its
accumulated elapsed duration reaches `gapTimeoutMs`. With no buffered gap, a quiet committed
prefix needs no recovery: the protocol supplies no heartbeat or head-revision signal to reveal a
dropped trailing patch. A later patch can expose that gap; reconnect resumes from the committed
revision. Patches received before initialization request a snapshot and retain their greatest
revision in the constant-size obligation. Eviction and same-audience reconnect also preserve
discarded revisions there. An older snapshot may initialize state, but cannot retire snapshot
recovery until a covering snapshot or contiguous patches commit through that obligation.
Property histories account for every delivered patch and assert the independently specified committed-prefix
hash and exact outstanding recovery without unsolicited replay, including all dropped subsets
and snapshot-late histories. The recovery journey answers the requested repair separately.
A gap beyond `maxRevisionGap`, buffer overflow or audience replacement requests
a snapshot. Snapshot recovery supersedes outstanding backfill. Repeating the same outstanding
request emits nothing; a successful repair retires it so a later independent gap can request
recovery again. Snapshots retain buffered successors; covered patches drain or become stale.
A changed timeline or space clears the preceding projection and pending patches
before loading the replacement. Audience replacement also clears both; reconnect always clears
pending patches, retaining a committed projection only for the same scope and audience. Thus
neither retired entities nor buffered operations can cross an audience boundary. Scope and
audience retirement also clear the discarded-revision obligation.

The convergence golden compares complete semantic projection content and its hash. Normalization
sorts hierarchy by `spaceId`, frames by `frameId`, entities and presentation bindings by
`objectId`, and interactions by `entityId`; it recursively sorts object keys and represents
bigints as decimal strings. Other arrays retain their semantic order, including coordinates,
axes and interaction actions. Envelope delivery metadata is outside projection content. Golden
mismatches report the actual normalized content and hash so generated values remain reviewable.

## Transient cues

Cue families are footsteps, splashes, particles, short sound references, emotes, hover hints and
animation transitions. Every cue has expiration and deduplication identity, and it expires after
its envelope's `sentAt`. Cues describe temporary
presentation only; losing every cue leaves the meaning of the durable projection unchanged.
Neither a cue nor public speech can carry an arbitrary canonical repair payload.

## Arrival and recovery

`WorldBootState` represents the ordered milestones `route_resolving`, `identity_resolved`,
`membership_authorized`, `joining_space`, `snapshot_ready`, `critical_assets_ready` and
`scene_ready`, with resumable progress. `text_ready` is a terminal success state: semantic
projection is usable when visual assets or the scene renderer are unavailable. Progress is the one
each state implies: `total` is 6, the milestones after `route_resolving`, and `completed` is the
state's position, from 0 for `route_resolving` to 6; both terminal states are complete.

Snapshots declare projection, asset-manifest and client compatibility versions. Strict decoding
refuses incompatible values with stable distinguishable error codes suitable for a visible recovery
surface. The envelope, snapshot compatibility record and asset manifest decoders check a present
version before strict shape, so a newer peer that also adds or drops fields still receives its
stable code rather than a generic field error; an absent version field remains a generic
missing-field error. A patch declares its compatibility with a `set_compatibility` operation. The
operation changes no projected state: it asserts that the patch was built for the declared versions,
so a patch from a newer projection version is refused with its stable code instead of being applied
as if compatible. A connection control's resume declares no projection version, so this assertion
is how a patch-only stream reaches an older client. The patch decoder checks every
`set_compatibility` version before the patch's or any operation's shape, so a newer patch
that also adds operations or fields still receives its stable code. A consumer can show refresh/deploy mismatch, bounded snapshot retry, text
fallback or an unsupported-version surface; it must not display a successfully decoded semantically
mismatched scene as live. This vocabulary does not prescribe a new retry count or timeout.

## Navigation and interaction boundaries

`ChangeViewedSpace` requests server authorization for another space projection. Viewing is distinct
from embodiment and object transfer. Following a selected actor resolves to exactly `followed`,
`stayed_within_space`, `permission_denied`, `target_hidden` or `unavailable`. Selection survives only
for an authorized projectable target. A refusal carries no scope, so it cannot expose a hidden
destination, and it preserves no unauthorized target. These meanings support future room/space navigation while keeping camera
movement, user presence, actor movement and inventory portability separate.

### Viewed spaces and follow decisions

A snapshot's `hierarchy` lists the projected authority space and every declared region whose
frame descends from a root frame of the space, as nested visible spaces; membership follows
declared frame ancestry, not where entities currently stand: each region's parent is its declared `parent`, and a root region's
parent is the authority space. Labels are identifiers. A viewed space is either the authority space
or one of these nested regions; the reference fixture stays one authority space whose regions
(`living-hall`, `snack-house`, …) are its viewed regions.

`POST /v1/runtime/viewed-space` decides one `ChangeViewedSpace`. The disposition's `scope` is the
scene connection's scope: the current scope for a nested region, the target space's scope for
another authority space. The server decides, in order:

1. without `runtime:world-observe` and `public_scene` on the connection scope, `permission_denied`;
2. a target that is not a nested region is another authority space, and needs the same grant on
   its own scope: no grant there, including for a space id the principal has no membership in or
   that does not exist, `permission_denied`; granted but not a ready routed space, `unavailable`;
3. without a selected entity, an authorized plain view change answers `204` with no body;
4. a selected entity the decided audience does not project there, `target_hidden` (a hidden and a
   nonexistent entity are one answer);
5. an entity standing within the target (the target is the authority space, or the entity's place,
   the innermost declared region containing its pose, is the target or a descendant), `followed`;
6. otherwise `stayed_within_space`, with the request's scope: the view does not move.

Refusals answer `200` with the disposition so the client can show it, and are logged as refused
(`permission_denied` also as `denied`); authentication failure
answers `401` and a malformed request `400 invalid_inspection_request`. The decision reads
canonical state only: it commits no command, moves no actor, changes no inventory and opens or
retires no scene connection. The web client acts on the answer with its one scene connection: a
nested region keeps the socket, another authority space replaces it through the retire-then-open
route handoff, and a refusal clears the selection with its Query data. A transport or server failure is not a
disposition: the client keeps the selection and says the request failed. Before Wave 11 no actor
crosses authority spaces, so `followed` is reached across nested regions.

Feed summaries and interaction summaries expose declared public meaning rather than raw event
payloads. Public spatial speech and private attributed Caretaker talk are distinct contracts.
Interaction modes disclose inspection from evidence, deterministic/reactive operation, an actor's
subjective perspective, or interpreted modeled state without implying that an object is sentient.

### Interaction cards

Every projected entity has one `InteractionSummary`: its `mode` and its effective `actions`, which
the server's policy evaluation computes on each scene read from canonical components and the reader's
current grants and ceiling. The card renders `INTERACTION_DISCLOSURES[mode]`: `inspectable`
"Inspection from world evidence", `reactive` "Deterministic/reactive object", `cognitive` "Actor's
subjective perspective", `interpreted` "Interpretation; object is not sentient". An action is
`{ kind, availability: "enabled" }` or `{ kind, availability: "disabled", reason }`. A kind is one of
`talk`, `observe`, `inspect`, `remember`, `history`, `influence` and `why`, and each is listed at most once. A
capability the entity lacks is absent, never disabled. `reason` is `command_grant_required` or
`conversation_not_permitted`, with the readable text in `INTERACTION_DENIAL_REASONS`. Nothing is inferred
from ownership, proximity or selection.

Wave 4 has no cognition: actors decide by deterministic utility, so actors, plants and resources
are `reactive`, and other entities are `inspectable`. Every entity has `inspect` and `history`
(issue 800's entity read, whose history reads the journal until Wave 6). Actors have `why`, issue 800's
recorded Why of their newest `routine.selected` command, and `talk`, which needs the `conversation`
category. Resource holders have `influence`, which needs `runtime:world-command`. The reader's
card authority enters the decided audience descriptor as `actions: { talk, influence }`, present
only when one of them is enabled, so plain observers keep their audience hash. Readers whose
authority differs never share a frame, and gaining or losing either grant is an audience change
that forces a snapshot. A Why that finds no `routine.selected` on the loaded history page pages back
through the entity read until it finds one or the history ends.

`POST /v1/runtime/influence` accepts `InfluenceRequest`: version 1, the four scope IDs, `intentId`,
`objectId`, `resourceKind` and `expectedRevision`, the projection revision the caller saw. The server
builds the typed `resource.offer` world command for one unit, with command ID
`influence:<principal>:<intentId>`. It chooses `issuedAt`, the epochs and the attribution. The
effective actor is the principal; the principal, membership and persona are sealed from the trusted
context. The command runs on the world-command path under `runtime:world-command`. The answer is an
`InfluenceReceipt` with the server-resolved `attribution`. A `committed` receipt carries the
revision and its consequence events, and answers `200`. A `rejected` receipt carries the denial
reason or the kernel's `code at path` refusal, for example a stale `expectedRevision` or an occupied
perishable holder, and answers `403` or `409`. A denial is a recorded rejected receipt. An
intent ID names one proposal. A retry of the same intent reuses the first attempt's
server-chosen `issuedAt`, request IDs and epochs, read back from its receipt's accepted bytes, so it
replays the stored receipt; a different proposal under the same intent ID answers
`409 command_id_reused`. Membership, the prior receipt or the epochs, and readiness are read in one
connection. Influence is a suggestion the world decides, never direct control.

Talk and Say are distinct commands with distinct receipts (Wave 5 RW-0501, issue 14).
`POST /v1/runtime/talk` appends private Caretaker Talk to a durable conversation session and never
reaches the scene; `POST /v1/runtime/say` is the explicit public-speech action. In its
`PublicSpeech` the addressed actor speaks a fixed scripted line, never the caller's words, with the
`attribution` (trusted principal and persona) of the caller whose explicit action made it speak.
Nothing is delivered to another observer: the caller-only `PublicSpeech` receipt remains the
public-speech path (owner decision on issue 811, 2026-11-05). See
[private conversations](conversations.md). The card's conversation region lists the actor's
sessions, and only explicit public speech enters the spatial speech region.

## Audience, assets and privacy

Audience and compatibility records have strict decoders. Asset manifests identify source,
creator/tool, license, generated prompt/reference provenance, review status, semantic entity or
archetype binding, animation family, anchor, footprint, bounds, palette, content hash, atlas location
and accessibility label. Review/provenance metadata describes an asset; it confers no viewing or
simulation authority.

Public projection excludes private cognition, raw event payloads, hidden entities, secrets,
capability grants irrelevant to the caller and provider identifiers. Public encoding reconstructs
the declared vocabulary, and strict observer decoding rejects additional fields rather than
reinterpreting privileged payloads as projection data. Audience hashes identify the projection's
visibility context; they are not authorization grants.

`SceneProjection.privateCognition` is the only privacy-differing field. It is present only
when the decided audience allows `private_cognition` (relationship-private access). It lists the
projected actors' canonical scripted beliefs and memories, ordered by `ref`, each with exactly `ref`,
`kind` (`belief` or `memory`), `actorId` (a projected entity), `targetObjectId` and the integer
`value`. The patch operation `set_private_cognition` replaces the whole list. An audience without
that allowance never receives the key, so neither its memory nor its DOM can hold it.

## Compatibility with existing surfaces

Diagnostic v1 retains `DiagnosticSceneProjection`, `ProjectionMessage` and its original decoder
behavior. `LivingScene` remains the separately versioned HTTP observation contract described in
[living-yard observation](living-yard-observation.md). The independent successor convergence
reducer does not change either existing consumer's transport behavior.

`pnpm check` pins the vocabulary. `tools/web-boundaries.mjs` compares one digest of every
`scene-*.ts` contract file, over each top-level statement except imports and with function
declaration bodies left out, with its committed value, so a new field, type, alias, export or scene
file fails until the change is reviewed and the digest updated. It refuses module augmentation and
namespaces in every contract file, and module augmentation anywhere in the web app. The scene
decoders share helpers from `validation.ts`; of those, the package exports only
`ContractDecodeError`, `exactKeys`, `nonNegativeInteger` and `record`.


## Executable wire examples

These snapshot and successor-patch examples are decoded through the public
`decodeObserverSceneMessage` API by `packages/contracts/test/scene-wire.test.ts`. Their matching
committed goldens verify exact `encodeObserverSceneMessage` bytes, including identities, ordered
operations and values beyond JSON's safe-integer range. The patch starts at the snapshot revision.

```json
{"tenantId":"tenant-scene","worldId":"world-hall","timelineId":"timeline-main","spaceId":"hall","protocolVersion":1,"messageId":"message-snapshot","sentAt":"2026-10-30T22:00:00Z","traceparent":"00-00000000000000000000000000000001-0000000000000001-01","projectionRevision":"9007199254740993","lane":"projection","type":"snapshot","payload":{"tenantId":"tenant-scene","worldId":"world-hall","timelineId":"timeline-main","spaceId":"hall","privacyClass":"public_scene","compatibility":{"projectionVersion":2,"assetManifestVersion":1,"clientVersion":1},"revision":"9007199254740993","simulationTime":"9007199254740995","weather":{"rainIntensity":6000},"hierarchy":[{"spaceId":"hall","label":"Hall"},{"spaceId":"den","label":"Den","parentSpaceId":"hall"}],"frames":[{"frameId":"hall-frame","version":1,"dimensions":2,"unit":{"name":"millimetre","fractionalDigits":0},"axes":{"axes":[{"name":"x","positiveDirection":"east"},{"name":"y","positiveDirection":"north"}]},"origin":["0","0"],"gravity":{"kind":"constant-vector","vector":["0","-9800"]}}],"entities":[{"objectId":"keeper","archetypeId":"resident","pose":{"frameId":"hall-frame","frameVersion":1,"coordinates":["-9007199254740993","2"]},"presentation":{"kind":"placeholder","label":"Keeper"}}],"presentationBindings":[{"objectId":"keeper","assetId":"keeper-reviewed","animationFamily":"idle","accessibilityLabel":"Keeper resting"}],"interactions":[{"entityId":"keeper","mode":"cognitive","actions":[{"kind":"inspect","availability":"enabled"},{"kind":"history","availability":"enabled"},{"kind":"why","availability":"enabled"},{"kind":"talk","availability":"enabled"}]}],"feedCursor":"feed-7","audienceHash":"audience-hall-observer","effects":[{"role":"puddle","assetId":"puddle","animationFamily":"loop","pose":{"frameId":"hall-frame","frameVersion":1,"coordinates":["4","5"]}}]}}
```

```json
{"tenantId":"tenant-scene","worldId":"world-hall","timelineId":"timeline-main","spaceId":"hall","protocolVersion":1,"messageId":"message-patch","sentAt":"2026-10-30T22:00:00Z","traceparent":"00-00000000000000000000000000000001-0000000000000001-01","projectionRevision":"9007199254740994","lane":"projection","type":"patch","payload":{"fromRevision":"9007199254740993","toRevision":"9007199254740994","operations":[{"op":"upsert_entity","entity":{"objectId":"keeper","archetypeId":"resident","pose":{"frameId":"hall-frame","frameVersion":1,"coordinates":["-9007199254740993","2"]},"presentation":{"kind":"placeholder","label":"Keeper"}}},{"op":"remove_entity","objectId":"leaf"},{"op":"upsert_frame","frame":{"frameId":"hall-frame","version":1,"dimensions":2,"unit":{"name":"millimetre","fractionalDigits":0},"axes":{"axes":[{"name":"x","positiveDirection":"east"},{"name":"y","positiveDirection":"north"}]},"origin":["0","0"],"gravity":{"kind":"constant-vector","vector":["0","-9800"]}}},{"op":"remove_frame","frameId":"old-frame"},{"op":"set_clock","simulationTime":"9007199254740997"},{"op":"set_weather","weather":{"rainIntensity":7000}},{"op":"upsert_space","space":{"spaceId":"porch","label":"Porch","parentSpaceId":"hall"}},{"op":"remove_space","spaceId":"shed"},{"op":"upsert_presentation","binding":{"objectId":"keeper","assetId":"keeper-reviewed","animationFamily":"idle","accessibilityLabel":"Keeper resting"}},{"op":"remove_presentation","objectId":"leaf"},{"op":"upsert_interaction","interaction":{"entityId":"keeper","mode":"cognitive","actions":[{"kind":"inspect","availability":"enabled"},{"kind":"history","availability":"enabled"},{"kind":"why","availability":"enabled"},{"kind":"talk","availability":"enabled"}]}},{"op":"remove_interaction","objectId":"leaf"},{"op":"set_effects","effects":[{"role":"puddle","assetId":"puddle","animationFamily":"loop","pose":{"frameId":"hall-frame","frameVersion":1,"coordinates":["4","5"]}}]},{"op":"set_feed_cursor","feedCursor":"feed-8"},{"op":"set_compatibility","compatibility":{"projectionVersion":2,"assetManifestVersion":1,"clientVersion":1}}],"sourceEventIds":["event-rain","event-rest"],"audienceHash":"audience-hall-observer"}}
```

## Authorized scene connection transport

`GET /v1/projection?tenantId=…&worldId=…&timelineId=…&spaceId=…` upgrades a scene
connection. Optional interest parameters `selection=<objectId>`, `conversation=true` and
`operator=true` request interest beyond the camera's space, which is always the scope's `spaceId`.
Any other parameter, value or repetition is 400 `invalid_scene_scope`. Requesting `operator`
without `runtime:world-inspect` is 403 `operator_interest_refused`. Requesting `conversation`
without a `conversation` ceiling allowance is 403 `conversation_interest_refused`. Changing
interest means joining again. Its `Sec-WebSocket-Protocol` request lists `clockgrove.scene.v1` and exactly
one `clockgrove.bearer.<session-credential>` carrier. The carrier suffix is the existing
bearer credential, supplied as a WebSocket subprotocol token. The response selects only
`clockgrove.scene.v1`. Credentials in query parameters, Authorization-only upgrades and
cookie-only sessions do not authenticate this route. Each upgrade verifies the configured
provider's current session, resolves the opaque internal principal, and requires the
`runtime:world-observe` grant in the exact requested world, timeline and space plus a
`public_scene` privacy allowance. Requested scope confers no authority.
An inspect-only principal receives 403 `authorization_refused`; operators need both grants to
observe and inspect. Neither grant authorizes mutation; operator actions require `runtime:world-operate`.

The Worker forwards a signed internal assertion binding that principal, public audience scope,
protocol and authority epoch. The existing runtime secret signs a domain-separated HMAC;
no additional managed secret is required. Assertion expiry is an explicit engineering decision:
30 seconds allows the single internal forwarding hop while bounding replay. The SpaceDO
validates expiry, signature, route, protocol and the current canonical authority epoch. The
authority epoch is the routing epoch, never the clock owner generation. Admission occupies
an entry in the existing `OwnerMailbox` and uses `SPACE_MAILBOX_BOUNDS`; a full mailbox
refuses the upgrade. `SCENE_SOCKET_BOUNDS` caps the resident sockets of one SpaceDO at 256 and
those of one principal at 4 (decisions recorded in `scene-delivery.ts`); an upgrade beyond either
receives 503 `scene_connections_full` with the mailbox's `retry-after` hint.

Accepted sockets use `acceptWebSocket`, the native hibernation API. Their recoverable attachment
has `principalId`, `audience`, `acknowledgedRevision` and `connectionVersion`, and, once a frame
whose decided audience the server knew is acknowledged, that frame's `acknowledgedAudienceHash`.
`audience` is the authorized scope with `privacyClass: "public_scene"` and the requested `interest`
(`selection`: an object id or null, `conversation` and `operator`: booleans). There are no bearer
credentials, provider identity, join assertions or execution contexts in the attachment.
Initially `acknowledgedRevision` is null, distinct from revision zero. Metadata belongs to live
connections and leaves with their close; it is not canonical world state.

## Connection controls

Readiness belongs to the current browser connection. `snapshot_required` during initial
establishment or reconnect with a retained committed cursor keeps the stream `connecting`
until compatible projection delivery commits. Once that connection reaches `ready`, the same
notice exposes `recovering` (living-yard `degraded`) until committed delivery completes recovery.
Pending gaps and outstanding recovery keep partial repair degraded, even as committed revisions
advance. Transport loss exposes degraded before reconnecting; retained revisions do not make a
replacement connection ready. Retired connection callbacks cannot change current readiness.
Ignored stale snapshots and stale or duplicate patches cannot complete establishment or recovery.
A compatible snapshot at the retained revision can complete delivery on the current connection.

The browser commits reducer output before notifying scene subscribers or publishing to Query.
The reducer strictly decodes each incoming snapshot or patch once; transport coordination reads
only validated envelope metadata afterward and refuses a changed scope before committing output.
`SCENE_RECOVERY` bounds pending patches to four (the runtime outstanding-frame bound), revision
distance to 64 (the runtime recovery history bound), and gap waiting to 1 s (decision: reuse the
first reconnect interval to allow reordering). Time enters the reducer as monotonic elapsed deltas;
only a detected pending gap schedules a timer. Backfill requests send `resume` from the committed
revision; snapshot requests send a null cursor hint. The runtime retains authority over whether
that hint produces bounded history or a snapshot, including its stored acknowledged cursor and
outstanding-frame debt. Each explicit replacement resume increments the client connection version;
acknowledgments require a committed compatible endpoint delivered in that version. Socket retirement
cancels gap/retry timers and detaches callbacks before close; a successor waits for close completion.

`scene-connection.ts` publishes a separate strict control vocabulary without changing
`SceneEnvelope`, `SceneProjection` or `ScenePatch`. Every control has `protocolVersion: 1`.
Client `resume` carries `lastAppliedRevision` (null or a lossless decimal revision) and
`assetManifestVersion: 1`. It is a recovery hint, not an acknowledgement. Client `ack` carries
`revision` and `connectionVersion` and means the client actually applied that revision on that
connection. Admission alone delivers no projection and therefore cannot establish such an ack.

Server `recovery` reasons are `snapshot_required`, `revision_unavailable`,
`asset_manifest_changed`, `backpressure` and `runtime_restarted`. Server `disconnect` reasons
are `malformed_control`, `unsupported_protocol`, `unauthorized`, `stale_authority_epoch` and
`internal_error`. Notices contain typed reasons, never exception details. Strict codecs reject
unknown fields, wrong directions, unsupported versions and malformed revisions. Revisions use
bigint internally and decimal strings on the wire. Parsing catches JSON syntax failures;
unexpected internal exceptions remain internal failures.

## Bounded native delivery and recovery

SpaceDO resolves the attachment's opaque principal against current world participation,
`runtime:world-observe` and `public_scene` before each projection serialization. The attachment
cannot preserve a revoked grant. The stream reuses the authorized HTTP living-scene field mapping;
raw owner documents and event payloads never enter the wire projection.

A fresh upgrade receives no projection until a compatible resume declares its cursor. A resume
uses the stored acknowledged revision when available, otherwise the client's applied
revision hint. The compatible asset-manifest version is validated by the control codec. A verified
contiguous PostgreSQL Journal range can produce one ordered patch spanning that range. Recovery
reads at most 64 event revisions (an engineering choice taken from the due-work input window of
issue 651, before issue 931 lowered `DUE_WORK_ADVANCE_BUDGET` to 16, as a conservative history count rather
than a measured network capacity).
The reader accounts for the difference between physical revision and Journal head. A missing range,
excessive lag, unknown/topology-changing event or unusable cursor falls back to an authorized snapshot
at the observed canonical revision. Only sequence gaps are recovery misses: corrupt hashes or other
Journal-integrity failures remain internal failures. Sending a snapshot or patch never acknowledges it.

Each connection retains at most one authorized projection baseline in memory. Live convergence
can diff that baseline against a current PostgreSQL projection even when history exceeds the recovery
budget; such a patch carries an empty source-event list rather than invented identities. Recovery
after losing the baseline still uses bounded PostgreSQL history or a snapshot.

Each connection's in-memory ledger accepts an ack only for an actually delivered endpoint revision
and its connection version; duplicate, stale, impossible and obsolete-version acks cannot advance the
stored cursor. Replacing a delivery intent fences its results, errors and cleanup. After memory loss,
SpaceDO reconstructs delivery from the native attachment and PostgreSQL, without a patch cache.
A restored socket with an acknowledged revision resumes from it on the next publication. One
without receives `recovery/runtime_restarted` instead, since what it was sent is unknown; sockets
this incarnation admitted that have not resumed still receive nothing. A late ack on the stored
connection version is accepted after memory loss when it advances the stored cursor and is not
beyond the revision PostgreSQL then observes; delivery continues from it. A socket this incarnation
closed or told to reconnect is never restored, so its in-flight acks cause no read. Only the first
late ack restores a ledger: with more than one frame outstanding across memory loss, the client may
receive `revision_unavailable` or a patch it cannot apply, and reconnects. The browser client answers
`revision_unavailable` and `runtime_restarted` with a fresh connection and a resume from its applied
revision, since only a fresh connection restarts at connection version 1. It reconnects the same
way after a close, `recovery/backpressure` or `disconnect/stale_authority_epoch`, with jittered
exponential backoff from 1 s over five attempts (`SCENE_RECONNECT` in `apps/web/src/projection.ts`).
A detected patch gap instead uses the pure reducer and the existing connection's resume protocol. An applied
projection resets the count, and a sixth loss in a row is unavailable.

Engineering budgets are four outstanding projection frames per socket,
and four lagging publication turns before closing. Four reuses the existing four-command
`OWNER_ACTIVATION_BUDGET` window, allowing one such activation before coalescing. Explicit resumes carry outstanding-frame debt
across connection versions, so repeated resumes cannot bypass that bound. Each recipient's delivery work is bounded; socket admission reuses the existing mailbox state
and depth bound, plus the resident socket caps above. Closed socket metadata is retired through the weak connection index. When the frame ledger fills, new replaceable projection
fields coalesce into one dirty flag; the next ack reads the latest authorized projection from
PostgreSQL. No intermediate frame queue is retained. Transient cues for objects outside the current authorized projection and expired cues are dropped and never
repair physical state. No Wave 4 runtime source emits a cue yet: these rules bind the first
producer, and only the native test worker exercises them. Recovery and disconnect notices bypass the replaceable projection lane.
A client that remains behind receives typed `recovery/backpressure` and closes with code 1013 and
reason `backpressure`. Only publication turns with a full frame ledger count as lag; a turn that
finds the connection's own read still pending only marks it dirty. A delivery read the owner mailbox
refuses (`owner_mailbox_full`, `_expired` or `_timeout`, all retryable) also ends with
`recovery/backpressure` and 1013, never `internal_error`; a refused cue read drops only that cue.
Each read compares the canonical authority (routing) epoch with the one the socket was admitted
under, or after memory loss the first one it read; a changed epoch sends
`disconnect/stale_authority_epoch` and closes with 1008, and the client rejoins. Other disconnect
notices retain the control vocabulary above.

One coalescing fanout task per owner processes native sockets. Within one fanout turn each principal
and requested audience gets one authority lookup of its own; authorization is never shared across
principals. Sockets whose authority decides the same audience share one PostgreSQL read per cursor,
whoever their principals are. Equal frames (same audience hash, revision, base revision and source
events) are encoded once and sent as the same bytes, `messageId` included. The browser is never sent
a superset to filter. Fanout failure cannot roll back a
canonical command; subsequent resume reads PostgreSQL even when notification failed. Delivery
ledgers, connection indexes, interest maps, hydrated projections, recent patches, mailbox execution
and command contexts are memory-only. Native attachments retain only the four metadata fields and
the acknowledged audience hash. No local canonical physical projection, conversation/memory tables, independent schedules,
unjournaled committed events or managed secrets are introduced.

### Server-decided audiences

Each read decides the audience before the projection is built, from the principal's current
membership. The attachment holds only what was requested; a lost grant or category takes effect on
the next read. `decideSceneAudience` (`apps/runtime/src/scene-audience.ts`) calls the kernel
perception resolver ([audiences](../../packages/kernel/docs/perception.md)) once through its
`viewer` path. Each interest is a viewer, subscribed when requested: `viewer:space` (always),
`viewer:selection`, `viewer:conversation` and `viewer:operator`. Access is set from grants and
ceiling: `space` is `reduce` without `private_cognition`, `conversation` is `deny` without
`conversation`, and `operator` is `deny` without `runtime:world-inspect`.

The decision event is synthetic and never recorded. It is a `system`-modality `object.created`
observation, at the read revision, of the selection or else the space's first entity in id order.
A space with no entity observes the world's first entity instead, since a viewer's outcome depends
only on its subscription and access. A selection that is not an entity of the space is dropped. A
resolver refusal, or a world with no entity, fails closed to the public scene with no interest. The resolver's viewer reasons stay on
the read result as the audience decision record. Operator-lane `connections` reach a socket only
when its audience was decided with the operator interest in the same fanout turn; a socket whose
read the turn skipped (pending or full) gets none until its next decision.

The decided descriptor is `{ scope, privacyCategories, interest }`: `public_scene`, plus
`private_cognition` for a `full` space viewer and `conversation` for an included conversation
viewer, and the included interests. The audience hash is the SHA-256 of its canonical bytes; it
excludes the principal.

A changed hash between two frames of one connection (a grant, ceiling or interest change) always
sends `recovery/snapshot_required` and a snapshot, never a patch over the prior audience's state. A
resume after such a change also snapshots, instead of patching from the acknowledged revision of
the prior audience. After memory loss the attachment's `acknowledgedAudienceHash` stands in for the
lost ledger, so a hash that changed while the owner was evicted still forces the snapshot; a
restored attachment without one patches as before, and the browser's reset fences it. The browser reducer resets on a changed hash, so nothing of the prior audience
survives in its state or DOM.

The local replacement fixture restarts workerd and explicitly models platform attachment restoration
before resuming from PostgreSQL. Separate held-read checks replace delivery intent while an earlier
success or error is pending. These checks do not exercise Cloudflare's hosted eviction mechanism;
real hibernation, restart and redeploy qualification remains pending on issue 881.
