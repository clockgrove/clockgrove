import type {
  ArtifactId,
  PartitionId,
  PrivacyClass,
  SpaceId,
  TenantId,
  TimelineId,
  WorldId,
} from "@clockgrove/contracts";

import type { RuntimeAuthorizationContext } from "./persistence.js";

/** `ephemeral` artifacts expire with the storage lifecycle; `durable` ones are kept. */
export type ArtifactRetentionClass = "durable" | "ephemeral";

/** `none` exactly for `public_scene`; every other stored class is AES-256-GCM envelope v1. */
export type ArtifactEncryption = "none" | "aes-256-gcm-v1";

export interface ArtifactScope {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
}

/** A read names the full scope; a row in any other scope is not found. */
export interface ArtifactLocator extends ArtifactScope {
  /**
   * Derived by the producer (for example `${snapshotId}:artifact:<compatibility>`), so a retried put
   * is idempotent.
   */
  readonly artifactId: ArtifactId;
}

export interface ArtifactInput extends ArtifactLocator {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly privacyClass: PrivacyClass;
  readonly retentionClass: ArtifactRetentionClass;
}

export interface ArtifactRef extends ArtifactLocator {
  /** `sha256:<hex>` of the stored bytes; for an encrypted class that is the ciphertext envelope. */
  readonly contentHash: string;
  /** The stored length in bytes. */
  readonly byteLength: number;
  readonly mediaType: string;
  readonly privacyClass: PrivacyClass;
  readonly retentionClass: ArtifactRetentionClass;
  readonly encryption: ArtifactEncryption;
  /** The data key version of an encrypted artifact; absent when `encryption` is `none`. */
  readonly dataKeyVersion?: number;
}

/**
 * Immutable, tenant-scoped artifact bytes with PostgreSQL metadata. Every call reauthorizes; `get`
 * returns bytes only after their length and SHA-256 match the authorized metadata.
 */
export interface ArtifactStore {
  put(authorization: RuntimeAuthorizationContext, input: ArtifactInput): Promise<ArtifactRef>;
  get(
    authorization: RuntimeAuthorizationContext,
    locator: ArtifactLocator,
  ): Promise<{ readonly ref: ArtifactRef; readonly bytes: Uint8Array }>;
}

/**
 * No artifact is readable at this locator. A missing ID, another tenant, a ceiling without the class
 * and an altered scope field give the same error, so it never reveals that an artifact exists.
 */
export class ArtifactNotFoundError extends Error {
  constructor(readonly artifactId: string) {
    super("artifact not found");
    this.name = "ArtifactNotFoundError";
  }
}

/** The write is outside the principal's tenant or ceiling, or names an unknown partition. */
export class ArtifactAccessDeniedError extends Error {
  constructor(readonly artifactId: string) {
    super("artifact write refused");
    this.name = "ArtifactAccessDeniedError";
  }
}

/** The artifact ID already holds different content or metadata. The stored row is unchanged. */
export class ArtifactConflictError extends Error {
  constructor(readonly artifactId: string) {
    super("artifact ID already holds different content");
    this.name = "ArtifactConflictError";
  }
}

/** `missing`, `size` and `hash` are storage corruption; `decrypt` is a failed key unwrap or GCM tag. */
export type ArtifactIntegrityFailure = "missing" | "size" | "hash" | "decrypt";

/** The stored bytes do not match their metadata. No bytes are returned. */
export class ArtifactIntegrityError extends Error {
  constructor(
    readonly artifactId: string,
    readonly reason: ArtifactIntegrityFailure,
  ) {
    super(`stored artifact failed verification: ${reason}`);
    this.name = "ArtifactIntegrityError";
  }
}

/** A private class needs a data key and none is available. Nothing was written or returned. */
export class ArtifactKeyUnavailableError extends Error {
  constructor(readonly artifactId: string) {
    super("no data key is available for this artifact");
    this.name = "ArtifactKeyUnavailableError";
  }
}

/** The artifact must be stored outside PostgreSQL and no blob storage is configured. */
export class ArtifactBlobStorageUnavailableError extends Error {
  constructor(readonly artifactId: string) {
    super("artifact needs blob storage, which is not configured");
    this.name = "ArtifactBlobStorageUnavailableError";
  }
}
