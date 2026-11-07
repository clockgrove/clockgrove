import type {
  BeginCaseOutcome,
  BirthElementKind,
  BirthRandomStreamRow,
  BirthScheduleRow,
  BirthScope,
  BirthSectionName,
  BirthSectionRow,
  BirthSeedResource,
  BirthSpaceRow,
  BirthState,
  CanonicalNode,
  CaseScope,
  JournalExecuteRequest,
  LiveHandoff,
  ProvisionedWorld,
  ProvisioningArtifact,
  ProvisioningRefusal,
  RecordGenesisInput,
  RuntimeAuthorizationContext,
  StoredBirth,
  WorldProvisioningStore,
} from "@clockgrove/application";
import {
  BIRTH_VERSION,
  ProvisioningCaseConflictError,
  ProvisioningStageError,
} from "@clockgrove/application";

import { executeJournalStatement, mapDatabaseError } from "./postgres-journal.js";
import { insertBirthSchedules } from "./postgres-schedules.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

/** Every seed/projection boundary where a test can interrupt provisioning. */
export type ProvisioningFaultPoint =
  | "genesis"
  | "projection-verified"
  | "ready"
  | `seed-command-${number}`;

export interface PostgreSqlWorldProvisioningTestHooks {
  /** Test-only: throws at `point`, before or after that stage's transaction commits. */
  readonly fault?: {
    readonly point: ProvisioningFaultPoint;
    readonly when: "before-commit" | "after-commit";
  };
}

export class ProvisioningFaultInjectedError extends Error {
  constructor(
    readonly point: ProvisioningFaultPoint,
    readonly when: "before-commit" | "after-commit",
  ) {
    super(`provisioning fault injected ${when} at ${point}`);
    this.name = "ProvisioningFaultInjectedError";
  }
}

type Row = Readonly<Record<string, unknown>>;
type OpenStatus = "requested" | "seeding" | "verified";

function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("PostgreSQL returned a malformed row");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(source: Row, column: string): string {
  const value = source[column];
  if (typeof value !== "string") throw new TypeError(`PostgreSQL column ${column} is not text`);
  return value;
}

