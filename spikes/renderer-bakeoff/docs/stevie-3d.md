# 3D Stevie spike (issue 77)

A second page, `stevie.html` (bundle `stevie`, `src/stevie/`), draws Stevie three ways in this same lit slice through
the WebGL2 Three.js adapter. Each arm adds its characters through `createThreeAdapter`'s optional `ThreeExtras`
hook, so every arm shares one light rig, one fog, one bloom and output pass, and one camera. The draft decision record is the
[character rendering ADR](../../../docs/adr/clockgrove-adr-character-rendering-3d-vs-2d.md).

- **3d** (`model.ts`): a rigged Stevie playing `idle` and `walk` clips, with `MeshToonMaterial` (a three-step ramp)
  and an inverted-hull outline. CI renders the **procedural stand-in**: 18 joints, two-bone skin weights and
  texture-only fur. Each generated model kept in `media/` (below) adds the arms `3d:<model>` and
  `3d-sprites:<model>`. A model rigged by its provider keeps its own skeleton and clips (`/idle/`, `/walk/`, or a
  separate walk file). Where the provider has no moving idle (Tripo ships none; Meshy's `clip0` is one frame), the
  idle is the spike's keyframed breathing on the provider's own spine, neck and tail bones, named as the spike's
  clip in the report. A model marked `fit` gets the stand-in's skeleton and clips fitted to its mesh by `fit.ts`.
- **2d** (`sheet.ts`): frames cropped from
  [`jimothy-sprite-sheet.png`](../../../docs/design/reference/jimothy-sprite-sheet.png). The grid is 8 columns of 192×230 cells,
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

## Generating the models

`scripts/generate.mjs` runs the owner's chosen route, and every output lands in the git-ignored `media/`. Keys come
from the environment and are never printed. Each call reserves its cost against the $10 cap before it runs, and is
refused past the cap. `media/provenance.json` records every call (provider, model, endpoint, parameters, cost and
how it was measured, minutes) and every file's sha256.

```sh
node scripts/generate.mjs turnaround                 # GPT-image edit via AI Gateway (AI_GATEWAY_API_KEY): media/turnaround*.png;
                                                     # refused while media/turnaround.png exists (the approved Stevie)
node scripts/generate.mjs fal three-quarter-1536     # TRELLIS.2 on fal (FAL_KEY); also `multi`, `three-quarter`
node scripts/generate.mjs meshy                      # Meshy multi-image-to-3D, then Meshy rigging (MESHY_API_KEY)
node scripts/generate.mjs tripo [model-task]         # Tripo multi-view low-poly, free rig check, quadruped rig, walk (TRIPO_API_KEY)
node scripts/generate.mjs tripo-fetch                # re-downloads every Tripo task's files (fresh URLs, no cost)
node scripts/generate.mjs keep <name> <provider|fit> <glb> [walk=<glb>] <why…>   # a model for the report
```

The turnaround is cropped into four views from its 2×2 grid by `png.mjs`. Every 3D route starts from those views:
the owner approved this turnaround as Stevie and said not to regenerate it, so `generate.mjs turnaround` refuses to
overwrite `media/turnaround.png`. The sheet is Jimothy's, so the 2D arm shows a different character.

`scripts/ship.mjs [name…]` converts each kept model, and every other generated mesh as a candidate, to the owner's
ship form. It writes `media/ship-<name>.glb` (and `-walk.glb`), `media/ship-candidate-<file>.glb` and `media/ship.json`:
- glTF 2.0 with KTX2 textures (UASTC for normal maps, ETC1S for every other map), meshopt geometry and
  `KHR_xmp_json_ld` provenance;
- reduced to 10,000 triangles and converted to metres; when the provider's hard-edged normals stall the simplifier,
  they are dropped and smooth, area-weighted vertex normals are computed on the indexed result;
- checked with the Khronos glTF Validator three times: the provider's raw file, the prepared geometry (after simplify,
  normals, scale and naming, before KTX2 and meshopt, which the validator cannot decode) and the shipped file;
- checked against four Asset Creation Guidelines items both as delivered and as shipped.

Its tools (glTF-Transform, meshoptimizer, the Khronos validator, ktx2-encoder, sharp) are pinned devDependencies of
this workspace package. `stevie.mjs` renders the shipped files where they exist, and shows the approved turnaround
beside Jimothy's sheet. The results, the costs and the likeness findings are in the ADR.

## Maintainer steps for issue 77 (outside the sandbox)

- **GPU frame times and the screenshots to judge:** run `stevie.mjs` with the GPU flags from the bake-off's
  maintainer step above, with the generated models in `media/`. Post the report's numbers and stills on issue 77
  with the host label. Regenerating the three routes' models from the kept turnaround costs about $1.80 (fal $0.35, Meshy $0.70,
  Tripo $0.75); the turnaround itself is never regenerated.
- **fal's terms:** re-check TRELLIS.2's terms on fal's model page and record them in `media/provenance.json` before
  relying on the licence. The run could not reach fal's web pages.
- **Assetforge sheet import:** run clockgrove/assetforge's sheet import on the identity sheet. Compare its frames
  with the spike's plain crop (`atlas-sheet-albedo.png` in the output), and post the result.

CI (`tests/ci/stevie-3d.journey.browser.test.mjs`, SwiftShader) checks only that the page builds and renders. Every arm
must render every declared shot in both states, at the declared PNG size, with matching recorded hashes.
