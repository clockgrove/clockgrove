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

The shell does not interpret HTML in names or copy. Presentation data is trusted deployment
configuration, rather than player-authored content. Static asset publication remains the
composition root's responsibility. The renderer verifies each atlas page's image digest
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
preserves the existing rendering path.

The in-repository offline example runs from the pinned checkout:

```sh
pnpm --filter @clockgrove/web exec vite ../../worlds/fixture/renderer \
  --config vite.config.ts
```

Open the printed URL. The [fixture page](../../worlds/fixture/renderer/index.html) reads its committed
[snapshot](../../worlds/fixture/renderer/snapshot.json), generates a looping skinned mesh and normal/depth
mapped sprite in code, and offers time, weather, reduced-motion and quality controls. No binaries,
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
"/decoders/draco/" })` inside `create`. Serve `basis_transcoder.js` and `basis_transcoder.wasm`
from the pinned installation's `apps/web/node_modules/three/examples/jsm/libs/basis/`, and the Draco
WASM wrapper/decoder files from its `examples/jsm/libs/draco/gltf/`, at those world-owned URLs.
Use the matching files from that exact installation. KTX2 support is detected against whichever
backend Clockgrove selected; the GLTF loader is wired to KTX2, Draco and the same pinned Meshopt
decoder. No external decoder CDN or second rendering library is needed. The composition root owns
publication and access to these static assets.

A browser automation tool can wait for both the page's ready marker and `data-content="ready"`,
wait for a rendered canvas, and
capture `page.locator("canvas").screenshot({ path: "frame.png" })`. Choose environment before
capture and enable reduced motion for repeatable stills. Use ordinary animation frames when
capturing motion. A canvas screenshot captures the product camera, lights, grade, bloom and tier;
it does not need the authenticated local-session command above.

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
Omitted model configuration uses the generic actor defaults.

The reference world's `runtime.json` groups these as `presentations` and `model` and carries
`presentationVersion: 1`. Deployment tooling serializes the two fields into their corresponding
bindings; the platform does not discover or import this file. The native test composition does
this for the explicitly selected pack. The fixture intentionally needs no runtime presentation
configuration, proving that a world can use neutral geometry and ordinary projection labels.
An atlas-free scene still draws geometry, renders frames and supports canvas picking; readiness
does not require an atlas texture when `scene.atlases` is `false`.
