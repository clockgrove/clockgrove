# Living-yard observation

The living-yard observation vocabulary is version 1, independently versioned from the legacy
`ProjectionMessage` diagnostic socket protocol. `ObservationRequest` contains exactly `version`
and `BrowserScope` (`tenantId`, `worldId`, `timelineId`, `spaceId`). Authentication and scoped
`runtime:world-observe` authorization are resolved by the runtime. A read grants no command authority.
The no-op diagnostic remains a separate operation with its existing request and response vocabulary.

The grants are independent. `runtime:world-inspect` authorizes read-only operator inspection,
including the causal-chain view and runtime-state inspector; it does not imply observation.
Operators need both grants to observe and inspect. `runtime:world-operate` authorizes operator
mutations, including publication repair and message replay. Neither observation nor inspection
authorizes those actions, commands, clock changes or diagnostic no-ops.

`LivingScene` contains exactly version, scope, `privacyClass: "public_scene"`, canonical `revision`,
canonical `simulationTime`, weather, frames and entities. Revision and simulation time are canonical
non-negative decimal strings, including values beyond JSON's exact integer range. Weather exposes
only `rainIntensity` in the canonical basis-point encoding. No trusted context, grants, actor-private
state or arbitrary component payload is part of this vocabulary. A broader privacy ceiling does not
expand the scene vocabulary.

Each entity exposes its stable `objectId`, `archetypeId`, semantic pose and a placeholder presentation
binding (`kind: "placeholder"`, `label`). Pose identifies its spatial frame and version, with signed
canonical decimal coordinate strings. Frame data preserves canonical dimensions, unit name and
fractional digits, ordered named axes and positive directions, origin, constant-vector gravity and
optional paired parent identity and transform. Translation and basis coefficients use signed decimal
strings. Frame and pose versions are positive safe integers; coordinate counts match dimensions.
Renderer types, canvas node IDs and screen coordinates never substitute for semantic identity.

`decodeObservationRequest` and `decodeLivingScene` reject unknown fields at every object boundary,
unsupported versions, non-public privacy classes, ambiguous decimal encodings, duplicate object or
frame identities and poses that do not reference the supplied frame version and dimensionality.
The contracts package performs no authentication or physical mutation.

## Observer world directory

`POST /v1/runtime/world-directory` lists the world spaces the caller may observe, so a browser can offer
them instead of asking for raw scope IDs. The request carries the session credential in
`Authorization: Bearer` and a body of exactly `WorldDirectoryRequest`, `{"version":1}`; it names no
scope. The Worker authenticates through `TrustedRuntimeRequestAuthenticator.authenticatePrincipal`:
the bearer session is verified by the provider and mapped to its principal, with no request body
read and no world authority resolved. Only then is the body decoded.

The required grant is the existing `runtime:world-observe`, checked per membership; no new grant
exists. The world reader lists, through the migrator-owned `clockgrove.observable_world_scopes`
function (migration 0032), exactly the authenticated principal's memberships that are unrevoked,
committed (`committed_at` not after the read), hold `runtime:world-observe` and belong to a world
whose lifecycle status is `ready`. Another principal's memberships never appear. Only the world
reader may execute the function, and it returns scope columns only.

`WorldDirectory` contains exactly `version: 1` and `entries`. Each `WorldDirectoryEntry` has the
four scope IDs (`tenantId`, `worldId`, `timelineId`, `spaceId`), `worldLabel` and `spaceLabel`. No
canonical record names a world or a space yet, so each label is its identifier. Entries are in byte
order of tenant, world, timeline and space IDs. `decodeWorldDirectory` and
`decodeWorldDirectoryRequest` reject unknown and missing fields at every object boundary and
unsupported versions. An empty `entries` list means nothing is observable.

Refusals use the observation codes: 401 `authentication_refused` for a missing, malformed or
invalid credential or an unmapped identity, decided before the body is read; 400
`invalid_inspection_request` for any other body; 503 `inspector_unavailable` when the directory or its
database is unavailable; and 500 `inspection_failed` otherwise. A refusal carries only its code, never a scope
or label. Each response is logged once as `scene_observation_answered`.

