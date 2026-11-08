# ADR: Character Rendering, Real-Time 3D or 2D Sheets

**Status:** Draft  
**Version:** 0.2  
**Date:** November 07, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.10, `raccoon-world-cloudflare-implementation-plan.md` v3.12 §20, and implementation Wave 4 §9.1  
**Scope:** Evidence for the owner's choice of how Raccoon World draws characters while environments stay painted 2.5D (issue 77); the owner picks, and a later Objective builds the chosen path

---

## Context

The owner decided on 2026-11-07 to try a 3D Stevie before investing heavily in 2D character sheets (issue 77). The spike draws three versions of Stevie in the #67 lit yard slice, the same Three.js WebGL2 adapter the [renderer bake-off](clockgrove-adr-renderer-bake-off.md) measured, at dusk in rain and at night:

- **3D:** a rigged model playing idle and walk clips, with toon shading and an outline, lit by the scene's own lights.
- **2D:** frames cut from the owner's [identity sheet](../design/reference/stevie-sprite-sheet.png), drawn as lit sprites with derived normal maps.
- **3D rendered to sprites:** the 3D arm's model and clips rendered offline to sprite frames, with exact albedo, normal and depth maps taken from the geometry.

The spike is in [`spikes/renderer-bakeoff`](../../spikes/renderer-bakeoff/README.md#3d-stevie-issue-77). Nothing in `apps/` imports it. It commits no media: models and frames go to a git-ignored directory or an output directory outside git, and the report records their sha256 and provenance.

## The generation run

The owner chose the services on the issue (2026-11-07): a GPT-image **turnaround** through Vercel AI Gateway first, then **fal.ai TRELLIS.2** with the spike's own rig, and **Meshy** image-to-3D with Meshy's own auto-rig, side by side within the $10 cap. `scripts/generate.mjs` makes every call. It reserves each call's cost against the cap before the call and records provider, model, endpoint, parameters, cost, minutes and sha256 in the git-ignored `media/provenance.json`.

**Services the keys reach.**

- AI Gateway's `/v1/models` lists image models (`openai/gpt-image-*`, Gemini image, FLUX and others). It has no image-to-3D or rigging model.
- Anthropic has no image-to-3D, rigging or image-generation model.
- fal.ai serves TRELLIS.2 at `fal-ai/trellis-2` and `fal-ai/trellis-2/multi`. It has no quadruped rigger.
- Meshy serves `multi-image-to-3d` and `rigging`.

**Calls.** Total generation spend is **$1.83 of the $10 cap**.

| Step | Provider, model | Parameters | Cost | Minutes | Output (sha256, first 12) |
| --- | --- | --- | --- | --- | --- |
| Turnaround | AI Gateway, `openai/gpt-image-2`, `/v1/images/edits` with the identity sheet | 1536×1024, high; the prompt asks for a 2×2 turnaround: front, three-quarter, side, back; neutral stance, flat shadowless light, plain background; the mask, the ringed tail, the colours and the proportions kept | $0.178 (gateway balance delta; 1,726 input and 5,488 output tokens) | 1.1 | `turnaround.png` 6fba28c68a99, cropped into four views |
| fal multi | fal.ai TRELLIS.2 `/multi`, four views | resolution 1024, texture 2048, decimation 50,000, seed 1 | $0.30 (listed price) | 1.0 | `fal-multi-model_glb.glb` 48d7c965dc04 |
| fal three-quarter | TRELLIS.2, three-quarter view | 1024, 2048, 50,000, seed 1 | $0.30 (listed price) | 1.1 | `fal-three-quarter-model_glb.glb` 47fae1d24256 |
| fal three-quarter 1536 (kept) | TRELLIS.2, three-quarter view | 1536, 2048, 50,000, seed 2 | $0.35 (listed price) | 2.8 | `fal-three-quarter-1536-model_glb.glb` 0908ec787495 |
| Meshy (kept) | Meshy multi-image-to-3D, four views; then Meshy rigging | textured, remeshed, triangles, 30,000 target; rig height 0.53 m | 35 credits (balance delta) ≈ $0.70 at $0.02 a credit | 2.3 + 0.3 | `meshy-model.glb` 07856f9fc704; `meshy-rig-rigged_character.glb` eb1791deb1f1; walking 6caf04a4b804 |

fal's prices are its listed per-call prices, because fal's billing API and web pages are outside the run's network allowance. fal's account is capped at $10 prepaid. Meshy's credit count is exact, and its dollar value is an estimate at the Pro plan's rate. TRELLIS.2's weights are MIT per Microsoft's release; fal's own terms for the endpoint couldn't be fetched from the run, so the maintainer re-checks them before relying on the licence.

**Likeness.** The judge is the turnaround, then the identity sheet; the report shows them side by side.

- **Meshy:** the most faithful. It has the mask and white brows, the ringed tail with clear dark and tan bands, the grey-brown back over a tan underside, dark legs and the round build. Its albedo is evenly lit, because the turnaround asked for flat light.
- **fal, three-quarter at 1536 (kept):** the shape and the mask are right. The fur drifts darker and blotchy, and the tail banding is faint.
- **fal, three-quarter at 1024:** loses the tail rings and drifts red-brown.
- **fal, multi-view:** worst of the three. The face melts, the eyes go orange, and the tail rings are lost. TRELLIS.2's multi-view endpoint did not help with this input.

**Rigs.**

- **Meshy's own auto-rig** is a 24-joint humanoid skeleton: `Hips`, `Spine`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftFoot` and so on. Its only walk is `walking_man`, which rears the raccoon onto its hind legs and shears the belly and front legs. Its idle is a one-frame rest pose. As delivered, it is **not usable** for a four-legged character.
- **The spike's fitted rig** (`src/stevie/fit.ts`) works on both meshes, with no paid rigger. It puts the stand-in's 18-joint quadruped skeleton on the mesh:
  - the spine and head are mapped from the stand-in by the bounding box;
  - each leg sits over the centroid of its quadrant of paw vertices;
  - the tail runs through slice centroids;
  - each vertex is weighted to its two nearest bone segments, with legs kept to their own side.

  Fitting takes about 0.2 s in Node. A software rasterisation of the idle and walk frames shows a clean diagonal gait with no tearing on either mesh, so the owner's Tripo fallback (quadruped auto-rig, about $0.25 a model) was not triggered. The joins where leg meets belly stretch a little at full stride, and the report's walk frames show how much. The best 3D result is **Meshy's mesh with the fitted rig** (model `meshy-fit` in the report).

**What the sandbox could not do.**

- It has no browser, so the report's stills and frame times come from the maintainer step on issue 77. The previews above came from a scratch CPU rasteriser, with skinning computed by three.js. CI renders under SwiftShader, so its numbers are correctness evidence only (`performance: false`). The report names the host of every number.
- The 2D arm is still a plain crop, because Assetforge's CLI is not in the sandbox.

## Recorded for the 3D model

These numbers come from inspecting the GLBs and from the fit's own step times. The report's `results.json` records the same fields on the host that renders it.

| Item | Procedural stand-in | Meshy mesh + fitted rig (best) | fal TRELLIS.2 + fitted rig | Meshy's own rig |
| --- | --- | --- | --- | --- |
| Polygons | 5,168 triangles, 3,631 vertices | 31,171 triangles, 55,131 vertices | 46,681 triangles, 40,543 vertices | 31,171 triangles, 55,804 vertices |
| Textures | 256² procedural fur strokes plus vertex colour | one 2048² JPEG base colour | 2048² WebP base colour plus 2048² metallic-roughness | as Meshy mesh |
| Rig | 18 joints, two influences per vertex | 18 joints fitted, two influences per vertex | 18 joints fitted, two influences per vertex | 24 humanoid joints, four influences per vertex |
| Clips | idle 2.4 s, walk 0.8 s (procedural) | the stand-in's clips, re-based on the fitted hips | the stand-in's clips | rest pose (1 frame), `walking_man` 1.07 s, `running` |
| Skinning artefacts | creases at the shoulders and hips at full stride | slight stretch where leg meets belly at full stride; no tearing | the same as Meshy-fit | rears up and tears; unusable |
| Fur | texture only | texture only (the generator's colour map); no shells or cards | texture only | texture only |

**Cleanup each generated model still needs.** None of this was done in the spike.

- **Retopology:** 31–47k triangles is about 6–9× the stand-in. That is fine for one character on a GPU, but a crowd wants a decimation to about 5–10k.
- **UVs:** both generators emit fragmented atlas UVs. They work for the one texture, but not for hand painting.
- **Baked lighting:** the turnaround's flat-light prompt kept Meshy's albedo nearly delit. fal's albedo carries darker, blotchy shading that would need a delighting pass.
- **Rig:** the fitted rig needs no manual work. A production rig would add weight painting at the shoulders and hips and ear and jaw joints.

**Time per step.** These are wall-clock times for this run:

| Step | Time |
| --- | --- |
| Turnaround | 1.1 min |
| TRELLIS.2 | 1.0–2.8 min a candidate |
| Meshy mesh | 2.3 min |
| Meshy rig | 0.3 min |
| Fitting the rig | about 0.2 s |
| Choosing the best candidate | by eye, from the previews |

## The three arms against the owner's criteria

The owner decided (2026-11-07) to judge cohesion first, then closeness to the mockup's look.

| Criterion | 3D | 2D from the sheet | 3D rendered to sprites |
| --- | --- | --- | --- |
| 1. One lighting model, nothing baked separately | yes: the scene's ambient, sky and point lights, and fog, light the mesh | partly: the scene lights the sprite through a derived normal map, but the painting's own rim light and shading stay baked in | yes: an unlit albedo plus the exact normal map, lit by the scene's lights |
| 2. One colour grade and post pass | yes: the shared bloom and output pass | yes | yes |
| 3. Matched detail density | lower than the painted environment unless the model and textures are generated at high detail; no real fur | highest: painted at about 2.5× screen density (192 sheet pixels over 77 screen pixels at zoom 1) | the 3D model's detail at 213 px/m (about 2.2× screen) |
| 4. Consistent edge treatment | an inverted-hull outline, the same width at every angle | a 1-pixel dark edge added to the keyed alpha; the sheet's painted fringe stays | the same outline as 3D, baked in |
| 5. One camera and scale | yes | yes, with scale set by eye from the sheet's pixels | yes |
| Identity across angles and frames | exact: one model; the Meshy mesh is close to the sheet through the turnaround | drifts: the sheet's frames vary in shape and colour, and it has no back or straight-front view | exact at the baked headings |
| Animation quality | interpolated clips at any frame rate; blending is free | the sheet's eight walk frames, with pose and size jumps between them | the 3D clip sampled at the baked frame count |

The owner judges the look from the report's stills. This record does not claim a winner on look.

## Cost of one more animation and one more variant

| | One more animation | One more character variant |
| --- | --- | --- |
| **3D** | one clip: keyframed, or a library motion retargeted onto the rig. A few kilobytes of tracks, and it plays in every direction at once. Library motions are humanoid (Meshy's walk is a human walk), so quadruped clips are keyframed or procedural, as in the spike. | a recolour or rescale is free (Juniper and the kit in the cohesion shot are a material tint and a 0.6 scale). A new shape is another turnaround and mesh, about $0.18 + $0.70 and 5 minutes on this run's route, then the fitted rig in seconds. |
| **2D** | new painted or generated frames for every direction (the sheet has 3 of 8 directions), with identity drift in each | a tint is free; anything more is a whole new sheet |
| **3D rendered to sprites** | the 3D clip, plus a re-bake (seconds) for every heading. Atlas memory grows with frames × headings × three maps: 8 headings × 16 frames at 192² is 128 × 192 × 192 × 4 B × 3 maps ≈ 56.6 MB before compression. | a tint is free; a shape variant is a re-bake |

## Precedents

- **Disco Elysium** and **Pillars of Eternity** put real-time 3D characters in painted isometric scenes, which is the **3D** arm. Their characters read as part of the painting because of their lighting and post, not their detail.
- **Hades** and **Diablo II** render 3D models to sprites, which is the **3D rendered to sprites** arm. They get one model's identity and 2D's draw cost, and pay atlas memory and re-bakes for every animation and heading.
- **Diablo III** and **IV** are fully 3D with painted-style art direction. That is where the 3D arm leads if environments also move to meshes, which this issue keeps out of scope.
- **Octopath Traveler** puts 2D sprites in a lit 3D world, which is the **2D** arm. The sprites carry the identity, and the world's lights and post make the scene cohere.

## Decision

None yet. This record is a draft for the owner, who picks one of three:

- 3D characters;
- 2D characters;
- 3D rendered to sprites.

The pick waits on the maintainer step on issue 77: running `stevie.mjs` on a GPU with the generated models in `media/`, then judging the stills and frame times. On this run's evidence, a 3D path is practical. The turnaround plus Meshy's mesh gives a faithful Stevie for under $1. The spike's fitted quadruped rig animates it, which Meshy's humanoid rig can't do. The open costs are polygon reduction, texture-only fur, and keyframing every quadruped clip by hand.

## Consequences

- Production rendering doesn't change. Character art stays on the current placeholder path until the owner picks.
- If the pick is 3D or 3D rendered to sprites, the material model (issue 66) extends to meshes, and Assetforge's 3D work (PRD §5.8) moves earlier.
- If the pick is 2D, the sheet needs the missing directions, and the derived maps should come from Assetforge's transformation core (§5.11) rather than the spike's alpha dome.
