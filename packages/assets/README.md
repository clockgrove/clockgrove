# @clockgrove/assets

The deterministic asset pipeline: it validates reviewed source sprites, packs them into atlases,
renders a golden scene, and uploads approved, licensed output to a content-addressed store. It uses
only Node built-ins and the shared contracts.

```sh
pnpm --filter @clockgrove/assets run check          # CI gate, also part of `pnpm check`
pnpm --filter @clockgrove/assets run build          # assets/reviewed and assets/license-report.md
pnpm --filter @clockgrove/assets run update-golden  # re-render the golden scenes (resets approval)
```

Art lives outside the package: `assets/manifests`, `assets/source`, `assets/reviewed`,
`assets/goldens`, `assets/license-report.md`. Packs bind stable IDs to assets in
`worlds/<pack>/presentation.json`.

The public API (`encodePng`, `validateSource`, `buildAtlases`, `renderScene`,
`uploadReviewedAssets`, `r2AssetStore`) is exported from `src/index.ts`.

## Subsystem contracts

- [Asset pipeline](docs/pipeline.md): steps, layout, validator rules, packing, deploy gate, golden
  approval and upload keys.
