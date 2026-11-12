import type { QueueEnvelope } from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface EffectAddress {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly effectId: string;
}
export interface EffectIntentMetadata extends EffectAddress {
  readonly spaceId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly runId: string | null;
  readonly callId: string;
  readonly capabilityId: string;
  readonly grantId: string;
  readonly policyVersion: string;
  readonly argumentsHash: string;
  readonly argumentsArtifactId: string | null;
  readonly reservedMicrousd: number;
}
export type EffectReservation = EffectIntentMetadata &
  (
    | { readonly disposition: "pending"; readonly dispatchId: string; readonly eventId: string }
    | {
        readonly disposition: "blocked" | "simulated" | "refused";
        readonly outcomeCode: string;
      }
  );
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

function reservationValues(request: EffectReservation) {
  const address = addressValues(request);
  const metadata = [
    request.spaceId,
    request.idempotencyKey,
    request.actorId,
    request.principalId,
    request.runId,
    request.callId,
    request.capabilityId,
    request.grantId,
    request.policyVersion,
    request.argumentsHash,
    request.argumentsArtifactId,
    request.reservedMicrousd,
  ];
  if (
    !metadata
      .slice(0, 9)
      .every(
        (value, index) =>
          (index === 4 && value === null) ||
          (index === 6
            ? typeof value === "string" &&
              new TextEncoder().encode(value).length >= 1 &&
              new TextEncoder().encode(value).length <= 4096
            : identity(value as string)),
      ) ||
    !/^[a-f0-9]{64}$/.test(request.argumentsHash) ||
    (request.argumentsArtifactId !== null && !identity(request.argumentsArtifactId)) ||
    !Number.isSafeInteger(request.reservedMicrousd) ||
    request.reservedMicrousd < 0 ||
    (request.disposition === "pending"
      ? !identity(request.dispatchId) || !identity(request.eventId)
      : !["blocked", "simulated", "refused"].includes(request.disposition) ||
        !/^[a-z_]{1,64}$/.test(request.outcomeCode))
  )
    throw new Error("Invalid effect reservation");
  return { address, metadata };
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

  /** Persists prior admission atomically; this is not a grant check or a budget reservation. */
  async reserve(request: EffectReservation): Promise<RecordedEffect> {
    request = { ...request };
    reservationValues(request);
    return this.transaction(() => this.reserveInTransaction(request));
  }

  /** Trusted admission composes reservation and ledger in its already-open transaction. */
  async reserveInTransaction(request: EffectReservation): Promise<RecordedEffect> {
    request = { ...request };
    const { address, metadata } = reservationValues(request);
    const pending = request.disposition === "pending";
    const reason = request.disposition === "pending" ? null : request.outcomeCode;
    const values = [...address, ...metadata];
    {
      const inserted = await this.client.query(
        `INSERT INTO clockgrove.effect_intents
        (tenant_id,world_id,timeline_id,effect_id,space_id,idempotency_key,actor_id,principal_id,
        run_id,call_id,capability_id,grant_id,policy_version,arguments_hash,arguments_artifact_id,
        reserved_microusd,disposition,outcome_code,ended_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          CASE WHEN $17='pending' THEN NULL ELSE statement_timestamp() END)
        ON CONFLICT DO NOTHING RETURNING effect_id`,
        [...values, request.disposition, reason],
      );
      // INSERT's unique-index arbitration serializes concurrent retries, including absent rows.
      const matches = await this.client.query(
        `SELECT 1 FROM clockgrove.effect_intents WHERE ${predicate}
        AND ROW(space_id,idempotency_key,actor_id,principal_id,run_id,call_id,capability_id,
          grant_id,policy_version,arguments_hash,arguments_artifact_id,reserved_microusd)
        IS NOT DISTINCT FROM ROW($5::text,$6::text,$7::text,$8::text,$9::text,$10::text,
          $11::text,$12::text,$13::text,$14::text,$15::text,$16::bigint)
        AND (($17::boolean AND disposition IN ('pending','started','succeeded','failed','uncertain'))
          OR (NOT $17::boolean AND disposition=$18 AND outcome_code=$19)) FOR UPDATE`,
        [...values, pending, request.disposition, reason],
      );
      if (matches.rows.length !== 1) throw new Error("Effect reservation conflicts");
      if (request.disposition === "pending") {
        const dispatchValues = [...address, request.dispatchId, request.eventId, request.spaceId];
        if (inserted.rows.length === 1)
          await this.client.query(
            `INSERT INTO clockgrove.event_dispatches
          (tenant_id,world_id,timeline_id,partition_id,space_id,dispatch_id,event_id,channel,status,privacy_class,payload)
          SELECT tenant_id,world_id,timeline_id,partition_id,space_id,$5,event_id,
          'external-effects','pending','conversation',jsonb_build_object('effectId',$4::text)
          FROM clockgrove.events WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3
          AND event_id=$6 AND space_id=$7 AND privacy_class='conversation'
          ON CONFLICT DO NOTHING`,
            dispatchValues,
          );
        const dispatch = await this.client.query(
          `SELECT 1 FROM clockgrove.event_dispatches d JOIN clockgrove.events e
          ON e.tenant_id=d.tenant_id AND e.event_id=d.event_id
          WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.timeline_id=$3 AND d.dispatch_id=$5
          AND d.event_id=$6 AND d.space_id=$7 AND d.channel='external-effects'
          AND d.privacy_class='conversation' AND d.payload=jsonb_build_object('effectId',$4::text)
          AND e.world_id=$2 AND e.timeline_id=$3 AND e.space_id=$7
          AND e.partition_id=d.partition_id AND e.privacy_class='conversation'`,
          dispatchValues,
        );
        if (dispatch.rows.length !== 1) throw new Error("Effect dispatch conflicts");
      } else {
        const dispatch = await this.client.query(
          `SELECT 1 FROM clockgrove.event_dispatches WHERE tenant_id=$1 AND world_id=$2
          AND timeline_id=$3 AND channel='external-effects' AND payload=jsonb_build_object('effectId',$4::text)`,
          address,
        );
        if (dispatch.rows.length !== 0) throw new Error("Effect disposition conflicts");
      }
      return (await this.recorded(address)) as RecordedEffect;
    }
  }

  /** Queue identity is a reference, never authority or an adapter request. */
  async resolveDispatch(message: QueueEnvelope<unknown>): Promise<EffectIntentMetadata | null> {
    const payload = message.payload;
    if (
      message.channel !== "external-effects" ||
      !message.worldId ||
      !message.timelineId ||
      !message.sourceEventId ||
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      Object.keys(payload)[0] !== "effectId" ||
      !("effectId" in payload) ||
      typeof payload.effectId !== "string" ||
      !identity(payload.effectId) ||
      (message.effectId !== undefined && message.effectId !== payload.effectId)
    )
      return null;
    const effectId = payload.effectId;
    return this.transaction(async () => {
      const result = await this.client.query(
        `SELECT i.tenant_id AS "tenantId",i.world_id AS "worldId",i.timeline_id AS "timelineId",
          i.effect_id AS "effectId",i.space_id AS "spaceId",i.idempotency_key AS "idempotencyKey",
          i.actor_id AS "actorId",i.principal_id AS "principalId",i.run_id AS "runId",
          i.call_id AS "callId",i.capability_id AS "capabilityId",i.grant_id AS "grantId",
          i.policy_version AS "policyVersion",i.arguments_hash AS "argumentsHash",
          i.arguments_artifact_id AS "argumentsArtifactId",i.reserved_microusd::text AS "reservedMicrousd"
        FROM clockgrove.event_dispatches d
        JOIN clockgrove.events e ON e.tenant_id=d.tenant_id AND e.event_id=d.event_id
        JOIN clockgrove.effect_intents i ON i.tenant_id=d.tenant_id AND i.world_id=d.world_id
          AND i.timeline_id=d.timeline_id AND i.effect_id=$7 AND i.space_id=d.space_id
        JOIN clockgrove.timelines t ON t.tenant_id=i.tenant_id AND t.world_id=i.world_id
          AND t.timeline_id=i.timeline_id AND t.kind='live'
        WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.timeline_id=$3 AND d.dispatch_id=$4
          AND d.event_id=$5 AND e.correlation_id=$6 AND d.channel='external-effects'
          AND d.privacy_class='conversation' AND d.payload=jsonb_build_object('effectId',$7::text)
          AND e.world_id=d.world_id AND e.timeline_id=d.timeline_id
          AND e.partition_id=d.partition_id AND e.space_id=d.space_id AND e.privacy_class='conversation'`,
        [
          message.tenantId,
          message.worldId,
          message.timelineId,
          message.messageId,
          message.sourceEventId,
          message.correlationId,
          effectId,
        ],
      );
      const row = result.rows[0] as
        | (Omit<EffectIntentMetadata, "reservedMicrousd"> & { reservedMicrousd: string })
        | undefined;
      return row ? { ...row, reservedMicrousd: Number(row.reservedMicrousd) } : null;
    });
  }

  async read(address: EffectAddress): Promise<RecordedEffect | null> {
    const values = addressValues(address);
    return this.transaction(() => this.recorded(values));
  }

  /** Internal caller already owns the client transaction. */
  async readInTransaction(address: EffectAddress): Promise<RecordedEffect | null> {
    return this.recorded(addressValues(address));
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
