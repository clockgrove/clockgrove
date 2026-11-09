# Clockgrove Wave 4: Shared Visual Projection and Inspector Web Client

**Status:** Coding-agent implementation specification  
**Version:** 1.9  
**Date:** October 19, 2026
**Parent plan:** `clockgrove-cloudflare-implementation-plan.md` v3.10  
**Product source:** `clockgrove-prd-v0.5.md` v0.5.9  
**Visual reference:** `6897ED26-A7B5-4F5E-8D90-B6524B538626.jpeg`  
**Wave:** 4 of 13  
**Assumptions:** Waves 0–3 are qualified; PostgreSQL and Journal remain canonical  
**Development tooling:** external tools such as `clockgrove/factory` may execute and verify this wave through replaceable browser-capable execution environments. No specific workstation, operating system, or tool state is a product/runtime dependency.  

---

## 1. Outcome

Wave 4 turns the qualified headless world into a shared, inspectable product. It implements the authenticated React shell, explicit browser-arrival readiness state, Three.js isometric scene, SpaceDO WebSocket projection path, deterministic client convergence, observer navigation, selection and universal interaction, event and causal inspection, accessible text projection, and the first reviewed asset set.

The wave exits only when:

> Two authorized browsers can observe the same living yard, converge through interruption and deployment, select real projected entities, inspect a deterministic action and its causal evidence, and use an equivalent text path—with no browser state becoming world authority.

This is the first demo-quality surface, but it deliberately uses deterministic actors and scripted conversation placeholders. LLM cognition arrives in Wave 5.

---

### 1.1 Objectives, sequencing, and checkpoints

This wave is a substantial workstream containing numerous Objectives and Work Items. The accepted [incremental-delivery ADR](../adr/clockgrove-adr-incremental-wave-delivery-and-evidence.md) governs capability scope, readiness, comparison rules, and proportionate qualification. The complete exit checklist below remains authoritative for full-wave qualification.

First deliver an authorized living-yard view: observe, select an entity, inspect a deterministic Why trace, and use the accessible text alternative. Predeclare the pilot audience, comprehension hypothesis/rubric and recording policy before evaluating this checkpoint.

Complete snapshot/patch convergence, reconnect/hibernation, camera versus embodied movement, interaction disclosure, asset delivery and reviewed art in subsequent Objectives. Shared projection must include only `public_scene`; actor-private cognition and conversations remain behind separate authorized views.

Evaluate whether users understand time, rain, actions and explanations before expanding visual polish. The full visual, accessibility, multi-client and cloud exit evidence remains required; an early local comprehension checkpoint does not qualify this wave.

#### Living-yard pilot protocol — predeclared, unevaluated

**Approval:** the maintainer approved this protocol on 2026-10-21.

**Status:** Evaluated on 2026-11-01 by the agent observer, on candidate `32e9976983f0` (main when issue 800 was accepted), starting at canonical revision 0. The rubric below holds the results; the protocol above is unchanged.

**Audience and recording:** the maintainer is the sole audience. No recording is permitted.

Amended (2026-11-01): the observer is Claude Code, the agent the maintainer orchestrates, not the maintainer. It uses the checkpoint's visual or text path through a local browser, under the same tasks and rubric. No recording is kept beyond the rubric results. An agent observer measures whether the checkpoint's surfaces let an observer complete the tasks; it is not a reading of human comprehension.

**Hypothesis:** An observer can distinguish canonical time from derived current time, recognize a rain-related change in an action, and explain that action using selection and recorded Why evidence.

**Tasks:** Ask the observer to use the authorized living-yard checkpoint, with its visual or equivalent accessible text path:

1. Identify canonical time and derived current time, and explain the distinction.
2. Identify a rain-related change in an action and describe what changed.
3. Select the entity involved, inspect its recent actions and recorded Why evidence, and use that evidence to explain the rain-related action.

**Rubric:** For each task, record whether it was completed unaided and which misunderstandings occurred. Results:

| Task | Unaided completion | Misunderstandings |
| --- | --- | --- |
| Distinguish canonical time from derived current time | Yes | Time is a bare integer with no unit or clock. Derived time appears only after selecting an entity and is labelled "Earned simulation time", which is not explained. After time advanced, derived and canonical values were identical, so the distinction disappeared. "hunger remainder" was unclear. |
| Recognize a rain-related action change | Yes, with dead ends | The scene shows only current "Rain intensity" (0 when looked at), with no rain visual or history, so rain was found only through Why. Recent-action rows named "Action action-pilot-advance-N" are events labelled by the clock command. `routine.selected` rows are buried among needs and wellbeing rows and needed paging. "Selected action" shows no previous value. One raccoon's rain-0 shelter-seeking (a tie at score 0) was a false lead. |
| Explain the action using selection and recorded Why evidence | Yes | One Why lists every raccoon's decision, and the same Why button repeats on every event row of a command. Feature names and scores have no units or legend. A later weather command listed as a "child command" of an earlier decision read as reversed causality. |

