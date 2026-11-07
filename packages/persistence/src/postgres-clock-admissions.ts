import {
  clockTarget,
  JournalRevisionConflictError,
  JournalRouteNotFoundError,
  type RuntimeAuthorizationContext,
  type RuntimeAuthorizationScope,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import type { PostgreSqlClient } from "./postgres-transaction.js";
import { withClientTransaction } from "./postgres-transaction.js";
import { readTimelineClockPolicy, record, text } from "./postgres-world-command.js";

export interface ClockAdmission {
  readonly activationId: string;
  readonly policyVersion: bigint;
  readonly horizon: bigint;
  readonly admitted: bigint;
}

/** Durable admission high-water mark and bounded activation receipts, under the physical lock. */
export class PostgreSqlClockAdmissionReader {
  constructor(private readonly client: PostgreSqlClient) {}

  /** The owner generation an incarnation observes once, before its first claim attempt. */
  ownerGeneration(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
  ): Promise<bigint> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT clock_owner_generation::text AS generation FROM clockgrove.partition_states
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
      return BigInt(text(record(result.rows[0], "owner generation"), "generation"));
    });
  }

  /**
   * The claim is the partition row itself (generation and owner id), so it keeps no history. Every
   * attempt of one incarnation carries the generation it observed before its first attempt:
   * - the current owner is this incarnation: its committed claim, recovered after a lost response;
   * - the generation is still the observed one: nobody claimed since, so this incarnation claims;
   * - otherwise a newer incarnation claimed after the observation and supersedes this one, at any
   *   retry delay: refused, never reclaimed.
   */
  claimOwner(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
    ownerId: string,
    observedGeneration: bigint,
  ): Promise<bigint> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT partition_id, clock_owner_generation::text AS generation, clock_owner_id
           FROM clockgrove.partition_states
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
          FOR UPDATE`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
      const row = record(result.rows[0], "owner generation");
      const current = BigInt(text(row, "generation"));
      if (row.clock_owner_id === ownerId) return current;
      if (current !== observedGeneration)
        throw new JournalRevisionConflictError("owner-generation", observedGeneration, current);
      await this.client.query(
        `UPDATE clockgrove.partition_states
            SET clock_owner_generation = $5, clock_owner_id = $4
          WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
        [
          scope.tenantId,
          scope.timelineId,
          decodeOpaqueId(row.partition_id, "PartitionId"),
          ownerId,
          (current + 1n).toString(),
        ],
      );
      return current + 1n;
    });
  }

  admit(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeAuthorizationScope,
    activation: Readonly<{
      activationId: string;
      policyVersion: bigint;
      wallTime: bigint;
      ownerGeneration?: bigint;
    }>,
  ): Promise<ClockAdmission> {
    return withClientTransaction(this.client, { authorization }, async () => {
      const result = await this.client.query(
        `SELECT partition_id, greatest(clock_admitted_horizon, simulation_time)::text AS horizon,
                simulation_time::text AS committed, clock_owner_generation::text AS generation
           FROM clockgrove.partition_states
          WHERE tenant_id = $1 AND world_id = $2 AND timeline_id = $3 AND space_id = $4
          FOR UPDATE`,
        [scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
      );
      if (result.rows.length !== 1) throw new JournalRouteNotFoundError(scope.spaceId);
      const row = record(result.rows[0], "admission state");
      const generation = BigInt(text(row, "generation"));
      if (activation.ownerGeneration !== undefined && activation.ownerGeneration !== generation) {
        throw new JournalRevisionConflictError(
          "owner-generation",
          activation.ownerGeneration,
          generation,
        );
      }
      const key = {
        tenantId: scope.tenantId,
        timelineId: scope.timelineId,
        partitionId: decodeOpaqueId(row.partition_id, "PartitionId"),
      };
      const policy = await readTimelineClockPolicy(this.client, key);
      if (policy.version !== activation.policyVersion) {
        throw new JournalRevisionConflictError(
          "clock-policy",
          activation.policyVersion,
          policy.version,
        );
      }
      const identity = [key.tenantId, key.timelineId, key.partitionId, activation.activationId];
      const receipt = await this.client.query(
        `SELECT policy_version::text, horizon::text, admitted::text FROM clockgrove.clock_admissions
          WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3 AND activation_id = $4`,
        identity,
      );
      if (receipt.rows.length === 1) {
        const stored = record(receipt.rows[0], "admission receipt");
        const receiptVersion = BigInt(text(stored, "policy_version"));
        if (receiptVersion !== policy.version) {
          throw new JournalRevisionConflictError("clock-policy", receiptVersion, policy.version);
        }
        return {
          activationId: activation.activationId,
          policyVersion: receiptVersion,
          horizon: BigInt(text(stored, "horizon")),
          admitted: BigInt(text(stored, "admitted")),
        };
      }
      const prior = BigInt(text(row, "horizon"));
      const horizon = clockTarget(policy, prior, activation.wallTime);
      const admitted = horizon - prior;
      await this.client.query(
        `UPDATE clockgrove.partition_states SET clock_admitted_horizon = $4
          WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3`,
        [key.tenantId, key.timelineId, key.partitionId, horizon.toString()],
      );
      // Retire receipts no replay can reach. A fenced (native) owner replays only its newest
      // activation, so its new admission retires every other receipt: at most one per partition.
      // Without a generation, keep this generation's and policy's receipts not yet committed.
      await this.client.query(
        `DELETE FROM clockgrove.clock_admissions
          WHERE tenant_id = $1 AND timeline_id = $2 AND partition_id = $3
            AND ($7 OR owner_generation <> $4 OR policy_version <> $5 OR horizon <= $6)`,
        [
          key.tenantId,
          key.timelineId,
          key.partitionId,
          generation.toString(),
          policy.version.toString(),
          text(row, "committed"),
          activation.ownerGeneration !== undefined,
        ],
      );
      await this.client.query(
        `INSERT INTO clockgrove.clock_admissions
          (tenant_id, timeline_id, partition_id, activation_id, policy_version, horizon, admitted,
           owner_generation)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ...identity,
          policy.version.toString(),
          horizon.toString(),
          admitted.toString(),
          generation.toString(),
        ],
      );
      return {
        activationId: activation.activationId,
        policyVersion: policy.version,
        horizon,
        admitted,
      };
    });
  }
}
