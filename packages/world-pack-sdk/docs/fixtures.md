# Fixtures and differential

`packages/kernel/test/pack-fixtures/` holds two independent packs (weather shelter and lantern vigil).
`weather-needs.long-run.test.ts` (`pnpm test:long-run`) builds them, refuses 26 mutated sources, checks reorder,
rebuild, version and hash-change behaviour, then runs the same code in Node and in actual workerd.
The evidence pairs every output with a complete input identity (manifest digest and each
resource's path, sha256 and byte length) and `packComparisons` compares those identities as well
as the outputs.