**Interpretation:** This pilot makes no population-level claim.

**Run notes:** The text path carried the run, because the canvas drew all entity labels on top of each other. The observer UI has no time control, so simulated time was advanced with `world.advance` commands from outside it (about 2.25 simulated days). One `world.weather.set` rain command was also issued; it proved redundant, since the seed had already rained and the explained decision predates it. Bringing up the checkpoint needed a temporary harness because there is no local start command. The findings above map to planned Wave 4 Objectives: time and boot display, the yard's labels and rain visual, the interaction card, canvas-free timeline and live changes, and per-entity, labelled Why evidence.

**Cost envelope** (recorded 2026-11-01 for issue 817; Claude Code, delegated by the maintainer): local only. No hosted infrastructure and no Clockgrove model-provider spend; the only model use is the observing agent's own session. One session of about 30 minutes on the local checkpoint.

**Replay conditions** (recorded 2026-11-01 for issue 817; Claude Code, delegated by the maintainer): the session starts from the deterministic `green-lake-yard@1` seed. It records the candidate commit and the canonical world revision at its start. The pilot runs once. A replay from the same commit and revision is allowed only to clarify an observed misunderstanding, never to re-score a task.

**Qualification carry-forward:** The Wave 3 evidence manifest (`pnpm qualify:wave3`, issue 853) keeps its hosted items pending: real Cloudflare qualification, owned by issue 3, and the deploy of main, owned by issue 2. This checkpoint uses the incremental-delivery ADR's local-development readiness exception; local acceptance does not qualify Wave 3 or Wave 4. The pending hosted obligations and the full wave-exit evidence remain required. The pilot was evaluated on 2026-11-01; its results are above.

---

### 1.2 Platform and reference-world ownership

The shell is world-agnostic. Clockgrove delivers the React shell, the Three.js scene adapter, the projection and realtime path, the asset pipeline and the browser suites, and proves them on its fixture world: the neutral reference variant under `worlds/fixture/reference` with its placeholder atlas, and an atlas-free neutral run. A world themes the shell through the [world presentation inputs](../protocols/world-presentation.md); platform code names no world's content.

Raccoon World's theme (wordmark, tokens and copy), its reviewed art, its reference image and UI description, its goldens and its browser journeys live in [clockgrove/raccoon-world](https://github.com/clockgrove/raccoon-world). That repository runs them in its own CI against a pinned Clockgrove commit. Where this plan names Raccoon World content, such as the reference composition, the wordmark, `green-lake-yard@1`, Stevie or the first reviewed set, the world half of the obligation is met there through those inputs, and the platform half is met here on the fixture world. Every exit item still holds; each is proven in the repository that owns it.

---

## 2. Entry conditions

These are the full-wave/default entry conditions. A named local-development Objective may consume only accepted prerequisite capabilities under the ADR's recorded readiness exception; its Issue must preserve pending qualification obligations and the selected path's mandatory safety evidence.

- Wave 3 qualification manifest is green.
- Worker authentication, principal mapping, WorldDO, SpaceDO, ActorAgentDO, routing epochs, alarms, Queues, Workflows, and runtime inspection are stable.
- SpaceDO can return an authorized full projection at a known canonical revision.
- Wave 2 event, decision, command, timeline, and causal-inspection APIs are stable.
- `green-lake-yard@1` has a minimal deterministic scene fixture with stable object IDs and presentation metadata.
- Asset provenance, review, content hashing, and R2 bindings exist from Wave 0.
- Better Auth reference development/staging environments—or the selected conforming provider adapter—have observer and operator fixture users.
- The attached 16:9 Raccoon World composition is the visual reference, not a shippable runtime asset.

Amended (2026-10-19, 2026-10-31): Wave 2's decisions are authority decisions. Kernel decision traces, with their selection, retention and indexes, and object state and history arrive in this wave's RW-0407, not from Wave 2. The normalized object/component read models Wave 2 deferred are built in Wave 6, rebuilt from replay. Until Wave 6 builds them, RW-0407's object history reads the event journal.

Amended (2026-10-19): Wave 3 delivers the `world-reactions` Queue path and the provisioning, readiness and catch-up Workflows, and keeps the Wave 0 `ActorAgentDO` shell. The `ActorAgentDO` foundation arrives in Wave 5 and cross-space transfer later (Wave 3 §9.3, §13).

Any missing projection field must be added to a versioned contract before UI code works around it.

---

## 3. Fixed product and authority boundaries

### 3.1 Ownership

- React + Vite owns routing, authentication, HUD, panels, chat placeholder, event feed, inspector, accessibility, errors, and responsive layout.
- Three.js owns canvas rendering, camera, depth order, picking, movement interpolation, animations, particles, weather, highlights, and local visual effects.
- `WorldSceneAdapter` is the only React/Three.js bridge.
- The bridge consumes renderer-neutral semantic scene data. A required headless 3D adapter fixture proves that a true 3D renderer can consume the same object IDs, spatial frames, presentation bindings, revisions, and intents without Three.js types.
- TanStack Query owns HTTP server-state caches.
- Zustand owns transient cross-panel selection and view state.
- The projection reducer owns the last authorized server projection and revision.
- IndexedDB may cache assets and last-known projection metadata, never canonical truth.
- PostgreSQL/Journal own every durable world fact.

