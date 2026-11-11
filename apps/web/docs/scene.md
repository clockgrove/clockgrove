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
  or any element around the canvas scrolls. Pointer moves do not trigger repeated layout reads.

When the world shell sets `scene.atlases`, the renderer reads the reviewed output's `atlases.json`
index and loads every page it lists, so a logical atlas split into `-page-N` pages and a world with
several atlas ids both draw all their assets. For each page it loads the page's animation manifest,
then fetches the page image itself and compares the SHA-256 of its bytes with the manifest's
`image.sha256` before any use. A copy is refused when the fetch fails, the response is not ok or the
hash differs. A refused copy is discarded, reported as `asset_cache` `failed`, and fetched once more
with `cache: "reload"`. A second refusal fails the whole load. A missing or malformed index, a page
that does not load, or an animation listed on two pages reports `asset_cache` `failed` and
`client_errors` `asset`, and the renderer is unavailable. Only once every page is verified and loaded
(each through a blob URL, revoked once loaded) are their animations merged into one map, keyed
`assetId/animationFamily`, and reported ready as one `asset_cache` `loaded`, which advances boot to
`critical_assets_ready`. The renderer also reports when it becomes unavailable, with a
reason: a missing, unverifiable or unloadable reviewed atlas is `assets_unavailable` and a lost
WebGL context is `renderer_unavailable`. The shell then destroys the adapter and shows the text
path. The reducer's committed projection is untouched.

## Material delivery

A material-enabled atlas animation exposes every named channel and supplied density. Both 1× and
2× are present, with optional 4×. Each channel identifies a content-addressed PNG fallback and a
KTX2 texture (Basis Universal UASTC, `ktx2-uastc`), dimensions, byte sizes and frame rectangles.
The renderer loads one of the two per page, chosen per device when the first material animation
loads:

- It asks the initialized backend, WebGPU features or WebGL2 extensions, through Three's
  `KTX2Loader.detectSupport`. When the device samples ASTC 4×4, BC7, ETC2 RGBA8 or BC3, in that
  order of preference, it fetches the page's `.ktx2`, verifies its SHA-256 and transcodes it off
  the main thread to that format. Desktop GPUs, which typically sample only BC formats, get BC7
  (BC3 without BPTC); phones get ASTC, or ETC2 without it.
- Only a device that samples none of them fetches the `.png` page and uploads RGBA8.
  `metrics.materialTextureFormat` reports `astc`, `bc7`, `etc2`, `bc3` or `png`.
- A compressed page that fails, whether its `.ktx2` is missing or fails its hash, the transcoder
  does not load, the worker runs out of memory or the transcoded size is not the charged one,
  falls back to that page's hash-verified PNG. The PNG is charged at RGBA8 against what remains
  of the budgets; if it no longer fits, the animation draws its flat sprite. Other pages and flat
  sprites are unaffected. Each fallback adds one to `metrics.materialTextureFallbacks` and
  reports `asset_cache` `failed`; a page that failed is not retried. Only a failed PNG page fails
  the scene's assets, as before.

The renderer keeps one KTX2 loader, shared by material pages and world content
(`loaders()`), so the transcoder and its workers load once per renderer; it is disposed when the
renderer and every content loader holding it have released it. The Basis transcoder
(`basis_transcoder.js` and `.wasm`) comes from the pinned `three` installation as built assets of
this app, served from its own origin, and is fetched only when the first KTX2 texture parses
(see [third-party notices](../../../THIRD_PARTY_NOTICES.md)). A transcoded page keeps its file's top-row-first orientation (`flipY` false),
so the sprite's texture coordinates follow each texture's `flipY`.

Selection considers device pixel ratio and what remains of the asset transfer and atlas page
texture budgets, measured as this device loads the pages (`materialPageCost`): a compressed page
costs its KTX2 bytes to fetch and 16 bytes per 4×4 block to upload, the size of every format UASTC
transcodes to; a PNG page costs its PNG bytes and RGBA8. `atlasTextureBytes` counts the bytes each
page actually uploaded, so a phone or desktop page costs a quarter of its PNG fallback. A smaller
rendition preserves the same logical frame size, anchor and world footprint. The renderer honours
the albedo's declared colour encoding on either path; channels it cannot shade remain available
through the shared adapter data and do not prevent drawing albedo. The existing text fallback and
reduced-motion policy apply to material-enabled assets too.

