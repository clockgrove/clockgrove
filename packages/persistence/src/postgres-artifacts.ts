import type {
  ArtifactEncryption,
  ArtifactInput,
  ArtifactLocator,
  ArtifactRef,
  ArtifactRetentionClass,
  ArtifactStore,
  EncryptedPrivacyClass,
  KeyEncryptionKeys,
  RuntimeAuthorizationContext,
  RuntimeMetrics,
  WebCryptoKey,
} from "@clockgrove/application";
import {
  ArtifactAccessDeniedError,
  ArtifactBlobStorageUnavailableError,
  ArtifactConflictError,
  ArtifactDecryptionError,
  ArtifactIntegrityError,
  ArtifactKeyUnavailableError,
  ArtifactNotFoundError,
  KeyEncryptionKeyUnavailableError,
  recordMetric,
} from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCategory } from "@clockgrove/contracts";

import {
  artifactAad,
  dataKeyAad,
  generateDataKey,
  openArtifact,
  sealArtifact,
} from "./artifact-crypto.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";
import { lowercaseHex, type R2BucketLike, sha256Hex } from "./r2-bucket.js";

type Row = Readonly<Record<string, unknown>>;

/** The largest artifact stored inline in PostgreSQL (migration 0012 enforces it). */
export const ARTIFACT_INLINE_LIMIT_BYTES = 131_072;
/** The largest artifact accepted at all. */
export const ARTIFACT_MAX_BYTES = 33_554_432;

const RETENTION_CLASSES: readonly string[] = ["durable", "ephemeral"];
const REF_COLUMNS = `tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id,
  content_hash, media_type, byte_length::integer AS byte_length, privacy_class, retention_class,
  encryption, data_key_version`;
const SCOPE_FILTER = `tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND partition_id = $4
  AND space_id = $5 AND artifact_id = $6`;

/** The bytes as stored: the plaintext of a public artifact, the ciphertext envelope otherwise. */
interface StoredForm {
  readonly bytes: Uint8Array;
  readonly encryption: ArtifactEncryption;
  readonly dataKeyVersion?: number;
}