## World readiness

`POST /v1/runtime/world-readiness` tells a browser whether a world it may observe is ready, still
provisioning, or failed provisioning, so arrival can say so instead of showing an empty yard. The
body is the version-1 `ObservationRequest`. The Worker authenticates first, as for the directory,
then decodes the body.

The required grant is `runtime:world-observe`. The world reader calls the migrator-owned
`clockgrove.observable_world_readiness` function (migration 0035), keyed only on the installed
`app.principal_id`. It answers nothing unless that principal holds an unrevoked, committed
membership for exactly the four scope IDs with the grant. Then `ready` when the world's lifecycle
status is `ready`; nothing when it is `archived`; `failed` when the world's latest
`clockgrove_birth.provisioning_cases` row (by `updated_at`, then `case_id`) is `failed`; otherwise
`provisioning`.

A ready world answers 200 `{"version":1,"readiness":"ready"}`. Otherwise the answer is 409
`{"error":"world_not_ready","readiness":"provisioning"|"failed"}`. `decodeWorldReadiness` rejects
unknown and missing fields. A missing or non-observable scope is 403 `authorization_refused`, with
no readiness disclosed. Other refusals are the observation codes: 401, 400, 503 and 500. The read
writes nothing and is logged once as `scene_observation_answered`.

Readiness is its own route by decision (2026-11-07): the directory stays a list of observable, ready
worlds, so adding unready worlds there would change its meaning for every caller and widen what a
member can enumerate. Retry re-reads readiness and never restarts provisioning, because observation
grants no mutation authority. The web client re-reads a provisioning world every 2,000 ms (decision:
about one provisioning step, and at most one indexed read per waiting viewer every two seconds); a
failed world waits for Retry.

## Observer clock and material feed

`POST /v1/runtime/world-status` answers the viewed space's canonical clock and its recent material
events. Its body is the same version-1 `ObservationRequest` that `/v1/runtime/scene` takes, and it has
the scene read's authority: the bearer session, `runtime:world-observe` for exactly the requested
scope, and a privacy ceiling that includes `public_scene`, which the read narrows to `public_scene`.
Refusals use the scene read's codes: 401 `authentication_refused`, 403 `authorization_refused`
(no observe grant, another scope, or no public scene), 400 `invalid_inspection_request`, 409
`world_not_ready`, 503 `inspector_unavailable` and 500 `inspection_failed`. The read mutates nothing and
grants no clock control. Each response is logged once as `scene_observation_answered`.

`WorldStatus` contains exactly version, scope, `privacyClass: "public_scene"`, canonical `revision`,
`clock` and `feed`, and decodes only through `decodeWorldStatus`, which rejects unknown and missing
fields at every level. `encodeWorldStatus` writes its JSON form. `WorldClock` is derived on the server
from PostgreSQL:

- `simulationTime`: the partition's canonical simulation time in ms, a decimal string;
- `runState`: `"running"` or `"paused"`, from the timeline clock policy;
- `speed`: simulation ms per wall ms, from the timeline clock policy;
- `dayLengthMs`: the installed pack's environment-policy `dayLengthMs`;
- `day`: the 1-based simulated day, floor(simulationTime / dayLengthMs) + 1, so Day 1 begins at 0;
- `timeOfDayMs`: simulationTime mod dayLengthMs.

When the installed pack declares no environment day length, the three day fields are null. The
decoder refuses a `day` or `timeOfDayMs` that does not follow from `simulationTime` and `dayLengthMs`,
so clients never compute a calendar themselves.

`feed` lists the space's material journal events, newest first. Each `WorldFeedItem` carries the
`FeedSummary` fields (`id` and the single `sourceEventIds` entry are the journal event ID, `simTimeMs`
its simulation time as a decimal string on the wire, `kind: "material"`, a plain sentence in
`text`), its `category`, and `objectId`: the event's object or actor, else its portal, and null
when no single entity applies (weather, phase changes and resource transfers). Items are derived on
read from the canonical journal's public semantic events, with no stored feed. They never carry an
event payload, attribution, principal or provider identity. The material event types and their
categories form a closed list:

