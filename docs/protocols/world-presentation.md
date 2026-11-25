# World presentation inputs

Clockgrove owns the shell and the renderer-neutral scene protocol. A world owns its name,
wordmark, design tokens, copy, atlas binding, scene presentation rules and model configuration.
These inputs do not grant authority or change canonical simulation state. Existing observation,
conversation and command grants still apply.

## Versioning and composition

The initial shell contract is version 1. A composition root supplies a world's JSON input;
platform modules must not import a world directory. Omitted shell input selects the neutral
platform theme. The fixture world demonstrates the same shell with its own name and copy.
A world's DESIGN.md is implemented as tokens in its shell input, not as a platform stylesheet.
Renderer material and presentation bindings remain independent of React and Three.js types. Optional
scene content uses a separate renderer contract, described below; it does not widen presentation v1.

Runtime presentation and model inputs are supplied separately from browser branding. Credentials
are environment references resolved by provider adapters and never belong in world JSON or the
browser. World identifiers remain stable in durable history; changing visual branding does not
rename world objects.

## Dependency direction

Worlds may consume platform packages; platform code may not import non-fixture worlds. The
boundary checks inspect imports and package dependency declarations, and dependency-cruiser
checks resolved module edges. The fixture is the deliberate test-world exception.

The world-identifier check fails the build when platform source contains a configured world
identifier. It distinguishes the platform's `clockgrove.` protocol namespace from a world's
namespace. The scan includes JSON source; its identifier configuration is explicitly allowlisted
in `scripts/world-boundaries.json`. Only `worlds/fixture` is a permitted platform world input.

## Browser shell v1

Set `CLOCKGROVE_WORLD_SHELL` to the absolute path of a JSON document before starting Vite or
building the web app. The same input is compiled into the browser and used for the HTML title.
Without it the shell uses its neutral default, with no atlas. Set `CLOCKGROVE_WORLD_ASSETS`
to the world's reviewed static-asset directory, the asset build's output: the `atlases.json`
index and each page's PNG and animation JSON it lists. An explicit path must name an existing directory; relative paths resolve from
Vite's working directory. Without this input the current compatibility default is
the world's reviewed asset directory. Use absolute paths when invoking pnpm from another repository.
For example, from an external world repository beside the pinned Clockgrove checkout:

```sh
CLOCKGROVE_WORLD_SHELL="$PWD/worlds/sample/shell.json" \
CLOCKGROVE_WORLD_ASSETS="$PWD/assets/reviewed" \
  pnpm --dir ../clockgrove --filter @clockgrove/web dev
CLOCKGROVE_WORLD_SHELL="$PWD/worlds/sample/shell.json" \
CLOCKGROVE_WORLD_ASSETS="$PWD/assets/reviewed" \
  pnpm --dir ../clockgrove --filter @clockgrove/web build
```

The document has these required fields:

| Field | Meaning |
| --- | --- |
| `shellVersion` | Exactly `1`; unsupported versions fail composition. |
| `name`, `wordmark` | Plain text title and shell heading. |
| `copy.worldLabel`, `copy.chooseWorld`, `copy.stopped` | Plain text world selector and error labels. |
| `copy.provisioning`, `copy.ready` | Plain text readiness messages, preserving each world's place terminology. |
| `tokens` | CSS property/value map; only versioned `--cg-v1-*` token names are accepted. Missing properties inherit neutral defaults. The prefix is the initial token ABI, independent of the world's identity. |
| `scene.atlases` | `true` to load every atlas page listed in the reviewed output's `atlases.json` index, which the asset build writes; `false` for neutral geometry without an atlas. |
| `scene.accent`, `scene.panel` | Integer RGB colors used by renderer selection graphics. |
| `scene.text` | Renderer label color. |
| `scene.camera` | Optional renderer-neutral `{ minZoom, maxZoom }` for the fixed isometric camera. Both factors must be finite and positive (the 640-pixel logical width divided by `minZoom` must also stay finite), with `minZoom <= 1 <= maxZoom`. Omission preserves 0.75–2. Initial framing remains zoom 1; no rotation is exposed. |

