import {
  type CatchUpWorkflowEnvelope,
  type CatchUpWorkflowOperation,
  type CatchUpWorkflowStore,
  decodeCatchUpWorkflowEnvelope,
  type RuntimeAuthorizationContext,
  type RuntimeAuthorizationScope,
} from "@clockgrove/application";
import { decodeOpaqueId, type RunId } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";
import { readTimelineClockPolicy, record, text } from "./postgres-world-command.js";

/** The partition's replaceable operational slot is independent of native Workflow history. */
export class PostgreSqlCatchUpWorkflowStore implements CatchUpWorkflowStore {
  constructor(private readonly client: PostgreSqlClient) {}

  async register(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
    activation: Readonly<{
      ownerGeneration: bigint;
      policyVersion: bigint;
      wallTime: bigint;
      applicationRunId?: RunId;
    }>,
  ): Promise<CatchUpWorkflowOperation | undefined> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT partition_id, clock_owner_generation::text AS generation, catch_up_run_id,
           catch_up_policy_version::text, catch_up_wall_time::text, catch_up_step::text
         FROM clockgrove.partition_states
         WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4 FOR UPDATE`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) return undefined;
      const row = record(result.rows[0], "catch-up partition");
      if (BigInt(text(row, "generation")) !== activation.ownerGeneration) return undefined;
      if (
        activation.applicationRunId !== undefined &&
        row.catch_up_run_id !== activation.applicationRunId
      )
        return undefined;
      const key = {
        tenantId: scope.tenantId,
        timelineId: scope.timelineId,
        partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      };
      const policy = await readTimelineClockPolicy(this.client, key);
      if (policy.version !== activation.policyVersion) return undefined;
      if (!policy.running) {
        await this.client.query(
          `UPDATE clockgrove.partition_states SET catch_up_run_id = NULL,
            catch_up_owner_generation = NULL, catch_up_policy_version = NULL,
            catch_up_wall_time = NULL, catch_up_step = NULL, catch_up_reconcile_attempted_at = NULL
           WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
          [key.tenantId, key.timelineId, key.partitionId],
        );
        return undefined;
      }
      const retained =
        row.catch_up_run_id !== null &&
        BigInt(text(row, "catch_up_policy_version")) === policy.version;
      const applicationRunId = retained
        ? decodeOpaqueId(row.catch_up_run_id, "RunId")
        : decodeOpaqueId(crypto.randomUUID(), "RunId");
      const wallTime = retained ? BigInt(text(row, "catch_up_wall_time")) : activation.wallTime;
      const step = retained ? BigInt(text(row, "catch_up_step")) : 0n;
      await this.client.query(
        `UPDATE clockgrove.partition_states SET catch_up_run_id = $4, catch_up_owner_generation = $5,
           catch_up_policy_version = $6, catch_up_wall_time = $7, catch_up_step = $8,
           catch_up_reconcile_attempted_at = CASE WHEN catch_up_run_id = $4
             THEN catch_up_reconcile_attempted_at ELSE NULL END
         WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
        [
          key.tenantId,
          key.timelineId,
          key.partitionId,
          applicationRunId,
          activation.ownerGeneration.toString(),
          policy.version.toString(),
          wallTime.toString(),
          step.toString(),
        ],
      );
      return {
        version: 1,
        ...scope,
        applicationRunId,
        ownerGeneration: activation.ownerGeneration,
        policyVersion: policy.version,
        wallTime,
        step,
      };
    });
  }

  async read(value: CatchUpWorkflowEnvelope): Promise<CatchUpWorkflowOperation | undefined> {
    const envelope = decodeCatchUpWorkflowEnvelope(value);
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT * FROM clockgrove.read_catch_up_operation($1,$2,$3,$4,$5)`,
        [
          envelope.tenantId,
          envelope.worldId,
          envelope.timelineId,
          envelope.spaceId,
          envelope.applicationRunId,
        ],
      );
      if (result.rows.length !== 1) return undefined;
      return this.decodeOperation(result.rows[0]);
    });
  }

  async current(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<CatchUpWorkflowOperation | undefined> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT tenant_id, world_id, timeline_id, space_id, catch_up_run_id,
          catch_up_owner_generation::text, catch_up_policy_version::text,
          catch_up_wall_time::text, catch_up_step::text FROM clockgrove.partition_states
         WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
           AND catch_up_run_id IS NOT NULL`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      return result.rows[0] === undefined ? undefined : this.decodeOperation(result.rows[0]);
    });
  }

  private decodeOperation(value: unknown): CatchUpWorkflowOperation {
    const row = record(value, "catch-up operation");
    const envelope = decodeCatchUpWorkflowEnvelope({
      version: 1,
      tenantId: row.tenant_id,
      worldId: row.world_id,
      timelineId: row.timeline_id,
      spaceId: row.space_id,
      applicationRunId: row.catch_up_run_id,
    });
    return {
      ...envelope,
      ownerGeneration: BigInt(text(row, "catch_up_owner_generation")),
      policyVersion: BigInt(text(row, "catch_up_policy_version")),
      wallTime: BigInt(text(row, "catch_up_wall_time")),
      step: BigInt(text(row, "catch_up_step")),
    };
  }

  async advance(
    authorization: RuntimeAuthorizationContext,
    value: CatchUpWorkflowEnvelope,
    activation: Readonly<{
      ownerGeneration: bigint;
      policyVersion: bigint;
      step: bigint;
      complete: boolean;
    }>,
  ): Promise<boolean> {
    const envelope = decodeCatchUpWorkflowEnvelope(value);
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT partition_id FROM clockgrove.partition_states WHERE tenant_id = $1 AND world_id = $2
         AND timeline_id = $3 AND space_id = $4 AND catch_up_run_id = $5
         AND clock_owner_generation = $6 AND catch_up_owner_generation = $6
         AND catch_up_policy_version = $7 AND catch_up_step = $8 FOR UPDATE`,
        [
          envelope.tenantId,
          envelope.worldId,
          envelope.timelineId,
          envelope.spaceId,
          envelope.applicationRunId,
          activation.ownerGeneration.toString(),
          activation.policyVersion.toString(),
          activation.step.toString(),
        ],
      );
      if (result.rows.length !== 1) return false;
      const row = record(result.rows[0], "catch-up partition");
      const key = {
        tenantId: envelope.tenantId,
        timelineId: envelope.timelineId,
        partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      };
      const policy = await readTimelineClockPolicy(this.client, key);
      if (!policy.running || policy.version !== activation.policyVersion) return false;
      await this.client.query(
        activation.complete
          ? `UPDATE clockgrove.partition_states SET catch_up_run_id = NULL, catch_up_owner_generation = NULL,
             catch_up_policy_version = NULL, catch_up_wall_time = NULL, catch_up_step = NULL,
             catch_up_reconcile_attempted_at = NULL
           WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`
          : `UPDATE clockgrove.partition_states SET catch_up_step = catch_up_step + 1
           WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
        [key.tenantId, key.timelineId, key.partitionId],
      );
      return true;
    });
  }

  async openCases(limit: number): Promise<readonly CatchUpWorkflowEnvelope[]> {
    return withClientTransaction(this.client, {}, async () => {
      const result = await this.client.query(
        `SELECT * FROM clockgrove.open_catch_up_operations($1)`,
        [limit],
      );
      return result.rows.map((value) => {
        const row = record(value, "catch-up candidate");
        return decodeCatchUpWorkflowEnvelope({
          version: 1,
          tenantId: row.tenant_id,
          worldId: row.world_id,
          timelineId: row.timeline_id,
          spaceId: row.space_id,
          applicationRunId: row.catch_up_run_id,
        });
      });
    });
  }
}
