# Lit isometric scene

This is the contract for the world shell Three.js WebGPURenderer canvas (`src/renderer.ts`) and its bridge
(`src/world-scene-adapter.ts`). The renderer choice is recorded in the accepted [renderer ADR](../../../docs/adr/clockgrove-adr-renderer-bake-off.md);
the scene contract is [Wave 4 plan §9](../../../docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md#9-scene-implementation).

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
- `setSelection(id?)` and `focus(id?)` draw the selection and keyboard-focus emphasis. `focus` also
  pans the camera when its entity is out of view. With no id, `focus` clears the focus affordance.
  Both the optional id and the pan widen §9.1, which declares `focus(id: WorldObjectId)` only: every
  adapter, the headless 3D fixture included, must accept `focus(undefined)` as clearing focus.
- `setReducedMotion(enabled)` follows `prefers-reduced-motion`. While it is on, moves snap,
  animations hold frame 0, rain does not animate, focus pans are immediate and cues do not drift.
- `onIntent(handler)` receives `{ type: "select", objectId }` intents. Intents only select. The
  canvas never mutates the world.
- `destroy()` removes canvas/context listeners, cancels the animation frame, clears intent handlers,
  and disposes scene geometries, materials, textures, postprocessing targets and renderer resources.
- The adapter refreshes the canvas bounds when a pointer enters or presses the canvas, or the page
  scrolls. Pointer moves do not trigger repeated layout reads.

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
  the longest reference-fixture path edge (14.2 m, `den-mouth` to `tree-base` in
  `worlds/fixture/reference/resources/spaces/neighborhood.json`), so a one-edge step interpolates. A longer move, or a
  change of frame, snaps. There is no physics engine.
- **Environment.** Lighting and weather read only the committed projection, never painted highlights
  in the art. Night remains before 06:00 or from 18:00 of the canonical 86 400 000 ms day.
  Projection `effects` bind reviewed `<assetId>/<animationFamily>` strips and poses. Puddles show
  while `rainIntensity` is above zero, above shadows and below standing bodies; when rain ends they
  fade over 400 ms, or vanish immediately under reduced motion. Lantern and window sources light
  at night. Hidden effects stop animating; reduced motion holds shown effects at frame 0.
  The text path states the same conditions as `Puddles: <count or none>` and `Lights: <lit roles, or off>`.
- **Labels.** Only the selected and the hovered entity are labelled on the canvas, so labels never
  pile up. The text path lists every label.
- **Selection.** The renderer draws it from projection data, never into art (decisions, in
  `SELECTION` and the token constants of `renderer.ts`): a 2:1 ellipse at the feet (32x16, 3 px
  stroke, 0.18 fill) with two wider glow ellipses (40x20 with a 6 px stroke at alpha 0.35, 48x24 with a
  10 px stroke at alpha 0.15), all in the `--rw-v1-accent` token; and a pill with fully round ends
  filled with `--rw-v1-panel` (`rgb(30 33 22 / 92%)`, so alpha 0.92) and a 1 px `--rw-v1-accent`
  hairline at alpha 0.6, holding the name in 13 px `--rw-v1-text` with 10 px side and 4 px top and
  bottom padding, its bottom edge 6 px above the sprite's anchor height. The ring and pill are built
  once per selected entity, label and sprite height, and later draws only move them. Hover (24x12) and
  focus (40x20) are 1 px ellipses and the hover label is plain text without a pill, so both stay
  lighter than selection.

## Materials, lighting and quality

`WorldSceneAdapter` remains renderer-neutral: no Three.js types enter the presentation or projection
contract. The product uses `WebGPURenderer` (`three/webgpu`) and an orthographic 3D scene. It selects
WebGPU where available and automatically falls back to WebGL2. Materials are node materials and
post-processing uses TSL (`three/tsl`) so both backends compile the same shader graphs; raw GLSL
`ShaderMaterial` and `onBeforeCompile` patches are excluded. Quads are the present visual geometry,
so future 3D meshes can reuse the adapter, materials and lights.

Material channels belong to the presentation contract. Until issue 66 supplies normal, height,
emissive, roughness/wetness and wind maps, the current reviewed atlas binding is flat albedo.
Missing channels use neutral defaults, rather than extracting a normal, height, emissive mask or
light source from the art's brightness. Light activation and poses come from projection effects;
clock/weather patches change the light rig without changing world state or rereading art.

The live canvas is 640×400 at DPR 1. Quality selection is conservative: software renderers
(SwiftShader/llvmpipe), missing floating-point color targets, maximum texture size below 4096,
or device memory below 4 GiB choose low. WebGPU software detection reads the device adapter
architecture/description; WebGL2 uses its debug renderer identity. Otherwise memory below 8 GiB
chooses medium and the remaining capable devices choose high. These thresholds are local decisions to bound target
allocation and shader work, rather than measured device-class performance promises.

| Tier | Scene target / lighting | Rain particle cap | Bloom | Wind | Puddle reflections |
| --- | --- | ---: | --- | --- | --- |
| low | 320×200, Lambert diffuse | 0 | off | off | off |
| medium | 640×400, Standard PBR | 64 | half-size targets, strength 0.08 | on | off |
| high | 640×400, Standard PBR | 192 | full-size targets, strength 0.12 | on | stencil-masked mirrored sprite geometry |

All tiers retain projection-driven lights, emissive, lit geometry and fog. Low uses Lambert node
materials to avoid Standard's GGX/Fresnel specular work, and a half-resolution TSL scene pass to
shade 75% fewer scene fragments on software/limited devices. This is a local budget policy, not a
change to the 640×400 output canvas, logical camera, picking coordinates or text path. Medium and
high retain full-resolution PBR and wet specular. Tier changes preserve common material state,
dispose replaced materials and restore puddle roughness when returning to PBR. Bloom radius is 0.2 and threshold 0.8. These tuning values
are renderer decisions for restrained glow, replacing the bake-off's over-strong bloom. Reflections
are a bounded visual approximation, not a physically complete reflection pass. After 120 frame
intervals, p95 above the 33.4 ms frame budget downgrades one tier; there is no automatic upgrade
loop. Reduced motion freezes animation independently of tier. Tier policy is local presentation
state and never writes a projection or runtime command.

Bloom and tone grading are separate from source emission. Warm sources use `0xffb966` with
emissive intensity 0.45 and a declared linear luminance range of 0–0.45 before grading
(`EMISSIVE_LUMINANCE`); ACES tone mapping uses exposure 1. The bound is a tuning decision, not a
physical photometric claim. Lantern/window light must retain its color instead of becoming white. Every tier requires a golden comparison, including tiers
without bloom. Run captures through `pnpm run qualify:wave4` and retain its evidence; a spike
screenshot or an unrun golden is not product qualification. ANGLE D3D11 and ANGLE GL over D3D12
are the required hardware targets. Their working bake-off paths are evidence for the selection,
not revalidation of the integrated adapter. CI's SwiftShader path supplies product correctness
evidence when its journey runs; physical GPU timing is reserved for the maintainer step.

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

The Chromium journey (`tests/e2e/living-hall.journey.browser.test.mjs`) measures the runtime budgets on the golden yard
with rain and puddles showing, from the adapter's `metrics`. The settled cadence window starts after the
additional viewer's first render, so its initial shader compilation is accounted for by the separate
first-render budget. These are local checks on the CI runner. They are
not a measurement on the supported laptop baseline.

Frame time is the unsmoothed interval between animation-frame callbacks, bounded to the latest
120 samples. It measures visible cadence, not GPU-complete latency. The bake-off's reference
GPU-complete numbers are separately sourced in `scene-budgets.json`: on the RTX 2060 SUPER at
960×540 DPR 1, high-tier Three.js WebGL2 spike camera pans measured p50/p95 1.8/2.0 ms under Windows
Edge/ANGLE D3D11. The WSL2 ANGLE GL-over-D3D12 path also rendered successfully. These are
spike measurements; product measurements on the owner's box remain a maintainer step after merge.
CI runs both WebGPU and forced WebGL2 under SwiftShader and records the actual backend and
adapter with each check.
SwiftShader proves correctness and is never performance evidence. Hardware WebGPU,
ANGLE D3D11 and ANGLE GL over D3D12 require real-GPU maintainer validation, including the fallback
framebuffer behavior identified in the spike. Product GPU-complete timing remains a maintainer step.
Multisampling is off. Texture accounting conservatively includes the renderer output
RGBA16F/depth-stencil target, the tier-scaled scene pass, the scaled bright target and both
five-level bloom chains (Three r187 allocation layout), plus atlas and generated UI textures.
WebGPU device loss follows the same text fallback as WebGL context loss.

The right rail shows a cognitive actor's private conversation as chat bubbles under its portrait,
a Talk / Observe / Remember / Why? grid drawn only from the actions the interaction card reports,
and a message box. Below 1200 px the rail is the bottom sheet; it works without the canvas.

Atlas animation uses per-mesh UVs on one shared atlas Texture. Three r187's WebGPURenderer allocates
GPU storage per Texture identity on both backends, so cloning textures that share an image would
duplicate atlas storage. Reflections borrow their source texture and copy animated frame UVs; they
dispose their own geometry/material without disposing the borrowed texture. Texture accounting counts
unique material-map Texture identities across the whole scene, including effects, reflections and
generated labels, plus the conservative render-target allocations above.
