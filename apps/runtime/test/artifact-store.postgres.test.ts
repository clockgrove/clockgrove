import { createHash } from "node:crypto";

import {
  ArtifactAccessDeniedError,
  ArtifactBlobStorageUnavailableError,
  ArtifactConflictError,
  ArtifactDecryptionError,
  type ArtifactInput,
  ArtifactIntegrityError,
  ArtifactKeyUnavailableError,
  type ArtifactLocator,
  ArtifactNotFoundError,
  InMemoryRuntimeMetrics,
  type KeyEncryptionKeys,
} from "@clockgrove/application";
import {
  dataKeyAad,
  generateDataKey,
  MemoryR2Bucket,
  PostgreSqlArtifactStore,
  WebCryptoKeyring,
} from "@clockgrove/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authorization,
  type Category,
  type JournalDatabase,
  openJournalDatabase,
  type Side,
} from "./journal-request.js";

const PUBLIC: Category[] = ["public_scene"];
const ALL: Category[] = ["public_scene", "private_cognition", "conversation", "operator_evidence"];

// One store over one runtime connection serves every tenant and ceiling. `sealed` shares that
// connection with a test keyring; the second connection is used only for the key-creation race.
let db: JournalDatabase;
let store: PostgreSqlArtifactStore;
let keyring: WebCryptoKeyring;
let sealed: PostgreSqlArtifactStore;
const keyringJson = (kekId: string, fill: number, older: Record<string, number> = {}) =>
  JSON.stringify({
    version: 1,
    current: kekId,
    keys: Object.fromEntries(
      Object.entries({ ...older, [kekId]: fill }).map(([id, byte]) => [
        id,
        Buffer.alloc(32, byte).toString("base64url"),
      ]),
    ),
  });

beforeAll(async () => {
  db = await openJournalDatabase(2);
  store = new PostgreSqlArtifactStore(db.clients[0]!);
  keyring = await WebCryptoKeyring.fromJson(keyringJson("test-kek-1", 7));
  sealed = new PostgreSqlArtifactStore(db.clients[0]!, { keyring });
}, 60_000);

afterAll(() => db?.close());

const auth = (side: Side, ceiling: Category[]) => authorization(side, ceiling) as never;

function input(
  side: Side,
  artifactId: string,
  text: string,
  change: Partial<ArtifactInput> = {},
): ArtifactInput {
  const suffix = `j-${side}`;
  return {
    tenantId: `tenant-${suffix}`,
    worldId: `world-${suffix}`,
    timelineId: `timeline-${suffix}`,
    partitionId: `partition-${suffix}`,
    spaceId: `space-${suffix}`,
    artifactId,
    bytes: new TextEncoder().encode(text),
    mediaType: "application/json",
    privacyClass: "public_scene",
    retentionClass: "durable",
    ...change,
  } as ArtifactInput;
}

const locator = ({
  bytes: _b,
  mediaType: _m,
  privacyClass: _p,
  retentionClass: _r,
  ...rest
}: ArtifactInput): ArtifactLocator => rest;
const stored = (id: string) =>
  db.truth(`SELECT string_agg(concat_ws(':', tenant_id, content_hash, inline_content IS NOT NULL, storage_key IS NULL), ',')
              FROM clockgrove.artifact_references WHERE artifact_id = '${id}'`);

