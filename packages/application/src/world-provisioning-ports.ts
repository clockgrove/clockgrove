import type { WorldState } from "@clockgrove/domain";

import type { JournalExecuteRequest } from "./journal.js";
import type { EncodedPartitionState } from "./partition-state.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";
import type {
  BirthPartition,
  BirthSeedResource,
  BirthState,
  DecodeResource,
  GenesisClockPolicy,
} from "./world-birth.js";
import type { ProvisioningRefusal } from "./world-provisioning-errors.js";

/** The identity and content digests of a built world pack artifact. */
export interface ProvisioningArtifact {
  readonly packId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly engineCompatibility: string;
  readonly resourceManifestHash: string;
  readonly assetManifestHash: string;
  readonly migrationSetHash: string;
  readonly buildToolVersion: string;
}

export type ProvisioningResourceKind =
  | "archetypes"
  | "traits"
  | "actors"
  | "policies"
  | "cognitiveSeeds"
  | "spaces"
  | "rules";

/** One immutable resource of the stored artifact, with its exact bytes. */
export interface ProvisioningResource {
  readonly kind: ProvisioningResourceKind;
  readonly id: string;
  readonly version: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface GenesisSeedCommand {
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly commandId: string;
}

/** Everything a successful genesis seeding produced; the application never sees the pack source. */
export interface GenesisBirth {
  readonly artifact: ProvisioningArtifact;
  readonly world: {
    readonly tenantId: string;
    readonly worldId: string;
    readonly timelineId: string;
    readonly partitionId: string;
  };
  readonly spaces: readonly { readonly spaceId: string; readonly frameId: string }[];
  readonly clock: GenesisClockPolicy;
  readonly cognitiveSeeds: readonly {
    readonly id: string;
    readonly version: number;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly resources: readonly ProvisioningResource[];
  readonly genesisCommandId: string;
  readonly seedCommands: readonly GenesisSeedCommand[];
  readonly events: readonly unknown[];
  readonly schedules: readonly unknown[];
  readonly state: WorldState;
  readonly randomState: string;
  readonly expectedSeedProjectionHash: string;
}

/** `defect` marks an internal failure (not a refusal of the pack); it is retried, not recorded as final. */
export type GenesisOutcome =
  | { readonly ok: true; readonly birth: GenesisBirth }
  | { readonly ok: false; readonly refusal: ProvisioningRefusal; readonly defect?: true };

/** Genesis seeding runs outside any database transaction; this port is its only entry. */
export interface WorldGenesisPort {
  seed(input: {
    readonly artifact: ProvisioningArtifact;
    readonly source: unknown;
  }): Promise<GenesisOutcome>;
}

export interface ProvisionedWorld {
  readonly tenantId: string;
  readonly caseId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly installationId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly contentHash: string;
  readonly lifecycleStatus: "ready";
}

export type BeginCaseOutcome =
  | { readonly kind: "ready"; readonly world: ProvisionedWorld }
  | { readonly kind: "failed"; readonly refusal: ProvisioningRefusal }
  | {
      readonly kind: "open";
      readonly status: "requested" | "seeding" | "verified";
      readonly seededCommands: number;
      /** Content hash already stored for this pack id and version; read only while status is requested. */
      readonly storedContentHash: string | undefined;
    };

export interface CaseScope {
  readonly authorization: RuntimeAuthorizationContext;
  readonly caseId: string;
}

export interface RecordGenesisInput extends CaseScope {
  readonly artifact: ProvisioningArtifact;
  readonly resources: readonly ProvisioningResource[];
  readonly world: { readonly worldId: string; readonly timelineId: string };
  readonly partitions: readonly BirthPartition[];
  readonly birth: BirthState;
  readonly installationId: string;
  readonly journal: JournalExecuteRequest;
}

/** The initial partition state a world goes live with, on the partition that holds its kernel state. */
export interface LiveHandoff {
  readonly partition: BirthPartition;
  readonly state: EncodedPartitionState;
}

export interface BirthScope {
  readonly authorization: RuntimeAuthorizationContext;
  readonly worldId: string;
  readonly timelineId: string;
}

export interface StoredBirth {
  readonly birth: BirthState;
  readonly seedResources: readonly BirthSeedResource[];
}

/**
 * Durable provisioning state. Every method that changes rows commits one short transaction holding only
 * database work and, where it appends events, one canonical journal command.
 */
export interface WorldProvisioningStore {
  /** Creates the case or re-reads it. Throws `ProvisioningCaseConflictError` for a different request. */
  beginCase(
    input: CaseScope & {
      readonly requestHash: string;
      readonly artifact: ProvisioningArtifact;
      /** Required for a Workflow-registered case; legacy unregistered cases retain their existing identity. */
      readonly requestIdentityHash?: string;
    },
  ): Promise<BeginCaseOutcome>;
  /** Stores artifact, installation, world, partitions, birth rows and WorldGenesisCreated atomically. */
  recordGenesis(input: RecordGenesisInput): Promise<void>;
  /** Appends one seed command's event and advances the seeded-command count in one transaction. */
  applySeedCommand(
    input: CaseScope & { readonly index: number; readonly journal: JournalExecuteRequest },
  ): Promise<void>;
  /** Reads the stored birth of a world's timeline; replay starts from it too. */
  readBirth(input: BirthScope): Promise<StoredBirth>;
  commitProjectionVerified(
    input: CaseScope & { readonly journal: JournalExecuteRequest },
  ): Promise<void>;
  /**
   * Appends WorldReady, writes the initial partition state (the birth-to-live handoff), and marks the
   * world and the case ready. The only path to a ready world.
   */
  commitReady(
    input: CaseScope & { readonly journal: JournalExecuteRequest; readonly live: LiveHandoff },
  ): Promise<ProvisionedWorld>;
  /** Terminal: the case becomes `failed` with its refusal as evidence. */
  recordFailure(input: CaseScope & { readonly refusal: ProvisioningRefusal }): Promise<void>;
  /** Non-terminal: keeps the last failure of an attempt as evidence so the case can be retried. */
  recordAttemptFailure(input: CaseScope & { readonly failure: ProvisioningRefusal }): Promise<void>;
}

export interface WorldProvisioningPorts {
  readonly store: WorldProvisioningStore;
  readonly genesis: WorldGenesisPort;
  readonly decodeResource: DecodeResource;
}

export interface ProvisionWorldRequest {
  readonly authorization: RuntimeAuthorizationContext;
  readonly caseId: string;
  readonly artifact: ProvisioningArtifact;
  /** Opaque pack source handed to genesis; trusted Workflow registration stores its exact form. */
  readonly source: unknown;
  /**
   * Set only when the trusted Workflow store read the request back: the identity stored at
   * registration. A terminal case has released its source, so this identity stands in for it.
   */
  readonly registeredIdentityHash?: string;
}
