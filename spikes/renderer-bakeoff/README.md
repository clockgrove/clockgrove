# Renderer bake-off (spike)

Issue 67's throwaway spike. It draws the same lit yard slice in Phaser 4 and in Three.js, each behind
the product's `WorldSceneAdapter` ([`apps/web/src/world-scene-adapter.ts`](../../apps/web/src/world-scene-adapter.ts)),
and measures each one. It is not the product path. Nothing in `apps/web` imports it, and production
rendering does not change. The decision record is the draft
[renderer bake-off ADR](../../docs/adr/clockgrove-adr-renderer-bake-off.md). A later Objective
integrates the winner.

## What is drawn

Every candidate reads the same inputs, in `src/inputs/`:

- `scene.ts` holds the committed projection: Stevie, a lantern post and a shrub in front of the house wall, a
  lantern and a window light, and two puddles. The snapshot is dusk in rain (18:15), just after the product's
  18:00 night rule lights the lantern and the window, as the reference mockup shows them at dusk; the sky
  stays a dusk sky until 20:00. The `TO_NIGHT` patch (22:00, lighter rain) arrives through `applyPatch`. The file also holds the shared light rig, the camera path and `isoProject`, which is the camera
  every candidate reproduces.
- `materials.ts` holds synthetic placeholder maps for every asset: albedo, normal (derived from height),
  height, emissive, roughness/wetness and wind. They are generated deterministically in code, so no image
  files are committed. Real maps from the material-model Objective (issue 66) replace them later.

Candidates are in `src/candidates/`. `phaser.ts` is Phaser 4 lighting with normal maps, plus custom shaders
and filters for the rest. `three.ts` is lit quads in an orthographic 3D scene; `three-webgl2.ts` runs it
on `WebGLRenderer`, and `three-webgpu.ts` runs it on `WebGPURenderer`, which falls back to WebGL2 where
WebGPU is missing. Each candidate reports in `describe()` what it actually used.

## Quality tiers and the sequence

`TIER_FEATURES` in `src/contract.ts` defines the tiers. **low** has lighting, normal maps and fog.
**medium** adds emissive, wetness, wind, 400 rain streaks and half-strength bloom (half of full's
strength at full resolution and the same threshold, `BLOOM_SCALE` and `BLOOM_THRESHOLD`, in every candidate). **high** adds puddle
reflections, 1,200 rain streaks and full bloom. Rain counts are scaled by the projection's rain
intensity. These are spike decisions, sized so the high tier is visibly heavier.

The page (`src/harness.ts`) draws a 960×540 canvas at device pixel ratio 1. For each candidate it
runs both lighting states and all three tiers. Each run has 10 warm-up frames, then 120 frames timed
from the camera change to GPU completion, stepped along `CAMERA_PATH`, then 30 frames of a continuous
pan (`panFrameMs`, a new camera every frame, so a candidate that re-bakes per camera pays it every
frame), then 30 requestAnimationFrame intervals. GPU completion is `gl.finish()` plus a 1-pixel
`readPixels` on WebGL2 and `queue.onSubmittedWorkDone()` on WebGPU: serialised CPU+GPU latency per
frame, not the frame rate of a pipelined loop. It then takes one screenshot at the fixed screenshot camera and time.
Last, it checks reduced motion: two frames 1 s apart on the page's own clock must be identical with
it on and differ with it off. Candidates never read wall time; every frame is drawn at the page
clock's time, which only the page or a test driving it moves. Query parameters `candidates`, `frames`, `warmup`, `panFrames` and `rafFrames` shorten a run.

## Measuring

```sh
pnpm --filter @clockgrove/renderer-bakeoff build      # dist/: page, one classic-script bundle each
node spikes/renderer-bakeoff/scripts/measure.mjs --browser <chromium-family exe> \
  [--browser-arg=<flag>]... --out <dir> --label "<host description>"
```

The script serves `dist/` on a loopback port, starts the browser headless on the page with a real
clock, and receives the JSON record by POST. It writes:

- `results.json`, with every number beside its host, browser user agent and renderer string;
- one PNG per candidate, state and tier;
- `report.html`, which puts the high-tier screenshots beside the
  [reference mockup](../../docs/design/reference/raccoon-world-reference.png).

