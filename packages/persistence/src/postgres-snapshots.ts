import type {
  ArtifactScope,
  CommittedPartitionState,
  PartitionSnapshotStore,
  RuntimeAuthorizationContext,
  SnapshotCompatibility,
  SnapshotRef,
  WorldPartitionScope,
} from "@clockgrove/application";
import { SnapshotConflictError, snapshotCompatibility } from "@clockgrove/application";
import { decodeOpaqueId, decodePrivacyCategory } from "@clockgrove/contracts";

import { readPendingSchedules } from "./postgres-schedules.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";

type Row = Readonly<Record<string, unknown>>;

const REF_COLUMNS = `tenant_id, world_id, timeline_id, partition_id, space_id, snapshot_id, stream_id,
  covered_partition_sequence::text AS covered_partition_sequence, covered_sequence::text AS covered_sequence,
  state_hash, artifact_id, privacy_class, compatibility`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`PostgreSQL returned a malformed ${key}`);
  return value;
}

function decodeScope(row: Row): ArtifactScope {
  return {
    tenantId: decodeOpaqueId(text(row, "tenant_id"), "TenantId"),
    worldId: decodeOpaqueId(text(row, "world_id"), "WorldId"),
    timelineId: decodeOpaqueId(text(row, "timeline_id"), "TimelineId"),
    partitionId: decodeOpaqueId(text(row, "partition_id"), "PartitionId"),
    spaceId: decodeOpaqueId(text(row, "space_id"), "SpaceId"),
  };
}

function decodeRef(row: Row): SnapshotRef {
  const compatibility = row.compatibility;
  if (typeof compatibility !== "object" || compatibility === null || Array.isArray(compatibility)) {
    throw new TypeError("PostgreSQL returned a malformed compatibility");
  }
  return {
    snapshotId: text(row, "snapshot_id"),
    scope: decodeScope(row),
    streamId: decodeOpaqueId(text(row, "stream_id"), "StreamId"),
    coveredPartitionSequence: BigInt(text(row, "covered_partition_sequence")),
    coveredStreamSequence: BigInt(text(row, "covered_sequence")),
    stateHash: text(row, "state_hash"),
    artifactId: decodeOpaqueId(text(row, "artifact_id"), "ArtifactId"),
    privacyClass: decodePrivacyCategory(row.privacy_class),
    compatibility: compatibility as SnapshotCompatibility,
  };
}

const COLUMNS = `tenant_id, world_id, timeline_id, partition_id, space_id, snapshot_id, stream_id,
  covered_partition_sequence, covered_sequence, state_hash, artifact_id, privacy_class, compatibility`;
const MATCH = COLUMNS.split(",")
  .map((column, index) => `${column.trim()} = $${index + 1}`)
  .join(" AND ");

function values(ref: SnapshotRef): readonly unknown[] {
  const { scope } = ref;
  return [
    scope.tenantId,
    scope.worldId,
    scope.timelineId,
    scope.partitionId,
    scope.spaceId,
    ref.snapshotId,
    ref.streamId,
    ref.coveredPartitionSequence.toString(),
    ref.coveredStreamSequence.toString(),
    ref.stateHash,
    ref.artifactId,
    ref.privacyClass,
    JSON.stringify(ref.compatibility),
  ];
}

/**
 * PartitionSnapshotStore over `clockgrove.snapshots` (migration 0013). Each call is one short authorized
 * transaction under RLS, never inside a journal transaction; rows are only appended.
 */
export class PostgreSqlSnapshotStore implements PartitionSnapshotStore {
  constructor(private readonly client: PostgreSqlClient) {}

