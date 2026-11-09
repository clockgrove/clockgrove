# ADR: Character Rendering, Real-Time 3D or 2D Sheets

**Status:** Draft  
**Version:** 0.4  
**Date:** November 07, 2026  
**Accepted baseline:** `clockgrove-prd-v0.5.md` v0.5.10, [raccoon-world-cloudflare-implementation-plan.md](https://github.com/clockgrove/raccoon-world/blob/main/docs/raccoon-world-cloudflare-implementation-plan.md) v3.12 §20, and implementation Wave 4 §9.1
**Scope:** Evidence for the owner's choice of how Raccoon World draws characters while environments stay painted 2.5D (issue 77); the owner picks, and a later Objective builds the chosen path

---

## Context

The owner decided on 2026-11-07 to try a 3D Stevie before investing heavily in 2D character sheets (issue 77). The spike draws three versions of Stevie in the #67 lit yard slice, the same Three.js WebGL2 adapter the [renderer bake-off](clockgrove-adr-renderer-bake-off.md) measured, at dusk in rain and at night:

- **3D:** a rigged model playing idle and walk clips, with toon shading and an outline, lit by the scene's own lights.
- **2D:** frames cut from [Jimothy's sheet](https://github.com/clockgrove/raccoon-world/blob/main/docs/design/reference/jimothy-sprite-sheet.png), drawn as lit sprites with derived normal maps. The sheet is Jimothy, the short-spine raccoon, not Stevie (owner's correction, 2026-11-07). No Stevie sprite sheet exists yet, so **the 2D and 3D arms show different characters**. Each arm is judged on technique (lighting, cohesion, animation), not on matching the other.
- **3D rendered to sprites:** the 3D arm's model and clips rendered offline to sprite frames, with exact albedo, normal and depth maps taken from the geometry.

The spike is in [`spikes/renderer-bakeoff`](https://github.com/clockgrove/raccoon-world/blob/main/spikes/stevie-3d/docs/stevie-3d.md). Nothing in `apps/` imports it. It commits no media: models and frames go to a git-ignored directory or an output directory outside git, and the report records their sha256 and provenance.

## The generation run

The owner chose the services on the issue (2026-11-07): a GPT-image **turnaround** through Vercel AI Gateway first, then three routes side by side within the $10 cap:
- **fal.ai TRELLIS.2** with the spike's own rig;
- **Meshy** image-to-3D with Meshy's own auto-rig;
- **Tripo** multi-view image-to-model with its low-poly option and its quadruped auto-rig.

The owner approved the first turnaround as Stevie's likeness: lean, upright, a long body and a ringed tail. Every route starts from it, and 3D likeness is judged against it. `scripts/generate.mjs` makes every call. It reserves each call's cost against the cap before the call and records provider, model, endpoint, parameters, cost, minutes and sha256 in the git-ignored `media/provenance.json`.

**Services the keys reach.**

- AI Gateway's `/v1/models` lists image models (`openai/gpt-image-*`, Gemini image, FLUX and others). It has no image-to-3D or rigging model.
- Anthropic has no image-to-3D, rigging or image-generation model.
- fal.ai serves TRELLIS.2 at `fal-ai/trellis-2` and `fal-ai/trellis-2/multi`. It has no quadruped rigger.
- Meshy serves `multi-image-to-3d` and `rigging`.
- Tripo's v3 API serves `multiview-to-model`, a free `rig-check`, `rig` and preset `retarget`. Its files come from `openapi-dl.data.tripo3d.com`, a host its docs don't name. The sandbox refused it until the owner allowed it.

**Calls.** Generation has committed **$4.56 of the $10 cap**: $3.56 spent, plus a $1 reservation for a stopped Tripo call whose outcome is unknown. The table lists the calls that produced the kept files.

| Step | Provider, model | Parameters | Cost | Minutes | Output (sha256, first 12) |
| --- | --- | --- | --- | --- | --- |
| Turnaround | AI Gateway, `openai/gpt-image-2`, `/v1/images/edits` with the identity sheet | 1536×1024, high; the prompt asks for a 2×2 turnaround: front, three-quarter, side, back; neutral stance, flat shadowless light, plain background; the mask, the ringed tail, the colours and the proportions kept | $0.178 (gateway balance delta; 1,726 input and 5,488 output tokens) | 1.1 | `turnaround.png` 6fba28c68a99, cropped into four views |
| fal multi | fal.ai TRELLIS.2 `/multi`, four views | resolution 1024, texture 2048, decimation 50,000, seed 1 | $0.30 (listed price) | 1.0 | `fal-multi-model_glb.glb` 48d7c965dc04 |
| fal three-quarter | TRELLIS.2, three-quarter view | 1024, 2048, 50,000, seed 1 | $0.30 (listed price) | 1.1 | `fal-three-quarter-model_glb.glb` 47fae1d24256 |
| fal three-quarter 1536 (kept) | TRELLIS.2, three-quarter view | 1536, 2048, 50,000, seed 2 | $0.35 (listed price) | 2.8 | `fal-three-quarter-1536-model_glb.glb` 0908ec787495 |
| Meshy (kept) | Meshy multi-image-to-3D, four views; then Meshy rigging | textured, remeshed, triangles, 30,000 target; rig height 0.53 m | 35 credits (balance delta) ≈ $0.70 at $0.02 a credit | 2.3 + 0.3 | `meshy-model.glb` 07856f9fc704; `meshy-rig-rigged_character.glb` eb1791deb1f1; walking 6caf04a4b804 |
| Tripo model (kept) | Tripo `multiview-to-model` `v3.1-20260211`, task `cb8787b8…`; front, left (the side view) and back | textured, PBR, `smart_low_poly`, `face_limit` 10,000 | 40 credits ≈ $0.40 at $0.01 a credit | 5.8 | `tripo-model-model_url.glb` 653511586904 |
| Tripo rig and walk (kept) | Tripo `rig-check` (free: riggable, `quadruped`), `rig` `v3.0-20260909`, `retarget` `preset:quadruped:walk` | glb out | 35 credits ≈ $0.35 (each task's `credits_consumed`) | 0.08 + 0.26 + 0.08 | rig 0e2fd5f51b3b; walk 4927c226d0c7 |

The other spend is all recorded in `provenance.json`:
- a second turnaround ($0.19), which the owner dropped because it was pushed toward Jimothy's shape;
- two more Tripo models at $0.40 each. One is from the approved turnaround (`7c64bf96…`, a spare candidate, not fetched). The other is from the dropped turnaround (`31d1a793…`, ignored). The ledger first carried each of these at its $2 reservation; it now carries the 40 credits Tripo's usage API reports, as the owner asked.

fal's prices are its listed per-call prices, because fal's billing API and web pages are outside the run's network allowance. fal's account is capped at $10 prepaid. Meshy's credit count is exact, and its dollar value is an estimate at the Pro plan's rate. TRELLIS.2's weights are MIT per Microsoft's release; fal's own terms for the endpoint couldn't be fetched from the run, so the maintainer re-checks them before relying on the licence.

**Likeness.** The judge is the approved turnaround. The owner asked for likeness at the reduced triangle count. The bullets below were judged at the **raw** count, each noted, from previews made before the ship step existed; the report page renders the shipped 10K files beside the turnaround, and judging those is the maintainer step under "What the sandbox could not do".

- **The image step held Stevie's identity:** the owner confirmed the first turnaround as Stevie, with the mask, the ringed tail, the grey-brown coat and the lean, upright build.
- **Meshy** (judged at its raw 31,171 triangles): faithful to the turnaround. It has the mask and white brows, the ringed tail with clear dark and tan bands, the grey-brown back over a tan underside and dark legs. Its albedo is evenly lit, because the turnaround asked for flat light.
- **Tripo** (judged at its raw 15,156 triangles, from Tripo's own render): Tripo's own preview render (front three-quarter, `preview-tripo-provider-render.png`) shows the closest face of the three routes: the mask, the white brows, glossy dark eyes, a grey-brown coat with a tan chest, dark paws, and added whiskers. Its finish is crisper and more naturalistic than the turnaround's soft illustration. The preview doesn't show the tail, so the tail's likeness waits on the maintainer's report render.
- **fal, three-quarter at 1536 (kept; raw 46,681 triangles):** the shape and the mask are right. The fur drifts darker and blotchy, and the tail banding is faint.
- **fal, three-quarter at 1024 (raw 48,469 triangles):** loses the tail rings and drifts red-brown.
- **fal, multi-view (raw 49,090 triangles):** worst of the three. The face melts, the eyes go orange, and the tail rings are lost. TRELLIS.2's multi-view endpoint did not help with this input.

**Rigs.**

- **Meshy's own auto-rig** is a 24-joint humanoid skeleton: `Hips`, `Spine`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftFoot` and so on. Its only walk is `walking_man`, which rears the raccoon onto its hind legs and shears the belly and front legs. Its idle is a one-frame rest pose, so the report plays the spike's keyframed breathing on Meshy's own spine, neck and head bones instead, named as the spike's clip. As delivered, it is **not usable** for a four-legged character.
- **Tripo's quadruped auto-rig:**
  - the free rig check classed the model as riggable and `quadruped`;
  - the rig has 28 joints, four influences per vertex: `tripo::Root`, `Spine_0–1`, `Head_0–2`, `0_Right_Limb_0–4`, `0_Left_Limb_0` and 18 unnamed `bone_N` (limbs and tail);
  - its preset quadruped walk is 2.6 s. Tripo has no idle preset, so the report plays the spike's keyframed breathing on Tripo's own spine, head and tail bones, named as the spike's clip; Tripo's idle cost is therefore not judged;
  - it is the only provider rig that fits a four-legged animal.
- **Skinning artefacts, measured.** The measure is the ratio of each mesh edge's length to its rest length, over eight evenly spaced frames of the walk, on the shipped files:
  - Tripo: p50 1.00, p99 1.42, p99.9 2.44, max 6.9. Most of the mesh holds, with stretching in a few places;
  - Meshy's humanoid rig: p99 3.54, max 12.2, which confirms the tearing.
- **The spike's fitted rig** (`src/stevie/fit.ts`) works on both meshes, with no paid rigger. It puts the stand-in's 18-joint quadruped skeleton on the mesh:
  - the spine and head are mapped from the stand-in by the bounding box;
  - each leg sits over the centroid of its quadrant of paw vertices;
  - the tail runs through slice centroids;
  - each vertex is weighted to its two nearest bone segments, with legs kept to their own side.

  Fitting takes about 0.2 s in Node. A software rasterisation of the idle and walk frames shows a clean diagonal gait with no tearing on either mesh, so it needed no fallback. The owner then added Tripo as a third route in its own right. The joins where leg meets belly stretch a little at full stride, and the report's walk frames show how much. Two 3D results are close enough that the report has to decide between them:
- **Meshy's mesh with the fitted rig** (`meshy-fit`): a faithful mesh on the spike's own rig;
- **Tripo with its own quadruped rig** (`tripo`): the closest face, with a provider rig and walk that need no code.

**What the sandbox could not do.**

- It has no browser, so the report's stills and frame times come from the maintainer step on issue 77. That step also makes the **likeness check at the reduced count**: the shipped 10K models on the report page against the turnaround, which the bullets above did not yet do. The shipped Meshy files now carry recomputed smooth normals, so their shading is part of that check. The previews above came from a scratch CPU rasteriser, with skinning computed by three.js. CI renders under SwiftShader, so its numbers are correctness evidence only (`performance: false`). The report names the host of every number.
- The 2D arm is still a plain crop, because Assetforge's CLI is not in the sandbox.

## Ship form and validation

The owner's standard (2026-11-07) is glTF 2.0 `.glb` with:
- `KHR_texture_basisu` (KTX2: UASTC for normal maps, as the standard names; ETC1S for colour and for metallic-roughness and occlusion);
- `EXT_meshopt_compression`;
- `KHR_xmp_json_ld` provenance, including IPTC `digitalSourceType: trainedAlgorithmicMedia`.

`scripts/ship.mjs` converts every kept model, and every other generated mesh as a candidate, to that form. Its tools are pinned devDependencies of the spike's workspace package, under the lockfile and the repository's supply-chain policy. It then:
- reduces the model to the **10,000-triangle budget** with meshoptimizer. Where the provider's hard-edged normals stall the simplifier, it drops them, welds, simplifies, and computes smooth area-weighted vertex normals on the indexed result;
- converts units to Stevie's 0.53 m height in metres, baked into the vertices, joints, inverse bind matrices and clips;
- names any unnamed nodes, meshes or materials;
- runs the Khronos glTF Validator three times: on the raw file; on the **prepared** geometry (after simplify, normals, scale and naming, before KTX2 and meshopt, which the validator cannot decode); and on the shipped file;
- checks four Asset Creation Guidelines 2.0 items (scale and units, naming, UVs, and texture sizes: powers of two, at most 2048) on the file as delivered and on the shipped file. On the shipped file, scale and naming pass by construction, so the delivered column is the providers' result.

The page renders the shipped files.

| Route | Triangles raw → shipped | Vertices raw → shipped | Bytes raw → shipped | Textures (shipped, KTX2) | Validator raw / prepared / shipped | Guidelines as delivered |
| --- | --- | --- | --- | --- | --- | --- |
| Tripo (rig and walk) | 15,156 → 9,799 | 15,412 → 11,666 | 5.5 MB → 4.4 MB | 2048² normal (UASTC), base colour and metallic-roughness (ETC1S) | 0 errors / 0 errors / 0 errors | all four pass; height 0.571 units |
| Meshy mesh + fitted rig | 31,171 → 9,799 | 55,131 → 11,342 | 5.6 MB → 1.0 MB | 2048² base colour | 0 / 0 / 0 errors | naming fails (node, mesh and material unnamed); height 0.97 units |
| Meshy's own rig | 31,171 → **22,464** | 55,804 → 46,765 | 7.5 MB → 1.7 MB | 2048² base colour | 0 / 0 / 0 errors | all four pass; height 0.53 m (Meshy's rig took a height) |
| fal TRELLIS.2 (kept) | 46,681 → 9,800 | 40,543 → 14,763 | 4.2 MB → 1.6 MB | 2048² base colour, metallic-roughness | **3 errors** (zero-length normals) / 0 / 0 | naming fails (material); height 0.58 units |
| fal multi (candidate) | 49,090 → 9,800 | 30,788 → 8,958 | 2.4 MB → 0.8 MB | as fal | 0 / 0 / 0 errors | naming fails (material); height 0.83 units |
| fal three-quarter 1024 (candidate) | 48,469 → **23,958** | 57,495 → 37,548 | 6.1 MB → 2.7 MB | as fal | **40 errors** / 0 / 0 | naming fails (material); height 0.61 units |
| Tripo model, unrigged (candidate) | 15,156 → 9,799 | 15,412 → 11,664 | 5.2 MB → 4.4 MB | as Tripo | 0 / 0 / 0 errors | all four pass; height 0.571 units |

Heights are measured at rest through each skin. The prepared Meshy and fal-1024 meshes are indexed, and every vertex normal has unit length.

What the run found:
- **The budget needs cleanup on some meshes.** Meshy's split normals locked the simplifier at about 22.5K triangles. Dropping the normals, welding, simplifying and computing smooth normals on the indexed mesh reached the budget, with fewer vertices than the raw file. Meshy's rigged file still stalls at 22.5K, because its skin-weight seams lock it too; reducing it needs a re-rig after decimation. fal's 1024 three-quarter candidate stalls at 24K the same way. Tripo's low-poly option delivered 15,156 triangles, over the requested 10,000 `face_limit`.
- **No provider returns real-world scale.** Raw heights were 0.57–0.97 units, or 0.53 m only where Meshy's rig took a height. All are inside the guidelines' 0.2–1.0 m range only because a raccoon is small.
- **Naming is the providers' one guideline failure:** Meshy's unrigged mesh and every fal file leave items unnamed.
- **Texture size comes from the encoding choice.** With ETC1S for everything but the normal map, Tripo's shipped file is 4.4 MB against its 5.5 MB raw file; most of it is the UASTC normal map, which the standard requires.
- **The validator's limits.** The Khronos validator does not decode `EXT_meshopt_compression` or `KHR_texture_basisu`, so the prepared GLB is where the rewritten geometry is validated. The shipped file's warnings are the `image/ktx2` MIME type it doesn't know.
- **Ship time** is under a minute a model, mostly KTX2 encoding.

## Recorded for the 3D model

These numbers come from inspecting the GLBs and from the fit's own step times. The report's `results.json` records the same fields on the host that renders it.

| Item | Procedural stand-in | Meshy mesh + fitted rig | Tripo + its quadruped rig | fal TRELLIS.2 + fitted rig | Meshy's own rig |
| --- | --- | --- | --- | --- | --- |
| Polygons, raw | 5,168 triangles, 3,631 vertices | 31,171 triangles, 55,131 vertices | 15,156 triangles, 15,412 vertices | 46,681 triangles, 40,543 vertices | 31,171 triangles, 55,804 vertices |
| Polygons, shipped | as raw | 9,799 triangles, 11,342 vertices (indexed, smooth normals) | 9,799 triangles | 9,800 triangles | 22,464 triangles (stalled) |
| Textures | 256² procedural fur strokes plus vertex colour | one 2048² base colour | 2048² base colour, normal and metallic-roughness | 2048² base colour and metallic-roughness | as Meshy mesh |
| Rig | 18 joints, two influences per vertex | 18 joints fitted, two influences per vertex | 28 joints (quadruped), four influences per vertex | 18 joints fitted, two influences per vertex | 24 humanoid joints, four influences per vertex |
| Clips | idle 2.4 s, walk 0.8 s (procedural) | the stand-in's clips, re-based on the fitted hips relative to the fitted root | `preset:quadruped:walk` 2.6 s; idle is the spike's breathing on Tripo's bones | the stand-in's clips | rest pose (1 frame, replaced by the spike's breathing on Meshy's bones), `walking_man` 1.07 s, `running` |
| Skinning artefacts | creases at the shoulders and hips at full stride | slight stretch where leg meets belly at full stride; no tearing | edge stretch p99 1.42, max 6.9: local stretching | the same as Meshy-fit | edge stretch p99 3.54, max 12.2: rears up and tears; unusable |
| Fur | texture only | texture only (the generator's colour map); no shells or cards | texture only, with modelled whiskers in the texture | texture only | texture only |

**Cleanup each generated model still needs.** The ship step did the decimation, units, naming and KTX2 (above). It did not do the rest:

- **Retopology:** the ship step's decimation is automatic. A production character would want a clean quad topology for deformation, which none of the routes give.
- **UVs:** all three generators emit fragmented atlas UVs. They work for the one texture, but not for hand painting.
- **Baked lighting:** the turnaround's flat-light prompt kept Meshy's albedo nearly delit. fal's albedo carries darker, blotchy shading that would need a delighting pass.
- **Rig:** the fitted rig needs no manual work. A production rig would add weight painting at the shoulders and hips and ear and jaw joints.

**Time per step.** These are wall-clock times for this run:

| Step | Time |
| --- | --- |
| Turnaround | 1.1 min |
| TRELLIS.2 | 1.0–2.8 min a candidate |
| Meshy mesh | 2.3 min |
| Meshy rig | 0.3 min |
| Tripo model | 5.8 min |
| Tripo rig check, rig and walk | 0.4 min |
| Ship (reduce, units, KTX2, meshopt, validate) | under 1 min a model |
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
| **3D** | one clip: keyframed, or a library motion retargeted onto the rig. A few kilobytes of tracks, and it plays in every direction at once. Library motions are humanoid (Meshy's walk is a human walk), so quadruped clips are keyframed or procedural, as in the spike. | a recolour or rescale is free (Juniper and the kit in the cohesion shot are a material tint and a 0.6 scale). A new shape is another turnaround and mesh, then a rig: about $0.18 + $0.70 and 5 minutes on the Meshy route with the fitted rig; about $0.18 + $0.75 and 7 minutes on the Tripo route with its own rig and walk. |
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

The pick waits on the maintainer step on issue 77, including the likeness check at the reduced count. It runs `generate.mjs`'s files through `ship.mjs`, then runs `stevie.mjs` on a GPU with the shipped models in `media/`, and judges the stills and frame times.

On this run's evidence, a 3D path is practical:
- the approved turnaround held Stevie's identity, and each of Meshy and Tripo turns it into a faithful Stevie for under $1, judged so far at the raw count (31,171 and 15,156 triangles); whether that holds at 10K is the maintainer's check;
- both reduce to the 10K budget in the owner's ship form, with no validator errors on the prepared geometry or the shipped file;
- Tripo is the only provider whose rig and walk fit a four-legged animal. The spike's fitted rig does the same for any mesh at no cost;
- the open costs are hand cleanup for production topology, texture-only fur, and keyframing quadruped clips beyond Tripo's presets.

Any Stevie art kept after the pick goes to clockgrove/raccoon-world, not to this platform repository (owner, 2026-11-07).

## Consequences

- Production rendering doesn't change. Character art stays on the current placeholder path until the owner picks.
- If the pick is 3D or 3D rendered to sprites, the material model (issue 66) extends to meshes, and Assetforge's 3D work (PRD §5.8) moves earlier.
- If the pick is 2D, the sheet needs the missing directions, and the derived maps should come from Assetforge's transformation core (§5.11) rather than the spike's alpha dome.
