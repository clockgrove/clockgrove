import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import { type PostgreSqlClient, withClientTransaction } from "@clockgrove/persistence";

import type { CanonicalRuntimeState, RuntimeScope } from "./types.js";
import { RuntimeRouteNotFoundError } from "./types.js";

export interface CanonicalRuntimeStateSource {
  loadReadyRuntimeState(
    context: TrustedExecutionContext,
    scope: RuntimeScope,
  ): Promise<CanonicalRuntimeState>;
}

/** PostgreSQL adapter for accepted Wave 0 world, partition, and stream truth. */
export class PostgreSqlCanonicalRuntimeStateSource implements CanonicalRuntimeStateSource {
  constructor(private readonly client: PostgreSqlClient) {}

  async loadReadyRuntimeState(
    context: TrustedExecutionContext,
    scope: RuntimeScope,
  ): Promise<CanonicalRuntimeState> {
    assertTrustedScope(context, scope);
    const result = await withClientTransaction(this.client, {}, async () => {
      await this.client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await this.client.query("SELECT set_config('app.principal_id', $1, true)", [
        context.principalId,
      ]);
      await this.client.query("SELECT set_config('app.privacy_ceiling', $1, true)", [
        JSON.stringify(context.privacyCeiling),
      ]);
      return this.client.query(
        `SELECT partition.partition_id, partition.routing_epoch, partition.head_sequence,
                stream.stream_id
           FROM clockgrove.worlds AS world
           JOIN clockgrove.timelines AS timeline
             ON timeline.tenant_id = world.tenant_id AND timeline.world_id = world.world_id
           JOIN clockgrove.timeline_partitions AS partition
             ON partition.tenant_id = timeline.tenant_id
            AND partition.world_id = timeline.world_id
            AND partition.timeline_id = timeline.timeline_id
           JOIN clockgrove.streams AS stream
             ON stream.tenant_id = partition.tenant_id
            AND stream.world_id = partition.world_id
            AND stream.timeline_id = partition.timeline_id
            AND stream.partition_id = partition.partition_id
            AND stream.space_id = partition.space_id
          WHERE world.tenant_id = $1 AND world.world_id = $2
            AND timeline.timeline_id = $3 AND partition.space_id = $4
            AND world.lifecycle_status = 'ready' AND timeline.state = 'active'
          ORDER BY stream.stream_id
          LIMIT 1`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
    });
    const row = result.rows[0];
    if (!isCanonicalRow(row)) throw new RuntimeRouteNotFoundError();
    const routingEpoch = BigInt(row.routing_epoch);
    return {
      ...scope,
      runtimeCellId: row.partition_id as CanonicalRuntimeState["runtimeCellId"],
      routingEpoch,
      // By design the durable routing epoch is also the authority epoch:
      // one epoch fences routes and writers; owner generation fences stale incarnations.
      authorityEpoch: routingEpoch,
      projectionRevision: BigInt(row.head_sequence),
      partitionId: row.partition_id as CanonicalRuntimeState["partitionId"],
      primaryStreamId: row.stream_id as CanonicalRuntimeState["primaryStreamId"],
      fidelity: "hot",
      lifecycleStatus: "ready",
    };
  }
}

function assertTrustedScope(context: TrustedExecutionContext, scope: RuntimeScope): void {
  if (
    context.tenantId !== scope.tenantId ||
    context.worldId !== scope.worldId ||
    context.timelineId !== scope.timelineId ||
    context.spaceId !== scope.spaceId
  ) {
    throw new Error("trusted execution context does not authorize the runtime scope");
  }
}

function isCanonicalRow(value: unknown): value is {
  readonly partition_id: string;
  readonly routing_epoch: string | number;
  readonly head_sequence: string | number;
  readonly stream_id: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.partition_id === "string" &&
    typeof row.stream_id === "string" &&
    (typeof row.routing_epoch === "string" || typeof row.routing_epoch === "number") &&
    (typeof row.head_sequence === "string" || typeof row.head_sequence === "number")
  );
}