describe("public artifacts in PostgreSQL", () => {
  it("put then get returns identical bytes stored inline, and contentHash is their SHA-256", async () => {
    const source = input("a", "snapshot-1:artifact", '{"state":[1,2,3]}');
    const hash = `sha256:${createHash("sha256").update(source.bytes).digest("hex")}`;
    const ref = await store.put(auth("a", PUBLIC), source);
    expect(ref).toMatchObject({
      contentHash: hash,
      byteLength: source.bytes.length,
      encryption: "none",
    });
    const read = await store.get(auth("a", PUBLIC), locator(source));
    expect(read.bytes).toEqual(source.bytes);
    expect(read.ref).toEqual(ref);
    expect(await stored("snapshot-1:artifact")).toBe(`tenant-j-a:${hash}:t:t`);
  });

  it("a retried put is idempotent; different bytes under the same ID conflict and change nothing", async () => {
    const source = input("a", "retry", '{"n":1}');
    const first = await store.put(auth("a", PUBLIC), source);
    expect(await store.put(auth("a", PUBLIC), source)).toEqual(first);
    const before = await stored("retry");
    await expect(
      store.put(auth("a", PUBLIC), input("a", "retry", '{"n":2}')),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(
      store.put(auth("a", PUBLIC), { ...source, mediaType: "text/plain" }),
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    expect(await stored("retry")).toBe(before);
  });

  it("another tenant, a ceiling without the class or any altered scope reads exactly like a missing ID", async () => {
    const own = input("a", "scoped", '{"a":1}');
    const other = input("b", "scoped", '{"b":1}');
    await store.put(auth("a", PUBLIC), own);
    await store.put(auth("b", PUBLIC), other);
    const missing = await store
      .get(auth("a", PUBLIC), { ...locator(own), artifactId: "absent" } as ArtifactLocator)
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ArtifactNotFoundError);
    const denied: [never, ArtifactLocator][] = [
      [auth("b", PUBLIC), locator(own)],
      [auth("a", ["conversation"]), locator(own)],
      [auth("a", PUBLIC), { ...locator(own), tenantId: other.tenantId }],
      ...(["worldId", "timelineId", "partitionId", "spaceId"] as const).map(
        (field): [never, ArtifactLocator] => [
          auth("a", PUBLIC),
          { ...locator(own), [field]: other[field] },
        ],
      ),
    ];
    for (const [principal, target] of denied) {
      // Alternate tenants on the one connection: a granted read of tenant b precedes each denial.
      expect((await store.get(auth("b", PUBLIC), locator(other))).bytes).toEqual(other.bytes);
      const error = await store.get(principal, target).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ArtifactNotFoundError);
      expect((error as Error).message).toBe((missing as Error).message);
    }
  });

  it("puts outside the tenant or ceiling are refused, and private or spilled inputs fail closed; none writes", async () => {
    const refusals: [never, ArtifactInput, new (id: string) => Error][] = [
      [auth("a", PUBLIC), input("b", "refused-tenant", "{}"), ArtifactAccessDeniedError],
      [auth("a", ["conversation"]), input("a", "refused-ceiling", "{}"), ArtifactAccessDeniedError],
      [
        auth("a", PUBLIC),
        input("a", "refused-partition", "{}", { partitionId: "partition-x" } as never),
        ArtifactAccessDeniedError,
      ],
      [
        auth("a", ALL),
        input("a", "refused-private", "{}", { privacyClass: "conversation" }),
        ArtifactKeyUnavailableError,
      ],
      [
        auth("a", PUBLIC),
        input("a", "refused-large", " ".repeat(131_073)),
        ArtifactBlobStorageUnavailableError,
      ],
      [
        auth("a", PUBLIC),
        input("a", "refused-binary", "x", { mediaType: "image/png" }),
        ArtifactBlobStorageUnavailableError,
      ],
    ];
    for (const [principal, attempt, refusal] of refusals) {
      await expect(store.put(principal, attempt)).rejects.toBeInstanceOf(refusal);
    }
    expect(
      await db.truth(
        "SELECT count(*) FROM clockgrove.artifact_references WHERE artifact_id LIKE 'refused-%'",
      ),
    ).toBe("0");
  });
});

