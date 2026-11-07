import type { PrivacyCategory, TenantId, WorldId } from "@clockgrove/contracts";

/** The WebCrypto key type, taken from the ambient global so no runtime or provider SDK type leaks in. */
export type WebCryptoKey = InstanceType<typeof CryptoKey>;

/** Classes stored only as ciphertext. `public_scene` stays plaintext; `credential` is refused. */
export type EncryptedPrivacyClass = Exclude<PrivacyCategory, "public_scene" | "credential">;

/**
 * Versioned key-encryption keys (KEKs) that wrap the per (tenant, world, class, version) data keys.
 * Project-owned, so a KMS or HSM can replace the WebCrypto keyring without touching callers.
 */
export interface KeyEncryptionKeys {
  /** The KEK that new data keys are wrapped under. */
  readonly currentKekId: string;
  /**
   * Wraps an extractable AES-256-GCM data key under a fresh nonce and returns the 61-byte stored form.
   * Throws `KeyEncryptionKeyUnavailableError` for a KEK not in the keyring.
   */
  wrap(kekId: string, dataKey: WebCryptoKey, aad: Uint8Array): Promise<Uint8Array>;
  /**
   * Returns the data key as a non-extractable AES-256-GCM key. Throws `KeyEncryptionKeyUnavailableError`
   * for a KEK not in the keyring and `ArtifactDecryptionError` when the wrapped bytes or AAD do not authenticate.
   */
  unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<WebCryptoKey>;
  /**
   * Re-wraps a stored data key from one KEK to another without exposing it to the caller, for KEK
   * rotation. The keyring builds both AADs from `binding`, so the key cannot be re-bound to another
   * scope or version. Throws as `unwrap` does; the result is a fresh 61-byte stored form.
   */
  rewrap(
    binding: DataKeyBinding,
    fromKekId: string,
    wrapped: Uint8Array,
    toKekId: string,
  ): Promise<Uint8Array>;
}

/** What a wrapped data key is bound to, besides its KEK. */
export interface DataKeyBinding {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly privacyClass: EncryptedPrivacyClass;
  readonly keyVersion: number;
}

/** The named KEK is not in the keyring. Callers fail closed: nothing is read or written. */
export class KeyEncryptionKeyUnavailableError extends Error {
  constructor(readonly kekId: string) {
    super(`key-encryption key ${kekId} is not in the keyring`);
    this.name = "KeyEncryptionKeyUnavailableError";
  }
}

/** Ciphertext or a wrapped key failed authentication (tampered, wrong key, wrong AAD or unknown format). */
export class ArtifactDecryptionError extends Error {
  constructor() {
    super("ciphertext failed authentication");
    this.name = "ArtifactDecryptionError";
  }
}
