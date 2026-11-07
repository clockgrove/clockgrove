# Named random streams

The kernel exports immutable, project-owned named random functions through its public index.
`initializeNamedRandomStreams({ version: 1, seed: "recorded-installation-seed" }, names)`
is an installation-only operation. Record this explicit non-empty seed and version before
initialization; retries reuse the recorded state. Names must be distinct non-empty strings.
Names are sorted by UTF-16 code-unit order, so input ordering does not affect canonical state.

Contract `clockgrove-random-v1` pins `pure-rand` exactly to `8.4.2` and algorithm
`pure-rand@8.4.2/xoroshiro128plus`, algorithm version 1. Each stream's seed is FNV-1a:
start at 2166136261, XOR each UTF-8 byte of
`canonicalSerialize(["clockgrove-random-v1", installationSeed.seed, streamName])`,
then multiply by 16777619 modulo 2^32. Pass that unsigned 32-bit result to the upstream
initializer. This deterministic derivation is not cryptographic; names can collide in its
32-bit seed space. Streams still advance independently. Upstream types and mutable generators
remain private to `src/random.ts`.

`drawNamedRandomStream(state, name)` returns `{ randomState, draw }` without changing its
input. The recorded metadata comes from validated state and the actual upstream `next()` result:
`rawValue` is a signed 32-bit integer represented as bigint; `drawIndex` is the zero-based
pre-draw counter. Only the selected stream advances. State words are the exact upstream
`[s01, s00, s11, s10]` signed 32-bit words, represented as bigints; all-zero state is rejected.
Counters are non-negative bigints with no fixed-width overflow. Returned state is frozen.

`serializeNamedRandomState` uses the existing canonical v1 encoding over
`["clockgrove-random-v1", sortedStreamTuples]`. Each tuple is
`[name, algorithm, "1", drawsDecimal, stateWordDecimals]`. `restoreNamedRandomState` validates
all names, shapes, words, counters, versions and exact canonical representation before returning
state. Whitespace, duplicate names, reordered tuples, extra fields and alternative numeric
spellings are refused. Persist these exact bytes and restore them to continue the exact next
draw; do not initialize again on restart. SHA-256 is computed by consumers outside the kernel.

Runtime forks and reseeding explicitly throw through `forkNamedRandomStream` and
`reseedNamedRandomStream`; missing stream draws also fail. State migration and unknown algorithm
or contract versions are unsupported. This capability does not install worlds or implement
later Wave 1 systems. Fixed golden scenarios run in Node and genuine local Workers using the
existing finite harness. This evidence is a local checkpoint, not hosted readiness or full-wave
qualification.