A browser that cannot start fails the script with its own error (the spawn error or its stderr). On a
Linux host that forbids unprivileged user namespaces, add `--browser-arg=--no-sandbox`. The script also
exports `measure({ out, launch, … })`, whose `launch(url)` opens the page. The CI journey passes one
that opens it in the repository's pinned Playwright Chromium (`scripts/ci/toolchain.sh browser`),
launched by `chromium.launch` as the other browser journeys launch it. It also records bundle sizes (bytes and gzip, from `dist/bundles.json`) and each adapter's code lines.
A run whose renderer string names SwiftShader, llvmpipe or another software rasteriser is marked
`performance: false`. Such numbers prove correctness only and are never reported as performance.

The page also runs from a `file://` URL and writes the same record into
`<script id="bakeoff-result">`. To extract it from a dumped DOM, run
`measure.mjs --from-dom <dump.html> --out <dir>`. Under `--virtual-time-budget`, the clock is virtual
(synchronous frames time as zero while timers move it on), so a dumped DOM's numbers are never marked
performance, and the page also flags any zero-duration frame as a suspect clock. Take performance numbers
from the served page.

### Maintainer GPU step (outside the sandbox)

These steps run on the owner's machine. The results are posted on issue 67 and are not committed.

- **WebGL2 in WSL2 Chromium:** run
  `GALLIUM_DRIVER=d3d12 LD_LIBRARY_PATH=/usr/lib/wsl/lib node spikes/renderer-bakeoff/scripts/measure.mjs --browser <chromium> --browser-arg=--use-gl=angle --browser-arg=--use-angle=gl --browser-arg=--ignore-gpu-blocklist --out <dir> --label "RTX 2060 SUPER, WSL2"`.
  The renderer string must read `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060 SUPER), …)`.
