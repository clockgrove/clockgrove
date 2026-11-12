import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface EffectApprovalAddress {
  readonly tenantId: string;
  readonly worldId: string;
  readonly timelineId: string;
  readonly approvalId: string;
}
export interface EffectApprovalRequest extends EffectApprovalAddress {
  readonly spaceId: string;
  readonly effectId: string;
  readonly principalId: string;
  readonly approverPrincipalId: string;
  readonly argumentsHash: string;
  readonly effectHash: string;
  readonly argumentsArtifactId: string | null;
  /** Owner decision, issue 166: ten wall-clock minutes by default. */
  readonly expirySeconds?: number;
}
export interface RecordedEffectApproval extends Omit<EffectApprovalRequest, "expirySeconds"> {
  readonly expirySeconds: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: "pending" | "approved" | "denied" | "revoked" | "expired" | "consumed";
  readonly decision: "approved" | "denied" | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly consumedBy: string | null;
  readonly consumedAt: string | null;
}
export interface EffectApprovalBinding extends EffectApprovalRequest {
  readonly expiresAt: string;
}
const predicate = "tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND approval_id=$4";
const columns = `tenant_id AS "tenantId",world_id AS "worldId",timeline_id AS "timelineId",
  approval_id AS "approvalId",space_id AS "spaceId",effect_id AS "effectId",principal_id AS "principalId",
  approver_principal_id AS "approverPrincipalId",arguments_hash AS "argumentsHash",effect_hash AS "effectHash",
  arguments_artifact_id AS "argumentsArtifactId",expiry_seconds AS "expirySeconds",created_at::text AS "createdAt",
  expires_at::text AS "expiresAt",state,decision,decided_by AS "decidedBy",decided_at::text AS "decidedAt",
  revoked_by AS "revokedBy",revoked_at::text AS "revokedAt",consumed_by AS "consumedBy",consumed_at::text AS "consumedAt"`;
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length > 0 &&
    new TextEncoder().encode(value).length <= 1024
  );
}
function addressValues(address: EffectApprovalAddress): string[] {
  const values = [address.tenantId, address.worldId, address.timelineId, address.approvalId];
  if (!values.every(identifier)) throw new Error("Invalid approval address");
  return values;
}
function requestValues(request: EffectApprovalRequest): unknown[] {
  const expiry = request.expirySeconds ?? 600;
  if (
    ![request.spaceId, request.effectId, request.principalId, request.approverPrincipalId].every(
      identifier,
    ) ||
    !/^[a-f0-9]{64}$/.test(request.argumentsHash) ||
    !/^[a-f0-9]{64}$/.test(request.effectHash) ||
    (request.argumentsArtifactId !== null && !identifier(request.argumentsArtifactId)) ||
    !Number.isInteger(expiry) ||
    expiry <= 0 ||
    expiry > 2147483647 // PostgreSQL signed integer storage bound.
  )
    throw new Error("Invalid approval request");
  return [
    ...addressValues(request),
    request.spaceId,
    request.effectId,
    request.principalId,
    request.approverPrincipalId,
    request.argumentsHash,
    request.effectHash,
    request.argumentsArtifactId,
    expiry,
  ];
}
function matches(record: RecordedEffectApproval, request: EffectApprovalRequest): boolean {
  return (
    record.spaceId === request.spaceId &&
    record.effectId === request.effectId &&
    record.principalId === request.principalId &&
    record.approverPrincipalId === request.approverPrincipalId &&
    record.argumentsHash === request.argumentsHash &&
    record.effectHash === request.effectHash &&
    record.argumentsArtifactId === request.argumentsArtifactId &&
    record.expirySeconds === (request.expirySeconds ?? 600)
  );
}

/** Privileged internal storage only. Trusted composition must authenticate the human, resolve
 * current grants and normalize/hash the exact call before using this port. Models have no access.
 * An approval alone grants no execution authority; consume it in the dispatch transaction. */
