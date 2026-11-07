import {
  ArtifactDecryptionError,
  type DataKeyBinding,
  type EncryptedPrivacyClass,
  type KeyEncryptionKeys,
  KeyEncryptionKeyUnavailableError,
  type WebCryptoKey,
} from "@clockgrove/application";
import type {
  ArtifactId,
  PartitionId,
  SpaceId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

const FORMAT_V1 = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** A v1 envelope is `0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16)`: the plaintext plus 29 bytes. */
export const ARTIFACT_ENVELOPE_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;
/** A wrapped data key is a v1 envelope around the 32 raw key bytes. */
export const WRAPPED_DATA_KEY_BYTES = ARTIFACT_ENVELOPE_OVERHEAD + KEY_BYTES;
const KEK_ID = /^[a-z0-9-]{1,64}$/u;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/u;
const encoder = new TextEncoder();

export interface ArtifactAadFields {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
  readonly artifactId: ArtifactId;
  readonly privacyClass: EncryptedPrivacyClass;
  readonly mediaType: string;
  readonly dataKeyVersion: number;
}

export interface DataKeyAadFields {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly privacyClass: EncryptedPrivacyClass;
  readonly keyVersion: number;
  readonly kekId: string;
}

/** Binds ciphertext to its row: copied into any other scope, ID, class, media type or key version, it fails. */
export function artifactAad(fields: ArtifactAadFields): Uint8Array {
  return lengthPrefixed([
    "clockgrove.artifact.v1",
    fields.tenantId,
    fields.worldId,
    fields.timelineId,
    fields.partitionId,
    fields.spaceId,
    fields.artifactId,
    fields.privacyClass,
    fields.mediaType,
    keyVersion(fields.dataKeyVersion),
  ]);
}

/** Binds a wrapped data key to its tenant, world, class, version and KEK. */
export function dataKeyAad(fields: DataKeyAadFields): Uint8Array {
  return lengthPrefixed([
    "clockgrove.dek.v1",
    fields.tenantId,
    fields.worldId,
    fields.privacyClass,
    keyVersion(fields.keyVersion),
    fields.kekId,
  ]);
}

/** A new extractable AES-256-GCM data key. Extractable only so it can be wrapped once. */
export function generateDataKey(): Promise<WebCryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Seals plaintext into a v1 envelope under a fresh random nonce. */
export function sealArtifact(
  dataKey: WebCryptoKey,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return sealArtifactWithNonce(
    dataKey,
    aad,
    plaintext,
    crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  );
}

/** Golden tests only: the package index does not export this, so production cannot pin a nonce. */
export async function sealArtifactWithNonce(
  dataKey: WebCryptoKey,
  aad: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== NONCE_BYTES) throw new RangeError("nonce must be 12 bytes");
  return frame(nonce, await crypto.subtle.encrypt(gcm(nonce, aad), dataKey, plaintext));
}

/** Opens a v1 envelope, or throws `ArtifactDecryptionError` and returns no bytes. */
export async function openArtifact(
  dataKey: WebCryptoKey,
  aad: Uint8Array,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  const [nonce, body] = unframe(envelope, ARTIFACT_ENVELOPE_OVERHEAD);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(gcm(nonce, aad), dataKey, body));
  } catch {
    throw new ArtifactDecryptionError();
  }
}

/** The keyring secret is malformed. The message never contains any of the secret text. */
export class InvalidKeyringError extends Error {
  constructor(reason: string) {
    super(`artifact keyring is invalid: ${reason}`);
    this.name = "InvalidKeyringError";
  }
}

/**
 * KEKs from the versioned `ARTIFACT_KEYRING` secret:
 * `{"version":1,"current":"<kekId>","keys":{"<kekId>":"<base64url 32 bytes>"}}`.
 * KEKs are imported non-extractable, and an unknown KEK fails closed.
 */
export class WebCryptoKeyring implements KeyEncryptionKeys {
  readonly #keys: ReadonlyMap<string, WebCryptoKey>;

  private constructor(
    readonly currentKekId: string,
    keys: ReadonlyMap<string, WebCryptoKey>,
  ) {
    this.#keys = keys;
  }

