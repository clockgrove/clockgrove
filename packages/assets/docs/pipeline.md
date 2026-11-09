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
| `worlds/fixture/assets/reviewed/<atlasId>.png`, `<atlasId>.animations.json` | build output, approved and licensed assets only, one pair per page |
| `worlds/fixture/assets/reviewed/atlases.json` | build output: every page's basename in build order, the index the local shell loads |
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
- Palette profiles check every nonzero-alpha colour against the world palette. Manifest
  palettes still list exactly the colours used by that asset. Strictness applies to the whole
  world, not to each asset: `exact` requires every declared world colour to appear in at least
  one of the world's manifests, while `subset` permits unused world colours. A single asset may
  use part of an `exact` palette. `validateSource` checks one asset; `worldPaletteProblems`
  checks the `exact` rule across the world's manifests, so `validate` (one manifest) cannot
  report it and `check`, `build` and `update-golden` do. Unrestricted profiles do not check
  the manifest palette inventory, allowing full-colour art and binary placeholders side by side.
- `transparent-pixel` requires a transparent pixel unless the role is `terrain`;
  `transparent-border` requires zero alpha on every outer edge of every frame, including terrain.
  `unrestricted` imposes no edge requirement.
- `bounds` equals the thresholded bounding box of the union of all frames, in frame coordinates.
- Profile failures use `STYLE_ALPHA`, `STYLE_PALETTE`, `STYLE_EDGE` and `STYLE_SIZE`; hash,
  frame grid, naming, PNG decoding and bounds remain platform checks under every profile.

`validateSource(manifest, bytes, manifestPath, profile)` requires an explicit decoded profile;
omission returns `STYLE_PROFILE_REQUIRED`. `check`, `build` and `update-golden` preflight every
source against the profile, then the world palette rule, then atlas placements, before writing any
reviewed or golden output. A world with no manifests under `assets/manifests` is refused with
`ASSETS_REQUIRED`. Profile and source refusals exit 1; an unknown command exits 2.

## Packing

Strips sort by (`atlasId`, `assetId`, `animationFamily`). A strip that fits one page packs as one
block. A strip at most 2048 px wide is a single row of its frames. A wider strip wraps its frames
into the fewest rows of at most 2048 px, with the frames spread evenly across them (frame `i` sits
in column `i mod columns`, row `floor(i / columns)`): an 8-frame strip of 300 px frames becomes two
rows of four, 1200 by 600 px. Each frame keeps its own rectangle in the page's animation JSON, which
the renderer reads.

A strip whose rows would pass 2048 px in height continues onto further pages. It packs as full
pages of `floor(2048 / width)` columns by `floor(2048 / height)` rows, then a last block with the
frames left over. Its first block takes the next shelf slot as usual; each further block starts a
new page at 0,0, and the next strip continues that page's shelf. A 5-frame strip of 1024 by
1024 px frames puts four frames on its first page and the fifth on the next. So every frame size
and count the manifest and profile admit can be built. Only a frame larger than a page is refused
(`ATLAS_SIZE`), and the manifest's 2048 px frame envelope already refuses that.

Each declared `atlasId` is a logical group. Its shelf width is the larger of 1024 px and its widest
block, bounded by 2048 px. Blocks are placed left to right; a block that does not fit starts a new
row at the previous row's y plus its tallest block. If the row would exceed 2048 px in height,
packing starts a new page.

The first page keeps the logical `atlasId`. Overflow pages receive deterministic kebab-case
`-page-N` suffixes, starting at 2 and skipping every declared atlas id and every previously
generated output id. Each page
writes its own PNG and animation JSON; the JSON's `atlasId` identifies the physical page. A page
lists the animations whose first frame it holds. A frame held by a later page carries that page's
`atlasId` beside its rectangle; a frame without one is on the listing page. A page that holds only
continued frames lists no animations. A page image is the maximum extent of its blocks on a
transparent background, at most 2048 by 2048 px.
`atlases.json` lists every page id in build order, so the local shell can load all of them.

A manifest's recorded `atlas.x/y` must equal its page-local computed placement ("atlas location").
Placements and page identities are computed over every manifest, so a pending asset keeps its
slot while only approved ones are built. Removing an asset from the layout can change later
placements; changing its review status does not. Existing groups that fit a 1024 px shelf and a
single page, with no strip wider than 2048 px, retain their output bytes.