function integer(source: Row, column: string): number {
  const value = source[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL column ${column} is not an integer`);
  }
  return value;
}

function node(source: Row, column: string): CanonicalNode {
  const value = source[column];
  if (!Array.isArray(value)) throw new TypeError(`PostgreSQL column ${column} is not a node`);
  return value;
}

function bytes(source: Row, column: string): Uint8Array {
  const value = source[column];
  if (!(value instanceof Uint8Array))
    throw new TypeError(`PostgreSQL column ${column} is not bytes`);
  return value;
}

function textArray(source: Row, column: string): string[] {
  const value = source[column];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`PostgreSQL column ${column} is not a text array`);
  }
  return value.map(String);
}

function refusalOf(value: unknown): ProvisioningRefusal {
  const stored = row(value);
  return {
    code: text(stored, "code"),
    path: text(stored, "path"),
    message: text(stored, "message"),
  };
}

function openStatus(status: string): OpenStatus | undefined {
  return status === "requested" || status === "seeding" || status === "verified"
    ? status
    : undefined;
}

function sectionName(value: string): BirthSectionName {
  if (
    value === "environment" ||
    value === "ecology" ||
    value === "wellbeing" ||
    value === "lifecycle"
  ) {
    return value;
  }
  throw new TypeError(`unknown birth section ${value}`);
}

function elementKind(value: string): BirthElementKind {
  if (value === "frame" || value === "region" || value === "anchor-graph" || value === "entity") {
    return value;
  }
  throw new TypeError(`unknown birth element kind ${value}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface LockedCase {
  readonly status: string;
  readonly seededCommands: number;
  /** Absent only while the case is still `requested`. */
  readonly worldId: string | undefined;
}

/**
 * PostgreSQL implementation of the world provisioning store. Each method commits exactly one short
 * transaction of database work (events only through `clockgrove.execute_journal`).
 */
export class PostgreSqlWorldProvisioningStore implements WorldProvisioningStore {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly testHooks: PostgreSqlWorldProvisioningTestHooks = {},
  ) {}

  async beginCase(
    input: CaseScope & {
      readonly requestHash: string;
      readonly artifact: ProvisioningArtifact;
      readonly requestIdentityHash?: string;
    },
  ): Promise<BeginCaseOutcome> {
    const { authorization, caseId, requestHash, artifact } = input;
    const tenantId = authorization.tenantId;
    return this.transaction<BeginCaseOutcome>(authorization, undefined, async () => {
      const inserted = await this.client.query(
        `INSERT INTO clockgrove_birth.provisioning_cases
           (tenant_id, case_id, request_hash, pack_id, pack_version, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, case_id) DO NOTHING
         RETURNING case_id`,
        [tenantId, caseId, requestHash, artifact.packId, artifact.version, artifact.contentHash],
      );
      const created = inserted.rows.length === 1;
      const locked = await this.client.query(
        `SELECT request_hash, workflow_request_hash, status, seeded_commands, failure
           FROM clockgrove_birth.provisioning_cases
          WHERE tenant_id = $1 AND case_id = $2
            FOR UPDATE`,
        [tenantId, caseId],
      );
      const stored = row(locked.rows[0]);
      if (text(stored, "request_hash") !== requestHash) {
        throw new ProvisioningCaseConflictError(tenantId, caseId);
      }
      if (
        stored.workflow_request_hash !== null &&
        stored.workflow_request_hash !== input.requestIdentityHash
      ) {
        throw new ProvisioningCaseConflictError(tenantId, caseId);
      }
      const status = text(stored, "status");
      if (status === "ready") {
        return { kind: "ready", world: await this.readProvisioned(tenantId, caseId) };
      }
      if (status === "failed") return { kind: "failed", refusal: refusalOf(stored.failure) };
      const open = openStatus(status);
      if (open === undefined) throw new TypeError(`unknown provisioning case status ${status}`);
      if (!created) {
        await this.client.query(
          `UPDATE clockgrove_birth.provisioning_cases
              SET attempts = attempts + 1, updated_at = statement_timestamp()
            WHERE tenant_id = $1 AND case_id = $2`,
          [tenantId, caseId],
        );
      }
      let storedContentHash: string | undefined;
      if (open === "requested") {
        const existing = await this.client.query(
          `SELECT content_hash FROM clockgrove_birth.pack_artifacts
            WHERE tenant_id = $1 AND pack_id = $2 AND pack_version = $3`,
          [tenantId, artifact.packId, artifact.version],
        );
        const found = existing.rows[0];
        if (found !== undefined) storedContentHash = text(row(found), "content_hash");
      }
      return {
        kind: "open",
        status: open,
        seededCommands: integer(stored, "seeded_commands"),
        storedContentHash,
      };
    });
  }

  async recordGenesis(input: RecordGenesisInput): Promise<void> {
    const { authorization, caseId, artifact, world, birth } = input;
    const tenantId = authorization.tenantId;
    await this.transaction(authorization, "genesis", async () => {
      const current = await this.expectStatus(tenantId, caseId, "recordGenesis", "requested");
      if (current.status !== "requested") return;
      await this.client.query(
        `INSERT INTO clockgrove_birth.pack_artifacts
           (tenant_id, pack_id, pack_version, content_hash, engine_compatibility,
            resource_manifest_hash, asset_manifest_hash, migration_set_hash, build_tool_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          artifact.packId,
          artifact.version,
          artifact.contentHash,
          artifact.engineCompatibility,
          artifact.resourceManifestHash,
          artifact.assetManifestHash,
          artifact.migrationSetHash,
          artifact.buildToolVersion,
        ],
      );
      for (const resource of input.resources) {
        await this.client.query(
          `INSERT INTO clockgrove_birth.pack_artifact_resources
             (tenant_id, pack_id, pack_version, resource_kind, resource_id, resource_version, path, sha256, content)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            tenantId,
            artifact.packId,
            artifact.version,
            resource.kind,
            resource.id,
            resource.version,
            resource.path,
            resource.sha256,
            resource.bytes,
          ],
        );
      }
      await this.client.query(
        `INSERT INTO clockgrove.worlds (tenant_id, world_id, lifecycle_status)
         VALUES ($1, $2, 'initializing')`,
        [tenantId, world.worldId],
      );
      await this.client.query(
        `INSERT INTO clockgrove.timelines (tenant_id, world_id, timeline_id) VALUES ($1, $2, $3)`,
        [tenantId, world.worldId, world.timelineId],
      );
      for (const partition of input.partitions) {
        await this.client.query(
          `INSERT INTO clockgrove.timeline_partitions
             (tenant_id, world_id, timeline_id, partition_id, space_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, world.worldId, world.timelineId, partition.partitionId, partition.spaceId],
        );
        await this.client.query(
          `INSERT INTO clockgrove.streams
             (tenant_id, world_id, timeline_id, partition_id, space_id, stream_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenantId,
            world.worldId,
            world.timelineId,
            partition.partitionId,
            partition.spaceId,
            partition.streamId,
          ],
        );
      }
      await this.insertBirth(tenantId, world, artifact, birth);
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET world_id = $3, status = 'seeding', updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2`,
        [tenantId, caseId, world.worldId],
      );
      await this.client.query(
        `INSERT INTO clockgrove_birth.pack_installations
           (tenant_id, installation_id, case_id, world_id, pack_id, pack_version, content_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'installed')`,
        [
          tenantId,
          input.installationId,
          caseId,
          world.worldId,
          artifact.packId,
          artifact.version,
          artifact.contentHash,
        ],
      );
      await this.client.query(
        `UPDATE clockgrove.worlds SET lifecycle_status = 'provisioning'
          WHERE tenant_id = $1 AND world_id = $2`,
        [tenantId, world.worldId],
      );
      await this.journal(input.journal);
    });
  }

  async applySeedCommand(
    input: CaseScope & { readonly index: number; readonly journal: JournalExecuteRequest },
  ): Promise<void> {
    const { authorization, caseId, index } = input;
    await this.transaction(authorization, `seed-command-${index}`, async () => {
      const current = await this.expectStatus(
        authorization.tenantId,
        caseId,
        "applySeedCommand",
        "seeding",
      );
      if (current.status !== "seeding" || current.seededCommands > index) return;
      if (current.seededCommands !== index) {
        throw new ProvisioningStageError(
          caseId,
          `applySeedCommand(${index})`,
          `seeded ${current.seededCommands}`,
        );
      }
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET seeded_commands = $3, updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2`,
        [authorization.tenantId, caseId, index + 1],
      );
      await this.journal(input.journal);
    });
  }

  async readBirth(input: BirthScope): Promise<StoredBirth> {
    const { authorization, worldId, timelineId } = input;
    const scope = [authorization.tenantId, worldId, timelineId, BIRTH_VERSION];
    const where = `tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND birth_version = $4`;
    return this.transaction<StoredBirth>(authorization, undefined, async () => {
      const header = await this.client.query(
        `SELECT state_schema_version, state_partition_id, scalars, clock_policy,
                simulation_epoch::text AS simulation_epoch, seed_projection_hash
           FROM clockgrove_birth.world_birth_states WHERE ${where}`,
        scope,
      );
      const state = row(header.rows[0]);
      const sections = await this.client.query(
        `SELECT section, section_version, node FROM clockgrove_birth.birth_state_sections
          WHERE ${where} ORDER BY section`,
        scope,
      );
      const spaceState = await this.client.query(
        `SELECT partition_id, space_id, element_kind, element_key, ordinal, node
           FROM clockgrove_birth.birth_space_state
          WHERE ${where} ORDER BY element_kind, ordinal`,
        scope,
      );
      const schedules = await this.client.query(
        `SELECT ordinal, node FROM clockgrove_birth.birth_schedules WHERE ${where} ORDER BY ordinal`,
        scope,
      );
      const random = await this.client.query(
        `SELECT stream_name, algorithm, algorithm_version, draws::text AS draws, state_words
           FROM clockgrove_birth.birth_random_streams WHERE ${where} ORDER BY stream_name`,
        scope,
      );
      const refs = await this.client.query(
        `SELECT seed_id, seed_version, sha256 FROM clockgrove_birth.birth_cognitive_seed_refs
          WHERE ${where} ORDER BY ordinal`,
        scope,
      );
      const resources = await this.client.query(
        `SELECT resource.resource_id, resource.resource_version, resource.sha256, resource.path, resource.content
           FROM clockgrove_birth.birth_cognitive_seed_refs AS ref
           JOIN clockgrove_birth.pack_artifact_resources AS resource
             ON resource.tenant_id = ref.tenant_id
            AND resource.pack_id = ref.pack_id
            AND resource.pack_version = ref.pack_version
            AND resource.resource_kind = ref.seed_kind
            AND resource.resource_id = ref.seed_id
            AND resource.resource_version = ref.seed_version
            AND resource.sha256 = ref.sha256
          WHERE ref.tenant_id = $1 AND ref.world_id = $2 AND ref.timeline_id = $3
            AND ref.birth_version = $4
          ORDER BY ref.ordinal`,
        scope,
      );
      const birth: BirthState = {
        birthVersion: BIRTH_VERSION,
        stateSchemaVersion: integer(state, "state_schema_version"),
        statePartitionId: text(state, "state_partition_id"),
        scalars: node(state, "scalars"),
        clockPolicy: node(state, "clock_policy"),
        simulationEpoch: text(state, "simulation_epoch"),
        seedProjectionHash: text(state, "seed_projection_hash"),
        sections: sections.rows.map((value): BirthSectionRow => {
          const stored = row(value);
          return {
            section: sectionName(text(stored, "section")),
            sectionVersion: integer(stored, "section_version"),
            node: node(stored, "node"),
          };
        }),
        spaceState: spaceState.rows.map((value): BirthSpaceRow => {
          const stored = row(value);
          return {
            partitionId: text(stored, "partition_id"),
            spaceId: text(stored, "space_id"),
            kind: elementKind(text(stored, "element_kind")),
            key: text(stored, "element_key"),
            ordinal: integer(stored, "ordinal"),
            node: node(stored, "node"),
          };
        }),
        schedules: schedules.rows.map((value): BirthScheduleRow => {
          const stored = row(value);
          return { ordinal: integer(stored, "ordinal"), node: node(stored, "node") };
        }),
        randomStreams: random.rows.map((value): BirthRandomStreamRow => {
          const stored = row(value);
          return {
            name: text(stored, "stream_name"),
            algorithm: text(stored, "algorithm"),
            algorithmVersion: integer(stored, "algorithm_version"),
            draws: text(stored, "draws"),
            stateWords: textArray(stored, "state_words"),
          };
        }),
        seedRefs: refs.rows.map((value) => {
          const stored = row(value);
          return {
            seedId: text(stored, "seed_id"),
            seedVersion: integer(stored, "seed_version"),
            sha256: text(stored, "sha256"),
          };
        }),
      };
      const seedResources = resources.rows.map((value): BirthSeedResource => {
        const stored = row(value);
        return {
          seedId: text(stored, "resource_id"),
          seedVersion: integer(stored, "resource_version"),
          sha256: text(stored, "sha256"),
          path: text(stored, "path"),
          bytes: bytes(stored, "content"),
        };
      });
      return { birth, seedResources };
    });
  }

  async commitProjectionVerified(
    input: CaseScope & { readonly journal: JournalExecuteRequest },
  ): Promise<void> {
    const { authorization, caseId } = input;
    await this.transaction(authorization, "projection-verified", async () => {
      const current = await this.expectStatus(
        authorization.tenantId,
        caseId,
        "commitProjectionVerified",
        "seeding",
      );
      if (current.status !== "seeding") return;
      await this.journal(input.journal);
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET status = 'verified', updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2`,
        [authorization.tenantId, caseId],
      );
    });
  }

  async commitReady(
    input: CaseScope & { readonly journal: JournalExecuteRequest; readonly live: LiveHandoff },
  ): Promise<ProvisionedWorld> {
    const { authorization, caseId, live } = input;
    const tenantId = authorization.tenantId;
    return this.transaction<ProvisionedWorld>(authorization, "ready", async () => {
      const current = await this.expectStatus(tenantId, caseId, "commitReady", "verified");
      if (current.status === "ready") return this.readProvisioned(tenantId, caseId);
      if (current.worldId === undefined)
        throw new TypeError(`provisioning case ${caseId} has no world`);
      await this.journal(input.journal);
      // Birth-to-live handoff: the initial partition state covers the head WorldReady just reached.
      const handedOff = await this.client.query(
        `INSERT INTO clockgrove.partition_states
           (tenant_id, world_id, timeline_id, partition_id, space_id, revision,
            covered_head_sequence, simulation_time, document_version, document, document_hash,
            state_hash)
         SELECT head.tenant_id, head.world_id, head.timeline_id, head.partition_id, head.space_id,
                $5::bigint, head.head_sequence, $6::bigint, $7, $8::jsonb, $9, $10
           FROM clockgrove.timeline_partitions AS head
          WHERE head.tenant_id = $1 AND head.world_id = $2 AND head.partition_id = $3
            AND head.space_id = $4
         RETURNING partition_id`,
        [
          tenantId,
          current.worldId,
          live.partition.partitionId,
          live.partition.spaceId,
          live.state.revision.toString(),
          live.state.simulationTime.toString(),
          live.state.documentVersion,
          json(live.state.document),
          live.state.documentHash,
          live.state.stateHash,
        ],
      );
      if (handedOff.rows.length !== 1) {
        throw new TypeError(
          `world ${current.worldId} has no partition ${live.partition.partitionId}`,
        );
      }
      // The birth queue becomes the partition's pending schedule rows, scheduled by WorldReady.
      await insertBirthSchedules(
        this.client,
        {
          tenantId,
          worldId: current.worldId,
          timelineId: input.journal.command.target.timelineId,
          partitionId: live.partition.partitionId,
          spaceId: live.partition.spaceId,
        },
        input.journal.command.commandId,
        live.state.schedules,
      );
      await this.client.query(
        `UPDATE clockgrove.worlds SET lifecycle_status = 'ready'
          WHERE tenant_id = $1 AND world_id = $2`,
        [tenantId, current.worldId],
      );
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET status = 'ready', updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2`,
        [tenantId, caseId],
      );
      return this.readProvisioned(tenantId, caseId);
    });
  }

  async recordFailure(input: CaseScope & { readonly refusal: ProvisioningRefusal }): Promise<void> {
    const { authorization, caseId, refusal } = input;
    await this.transaction(authorization, undefined, async () => {
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET status = 'failed', failure = $3::jsonb, updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2 AND status NOT IN ('ready', 'failed')`,
        [authorization.tenantId, caseId, json(refusal)],
      );
    });
  }

  async recordAttemptFailure(
    input: CaseScope & { readonly failure: ProvisioningRefusal },
  ): Promise<void> {
    const { authorization, caseId, failure } = input;
    await this.transaction(authorization, undefined, async () => {
      await this.client.query(
        `UPDATE clockgrove_birth.provisioning_cases
            SET last_failure = $3::jsonb, updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND case_id = $2 AND status NOT IN ('ready', 'failed')`,
        [authorization.tenantId, caseId, json(failure)],
      );
    });
  }

  private async transaction<TResult>(
    authorization: RuntimeAuthorizationContext,
    point: ProvisioningFaultPoint | undefined,
    work: () => Promise<TResult>,
  ): Promise<TResult> {
    const result = await withClientTransaction(this.client, { authorization }, async () => {
      const value = await work();
      if (point !== undefined) this.fault(point, "before-commit");
      return value;
    });
    if (point !== undefined) this.fault(point, "after-commit");
    return result;
  }

  private fault(point: ProvisioningFaultPoint, when: "before-commit" | "after-commit"): void {
    const configured = this.testHooks.fault;
    if (configured?.point === point && configured.when === when) {
      throw new ProvisioningFaultInjectedError(point, when);
    }
  }

  private async journal(request: JournalExecuteRequest): Promise<void> {
    try {
      await executeJournalStatement(this.client, request);
    } catch (error) {
      throw mapDatabaseError(error, request);
    }
  }

  private async expectStatus(
    tenantId: string,
    caseId: string,
    stage: string,
    expected: OpenStatus,
  ): Promise<LockedCase> {
    const locked = await this.client.query(
      `SELECT status, seeded_commands, world_id FROM clockgrove_birth.provisioning_cases
        WHERE tenant_id = $1 AND case_id = $2
          FOR UPDATE`,
      [tenantId, caseId],
    );
    const stored = row(locked.rows[0]);
    const status = text(stored, "status");
    const stages = ["requested", "seeding", "verified", "ready"];
    if (stages.indexOf(status) < stages.indexOf(expected)) {
      throw new ProvisioningStageError(caseId, stage, status);
    }
    const worldId = stored.world_id;
    return {
      status,
      seededCommands: integer(stored, "seeded_commands"),
      worldId: typeof worldId === "string" ? worldId : undefined,
    };
  }

  private async readProvisioned(tenantId: string, caseId: string): Promise<ProvisionedWorld> {
    const found = await this.client.query(
      `SELECT provisioning_case.world_id, installation.installation_id, installation.pack_id,
              installation.pack_version, installation.content_hash, birth.timeline_id,
              world.lifecycle_status
         FROM clockgrove_birth.provisioning_cases AS provisioning_case
         JOIN clockgrove_birth.pack_installations AS installation
           ON installation.tenant_id = provisioning_case.tenant_id
          AND installation.case_id = provisioning_case.case_id
         JOIN clockgrove_birth.world_birth_states AS birth
           ON birth.tenant_id = provisioning_case.tenant_id
          AND birth.world_id = provisioning_case.world_id
          AND birth.birth_version = $3
         JOIN clockgrove.worlds AS world
           ON world.tenant_id = provisioning_case.tenant_id
          AND world.world_id = provisioning_case.world_id
        WHERE provisioning_case.tenant_id = $1 AND provisioning_case.case_id = $2`,
      [tenantId, caseId, BIRTH_VERSION],
    );
    const stored = row(found.rows[0]);
    if (text(stored, "lifecycle_status") !== "ready") {
      throw new TypeError(`provisioning case ${caseId} is ready but its world is not`);
    }
    return {
      tenantId,
      caseId,
      worldId: text(stored, "world_id"),
      timelineId: text(stored, "timeline_id"),
      installationId: text(stored, "installation_id"),
      packId: text(stored, "pack_id"),
      packVersion: text(stored, "pack_version"),
      contentHash: text(stored, "content_hash"),
      lifecycleStatus: "ready",
    };
  }

  private async insertBirth(
    tenantId: string,
    world: RecordGenesisInput["world"],
    artifact: ProvisioningArtifact,
    birth: BirthState,
  ): Promise<void> {
    const scope = [tenantId, world.worldId, world.timelineId, birth.birthVersion];
    await this.client.query(
      `INSERT INTO clockgrove_birth.world_birth_states
         (tenant_id, world_id, timeline_id, birth_version, pack_id, pack_version, content_hash,
          state_schema_version, state_partition_id, scalars, clock_policy, simulation_epoch,
          seed_projection_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::bigint, $13)`,
      [
        ...scope,
        artifact.packId,
        artifact.version,
        artifact.contentHash,
        birth.stateSchemaVersion,
        birth.statePartitionId,
        json(birth.scalars),
        json(birth.clockPolicy),
        birth.simulationEpoch,
        birth.seedProjectionHash,
      ],
    );
    for (const section of birth.sections) {
      await this.client.query(
        `INSERT INTO clockgrove_birth.birth_state_sections
           (tenant_id, world_id, timeline_id, birth_version, section, section_version, node)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [...scope, section.section, section.sectionVersion, json(section.node)],
      );
    }
    for (const element of birth.spaceState) {
      await this.client.query(
        `INSERT INTO clockgrove_birth.birth_space_state
           (tenant_id, world_id, timeline_id, birth_version, partition_id, space_id,
            element_kind, element_key, ordinal, node)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          ...scope,
          element.partitionId,
          element.spaceId,
          element.kind,
          element.key,
          element.ordinal,
          json(element.node),
        ],
      );
    }
    for (const schedule of birth.schedules) {
      await this.client.query(
        `INSERT INTO clockgrove_birth.birth_schedules
           (tenant_id, world_id, timeline_id, birth_version, ordinal, node)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [...scope, schedule.ordinal, json(schedule.node)],
      );
    }
    for (const stream of birth.randomStreams) {
      await this.client.query(
        `INSERT INTO clockgrove_birth.birth_random_streams
           (tenant_id, world_id, timeline_id, birth_version, stream_name, algorithm,
            algorithm_version, draws, state_words)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::text[])`,
        [
          ...scope,
          stream.name,
          stream.algorithm,
          stream.algorithmVersion,
          stream.draws,
          stream.stateWords,
        ],
      );
    }
    for (const [ordinal, ref] of birth.seedRefs.entries()) {
      await this.client.query(
        `INSERT INTO clockgrove_birth.birth_cognitive_seed_refs
           (tenant_id, world_id, timeline_id, birth_version, ordinal, pack_id, pack_version,
            seed_id, seed_version, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ...scope,
          ordinal,
          artifact.packId,
          artifact.version,
          ref.seedId,
          ref.seedVersion,
          ref.sha256,
        ],
      );
    }
  }
}
