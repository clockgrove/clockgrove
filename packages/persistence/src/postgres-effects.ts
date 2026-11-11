import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface EffectAddress {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly effectId: string;
}
export type EffectTerminalDisposition = "succeeded" | "failed" | "uncertain";
export interface EffectCompletion {
  readonly disposition: EffectTerminalDisposition;
  readonly outcomeCode: string;
  readonly resultArtifactId: string | null;
  readonly costMicrousd: number | null;
}
export interface RecordedEffect {
  readonly disposition:
    | "pending"
    | "started"
    | EffectTerminalDisposition
    | "blocked"
    | "simulated"
    | "refused";
  readonly attemptId: string | null;
  readonly attemptDisposition: "started" | EffectTerminalDisposition | null;
  readonly outcomeCode: string | null;
  readonly resultArtifactId: string | null;
  readonly costMicrousd: number | null;
  readonly endedAt: string | null;
}

const predicate = "tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4";
const columns = `i.disposition, a.attempt_id AS "attemptId", a.disposition AS "attemptDisposition",
  coalesce(a.outcome_code,i.outcome_code) AS "outcomeCode", a.result_artifact_id AS "resultArtifactId",
  a.cost_microusd::text AS "costMicrousd", coalesce(a.ended_at,i.ended_at)::text AS "endedAt"`;

function identity(value: string): boolean {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length >= 1 &&
    new TextEncoder().encode(value).length <= 1024
  );
}
function addressValues(address: EffectAddress): string[] {
  const values = [address.tenantId, address.worldId, address.timelineId, address.effectId];
  if (!values.every(identity)) throw new Error("Invalid effect address");
  return values;
}
function completionValues(completion: EffectCompletion): unknown[] {
  if (
    !["succeeded", "failed", "uncertain"].includes(completion.disposition) ||
    !/^[a-z_]{1,64}$/.test(completion.outcomeCode) ||
    (completion.resultArtifactId !== null && !identity(completion.resultArtifactId)) ||
    (completion.disposition === "succeeded" && completion.resultArtifactId === null) ||
    (completion.costMicrousd !== null &&
      (!Number.isSafeInteger(completion.costMicrousd) || completion.costMicrousd < 0))
  ) {
    throw new Error("Invalid effect completion");
  }
  return [
    completion.disposition,
    completion.outcomeCode,
    completion.resultArtifactId,
    completion.costMicrousd,
  ];
}