describe("spilled artifacts in a bucket", () => {
  const bucket = new MemoryR2Bucket();
  const spill = () => new PostgreSqlArtifactStore(db.clients[0]!, { bucket });
  const binary = { mediaType: "application/octet-stream" } as const;
  const key = (side: Side, hash: string, retention = "durable") =>
    `${retention}/${Buffer.from(`tenant-j-${side}`).toString("hex")}/sha256/${hash.slice(7)}`;
  const location = (id: string) =>
    db.truth(
      `SELECT string_agg(concat_ws(':', storage_key, inline_content IS NULL), ',') FROM clockgrove.artifact_references WHERE artifact_id = '${id}'`,
    );

  it("large JSON and binary artifacts land at their content-addressed key with no inline bytes", async () => {
    const large = input("a", "spill-json", JSON.stringify({ pad: "x".repeat(131_072) }));
    const small = input("a", "spill-binary", "\u0001", { ...binary, retentionClass: "ephemeral" });
    for (const source of [large, small]) {
      // The bucket refuses a put without the matching sha256, so a stored object proves it was sent.
      const ref = await spill().put(auth("a", PUBLIC), source);
      const at = key("a", ref.contentHash, source.retentionClass);
      expect(bucket.objects.get(at)).toEqual(source.bytes);
      expect(await location(source.artifactId)).toBe(`${at}:t`);
      expect((await spill().get(auth("a", PUBLIC), locator(source))).bytes).toEqual(source.bytes);
    }
  });

  it.each([
    [
      "altered",
      "hash",
      (bytes: Uint8Array) => bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
    ],
    ["truncated", "size", (bytes: Uint8Array) => bytes.slice(1)],
    ["deleted", "missing", () => undefined],
  ] as const)("an %s object fails with %s and returns no bytes", async (name, reason, tamper) => {
    const source = input("a", `tamper-${name}`, `bytes-${name}`, binary);
    const at = key("a", (await spill().put(auth("a", PUBLIC), source)).contentHash);
    const changed = tamper(bucket.objects.get(at)!);
    if (changed === undefined) bucket.objects.delete(at);
    else bucket.objects.set(at, changed);
    const error = await spill()
      .get(auth("a", PUBLIC), locator(source))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArtifactIntegrityError);
    expect(error).toMatchObject({ artifactId: source.artifactId, reason });
  });

  it("the same bytes in two tenants get two keys, and a denied read never touches the bucket", async () => {
    const own = input("a", "shared", "same-bytes", binary);
    const refs = [
      await spill().put(auth("a", PUBLIC), own),
      await spill().put(auth("b", PUBLIC), input("b", "shared", "same-bytes", binary)),
    ];
    expect(refs[0]!.contentHash).toBe(refs[1]!.contentHash);
    expect(
      [key("a", refs[0]!.contentHash), key("b", refs[1]!.contentHash)].every((at) =>
        bucket.objects.has(at),
      ),
    ).toBe(true);
    const gets = bucket.gets;
    for (const [principal, target] of [
      [auth("b", PUBLIC), locator(own)],
      [auth("a", ["conversation"]), locator(own)],
      [auth("a", PUBLIC), { ...locator(own), spaceId: "space-j-b" }],
    ] as [never, ArtifactLocator][]) {
      await expect(spill().get(principal, target)).rejects.toBeInstanceOf(ArtifactNotFoundError);
    }
    expect(bucket.gets).toBe(gets);
  });

  it("records inline and spilled sizes, a corrupt object and cross-tenant refusals", async () => {
    const metrics = new InMemoryRuntimeMetrics();
    const measured = new PostgreSqlArtifactStore(db.clients[0]!, { bucket, metrics });
    const inline = input("a", "measured-inline", '{"n":1}');
    const spilled = input("a", "measured-spill", "spilled", binary);
    await measured.put(auth("a", PUBLIC), inline);
    const at = key("a", (await measured.put(auth("a", PUBLIC), spilled)).contentHash);
    bucket.objects.set(at, new TextEncoder().encode("spilleD"));
    await expect(measured.get(auth("a", PUBLIC), locator(spilled))).rejects.toMatchObject({
      reason: "hash",
    });
    await expect(measured.get(auth("b", PUBLIC), locator(inline))).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(
      measured.put(auth("a", PUBLIC), input("b", "measured-refused", "{}")),
    ).rejects.toBeInstanceOf(ArtifactAccessDeniedError);
    const point = (name: string, tenant: Side, world: Side, label: string, value: number) => ({
      name,
      tenantId: `tenant-j-${tenant}`,
      worldId: `world-j-${world}`,
      label,
      value,
    });
    expect(metrics.points).toEqual([
      point("artifact_bytes", "a", "a", "inline", 7),
      point("artifact_bytes", "a", "a", "spill", 7),
      point("artifact_integrity_failures", "a", "a", "hash", 1),
      point("rls_denials", "b", "a", "artifact_read", 1),
      point("rls_denials", "a", "b", "artifact_write", 1),
    ]);
  });

  it("a put retried over an object orphaned by a failed metadata write stores one row", async () => {
    const source = input("a", "orphan", "orphan-bytes", binary);
    const crashing = new PostgreSqlArtifactStore(
      {
        query: (sql, values) =>
          sql.includes("INSERT")
            ? Promise.reject(new Error("crash"))
            : db.clients[0]!.query(sql, values),
      },
      { bucket },
    );
    await expect(crashing.put(auth("a", PUBLIC), source)).rejects.toThrow("crash");
    const before = bucket.objects.size;
    const ref = await spill().put(auth("a", PUBLIC), source);
    expect(bucket.objects.size).toBe(before);
    expect(await location("orphan")).toBe(`${key("a", ref.contentHash)}:t`);
    expect((await spill().get(auth("a", PUBLIC), locator(source))).bytes).toEqual(source.bytes);
  });
});

