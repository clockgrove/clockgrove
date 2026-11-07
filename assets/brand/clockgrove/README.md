# Clockgrove logo package

Selected mark: **The Living Rings** — tree rings as persistent history, a bare hour twig, and a leafy minute branch representing a world that continues to grow.

## Master files

- `master/clockgrove-approved-original.png` — untouched approved artwork.
- `master/clockgrove-icon-cream-1024.png` — primary brand icon on warm cream.
- `master/clockgrove-icon-slate-1024.png` — full-bleed square icon for platforms that apply their own corner mask.
- `master/clockgrove-mark-transparent-1024.png` — isolated mark with alpha transparency.

`master/clockgrove-approved-original.png` is stored in Git LFS; the other brand files are ordinary Git blobs.

The Clockgrove name and this logo are the project's trademarks and are not covered by the repository's MIT license: use them to refer to Clockgrove, not to brand a fork or a derivative.

## Web files

- `web/favicon.ico` — bundled 16, 32, and 48 px favicon.
- `web/favicon-16.png`, `favicon-32.png`, `favicon-48.png` — explicit PNG sizes.
- `web/apple-touch-icon.png` — 180 px.
- `web/icon-192.png`, `web/icon-512.png` — web-app manifest sizes.

## Profile images

- `profiles/clockgrove-x-profile-400.png` — 400 px PNG, below X's 2 MB limit and safe for its circular crop.
- `profiles/clockgrove-x-header-1500x500.png` — panoramic X header with a quiet lower-left avatar zone.
- `profiles/clockgrove-gmail-profile-720.png` — recommended Gmail/Google Account upload.
- `profiles/clockgrove-gmail-profile-250.png` — compact minimum-size alternative.

Recommended HTML:

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

Recommended manifest entries:

```json
{
  "icons": [
    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}
  ]
}
```

## Usage notes

- Use the cream icon as the primary browser, app, and social-avatar treatment.
- Use slate as the approved alternate when stronger dark-background contrast is needed.
- Use the transparent mark over quiet cream, off-white, or slate surfaces.
- Do not add clock numerals, robot/AI motifs, glossy effects, or hard geometric cleanup.
- Preserve the irregular ring spacing, organic bark, bare hour twig, and leafy minute branch.
- Avoid reproducing the raster artwork as a generic auto-traced vector; its printed texture is part of the identity.
