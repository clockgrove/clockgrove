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
6. Pack approved assets into atlases and write `assets/reviewed`.
7. Regenerate `assets/license-report.md`.
8. Render the golden scene and get its diff approved by a human.
9. Upload the reviewed output content-addressed to the asset store.

## Layout

| Path | Content |
| --- | --- |
| `assets/manifests/<assetId>/<animationFamily>.json` | one manifest per strip |
| `assets/source/<assetId>/<animationFamily>.png` | the source strip: `frames.count` frames side by side |
| `assets/reviewed/<atlasId>.png`, `<atlasId>.animations.json` | build output, approved and licensed assets only |
| `assets/license-report.md` | generated table of every manifest |
| `assets/goldens/<packdir>.scene.png`, `.scene.json` | golden scene image and record |
| `worlds/<packdir>/presentation.json` | pack presentation metadata |

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
requires `assets/reviewed` to equal a fresh build of exactly the manifests with no
`assetDeployRefusals`, and requires the license report to be current.

## Golden approval

`update-golden` re-renders each pack's scene (frame 0 of each binding, paths, selection, night and
rain effects, integer math only). If the scene hash changed it resets approval to `pending`. A human
edits `approval` to `approved` with `reviewer` and `approvedSceneSha256`. `check` fails on any
rendering difference ("visual diff"), on a pack with `presentation.json` but no golden, and on a
golden that is not approved for its current `sceneSha256`, so a re-rendered golden cannot merge
without a human edit. The scene renders only deployable manifests, the ones upload ships; a binding
to a pending or refused manifest fails the render.

Golden parameters (issue 813 decisions). `assets/goldens/raccoons.scene.json` fixes the camera at origin
(-2000 mm, 3000 mm), 80 mm per pixel and 480 x 270 pixels, so the whole yard layout fits a 16:9
frame at a scale where 64-pixel sprites read at their footprints; the time at 79,200,000 ms (22:00)
with rain intensity 6000, so the night lighting, lantern and window glow, rain and puddles all appear
in the one approved image; and `grove.stevie` selected, so the selection effect appears too. For a
pack with no golden, `update-golden` starts from origin (0, 0), 50 mm per pixel, 800 x 600 pixels,
noon (43,200,000 ms), no rain and the first binding selected: a neutral daylight starting point that
a human adjusts in the record before approving.

## Upload

`uploadReviewedAssets` throws, uploading nothing, if any manifest is refused or the golden is not
approved for its current hash. Each output is stored at `sha256/<hex of its bytes>` (atlas PNG as
`image/png`, animation manifest as `application/json`); existing keys are skipped. The R2 adapter
takes a structural bucket binding, so no provider type enters the package.

Staging upload and the RW-0409 exit stay pending on issue 881.

## First set and how to approve it

`node worlds/raccoons/tools/generate-assets.mjs` (from the repository root) regenerates the first Raccoon World set
deterministically from the world-owned `worlds/raccoons/tools/generate-assets.ts`: Stevie, the Gracie and Juniper placeholder
variants and the kit in the `idle`, `walk`, `sniff`, `eat`, `play` and `shelter` families; the den,
trash can, feeder, mailbox, tree, plant and path tile; and the rain, puddle, lantern, window and
selection effects. The generator writes every manifest with `review.status: "pending"`, because
review is human-owned; the committed set was approved by kirkmarple-clockgrove on 2026-11-05
(issue 813 owner decision). To approve, a human reviewer inspects each source and the golden scene and sets
`review` to `{"status": "approved", "reviewer": "<login>", "reviewedAt": "<UTC time>", "notes": ...}`
in each manifest they approve. They then set the golden record's `approval` to approved for its
`sceneSha256`, and run `pnpm --filter @clockgrove/assets run build`, which writes the approved
atlases into `assets/reviewed/`. `pnpm check` and the upload refuse anything else.