describe("private artifacts are stored only as ciphertext", () => {
  const thought = '{"thought":"the lamp is lit"}';
  const secret = (side: Side, id: string, change: Partial<ArtifactInput> = {}) =>
    input(side, id, thought, { privacyClass: "private_cognition", ...change });
  const row = (id: string) => `FROM clockgrove.artifact_references WHERE artifact_id = '${id}'`;
  const decryptFailure = (side: Side, id: string) =>
    sealed.get(auth(side, ALL), locator(secret(side, id))).then(
      () => "returned bytes",
      (error: unknown) => error instanceof ArtifactIntegrityError && error.reason,
    );

  it("round-trips identical bytes; the stored bytes are a fresh envelope that never holds the plaintext", async () => {
    const ref = await sealed.put(auth("a", ALL), secret("a", "private-1"));
    expect(ref).toMatchObject({
      encryption: "aes-256-gcm-v1",
      dataKeyVersion: 1,
      byteLength: thought.length + 29,
    });
    expect((await sealed.get(auth("a", ALL), locator(secret("a", "private-1")))).bytes).toEqual(
      secret("a", "x").bytes,
    );
    expect(
      await db.truth(
        `SELECT position(convert_to('lamp', 'UTF8') IN inline_content) ${row("private-1")}`,
      ),
    ).toBe("0");
    await sealed.put(auth("a", ALL), secret("a", "private-2"));
    const bodies = `SELECT count(DISTINCT substr(inline_content, 14, ${thought.length})) FROM clockgrove.artifact_references`;
    expect(await db.truth(`${bodies} WHERE artifact_id IN ('private-1', 'private-2')`)).toBe("2");
    expect(await sealed.put(auth("a", ALL), secret("a", "private-1"))).toEqual(ref);
    const changed = secret("a", "private-1", { bytes: new TextEncoder().encode("{}") });
    await expect(sealed.put(auth("a", ALL), changed)).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("tampered ciphertext, another tenant's wrapped key and ciphertext moved to another row fail to decrypt", async () => {
    await sealed.put(auth("a", ALL), secret("a", "tampered"));
    const flipped = "set_byte(inline_content, 20, get_byte(inline_content, 20) # 1)";
    await db.truth(`UPDATE clockgrove.artifact_references SET inline_content = ${flipped},
      content_hash = 'sha256:' || encode(sha256(${flipped}), 'hex') WHERE artifact_id = 'tampered'`);
    expect(await decryptFailure("a", "tampered")).toBe("decrypt");

    await sealed.put(auth("a", ALL), secret("a", "moved-from"));
    await db.truth(`INSERT INTO clockgrove.artifact_references SELECT (jsonb_populate_record(r,
      jsonb_build_object('artifact_id', 'moved-to'))).* FROM clockgrove.artifact_references r WHERE artifact_id = 'moved-from'`);
    expect(await decryptFailure("a", "moved-to")).toBe("decrypt");

    // Tenant a's wrapped key presented as tenant b's (same world ID and class) does not unwrap, and a
    // key wrapped for tenant b in tenant a's row does not decrypt tenant a's artifacts.
    const scope = {
      tenantId: "tenant-j-b",
      worldId: "world-j-a",
      privacyClass: "private_cognition",
      keyVersion: 1,
      kekId: "test-kek-1",
    } as never;
    const own = await db.truth(
      "SELECT encode(wrapped_key, 'hex') FROM clockgrove.artifact_data_keys WHERE tenant_id = 'tenant-j-a' AND privacy_class = 'private_cognition'",
    );
    await expect(
      keyring.unwrap("test-kek-1", Buffer.from(own, "hex"), dataKeyAad(scope)),
    ).rejects.toBeInstanceOf(ArtifactDecryptionError);
    const foreign = await keyring.wrap("test-kek-1", await generateDataKey(), dataKeyAad(scope));
    await db.truth(`UPDATE clockgrove.artifact_data_keys SET wrapped_key = '\\x${Buffer.from(foreign).toString("hex")}'
      WHERE tenant_id = 'tenant-j-a' AND privacy_class = 'private_cognition'`);
    expect(await decryptFailure("a", "private-1")).toBe("decrypt");
  });

  it("a missing keyring or an unknown KEK fails closed and writes nothing", async () => {
    const evidence = (id: string) => secret("b", id, { privacyClass: "operator_evidence" });
    await expect(store.put(auth("b", ALL), evidence("keyless"))).rejects.toBeInstanceOf(
      ArtifactKeyUnavailableError,
    );
    await sealed.put(auth("b", ALL), secret("b", "old-kek"));
    await expect(store.get(auth("b", ALL), locator(secret("b", "old-kek")))).rejects.toBeInstanceOf(
      ArtifactKeyUnavailableError,
    );
    const rotatedAway = new PostgreSqlArtifactStore(db.clients[0]!, {
      keyring: await WebCryptoKeyring.fromJson(keyringJson("other-kek", 9)),
    });
    await expect(
      rotatedAway.put(auth("b", ALL), secret("b", "unknown-kek")),
    ).rejects.toBeInstanceOf(ArtifactKeyUnavailableError);
    await expect(
      rotatedAway.get(auth("b", ALL), locator(secret("b", "old-kek"))),
    ).rejects.toBeInstanceOf(ArtifactKeyUnavailableError);
    expect(await db.truth(`SELECT count(*) ${row("keyless")} OR artifact_id = 'unknown-kek'`)).toBe(
      "0",
    );
    expect(
      await db.truth(
        "SELECT count(*) FROM clockgrove.artifact_data_keys WHERE privacy_class = 'operator_evidence'",
      ),
    ).toBe("0");
  });

  it("a private artifact that spills stores only its envelope in the bucket and reads back", async () => {
    const bucket = new MemoryR2Bucket();
    const spilled = new PostgreSqlArtifactStore(db.clients[0]!, { bucket, keyring });
    const source = secret("a", "private-spill", {
      privacyClass: "conversation",
      mediaType: "application/octet-stream",
    });
    const ref = await spilled.put(auth("a", ALL), source);
    const [object, ...others] = bucket.objects.values();
    expect([others.length, object?.length, Buffer.from(object!).includes("lamp")]).toEqual([
      0,
      thought.length + 29,
      false,
    ]);
    expect(ref.byteLength).toBe(thought.length + 29);
    expect((await spilled.get(auth("a", ALL), locator(source))).bytes).toEqual(source.bytes);
  });

  it("two concurrent first puts for one tenant, world and class end with one data key", async () => {
    // Both puts must find no key and reach wrap before either inserts.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const barrier: KeyEncryptionKeys = {
      currentKekId: keyring.currentKekId,
      unwrap: (...args) => keyring.unwrap(...args),
      rewrap: (...args) => keyring.rewrap(...args),
      wrap: async (...args) => (++arrived === 2 && release(), await both, keyring.wrap(...args)),
    };
    const [first, second] = await Promise.all(
      [0, 1].map((client) =>
        new PostgreSqlArtifactStore(db.clients[client]!, { keyring: barrier }).put(
          auth("b", ALL),
          secret("b", `race-${client + 1}`, { privacyClass: "conversation" }),
        ),
      ),
    );
    expect([first?.dataKeyVersion, second?.dataKeyVersion]).toEqual([1, 1]);
    expect(
      await db.truth(
        "SELECT count(*) FROM clockgrove.artifact_data_keys WHERE privacy_class = 'conversation' AND tenant_id = 'tenant-j-b'",
      ),
    ).toBe("1");
    expect((await sealed.get(auth("b", ALL), locator(secret("b", "race-2")))).ref).toEqual(second);
  });
});

describe("key rotation keeps old data readable", () => {
  const evidence = (id: string) =>
    input("b", id, `{"evidence":"${id}"}`, { privacyClass: "operator_evidence" });
  const scope = {
    tenantId: "tenant-j-b",
    worldId: "world-j-b",
    privacyClass: "operator_evidence",
  } as never;
  const keks = (where: string) =>
    db.truth(`SELECT count(*) FROM clockgrove.artifact_data_keys WHERE ${where}`);
  // Every tenant-b artifact written so far in this file, across three classes and two key versions.
  const tenantB = ["old-kek", "race-1", "race-2", "rotated-v1", "rotated-v2"].map((id) =>
    locator(input("b", id, "")),
  );

  it("after a data key rotation old artifacts stay readable and new puts use the new version", async () => {
    expect((await sealed.put(auth("b", ALL), evidence("rotated-v1"))).dataKeyVersion).toBe(1);
    expect(await sealed.rotateDataKey(auth("b", ALL), scope)).toBe(2);
    expect((await sealed.put(auth("b", ALL), evidence("rotated-v2"))).dataKeyVersion).toBe(2);
    for (const id of ["rotated-v1", "rotated-v2"]) {
      expect((await sealed.get(auth("b", ALL), locator(evidence(id)))).bytes).toEqual(
        evidence(id).bytes,
      );
    }
  });

  it("removing the old KEK before the rewrap fails closed; after it, the new KEK alone reads everything", async () => {
    const newOnly = new PostgreSqlArtifactStore(db.clients[0]!, {
      keyring: await WebCryptoKeyring.fromJson(keyringJson("new-kek", 11)),
    });
    await expect(
      newOnly.get(auth("b", ALL), locator(evidence("rotated-v1"))),
    ).rejects.toBeInstanceOf(ArtifactKeyUnavailableError);
    await expect(newOnly.put(auth("b", ALL), evidence("too-early"))).rejects.toBeInstanceOf(
      ArtifactKeyUnavailableError,
    );
    expect(
      await db.truth(
        "SELECT count(*) FROM clockgrove.artifact_references WHERE artifact_id = 'too-early'",
      ),
    ).toBe("0");

    const both = new PostgreSqlArtifactStore(db.clients[0]!, {
      keyring: await WebCryptoKeyring.fromJson(keyringJson("new-kek", 11, { "test-kek-1": 7 })),
    });
    const tenantA = await keks("tenant_id = 'tenant-j-a' AND kek_id = 'test-kek-1'");
    expect(await both.rewrapDataKeys(auth("b", ALL), { fromKekId: "test-kek-1" })).toBe(4);
    expect(await both.rewrapDataKeys(auth("b", ALL), { fromKekId: "test-kek-1" })).toBe(0);
    expect(await keks("tenant_id = 'tenant-j-b' AND kek_id = 'test-kek-1'")).toBe("0");
    expect(await keks("tenant_id = 'tenant-j-a' AND kek_id = 'test-kek-1'")).toBe(tenantA);
    for (const at of tenantB)
      expect((await newOnly.get(auth("b", ALL), at)).ref.artifactId).toBe(at.artifactId);
    expect((await newOnly.put(auth("b", ALL), evidence("after-rewrap"))).dataKeyVersion).toBe(2);
  });
});
