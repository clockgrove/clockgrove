import type {
  LockedPartitionState,
  RuntimeAuthorizationContext,
  RuntimeAuthorizationScope,
  TimelineClockPolicy,
} from "@clockgrove/application";
import { JournalRevisionConflictError, JournalRouteNotFoundError } from "@clockgrove/application";
import {
  decodeOpaqueId,
  type PartitionId,
  type SpaceId,
  type StreamId,
} from "@clockgrove/contracts";
import { DUE_ORDER, readContinuation, readPendingSchedules } from "./postgres-schedules.js";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { installAuthorization, withClientTransaction } from "./postgres-transaction.js";
import {
  clockPolicyOf,
  decodeLockedPartitionState,
  readTimelineClockPolicy,
  record,
  text,
} from "./postgres-world-command.js";

export interface HydratedWorldOwner extends LockedPartitionState {
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
  readonly streamId: StreamId;
  readonly routingEpoch: bigint;
}

/** A space's canonical placement: what routing a command needs, without its state document. */
export interface WorldOwnerRoute {
  readonly partitionId: PartitionId;
  readonly spaceId: SpaceId;
  readonly streamId: StreamId;
  readonly routingEpoch: bigint;
}

/** What alarm planning and an advance read before any lock: the clock row and next deadline. */
export interface ClockOwnerState extends WorldOwnerRoute {
  readonly authorization: RuntimeAuthorizationContext;
  readonly policy: TimelineClockPolicy;
  readonly simulationTime: bigint;
  readonly revision: bigint;
  /** The admitted high-water mark, never behind simulation time. */
  readonly horizon: bigint;
  readonly continuation: boolean;
  readonly nextDueAt: bigint | null;
}

const ROUTE_FROM = `FROM clockgrove.timeline_partitions AS head
           JOIN clockgrove.streams AS stream USING (tenant_id, world_id, timeline_id, partition_id, space_id)
           JOIN clockgrove.partition_states AS state USING (tenant_id, world_id, timeline_id, partition_id, space_id)`;

function routeOf(stored: Readonly<Record<string, unknown>>): WorldOwnerRoute {
  return {
    partitionId: decodeOpaqueId(stored.partition_id, "PartitionId"),
    spaceId: decodeOpaqueId(stored.space_id, "SpaceId"),
    streamId: decodeOpaqueId(stored.stream_id, "StreamId"),
    routingEpoch: BigInt(text(stored, "routing_epoch")),
  };
}

