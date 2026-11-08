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
Renderer material and presentation bindings remain independent of React and Three.js types.

Runtime presentation and model inputs are supplied separately from browser branding. Credentials
are environment references resolved by provider adapters and never belong in world JSON or the
browser. World identifiers remain stable in durable history; changing visual branding does not
rename world objects.

## Dependency direction

Worlds may consume platform packages; platform code may not import non-fixture worlds. The
boundary checks inspect imports and package dependency declarations, and dependency-cruiser
checks resolved module edges. The fixture is the deliberate test-world exception.

The configurable world-identifier check reports remaining references until the world extraction
lands. Its enforcement switch is intentionally off pending clockgrove/raccoon-world#1. Matching
identifiers must not confuse the platform's `clockgrove.` protocol namespace with a world's
`grove.` namespace. No broad world-name exceptions are implied by report-only mode. The scan includes JSON source;
its own identifier configuration is explicitly allowlisted in `scripts/world-boundaries.json`.

## Browser shell v1

Set `CLOCKGROVE_WORLD_SHELL` to the absolute path of a JSON document before starting Vite or
building the web app. The same input is compiled into the browser and used for the HTML title.
Without it the shell uses its neutral default, with no atlas. Set `CLOCKGROVE_WORLD_ASSETS`
to the world's reviewed static-asset directory, containing atlas files at the paths requested
by the renderer. An explicit path must name an existing directory; relative paths resolve from
Vite's working directory. Without this input the current compatibility default is
Clockgrove's `assets/reviewed`. Use absolute paths when invoking pnpm from another repository.
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
| `tokens` | CSS property/value map; only versioned `--rw-v1-*` token names are accepted. Missing properties inherit neutral defaults. The prefix is the initial token ABI, independent of the world's identity. |
| `scene.atlas` | Atlas basename, or `null` for neutral geometry without an atlas. |
| `scene.accent`, `scene.panel` | Integer RGB colors used by renderer selection graphics. |
| `scene.text` | Renderer label color. |

The shell does not interpret HTML in names or copy. Presentation data is trusted deployment
configuration, rather than player-authored content. Static asset publication remains the
composition root's responsibility. The renderer verifies the selected atlas's image digest
before using it, as described in the [scene contract](../../apps/web/docs/scene.md).

## External local session

Install a separate Clockgrove source checkout at an exact commit as described in
[pack conformance](../../packages/simulator/docs/conformance.md#external-worlds-from-a-pinned-checkout).
The local runtime also needs the repository's pinned PostgreSQL and pgvector toolchain;
see the [development reference](../runbooks/development.md). From the world repository:

```sh
node ../clockgrove/scripts/dev-yard.mjs \
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
does not require an atlas texture when `scene.atlas` is `null`.