/** Internal storage only: requires a privileged, already-authorized client, never a runtime grant. */
export class PostgreSqlEffects {
  constructor(private readonly client: PostgreSqlClient) {}

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withClientTransaction(this.client, {}, operation);
    } catch {
      // SQL constraint errors can contain values; no driver text crosses this boundary.
      throw new Error("Effect persistence unavailable");
    }
  }

  async read(address: EffectAddress): Promise<RecordedEffect | null> {
    const values = addressValues(address);
    return this.transaction(() => this.recorded(values));
  }

  private async recorded(values: readonly string[]): Promise<RecordedEffect | null> {
    const result = await this.client.query(
      `SELECT ${columns} FROM clockgrove.effect_intents i
      LEFT JOIN clockgrove.effect_attempts a USING(tenant_id,world_id,timeline_id,effect_id)
      WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.timeline_id=$3 AND i.effect_id=$4`,
      values,
    );
    if (result.rows[0] === undefined) return null;
    const row = result.rows[0] as Omit<RecordedEffect, "costMicrousd"> & {
      costMicrousd: string | null;
    };
    return { ...row, costMicrousd: row.costMicrousd === null ? null : Number(row.costMicrousd) };
  }

  private async lock(values: readonly string[]): Promise<string | null> {
    const result = await this.client.query(
      `SELECT disposition FROM clockgrove.effect_intents
      WHERE ${predicate} FOR UPDATE`,
      values,
    );
    return (result.rows[0] as { disposition: string } | undefined)?.disposition ?? null;
  }

  async claim(
    address: EffectAddress,
    attemptId: string,
  ): Promise<{ claimed: boolean; effect: RecordedEffect | null }> {
    const values = addressValues(address);
    if (!identity(attemptId)) throw new Error("Invalid effect attempt");
    return this.transaction(async () => {
      const disposition = await this.lock(values);
      if (disposition !== "pending") return { claimed: false, effect: await this.recorded(values) };
      await this.client.query(
        `UPDATE clockgrove.effect_intents SET disposition='started' WHERE ${predicate}`,
        values,
      );
      await this.client.query(
        `INSERT INTO clockgrove.effect_attempts
        (tenant_id,world_id,timeline_id,effect_id,attempt_id) VALUES ($1,$2,$3,$4,$5)`,
        [...values, attemptId],
      );
      return { claimed: true, effect: await this.recorded(values) };
    });
  }

  async complete(
    address: EffectAddress,
    attemptId: string,
    completion: EffectCompletion,
  ): Promise<RecordedEffect> {
    const values = addressValues(address);
    completion = { ...completion };
    if (!identity(attemptId)) throw new Error("Invalid effect attempt");
    const outcome = completionValues(completion);
    return this.transaction(async () => {
      const disposition = await this.lock(values);
      const record = await this.recorded(values);
      if (record === null || record.attemptId !== attemptId || disposition === "pending") {
        throw new Error("Effect attempt unavailable");
      }
      if (record.attemptDisposition === "started") {
        await this.client.query(
          `UPDATE clockgrove.effect_attempts SET disposition=$6,outcome_code=$7,
          result_artifact_id=$8,cost_microusd=$9,ended_at=statement_timestamp()
          WHERE ${predicate} AND attempt_id=$5`,
          [...values, attemptId, ...outcome],
        );
      } else if (
        record.attemptDisposition !== completion.disposition ||
        record.outcomeCode !== completion.outcomeCode ||
        record.resultArtifactId !== completion.resultArtifactId ||
        record.costMicrousd !== completion.costMicrousd
      ) {
        throw new Error("Effect completion conflicts with recorded outcome");
      }
      await this.settle(values);
      return (await this.recorded(values)) as RecordedEffect;
    });
  }

  /** A terminal attempt is authoritative after a crash; a started attempt remains explicitly in flight. */
  async reconcile(address: EffectAddress): Promise<RecordedEffect | null> {
    const values = addressValues(address);
    return this.transaction(async () => {
      await this.lock(values);
      await this.settle(values);
      return this.recorded(values);
    });
  }

  private async settle(values: readonly string[]): Promise<void> {
    await this.client.query(
      `UPDATE clockgrove.effect_intents i SET disposition=a.disposition,
      outcome_code=a.outcome_code,ended_at=a.ended_at FROM clockgrove.effect_attempts a
      WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.timeline_id=$3 AND i.effect_id=$4
      AND a.tenant_id=i.tenant_id AND a.world_id=i.world_id AND a.timeline_id=i.timeline_id
      AND a.effect_id=i.effect_id AND i.disposition='started' AND a.disposition<>'started'`,
      values,
    );
  }

  async accounting(
    scope: Omit<EffectAddress, "effectId">,
  ): Promise<{ knownCostMicrousd: string; unknownCostCount: string }> {
    const values = addressValues({ ...scope, effectId: "accounting" }).slice(0, 3);
    return this.transaction(async () => {
      const result = await this.client.query(
        `SELECT coalesce(sum(cost_microusd),0)::text AS "knownCostMicrousd",
        count(*) FILTER (WHERE cost_microusd IS NULL)::text AS "unknownCostCount"
        FROM clockgrove.effect_attempts WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3
        AND disposition<>'started'`,
        values,
      );
      return result.rows[0] as { knownCostMicrousd: string; unknownCostCount: string };
    });
  }
}