`tests/visual/golden-states.journey.browser.test.mjs` proves the selection on both backends under
SwiftShader, which samples BC, ETC2 and ASTC. Each device profile hides formats from the page's
WebGPU adapter and device and from WebGL2 before the renderer starts: desktop (BC only) uploads
BC7, phone (no BC) ASTC, an ETC2-only phone ETC2, and no compression PNG. Each compressed drawing
matches the PNG drawing (BC7 and ASTC within 2 per channel, ETC2 within 16). A further case
answers the `.ktx2` request with 404 on each backend: the page loads its PNG, the scene draws, and
`materialTextureFallbacks` is 1.

Real phones remain a maintainer step: on a recent Android phone (Chrome) and iPhone (Safari),
open a world with material assets, confirm `metrics.materialTextureFormat` is `astc` (or `etc2`),
the network panel shows `.ktx2` pages and no material `.png`, and the sprites draw the right way
up.

Projected `lighting` carries sun/moon directions and colours, placed light properties, weather
intensity and a grading key. Renderer implementations consume supported parameters from this
committed data. Legacy projections without lighting retain their existing environment policy.

## Isometric rules (§9.2)

- **Camera.** The camera is fixed at 2:1 isometric, with east running down-right and north running
  up-right. The scale is 12.5 px per metre, which is the issue 813 golden's 80 mm per pixel, so reviewed
  sprites draw 1:1. Frame units become metres by unit name (metre, millimetre); an unknown unit counts
  as metres. On each scope's first snapshot the camera is centred on the projected entities. Panning
  (by drag) is bounded to 160 px beyond them, and never less than the view at the smallest zoom. Zoom
  (by wheel) is clamped to `scene.camera.minZoom`–`maxZoom` from the browser shell presentation.
  Omitted camera input retains 0.75–2. Limits must be finite, positive and include initial zoom 1;
  the pan bounds include the view at the configured minimum zoom. There is no rotation.
  For a deep-zoom composition, `{ "minZoom": 0.1, "maxZoom": 24 }` spans an overview and a
  close-up: a 0.5 m vertical content mesh occupies 150 of the 400 logical view pixels at 24×
  (0.5 × 12.5 × 24), exceeding issue #184’s one-third-height target at 640×400.
  The fixture allows up to 96×: its 390×844 portrait view has logical height about 1385,
  requiring about 74× for that same half-metre subject to occupy one third of the viewport. Zoom changes the
  orthographic projection continuously; geometry stays at its native rendering resolution.
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
  pile up. The text path lists every label. The pill and label text draw on their own layer: the
  low tier, whose scene pass is a quarter of the canvas, draws that layer in a separate pass at the
  canvas's full resolution and composites it over the scene, so the text stays legible at every
  tier. The medium and high tiers draw it in their full-resolution scene pass.
- **Selection.** The renderer draws it from projection data, never into art (decisions, in
  `SELECTION` and the token constants of `renderer.ts`): a 2:1 ellipse at the feet (32x16, 3 px
  stroke, 0.18 fill) with two wider glow ellipses (40x20 with a 6 px stroke at alpha 0.35, 48x24 with a
  10 px stroke at alpha 0.15), all in the `--cg-v1-primary` token; and a pill with fully round ends
  filled with `--cg-v1-panel` (`rgb(30 33 22 / 92%)`, so alpha 0.92) and a 1 px `--cg-v1-primary`
  hairline at alpha 0.6, holding the name in 13 px `--cg-v1-text` with 10 px side and 4 px top and
  bottom padding, its bottom edge 6 px above the sprite's anchor height. The ring and pill are built
  once per selected entity, label and sprite height, and later draws only move them. Hover (24x12) and
  focus (40x20) are 1 px ellipses and the hover label is plain text without a pill, so both stay
  lighter than selection.

## Materials, lighting and quality

`WorldSceneAdapter` remains renderer-neutral: no Three.js types enter the presentation or projection
contract. The product uses `WebGPURenderer` (`three/webgpu`) and an orthographic 3D scene. It selects
WebGPU where available and automatically falls back to WebGL2. Materials are node materials and
post-processing uses TSL (`three/tsl`) so both backends compile the same shader graphs; raw GLSL
`ShaderMaterial` and `onBeforeCompile` patches are excluded. Projected atlas entries remain quads. Optional world content can supply skinned meshes and mapped
geometry through the separate renderer contract below, sharing the same materials, lights and post pass.

