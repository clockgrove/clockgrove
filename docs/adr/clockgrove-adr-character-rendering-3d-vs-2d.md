# ADR: Character Rendering, Real-Time 3D or 2D Sheets

**Status:** Draft  
**Version:** 0.1  
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

## What the sandbox could and couldn't do

- **3D services.** No image-to-3D or auto-rig service was reachable from the sandbox.
  - The `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` and OpenAI keys are not in the sandbox, and its egress proxy refuses `ai-gateway.vercel.sh`, `api.openai.com` and the 3D vendors' hosts.
  - Going by the providers' published catalogues, which couldn't be checked live from the sandbox, none of those three offers image-to-3D or rigging.
  - Generation spend in the spike is **$0 of the $10 cap**. A generator needs a new account, which is a Question for the owner (below). Nothing was signed up for.
- **The 3D arm runs on a procedural stand-in.** The spike builds the model in code (`src/stevie/model.ts`), and it is not generated from the sheet. The pipeline after generation is real and the same for a generated model: skinning, the skeleton, clips, toon shading, the outline, scene lighting, variants and baking to sprites. A generated `media/stevie.glb` replaces the stand-in with no code change. The identity likeness of an image-to-3D model is **not yet measured**.
- **The 2D arm is a plain crop**, because Assetforge's CLI is not in the sandbox. Running its sheet import is a maintainer step.
- **Frame times come only from a GPU.** The sandbox has no browser, and CI renders with SwiftShader, so its numbers are correctness evidence only (`performance: false`). GPU frame times and the screenshots the owner judges come from the maintainer step on issue 77. The report names the host of every number.

## Recorded for the 3D model

These are the procedural stand-in's numbers, read from `results.json`. A generated model reports the same fields, plus the provenance from `media/provenance.json`.

| Item | Stand-in |
| --- | --- |
| Polygons | 5,168 triangles, 3,631 vertices, one merged skinned mesh plus an inverted-hull outline drawn from the same geometry |
| Textures | one 256×256 procedural fur-stroke map; colour comes from vertex colours |
| Rig | 18 joints: root, hips, spine, chest, neck, head, four tail joints, and two per leg. Two influences per vertex, weighted by inverse-square distance to the nearest bone segments of each body part. The head and feet are rigid. There are no corrective shapes, so expect creasing at the shoulders and hips at full stride; the report's walk frames show it. |
| Clips | idle: 2.4 s, 7 tracks (breathing, looking round, tail). walk: 0.8 s, 15 tracks (a diagonal-pair gait, hip bob, tail sway). |
| Fur | texture only: strokes multiplied over vertex colour. No shells or cards. |
| Cleanup | none for the stand-in. A generated model needs a pass for each item below; their times are pending the maintainer step. |
| Step times | building the mesh and skin weights ≈ 14 ms, building the clips < 1 ms (a Node run of `model.ts`). Bake and cut times are per host, in the report. |

**Expected cleanup for a generated quadruped.** These are not measured until the Question is answered:

- **Retopology:** image-to-3D meshes are dense and irregular, so plan a decimation to about 5–10k triangles.
- **UVs:** generated UVs are usable for a single texture, but not for painting.
- **Baked lighting:** generated albedo carries the source image's light. The sheet has an orange rim light and soft top light painted in, so delighting the texture is required for criterion 1.
- **Rigging:** auto-rigs fit bipeds best. A quadruped rig needs checking at the shoulders, the tail and the ears.

## The three arms against the owner's criteria

The owner decided (2026-11-07) to judge cohesion first, then closeness to the mockup's look.

| Criterion | 3D | 2D from the sheet | 3D rendered to sprites |
| --- | --- | --- | --- |
| 1. One lighting model, nothing baked separately | yes: the scene's ambient, sky and point lights, and fog, light the mesh | partly: the scene lights the sprite through a derived normal map, but the painting's own rim light and shading stay baked in | yes: an unlit albedo plus the exact normal map, lit by the scene's lights |
| 2. One colour grade and post pass | yes: the shared bloom and output pass | yes | yes |
| 3. Matched detail density | lower than the painted environment unless the model and textures are generated at high detail; no real fur | highest: painted at about 2.5× screen density (192 sheet pixels over 77 screen pixels at zoom 1) | the 3D model's detail at 213 px/m (about 2.2× screen) |
| 4. Consistent edge treatment | an inverted-hull outline, the same width at every angle | a 1-pixel dark edge added to the keyed alpha; the sheet's painted fringe stays | the same outline as 3D, baked in |
| 5. One camera and scale | yes | yes, with scale set by eye from the sheet's pixels | yes |
| Identity across angles and frames | exact: one model | drifts: the sheet's frames vary in shape and colour, and it has no back or straight-front view | exact at the baked headings |
| Animation quality | interpolated clips at any frame rate; blending is free | the sheet's eight walk frames, with pose and size jumps between them | the 3D clip sampled at the baked frame count |

The owner judges the look from the report's stills. This record does not claim a winner on look.

## Cost of one more animation and one more variant

| | One more animation | One more character variant |
| --- | --- | --- |
| **3D** | one clip: keyframed, or a library motion retargeted onto the rig. A few kilobytes of tracks, and it plays in every direction at once. | a recolour or rescale is free (Juniper and the kit in the cohesion shot are a material tint and a 0.6 scale). A new shape needs blend shapes or another generated model. |
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

The pick waits on the maintainer step on issue 77 (GPU frame times and the report's screenshots) and on the Question of the generator service. The service is needed to measure how well a model generated from the sheet keeps Stevie's identity.

## Consequences

- Production rendering doesn't change. Character art stays on the current placeholder path until the owner picks.
- If the pick is 3D or 3D rendered to sprites, the material model (issue 66) extends to meshes, and Assetforge's 3D work (PRD §5.8) moves earlier.
- If the pick is 2D, the sheet needs the missing directions, and the derived maps should come from Assetforge's transformation core (§5.11) rather than the spike's alpha dome.