- `weather`: `weather.changed`, `weather.transitioned`, `environment.phase-changed`;
- `routine`: `routine.selected`;
- `wellbeing`: `needs.threshold-crossed`, `exposure.threshold-crossed`, `health.threshold-crossed`;
- `growth`: `growth.stage-changed`;
- `movement`: `movement.portal-crossed`, `movement.completed`;
- `portal`: `portal.opened`, `portal.closed`;
- `resource`: `resource.offered`, `resource.consumed`, `resource.transferred`, `resource.spoiled`.

`text` is generated on read from the event's public payload, naming each entity by its `presentation.label`
in the space's living scene (an entity outside the scene by its object id); the payload itself is never exposed. When the payload lacks a field a sentence needs,
`text` falls back to fixed per-type wording. Sentences, with `A` the object and `K` the capitalised
resource kind: `weather.transitioned` "It started raining." / "The rain stopped." / "The rain changed."
/ "The weather turned."; `weather.changed` "It is raining." / "It is dry."; `environment.phase-changed`
"It is now {phase}."; `routine.selected` "A is staying put." / "A is looking for food|water|shelter[ at
{target}]."; `needs.threshold-crossed` "A is hungry|thirsty."; `exposure.threshold-crossed` "A got wet." /
"A dried off." / "A is uncomfortable in the weather." / "A is comfortable again.";
`health.threshold-crossed` "A's health is critical." / "A is recovering."; `growth.stage-changed` "A
reached its {stage} stage."; `movement.completed` "A arrived."; `movement.portal-crossed` "A went
through {portal}."; `portal.opened|closed` "{portal} opened|closed."; `resource.offered` "K was offered
at A."; `resource.consumed` "K at A was used."; `resource.transferred` "K moved from {from} to {to}.";
`resource.spoiled` "Food at A spoiled."

Every other type, including `time.advanced`, `needs.changed`, `comfort.changed`, `needs.relieved`,
`wellbeing.integrated`, `growth.integrated`, `location.changed`, `movement.started`,
`movement.region-*`, `movement.interrupted`, `movement.replanned` and clock and lifecycle records, is
never a feed item. The feed reads the space partition's 100 latest sequences up to the covered head,
the bounded public window of the existing object-history reader, so it holds at most 100 items. Events
outside the caller's privacy ceiling are absent from that window and never appear.

## Authorized scene stream

The default living-yard observer uses one WebSocket at `/v1/projection`, with exactly the four
scope IDs as URL query parameters. The credential is carried in the dedicated
`clockgrove.bearer.` WebSocket subprotocol alongside `clockgrove.scene.v1`; it is never a URL
parameter or cookie session. Every upgrade verifies the provider session and scoped
`runtime:world-observe` authorization and `public_scene` privacy allowance. The response selects
only `clockgrove.scene.v1`. The stream reauthorizes current scoped membership and this grant before
each projection serialization, including after connection replacement. Operator-lane messages are
unavailable on this public stream and rejected by `decodeObserverSceneMessage`.

The observer decodes the public successor `SceneProjection` and `ScenePatch` vocabulary through
the observer codecs. It preserves lossless revisions, scope, audience and compatibility. Applied
scene fields retain the renderer-neutral `LivingScene` meaning above for Phaser and semantic text.
Duplicate or stale state is ignored. A patch must start at the last applied revision; gaps request
recovery instead of changing the scene. Only compatible successfully applied revisions are
acknowledged, bound to the current connection version. Resume declares the last applied revision
and asset-manifest version. Recovery and disconnect controls use the typed runtime vocabulary.

