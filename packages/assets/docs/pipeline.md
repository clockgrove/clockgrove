# Asset pipeline

Contract for `@clockgrove/assets`. The pipeline follows the nine steps of the
[Wave 4 plan, section 12](../../../docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md#12-asset-pipeline).
Manifest and presentation shapes are owned by the
[shared contracts](../../../docs/protocols/shared-contracts.md) (`AssetManifest`,
`PackPresentation`); this document does not restate them.

## Steps

1. Author or generate a source PNG and its manifest (`generated`, `authored` or `imported`).
2. Decode the manifest; the decoder enforces naming, ids, frame limits and review consistency.
3. Validate the source PNG against the manifest (validator rules below).
4. A human reviews the asset and sets `review` to `approved` with their login.
5. Check the license against `PERMITTED_ASSET_LICENSES` and the reviewer against the deploy gate.
6. Pack approved assets into atlases and write `worlds/fixture/assets/reviewed`.
7. Regenerate `worlds/fixture/assets/license-report.md`.
8. Render the golden scene and get its diff approved by a human.
9. Upload the reviewed output content-addressed to the asset store.

## Layout

| Path | Content |
| --- | --- |
| `worlds/fixture/assets/manifests/<assetId>/<animationFamily>.json` | one manifest per strip |
| `worlds/fixture/assets/source/<assetId>/<animationFamily>.png` | the source strip: `frames.count` frames side by side |
| `worlds/fixture/assets/reviewed/<atlasId>.png`, `<atlasId>.animations.json` | build output, approved and licensed assets only |
| `worlds/fixture/assets/license-report.md` | generated table of every manifest |
| `worlds/fixture/assets/goldens/fixture-reference.scene.png`, `.scene.json` | golden scene image and record |
| `worlds/fixture/reference/presentation.json` | pack presentation metadata |

## Validator rules

`validateSource` reports each failing rule; the manifest path must match the layout above.

- `contentHash` equals the SHA-256 of the source bytes.
- The PNG is 8-bit RGBA ("transparency") of `frames.width * frames.count` by `frames.height`
  ("dimensions").
- Every alpha is 0 or 255, and at least one pixel is transparent unless the role is `terrain`.
- Every opaque colour is in `palette` and every palette colour is used.
- `bounds` equals the opaque bounding box of the union of all frames, in frame coordinates.

## Packing

Strips sort by (`atlasId`, `assetId`, `animationFamily`) and are placed left to right on shelves at
most 1024 px wide; a strip that does not fit starts a new row at the previous row's y plus its tallest
strip. The atlas is the maximum extent of its strips on a transparent background. A manifest's
recorded `atlas.x/y` must equal the computed placement ("atlas location"); placements are computed
over every manifest, so a pending asset keeps its place while only approved ones are built.

Numbers: atlas width 1024 is a decision of issue 813 that keeps atlases under the 2048 px minimum texture
size WebGL guarantees; the 256 px frame edge is a decision of issue 813 (`MAX_ASSET_FRAME_EDGE`). Inputs in
any order produce identical bytes (deflate level 9, filter 0, sorted-key JSON).

## Deploy gate

`pnpm check` proves the gate on the committed `unreviewed` and `unlicensed` contract fixtures,
requires `worlds/fixture/assets/reviewed` to equal a fresh build of exactly the manifests with no
`assetDeployRefusals`, and requires the license report to be current.

## Golden approval

`update-golden` re-renders each pack's scene (frame 0 of each binding, paths, selection, night and
rain effects, integer math only). If the scene hash changed it resets approval to `pending`. A human
edits `approval` to `approved` with `reviewer` and `approvedSceneSha256`. `check` fails on any
rendering difference ("visual diff"), on a pack with `presentation.json` but no golden, and on a
golden that is not approved for its current `sceneSha256`, so a re-rendered golden cannot merge
without a human edit. The scene renders only deployable manifests, the ones upload ships; a binding
to a pending or refused manifest fails the render.

The fixture scene retains the issue 813 camera and effects coverage: origin (-2000 mm,
3000 mm), 80 mm per pixel, 480 x 270 pixels, simulation time 79,200,000 ms (22:00),
rain intensity 6000 and `fixture.keeper` selected. Its geometric placeholder image exercises
night, rain, lighting and selection rendering. The approval is synthetic test data; external
world artwork still requires its own human approval.

## Upload

`uploadReviewedAssets` throws, uploading nothing, if any manifest is refused or the golden is not
approved for its current hash. Each output is stored at `sha256/<hex of its bytes>` (atlas PNG as
`image/png`, animation manifest as `application/json`); existing keys are skipped. The R2 adapter
takes a structural bucket binding, so no provider type enters the package.

Staging upload and the RW-0409 exit stay pending on issue 3.

## Fixture placeholders

`node worlds/fixture/tools/generate-assets.mjs` regenerates neutral checkerboard rectangles
from the committed manifest frame sizes and bounds. It preserves review records, writes sources
under `worlds/fixture/assets/source`, and updates content hashes and atlas placements.
`pnpm --filter @clockgrove/assets run build` rebuilds the fixture atlas and license report;
`update-golden` renders its scene and resets changed approval as usual.

The manifests and scene record use the synthetic `fixture-reviewer` identity already used by
contract fixtures. These records test the approved branch of the deploy gate; they do not
represent a human review of external world artwork. Unreviewed and unlicensed negative controls,
source validation, exact atlas rebuilding and golden refusal checks remain enabled.

## World style data (issue 61, first part)

World authors can declare `reference/asset-style.json` beside their presentation metadata.
The [style-profile contract](../../../docs/protocols/shared-contracts.md#world-asset-style-profile)
documents the version-1 JSON format and its strict decoder. This file is presentation data,
not simulation-pack content, so editing it does not change simulation hashes or goldens.
The fixture declares binary alpha, its existing exact palette, a transparent-pixel edge
rule and 256 px frame limits for every role. Other profiles can declare soft alpha with a
bounds threshold, unrestricted colour, palette subsets, transparent borders and larger
frames within the platform envelope.

This first part supplies the format and fixture declaration. The validator, atlas builder
and CLI still use the pixel-art rules above; profile enforcement, larger manifest frames
and external-world asset commands land in subsequent parts of issue 61.
