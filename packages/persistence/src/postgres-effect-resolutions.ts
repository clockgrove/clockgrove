import type { EffectAddress } from "./postgres-effects.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface EffectResolutionRequest extends EffectAddress {
  readonly attemptId: string;
  readonly resolvedBy: string;
  readonly disposition: "done" | "failed";
}
export interface RecordedEffectResolution extends EffectResolutionRequest {
  readonly spaceId: string;
  readonly resolvedAt: string;
}
const predicate = "tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4";
const columns = `tenant_id AS "tenantId",world_id AS "worldId",timeline_id AS "timelineId",
  effect_id AS "effectId",space_id AS "spaceId",attempt_id AS "attemptId",
  resolved_by AS "resolvedBy",disposition,resolved_at::text AS "resolvedAt"`;
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length > 0 &&
    new TextEncoder().encode(value).length <= 1024
  );
}
function addressValues(address: EffectAddress): string[] {
  const values = [address.tenantId, address.worldId, address.timelineId, address.effectId];
  if (!values.every(identifier)) throw new Error("Invalid effect resolution address");
  return values;
}

/** Privileged internal storage. Trusted composition authenticates the operator and current grants;
 * neither models nor runtime SQL receive mutation authority. A resolution never retries a call. */
export class PostgreSqlEffectResolutions {
  constructor(private readonly client: PostgreSqlClient) {}
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withClientTransaction(this.client, {}, operation);
    } catch {
      throw new Error("Effect resolution persistence unavailable");
    }
  }
  private async recorded(values: readonly string[]): Promise<RecordedEffectResolution | null> {
    const result = await this.client.query(
      `SELECT ${columns} FROM clockgrove.effect_resolutions WHERE ${predicate}`,
      values,
    );
    return (result.rows[0] as RecordedEffectResolution | undefined) ?? null;
  }
  async read(address: EffectAddress): Promise<RecordedEffectResolution | null> {
    const values = addressValues(address);
    return this.transaction(() => this.recorded(values));
  }
  async resolve(request: EffectResolutionRequest): Promise<RecordedEffectResolution> {
    request = { ...request };
    const values = addressValues(request);
    if (
      !identifier(request.attemptId) ||
      !identifier(request.resolvedBy) ||
      !["done", "failed"].includes(request.disposition)
    )
      throw new Error("Invalid effect resolution");
    return this.transaction(async () => {
      const intent = await this.client.query(
        `SELECT space_id AS "spaceId" FROM clockgrove.effect_intents
        WHERE ${predicate} AND disposition='uncertain' FOR UPDATE`,
        values,
      );
      const spaceId = (intent.rows[0] as { spaceId: string } | undefined)?.spaceId;
      if (spaceId === undefined) throw new Error("Effect uncertainty unavailable");
      await this.client.query(
        `INSERT INTO clockgrove.effect_resolutions
        (tenant_id,world_id,timeline_id,effect_id,space_id,attempt_id,resolved_by,disposition)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [...values, spaceId, request.attemptId, request.resolvedBy, request.disposition],
      );
      const record = await this.recorded(values);
      if (
        !record ||
        record.attemptId !== request.attemptId ||
        record.resolvedBy !== request.resolvedBy ||
        record.disposition !== request.disposition
      )
        throw new Error("Effect resolution conflicts");
      return record;
    });
  }
}