  async readCommitted(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
  ): Promise<CommittedPartitionState | undefined> {
    // One snapshot of the database: the state row, its schedules, the pack and the route stream's
    // coverage at the state's head all belong to the same commit.
    return this.transaction(
      authorization,
      "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      async () => {
        const result = await this.client.query(
          `SELECT state.tenant_id, state.world_id, state.timeline_id, state.partition_id, state.space_id,
                stream.stream_id, state.covered_head_sequence::text AS covered_partition_sequence,
                coalesce((SELECT event.stream_sequence FROM clockgrove.events AS event
                           WHERE event.tenant_id = state.tenant_id AND event.timeline_id = state.timeline_id
                             AND event.partition_id = state.partition_id AND event.stream_id = stream.stream_id
                             AND event.partition_sequence <= state.covered_head_sequence
                           ORDER BY event.partition_sequence DESC LIMIT 1), 0)::text AS covered_sequence,
                installation.content_hash, state.revision::text AS revision,
                state.simulation_time::text AS simulation_time, state.document_version, state.document,
                state.document_hash, state.state_hash, state.continuation IS NOT NULL AS continuation_open
           FROM clockgrove.partition_states AS state
           JOIN clockgrove.streams AS stream USING (tenant_id, world_id, timeline_id, partition_id, space_id)
           JOIN clockgrove_birth.pack_installations AS installation USING (tenant_id, world_id)
          WHERE state.tenant_id = $1 AND state.world_id = $2 AND state.timeline_id = $3 AND state.partition_id = $4`,
          [scope.tenantId, scope.worldId, scope.timelineId, scope.partitionId],
        );
        const row = result.rows[0] as Row | undefined;
        if (row === undefined) return undefined;
        if (result.rows.length !== 1)
          throw new TypeError("the partition has more than one route stream");
        const document = row.document;
        const documentVersion = row.document_version;
        if (!Array.isArray(document) || typeof documentVersion !== "number") {
          throw new TypeError("PostgreSQL returned a malformed partition state");
        }
        return {
          scope: decodeScope(row),
          streamId: decodeOpaqueId(text(row, "stream_id"), "StreamId"),
          coveredPartitionSequence: BigInt(text(row, "covered_partition_sequence")),
          coveredStreamSequence: BigInt(text(row, "covered_sequence")),
          packContentHash: text(row, "content_hash"),
          stored: {
            revision: BigInt(text(row, "revision")),
            simulationTime: BigInt(text(row, "simulation_time")),
            documentVersion,
            document,
            documentHash: text(row, "document_hash"),
            stateHash: text(row, "state_hash"),
            schedules: await readPendingSchedules(this.client, scope),
          },
          continuationOpen: row.continuation_open === true,
        };
      },
    );
  }

  async record(authorization: RuntimeAuthorizationContext, ref: SnapshotRef): Promise<SnapshotRef> {
    const placeholders = values(ref)
      .map((_value, index) => `$${index + 1}`)
      .join(", ");
    // jsonb equality ignores key order, so an equal retry matches.
    const matches = async () =>
      (await this.client.query(`SELECT 1 FROM clockgrove.snapshots WHERE ${MATCH}`, values(ref)))
        .rows.length === 1;
    const stored = await this.transaction(authorization, "BEGIN", async () => {
      const inserted = await this.client.query(
        `INSERT INTO clockgrove.snapshots (${COLUMNS}) VALUES (${placeholders})
         ON CONFLICT (tenant_id, snapshot_id) DO NOTHING RETURNING snapshot_id`,
        values(ref),
      );
      return inserted.rows.length === 1 || (await matches());
    }).catch((error: unknown) => {
      // ON CONFLICT arbitrates on the primary key only. A concurrent insert of the same row can commit
      // between its check and this insert, which then fails on the covered-head index (23505); the
      // committed row decides, in a fresh transaction. A different row at that head conflicts.
      if ((error as { readonly code?: unknown }).code !== "23505") throw error;
      return this.transaction(authorization, "BEGIN", matches);
    });
    if (!stored) throw new SnapshotConflictError(ref.snapshotId);
    return ref;
  }

  async list(
    authorization: RuntimeAuthorizationContext,
    scope: WorldPartitionScope,
    through?: bigint,
  ): Promise<readonly SnapshotRef[]> {
    return this.transaction(authorization, "BEGIN", async () => {
      // Ordered by the bigint column; the bare name would sort by its text alias.
      const result = await this.client.query(
        `SELECT ${REF_COLUMNS} FROM clockgrove.snapshots
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND partition_id = $4
            AND ($5::bigint IS NULL OR covered_partition_sequence <= $5::bigint)
          ORDER BY snapshots.covered_partition_sequence`,
        [
          scope.tenantId,
          scope.worldId,
          scope.timelineId,
          scope.partitionId,
          through?.toString() ?? null,
        ],
      );
      return result.rows.map((row) => decodeRef(row as Row));
    });
  }

  /**
   * Up to `limit` partitions due for a snapshot (migration 0030): no compatible one yet, or the head
   * at least `interval` events past the latest compatible one; least recently attempted first, then
   * most behind. Listing them stamps each as attempted. Each comes with its world's system principal
   * and a `public_scene` ceiling, the class of snapshots and of the events they copy.
   */
  async duePartitions(
    interval: bigint,
    limit: number,
  ): Promise<
    readonly {
      readonly authorization: RuntimeAuthorizationContext;
      readonly scope: WorldPartitionScope;
    }[]
  > {
    // The current compatibility set but the pack hash, which 0030 takes from each world's installation.
    const { packContentHash: _pack, ...current } = snapshotCompatibility("");
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT tenant_id, world_id, timeline_id, partition_id, principal_id
           FROM clockgrove.snapshot_due_partitions($1::jsonb, $2::bigint, $3::integer)`,
        [JSON.stringify(current), interval.toString(), limit],
      );
      return result.rows.map((value) => {
        const row = value as Row;
        const tenantId = decodeOpaqueId(text(row, "tenant_id"), "TenantId");
        return {
          authorization: {
            tenantId,
            principalId: decodeOpaqueId(text(row, "principal_id"), "PrincipalId"),
            privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
          },
          scope: {
            tenantId,
            worldId: decodeOpaqueId(text(row, "world_id"), "WorldId"),
            timelineId: decodeOpaqueId(text(row, "timeline_id"), "TimelineId"),
            partitionId: decodeOpaqueId(text(row, "partition_id"), "PartitionId"),
          },
        };
      });
    });
  }

  private async transaction<T>(
    authorization: RuntimeAuthorizationContext,
    begin: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withClientTransaction(this.client, { authorization, begin }, operation);
  }
}
