---
name: realtime-visual-world
description: Rules for Clockgrove's browser projection and scene. Use when implementing or reviewing apps/web, the scene WebSocket, the convergence reducer, the Three.js scene adapter, world boot and readiness, selection, navigation between spaces, transient cues, the text path or the browser journeys.
---

# Realtime visual world

The browser renders one canonical world. It never becomes an authority for it.

## Read first

The contracts below are the authority; where this page and they differ, they win.

- `docs/protocols/realtime-projection.md`: lanes, snapshots, ordered patches, convergence, cues, arrival, navigation, audiences and privacy.
- `apps/web/README.md` and `apps/web/docs/scene.md`: the shell, the `WorldSceneAdapter`, isometric rules, asset loading and scene budgets.
- `docs/protocols/world-presentation.md`: what a world supplies (theme, atlases, scene rules) and what it may not.
- `docs/waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md`: §3 ownership, §6 wire contracts, §8 convergence, §9 scene, §11 text path, §15 suites.
- `docs/adr/clockgrove-adr-renderer-bake-off.md`: why the renderer is Three.js `WebGPURenderer` with WebGL2 fallback.

## Ownership chain

```text
PostgreSQL journal -> SpaceDO authorized projection -> browser reducer -> WorldSceneAdapter -> Three.js
```

- PostgreSQL owns every durable world fact. Reason: everything after it is rebuildable.
- The reducer owns the last contiguous authorized projection and its revision. The adapter only draws what the reducer committed.
- Three.js owns camera, depth, picking, interpolation, animation, particles and weather effects, nothing canonical.
- `WorldSceneAdapter` is the only React/renderer bridge and imports only `@clockgrove/contracts` (`tools/web-boundaries.mjs`). Reason: the renderer stays replaceable; a headless 3D fixture proves the same contract.

## Rules

- **No client authority.** The browser submits typed intents and acknowledges revisions. It never commits movement, time, inventory, weather or history; optimistic UI is limited to visibly pending controls.
- **Contiguous patches only.** Apply the next revision or nothing. A stale, duplicate or gapped patch changes nothing; recovery (backfill or fresh snapshot) belongs to the reducer.
- **Compatibility fails visibly.** A decoded but mismatched projection is discarded, never shown as live. Use the stable error codes for refresh, retry, text fallback or unsupported-version surfaces.
- **One truthful readiness path.** `WorldBootState` runs `route_resolving` to `scene_ready`; `text_ready` is the other arrived state. Never show a half-seeded world or report a canvas ready while only the text scene shows.
- **The text path is a full projection.** Every visual interaction (select, focus, actions, Why, event feed, navigation) has a keyboard and text equivalent that resolves the same entity ID. Reason: accessibility and the WebGL-loss fallback depend on it.
- **Server-returned actions only.** Render the effective actions the server's policy returned; never infer permission from a visible button, ownership or proximity.
- **Cues are presentation.** Footsteps, splashes, particles and emotes expire and dedupe; losing all of them changes no meaning. They carry no canonical repair payload and never enter the journal.
- **Motion is interpolated, not invented.** The server commits movement; the client may animate gait and smooth the camera, never pick a destination or correct physical state.
- **Keep navigation concepts apart.** Camera pan/zoom, `ChangeViewedSpace`, following an actor, embodied movement, object mobility and operator inspection are different commands. Camera location is not persona location.
- **Privacy before delivery.** Only `public_scene` enters the shared projection; `privateCognition` appears only for an audience the server allowed. On an authorization change, purge now-unauthorized state before the next render.
- **Why is evidence.** Why opens recorded command and decision evidence (`/v1/runtime/why`), never a model's guess from the current frame.
- **Renderer-neutral data.** No renderer texture IDs or sprite handles in contracts or durable IDs. A world binds semantic presentation roles to reviewed assets.
- **Budgets are sourced.** Scene limits live in `apps/web/scene-budgets.json` with their source or decision and are checked by `pnpm check`.

## Testing

Follow `docs/runbooks/testing.md`: one integration test per claim through the real path. Browser tests belong in the `include` of `tests/ci/vitest.browser.config.ts`; run the browser journey before pushing any change under `apps/web/` or `apps/runtime/`:

```
env CI=true node node_modules/vitest/vitest.mjs run --config tests/ci/vitest.browser.config.ts
```

The Wave 4 suites are `pnpm run test:projection`, `test:realtime`, `test:web` and `test:scene` (see `docs/runbooks/development.md`).

## Reject

Clickable background hotspots as world truth, renderer-specific fields in domain contracts, client-authoritative inventory or movement, unversioned scene blobs, private cognition in shared projections, fixture or static images presented as a live world.
