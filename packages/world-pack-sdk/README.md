# @clockgrove/world-pack-sdk

Provider-neutral validation and build of world packs. It depends only on
`@clockgrove/contracts` and `@clockgrove/domain`, performs no I/O, and receives hashing and
canonical encoding through two ports:

```ts
interface WorldPackPorts {
  canonicalBytes(value: unknown): Uint8Array;
  sha256(bytes: Uint8Array): Promise<string>; // lowercase hexadecimal
}
```

`buildWorldPack(source, ports)` and `validateWorldPack(source, ports)` are total. Every refusal,
including malformed or hostile data, returns `{ ok: false, error: { code, path, message } }`; an
exception never escapes.

## Subsystem contracts

- [Source and compatibility](docs/source-and-compatibility.md): source shape, resource encoding, compatibility rules and schema upcasting.
- [Collections](docs/collections.md): spaces, rules, capabilities and seed commands.
- [Migrations](docs/migrations.md): migration documents, chain rules and planning.
- [Hashing and output](docs/hashing-and-output.md): hash inputs and the immutable build output.
- [Refusal codes](docs/refusal-codes.md): the stable refusal codes.
- [Fixtures](docs/fixtures.md): pack fixtures and the Node/workerd differential.

## Not done here

This package does not install packs or create worlds. Genesis is in `@clockgrove/simulator`
(`seedGenesis`). The runtime's world provisioning builds the pack with this package, runs genesis
and records the pack installation (Wave 2 RW-0202; see
[Durable world provisioning and readiness](../../docs/runbooks/runtime.md#durable-world-provisioning-and-readiness)).

Deferred: applying migrations to installed worlds (pack upgrade) belongs to Wave 7 §13.1
("World-pack upgrades and reusable exports") and RW-0709. This package only validates, hashes and
plans migrations.