Numbers: the 1024 px baseline shelf width is the issue 813 decision; the 2048 px page envelope
is WebGL's guaranteed minimum texture size. `MAX_ASSET_FRAME_EDGE` is the 2048 px manifest
envelope. The issue 813 256 px frame-edge decision applies to the fixture's declared pixel-art
profile, rather than every style. Profile frame widths remain at most 1024 px; multi-frame strips
may use the full 2048 px atlas width, wrap onto further rows beyond it and continue onto further
pages. Inputs in any order produce identical bytes (deflate level 9,
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
rain effects, integer math only). Each sprite pixel is composited source-over the opaque scene
with integer arithmetic, `(src * a + dst * (255 - a) + 127) / 255` rounded down per channel, and
the output alpha stays 255; alpha 0 leaves the scene unchanged and alpha 255 copies the colour, so
binary-alpha art renders as before. If the scene hash changed it resets approval to `pending`. A
human edits `approval` to `approved` with their `reviewer` login and `approvedSceneSha256`. `check`
fails on any rendering difference ("visual diff"), on a pack with `presentation.json` but no golden,
on a world with manifests but no presentation metadata (`GOLDEN_SCENE_REQUIRED`), on a golden that
is not approved for its current `sceneSha256` (`GOLDEN_NOT_APPROVED`), and on an approval whose
reviewer is null, blank or a GitHub `[bot]` account (`GOLDEN_REVIEWER_NOT_HUMAN`), so a
re-rendered golden cannot merge without a human edit. The scene renders only deployable manifests,
the ones upload ships; a binding to a pending or refused manifest fails the render.

The fixture scene retains the issue 813 camera and effects coverage: origin (-2000 mm,
3000 mm), 80 mm per pixel, 480 x 270 pixels, simulation time 79,200,000 ms (22:00),
rain intensity 6000 and `fixture.keeper` selected. Its geometric placeholder image exercises
night, rain, lighting and selection rendering. The approval is synthetic test data; external
world artwork still requires its own human approval.

## Upload

`uploadReviewedAssets` throws, uploading nothing, if any manifest is refused or the golden is not
approved by a human for its current hash (the same `GOLDEN_NOT_APPROVED` and
`GOLDEN_REVIEWER_NOT_HUMAN` rule as `check`). Each output is stored at `sha256/<hex of its bytes>` (atlas PNG as
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
on refusal, 0 on success. Invalid command usage or world directory exits 2, as does a
`validate` manifest that is missing or not a file (`ASSET_MANIFEST_REQUIRED`) or lies outside
the world (`ASSET_PATH_INVALID`). Unexpected internal errors exit 70. External success prints a
JSON object with `status: "ok"` and the command name. `check` also refuses
undeployable external assets, stale reviewed output, stale licence reporting,
missing or changed goldens and pending or non-human golden approval. Deploy refusals print as
`<code> <assetId>/<animationFamily>: <detail>`.

Malformed world input exits 1 with a stable code that names the file: `JSON_INVALID` for
unparseable JSON, `ASSET_MANIFEST_INVALID` and `PRESENTATION_INVALID` for decoder refusals
(with the field path), and `PACK_SCENE_INVALID` for an actor placement or anchor graph the scene
cannot read (coordinates that are not integer `$bigint` values, or an edge naming an undeclared
anchor). `build` includes only
deployable assets; human review is still required. A changed golden resets to
pending until a human records approval for the new scene hash. Existing
external local sessions serve the world's reviewed directory; the shell loads every
page its `atlases.json` lists.


## Lit material rollout

Issue 66 adds a standalone, versioned `AssetMaterial` source declaration and optional per-role
material policies on `AssetStyleProfile`; see the
[material source contract](../../../docs/protocols/shared-contracts.md#lit-material-source-declarations).
World tools supply lossless RGBA8 PNG maps and 1×/2×/optional 4× renditions. The source contract
requires albedo, permits the named companion channels, and identifies each source by a safe
world-relative path and exact SHA-256. All declared densities carry the same channels. The style
profile declares channel encoding, RGB byte ranges and a maximum adjacent-frame RGB change,
including the loop seam; alpha represents coverage separately. Those limits belong to the world,
with no implicit platform defaults.

This first part establishes decoded declarations only. `AssetManifest` and the asset CLI do not
yet accept material source declarations, and existing flat sprites build as before. Decoding a
material or style policy does not decode images or enforce grid, bounds, range or temporal
acceptance. Later parts wire those checks into the real build, pack every supplied channel and
density, encode deterministic GPU-compressed atlas delivery with a fallback, and carry the result
through projection to renderers. The atlas build owns compressed output because it creates new
packed textures; it must not require per-asset compressed input from a generation tool.
Clockgrove never derives, paints, estimates or upscales a missing map or rendition.