- **WebGPU and WebGL2 in Windows Edge:** copy `dist/` to a Windows path. For frame times, point `--browser` at
  `msedge.exe` with `--browser-arg=--enable-unsafe-webgpu` and a Windows `--browser-arg=--user-data-dir=C:\…`
  (WSL2 forwards Windows `localhost` to the script's server). The `file://` route,
  `msedge.exe --headless=new --enable-unsafe-webgpu --virtual-time-budget=<ms> --dump-dom "file:///C:/…/index.html" > dump.html`
  and then `measure.mjs --from-dom dump.html`, gives the adapter info, screenshots and correctness only: its
  virtual clock makes the frame times not performance.
- The phone and the integrated GPU stay listed as missing in `results.json` until someone measures them on real
  devices.

## Checks

`pnpm check` type-checks and builds the spike. `tests/ci/renderer-bakeoff.journey.browser.test.mjs`
runs in CI's browser share under SwiftShader and asserts only what is deterministic there: every
candidate builds and renders the fixed slice, the record has the declared shape (timings and renderer
strings are recorded, not asserted), screenshots are non-empty 960×540 PNGs, and reduced motion holds.
For the last, it opens `index.html?drive=1` from `file://`. In that mode the page runs no sequence and
exposes `window.bakeoffDrive` (`open`, `setReducedMotion`, and `frameAt` and `step`, which return
the frame's capture), so the test steps the page clock by a fixed amount and compares two captures: identical with
reduced motion on, different with it off. It also checks the dumped-DOM path from `file://`.

## 3D Stevie (issue 77)

A second page, `stevie.html` (bundle `stevie`, `src/stevie/`), draws Stevie three ways in this same lit slice through
the WebGL2 Three.js adapter. Each arm adds its characters through `createThreeAdapter`'s optional `ThreeExtras`
hook, so every arm shares one light rig, one fog, one bloom and output pass, and one camera. The draft decision record is the
[character rendering ADR](../../docs/adr/clockgrove-adr-character-rendering-3d-vs-2d.md).

- **3d** (`model.ts`): a rigged Stevie playing `idle` and `walk` clips, with `MeshToonMaterial` (a three-step ramp)
  and an inverted-hull outline. CI renders the **procedural stand-in**: 18 joints, two-bone skin weights and
  texture-only fur. Each generated model kept in `media/` (below) adds the arms `3d:<model>` and
  `3d-sprites:<model>`. A model rigged by its provider keeps its own skeleton and clips (`/idle/`, `/walk/`, or a
  separate walk file). A model marked `fit` gets the stand-in's skeleton and clips fitted to its mesh by `fit.ts`.
- **2d** (`sheet.ts`): frames cropped from
  [`stevie-sprite-sheet.png`](../../docs/design/reference/stevie-sprite-sheet.png). The grid is 8 columns of 192×230 cells,
  with the frame label removed:
  - idle is frames 0–5, walk right is 6–13 and walk left is 14–21;
  - alpha is keyed from each cell's corner colour;
  - the normal map is the Sobel gradient of a blurred-alpha dome mixed with luminance;
  - the edge is a 1-pixel dark line.
- **3d-sprites** (`bake.ts`): the 3d arm's model and clips, rendered offline from the scene camera's direction into
  192 px cells (0.9 m). Each cell has albedo, view-space normal and depth. The frames are placed as camera-facing toon quads with the exact normal map.

Shots, at the high tier in both lighting states:

- five headings (`three-quarter`, `right`, `back`, `left`, `front`) under the one fixed camera;
- an 8-frame walk and a 4-frame idle;
- a cohesion shot of Stevie, Juniper (a tint) and a kit (0.6 scale) on the lit path.

Close shots are 360×360 crops around Stevie. The cohesion shot is the full 960×540 canvas.

```sh
node spikes/renderer-bakeoff/scripts/build.mjs
node spikes/renderer-bakeoff/scripts/stevie.mjs --browser <chromium-family exe> [--browser-arg=<flag>]... \
  --out <dir outside git> --label "<host description>"
```

`stevie.mjs` serves the page, the identity sheet (`/sheet.png`) and anything in the git-ignored `media/`
(`/media/<name>`). It writes these files into `--out`:

- every shot as a PNG;
- the sprite and sheet atlases;
- `results.json`, with the model metrics, the preparation step times, frame times, the renderer string, and the
  sha256 of every input, output and generated file, joined to `media/provenance.json`;
- `report.html`, which shows each arm beside the reference mockup.

A software renderer's times are marked `performance: false`. No media is committed.

### Generating the models

`scripts/generate.mjs` runs the owner's chosen route, and every output lands in the git-ignored `media/`. Keys come
from the environment and are never printed. Each call reserves its cost against the $10 cap before it runs, and is
refused past the cap. `media/provenance.json` records every call (provider, model, endpoint, parameters, cost and
how it was measured, minutes) and every file's sha256.

```sh
node scripts/generate.mjs turnaround                 # GPT-image edit via AI Gateway (AI_GATEWAY_API_KEY): media/turnaround*.png
node scripts/generate.mjs fal three-quarter-1536     # TRELLIS.2 on fal (FAL_KEY); also `multi`, `three-quarter`
node scripts/generate.mjs meshy                      # Meshy multi-image-to-3D, then Meshy rigging (MESHY_API_KEY)
node scripts/generate.mjs keep <name> <provider|fit> <glb> [walk=<glb>] <why…>   # a model for the report
```

The turnaround is cropped into four views from its 2×2 grid by `png.mjs`. Both 3D routes start from those views.
`stevie.mjs` renders every kept model and shows the turnaround beside the identity sheet. The results, the
costs and the likeness findings are in the ADR.

### Maintainer steps for issue 77 (outside the sandbox)

- **GPU frame times and the screenshots to judge:** run `stevie.mjs` with the GPU flags from the bake-off's
  maintainer step above, with the generated models in `media/`. Post the report's numbers and stills on issue 77
  with the host label. Regenerating `media/` from scratch costs about $1.83 on this route.
- **fal's terms:** re-check TRELLIS.2's terms on fal's model page and record them in `media/provenance.json` before
  relying on the licence. The run could not reach fal's web pages.
- **Assetforge sheet import:** run clockgrove/assetforge's sheet import on the identity sheet. Compare its frames
  with the spike's plain crop (`atlas-sheet-albedo.png` in the output), and post the result.

CI (`tests/ci/stevie-3d.journey.browser.test.mjs`, SwiftShader) checks only that the page builds and renders. Every arm
must render every declared shot in both states, at the declared PNG size, with matching recorded hashes.
