# Third-party notices

Clockgrove is MIT licensed (see [LICENSE](LICENSE)). The web app's built output and the asset
build also include or run the third-party components below. Their licences require these notices
to travel with redistributions. Every npm dependency's licence is checked by
`pnpm run verify:supply-chain` and inventoried in its SBOM; this file covers components whose own
licence differs from their npm package's.

## Basis Universal transcoder (shipped in the web app)

- Files: `basis_transcoder.js` and `basis_transcoder.wasm` from `three` 0.187.0
  (`examples/jsm/libs/basis/`), resolved from the lockfile. `apps/web` builds them into
  `dist/assets/` as `basis_transcoder-<hash>.js` and `basis_transcoder-<hash>.wasm`; the renderer
  fetches them from the app's own origin to transcode KTX2 textures.
- SHA-256 as shipped by `three` 0.187.0: `basis_transcoder.js`
  `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1`, `basis_transcoder.wasm`
  `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a`.
- Project: [Basis Universal](https://github.com/BinomialLLC/basis_universal), Binomial LLC.
- Licence: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The `three` package
  that carries it is MIT.

## Basis Universal encoder (run by the asset build)

- Files: `dist/basis/basis_encoder.js` and `basis_encoder.wasm` of `ktx2-encoder` 0.6.0, the
  `@clockgrove/assets` dependency that encodes material pages as KTX2. Built by that package from
  Basis Universal commit `1b33fd5098c6e7b58324146b8f5518cbb4cdfb72` (its `THIRD_PARTY_NOTICES.md`).
  It runs at build time and is not part of the web app's output.
- Project: [Basis Universal](https://github.com/BinomialLLC/basis_universal), Binomial LLC.
- Licence: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The `ktx2-encoder`
  package that carries it is MIT.

## Basis Universal NOTICE

Both components above reproduce this notice, as Apache License 2.0 §4(d) requires:

```text
Basis Universal™ Supercompressed GPU Texture Compression Library

Copyright © 2016–2026 Binomial LLC.
All rights reserved except as granted under the Apache 2.0 license
(https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE).
"Basis Universal" is a trademark of Binomial LLC.

The documents in the Basis Universal wiki, and the Basis Universal library,
example, and tool source code, fall under the Apache 2.0 license, unless
otherwise explicitly indicated.

Redistributions or derivative works must include a readable copy of the
attribution notices from this NOTICE file (see Apache License 2.0 §4(d)).
```