/** The ready scope's autonomous principal, inside the caller's transaction. */
async function resolveAutonomousAuthorization(
  client: PostgreSqlClient,
  scope: RuntimeAuthorizationScope,
): Promise<RuntimeAuthorizationContext | undefined> {
  const result = await client.query(
    `SELECT clockgrove.resolve_ready_clock_principal($1, $2, $3, $4) AS principal_id`,
    [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
  );
  const row = record(result.rows[0], "autonomous authority");
  return row.principal_id === null
    ? undefined
    : {
        tenantId: scope.tenantId,
        principalId: decodeOpaqueId(row.principal_id, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
      };
}

export interface InstalledWorldResources {
  readonly packId: string;
  readonly packVersion: string;
  readonly contentHash: string;
  readonly resources: readonly {
    readonly kind: string;
    readonly id: string;
    readonly version: number;
    readonly path: string;
    readonly sha256: string;
    readonly content: Uint8Array;
  }[];
}

/** Request-scoped reads of canonical placement, live state and immutable installed resources. */
export class PostgreSqlWorldOwnerReader {
  constructor(private readonly client: PostgreSqlClient) {}

  /** The world system principal (0017), reconstructed from an installed ready scope without a session. */
  autonomousAuthorization(
    scope: RuntimeAuthorizationScope,
  ): Promise<RuntimeAuthorizationContext | undefined> {
    return withClientTransaction(this.client, {}, () =>
      resolveAutonomousAuthorization(this.client, scope),
    );
  }

  /**
   * One short transaction for alarm planning and an advance: the autonomous principal, then under
   * it the clock row, fenced by `ownerGeneration`, and the next deadline through the due index. No
   * state document or schedule queue is read. `undefined` without a ready clock principal.
   */
  clockOwner(
    scope: RuntimeAuthorizationScope,
    ownerGeneration?: bigint,
  ): Promise<ClockOwnerState | undefined> {
    return withClientTransaction(this.client, {}, async () => {
      const authorization = await resolveAutonomousAuthorization(this.client, scope);
      if (authorization === undefined) return undefined;
      await installAuthorization(this.client, authorization);
      const result = await this.client.query(
        `SELECT head.partition_id, head.space_id, stream.stream_id,
                head.routing_epoch::text AS routing_epoch,
                state.simulation_time::text AS simulation_time,
                state.revision::text AS revision,
                greatest(state.clock_admitted_horizon, state.simulation_time)::text AS horizon,
                state.clock_owner_generation::text AS generation,
                state.continuation_command_id IS NOT NULL AS continuation,
                state.clock_policy, birth.clock_policy AS genesis_clock_policy,
                (SELECT schedule.due_at::text FROM clockgrove.partition_schedules AS schedule
                  WHERE schedule.tenant_id = state.tenant_id
                    AND schedule.timeline_id = state.timeline_id
                    AND schedule.partition_id = state.partition_id
                    AND schedule.status = 'pending'
                  ORDER BY ${DUE_ORDER} LIMIT 1) AS next_due_at
           ${ROUTE_FROM}
           JOIN clockgrove_birth.world_birth_states AS birth USING (tenant_id, world_id, timeline_id)
          WHERE head.tenant_id = $1 AND head.world_id = $2 AND head.timeline_id = $3 AND head.space_id = $4`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
      const row = record(result.rows[0], "clock owner");
      const generation = BigInt(text(row, "generation"));
      if (ownerGeneration !== undefined && ownerGeneration !== generation)
        throw new JournalRevisionConflictError("owner-generation", ownerGeneration, generation);
      const nextDueAt = row.next_due_at;
      return {
        ...routeOf(row),
        authorization,
        policy: clockPolicyOf(row),
        simulationTime: BigInt(text(row, "simulation_time")),
        revision: BigInt(text(row, "revision")),
        horizon: BigInt(text(row, "horizon")),
        continuation: row.continuation === true,
        nextDueAt: typeof nextDueAt === "string" ? BigInt(nextDueAt) : null,
      };
    });
  }

  /** The space's placement under `authorization`, without its state document or schedule queue. */
  route(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<WorldOwnerRoute> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT head.partition_id, head.space_id, stream.stream_id,
                head.routing_epoch::text AS routing_epoch
           ${ROUTE_FROM}
           JOIN clockgrove_birth.pack_installations AS installation USING (tenant_id, world_id)
          WHERE head.tenant_id = $1 AND head.world_id = $2 AND head.timeline_id = $3 AND head.space_id = $4`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
      return routeOf(record(result.rows[0], "owner route"));
    });
  }

  isTenantMember(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<boolean> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT principal_id FROM clockgrove.tenant_principals
          WHERE tenant_id = $1 AND principal_id = $2`,
        [scope.tenantId, authorization.principalId],
      );
      return result.rows.length === 1;
    });
  }

  isReady(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<boolean> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT lifecycle_status FROM clockgrove.worlds WHERE tenant_id = $1 AND world_id = $2`,
        [scope.tenantId, scope.worldId],
      );
      return (
        result.rows.length === 1 && record(result.rows[0], "world").lifecycle_status === "ready"
      );
    });
  }

  hydrate(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<HydratedWorldOwner> {
    return withClientTransaction(
      this.client,
      {
        authorization,
        begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      },
      async () => {
        const result = await this.client.query(
          `SELECT head.partition_id, head.space_id, stream.stream_id,
                head.routing_epoch::text AS routing_epoch,
                state.revision::text AS revision,
                state.covered_head_sequence::text AS "coveredHeadSequence",
                state.simulation_time::text AS "simulationTime",
                state.document_version AS "documentVersion", state.document,
                state.document_hash AS "documentHash", state.state_hash AS "stateHash",
                installation.content_hash AS "packContentHash"
           ${ROUTE_FROM}
           JOIN clockgrove_birth.pack_installations AS installation USING (tenant_id, world_id)
          WHERE head.tenant_id = $1 AND head.world_id = $2 AND head.timeline_id = $3 AND head.space_id = $4`,
          [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
        );
        if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
        const stored = record(result.rows[0], "owner state");
        const partitionId = decodeOpaqueId(stored.partition_id, "PartitionId");
        const key = { tenantId: scope.tenantId, timelineId: scope.timelineId, partitionId };
        const schedules = await readPendingSchedules(this.client, key);
        const continuation = await readContinuation(this.client, key);
        return {
          ...decodeLockedPartitionState(stored, schedules, continuation),
          clockPolicy: await readTimelineClockPolicy(this.client, key),
          ...routeOf(stored),
        };
      },
    );
  }

  installedResources(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<InstalledWorldResources> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT installation.pack_id, installation.pack_version, installation.content_hash,
                resource.resource_kind, resource.resource_id, resource.resource_version,
                resource.path, resource.sha256, resource.content
           FROM clockgrove_birth.pack_installations AS installation
           JOIN clockgrove_birth.pack_artifact_resources AS resource USING (tenant_id, pack_id, pack_version)
          WHERE installation.tenant_id = $1 AND installation.world_id = $2
          ORDER BY resource.path`,
        [scope.tenantId, scope.worldId],
      );
      if (result.rows.length === 0) throw new JournalRouteNotFoundError(scope.worldId);
      const first = record(result.rows[0], "installed pack");
      return {
        packId: text(first, "pack_id"),
        packVersion: text(first, "pack_version"),
        contentHash: text(first, "content_hash"),
        resources: result.rows.map((value) => {
          const stored = record(value, "installed resource");
          const content = stored.content;
          const version = stored.resource_version;
          if (!(content instanceof Uint8Array) || typeof version !== "number") {
            throw new TypeError("PostgreSQL returned a malformed installed resource");
          }
          return {
            kind: text(stored, "resource_kind"),
            id: text(stored, "resource_id"),
            version,
            path: text(stored, "path"),
            sha256: text(stored, "sha256"),
            content,
          };
        }),
      };
    });
  }
}
