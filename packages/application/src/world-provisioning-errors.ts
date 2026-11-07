/** The structured reason a provisioning request was refused. It is the failure evidence stored on a case. */
export interface ProvisioningRefusal {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * The request can never succeed (the artifact, tenant, seed or stored projection is wrong). The case is
 * recorded as `failed`, and the world, if any, stays non-ready.
 */
export class WorldProvisioningRefusedError extends Error implements ProvisioningRefusal {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "WorldProvisioningRefusedError";
  }

  get refusal(): ProvisioningRefusal {
    return { code: this.code, path: this.path, message: this.message };
  }
}

/** Genesis seeding failed for a reason that is not a refusal of the pack; the case stays retryable. */
export class WorldGenesisDefectError extends Error implements ProvisioningRefusal {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "WorldGenesisDefectError";
  }
}

/** A case identity was reused with a different request (a different artifact or tenant). */
export class ProvisioningCaseConflictError extends Error {
  constructor(
    readonly tenantId: string,
    readonly caseId: string,
  ) {
    super(
      `provisioning case ${caseId} of tenant ${tenantId} was already used for a different request`,
    );
    this.name = "ProvisioningCaseConflictError";
  }
}

/** A stage was attempted from a case state that does not allow it (for example a skipped stage). */
export class ProvisioningStageError extends Error {
  constructor(
    readonly caseId: string,
    readonly stage: string,
    readonly status: string,
  ) {
    super(`provisioning case ${caseId} cannot run ${stage} while ${status}`);
    this.name = "ProvisioningStageError";
  }
}

/** The tenant already holds this pack id and version with a different content hash. */
export class PackVersionConflictError extends WorldProvisioningRefusedError {
  constructor(packId: string, version: string, installedHash: string, requestedHash: string) {
    super(
      "PACK_VERSION_CONFLICT",
      "artifact.contentHash",
      `${packId}@${version} is already stored with content hash ${installedHash}; the request has ${requestedHash}`,
    );
    this.name = "PackVersionConflictError";
  }
}

/** The stored failure evidence of a case that already failed; retrying the case repeats the refusal. */
export class ProvisioningCaseFailedError extends WorldProvisioningRefusedError {
  constructor(refusal: ProvisioningRefusal) {
    super(refusal.code, refusal.path, refusal.message);
    this.name = "ProvisioningCaseFailedError";
  }
}