Compatible gap recovery publishes **degraded** while preserving the last committed scene. A reducer
transition that discards the authorized projection also clears Query's scene and projection and
cancels/removes dependent entity and Why reads. This includes audience changes in either snapshots
or patches; messages from any other scope are refused and clear the live view. Late dependent read
results and errors cannot restore the discarded state. Bounded buffered
patches commit together when predecessors arrive. After the gap timer expires, backfill uses an
explicit resume on the same authenticated socket; reducer snapshot recovery supplies a null cursor
hint. The runtime's recovery bounds and acknowledged cursor remain authoritative. Replacement
resumes version their acknowledgments; buffered endpoints from an older version cannot be acknowledged
as newly delivered. Transport loss retains `SCENE_RECONNECT` jittered backoff and serialized retirement,
with degraded, connecting and ready statuses. Authorization refusal exposes unavailable with an
authorization explanation and clears authorized projection, entity and Why reads. Incompatibility
clears the projection and permits explicit retry through **Observe yard**.

`YardSession` coordinates observation across credential replacement, scope changes, sign-out, authorization
loss and reconnect. It retires the old socket before activating a successor, including handoff to
another authorized SpaceDO. Obsolete session and connection callbacks cannot install a scene,
clear newer selection or Why, reconnect, or close the current socket. A refusal, incompatibility
or unrecoverable lag removes the live scene; authorization loss clears dependent selection and Why.
Entity and Why reads remain separate HTTP operations. `/v1/runtime/scene` remains a supported HTTP
snapshot endpoint. The explicit diagnostic entrypoint retains its legacy wire codecs and no-op
operation and does not open a second scene connection beside living-yard observation.

## Browser ownership and retirement

TanStack Query owns the browser's replaceable server-state data and query status. The projection
reducer determines the committed authorized projection; its output is published to the
`living-yard` projection query and consumed from that cache by React. `YardSession` retains
transport handles, credentials and transient intent identities, with no independent projection,
entity, Why, loading or failure fields. Entity selection and recorded Why are queries, including
their pending, success and error states. Compatibility snapshot methods derive their values from
Query. Active observers retain the current queries; retry is disabled and garbage collection is
immediate after the last observer leaves, as before. No polling or additional canonical read is
introduced by cache publication.

Entity and Why query identities include the authorized observation lifetime, scope and intent;
entity identity includes the selected object and history cursor, and Why identity includes the
selected entity/history intent and command. Credentials never enter keys or diagnostics. Refresh
and history continuation replace the entity query. Closing Why, replacing its action or history,
and changing entity cancel and remove the previous Why query. Credential or scope replacement,
sign-out and current HTTP 401/403 or socket authorization refusal synchronously remove prior
authorized entity and Why queries and replace the projection with an empty authorized view.
Cancelled queries cannot publish late completions; lifetime and intent checks prevent old errors
or transport cleanup from retiring a successor. Recorded receipt evidence is not recomputed.

React + Vite owns routing, authentication, HUD, panels, chat placeholder, event feed, inspector,
accessibility, errors, and responsive layout. Phaser owns canvas rendering, camera, depth order,
picking, movement interpolation, animations, particles, weather, highlights, and local visual
effects. `WorldSceneAdapter` remains the only React/Phaser bridge and consumes renderer-neutral
semantic scene data. Zustand owns transient cross-panel selection and view state through
`useYardView` and `useWhyView`; neither store contains server responses, query status or credentials.

The renderer-neutral `scenePresentations` adapter resolves committed presentation bindings by
semantic object ID into placeholder and material resource, animation and accessibility-label choices.
The headless 3D fixture uses those choices to construct frame-local scene nodes; its journey asserts
nonempty binding-derived material output alongside exact object IDs, 3D frames, revisions and intents.

The local Chromium journey exercises native runtime/PostgreSQL committed delivery, Phaser and
semantic output, and interruption recovery. It does not establish hosted Cloudflare hibernation,
restart or deployment qualification. Full qualification remains pending under issue 853 and issue 693;
pilot evaluation remains deferred to issue 817. The predeclared pilot remains unevaluated and permits
no recording.

## Selected public entity

`POST /v1/runtime/entity` accepts `EntitySelectionRequest`: version 1, the four scope IDs,
`objectId`, and an optional `cursor` containing `observedRevision` and exclusive `beforeSequence`.
The same scoped `runtime:world-observe` grant authorizes this read without a mutation grant.
The runtime requires `public_scene` and current membership of the object in the requested scene.
Unknown objects and objects outside that scene expose neither physical state nor history.