export class PostgreSqlEffectApprovals {
  constructor(private readonly client: PostgreSqlClient) {}
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withClientTransaction(this.client, {}, operation);
    } catch {
      throw new Error("Approval persistence unavailable");
    }
  }
  private async locked(address: EffectApprovalAddress): Promise<RecordedEffectApproval | null> {
    const values = addressValues(address);
    await this.client.query(
      `SELECT 1 FROM clockgrove.effect_approvals WHERE ${predicate} FOR UPDATE`,
      values,
    );
    await this.client.query(
      `UPDATE clockgrove.effect_approvals SET state='expired'
      WHERE ${predicate} AND state IN ('pending','approved') AND expires_at<=clock_timestamp()`,
      values,
    );
    return this.recorded(address);
  }
  private async recorded(address: EffectApprovalAddress): Promise<RecordedEffectApproval | null> {
    const result = await this.client.query(
      `SELECT ${columns} FROM clockgrove.effect_approvals WHERE ${predicate}`,
      addressValues(address),
    );
    return (result.rows[0] as RecordedEffectApproval | undefined) ?? null;
  }
  async request(request: EffectApprovalRequest): Promise<RecordedEffectApproval> {
    request = { ...request };
    const values = requestValues(request);
    return this.transaction(async () => {
      await this.client.query(
        `INSERT INTO clockgrove.effect_approvals
        (tenant_id,world_id,timeline_id,approval_id,space_id,effect_id,principal_id,approver_principal_id,
         arguments_hash,effect_hash,arguments_artifact_id,expiry_seconds,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()) ON CONFLICT DO NOTHING`,
        values,
      );
      const record = await this.locked(request);
      if (!record || !matches(record, request)) throw new Error("Approval request conflicts");
      return record;
    });
  }
  async read(address: EffectApprovalAddress): Promise<RecordedEffectApproval | null> {
    address = { ...address };
    addressValues(address);
    return this.transaction(() => this.locked(address));
  }
  async decide(
    address: EffectApprovalAddress,
    humanPrincipalId: string,
    decision: "approved" | "denied",
  ): Promise<RecordedEffectApproval> {
    address = { ...address };
    addressValues(address);
    if (!identifier(humanPrincipalId) || !["approved", "denied"].includes(decision))
      throw new Error("Invalid approval decision");
    return this.transaction(async () => {
      const record = await this.locked(address);
      if (!record || record.approverPrincipalId !== humanPrincipalId)
        throw new Error("Approval decision refused");
      if (record.decision === decision) return record;
      if (record.state !== "pending") throw new Error("Approval decision conflicts");
      await this.client.query(
        `UPDATE clockgrove.effect_approvals SET state=$5,decided_by=$6 WHERE ${predicate}`,
        [...addressValues(address), decision, humanPrincipalId],
      );
      return (await this.recorded(address))!;
    });
  }
  async revoke(
    address: EffectApprovalAddress,
    humanPrincipalId: string,
  ): Promise<RecordedEffectApproval> {
    address = { ...address };
    addressValues(address);
    if (!identifier(humanPrincipalId)) throw new Error("Invalid approval revocation");
    return this.transaction(async () => {
      const record = await this.locked(address);
      if (!record || record.approverPrincipalId !== humanPrincipalId)
        throw new Error("Approval revocation refused");
      if (record.state === "revoked") return record;
      if (!["pending", "approved"].includes(record.state))
        throw new Error("Approval revocation conflicts");
      await this.client.query(
        `UPDATE clockgrove.effect_approvals SET state='revoked',revoked_by=$5 WHERE ${predicate}`,
        [...addressValues(address), humanPrincipalId],
      );
      return (await this.recorded(address))!;
    });
  }
  async consume(
    binding: EffectApprovalBinding,
  ): Promise<{ consumed: boolean; approval: RecordedEffectApproval | null }> {
    binding = { ...binding };
    requestValues(binding);
    return this.transaction(() => this.consumeInTransaction(binding));
  }
  /** The trusted caller owns the transaction and must commit dispatch atomically with consumption. */
  async consumeInTransaction(
    binding: EffectApprovalBinding,
  ): Promise<{ consumed: boolean; approval: RecordedEffectApproval | null }> {
    binding = { ...binding };
    requestValues(binding);
    const record = await this.locked(binding);
    if (
      !record ||
      !matches(record, binding) ||
      record.expiresAt !== binding.expiresAt ||
      record.state !== "approved"
    )
      return { consumed: false, approval: record };
    await this.client.query(
      `UPDATE clockgrove.effect_approvals SET state='consumed',consumed_by=$5 WHERE ${predicate}`,
      [...addressValues(binding), binding.principalId],
    );
    return { consumed: true, approval: await this.recorded(binding) };
  }
}