  static async fromJson(secretText: string): Promise<WebCryptoKeyring> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(secretText);
    } catch {
      throw new InvalidKeyringError("not JSON");
    }
    if (!isRecord(parsed) || Object.keys(parsed).sort().join() !== "current,keys,version") {
      throw new InvalidKeyringError("expected exactly version, current and keys");
    }
    if (parsed.version !== 1) throw new InvalidKeyringError("unsupported version");
    const entries = isRecord(parsed.keys) ? Object.entries(parsed.keys) : [];
    const keys = new Map<string, WebCryptoKey>();
    for (const [kekId, text] of entries) {
      if (!KEK_ID.test(kekId))
        throw new InvalidKeyringError("a key ID does not match ^[a-z0-9-]{1,64}$");
      keys.set(kekId, await importKek(text));
    }
    const current = parsed.current;
    if (typeof current !== "string" || !keys.has(current)) {
      throw new InvalidKeyringError("current does not name a key in keys");
    }
    return new WebCryptoKeyring(current, keys);
  }

  async wrap(kekId: string, dataKey: WebCryptoKey, aad: Uint8Array): Promise<Uint8Array> {
    const kek = this.#kek(kekId);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const wrapped = frame(nonce, await crypto.subtle.wrapKey("raw", dataKey, kek, gcm(nonce, aad)));
    if (wrapped.length !== WRAPPED_DATA_KEY_BYTES) throw new RangeError("data key must be AES-256");
    return wrapped;
  }

  unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<WebCryptoKey> {
    return this.#unwrap(kekId, wrapped, aad, false);
  }

  /** The data key is extractable only inside this call, to be wrapped again under `toKekId`. */
  async rewrap(
    binding: DataKeyBinding,
    fromKekId: string,
    wrapped: Uint8Array,
    toKekId: string,
  ): Promise<Uint8Array> {
    this.#kek(toKekId);
    const dataKey = await this.#unwrap(
      fromKekId,
      wrapped,
      dataKeyAad({ ...binding, kekId: fromKekId }),
      true,
    );
    return this.wrap(toKekId, dataKey, dataKeyAad({ ...binding, kekId: toKekId }));
  }

  async #unwrap(
    kekId: string,
    wrapped: Uint8Array,
    aad: Uint8Array,
    extractable: boolean,
  ): Promise<WebCryptoKey> {
    const kek = this.#kek(kekId);
    if (wrapped.length !== WRAPPED_DATA_KEY_BYTES) throw new ArtifactDecryptionError();
    const [nonce, body] = unframe(wrapped, WRAPPED_DATA_KEY_BYTES);
    try {
      return await crypto.subtle.unwrapKey(
        "raw",
        body,
        kek,
        gcm(nonce, aad),
        "AES-GCM",
        extractable,
        ["encrypt", "decrypt"],
      );
    } catch {
      throw new ArtifactDecryptionError();
    }
  }

  #kek(kekId: string): WebCryptoKey {
    const kek = this.#keys.get(kekId);
    if (kek === undefined) throw new KeyEncryptionKeyUnavailableError(kekId);
    return kek;
  }
}

async function importKek(text: unknown): Promise<WebCryptoKey> {
  if (typeof text !== "string" || !KEY_TEXT.test(text)) {
    throw new InvalidKeyringError("every key must be 32 bytes of unpadded base64url");
  }
  const bytes = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
  try {
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["wrapKey", "unwrapKey"]);
  } finally {
    bytes.fill(0);
  }
}

function gcm(nonce: Uint8Array, aad: Uint8Array) {
  return { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 };
}

function frame(nonce: Uint8Array, sealed: ArrayBuffer): Uint8Array {
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength);
  out[0] = FORMAT_V1;
  out.set(nonce, 1);
  out.set(new Uint8Array(sealed), 1 + NONCE_BYTES);
  return out;
}

function unframe(stored: Uint8Array, minimumLength: number): readonly [Uint8Array, Uint8Array] {
  if (stored.length < minimumLength || stored[0] !== FORMAT_V1) throw new ArtifactDecryptionError();
  return [stored.subarray(1, 1 + NONCE_BYTES), stored.subarray(1 + NONCE_BYTES)];
}

/** Each field is UTF-8 behind a u32 big-endian byte length, so no two field lists encode alike. */
function lengthPrefixed(fields: readonly string[]): Uint8Array {
  const encoded = fields.map((field) => {
    if (!field.isWellFormed()) throw new RangeError("AAD fields must be well-formed Unicode");
    return encoder.encode(field);
  });
  const out = new Uint8Array(encoded.reduce((total, bytes) => total + 4 + bytes.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.length;
  }
  return out;
}

function keyVersion(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("key version must be a positive integer");
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
