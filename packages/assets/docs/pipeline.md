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
5. Check the declared licence, generated provenance/provider grant and reviewer against the deploy gate.
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
- Manifest version 2 admits frame edges up to the 2048 px WebGL envelope.
- A declared `reference/asset-style.json` supplies alpha, colour, edge and per-role frame limits.
  Missing and malformed profiles are refused with `STYLE_PROFILE_REQUIRED` and `STYLE_PROFILE_INVALID`.
- Binary alpha permits only 0 and 255; soft alpha accepts all byte values. Bounds use 255 for
  binary profiles and `boundsThreshold` for soft profiles, including pixels equal to the threshold.
- Palette profiles check every nonzero-alpha colour against the world palette; `exact` requires
  every declared world colour to appear, while `subset` permits unused world colours. Manifest
  palettes still list exactly the colours used by that asset. Unrestricted profiles do not check
  the manifest palette inventory, allowing full-colour art and binary placeholders side by side.
- `transparent-pixel` requires a transparent pixel unless the role is `terrain`;
  `transparent-border` requires zero alpha on every outer edge of every frame, including terrain.
  `unrestricted` imposes no edge requirement.
- `bounds` equals the thresholded bounding box of the union of all frames, in frame coordinates.
- Profile failures use `STYLE_ALPHA`, `STYLE_PALETTE`, `STYLE_EDGE` and `STYLE_SIZE`; hash,
  frame grid, naming, PNG decoding and bounds remain platform checks under every profile.

`validateSource(manifest, bytes, manifestPath, profile)` requires an explicit decoded profile;
omission returns `STYLE_PROFILE_REQUIRED`. `check`, `build` and `update-golden` preflight every
source against the profile and check atlas placements before writing any reviewed or golden output.
Profile and source refusals exit 1; an unknown command exits 2.

## Packing

Strips sort by (`atlasId`, `assetId`, `animationFamily`). Each declared `atlasId` is a logical
group. Its shelf width is the larger of 1024 px and its widest whole strip, bounded by 2048 px.
Strips are placed left to right; a strip that does not fit starts a new row at the previous row's
y plus its tallest strip. If the row would exceed 2048 px in height, packing starts a new page.
A strip wider or taller than 2048 px is refused before atlas allocation. Strips stay contiguous;
frames are never split across pages.

The first page keeps the logical `atlasId`. Overflow pages receive deterministic kebab-case
`-page-N` suffixes, starting at 2 and skipping every declared atlas id and every previously
generated output id. Each page
writes its own PNG and animation JSON; the JSON's `atlasId` identifies the physical page. A page
image is the maximum extent of its strips on a transparent background, at most 2048 by 2048 px.

A manifest's recorded `atlas.x/y` must equal its page-local computed placement ("atlas location").
Placements and page identities are computed over every manifest, so a pending asset keeps its
slot while only approved ones are built. Removing an asset from the layout can change later
placements; changing its review status does not. Existing groups that fit a 1024 px shelf and a
single page retain their output bytes.

Numbers: the 1024 px baseline shelf width is the issue 813 decision; the 2048 px page envelope
is WebGL's guaranteed minimum texture size. `MAX_ASSET_FRAME_EDGE` is the 2048 px manifest
envelope. The issue 813 256 px frame-edge decision applies to the fixture's declared pixel-art
profile, rather than every style. Profile frame widths remain at most 1024 px; multi-frame strips
may use the full 2048 px atlas width. Inputs in any order produce identical bytes (deflate level 9,
filter 0, sorted-key JSON).

## Deploy gate

`pnpm check` proves the gate on the committed `unreviewed` and `unlicensed` contract fixtures,
requires `worlds/fixture/assets/reviewed` to equal a fresh build of exactly the manifests with no
`assetDeployRefusals`, and requires the license report to be current. Turbo caches this `check`
with every file under `worlds/` among its inputs (`turbo.json`), so an asset-only change re-runs the
gate on a warm local cache instead of replaying an earlier pass.

Generated assets use manifest version 2's complete provenance: `model`, `provider`, `route`,
`providerTermsVersion`, prompt or serialized parameters, reference hashes and `outputGrant`.
The provider grant uses the tool-neutral fields `license`, `plan`, `commercial`, `relabel` and,
when required, `attribution`; see the
[manifest contract](../../../docs/protocols/shared-contracts.md#generated-provenance).
The top-level `license` declares the asset's licence. MIT requires a commercial grant that
permits relicensing. A CC-BY-4.0 grant remains CC-BY-4.0 with its required credit line, published
in the licence report. Non-commercial or provider-retained output, incomplete provenance and
an incompatible declared licence are refused with stable deploy reasons. No refusal changes
an asset's declared licence, and provenance never replaces human review.

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

## World style data

World authors can declare `reference/asset-style.json` beside their presentation metadata.
The [style-profile contract](../../../docs/protocols/shared-contracts.md#world-asset-style-profile)
documents the version-1 JSON format and its strict decoder. This file is presentation data,
not simulation-pack content, so editing it does not change simulation hashes or goldens.
The fixture declares binary alpha, its existing exact palette, a transparent-pixel edge
rule and 256 px frame limits for every role. Other profiles can declare soft alpha with a
bounds threshold, unrestricted colour, palette subsets, transparent borders and larger
frames within the platform envelope.

The validator and fixture CLI enforce the declared profile. Manifest version 2 allows larger
frames within the platform envelope, while the declared role limits and atlas strip budget
still apply. A soft-alpha, unrestricted-colour profile continues to accept binary-alpha
placeholders alongside painterly assets. Bounded multi-atlas packing supports larger strips and
multiple pages. External-world commands accept a world location as described below. Upload retains its review/licence, generated
provenance and golden gate; it does not itself perform source/profile validation.


## External world commands

Use a separately installed, exact-commit Clockgrove checkout (see the
[pinned-checkout guide](../../simulator/docs/conformance.md)). No npm project is
required in the world repository. From any working directory:

```sh
node /path/to/clockgrove/packages/assets/bin/clockgrove-assets.mjs validate /path/to/world/assets/manifests/example/idle.json --world /path/to/world
node /path/to/clockgrove/packages/assets/bin/clockgrove-assets.mjs build --world /path/to/world
node /path/to/clockgrove/packages/assets/bin/clockgrove-assets.mjs update-golden --world /path/to/world
node /path/to/clockgrove/packages/assets/bin/clockgrove-assets.mjs check --world /path/to/world
```

The world directory holds `assets/` and `reference/`; presentation metadata,
style profile and resources live in `reference/`. Source paths remain relative
to the world directory. Reviewed atlases, the licence report and golden records
are written into that world's `assets/`. No world files are copied into the
Clockgrove checkout. Omitting `--world` preserves the fixture pipeline.

`validate` reads only the named manifest, its media and the world's style
profile, including provenance and licence refusals. Pending human review is accepted
by this generation-tool hook; build and check retain the human review gate. It prints refusals on stderr and exits 1
on refusal, 0 on success; invalid command usage or world directory exits 2,
and unexpected internal errors exit 70. External success prints a JSON object
with `status: "ok"` and the command name. `check` also refuses
undeployable external assets, stale reviewed output, stale licence reporting,
missing or changed goldens and pending golden approval. `build` includes only
deployable assets; human review is still required. A changed golden resets to
pending until a human records approval for the new scene hash. Existing
external local sessions serve the world's reviewed directory.
