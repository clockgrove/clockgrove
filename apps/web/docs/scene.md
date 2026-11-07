# Isometric scene

This is the contract for the Raccoon World canvas (`src/renderer.ts`) and its bridge (`src/world-scene-adapter.ts`). It follows
[Wave 4 plan §9](../../../docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md#9-phaser-scene-implementation).

## Adapter

`WorldSceneAdapter` implements the §9.1 interface and is the only React/renderer bridge. The bridge
imports only `@clockgrove/contracts` (`tools/web-boundaries.mjs`).

- `loadSnapshot(projection)` draws a committed `SceneProjection`. The shell calls it with each
  projection the convergence reducer commits, and never with anything else (plan §8). Entities that
  persist across loads keep their sprites, so they move instead of respawning. A change of scope
  rebuilds the scene and reframes the camera.
- `applyPatch(patch)` applies only the next contiguous patch, through the same `applyScenePatch` the
  reducer uses. A stale, duplicate or gapped patch changes nothing, because recovery belongs to the
  reducer.
- `emitCue(cue)` draws a short marker once per dedupe key until the cue expires. It remembers at most
  64 keys and forgets the oldest first. A cue never changes the projection. The socket does not yet
  forward cues to the shell.
- `setSelection(id?)` and `focus(id?)` draw the selection and keyboard-focus emphasis. `focus`, and
  `setSelection` when the selected id changes, also pan the camera when the entity is out of view, so
  choosing a feed event reveals its entity. With no id, `focus` clears the focus affordance.
  Both the optional id and the pan widen §9.1, which declares `focus(id: WorldObjectId)` only: every
  adapter, the headless 3D fixture included, must accept `focus(undefined)` as clearing focus.
- `setReducedMotion(enabled)` follows `prefers-reduced-motion`. While it is on, moves snap,
  animations hold frame 0, rain does not animate, focus pans are immediate and cues do not drift.
- `onIntent(handler)` receives `{ type: "select", objectId }` intents. Intents only select. The
  canvas never mutates the world.
- `destroy()` removes the canvas listeners and the context-loss listener, clears the intent handlers,
  removes the atlas texture and destroys the game.
- The adapter refreshes the canvas bounds when a pointer enters or presses the canvas, or the page
  scrolls. Phaser's periodic bounds poll is off, so no layout read happens between those events.

The renderer loads the atlas manifest, then fetches the atlas image itself and compares the
SHA-256 of its bytes with the manifest's `image.sha256` before any use. A copy is refused when the
fetch fails, the response is not ok or the hash differs. A refused copy is discarded, reported as
`asset_cache` `failed`, and fetched once more with `cache: "reload"`. A second refusal reports
another `asset_cache` `failed` and `client_errors` `asset`, and the renderer is unavailable. Only a
verified copy is loaded (through a blob URL, revoked once loaded) and reported ready, which advances
boot to `critical_assets_ready`. The renderer also reports when it becomes unavailable, with a
reason: a missing, unverifiable or unloadable reviewed atlas is `assets_unavailable` and a lost
WebGL context is `renderer_unavailable`. The shell then destroys the adapter and shows the text
path. The reducer's committed projection is untouched.

## Isometric rules (§9.2)

- **Camera.** The camera is fixed at 2:1 isometric, with east running down-right and north running
  up-right. The scale is 12.5 px per metre, which is the issue 813 golden's 80 mm per pixel, so reviewed
  sprites draw 1:1. Frame units become metres by unit name (metre, millimetre); an unknown unit counts
  as metres. On each scope's first snapshot the camera is centred on the projected entities. Panning
  (by drag) is bounded to 160 px beyond them, and never less than the view at the smallest zoom. Zoom
  (by wheel) is clamped to 0.75–2. There is no rotation.
- **Visual entity.** Each drawn entity has explicit geometry:
  - **Footprint** in millimetres, drawn as a ground shadow.
  - **Anchor**, the frame pixel that stands on the pose.
  - **Elevation**, the z coordinate of a 3D frame, else 0.
  - **Occlusion group**: `ground` < `standing` < `weather` < `emphasis`. Every projected entity is
    `standing`.
  - **Depth key**: occlusion group, then nearness to the viewer (x − y), then elevation, then object
    id.

  A bound entity takes its footprint and anchor from the reviewed atlas entry for its
  `assetId`/`animationFamily` (`assets/reviewed`, served by Vite). Anything else draws as a
  placeholder marker with a 600 × 600 mm footprint. The family is the projection's: the runtime chooses
  it from the actor's committed activity ([realtime projection](../../../docs/protocols/realtime-projection.md#snapshots-and-ordered-patches)),
  and a changed family replaces the sprite with the new strip.
- **Pick order.** `pickOrder` lists the entities nearest first. Drawing uses the reverse order.
  Pointer, touch and keyboard picking all resolve in this order. A pointer picks the first candidate
  within 12 px, and the entity list in the shell is in the same order. A touch tap uses a 24 px
  radius (§4.4). A repeated tap within 8 px on the same candidate set picks the next candidate and
  wraps around.
- **Movement.** A committed move of up to 16 m interpolates over 400 ms. Sixteen metres is beyond
  the longest green-lake-yard path edge (14.2 m, `den-mouth` to `tree-base` in
  `worlds/raccoons/resources/spaces/neighborhood.json`), so a one-edge step interpolates. A longer move, or a
  change of frame, snaps. There is no physics engine.
- **Environment.** Night uses the issue 813 golden's rule: before 06:00 or from 18:00 of the canonical
  86 400 000 ms day. It is drawn as a black overlay at alpha 0.6, matching the golden's grass at 2/5
  brightness. While `rainIntensity` is above 0, the reviewed rain effect tiles the view, as it does
  in the golden. The projection's `effects` are drawn as sprites from the reviewed atlas key
  `<assetId>/<animationFamily>`, placed like entities. Puddles show while `rainIntensity` is above 0,
  in the ground group above shadows and below standing bodies; when the rain ends they fade out over
  400 ms, or vanish at once under reduced motion. Lantern and window lights show at night by the rule
  above, above the night overlay and below rain. A hidden effect stops animating. Under reduced
  motion shown effects hold frame 0. The text path states the same conditions as `Puddles: <count or
  none>` and `Lights: <lit roles, or off>`.
- **Labels.** Only the selected and the hovered entity are labelled on the canvas, so labels never
  pile up. The text path lists every label.
- **Selection.** The renderer draws it from projection data, never into art: a 2:1 ellipse at the feet
  (32x16, 3 px stroke, 0.18 fill) with two wider glow ellipses (+8 and +16 px, alpha 0.35 and 0.15),
  all in the `--rw-v1-accent` token, and a dark rounded pill (`--rw-v1-panel`, alpha 0.92) holding the
  name in `--rw-v1-text`, centred above the sprite. Hover (24x12) and focus (40x20) are 1 px ellipses
  and the hover label is plain text without a pill, so both stay lighter than selection.

## Budgets (§9.3)

[`scene-budgets.json`](../scene-budgets.json) records each limit with its source or decision.

| Budget | Limit | Checked by |
| --- | --- | --- |
| Initial JS (gzip, every built chunk: entry plus scene chunk) | 512 000 B | `tools/scene-budget.mjs` in `pnpm check` |
| Reviewed asset bytes | 256 KiB | `tools/scene-budget.mjs` in `pnpm check` |
| Texture memory | 16 MiB | Chromium journey |
| First scene render | 2 500 ms | Chromium journey |
| Frame time, 95th percentile | 33.4 ms | Chromium journey |
| Entity count | 256 | Chromium journey |
| Patch application | 8 ms | Chromium journey |
| Reconnect, from observed drop to ready | 3 000 ms | Chromium journey |

The Chromium journey (`tests/e2e/living-yard.journey.browser.test.mjs`) measures the runtime budgets on the golden yard
with rain and puddles showing, from the adapter's `metrics`. These are local checks on the CI runner. They are
not a measurement on the supported laptop baseline.

Frame time is the unsmoothed interval between game steps (Phaser's `loop.rawDelta`). Phaser's own
delta averages ten frames and clamps slow ones, so it can report 16.7 ms while the page draws at
12 frames per second. The adapter draws the scene only on a step where something visible may have
changed: a committed draw, an emphasis change, a cue, a rain or sprite animation frame, a running
tween, or a camera scroll or zoom. Other steps still run Phaser's update (input, timers, tweens and
animations), and the canvas keeps its last frame. WebGL multisampling is off.