### 3.2 Client non-authority

The browser may submit typed intents, acknowledge revisions, and predict only presentation. It cannot commit movement, time, inventory, weather, relationships, or event history. Optimistic UI is limited to controls whose pending state is visibly labeled.

Every submitted intent includes the trusted server-resolved persona and attribution context. The UI renders only effective actions returned by policy evaluation and distinguishes disabled actions from missing capabilities. It does not infer permission from ownership, proximity, or a selected sprite.

### 3.3 One scene connection

The browser holds one scene WebSocket to the current SpaceDO. Conversation sockets arrive in Wave 5. Large snapshots and durable history may use HTTP. Changing spaces performs an authorized handoff and never leaves two active scene owners for one presence.

---

## 4. Visual and interaction contract

### 4.1 Reference composition

The supplied 1536×864 mockup establishes the desktop information hierarchy:

1. a roughly 60 px top HUD spanning the viewport;
2. a primary isometric world canvas occupying about four-fifths of the width;
3. a persistent right detail rail occupying about one-fifth;
4. a compact material-event feed floating at lower left;
5. the selected entity highlighted in-scene and named near its sprite;
6. current world day/time/weather centered in the HUD;
7. navigation and utility actions placed at the left and right edges of the HUD.

Exact pixels may adapt, but the visual hierarchy may not invert. The yard remains the primary surface; panels support it.

