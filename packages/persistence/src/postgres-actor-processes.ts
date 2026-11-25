import type { RuntimeAuthorizationContext } from "@clockgrove/application";
import type {
  ActorProcess,
  ActorProcessBudget,
  ActorProcessMode,
  BrowserScope,
} from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;

/** A segment written under a lease epoch a newer claim replaced (CG022, migration 0038). */
export class StaleProcessLeaseError extends Error {
  constructor() {
    super("stale actor process lease");
    this.name = "StaleProcessLeaseError";
  }
}

/** A segment past the process's step or segment budget (CG025, migration 0079). */
export class ProcessBudgetError extends Error {
  constructor() {
    super("actor process budget exceeded");
    this.name = "ProcessBudgetError";
  }
}

/**
 * `ActorProcess` state over migrations 0038 and 0079. A process keeps its ID for life; each bounded segment
 * claims the next lease epoch, then appends one checkpoint segment under it. The segment trigger
 * fences the epoch and moves the checkpoint, so a superseded holder can never advance the process.
 */
export class PostgreSqlActorProcesses {
  constructor(private readonly client: PostgreSqlClient) {}

  /**
   * Creates the process if it does not exist; an existing one keeps its objective, target, mode and
   * budget. An omitted budget takes the table's bounds (64 segments, 10,000 steps a segment).
   */
  start(
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    process: {
      readonly processId: string;
      readonly actorId: string;
      readonly target: number;
      readonly mode: ActorProcessMode;
      readonly budget?: ActorProcessBudget;
    },
  ): Promise<void> {
    return this.transaction(authorization, async () => {
      await this.client.query(
        `INSERT INTO clockgrove.actor_processes (
           tenant_id, process_id, world_id, timeline_id, actor_id, objective, target, mode,
           segment_limit, step_limit
         ) VALUES ($1, $2, $3, $4, $5, 'fixture-tally', $6, $7, coalesce($8, 64), coalesce($9, 10000))
         ON CONFLICT (tenant_id, process_id) DO NOTHING`,
        [
          scope.tenantId,
          process.processId,
          scope.worldId,
          scope.timelineId,
          process.actorId,
          process.target,
          process.mode,
          process.budget?.segments ?? null,
          process.budget?.steps ?? null,
        ],
      );
    });
  }

  /**
   * Takes the next lease epoch for a holder; undefined when the process is completed or its segment
   * budget is spent.
   */
  claim(
    authorization: RuntimeAuthorizationContext,
    processId: string,
    holder: string,
  ): Promise<
    | {
        readonly leaseEpoch: number;
        readonly checkpoint: number;
        readonly target: number;
        readonly stepLimit: number;
      }
    | undefined
  > {
    return this.transaction(authorization, async () => {
      const claimed = await this.client.query(
        `UPDATE clockgrove.actor_processes
            SET lease_epoch = lease_epoch + 1, lease_holder = $3
          WHERE tenant_id = $1 AND process_id = $2 AND state = 'active'
            AND segments < segment_limit
          RETURNING lease_epoch, checkpoint, target, step_limit`,
        [authorization.tenantId, processId, holder],
      );
      const row = claimed.rows[0] as Row | undefined;
      if (row === undefined) return undefined;
      return {
        leaseEpoch: Number(row.lease_epoch),
        checkpoint: Number(row.checkpoint),
        target: Number(row.target),
        stepLimit: Number(row.step_limit),
      };
    });
  }

  /** Appends a segment under the claimed epoch; a newer claim makes it stale. */
  async segment(
    authorization: RuntimeAuthorizationContext,
    processId: string,
    lease: { readonly leaseEpoch: number; readonly holder: string },
    fromCheckpoint: number,
    toCheckpoint: number,
  ): Promise<void> {
    try {
      await this.transaction(authorization, async () => {
        await this.client.query(
          `INSERT INTO clockgrove.actor_process_segments (
             tenant_id, process_id, segment, lease_epoch, lease_holder, from_checkpoint,
             to_checkpoint
           ) SELECT $1, $2, segments + 1, $3, $4, $5, $6 FROM clockgrove.actor_processes
              WHERE tenant_id = $1 AND process_id = $2`,
          [
            authorization.tenantId,
            processId,
            lease.leaseEpoch,
            lease.holder,
            fromCheckpoint,
            toCheckpoint,
          ],
        );
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "CG022") throw new StaleProcessLeaseError();
      if (code === "CG025") throw new ProcessBudgetError();
      throw error;
    }
  }

  read(authorization: RuntimeAuthorizationContext, processId: string): Promise<ActorProcess> {
    return this.transaction(authorization, async () => {
      const found = await this.client.query(
        `SELECT process_id, actor_id, objective, mode, segment_limit, step_limit, target,
                checkpoint, state, lease_epoch,
                (SELECT coalesce(json_agg(json_build_object(
                          'segment', segment, 'leaseEpoch', lease_epoch,
                          'fromCheckpoint', from_checkpoint, 'toCheckpoint', to_checkpoint)
                        ORDER BY segment), '[]'::json)
                   FROM clockgrove.actor_process_segments AS segment
                  WHERE segment.tenant_id = process.tenant_id
                    AND segment.process_id = process.process_id) AS segments
           FROM clockgrove.actor_processes AS process
          WHERE tenant_id = $1 AND process_id = $2`,
        [authorization.tenantId, processId],
      );
      const row = found.rows[0] as Row | undefined;
      if (row === undefined) throw new Error("actor process not found");
      return Object.freeze({
        processId: String(row.process_id),
        actorId: String(row.actor_id),
        objective: "fixture-tally" as const,
        mode: String(row.mode) as ActorProcessMode,
        budget: Object.freeze({
          segments: Number(row.segment_limit),
          steps: Number(row.step_limit),
        }),
        target: Number(row.target),
        checkpoint: Number(row.checkpoint),
        state: row.state === "completed" ? ("completed" as const) : ("active" as const),
        leaseEpoch: Number(row.lease_epoch),
        segments: (row.segments as ActorProcess["segments"]).map((segment) => ({
          ...segment,
          leaseEpoch: Number(segment.leaseEpoch),
        })),
      });
    });
  }

  private transaction<T>(
    authorization: RuntimeAuthorizationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withClientTransaction(this.client, { authorization }, operation);
  }
}