A deep-zoom world may set `scene.camera` to `{ "minZoom": 0.1, "maxZoom": 24 }`.
At the current 12.5 logical pixels per metre and 400-pixel logical view height, a 0.5 m
vertical mesh then fills 150 pixels (37.5% of the height); these example limits are a
presentation choice for issue #184’s overview-to-close-up experience, not simulation data.
The same input applies to the local shell and explicitly composed renderer content.
Viewport raster density is renderer policy: the output requests host dimensions times DPR,
with bounded effective scale per quality tier. Camera limits remain logical zoom factors
independent of backing resolution; the logical camera contains its original 640×400 view while expanding width or height to match viewport aspect; see the [scene tier policy](../../apps/web/docs/scene.md).

The shell does not interpret HTML in names or copy. Presentation data is trusted deployment
configuration, rather than player-authored content. Static asset publication remains the
composition root's responsibility. The asset upload stores the reviewed output by content hash with
a directory that maps each file name the shell requests to its key
([upload](../../packages/assets/docs/pipeline.md#upload)). The renderer verifies each atlas page's image digest
before using it, as described in the [scene contract](../../apps/web/docs/scene.md).

## External local session

Install a separate Clockgrove source checkout at an exact commit as described in
[pack conformance](../../packages/simulator/docs/conformance.md#external-worlds-from-a-pinned-checkout).
The local runtime also needs the repository's pinned PostgreSQL and pgvector toolchain;
see the [development reference](../runbooks/development.md). From the world repository:

```sh
node ../clockgrove/scripts/dev-world.mjs \
  --pack worlds/sample --shell worlds/sample/shell.json --assets assets/reviewed
```

Supply all three options together. Paths resolve from the caller's working directory, so the
world remains outside the platform checkout. The command provisions the selected pack in
disposable PostgreSQL, starts the native workerd runtime and serves the web shell with the
selected theme and static assets. It reads optional `runtime.json` beside the pack's manifest,
serializing `presentations` and `model` into the runtime bindings described below. An omitted
runtime file uses neutral presentation and the generic model defaults.

Open the printed URL and sign in with the printed local credential. That credential grants
observation only. Ctrl-C stops the session and removes its database and runtime storage;
the existing four-hour session bound also stops it. This local composition is a development
session, not a production deployment. A direct Vite invocation above serves/builds only the
browser shell; it does not provision a runtime or configure authentication.

For Raccoon World's repository layout, run the complete session from its checkout:

```sh
node ../clockgrove/scripts/dev-world.mjs \
  --pack worlds/raccoons --shell worlds/raccoons/shell.json --assets assets/reviewed
```

The selected pack's adjacent `runtime.json` supplies its presentation bindings. Hydrate that
repository's reviewed art before starting the session. To check the themed shell build in its
CI job after the [pinned conformance recipe](../../packages/simulator/docs/conformance.md#world-repository-ci-recipe):

```sh
CLOCKGROVE_WORLD_SHELL="$PWD/worlds/raccoons/shell.json" \
CLOCKGROVE_WORLD_ASSETS="$PWD/assets/reviewed" \
  pnpm --dir ../clockgrove --filter @clockgrove/web build
```

This build checks browser composition; use the local session to observe the authenticated
runtime, theme and presentation together. Inside a platform checkout the neutral development
command is `pnpm dev:world`; `CLOCKGROVE_DEV_WORLD_HOURS` overrides its session bound.
The world maintainer owns adding these commands to the external repository's workflow.

## External visual captures

Use the pinned checkout's shared Wave 4 capture suite to render the selected world's runtime,
shell and assets together:

```sh
node ../clockgrove/scripts/capture-world.mjs \
  --pack worlds/sample --shell worlds/sample/shell.json \
  --assets assets/reviewed --out tests/visual
```

This needs the same pinned native-runtime and browser toolchain as the visual suite, in addition
to the checkout's frozen dependencies. The world repository needs no npm installation. All paths
resolve from the caller's working directory; the explicit world inputs remain outside Clockgrove.
The command reads optional adjacent `runtime.json` for the selected pack. Use `--actor <id>` and
`--object <id>` when the world requires particular rail subjects; the selected actor needs recorded
Why evidence. Otherwise suitable projected entities are selected from the world.

Both WebGPU and forced WebGL2 run the same states and three viewports as the fixture caller,
including each dusk/rain quality tier, entity rails, recorded Why, recovery and text access.
The world's output directory holds the PNGs, digest reports and `approved-captures.json`.
Approval requires a person or an agent acting on the owner's explicit delegation; capture runs
and CI never approve. Changing an image invalidates its prior digest approval. See the
[pinned capture instructions](../../packages/simulator/docs/conformance.md#external-visual-goldens)
and [visual review workflow](../../tests/visual/README.md) for command results and review details.

## External renderer composition

A world can compose the product renderer directly in its own page, without a running world session,
database or sign-in. This is renderer content **version 1**, separate from shell/presentation v1:
worlds accept coupling to the Three.js version (currently **0.187.0**) of the exact Clockgrove commit
they pin. Packs declare no models and Clockgrove does not load model URLs from pack data. See the
[scene contract](../../apps/web/docs/scene.md#world-scene-content-v1) for supported materials,
coordinates, adaptation inputs, failure categories and resource ownership.

Install the pinned checkout's frozen dependencies first. Use its rendering library through
[`renderer-content.ts`](../../apps/web/src/renderer-content.ts), including its curated context or
static `THREE`/`TSL` exports; do not install another Three copy in the world. A composition root can
also pass `content` to the live `WorldApp` as an optional prop alongside its authentication port.
The shell JSON, grants and renderer-neutral presentation records remain unchanged. Omitted content
preserves the existing rendering path. Optional content-light descriptors and shadow participation
are visual composition data owned by that separate content seam; they grant no world authority.
The renderer validates and bounds them by quality tier, shares their illumination with content
and ground, and owns GPU lights and shadow resources. See the
[content lighting policy](../../apps/web/docs/scene.md#content-lights-and-shadows) for units,
limits, retirement and phone-tier behavior.

The in-repository offline example runs from the pinned checkout:

```sh
CLOCKGROVE_WORLD_SHELL="$PWD/worlds/fixture/renderer/shell.json" \
  pnpm --filter @clockgrove/web exec vite ../../worlds/fixture/renderer \
  --config vite.config.ts
```

Open the printed URL. The [fixture page](../../worlds/fixture/renderer/index.html) reads its committed
[snapshot](../../worlds/fixture/renderer/snapshot.json), generates a looping skinned mesh and normal/depth
mapped sprite in code, and offers time, weather, reduced-motion, quality and zoom controls. Its explicit shell
input sets a 0.1–96 zoom range (portrait close-ups need about 74× for a 0.5 m subject) without changing the platform default. No binaries,
credentials or canonical commands are involved. Its diagnostic capture helpers are fixture code,
not additional product renderer API.

For a separate world repository beside `../clockgrove`, add a `vite.config.ts` that reuses the pinned
web configuration. This retains its backend-compatible loader handling and resolves imported source
against that checkout's own dependency installation:

```ts
import { fileURLToPath } from "node:url";
import { mergeConfig } from "../clockgrove/apps/web/node_modules/vite/dist/node/index.js";
import platform from "../clockgrove/apps/web/vite.config.ts";

const world = fileURLToPath(new URL(".", import.meta.url));
const pinned = fileURLToPath(new URL("../clockgrove", import.meta.url));
export default mergeConfig(platform, {
  root: world,
  publicDir: `${world}/public`,
  server: { fs: { allow: [world, pinned] } },
});
```

Its HTML imports its own `main.ts` and contains a `#scene` element. A minimal content module can use
only the library supplied at composition:

```ts
import type { RendererContent } from "../clockgrove/apps/web/src/renderer-content.ts";

export const content: RendererContent = {
  version: 1,
  create({ THREE, place }) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2, 1).translate(0, 1, 0),
      new THREE.MeshStandardNodeMaterial({ color: 0x889955 }),
    );
    const anchor = new THREE.Group();
    anchor.add(body);
    place(anchor, { x: 0, y: 0 });
    root.add(anchor);
    return { root, update(frame) { body.rotation.y = frame.timeMs / 1000; } };
  },
};
```

`main.ts` decodes an actual committed `SceneProjection` JSON snapshot, including its compatibility
and scope fields, using the pinned contracts. It supplies that read-only snapshot and its content
to the adapter:

```ts
import { decodeSceneProjection } from "../clockgrove/packages/contracts/src/index.ts";
import { ThreeWorldSceneAdapter } from "../clockgrove/apps/web/src/renderer.ts";
import committed from "./snapshot.json";
import { content } from "./content.ts";

let snapshot = decodeSceneProjection(committed);
const adapter = new ThreeWorldSceneAdapter(
  document.querySelector<HTMLElement>("#scene")!,
  () => {
    adapter.loadSnapshot(snapshot);
    document.body.dataset.ready = "true";
  },
  () => { document.body.dataset.ready = "unavailable"; },
  point => {
    console.info(point);
    if (point.name === "renderer_content" && point.category === "ready")
      document.body.dataset.content = "ready";
  },
  content,
);
// Local capture controls change a copy of visual inputs; they issue no simulation command.
export function chooseEnvironment(simulationTime: bigint, rainIntensity: number) {
  snapshot = { ...snapshot, simulationTime, weather: { rainIntensity } };
  adapter.loadSnapshot(snapshot);
}
adapter.setReducedMotion(true);
window.addEventListener("pagehide", () => adapter.destroy(), { once: true });
```

Run the pinned Vite CLI from the world repository:

```sh
node ../clockgrove/apps/web/node_modules/vite/bin/vite.js --config vite.config.ts
```

For compressed assets, call `await context.loaders({ basis: "/decoders/basis/", draco:
"/decoders/draco/" })` inside `create`. Serve the Draco WASM wrapper/decoder files from the pinned
installation's `apps/web/node_modules/three/examples/jsm/libs/draco/gltf/` at the world-owned
`draco` URL. KTX2 uses the renderer's shared loader, whose Basis transcoder is built into the app
from the same pinned `three`, so the `basis` URL is not read and needs no files. KTX2 support is
detected against whichever backend Clockgrove selected; the GLTF loader is wired to KTX2, Draco and
the same pinned Meshopt decoder. No external decoder CDN or second rendering library is needed. The composition root owns
publication and access to these static assets.

A reviewed model whose look-dev images (groom maps, textures, eyes) sit beside its `.glb` is loaded
with `context.loadModel(gltf, url, models[assetId], context.qualityTier)`, where `models[assetId]` is
that model's `models.json` entry. The tier name is matched by equality against the entry's `tiers`
keys, so those keys must be the names the world passes: `low`, `medium` and `high` when it passes
`context.qualityTier`. A tier without an entry, including a free-form profile name such as `phone`
that the world never passes, draws the top-level `groom`, `textures` and `eyes`. Images the tier does
not draw are never requested, so a phone that never draws fur never downloads fur maps. Models with
embedded images load unchanged.

A browser automation tool can wait for both the page's ready marker and `data-content="ready"`,
wait for a rendered canvas, and
capture `page.locator("canvas").screenshot({ path: "frame.png" })`. Choose environment before
capture and enable reduced motion for repeatable stills. Use ordinary animation frames when
capturing motion. A canvas screenshot captures the product camera, lights, grade, bloom and tier;
it does not need the authenticated local-session command above.

### One picture

A scene is one picture. The cast and the set share lights, shadows, indirect light, fog and the grade
on every quality tier. Rim light is presentation data with a per-tier budget, which is none on every
tier today. No screen-space filter applies to the set and not the cast: painterly worlds carry
painterliness in their textures. The rule is world-agnostic and names no cast or species. The
renderer's grounding, shadow and budget rules are in
[Grounding and one picture](../../apps/web/docs/scene.md#grounding-and-one-picture-266).

Lamps belong to the same picture. The brightest of a world's content lamps (its content `lights`) is
the key lamp, the key at dusk. At the tiers whose lamp budget holds a map, it casts shadows for cast
and set alike; below, every contact shape, the cast's and the set's, takes the same cheap stand-in,
a soft shadow on the floor pointing away from the lamp. No tier's budget holds the map until the
owner's quality lab measures its frame cost at the top tier, so today every tier draws the stand-in. The rules are in
[Lamp shadows](../../apps/web/docs/scene.md#lamp-shadows-266).

Occlusion is part of the same picture: it is depth-true by default, so a character behind a trunk
is hidden like anything else behind it. Only the selected (or followed) character is revealed, after
a short dwell. World content says what may fade (canopies, roofs: `kind: "fade"`) and what never
does (trunks, posts, walls: `kind: "solid"`) through its `occluders`, each with the plain-text label
the text path uses ("Ada is behind the cedar."). The rules are in
[Occlusion and reveal](../../apps/web/docs/scene.md#occlusion-and-reveal-266).

## Surface treatments (#267)

A world remembers what its actors do to it as graded surface state: pack-declared zones whose
channels (wear, mud, depth…) sit in named, overlapping bands and keep a short ring of recent marks
([surfaces](../../packages/domain/docs/surfaces.md)). That state is canonical; its look is a *derived
look*, computed from state and presentation data, never stored. A presentation binds it through its
optional `surfaces` field:

| Field | Contract |
| --- | --- |
| `decals` | `{low, medium, high}`: the most close-range mark decals the world draws at each quality tier, integers 0–256 |
| `zones` | `[{zoneId, label}]`: the zones the world shows, each with the plain-text label the text path names it by ("The cedar's bark"); unique ids |
| `treatments` | `[{channel, band, phrase, tiers}]`: one per channel band the world draws, unique per pair. `phrase` completes a zone's label into a sentence ("is scratched"); `tiers` holds `low`, `medium` and `high`, each `{tint, opacity, marks}`: an RGB hex tint, its opacity from 0 to 1, and whether the zone's recent marks show as decals at close range on that tier |

Omitting the field keeps the presentation's encoding and draws no surface. Pack conformance refuses a
presentation that names a zone, channel or band its pack does not declare, and, with
`SURFACE_DECAL_BUDGET_EXCEEDED`, one whose decals cannot hold every mark: at each tier, the summed
`markCapacity` of the labelled zones having a channel with a treatment that draws marks on that tier
must fit that tier's `decals` (`surfaceDecalRefusal` in `@clockgrove/contracts`). The runtime reads
its own copy of the presentation, so it applies the same check where it binds that copy to the
installed policy: a scene or flashback projection over a budget too small is refused with
`SurfaceDecalBudgetRefusedError`, code `SURFACE_DECAL_BUDGET_EXCEEDED`, and draws nothing. The code
reaches the client: the scene socket sends the `disconnect` control with reason
`surface_decal_budget_exceeded` and closes 1011 ([realtime projection](realtime-projection.md)), and
the flashback route answers 500 `surface_decal_budget_exceeded`
([flashback](living-yard-observation.md)), so a client tells this refusal from a crash. The zone and mark
budgets are the pack's own (`SURFACE_BUDGET_EXCEEDED`, [SDK refusal codes](../../packages/world-pack-sdk/docs/refusal-codes.md)).
No budget is met by dropping a mark.

The runtime projects them into the scene's optional `surfaces` field
([realtime projection](realtime-projection.md)), the same way for the live scene and a flashback
frame: for each labelled zone in the policy's declaration order whose host is in the scene (a
projected object, or a region in a projected frame, given by its frame and two-axis bounds), each
channel is settled at the scene's simulation time under the rain the world holds, with its band set;
`treatments` lists the treatment of each current band that has one, in channel then band order; and
`marks` copies the zone's ring, oldest first (who, when, where, how hard). A mark's `actorId` is the
marking actor when the scene projects it and null otherwise: a scene never names an entity it does
not project. The text path's `sentence` is null when no current band has a treatment, else
`<label> <phrase>, <phrase>.`, or `<label> <phrases>; most recently by <actor>.` when the zone's
newest mark was left by a projected actor, named by its presentation binding's accessibility label,
else its scene label, for example "The cedar's bark is scratched; most recently by Keeper, a
resident." When that actor is not projected the sentence names no one; who left the mark is the
journal's answer under its own authority. Every value is a function of state and these records, so replay and catch-up
draw the same picture. The scene reader loads the installed behaviour policy only when the pack's
presentation binds surfaces. The reference fixture binds its cedar bark, fence path, porch boards
and garden bed in `presentation.json` and `runtime.json`.

## Runtime inputs

The runtime composition binds `WORLD_PRESENTATION` to a JSON array of presentation records.
Each record contains `presentation` (the existing versioned `PackPresentation` wire document),
`drawable` (available `assetId/animationFamily` pairs), and `activity` (the families whose strips
follow actor activity and the `moving`, `shelter`, `arrived`, `seeking` replacement families).
Only projected objects receive bindings. An omitted input produces no world-specific bindings
or effects. Runtime inputs are decoded at composition and reused by projection readers.

`WORLD_MODEL_CONFIG` binds a JSON object with `alias`, `modelName`, `identity`, `sceneLabel`, `commandPrefix`
and `aliases`. The alias definitions retain the model gateway's provider-neutral route,
credential-reference, token-limit, timeout and price contract. `identity` supplies the world's
actor identity, and `sceneLabel` supplies its place label; platform instructions still protect grants and treat retrieved text as untrusted.
The command prefix preserves a world's command idempotency identity across deployments.
An optional `context` object sets the world's actor context budget (`tokenBudget`, 256 to 65,536
estimated tokens, 4,096 by default) and history window (`historyWindow`, 1 to 64 messages, 16 by
default). A value out of range refuses the configuration
([context settings](context-assembly.md#world-context-settings)).
Omitted model configuration uses the generic actor defaults.

`WORLD_APPROVER` binds the world owner's approver of protected external writes that route to an
operator, `{"principal":"<id>"}` or `{"role":"<role>"}`; absent, such a write is refused
`approver_unconfigured` ([runtime runbook](../runbooks/runtime.md)). Any other value refuses the
composition.

The reference world's `runtime.json` groups these as `presentations`, `model` and `approver` and
carries `presentationVersion: 1`. Deployment tooling serializes the three fields into their corresponding
bindings; the platform does not discover or import this file. The native test composition does
this for the explicitly selected pack; the reference world's `approver` names `principal-runtime`,
the operator that composition provisions. The fixture intentionally needs no runtime presentation
configuration, proving that a world can use neutral geometry and ordinary projection labels.
An atlas-free scene still draws geometry, renders frames and supports canvas picking; readiness
does not require an atlas texture when `scene.atlases` is `false`.

### Continuous time-of-day projection

Optional `SceneLighting.environment` carries finite `daylight` in [0,1], RGB hex
`ambientColour`, nonnegative finite `ambientIntensity`, and RGB hex `backgroundColour`,
`fogColour`, `gradeColour`. These are committed presentation data, independent of renderer APIs.
Omitting the field preserves legacy consumers' binary environment. The renderer applies grade to
scene pixels before the low-tier label composite; the optional environment also lets the text path
report lamps through dawn/dusk consistently with their fading visible effects.

`defaultSceneLighting(simulationTime, weather, effects)` is the shared pure presentation default
for material worlds and offline compositions. It uses a canonical 86,400,000 ms period (the existing
scene clock convention), normalized for negative times, smooth daylight transitions centred on
06:00 and 18:00, warm horizon colours, and inverse-daylight lamp intensity. It never reads wall time.
The two-hour transition and colour palette are visual policy decisions for #184, not simulation
rules or hardware performance claims. Callers may supply their own validated lighting/environment.
Content shares the scene's continuous ambient and directional lights through its attached root,
without a per-world renderer branch. It also shares the scene's real depth (#266): `place` anchors
content at the floor's real world-space depth and scales its local axes 12.5 on all three, so a
pinned world whose models were authored against the earlier 0.01 local depth scale rechecks them
on updating its pin ([scene: real depth](../../apps/web/docs/scene.md#isometric-rules-92)). Its `update` frame retains the existing time/weather fields.