/** The scope a data key is bound to. */
export type DataKeyScope = Pick<ArtifactLocator, "tenantId" | "worldId"> & {
  readonly privacyClass: EncryptedPrivacyClass;
};

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`PostgreSQL returned a malformed ${key}`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL returned a malformed ${key}`);
  }
  return value;
}

function decodeRef(row: Row): ArtifactRef {
  const encryption = text(row, "encryption");
  const retentionClass = text(row, "retention_class");
  if (encryption !== "none" && encryption !== "aes-256-gcm-v1") {
    throw new TypeError("PostgreSQL returned a malformed encryption");
  }
  if (!RETENTION_CLASSES.includes(retentionClass)) {
    throw new TypeError("PostgreSQL returned a malformed retention_class");
  }
  return {
    tenantId: decodeOpaqueId(text(row, "tenant_id"), "TenantId"),
    worldId: decodeOpaqueId(text(row, "world_id"), "WorldId"),
    timelineId: decodeOpaqueId(text(row, "timeline_id"), "TimelineId"),
    partitionId: decodeOpaqueId(text(row, "partition_id"), "PartitionId"),
    spaceId: decodeOpaqueId(text(row, "space_id"), "SpaceId"),
    artifactId: decodeOpaqueId(text(row, "artifact_id"), "ArtifactId"),
    contentHash: text(row, "content_hash"),
    byteLength: integer(row, "byte_length"),
    mediaType: text(row, "media_type"),
    privacyClass: decodePrivacyCategory(row.privacy_class),
    retentionClass: retentionClass as ArtifactRetentionClass,
    encryption,
    ...(row.data_key_version === null ? {} : { dataKeyVersion: integer(row, "data_key_version") }),
  };
}

function scope(at: ArtifactLocator): readonly string[] {
  return [at.tenantId, at.worldId, at.timelineId, at.partitionId, at.spaceId, at.artifactId];
}

async function contentHash(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

function encryptedClass(at: { readonly privacyClass: string }): EncryptedPrivacyClass {
  const value = at.privacyClass;
  if (value === "private_cognition" || value === "conversation" || value === "operator_evidence")
    return value;
  throw new TypeError("privacy class is not stored encrypted");
}

/** `denied` hears an RLS refusal (42501); a foreign-key refusal (23503) is an unknown partition. */
function writeRefusal(error: unknown, artifactId: string, denied?: () => void): unknown {
  const code = (error as { readonly code?: unknown }).code;
  if (code === "42501") denied?.();
  return code === "42501" || code === "23503" ? new ArtifactAccessDeniedError(artifactId) : error;
}

/** Key and tag failures surface as the store's errors; no bytes are returned on either. */
async function keyed<T>(artifactId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KeyEncryptionKeyUnavailableError)
      throw new ArtifactKeyUnavailableError(artifactId);
    if (error instanceof ArtifactDecryptionError)
      throw new ArtifactIntegrityError(artifactId, "decrypt");
    throw error;
  }
}

function inlineMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.startsWith("text/");
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  const keys = Object.keys(left) as (keyof ArtifactRef)[];
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * ArtifactStore over `clockgrove.artifact_references` (migration 0012). Every call reauthorizes in
 * short authorized transactions, never inside a journal transaction: a get runs one; a private put runs
 * up to three (data-key create, artifact insert, and a re-read when an ID conflict needs a plaintext
 * compare). Bucket I/O is never inside a transaction. Reads select by the full scope under
 * RLS, then verify length and SHA-256 after COMMIT. Small JSON and text artifacts are stored inline;
 * the rest spill to `<retention>/<tenant hex>/sha256/<hex>` in the bucket, or fail closed without one.
 * Every class except `public_scene` is sealed with its (tenant, world, class) data key, wrapped by the
 * keyring's KEK, and the envelope is what is stored inline or spilled; without a keyring, or with an
 * unknown KEK, private puts and gets fail closed. Data keys are not cached. `metrics` hears each
 * stored artifact's size by placement, each integrity failure, and each RLS refusal it can tell
 * apart without a query: a put refused with 42501, and a get of another tenant's locator.
 */
export class PostgreSqlArtifactStore implements ArtifactStore {
  private readonly inlineLimitBytes: number;
  private readonly bucket: R2BucketLike | undefined;
  private readonly keyring: KeyEncryptionKeys | undefined;
  private readonly metrics: RuntimeMetrics | undefined;

  constructor(
    private readonly client: PostgreSqlClient,
    options: {
      readonly inlineLimitBytes?: number;
      readonly bucket?: R2BucketLike;
      readonly keyring?: KeyEncryptionKeys;
      readonly metrics?: RuntimeMetrics;
    } = {},
  ) {
    this.keyring = options.keyring;
    this.metrics = options.metrics;
    const limit = options.inlineLimitBytes ?? ARTIFACT_INLINE_LIMIT_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > ARTIFACT_INLINE_LIMIT_BYTES) {
      throw new RangeError(
        `inlineLimitBytes must be an integer from 0 to ${ARTIFACT_INLINE_LIMIT_BYTES}`,
      );
    }
    this.inlineLimitBytes = limit;
    this.bucket = options.bucket;
  }

  async put(
    authorization: RuntimeAuthorizationContext,
    input: ArtifactInput,
  ): Promise<ArtifactRef> {
    if (input.bytes.byteLength > ARTIFACT_MAX_BYTES) {
      throw new RangeError(`artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
    }
    if (input.mediaType === "") throw new RangeError("mediaType must not be empty");
    if (!RETENTION_CLASSES.includes(input.retentionClass)) {
      throw new RangeError("retentionClass must be durable or ephemeral");
    }
    if (input.privacyClass === "credential") {
      throw new RangeError("credential artifacts belong to the credential store");
    }
    const denied = () => this.denied(authorization, input, "artifact_write");
    const stored = await this.storedForm(authorization, input, denied);
    const { bytes: _plaintext, ...metadata } = input;
    const ref: ArtifactRef = {
      ...metadata,
      contentHash: await contentHash(stored.bytes),
      byteLength: stored.bytes.byteLength,
      encryption: stored.encryption,
      ...(stored.dataKeyVersion === undefined ? {} : { dataKeyVersion: stored.dataKeyVersion }),
    };
    // Spill: the stored bytes go to their tenant-scoped content-addressed key before any SQL, so a
    // crash leaves only an orphaned object that a retry overwrites with the same bytes. The tenant
    // segment is the hex of the UTF-8 tenant ID, which migration 0012 checks exactly.
    const inline = inlineMediaType(input.mediaType) && ref.byteLength <= this.inlineLimitBytes;
    const storageKey = inline
      ? null
      : `${ref.retentionClass}/${lowercaseHex(new TextEncoder().encode(ref.tenantId))}/sha256/${ref.contentHash.slice(7)}`;
    if (storageKey !== null) {
      if (this.bucket === undefined)
        throw new ArtifactBlobStorageUnavailableError(input.artifactId);
      await this.bucket.put(storageKey, stored.bytes, {
        sha256: ref.contentHash.slice(7),
        httpMetadata: { contentType: ref.mediaType },
      });
    }
    const find = async (): Promise<ArtifactRef | "hidden"> => {
      const found = await this.client.query(
        `SELECT ${REF_COLUMNS} FROM clockgrove.artifact_references
          WHERE tenant_id = $1 AND artifact_id = $2`,
        [input.tenantId, input.artifactId],
      );
      return found.rows.length === 1 ? decodeRef(found.rows[0] as Row) : "hidden";
    };
    let existing: ArtifactRef | "inserted" | "hidden";
    try {
      existing = await this.transaction(authorization, async () => {
        const inserted = await this.client.query(
          `INSERT INTO clockgrove.artifact_references (
             tenant_id, world_id, timeline_id, partition_id, space_id, artifact_id, content_hash,
             media_type, inline_content, byte_length, privacy_class, retention_class, encryption,
             data_key_version, storage_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (tenant_id, artifact_id) DO NOTHING
           RETURNING artifact_id`,
          [
            ...scope(input),
            ref.contentHash,
            ref.mediaType,
            inline ? stored.bytes : null,
            ref.byteLength,
            ref.privacyClass,
            ref.retentionClass,
            ref.encryption,
            ref.dataKeyVersion ?? null,
            storageKey,
          ],
        );
        return inserted.rows.length === 1 ? "inserted" : find();
      });
    } catch (error) {
      // ON CONFLICT arbitrates on the primary key only. A concurrent put of the same ID can commit
      // between its check and this insert, which then fails on artifact_references_snapshot_target
      // (23505); the committed row is compared below, read in a fresh transaction.
      if ((error as { readonly code?: unknown }).code !== "23505")
        throw writeRefusal(error, input.artifactId, denied);
      existing = await this.transaction(authorization, find);
    }
    // A retry with identical content returns the stored ref; anything else, including a row of the
    // same ID that the ceiling hides, is a conflict.
    if (existing === "inserted") {
      recordMetric(this.metrics, {
        name: "artifact_bytes",
        tenantId: input.tenantId,
        worldId: input.worldId,
        label: inline ? "inline" : "spill",
        value: ref.byteLength,
      });
      return ref;
    }
    if (
      existing !== "hidden" &&
      (await this.sameContent(authorization, existing, ref, input.bytes))
    ) {
      return existing;
    }
    throw new ArtifactConflictError(input.artifactId);
  }

  async get(
    authorization: RuntimeAuthorizationContext,
    locator: ArtifactLocator,
  ): Promise<{ readonly ref: ArtifactRef; readonly bytes: Uint8Array }> {
    try {
      return await this.read(authorization, locator);
    } catch (error) {
      if (error instanceof ArtifactIntegrityError)
        recordMetric(this.metrics, {
          name: "artifact_integrity_failures",
          tenantId: locator.tenantId,
          worldId: locator.worldId,
          label: error.reason,
          value: 1,
        });
      // RLS hides every row of another tenant, so that read is refused whether or not the ID exists.
      else if (
        error instanceof ArtifactNotFoundError &&
        locator.tenantId !== authorization.tenantId
      )
        this.denied(authorization, locator, "artifact_read");
      throw error;
    }
  }

  /** Attributed to the refused principal's tenant and the world it asked for. */
  private denied(
    authorization: RuntimeAuthorizationContext,
    at: Pick<ArtifactLocator, "worldId">,
    label: "artifact_read" | "artifact_write",
  ): void {
    recordMetric(this.metrics, {
      name: "rls_denials",
      tenantId: authorization.tenantId,
      worldId: at.worldId,
      label,
      value: 1,
    });
  }

  private async read(
    authorization: RuntimeAuthorizationContext,
    locator: ArtifactLocator,
  ): Promise<{ readonly ref: ArtifactRef; readonly bytes: Uint8Array }> {
    const row = await this.transaction(authorization, async () => {
      // The wrapped data key is joined in the same authorized SELECT; RLS hides it from a lower ceiling.
      const result = await this.client.query(
        `SELECT ${REF_COLUMNS}, inline_content, storage_key, data_key.kek_id, data_key.wrapped_key
           FROM clockgrove.artifact_references AS artifact
           LEFT JOIN LATERAL (
             SELECT kek_id, wrapped_key FROM clockgrove.artifact_data_keys AS key
              WHERE key.tenant_id = artifact.tenant_id AND key.world_id = artifact.world_id
                AND key.privacy_class = artifact.privacy_class
                AND key.key_version = artifact.data_key_version
           ) AS data_key ON true
          WHERE ${SCOPE_FILTER}`,
        scope(locator),
      );
      return result.rows[0] as Row | undefined;
    });
    if (row === undefined) throw new ArtifactNotFoundError(locator.artifactId);
    const ref = decodeRef(row);
    const inline = await this.storedBytes(row, ref);
    if (inline.byteLength !== ref.byteLength)
      throw new ArtifactIntegrityError(ref.artifactId, "size");
    if ((await contentHash(inline)) !== ref.contentHash) {
      throw new ArtifactIntegrityError(ref.artifactId, "hash");
    }
    if (ref.encryption === "none") return { ref, bytes: new Uint8Array(inline) };
    const { kek_id: kekId, wrapped_key: wrapped } = row;
    const version = ref.dataKeyVersion;
    if (
      this.keyring === undefined ||
      typeof kekId !== "string" ||
      !(wrapped instanceof Uint8Array) ||
      version === undefined
    ) {
      throw new ArtifactKeyUnavailableError(ref.artifactId);
    }
    const keyring = this.keyring;
    const bytes = await keyed(ref.artifactId, async () => {
      const at = { ...ref, privacyClass: encryptedClass(ref) };
      const key = await keyring.unwrap(
        kekId,
        wrapped,
        dataKeyAad({ ...at, keyVersion: version, kekId }),
      );
      return openArtifact(key, artifactAad({ ...at, dataKeyVersion: version }), inline);
    });
    return { ref, bytes };
  }

  /** Public bytes are stored as given; every other class is sealed under its current data key. */
  private async storedForm(
    authorization: RuntimeAuthorizationContext,
    input: ArtifactInput,
    denied: () => void,
  ): Promise<StoredForm> {
    if (input.privacyClass === "public_scene") return { bytes: input.bytes, encryption: "none" };
    if (this.keyring === undefined) throw new ArtifactKeyUnavailableError(input.artifactId);
    const at = { ...input, privacyClass: encryptedClass(input) };
    const { key, version } = await this.currentDataKey(
      authorization,
      this.keyring,
      at,
      input.artifactId,
      denied,
    );
    const bytes = await sealArtifact(
      key,
      artifactAad({ ...at, dataKeyVersion: version }),
      input.bytes,
    );
    return { bytes, encryption: "aes-256-gcm-v1", dataKeyVersion: version };
  }

  /**
   * The highest data key version for the scope, unwrapped. The first put creates version 1 in its own
   * short transaction; a concurrent creator wins through ON CONFLICT and both use the stored row.
   */
  private async currentDataKey(
    authorization: RuntimeAuthorizationContext,
    keyring: KeyEncryptionKeys,
    at: DataKeyScope,
    artifactId: string,
    denied: () => void,
  ): Promise<{ readonly key: WebCryptoKey; readonly version: number }> {
    const select = `SELECT key_version, kek_id, wrapped_key FROM clockgrove.artifact_data_keys
      WHERE tenant_id = $1 AND world_id = $2 AND privacy_class = $3 ORDER BY key_version DESC LIMIT 1`;
    const values = [at.tenantId, at.worldId, at.privacyClass];
    let row: Row;
    try {
      row = await this.transaction(authorization, async () => {
        const found = await this.client.query(select, values);
        if (found.rows[0] !== undefined) return found.rows[0] as Row;
        const kekId = keyring.currentKekId;
        const wrapped = await keyed(artifactId, async () =>
          keyring.wrap(kekId, await generateDataKey(), dataKeyAad({ ...at, keyVersion: 1, kekId })),
        );
        await this.client.query(
          `INSERT INTO clockgrove.artifact_data_keys (tenant_id, world_id, privacy_class, key_version, kek_id, wrapped_key)
           VALUES ($1, $2, $3, 1, $4, $5) ON CONFLICT DO NOTHING`,
          [...values, kekId, wrapped],
        );
        return (await this.client.query(select, values)).rows[0] as Row;
      });
    } catch (error) {
      throw writeRefusal(error, artifactId, denied);
    }
    const version = integer(row, "key_version");
    const kekId = text(row, "kek_id");
    const wrapped = row.wrapped_key;
    if (!(wrapped instanceof Uint8Array))
      throw new TypeError("PostgreSQL returned a malformed wrapped_key");
    const key = await keyed(artifactId, () =>
      keyring.unwrap(kekId, wrapped, dataKeyAad({ ...at, keyVersion: version, kekId })),
    );
    return { key, version };
  }

  /**
   * Adds data key version N+1 for the scope, wrapped under the current KEK, and returns N+1. New puts
   * use the highest version; artifacts keep the version they recorded, so nothing is re-encrypted.
   */
  async rotateDataKey(
    authorization: RuntimeAuthorizationContext,
    at: DataKeyScope,
  ): Promise<number> {
    return this.keyOperation(
      authorization,
      `${at.tenantId}/${at.worldId}/${at.privacyClass}`,
      async (keyring) => {
        const latest = await this.client.query(
          `SELECT coalesce(max(key_version), 0)::integer AS key_version FROM clockgrove.artifact_data_keys
          WHERE tenant_id = $1 AND world_id = $2 AND privacy_class = $3`,
          [at.tenantId, at.worldId, at.privacyClass],
        );
        const keyVersion = integer(latest.rows[0] as Row, "key_version") + 1;
        const kekId = keyring.currentKekId;
        const wrapped = await keyring.wrap(
          kekId,
          await generateDataKey(),
          dataKeyAad({ ...at, keyVersion, kekId }),
        );
        await this.client.query(
          `INSERT INTO clockgrove.artifact_data_keys (tenant_id, world_id, privacy_class, key_version, kek_id, wrapped_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [at.tenantId, at.worldId, at.privacyClass, keyVersion, kekId, wrapped],
        );
        return keyVersion;
      },
    );
  }

  /**
   * KEK rotation step 2: rewraps every data key wrapped under `fromKekId` that the principal can see
   * (its tenant, the classes in its ceiling) to the current KEK, changing only `kek_id` and
   * `wrapped_key`, and returns how many it rewrapped. Idempotent: a second run finds none. Remove the
   * old KEK from the keyring only once no row references it.
   */
  async rewrapDataKeys(
    authorization: RuntimeAuthorizationContext,
    { fromKekId }: { readonly fromKekId: string },
  ): Promise<number> {
    return this.keyOperation(authorization, fromKekId, async (keyring) => {
      const toKekId = keyring.currentKekId;
      if (fromKekId === toKekId) return 0;
      // NO KEY UPDATE serializes rewraps without blocking the FK's KEY SHARE lock taken by private puts.
      const rows = await this.client.query(
        `SELECT tenant_id, world_id, privacy_class, key_version, wrapped_key FROM clockgrove.artifact_data_keys
          WHERE kek_id = $1 ORDER BY world_id, privacy_class, key_version FOR NO KEY UPDATE`,
        [fromKekId],
      );
      for (const row of rows.rows as Row[]) {
        const wrapped = row.wrapped_key;
        if (!(wrapped instanceof Uint8Array))
          throw new TypeError("PostgreSQL returned a malformed wrapped_key");
        const at = {
          tenantId: decodeOpaqueId(text(row, "tenant_id"), "TenantId"),
          worldId: decodeOpaqueId(text(row, "world_id"), "WorldId"),
          privacyClass: encryptedClass({ privacyClass: text(row, "privacy_class") }),
          keyVersion: integer(row, "key_version"),
        };
        const rewrapped = await keyring.rewrap(at, fromKekId, wrapped, toKekId);
        await this.client.query(
          `UPDATE clockgrove.artifact_data_keys SET kek_id = $5, wrapped_key = $6
            WHERE tenant_id = $1 AND world_id = $2 AND privacy_class = $3 AND key_version = $4 AND kek_id = $7`,
          [at.tenantId, at.worldId, at.privacyClass, at.keyVersion, toKekId, rewrapped, fromKekId],
        );
      }
      return rows.rows.length;
    });
  }

  /**
   * Runs an operator key operation in one authorized transaction and maps failures as put does, with
   * `subject` (the key scope or KEK ID) in place of an artifact ID: no keyring or an unknown KEK is
   * `ArtifactKeyUnavailableError`, a failed unwrap `ArtifactIntegrityError('decrypt')`, a lost
   * rotation race (23505) `ArtifactConflictError`, and an RLS or FK refusal `ArtifactAccessDeniedError`.
   */
  private async keyOperation<T>(
    authorization: RuntimeAuthorizationContext,
    subject: string,
    operation: (keyring: KeyEncryptionKeys) => Promise<T>,
  ): Promise<T> {
    const keyring = this.keyring;
    if (keyring === undefined) throw new ArtifactKeyUnavailableError(subject);
    try {
      return await keyed(subject, () => this.transaction(authorization, () => operation(keyring)));
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === "23505")
        throw new ArtifactConflictError(subject);
      throw writeRefusal(error, subject);
    }
  }

  /** A retried encryption has a fresh nonce, so encrypted content is compared as plaintext. */
  private async sameContent(
    authorization: RuntimeAuthorizationContext,
    existing: ArtifactRef,
    ref: ArtifactRef,
    plaintext: Uint8Array,
  ): Promise<boolean> {
    if (ref.encryption === "none") return sameRef(existing, ref);
    const ignored = { contentHash: "", byteLength: 0, dataKeyVersion: 0 };
    if (!sameRef({ ...existing, ...ignored }, { ...ref, ...ignored })) return false;
    const { bytes } = await this.get(authorization, existing);
    return (
      bytes.length === plaintext.length && bytes.every((byte, index) => byte === plaintext[index])
    );
  }

  /** Inline bytes from the authorized row, or the bucket object at the row's own key, never the caller's. */
  private async storedBytes(row: Row, ref: ArtifactRef): Promise<Uint8Array> {
    if (row.inline_content instanceof Uint8Array) return row.inline_content;
    if (this.bucket === undefined) throw new ArtifactBlobStorageUnavailableError(ref.artifactId);
    const object = await this.bucket.get(text(row, "storage_key"));
    if (object === null) throw new ArtifactIntegrityError(ref.artifactId, "missing");
    return new Uint8Array(await object.arrayBuffer());
  }

  private async transaction<T>(
    authorization: RuntimeAuthorizationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withClientTransaction(this.client, { authorization }, operation);
  }
}
