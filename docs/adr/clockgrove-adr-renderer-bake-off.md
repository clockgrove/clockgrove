# ADR: Renderer for Top-Tier Lit 2.5D

**Status:** Accepted  
**Version:** 1.0  
**Date:** November 07, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.10, [raccoon-world-cloudflare-implementation-plan.md](https://github.com/clockgrove/raccoon-world/blob/main/docs/raccoon-world-cloudflare-implementation-plan.md) v3.12 §20, and implementation Wave 4 §9.1
**Scope:** Accepted Three.js WebGPURenderer browser renderer decision with WebGL2 fallback; issue 74 integrates the lit 2.5D yard

---

## Context

Architecture §20.4 pins Phaser 4.2+ with WebGL as the initial renderer. Issue 67 records that Phaser 4 is the initial implementation, not a permanent contract, and that its lighting may cap the look the [reference mockup](https://github.com/clockgrove/raccoon-world/blob/main/docs/design/reference/raccoon-world-reference.png) asks for: painterly storybook realism, dusk in rain and night, lit windows and lanterns, wet ground, fog and soft glow. The owner decided on 2026-11-07 to run a bake-off first and then pick.

The bake-off is the spike in [`spikes/renderer-bakeoff`](../../spikes/renderer-bakeoff/README.md). Every candidate implements the product's `WorldSceneAdapter` (Wave 4 §9.1) for one reference yard slice. Every candidate gets the same committed projection, the same dusk-to-night patch, the same light rig, the same camera and the same synthetic maps: normal, height, emissive, roughness/wetness and wind. The spike left production rendering unchanged; issue 74 carries the selected implementation into the product.

## Candidates and why

| Candidate | Why it is in the bake-off |
| --- | --- |
| **Phaser 4.2.1** (`phaser`) | The incumbent (§20.4), pushed with its normal-map lighting, filters and custom shaders, to find its ceiling. |
| **Three.js 0.187.0, WebGL2** (`three-webgl2`) | Lit quads in an orthographic 3D scene. Physically based materials take normal, roughness and emissive maps natively, fog and bloom are standard, and it is the shortest path to full 3D. |
| **Three.js 0.187.0, WebGPU** (`three-webgpu`) | The same scene code on `WebGPURenderer`, which falls back to WebGL2 when WebGPU is missing. It measures WebGPU without a second engine. |

Not chosen: **PixiJS v8**, whose lighting, like Phaser's, is 2D sprite lighting, so it tests the same ceiling as the incumbent. **A minimal custom WebGPU renderer** has the most code, no WebGL2 fallback, and a WebGPU path that the Three.js WebGPU backend already measures.

## What each candidate can and can't do

The levels below are what each adapter reports in `describe()`. **Native** means the engine does it. **Custom shader** means hand-written GLSL inside the engine. **Approximated** means a workaround with a visible limit. **Missing** means not done.

| Look feature | phaser | three-webgl2 / three-webgpu |
| --- | --- | --- |
| Normal maps | native (2D lighting with the normal map as the texture's data source) | native (`MeshStandardMaterial.normalMap`) |
| Height maps | missing (Phaser's self-shadow reads albedo brightness, not height) | approximated (ground `displacementMap` only; sprites rely on the normal map derived from height) |
| Emissive maps | approximated (an unlit additive layer; Phaser has no emissive channel) | native (`emissiveMap`) |
| Roughness/wetness | approximated (darkening layer plus an additive sheen; the lighting is diffuse only, with no specular) | approximated (wetness baked into a derived roughness map per lighting state; physically based specular) |
| Wind maps | approximated (the shrub cut into 8 strips offset by the wind map) | approximated (CPU vertex sway on a 16×16 grid weighted by the wind map) |
| Lantern and window lights | native (2D point lights; falloff by screen distance, not by 3D position) | native (`PointLight` with physical falloff over 3D positions) |
| Puddle reflections | custom shader (full-canvas GLSL mirrors sprite albedo inside the puddles, lit by distance only) | approximated (stencil-masked mirrored geometry, lit by the same lights; no blur) |
| Fog | custom shader (full-canvas overlay with depth taken from the screen row) | native (`FogExp2` by view depth, per pixel) |
| Rain particles | approximated (a pool of streak images placed as a pure function of time) | approximated (CPU-updated `LineSegments`, unlit) |
| Bloom | native (`Actions.AddEffectBloom` camera filter) | native (`UnrealBloomPass` on WebGL2; `bloom()` in the WebGPU `RenderPipeline`) |

What the table means:

- **Phaser 4** can light normal-mapped sprites and bloom them, and its filters and shader objects can add effects that cover the whole canvas. It can't give specular or roughness response, an emissive channel, light falloff over real 3D positions, or per-object fog depth. Each of these is a separate layer or a screen-space shader, and the spike already carries five of them. That is the ceiling the issue suspected. The spike also warps the ground and the wall into canvas textures for each camera, so a camera change costs Phaser a re-bake and texture upload that Three.js doesn't pay. Every timed frame starts before the camera is set, so the re-bake is measured: in the stepped sequence it lands in two frames of 120 (`frameMs`), and in the continuous pan (`panFrameMs`) it lands in every frame. Compare the pan p50/p95 to see what scrolling costs each candidate.
- **Three.js** gets normal, roughness and emissive maps, physical point lights, per-pixel fog and bloom from the engine. Wetness, wind, rain and reflections are still the spike's own work, as in Phaser, but they sit on a physically based base. The WebGPU entry runs the same scene code. Its post-processing is node-based (TSL) rather than `EffectComposer`, so the post stack is written twice.

## Measurements

The measurement page and script are described in the spike's [README](../../spikes/renderer-bakeoff/README.md#measuring). Every record carries its host, browser user agent and renderer string. A software rasteriser (SwiftShader, llvmpipe) is marked `performance: false` and is never reported as performance.

Each frame is timed from the camera change to GPU completion. Completion is `gl.finish()` plus a 1-pixel `readPixels` on WebGL2 (phaser, three-webgl2 and three-webgpu's WebGL2 fallback) and `queue.onSubmittedWorkDone()` on WebGPU. The fences differ in cost, so a WebGPU number and a WebGL2 number differ by that sync as well as by the API. Every number is serialised CPU+GPU latency per frame, not the frame rate a pipelined loop reaches. Frame times come only from the served page: a dumped DOM (`--virtual-time-budget`) runs on a virtual clock, so its numbers are never marked as performance.

The tiers do the same work in every candidate. `half` bloom is half of the full strength, at full resolution and the same threshold (`BLOOM_SCALE`, `BLOOM_THRESHOLD`). The dusk-in-rain state is 18:15, after the product's 18:00 night rule lights the lantern and the window, as in the mockup's dusk. The sky stays a dusk sky until 20:00.

Bundle sizes and code lines come from `node spikes/renderer-bakeoff/scripts/build.mjs` (Vite 8.3.4) at this record's commit. They depend on no host.

| Measure | phaser | three-webgl2 | three-webgpu |
| --- | --- | --- | --- |
| Bundle (minified, gzip level 9), including the shared inputs | 1,415,827 B (367,900 B gzip) | 797,225 B (201,792 B gzip) | 1,152,627 B (313,009 B gzip) |
| Adapter code lines (non-blank, non-comment) | 824 | 639 shared + 45 entry | 639 shared + 32 entry |
| Frame time, RTX 2060 SUPER, WSL2 Chromium (ANGLE GL over D3D12) | shader compilation fails | static and pan about 1.4 ms at low; suspect-clock flag from failed peers | unavailable WebGPU; fallback crashes |
| Camera pan p50/p95, RTX 2060 SUPER, Windows Edge, low → high | 10.1/15.9 → 14.8/18.6 ms (night low 17.1/24.6 ms) | 0.5/0.7 → 1.8/2.0 ms | 3.4/4.1 → 5.0/7.1 ms (WebGPU) |
| Frame time p50/p95, integrated GPU | missing: needs a real device | missing | missing |
| Frame time p50/p95, phone | missing: needs a real device | missing | missing |
| GPU memory | estimate in `results.json`: texture uploads, the canvas's colour and depth/stencil, and bloom targets while bloom is on (browsers expose no GPU memory API) | same items | same items |
| WebGL2 | yes | yes | fallback backend |
| WebGPU | no | no | yes, where the browser offers it |

The [maintainer measurements on issue 67](https://github.com/clockgrove/clockgrove/issues/67#issuecomment-6716384072) were taken on 2026-11-07 at 960×540, DPR 1, with an NVIDIA GeForce RTX 2060 SUPER (8 GB), Windows 11 Edge on ANGLE D3D11 and WSL2 Chromium on ANGLE GL over D3D12. They use 10 warm-up and 120 measured frames. The Windows Three.js WebGL2 static high-tier p50/p95 was also 1.8/2.0 ms. These are spike baselines, not product-adapter measurements. The owner observed white bloom blowout in the Three.js lantern/window and required tuning during integration.

The GPU memory figures count the same items, and the texture and canvas bytes compare directly. The bloom share is each candidate's own estimate of its engine's internal targets, three RGBA8 full-canvas targets for Phaser and a half-float mip chain for three, so the totals compare only roughly.

Every candidate implements the three quality tiers of `TIER_FEATURES` and freezes rain, wind and flicker under reduced motion. The CI journey checks reduced motion on every candidate by stepping the page clock itself.

On three's WebGL2 fallback, a `PassNode` target needs its stencil buffer requested at construction (`pass(scene, camera, { stencilBuffer: true })`). Setting it afterwards left an incomplete framebuffer that drew nothing under SwiftShader in CI. Its `PassNode` also re-renders the scene only once per node frame, which three advances on its own requestAnimationFrame tick. Frames drawn back to back at explicit times, as the harness and any fixed-step product loop draw them, must advance it themselves (the spike calls `nodeFrame.update()`), or they show and time a stale pass.

## Path to full 3D

- **Phaser 4** is a 2D engine. Its lights are 2D point lights over normal-mapped sprites, and depth is a sort key. Moving to full 3D means a second renderer, so the 2.5D work would not carry over beyond the adapter boundary.
- **Three.js** already draws the 2.5D slice as upright lit quads in a real 3D scene, with an orthographic camera that reproduces `isoProject`. Full 3D is the same scene graph with meshes in place of quads and a perspective or free camera: the lights, materials, fog, post-processing and adapter stay. This matches the 3D frame placement the existing headless 3D adapter already proves (`apps/web/test/headless-3d-adapter.ts`).
- **Three.js WebGPU** follows the same path, and its node materials (TSL) are where three's new rendering features land.

## Decision

**Three.js `WebGPURenderer` with automatic WebGL2 fallback**, as [decided by Kirk on 2026-11-08](https://github.com/clockgrove/clockgrove/issues/74#issuecomment-6718736583), updating the [2026-11-07 WebGL2 selection](https://github.com/clockgrove/clockgrove/issues/67#issuecomment-6716391037). WebGL2 remains the compatibility floor. Use `three/webgpu` for lit quads in an orthographic 3D scene behind the existing renderer-neutral `WorldSceneAdapter`. Materials and post-processing use TSL (`three/tsl`) and node materials so the same shader graphs compile for both backends. Raw GLSL `ShaderMaterial` and `onBeforeCompile` patches are excluded. This supersedes the Phaser renderer choice in architecture §20 and the PRD rendering rows. Issue 74 integrates the decision into the live yard.

The WebGL2 camera-pan measurements, smaller bundle, faster initialization and working WSL GL path support the compatibility floor; they do not measure the integrated WebGPURenderer. Preserve semantic poses, selection intents, projection-only input and the headless 3D conformance path. Tune bloom and grading so warm lantern/window sources retain color instead of blowing out to white.

CI runs both WebGPU and forced WebGL2 backends under SwiftShader for correctness and records the backend and adapter of each check, following the [maintainer automation findings](https://github.com/clockgrove/clockgrove/issues/74#issuecomment-6718905798). The spike's fallback crash must be addressed by integration rather than excluded from scope. Headless WebGPU uses the explicitly enabled SwiftShader Vulkan adapter; correctness asserts its architecture and rendered pixels, never timing. Backend-specific paths must be guarded by backend detection. Real-GPU WebGPU, ANGLE D3D11 and ANGLE GL over D3D12 validation remain explicit maintainer checks, as do product GPU-complete timings on the owner's reference box after merge.

## Consequences

- Three.js WebGPURenderer replaces Phaser in the product path; the bake-off may retain Phaser as a reference. WebGPU is preferred when available, WebGL2 is automatic fallback, and renderer initialization failure or context loss uses the accessible text scene.
- Materials and lighting come from the presentation contract and committed projection. Until issue 66 lands, current bindings use a flat-albedo fallback, without deriving lighting from painted highlights.
- Quality tiers and reduced motion remain renderer policy. Golden comparisons at every tier qualify bloom and grading; synthetic-map spike captures do not qualify the product look.
- Phone and integrated-GPU numbers stay missing until someone measures them on real devices; the report lists them.
- The material-model Objective (issue 66) replaces the synthetic maps. The adapter inputs here (`MaterialSet`) are the spike's own, not a contract.

The post-merge real-GPU run uses Windows Edge Direct3D 12 via a Playwright CDP loopback bridge for core WebGPU and ANGLE D3D11 for WebGL2. The WSL route sets `GALLIUM_DRIVER=d3d12` with `--use-angle=gl --ignore-gpu-blocklist --enable-unsafe-webgpu --use-webgpu-adapter=opengles`; it checks WebGPU compatibility mode and WebGL2 through Mesa D3D12. Record backend, adapter, and GPU-complete pan timings for the integrated yard at 960×540 high tier. The maintainer findings above describe the routes and their spike measurements.