Amended (2026-11-07): the owner-supplied reference is committed at [docs/design/reference/raccoon-world-reference.png](https://github.com/clockgrove/raccoon-world/blob/main/docs/design/reference/raccoon-world-reference.png). Its actual size is 1672×941, the same composition as the 1536×864 mockup named above. It is the visual target for both composition and art style: painterly storybook realism, not pixel art. [raccoon-world-ui.md](https://github.com/clockgrove/raccoon-world/blob/main/docs/design/raccoon-world-ui.md#reference) describes it in words. It stays a reference only and is never a runtime background (§4.5).

### 4.2 Art direction tokens

- Background chrome: near-black charcoal with warm olive undertone.
- Panels: translucent charcoal/olive, strong enough for text contrast without hiding the scene.
- Borders: restrained aged-brass/khaki hairlines.
- Primary accent: muted leaf/sage green for selection, permitted actions, and live state.
- Semantic accents: rain blue, event amber, affection coral, warning rust, error red.
- Type: highly readable humanist sans; small caps or spaced display treatment only for the Raccoon World wordmark.
- Scene lighting: cozy warm windows and lanterns against cool wet Seattle ambience.
- Geometry: modest radii, compact controls, circular entity portraits, minimal gloss.
- Motion: slow environmental motion and readable actor animation; no casino-like pulsing.

All tokens live in versioned CSS variables and a design-token package. Color alone never carries state.

Amended (2026-11-09): satisfied for the world-agnostic shell by [DESIGN.md](../../DESIGN.md), which holds the shell's default UI tokens in Google Labs' DESIGN.md format and generates the versioned `--cg-v1-*` CSS variables, with a drift check and a pinned lint in `pnpm check`. A world's tokens override them through the theme seam of [world presentation](../protocols/world-presentation.md). The Raccoon World palette listed above lives in that world's repository, not in the shell defaults.

### 4.3 Required desktop regions

**Top HUD**

- Raccoon World title and world selector.
- Navigation icons for journal, residents, ecology, home, tasks/authoring when authorized, and settings.
- Simulated day, time, running/paused state, speed, and weather.
- Capture, safety/privacy, and menu utilities.

Amended (2026-11-07): the owner defers the navigation icons (journal, residents, ecology, home, tasks/authoring and settings) and the capture, safety/privacy and menu utilities to Wave 8 RW-0807, where the screens they open exist. Reason: in Wave 4 they would open nothing. The Wave 4 top HUD is the title and world selector, and the simulated day, time, run state, speed and weather.

**Scene**

- Fixed isometric camera, limited pan/zoom, no free rotation.
- Yard, den, tree, feeder, trash can, garden beds, paths, water/wetness, lights, and spatial portals.
- Visible deterministic raccoon movement and routines.
- Hover/focus affordance; selected entity gets outline/ring and label.

**Event feed**

- Recent material events with semantic icon, human-readable summary, and world time.
- Selecting an item focuses its location/entity and opens its causal record.
- Feed is derived from authorized semantic events, not raw logs.

**Entity rail**

- Name, portrait/icon, type/voice disclosure, current public state, and location.
- Capability-filtered actions: Talk, Observe/Inspect, Remember/History, Influence, Why.
- Conversation placeholder in Wave 4 uses scripted fixture responses but the final session contract shape.
- Close/collapse without losing scene selection.

### 4.4 Responsive behavior

- At widths below the desktop breakpoint, the right rail becomes a drawer or bottom sheet.
- Event feed becomes a collapsible sheet/timeline.
- Clock/weather and selection remain reachable without reloading the scene.
- Touch picking uses enlarged targets and deterministic selection cycling for overlapping sprites.
- The product must remain usable at 1280×720, common laptop widths, and portrait mobile text mode.

### 4.5 Never fake the world

The reference image must not be used as a background with hotspots. Every actor, object, label, state, event, and interaction is produced from scene projection data and reviewed runtime assets. Static compositing is allowed only in promotional captures, never in the application path.

Amended (2026-11-07): this rule covers the committed reference image [docs/design/reference/raccoon-world-reference.png](https://github.com/clockgrove/raccoon-world/blob/main/docs/design/reference/raccoon-world-reference.png). The application path never loads it, as a background or otherwise.

---

## 5. Owned code and configuration

```text
apps/web/
  app/
  src/auth/
  src/world-shell/
  src/realtime/
  src/projection/
  src/scene/
  src/panels/
  src/feed/
  src/interaction/
  src/inspector/
  src/timeline/
  src/accessibility/
  src/design-system/
  src/test-fixtures/
apps/runtime/src/realtime/
apps/runtime/src/durable-objects/space/sockets/
packages/contracts/src/realtime/
packages/contracts/src/projections/
packages/contracts/src/interaction/
packages/contracts/src/assets/
packages/application/src/projections/
packages/application/src/inspection/
packages/testkit/src/realtime/
packages/testkit/src/browser/
worlds/fixture/assets/
tests/e2e/
tests/visual/
tests/accessibility/
tests/load/realtime/
docs/protocols/realtime-projection.md
docs/protocols/world-presentation.md
```

Raccoon World's `assets/` (source, reviewed, manifests, goldens) and `docs/design/raccoon-world-ui.md` are owned in its repository (§1.2).

Three.js cannot import runtime, persistence, cognition, authentication-provider, or database packages. Runtime cannot import React or Three.js.

---

## 6. Projection and wire contracts

### 6.1 Lanes

```ts
type SceneLane = "projection" | "transient" | "operator";

interface SceneEnvelope<T> {
  protocolVersion: number;
  messageId: string;
  lane: SceneLane;
  type: string;
  worldId: WorldId;
  timelineId: TimelineId;
  spaceId: SpaceId;
  projectionRevision?: bigint;
  sentAt: string;
  traceparent?: string;
  payload: T;
}
```

- Projection messages are monotonic, durable-derived, gap-detectable state.
- Transient cues may be dropped and never repair canonical state.
- Operator messages are authorized diagnostics and disabled for ordinary observers.

Amended (2026-10-30): `runtime:world-observe` authorizes scoped public scene,
selected-entity state and public Why reads, and the public scene connection. `runtime:world-inspect`
does not imply observation: operators need both grants to observe and inspect. Inspection remains
read-only operator authority for the causal-chain view, inspector audit internals and operator-lane
messages; those messages remain unavailable through observer streams. Neither grant adds mutation
authority. As the maintainer decided on 2026-10-27, operator mutations use `runtime:world-operate`,
including publication repair and DLQ replay; this split reuses that grant and defines no other
operator grant. Command, clock and diagnostic no-op operations retain their independent grants.

### 6.2 Snapshot

`SceneProjection` contains world/timeline/space identity, revision, sim clock/weather, visible spatial hierarchy, semantic 2D/3D spatial-frame references, entities, renderer-neutral presentation components/bindings, interaction summaries, material-feed cursor, asset manifest version, privacy/audience hash, and compatibility version.

It excludes private cognition, raw event payloads, hidden entities, secrets, capability grants not relevant to the caller, and provider identifiers.

### 6.3 Patch

Patches declare `fromRevision`, `toRevision`, ordered operations, source event IDs where authorized, and audience hash. A patch is applied only when contiguous and compatible. Duplicate or stale patches are acknowledged and ignored. Gaps trigger bounded backfill, then snapshot fallback.

### 6.4 Transient cue

Transient cues cover footsteps, splashes, particles, short sound references, emotes, hover hints, and animation transitions. They carry expiration and dedupe keys. Missing a cue cannot change the resulting projection.

### 6.5 Browser boot and compatibility

The shell exposes one typed `WorldBootState` rather than independent spinners: `route_resolving → identity_resolved → membership_authorized → joining_space → snapshot_ready → critical_assets_ready → scene_ready`. An accessible `text_ready` terminal state is valid when the semantic projection is usable but visual assets or the scene renderer are unavailable.

Every snapshot declares projection, asset-manifest, and client compatibility versions. Incompatibility is explicit and recoverable: refresh or deploy mismatch, bounded snapshot retry, text fallback, or a stable unsupported-version screen. The UI never displays an apparently live but semantically mismatched scene.

---

## 7. SpaceDO WebSocket runtime

Upgrade path:

1. Worker verifies the configured authentication-provider session and resolves the internal principal.
2. Application authorization resolves world/timeline/space access and privacy ceiling.
3. Worker signs a short-lived internal join assertion.
4. SpaceDO validates assertion, protocol, admission budget, and routing epoch.
5. Client provides last acknowledged revision and asset manifest version.
6. SpaceDO sends backfill or authorized snapshot.
7. SpaceDO stores hibernation attachment with opaque principal, audience descriptor, acknowledgements, and connection version.

Fanout resolves recipient audiences before serialization. Never broadcast a superset and filter in the browser.

Backpressure policy coalesces replaceable projection fields, drops expired transient cues, preserves disconnect/recovery notices, and closes clients that cannot safely catch up.

---

## 8. Deterministic client convergence

The pure reducer accepts snapshot/patch/reconnect actions and produces projection state plus recovery requests. It is independent of React and Three.js.

Required behavior:

- schema/version rejection is explicit;
- duplicate/stale operations are idempotent;
- bounded out-of-order buffer has deterministic eviction;
- gap timeout requests backfill;
- excessive gap or audience change requests snapshot;
- timeline/space mismatch clears state before load;
- reconnect retains no unauthorized entities from a prior audience;
- scene updates are emitted only after reducer commit.

Golden tests permute, duplicate, delay, and drop the same message set and compare final hashes.

---

## 9. Scene implementation

### 9.1 Adapter

```ts
interface WorldSceneAdapter {
  loadSnapshot(snapshot: SceneProjection): void;
  applyPatch(patch: SceneProjectionPatch): void;
  emitCue(cue: TransientCue): void;
  setSelection(id?: WorldObjectId): void;
  focus(id: WorldObjectId): void;
  setReducedMotion(enabled: boolean): void;
  onIntent(handler: (intent: SceneIntent) => void): Unsubscribe;
  destroy(): void;
}
```

### 9.2 Isometric rules

- Fixed 2.5D camera and projection transform.
- Explicit footprint, anchor, elevation, occlusion group, and depth key for each visual entity.
- No general physics engine as authority.
- Movement interpolates between committed path samples; correction snaps only beyond declared threshold.
- Pointer and keyboard picking resolve the same entity order.
- Weather and day/night are visual projections of canonical environment state.

### 9.3 Performance budgets

Declare budgets for initial JS, first scene render, asset bytes, texture memory, frame time, entity count, patch application, and reconnect. The golden yard must hold target frame rate on the supported laptop baseline with weather enabled.

---

## 10. Universal interaction and mode disclosure

All selectable entities implement one UI contract, with actions filtered by entity capability and caller permission.

| Entity mode | Primary operation | Disclosure |
|---|---|---|
| Inspectable | Inspect physical/derived state | “Inspection from world evidence” |
| Reactive | Inspect and invoke typed reaction | “Deterministic/reactive object” |
| Cognitive | Talk, observe, remember, why | “Actor’s subjective perspective” |
| Interpreted | Ask for narrated modeled state | “Interpretation; object is not sentient” |

Wave 4 implements canonical inspect/history/why for deterministic decisions. Talk is a contract-correct scripted fixture and cannot imply persistent cognition.

Influence submits a typed intent and shows proposed, accepted/rejected, committed, and consequential states. It never labels a suggestion as direct control.

### 10.1 Observer navigation

Viewing is not embodiment and is not an object transfer. `ChangeViewedSpace` asks the server to authorize a different space projection; following a selected actor resolves to `followed`, `stayed_within_space`, `permission_denied`, `target_hidden`, or `unavailable`. Selection remains stable only while the target is authorized and projectable.

The first Raccoon World yard may be one viewed authority space with nested visual regions. The contract nevertheless supports later room/space navigation without treating camera movement, user presence, actor movement, and inventory portability as the same operation.

---

## 11. Inspector and text-first projection

### 11.1 Causal inspector

Support progressive authorized traversal:

- selected object → state and recent events;
- event → command, parents, children, affected projections;
- decision → inputs, candidates, score components, chosen action, result;
- scheduled action → trigger/deadline → command → event;
- client view → audience decision → projection revision.

Raw protected values remain redacted. Each view labels canonical, derived, transient, or operational evidence.

Field-guide readers arrive in Wave 6 and counterfactual Why in Wave 7 under the [accepted topic ADR](../adr/clockgrove-adr-field-guides-and-counterfactual-why.md). Wave 4 owns the recorded decision/source identity, authorized trace and visual/text inspector seams they consume. Do not label an ordinary explanation as a counterfactual or expose executable controls before the later capability and preview authority exist.

### 11.2 Text path

The canvas-independent path can:

- summarize current space and weather;
- enumerate perceivable entities and their public states;
- navigate selection with keyboard/screen reader;
- invoke every permitted inspect/influence operation;
- open event history and Why;
- follow actor movement and material changes through live regions;
- recover connection without losing focus.

This is a first-class client projection, not accessibility alt text generated from pixels.

---

## 12. Asset pipeline

Amended (2026-11-09, issue 61): the pipeline is style-agnostic. Versioned world
presentation data declares alpha/opacity threshold, colour, edge and per-role
size rules, outside simulation content hashes. The fixture declares pixel art;
external worlds can use painterly or flat-cartoon profiles. The issue 813
256 px frame-edge decision is the pixel-art profile's value, within the shared
WebGL/atlas envelope. Generated manifest v2 provenance records provider output
grants; MIT requires permission to relicense, CC-BY retains attribution, and
non-commercial or provider-retained outputs cannot deploy. External authors use
[world-location asset commands](../../packages/assets/docs/pipeline.md#external-world-commands)
from a pinned checkout, including single-asset validation, reviewed atlas and
licence builds, and human-approved golden rendering.


Every asset manifest records source, creator/tool, license, prompt/reference provenance when generated, review status, semantic entity/archetype, animation family, anchor, footprint, bounds, palette, content hash, atlas location, and accessibility label.

Pipeline:

1. import/generate source;
2. capture provenance;
3. validate dimensions/transparency/naming;
4. human review for anatomy, style, artifacts, and fit;
5. build atlases and animation manifests;
6. upload content-addressed outputs;
7. bind through world pack;
8. render golden scene at fixed camera/time/weather;
9. approve visual diff.

First reviewed set, delivered in the reference world's repository (§1.2): Stevie, Gracie/Juniper placeholder variants, kits, idle/walk/sniff/eat/play/shelter animations, den, trash can, feeder, mailbox, tree, paths, plants, rain, puddles, lantern/window lighting, and selection/interaction effects.

---

## 13. Detailed work packets

### RW-0401 — Scene projection schemas

Freeze snapshot, patch, transient, audience, compatibility, asset-manifest, feed-summary, interaction-summary, `WorldBootState`, `ChangeViewedSpace`, follow-disposition, private-Caretaker-talk, and public-speech contracts. Add golden serialization, boot-resume, compatibility, navigation, and privacy fixtures.

Exit: incompatible versions fail visibly; no private fixture field appears in an observer projection.

### RW-0402 — Space WebSocket runtime

Implement authenticated upgrade, signed join assertions, hibernation attachments, acknowledgements, backfill/snapshot selection, admission, backpressure, fanout, redeploy recovery, and socket inspection.

Exit: real Cloudflare hibernation/restart preserves or safely restores connection state.

### RW-0403 — Client convergence reducer

Implement pure reducer, gap buffer, dedupe, reordered/stale handling, audience changes, reconnect/backfill, snapshot fallback, hashes, and property tests.

Exit: all delivery permutations converge or request the one correct recovery action.

### RW-0404 — React product shell

Implement provider-neutral authentication boundary, world route/selector, unified boot/readiness state, compatibility handling, text fallback, HUD, clock/weather, event feed, observer navigation, selected rail, drawers, errors, recovery, design tokens, and state ownership.

Exit: the shell matches the reference composition at desktop and preserves all core functions at laptop/mobile breakpoints.

### RW-0405 — Three.js isometric scene

Implement camera, coordinate conversion, layers, depth, anchors, picking, selection, interpolation, animation, wet-weather/day-night effects, typed adapter, cleanup, performance instrumentation, and a headless full-3D conformance fixture for the same adapter contract.

Exit: the yard is assembled from projected entities/assets and remains interactive at target frame budget.

### RW-0406 — Interest and client audience filtering

Implement camera/space/selection/conversation/operator interest descriptors, server authorization, audience hashes, privacy-different snapshots/patches, and transition cleanup.

Exit: two principals in one space receive different correct views with no client-side secrecy assumption.

### RW-0407 — Universal interaction and inspector

Implement entity card, mode disclosure, action resolution, canonical Inspect, scripted Talk placeholder, Influence receipts, Why traversal, event focusing, redaction, and audit.

Exit: a user can explain why Stevie sought shelter using authorized deterministic evidence.

### RW-0408 — Timeline and text-access path

Implement timeline metadata, revision/event navigation, branch placeholder state, live regions, keyboard entity navigation, text scene, reduced motion, focus recovery, and screen-reader contracts.

Exit: every Wave 4 journey is completable without the canvas.

### RW-0409 — Deterministic asset pipeline

Implement manifests, provenance/review checks, optimization/atlas build, content-addressed R2 upload, world-pack binding, golden camera fixture, the fixture world's placeholder set and license report here, and the reference world's first character/environment set in its own repository.

Exit: staging scene is reproducible from approved source/manifests; no unreviewed asset can deploy.
The local pipeline is proven on generated pixel, cartoon and painterly external
worlds; reviewed output is served by the external local shell. Human approval,
provider-grant enforcement and scene-diff review remain required for every style.
Staging upload evidence remains pending on issue 3.

Amended (2026-10-27): RW-0409 inherits from Wave 1 (Wave 1 §5.2) the registration of the Presentation component, whose first consumer is the world-pack presentation binding.

### RW-0410 — Realtime and client qualification

Assemble convergence, privacy, hibernation, redeploy, visual, accessibility, performance, and fanout suites. Produce reference captures at fixed viewport/time/weather.

Exit: publish Wave 4 qualification manifest and satisfy the outcome.

Amended (2026-11-06): PRD §33 item 4 (2026-10-19, v0.5.10) runs one space owner per world partition and moves cross-space transfer to Wave 11, so RW-0410 assembles no cross-space suite and §15.2 drops the actor-crosses-spaces scenario. Following a selected actor across a viewed-space boundary inside one partition stays in §15.2.

---

## 14. Dependency graph and bounded execution

```text
RW-0401 ─┬─ RW-0402 ─┬─ RW-0403 ───────────────┐
         │            └─ RW-0406 ───────────────┤
         ├─ RW-0404 ───── RW-0407 ─ RW-0408 ───┼─ RW-0410
         └─ RW-0409 ───── RW-0405 ──────────────┘
```

Safe parallel lanes:

- projection contracts and asset-manifest contracts;
- WebSocket runtime and React shell after envelope freeze;
- asset preparation and Three.js adapter;
- inspector APIs and accessibility text projection;
- fault/fanout harness and visual-regression fixtures.

One owner coordinates `apps/web` composition and one owner coordinates realtime schemas.

---

## 15. Test and qualification strategy

### 15.1 Required suites

```text
pnpm test:projection
pnpm test:realtime
pnpm test:web
pnpm test:scene
pnpm test:e2e
pnpm test:visual
pnpm test:a11y
pnpm test:realtime:load
pnpm qualify:wave4:staging
```

### 15.2 Browser scenarios

- two observers join before/after an event and converge;
- one observer has relationship-private access and the other does not;
- duplicate, reordered, stale, missing, and incompatible patches;
- network offline/online, token expiry, hibernation, DO restart, Worker deploy;
- world pauses/resumes/speeds up;
- rain begins, puddles update, an actor moves, event feed records, Why explains (on the fixture world here; with Stevie in the reference world's journeys);
- keyboard-only and screen-reader-equivalent interaction;
- reduced motion and high zoom/text scale;
- scene asset missing/corrupt/version mismatch;
- world still provisioning, failed provisioning with retry/status, and transition to `WorldReady`;
- projection/client/asset incompatibility with explicit refresh or text fallback;
- snapshot ready before critical assets, asset recovery, and no false `scene_ready`;
- selected actor crosses a viewed-space boundary with each follow disposition;
- private Caretaker Talk never appears as public spatial speech, while an explicit public-speech action does;
- a 3D spatial-frame fixture passes through the headless adapter with semantic IDs and no Three.js or quadtree identifiers.

Amended (2026-11-09, issue 23): local qualification uses only the shell and
`fixture/reference`. The WebGPU and forced WebGL2 living-hall browser journey
(`tests/e2e/living-hall.journey.browser.test.mjs`) drives these steps through the
local runtime and PostgreSQL; the scenario matrix names their markers:

| Row | Browser step |
| --- | --- |
| S1 | Join an observer, commit an event, join another observer and compare their views. |
| S4 / F4 | Keep the browser offline until a reconnect attempt fails while it still shows recovery, then go online; expire its session in the session store, observing the refusal and recovery on sign-in. |
| S5 | Observe pause, resume and speed changes in the clock HUD. |
| S12 | Hold the atlas request past the snapshot; while it is held, boot stays at `snapshot_ready` with no canvas presented. Release it; readiness waits for presentation. |
| F1 | Drop the socket before its first snapshot, then recover. |
| F13 | Request inspection as an observer without inspect authority and show the denial. |
| A4 | Lose the canvas; a failed retry stays on the text path, and a successful one rebuilds the canvas from the retained reducer projection, with arrival status and accessibility mode reporting it. |
| A5 | Compare PostgreSQL world facts across the React error-boundary fault. |

S4's full coverage is local: hosted hibernation, restart and deployment still
belong to issue 3. F6 and F7 retain that hosted deviation. The runtime evidence
JSON records the local browser source and backends separately from hosted
qualification. Golden-capture approval and the §19 independent review remain
maintainer steps; these browser proofs do not qualify the whole wave.

### 15.3 Visual regression matrix

Capture fixed golden states at 1536×864, 1280×720, and one narrow layout:

- daylight/dry;
- dusk/rain matching the reference mood;
- selected cognitive actor rail;
- selected inspectable object rail;
- event/Why inspector open;
- disconnected/recovering;
- text-access mode.

Diffs require human approval when asset or layout intent changes.

Amended (2026-11-06): the §15.1 suites are package scripts (see [development.md](../runbooks/development.md)). `pnpm qualify:wave4` runs them and writes the §19 manifest. The narrow layout is 390×844. Until Wave 5 adds a cognitive actor, `green-lake-yard` has none, so the selected-actor golden state selects Stevie, whose mode disclosure is reactive. That substitution is a known deviation in the manifest. A capture counts as approved only when its SHA-256 is listed in `tests/visual/approved-captures.json`, which a person reviews and commits.

Amended (2026-11-07): the owner delegated the review of the §15.3 golden captures to an agent. An agent may approve a capture in `tests/visual/approved-captures.json` on the owner's explicit delegation, recorded in the pull request that adds the approval. CI never approves a capture.

---

## 16. Failure, recovery, and security matrix

Inject socket drop before/after snapshot, patch gap, stale join assertion, expired token, audience/grant change, SpaceDO hibernation, deploy, backpressure, corrupt cached metadata, asset 404/hash failure, React error boundary, WebGL context loss, and inspector authorization denial.

Assert:

- no unauthorized entity survives in memory or UI after scope change;
- acknowledged canonical state is never rolled back by a stale message;
- reconnect status is explicit;
- scene can rebuild from reducer state;
- browser errors do not corrupt or mutate the world;
- operator details never appear in ordinary telemetry/UI;
- accessibility path remains available when WebGL is unavailable.

Amended (2026-11-07): the owner rules corrupt cached metadata (item F9 of `scripts/ci/qualify-wave4-scenarios.json`) not applicable to Wave 4. The web client keeps no persistent metadata cache: no IndexedDB, Web Storage or Cache Storage, and its runtime reads use `cache: "no-store"`. §3.1 allows such a cache but does not require one, so there is no cached metadata to corrupt. A later wave that adds a metadata cache takes on F9's test as its own obligation.

---

## 17. Observability and evidence

Measure connection admission, handshake, current/acked revision, patch bytes, fanout recipients, audience decisions, gap/reconnect/snapshot fallback, reducer latency, scene apply time, dropped cues, frame budget, asset cache/hashes, interaction outcome, inspector traversal, accessibility mode, and errors by release/world-pack.

Analytics use opaque IDs and action categories. They do not record private conversation fixture text or hidden projection payloads.

The [partial runtime evidence manifest](clockgrove-wave-4-runtime-evidence.json) keeps
real Cloudflare hibernation, restart and redeploy qualification pending on issue 3,
blocked on owner setup issue 1 and the Wave 0 hosted half, issue 2. Local workerd/PostgreSQL checks establish
only local native behavior; they do not qualify hosted Cloudflare or the whole wave.
`tests/ci/scene-evidence.test.mjs`, included in ordinary Testkit discovery, checks the
manifest's pending scenarios, owners, blockers and absent hosted evidence exactly,
and rejects relabelling local native checks as hosted success.

---

## 18. Explicit non-goals

Wave 4 does not implement:

- production LLM conversations, memory, beliefs, learning, dreaming, or MCP;
- natural-language authoring, branches, promotion, or complete rules;
- a player avatar or general multiplayer embodiment;
- production free-camera 3D, 3D physics, photorealism, or a general game engine in this wave; the renderer-neutral projection contract and headless 3D fixture keep these additive later;
- static screenshot hotspots or client-authored world outcomes;
- full lifecycle/ecology content polish;
- native mobile apps or external channel providers.

---

## 19. Exit evidence checklist

- [ ] RW-0401 through RW-0410 are merged.
- [ ] WebSocket authorization and audience filtering occur server-side.
- [ ] Snapshot/patch reducer convergence suite passes.
- [ ] Hibernation, restart, deploy, reconnect, and snapshot fallback pass on Cloudflare.
- [ ] React/Three.js ownership boundary is enforced.
- [ ] Reference composition and art-direction tokens are implemented.
- [ ] Scene is data-driven; reference image is not a runtime background.
- [ ] Selection, event feed, entity rail, Inspect, Influence, and Why use real contracts.
- [ ] Entity mode disclosure distinguishes inspectable/reactive/cognitive/interpreted.
- [ ] Text path covers every required interaction.
- [ ] Asset provenance/review/license gates pass.
- [ ] Visual, accessibility, performance, privacy, and fanout qualifications pass.
- [ ] Main remains deployable and local setup remains reproducible.

The manifest records commit, protocol/schema/asset versions, browser matrix, golden capture hashes, convergence/fault results, accessibility report, Web Vitals/frame/load evidence, Cloudflare qualification, known deviations, and exit decision.

---

## 20. Handoff to Wave 5

Wave 5 replaces the scripted Talk fixture with durable sessions and recoverable cognitive turns. It consumes the existing entity rail, conversation region, ActorAgentDO session route, mode disclosure, realtime envelope, context/inspection APIs, and projection authority rules. Conversation streaming adds a separate lane; it does not mutate the scene reducer or make model output world truth.