`EntitySelection` identifies the object, scope, canonical `revision` and canonical `simulationTime`.
Its `entity` uses the scene's renderer-neutral identity, archetype, pose and presentation vocabulary.
`physical` exposes canonical needs, wellbeing and plant records, resource kind and quantity,
shelter protection, location, selected routine action and lifecycle status. Absent applicable
records are explicitly `null`. Component bags, private cognition and persona inventory do not
enter this closed vocabulary. Canonical needs and wellbeing retain integration timestamps and
remainders; canonical plant state retains stage, growth, wetness and integration metadata.

`derived` is explicitly `canonical: false`, with its own `simulationTime`. These values come from
`PostgreSqlCommandOwner.inspect` and its earned-time result, using the runtime's installed policy.
A paused clock earns no elapsed wall time; integration never runs before canonical simulation time.
Needs expose current hunger, wetness and their integration metadata; wellbeing exposes current
thirst and health with remainders; plants expose current growth and wetness with remainders.
The current-time calculation does not advance canonical plant stages or assert a newly recorded
comfort state. Unchanged values retain their canonical values. No browser physics are involved.
Reading or refreshing this view writes no canonical state, revision, receipt or schedule.

`history.observedRevision` identifies the canonical snapshot bounding the history read. Summaries
contain original `eventId`, `actionId` and `commandId`, public event `type`, canonical
`partitionSequence`, event `simulationTime` and its original `recordedAt` timestamp. Summaries
are newest first by partition sequence, never by wall time. They contain no raw journal payload.
Only authorized public actions concerning the selected object are returned; a broader privacy
ceiling cannot widen this vocabulary. No action beyond the snapshot's covered journal head is
included.

History work is bounded by a scan window of 100 partition sequence positions per request, an
implementation limit on read cost rather than a lifetime retention cutoff. A page can be empty
while still having an earlier window. `beforeSequence: null` means no earlier window remains;
otherwise request that exclusive boundary with the observed revision to continue toward older
actions. A canonical revision change invalidates the cursor and requires refreshing selection.
Each page replaces the prior page in the browser cache instead of accumulating lifetime history.

Visual picking and semantic entity buttons share the same object-ID selection and panel. Buttons
support normal keyboard operation. The panel distinguishes loading, unavailable and empty history,
and labels canonical and non-canonical times. Session replacement, sign out, removal and selection
changes cancel and discard obsolete reads, including late errors and completion notifications.


## Recorded Why

`POST /v1/runtime/why` accepts exactly `RecordedWhyRequest`: version 1, the four scope IDs and
one entry.

- `commandId` comes from a recent authorized action.
- `eventId` comes from a feed item's `sourceEventIds` and answers the Why of the event's command.
- `scheduleId` with `idempotencyKey` comes from a Why's `schedules` and answers the Why of the
  command that consumed the row, or, while the row is pending, of the command that scheduled it.

`entry` echoes where the traversal started (`command`, `event` or `scheduled-action`). An unknown
event or row answers 404 `event_not_found` or `schedule_not_found`, and the entry access is audited
with that subject. It uses the scoped `runtime:world-observe`
grant and the audited `PostgreSqlCausalInspector.recordedWhy`, which checks that grant itself,
narrows the caller's ceiling to `public_scene` and returns only `RecordedWhy`. A broader
authorized ceiling never expands the shared-browser response. The inspector's causal-chain read
requires `runtime:world-inspect` and an `operator_evidence` ceiling itself, takes no caller-chosen
grant, and audits a refusal before throwing it. This is an observation,
not a command submission, decision regeneration or projection replay verification.
It grants no access to `CausalCommandView` or inspector audit internals. Observation-only callers
receive 403 `authorization_refused` from `/v1/runtime/causal-chain` and `/v1/runtime/runtime-state`,
with denial records under the existing inspector audit rules. Inspect-only callers receive the
same refusal code for public scene, entity and Why reads and scene admission.

`RecordedWhy` identifies the scope, original `commandId`, original `actionId` (or `null`) and
`receiptStatus`. It exposes neither the complete receipt nor the authority decision. `traces.status`
is `available`, `unavailable` (no retained record), or `redacted` (the inspector withheld evidence).
Only `available` may contain drafts. Available with no drafts means no recorded routine decisions;
it must not be substituted for missing or redacted evidence.

