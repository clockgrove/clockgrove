# ADR: Renderer for Top-Tier Lit 2.5D

**Status:** Draft  
**Version:** 0.1  
**Date:** November 07, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.10, `raccoon-world-cloudflare-implementation-plan.md` v3.12 §20, and implementation Wave 4 §9.1  
**Scope:** Evidence for choosing the browser renderer of the lit 2.5D yard; the owner picks, a later Objective integrates

---

## Context

Architecture §20.4 pins Phaser 4.2+ with WebGL as the initial renderer. Issue 67 records that Phaser 4 is the initial implementation, not a permanent contract, and that its lighting may cap the look the [reference mockup](../design/reference/raccoon-world-reference.png) asks for: painterly storybook realism, dusk in rain and night, lit windows and lanterns, wet ground, fog and soft glow. The owner decided on 2026-11-07 to run a bake-off first and then pick.

The bake-off is the spike in [`spikes/renderer-bakeoff`](../../spikes/renderer-bakeoff/README.md). Every candidate implements the product's `WorldSceneAdapter` (Wave 4 §9.1) for one reference yard slice. Every candidate gets the same committed projection, the same dusk-to-night patch, the same light rig, the same camera and the same synthetic maps: normal, height, emissive, roughness/wetness and wind. Production rendering does not change.

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

- **Phaser 4** can light normal-mapped sprites and bloom them, and its filters and shader objects can add effects that cover the whole canvas. It can't give specular or roughness response, an emissive channel, light falloff over real 3D positions, or per-object fog depth. Each of these is a separate layer or a screen-space shader, and the spike already carries five of them. That is the ceiling the issue suspected.
- **Three.js** gets normal, roughness and emissive maps, physical point lights, per-pixel fog and bloom from the engine. Wetness, wind, rain and reflections are still the spike's own work, as in Phaser, but they sit on a physically based base. The WebGPU entry runs the same scene code. Its post-processing is node-based (TSL) rather than `EffectComposer`, so the post stack is written twice.

## Measurements

The measurement page and script are described in the spike's [README](../../spikes/renderer-bakeoff/README.md#measuring). Every record carries its host, browser user agent and renderer string. A software rasteriser (SwiftShader, llvmpipe) is marked `performance: false` and is never reported as performance.

Bundle sizes and code lines come from `node spikes/renderer-bakeoff/scripts/build.mjs` (Vite 8.3.4) at this record's commit. They depend on no host.

| Measure | phaser | three-webgl2 | three-webgpu |
| --- | --- | --- | --- |
| Bundle (minified, gzip level 9), including the shared inputs | 1,415,654 B (367,817 B gzip) | 797,162 B (201,738 B gzip) | 1,152,583 B (312,968 B gzip) |
| Adapter code lines (non-blank, non-comment) | 817 | 638 shared + 47 entry | 638 shared + 31 entry |
| Frame time p50/p95, mid-range GPU (RTX 2060 SUPER, WebGL2 in WSL2 Chromium) | pending: maintainer step | pending: maintainer step | pending: maintainer step |
| Frame time p50/p95, RTX 2060 SUPER, Windows Edge | pending: maintainer step | pending: maintainer step | pending: maintainer step (WebGPU) |
| Frame time p50/p95, integrated GPU | missing: needs a real device | missing | missing |
| Frame time p50/p95, phone | missing: needs a real device | missing | missing |
| GPU memory | each candidate's own estimate of texture and render-target bytes, in `results.json` (browsers expose no GPU memory API) | same | same |
| WebGL2 | yes | yes | fallback backend |
| WebGPU | no | no | yes, where the browser offers it |

Every candidate implements the three quality tiers of `TIER_FEATURES` and freezes rain, wind and flicker under reduced motion. The CI journey checks both properties on every candidate.

## Path to full 3D

- **Phaser 4** is a 2D engine. Its lights are 2D point lights over normal-mapped sprites, and depth is a sort key. Moving to full 3D means a second renderer, so the 2.5D work would not carry over beyond the adapter boundary.
- **Three.js** already draws the 2.5D slice as upright lit quads in a real 3D scene, with an orthographic camera that reproduces `isoProject`. Full 3D is the same scene graph with meshes in place of quads and a perspective or free camera: the lights, materials, fog, post-processing and adapter stay. This matches the 3D frame placement the existing headless 3D adapter already proves (`apps/web/test/headless-3d-adapter.ts`).
- **Three.js WebGPU** follows the same path, and its node materials (TSL) are where three's new rendering features land.

## Decision

None yet. This record is a draft for the owner. The owner picks a renderer after the maintainer GPU step posts its numbers and screenshots on issue 67. Accepting this record then states the pick and amends architecture §20.4 if the pick is not Phaser. A later Objective integrates the winner behind `WorldSceneAdapter`.

## Consequences

- Until the owner picks, production rendering stays on Phaser 4 (§20.4).
- Phone and integrated-GPU numbers stay missing until someone measures them on real devices; the report lists them.
- The material-model Objective (issue 66) replaces the synthetic maps. The adapter inputs here (`MaterialSet`) are the spike's own, not a contract.