Atlas material channels belong to the presentation contract. Until issue 66 supplies normal, height,
emissive, roughness/wetness and wind maps, the current reviewed atlas binding is flat albedo.
Missing channels use neutral defaults, rather than extracting a normal, height, emissive mask or
light source from the art's brightness. Light activation and poses come from projection effects;
clock/weather patches change the light rig without changing world state or rereading art. World-supplied
content brings its own maps through the renderer extension; it does not extend atlas bindings or decide
issue 66's material model.

The live canvas follows its host CSS viewport and requests its device pixel ratio. A ResizeObserver
updates backing storage after layout changes, and the frame loop detects DPR changes. Each tier
caps output pixels by uniformly reducing the effective scale: low 512,000, medium 1,000,000,
high 3,000,000 pixels (issue #184 policy). Width and height round down to whole pixels,
with per-axis minima of 2/32/16 for low/medium/high so every scene and bloom mip target stays valid.
The logical camera contains the original 640×400 view at every host aspect: width is
`max(640, 400 × aspect)` and height is `max(400, 640 / aspect)`. This keeps the fixed
isometric camera's proportions and original world framing. Picking, panning and rain use those same coordinates;
resizing preserves zoom and camera position within the updated pan bounds.
The shell reserves the viewport height minus 260 CSS pixels for the HUD, status and heading, with a 400-pixel minimum;
external compositions own their host size. Auto-height hosts retain a stable initial 400-pixel height.
Texture allocation ceilings are 16/64/192 MiB for low/medium/high, apart from the separate atlas budget.
Resource textures reserve their measured bytes before render-target sizing, so adding content can
reduce effective output scale. Content whose resources leave no room for even the smallest output
is retired as a content-contract failure; the built-in scene and text path remain available.
Host sizing uses the content box, excluding padding, including for auto-height compositions.
These are bounded allocation decisions, not hardware performance claims. Quality selection is conservative: software renderers
(SwiftShader/llvmpipe), missing floating-point color targets, maximum texture size below 4096,
or device memory below 4 GiB choose low. WebGPU software detection reads the device adapter
architecture/description; WebGL2 uses its debug renderer identity. Otherwise memory below 8 GiB
chooses medium and the remaining capable devices choose high. These thresholds are local decisions to bound target
allocation and shader work, rather than measured device-class performance promises.

| Tier | Scene target / lighting | Rain particle cap | Bloom | Wind | Puddle reflections |
| --- | --- | ---: | --- | --- | --- |
| low | half output size, Lambert diffuse | 0 | off | off | off |
| medium | output size, Standard PBR | 64 | half-size targets, strength 0.08 | on | off |
| high | output size, Standard PBR | 192 | full-size targets, strength 0.12 | on | stencil-masked mirrored sprite geometry |

All tiers retain projection-driven lights, emissive, lit geometry and fog. Low uses Lambert node
materials to avoid Standard's GGX/Fresnel specular work, and a half-resolution TSL scene pass to
shade 75% fewer scene fragments on software/limited devices. This is a local budget policy, not a
change to the logical camera, picking coordinates or text path. Labels use the effective full output resolution. Medium and
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

## World scene content v1

[`RendererContent`](../src/renderer-content.ts) is a separate, versioned renderer contract, outside
world presentation v1. Supply an optional fifth argument to `new ThreeWorldSceneAdapter(parent,
ready, unavailable, report, content)`. Omit it for the existing rendering path, including its existing
sprite ordering. Packs do not declare models; the platform never discovers content from pack data.
A composition root explicitly imports trusted world code. This is a visual extension, not a sandbox
for hostile JavaScript.

`content.version` is exactly `1`. After backend initialization, the renderer calls `create(context)`;
it may return a promise. The result owns a `THREE.Group` named `root`, an `update(frame)` function,
and an optional `dispose()` callback. Loading does not block the projected scene. The renderer owns
attachment, rendering and retirement of the root. A rejected load removes only content, leaving the
canvas, committed projection and shell working.

The context supplies these values:

| Value | Meaning |
| --- | --- |
| `THREE`, `TSL` | Curated constructors, constants and node helpers from the renderer's pinned Three.js installation. The same module also statically exports the full `THREE` and `TSL` namespaces for additional named use. |
| `backend` | The selected `webgpu` or `webgl2` backend, after initialization. |
| `signal` | Aborted on content failure or adapter destruction; use it to retire asynchronous work. |
| `place(object, { x, y, elevation? })` | Set a content anchor in the projection frame's metres; elevation defaults to zero. |
| `loaders({ basis, draco })` | Asynchronously construct a GLTF loader with Meshopt and Draco decoding and the renderer's shared KTX2 loader, detected against the initialized renderer/backend. `draco` is an explicit URL for matching pinned decoder files; KTX2 uses the transcoder built into the app, so `basis` is not read. |

Import additional library types and values from `renderer-content.ts`, never another installed copy
of Three. A world using this seam accepts coupling to Three **0.187.0** and the renderer contract of
the exact Clockgrove commit it pins. Updating that pin requires rechecking its content. Neither
React nor Three types enter world presentation v1 or the durable projection protocol.

Meshes must use `MeshStandardNodeMaterial` or `MeshLambertNodeMaterial`, with depth testing and
writing, fog and tone mapping enabled. Geometry can be skinned, textured or driven by TSL; a sprite
is a textured mesh, not `THREE.Sprite`. The root may contain groups, ordinary object transforms and
bones. Geometry deformation through `positionNode` is supported. Lights, cameras, scenes, render
hooks and material overrides of the full vertex stage (`vertexNode`), lights, final fragment/output
or backdrop nodes are rejected. The extension receives no renderer, scene, camera, lights,
post-processing, projection, selection or command handles. It cannot replace or retune the product
look. Quality selection converts supported lit materials between Standard and Lambert; world
updates adapt detail to the selected tier rather than choosing another light rig or post pass.
The configured GLTF loader converts decoded materials to lit node materials before attachment.

`place` uses the existing fixed camera: scene X is `(x + y) * 12.5`, scene Y is
`-(x - y) * 6.25 + elevation * 12.5`, and depth is `(x - y) * 0.01 + elevation * 0.005`.
It sets local scale to `(12.5, 12.5, 0.01)`. Local content geometry therefore uses screen-aligned
metres, Y upward and shallow local Z depth; rotate model geometry within an anchor group when
needed. Local Y zero is the feet/ground anchor, not a separate physical ground simulation.
With content attached, projected bodies write anchor depth too, so opaque and alpha-tested
content interleaves with projected sprites through the same depth buffer. Normal maps affect the
shared lighting; a TSL `depthNode` can apply a world-supplied per-fragment depth map. Content is
absent from `pickOrder`, pointer candidates, selection and keyboard navigation.

Each update receives a fresh read-only frame value: `backend`, `qualityTier`, `reducedMotion`,
`simulationTime` (bigint), copied `weather` and `timeMs`. The latter is absolute visual milliseconds,
**zero** under reduced motion, matching atlas frame zero. Set animation mixers from that absolute
time instead of accumulating independent deltas. Clock and weather remain renderer inputs read
from the loaded committed projection; content cannot mutate them. The renderer's frame cadence,
p95 sampling and automatic tier downgrade include content work, including under reduced motion. `metrics.contentUpdateMs` records
update cost, while `textureBytes` includes content textures alongside render targets; atlas pages count
in `atlasTextureBytes`.

Stable failures are `content_load`, `content_contract`, `content_update` and `content_draw`.
`metrics.contentStatus` is `none`, `loading`, `ready` or `failed`; `contentFailure`,
`contentFailures` and `contentObjects` identify the bounded lifecycle outcome. The `renderer_content`
measurement reports `ready` or the stable failure category, never exception text. On failure the
renderer detaches content, retires its resources and draws the remaining scene again. On destruction,
late async completion is retired too. The renderer disposes root geometries, materials, textures,
skeletons and configured decoder workers; `dispose()` is for other world-owned external resources.
Register textures created inside deferred shader callbacks in the instance’s optional `textures` array;
these cannot be discovered from the persistent material graph. The renderer also accounts for and
disposes these registered textures. Do not share disposable resources with another renderer instance.

The generated [fixture content](../../../worlds/fixture/renderer/content.ts) supplies a looping
skinned model and a sprite with normal and depth maps. Its [standalone page](../../../worlds/fixture/renderer/index.html)
loads a [committed snapshot](../../../worlds/fixture/renderer/snapshot.json) and offers time, rain,
motion and tier controls without a world session. The existing
[renderer browser journey](../../../tests/ci/renderer-bakeoff.journey.browser.test.mjs) proves the seam
under both software backends. Software rendering establishes correctness, not physical GPU timing.
See [external renderer composition](../../../docs/protocols/world-presentation.md#external-renderer-composition)
for the pinned-checkout recipe and frame capture.

### Content lights and shadows

Content may opt into renderer-owned local lights and scene-light shadows. This is additive to
content v1: omitting the optional fields preserves existing content and capture output. Arbitrary
Three light objects remain invalid in the content root. Light descriptors are presentation data;
the renderer owns the actual lights, tier selection and GPU resource retirement.

| Tier | Active content lights | Directional shadow maps | Map side |
| --- | ---: | ---: | ---: |
| low | 2 | 0 | 0 |
| medium | 4 | 1 | 512 |
| high | 8 | 2 | 1024 |

The instance's optional `lights` array contains `{ position: [x, y, z], colour,
intensity, rangeMetres }` descriptors. Positions are screen-aligned metres relative to the scene
origin, with all three axes scaled by 12.5; unlike `place`, their depth is not compressed.
`colour` is `#rrggbb`, intensity is nonnegative, and range is positive. All numbers must be
finite. Admission uses array order, up to the active tier's cap; extra valid descriptors remain
inactive. At most 64 descriptors are accepted. Absolute position components and intensity are
bounded by 1,000,000, and range by 100,000 metres. These defensive #184 presentation limits
bound validation work and avoid overflow; invalid values fail the content contract.
Descriptors can change during `update`; the renderer revalidates them before rendering.

The instance's optional `shadows: true` enables content mesh `castShadow` and `receiveShadow`
flags and ground shadow reception. Meshes choose their flags individually; the renderer bounds
scene directional shadow maps by tier. Omission or `false` disables participation. Point lights
from descriptors illuminate surfaces but do not allocate point-light shadow cube maps.
The standalone fixture opts in with `?lighting`.

These are explicit #184 visual policy decisions to bound per-fragment light work and shadow
allocation. The lower tier retains local illumination with shadow passes disabled. Existing
projection lights continue to follow committed time-of-day data. Content illumination reaches
other lit content and the ground; shadow participation is opt-in and uses scene directional
lights. Content does not choose another camera or replace the scene light rig.

Shadow storage conservatively reserves 12 bytes per map pixel before choosing viewport dimensions
and counts in `textureBytes`: 3,145,728 bytes at medium and 25,165,824 at high when both scene
directional sources are present. `metrics.contentLights`, `shadowMaps` and `shadowTextureBytes`
report active admission and reserved storage. Shadow coverage follows the fixed camera and zoom
using the visible rectangle’s diagonal radius and 128 logical pixels of caster margin. The light
target sits at depth -50 between content and ground (-100); the source distance is the larger of
1000 or coverage radius plus 128, with near 0.1 and far distance plus radius plus 128. Bias is -0.0001.
These are explicit renderer presentation choices for #184, bounding coverage while limiting acne.
Tier changes, content failure and destruction retire unused light and shadow resources. The
existing frame-cadence downgrade includes the cost of content lights and shadows. Software
backend fixtures establish correctness and bounded allocation; physical phone timing remains
part of #184's final qualification.

## Budgets (§9.3)

[`scene-budgets.json`](../scene-budgets.json) records each limit with its source or decision.

| Budget | Limit | Checked by |
| --- | --- | --- |
| Initial JS (gzip, every built chunk: entry plus scene chunk) | 512 000 B | `tools/scene-budget.mjs` in `pnpm check` |
| Reviewed asset bytes | 256 KiB | `tools/scene-budget.mjs` in `pnpm check` |
| Texture memory, apart from atlas pages | 16/64/192 MiB low/medium/high | Chromium journeys |
| Atlas page texture memory | 32 MiB | Chromium journeys |
| First scene render | 2 500 ms | Chromium journey |
| Frame time, 95th percentile | 33.4 ms | Chromium journey |
| Entity count | 256 | Chromium journey |
| Patch application | 8 ms | Chromium journey |
| Reconnect, from observed drop to ready | 3 000 ms | Chromium journey |

The Chromium journey (`tests/e2e/living-hall.journey.browser.test.mjs`) measures the runtime budgets on the golden yard
with rain and puddles showing, from the adapter's `metrics`. The settled cadence window starts after the
additional viewer's first render, so its initial shader compilation is accounted for by the separate
first-render budget. These are local checks on the CI runner. They are
not a measurement on the supported laptop baseline. The golden yard has one atlas page, so the
multi-page world in `tests/ci/dev-world.journey.browser.test.mjs` also measures both texture budgets,
under WebGPU and forced WebGL2: its four pages (17 040 000 B) must all be counted in
`atlasTextureBytes`.

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
RGBA16F/depth-stencil target, the tier-scaled scene pass, the low tier's full-resolution RGBA16F
label target, the scaled bright target and both five-level bloom chains (Three r187 allocation
layout), plus generated UI and content textures, in `textureBytes`. `atlasTextureBytes` is the
decoded size of every atlas page Texture: each page the index lists and each selected material page.
WebGPU device loss follows the same text fallback as WebGL context loss.
After renderer or asset failure, **Retry canvas** creates a fresh renderer and loads
the latest retained reducer projection. The text scene remains available throughout;
retrying does not reconnect the observation or issue a world command. A retry that presents
returns the boot to `scene_ready`; one that fails leaves it at `text_ready`.

The right rail shows a cognitive actor's private conversation as chat bubbles under its portrait,
a Talk / Observe / Remember / Why? grid drawn only from the actions the interaction card reports,
and a message box. Below 1200 px the rail is the bottom sheet; it works without the canvas.

Atlas animation uses per-mesh UVs on one shared Texture per atlas page; each animation's frames index
the page it was loaded from, one rectangle per frame. A frame that names another page's `atlasId`
indexes that page instead (a strip continued onto further pages), and showing it swaps the mesh's
map, and its reflection's, to that page. A frame naming a page the index does not list makes the
renderer unavailable, as a page that does not load does. Three r187's WebGPURenderer allocates
GPU storage per Texture identity on both backends, so cloning textures that share an image would
duplicate atlas storage. Reflections borrow their source texture and copy animated frame UVs; they
dispose their own geometry/material without disposing the borrowed texture. Texture accounting counts
unique material-map Texture identities across the whole scene, including effects, reflections and
generated labels, plus the conservative render-target allocations above; each atlas page counts
once, in `atlasTextureBytes`.

The Recorded Why panel's **Inspect command** action requests the existing operator
causal-chain read under `runtime:world-inspect`. Observation alone shows an explicit
inspection denial. An authorized response displays the recorded command receipt
identity and status; public Why remains available under `runtime:world-observe`.
Closing or changing the panel cancels pending inspection work.

The viewport browser proof in `tests/visual/golden-states.journey.browser.test.mjs` exercises
960×540 DPR 1 and 390×844 DPR 3 profiles on both backends, each tier and live resize.
It asserts backing/scene dimensions and accounted texture allocation. Phone emulation establishes
correctness of the lower tier; recent-phone hardware cadence and GPU-complete timing still need
maintainer qualification. Changed visual digests require the existing capture review workflow.

### Continuous projected environment

`SceneLighting.environment` optionally supplies `daylight` (0–1), ambient colour and intensity,
background/fog colours and an RGB grade multiplier. The renderer consumes these values on every
projection, including under reduced motion, and multiplies scene colour before compositing the
low-tier full-resolution labels. Changing tier retains the current grade. Omission preserves the
legacy 06:00–18:00 binary environment and white grade. Sun/moon directions and all intensities
remain renderer-neutral projection data; `gradingKey` labels the phase rather than selecting a
renderer-local preset.

The shared `defaultSceneLighting` presentation policy uses canonical simulation milliseconds on a
24-hour periodic cycle. Decision for #184: smoothstep over solar elevation ±15° gives two-hour
dawn/dusk transitions centred on 06:00/18:00, with warm sunlight and grading at the horizon.
Midnight/noon retain the existing ambient and directional intensity endpoints; lamps fade with
inverse daylight. RGB colours are rounded to 8-bit channels, while intensities vary continuously.
Lantern/window effect opacity follows daylight; puddles retain their rain policy. This adds only
bounded scalar work per projection, no targets, textures or wall-clock animation. Worlds can
project a different rig/environment without changing the renderer. The offline renderer fixture
uses the same policy and offers a continuous time slider. Final golden approval and physical
phone performance qualification remain separate from this backend correctness proof.

Issue #184 part 4 adds bounded content lights and opt-in scene shadows, accounted within tier
texture ceilings and the existing frame-cadence downgrade. Part 5 must measure the completed renderer on desktop and
recent-phone hardware, including a working lower phone tier; allocation bounds and
software-rendered frame cadence do not establish that hardware requirement. Part 5 must also
re-capture the golden states at full viewport resolution and obtain review through the existing
capture approval workflow before updating `tests/visual/approved-captures.json`. Periodic image
equality proves determinism, not reviewed visual approval. These acceptance entries remain open.