Each public draft retains its original zero-based `draftIndex` in the immutable receipt, schema
version, object ID, input revision, recorded simulation time, policy version, selection tier,
candidates and selected action. Revisions and times are canonical unsigned decimal strings;
scores and named feature values are signed decimal strings, preserving bigint precision. Actions
retain their kind and nullable target identity. Candidate features use a closed producer vocabulary
and exclusions use closed reason codes. Private perception, belief and memory references, random
metadata, outcome payloads, credentials, grants and provider identities are not public fields.
`links.parents` and `links.children` include only command identities that a further inspector read
admits under the same public ceiling and exact scope; unknown or foreign links are omitted.
`schedules` lists the schedule rows the command scheduled or consumed: id, idempotency key, kind,
deadline `dueAt`, status, `scheduledBy`, and `completedBy` (or `null`). These are its triggers and
deadlines. A row is listed only when every command it names is this one or an admitted link.
Links and schedule rows are current rows read again on each request, so a later command can
complete a row.

`evidence` labels each part from the closed `INSPECTOR_EVIDENCE_CLASSES`:

- `receipt`, `traces` and `schedules` are `canonical`.
- `links` are `derived`.

`EntitySelection.evidence` labels `entity`, `physical` and `history` as `canonical`, and issue 740's earned
`derived` block as `derived`. Nothing is labelled counterfactual.

The evidence belongs to the recorded receipt. A later canonical revision or derived earned-time
refresh does not rewrite its input revision, time, score or selected action. The selected entity
panel labels canonical physical state and derived non-canonical current values separately.

Responses preserve the inspector's codes: 400 `invalid_inspection_request` for malformed requests,
401 `authentication_refused`, 403 `authorization_refused`, 404 `command_not_found` for unknown or
foreign commands, 429 `inspection_rate_limited`, 500 `inspection_failed`, and 503
`inspector_unavailable`. Malformed retained evidence is an internal inspection failure, never
malformed observer input. Responses contain stable codes, not internal exception details.
An authenticated decoded request retains the inspector's admission, audit and retention rules.
Each additional causal-link authorization is also an audited inspector read.

Use entity buttons and each recent action's **Why action** button with Tab and Enter or Space;
no canvas is needed. The semantic Why panel exposes the same recorded evidence, focuses its
heading on opening, announces loading or failure, and **Close Why** restores focus to the action
button. Unavailable, refused and redacted states remain distinct. New action or entity selection,
history-page replacement, scope edits, sign-out and current authorization failure cancel and
supersede previous Why work, including late results and errors. The browser retains only one
replaceable Why query; loading and rendering never advance canonical state or event history.

### Client view trace

`POST /v1/runtime/view-trace` traces the caller's own view: client view, then audience
decision, then projection revision. It takes `ClientViewTraceRequest`: version 1, the four scope
IDs, and the `interest` the client joined with (`SceneInterest`).

Under the scoped `runtime:world-observe` grant and a `public_scene` ceiling, the server decides
that interest against current canonical state with the scene read's `decideSceneAudience`, using the
caller's own current grants and ceiling. No caller can name another principal's view.
`ClientViewTrace` returns:

- the requested interest;
- the decided `audience`: privacy categories, interest, `hash`, and one reason per viewer path
  (`space`, `selection`, `conversation`, `operator`: outcome, code and detail level);
- the `projection` revision and simulation time it projects.

`audience.hash` equals the `audienceHash` of the scene frames the same view receives. `evidence`
labels the audience as `transient`, because it is decided per request and never recorded, and the
projection as `canonical`.

Each access writes one `inspector_accesses` row with `subject = 'client-view'`, under the inspector
rate limit. The codes are those of the other inspector routes: 400 `invalid_inspection_request`,
401, 403 `authorization_refused`, 409 `world_not_ready`, 429 `inspection_rate_limited`, 500
`inspection_failed` and 503 `inspector_unavailable`.
