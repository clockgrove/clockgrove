import {
  type ActivationAddress,
  CAPABILITY_REGISTRY,
  CapabilityGrants,
  DeliveryRefusedError,
  type DeliveryTarget,
  evaluateDeliveryPolicy,
  type GovernedDeliveryPort,
  type RuntimeAuthorizationContext,
  validateDeliveryConsent,
} from "@clockgrove/application";
import type {
  DeliveryConsent,
  DeliveryReceipt,
  DeliveryRequested,
  DeliveryResult,
} from "@clockgrove/contracts";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;
const KEY = "tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND actor_id=$4 AND principal_id=$5";
const consentOf = (r: Row): DeliveryConsent => ({
  enabled: r.enabled === true,
  timezone: String(r.timezone),
  quietHours:
    r.quiet_start === null
      ? null
      : { startMinute: Number(r.quiet_start), endMinute: Number(r.quiet_end) },
  budgetLimit: Number(r.budget_limit),
  reservedUnits: Number(r.reserved_units),
  version: Number(r.version),
});
const key = (a: RuntimeAuthorizationContext, t: DeliveryTarget) => [
  a.tenantId,
  t.scope.worldId,
  t.scope.timelineId,
  t.actorId,
  a.principalId,
];
const id = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  new TextEncoder().encode(value).length > 0 &&
  new TextEncoder().encode(value).length <= 1024;
const exact = (value: object, names: readonly string[]) =>
  Object.keys(value).length === names.length && Object.keys(value).every((k) => names.includes(k));
function validateRequest(r: DeliveryRequested): void {
  if (
    r?.type !== "DeliveryRequested" ||
    r.version !== 1 ||
    !r.scope ||
    !r.channelBinding ||
    !r.reason ||
    !r.budgetReservation ||
    !exact(r, [
      "type",
      "version",
      "scope",
      "actorId",
      "sessionId",
      "recipientPrincipalId",
      "channelBinding",
      "reason",
      "urgency",
      "contentArtifactId",
      "privacyClass",
      "consentVersion",
      "policyVersion",
      "dedupeKey",
      "quietHoursBehavior",
      "budgetReservation",
    ]) ||
    !exact(r.scope, ["tenantId", "worldId", "timelineId", "spaceId"]) ||
    !exact(r.channelBinding, ["channel", "threadId"]) ||
    !exact(r.reason, ["kind", "id"]) ||
    !exact(r.budgetReservation, ["id", "units"]) ||
    ![
      r.scope.tenantId,
      r.scope.worldId,
      r.scope.timelineId,
      r.scope.spaceId,
      r.actorId,
      r.sessionId,
      r.recipientPrincipalId,
      r.channelBinding.threadId,
      r.reason.id,
      r.contentArtifactId,
      r.dedupeKey,
      r.budgetReservation.id,
    ].every(id) ||
    !["browser", "cli", "fake"].includes(r.channelBinding.channel) ||
    !["event", "goal", "promise", "subscription", "response"].includes(r.reason.kind) ||
    !["normal", "urgent"].includes(r.urgency) ||
    !["delay", "silent", "reject"].includes(r.quietHoursBehavior) ||
    r.privacyClass !== "conversation" ||
    !Number.isSafeInteger(r.consentVersion) ||
    r.consentVersion < 0 ||
    new TextEncoder().encode(JSON.stringify(r)).length > 16384 ||
    !Number.isSafeInteger(r.budgetReservation.units) ||
    r.budgetReservation.units <= 0
  )
    throw new DeliveryRefusedError("delivery_policy_invalid");
}

/** Durable fake/preview outboxes are the only sinks in Wave 5; no provider is invoked. */
export class PostgreSqlGovernedDelivery implements GovernedDeliveryPort {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private instant(): Date {
    const date = this.now();
    if (!Number.isFinite(date.getTime())) throw new DeliveryRefusedError("delivery_policy_invalid");
    return date;
  }
  private async target(
    a: RuntimeAuthorizationContext,
    t: DeliveryTarget,
    request?: DeliveryRequested,
  ): Promise<"fake" | "preview"> {
    if (t.scope.tenantId !== a.tenantId) throw new DeliveryRefusedError("delivery_target_invalid");
    const result = await this.client.query(
      `SELECT tl.kind FROM clockgrove.conversation_sessions s
      JOIN clockgrove.channel_bindings b USING (tenant_id,session_id)
      JOIN clockgrove.timelines tl ON tl.tenant_id=s.tenant_id AND tl.world_id=s.world_id AND tl.timeline_id=s.timeline_id
      WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.timeline_id=$3 AND s.space_id=$4
        AND s.actor_id=$5 AND s.session_id=$6 AND b.principal_id=$7 AND s.state<>'deleted'
        AND clockgrove.runtime_delivery_authorized(s.tenant_id,s.world_id,s.timeline_id,s.space_id,$7,s.actor_id)
        AND ($8::text IS NULL OR (b.channel=$8 AND b.thread_id=$9))
        AND ($10::text IS NULL OR EXISTS (SELECT 1 FROM clockgrove.artifact_references ar
          WHERE ar.tenant_id=s.tenant_id AND ar.world_id=s.world_id AND ar.timeline_id=s.timeline_id
            AND ar.space_id=s.space_id AND ar.artifact_id=$10 AND ar.privacy_class='conversation' AND ar.encryption='aes-256-gcm-v1'
            AND EXISTS (SELECT 1 FROM clockgrove.conversation_messages cm WHERE cm.tenant_id=s.tenant_id
              AND cm.session_id=s.session_id AND cm.role='actor' AND cm.author_id=s.actor_id AND cm.content_artifact_id=ar.artifact_id)))`,
      [
        a.tenantId,
        t.scope.worldId,
        t.scope.timelineId,
        t.scope.spaceId,
        t.actorId,
        t.sessionId,
        a.principalId,
        request?.channelBinding.channel ?? null,
        request?.channelBinding.threadId ?? null,
        request?.contentArtifactId ?? null,
      ],
    );
    if (result.rows.length !== 1) throw new DeliveryRefusedError("delivery_target_invalid");
    return (result.rows[0] as Row).kind === "live" ? "fake" : "preview";
  }
  configureConsent(
    a: RuntimeAuthorizationContext,
    t: DeliveryTarget,
    input: Omit<DeliveryConsent, "version" | "reservedUnits">,
  ): Promise<DeliveryConsent> {
    validateDeliveryConsent(input);
    return withClientTransaction(this.client, { authorization: a }, async () => {
      await this.target(a, t);
      const timezone = await this.client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=$1) AS valid",
        [input.timezone],
      );
      if (!(timezone.rows[0] as Row)?.valid)
        throw new DeliveryRefusedError("delivery_policy_invalid");
      const r = await this.client.query(
        `INSERT INTO clockgrove.delivery_consent
        (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,enabled,timezone,quiet_start,quiet_end,budget_limit,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
        ON CONFLICT (tenant_id,world_id,timeline_id,actor_id,principal_id) DO UPDATE
        SET enabled=EXCLUDED.enabled,timezone=EXCLUDED.timezone,quiet_start=EXCLUDED.quiet_start,
          quiet_end=EXCLUDED.quiet_end,budget_limit=EXCLUDED.budget_limit,version=delivery_consent.version+1
        RETURNING *`,
        [
          ...key(a, t),
          t.scope.spaceId,
          input.enabled,
          input.timezone,
          input.quietHours?.startMinute ?? null,
          input.quietHours?.endMinute ?? null,
          input.budgetLimit,
        ],
      );
      return consentOf(r.rows[0] as Row);
    });
  }
  request(a: RuntimeAuthorizationContext, r: DeliveryRequested): Promise<DeliveryResult> {
    validateRequest(r);
    if (r.recipientPrincipalId !== a.principalId)
      throw new DeliveryRefusedError("delivery_target_invalid");
    const t: DeliveryTarget = { scope: r.scope, actorId: r.actorId, sessionId: r.sessionId };
    return withClientTransaction(this.client, { authorization: a }, () =>
      this.requestHere(a, r, t),
    );
  }

  private async requestHere(
    a: RuntimeAuthorizationContext,
    r: DeliveryRequested,
    t: DeliveryTarget,
  ): Promise<DeliveryResult> {
    const sink = await this.target(a, t, r);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([...key(a, t), r.dedupeKey]),
    ]);
    const existing = await this.client.query(
      `SELECT receipt,request=$7::jsonb AS matches FROM clockgrove.deliveries WHERE ${KEY} AND dedupe_key=$6`,
      [...key(a, t), r.dedupeKey, JSON.stringify(r)],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0] as Row;
      if (!row.matches) throw new DeliveryRefusedError("delivery_key_reused");
      return { disposition: "deduplicated", receipt: row.receipt as DeliveryReceipt };
    }
    const c = await this.client.query(
      `SELECT * FROM clockgrove.delivery_consent WHERE ${KEY} FOR UPDATE`,
      key(a, t),
    );
    const consent = c.rows[0] ? consentOf(c.rows[0] as Row) : undefined;
    const collision = await this.client.query(
      `SELECT 1 FROM clockgrove.deliveries WHERE ${KEY} AND reservation_id=$6`,
      [...key(a, t), r.budgetReservation.id],
    );
    if (collision.rows.length) throw new DeliveryRefusedError("delivery_key_reused");
    const now = this.instant();
    const draft = {
      status: "reserved",
      reason: "allowed",
      effectiveUrgency: r.urgency,
      request: r,
      evaluatedAt: now.toISOString(),
      reservedUnits: 0,
      sink: null,
    };
    const inserted = await this.client.query(
      `INSERT INTO clockgrove.deliveries
        (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,session_id,dedupe_key,reservation_id,reserved_units,content_artifact_id,request,receipt,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11::jsonb,$12::jsonb,'reserved') RETURNING reserved_units`,
      [
        ...key(a, t),
        t.scope.spaceId,
        t.sessionId,
        r.dedupeKey,
        r.budgetReservation.id,
        r.contentArtifactId,
        JSON.stringify(r),
        JSON.stringify(draft),
      ],
    );
    const reserved = Number((inserted.rows[0] as Row).reserved_units);
    const decision =
      reserved === 0
        ? {
            status: "rejected" as const,
            reason: "budget_exhausted" as const,
            effectiveUrgency: r.urgency,
          }
        : evaluateDeliveryPolicy(r, consent, now);
    const receipt: DeliveryReceipt = {
      ...decision,
      request: r,
      evaluatedAt: now.toISOString(),
      reservedUnits: reserved,
      sink: decision.status === "approved" || decision.status === "downgraded" ? sink : null,
    };
    await this.client.query(
      `UPDATE clockgrove.deliveries SET receipt=$7::jsonb,status=$8 WHERE ${KEY} AND dedupe_key=$6`,
      [...key(a, t), r.dedupeKey, JSON.stringify(receipt), receipt.status],
    );
    await this.send(a, t, receipt);
    return { disposition: "recorded", receipt };
  }

  /** Runs inside the conversation commit transaction: receipt and reply commit together. */
  async requestResponseHere(
    a: RuntimeAuthorizationContext,
    target: DeliveryTarget,
    messageId: string,
    contentArtifactId: string,
  ): Promise<DeliveryResult | undefined> {
    const binding = await this.client.query(
      `SELECT b.channel,b.thread_id,
         'response:'||encode(sha256(convert_to(octet_length(b.session_id)::text||':'||b.session_id||$4,'UTF8')),'hex') AS response_key
       FROM clockgrove.channel_bindings b
       WHERE b.tenant_id=$1 AND b.session_id=$2 AND b.principal_id=$3
         AND NOT EXISTS (SELECT 1 FROM clockgrove.actor_activations aa
           WHERE aa.tenant_id=b.tenant_id AND aa.session_id=b.session_id AND aa.message_id=$4)`,
      [a.tenantId, target.sessionId, a.principalId, messageId],
    );
    const row = binding.rows[0] as Row | undefined;
    if (!row) return undefined;
    // Session and message IDs together identify one response allowance across all channels.
    const dedupeKey = String(row.response_key);
    const request: DeliveryRequested = {
      type: "DeliveryRequested",
      version: 1,
      ...target,
      recipientPrincipalId: a.principalId,
      channelBinding: {
        channel: row.channel as DeliveryRequested["channelBinding"]["channel"],
        threadId: String(row.thread_id),
      },
      reason: { kind: "response", id: messageId },
      urgency: "normal",
      contentArtifactId,
      privacyClass: "conversation",
      consentVersion: 0,
      policyVersion: "delivery-policy-v1",
      dedupeKey,
      quietHoursBehavior: "reject",
      budgetReservation: { id: dedupeKey, units: 1 },
    };
    validateRequest(request);
    return this.requestHere(a, request, target);
  }

  requestActivation(
    a: ActivationAddress,
    activationId: string,
  ): Promise<DeliveryResult | undefined> {
    return withClientTransaction(this.client, { authorization: a.participant }, async () => {
      const leader = await this.client.query(
        `SELECT * FROM clockgrove.actor_activations
         WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND actor_id=$4
           AND principal_id=$5 AND space_id=$6 AND activation_id=$7 AND leader=true FOR UPDATE`,
        [
          a.scope.tenantId,
          a.scope.worldId,
          a.scope.timelineId,
          a.actorId,
          a.participant.principalId,
          a.scope.spaceId,
          activationId,
        ],
      );
      const row = leader.rows[0] as Row | undefined;
      if (!row) throw new DeliveryRefusedError("delivery_target_invalid");
      if (row.delivery_intent == null) return undefined;
      const authority = await this.client.query(
        `SELECT clockgrove.lock_activation_delivery_authority($1,$2,$3,$4,$5) AS allowed`,
        [
          a.scope.tenantId,
          a.scope.worldId,
          a.scope.timelineId,
          a.scope.spaceId,
          a.participant.principalId,
        ],
      );
      if (!(authority.rows[0] as Row)?.allowed)
        throw new DeliveryRefusedError("delivery_target_invalid");
      const target: DeliveryTarget = {
        scope: a.scope,
        actorId: a.actorId,
        sessionId: String(row.session_id),
      };
      const dedupeKey = `activation:${activationId}`;
      const previous = await this.client.query(
        `SELECT receipt FROM clockgrove.deliveries WHERE ${KEY} AND dedupe_key=$6`,
        [...key(a.participant, target), dedupeKey],
      );
      const historical = (previous.rows[0] as Row | undefined)?.receipt as
        | DeliveryReceipt
        | undefined;
      if (!historical && row.status !== "pending") return undefined;
      const grants = new CapabilityGrants(
        CAPABILITY_REGISTRY,
        [{ capability: "delivery.request", callsPerTurn: 1 }],
        new Set(),
      );
      const decision = grants.authorize({
        capability: "delivery.request",
        input: row.delivery_intent,
      });
      if (!decision.accepted) throw new DeliveryRefusedError("delivery_policy_invalid");
      const source = await this.client.query(
        `SELECT cm.content_artifact_id,b.channel,b.thread_id,c.version
         FROM clockgrove.conversation_messages cm
         JOIN clockgrove.channel_bindings b USING(tenant_id,session_id)
         LEFT JOIN clockgrove.delivery_consent c ON c.tenant_id=b.tenant_id AND c.world_id=b.world_id
           AND c.timeline_id=b.timeline_id AND c.actor_id=$4 AND c.principal_id=b.principal_id
         WHERE cm.tenant_id=$1 AND cm.session_id=$2 AND cm.message_id=$3 AND cm.role='actor'
           AND cm.author_id=$4 AND b.principal_id=$5`,
        [
          a.scope.tenantId,
          target.sessionId,
          `${row.message_id}:reply`,
          a.actorId,
          a.participant.principalId,
        ],
      );
      const content = source.rows[0] as Row | undefined;
      if (!content || source.rows.length !== 1)
        throw new DeliveryRefusedError("delivery_target_invalid");
      const intent = decision.input as {
        urgency: "normal" | "urgent";
        quietHoursBehavior: "delay" | "silent" | "reject";
      };
      const request: DeliveryRequested = {
        type: "DeliveryRequested",
        version: 1,
        ...target,
        recipientPrincipalId: a.participant.principalId,
        channelBinding: {
          channel: content.channel as DeliveryRequested["channelBinding"]["channel"],
          threadId: String(content.thread_id),
        },
        reason: { kind: "event", id: activationId },
        ...intent,
        contentArtifactId: String(content.content_artifact_id),
        privacyClass: "conversation",
        consentVersion: historical?.request.consentVersion ?? Number(content.version ?? 0),
        policyVersion: "delivery-policy-v1",
        dedupeKey,
        budgetReservation: { id: dedupeKey, units: 1 },
      };
      validateRequest(request);
      return this.requestHere(a.participant, request, target);
    });
  }

  private async send(
    a: RuntimeAuthorizationContext,
    t: DeliveryTarget,
    r: DeliveryReceipt,
  ): Promise<void> {
    if (r.sink === null) return;
    await this.client.query(
      `INSERT INTO clockgrove.delivery_sink_receipts
      (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,dedupe_key,sink,content_artifact_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...key(a, t), t.scope.spaceId, r.request.dedupeKey, r.sink, r.request.contentArtifactId],
    );
  }
  resume(
    a: RuntimeAuthorizationContext,
    t: DeliveryTarget,
    dedupeKey: string,
  ): Promise<DeliveryReceipt> {
    return withClientTransaction(this.client, { authorization: a }, async () => {
      const sink = await this.target(a, t);
      const pending = await this.client.query(
        `SELECT receipt FROM clockgrove.deliveries WHERE ${KEY} AND dedupe_key=$6`,
        [...key(a, t), dedupeKey],
      );
      const candidate = (pending.rows[0] as Row | undefined)?.receipt as
        | DeliveryReceipt
        | undefined;
      if (
        candidate?.status === "delayed" &&
        candidate.request.reason.kind === "event" &&
        candidate.request.dedupeKey === `activation:${candidate.request.reason.id}`
      ) {
        // Hold the same membership lock as the producer until dispatch commits.
        const authority = await this.client.query(
          `SELECT clockgrove.lock_activation_delivery_authority($1,$2,$3,$4,$5) AS allowed`,
          [
            candidate.request.scope.tenantId,
            candidate.request.scope.worldId,
            candidate.request.scope.timelineId,
            candidate.request.scope.spaceId,
            a.principalId,
          ],
        );
        if (!(authority.rows[0] as Row)?.allowed)
          throw new DeliveryRefusedError("delivery_target_invalid");
      }
      // Producer and resumer lock membership before the receipt, then the lifetime budget row.
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([...key(a, t), dedupeKey]),
      ]);
      const rows = await this.client.query(
        `SELECT receipt FROM clockgrove.deliveries WHERE ${KEY} AND dedupe_key=$6 FOR UPDATE`,
        [...key(a, t), dedupeKey],
      );
      const old = (rows.rows[0] as Row | undefined)?.receipt as DeliveryReceipt | undefined;
      if (
        !old ||
        old.request.sessionId !== t.sessionId ||
        old.request.scope.spaceId !== t.scope.spaceId
      )
        throw new DeliveryRefusedError("delivery_not_found");
      if (old.status !== "delayed") return old;
      await this.target(a, t, old.request);
      const c = await this.client.query(
        `SELECT * FROM clockgrove.delivery_consent WHERE ${KEY} FOR UPDATE`,
        key(a, t),
      );
      const now = this.instant();
      const decision = evaluateDeliveryPolicy(
        old.request,
        c.rows[0] ? consentOf(c.rows[0] as Row) : undefined,
        now,
      );
      if (decision.status === "delayed") return old;
      const receipt: DeliveryReceipt = {
        ...old,
        ...decision,
        evaluatedAt: now.toISOString(),
        sink: decision.status === "approved" || decision.status === "downgraded" ? sink : null,
      };
      await this.client.query(
        `UPDATE clockgrove.deliveries SET receipt=$7::jsonb,status=$8 WHERE ${KEY} AND dedupe_key=$6`,
        [...key(a, t), dedupeKey, JSON.stringify(receipt), receipt.status],
      );
      await this.send(a, t, receipt);
      return receipt;
    });
  }
  /** Only currently authorized targets keep this principal's actor alarm alive. */
  pending(address: ActivationAddress): Promise<boolean> {
    return withClientTransaction(this.client, { authorization: address.participant }, async () => {
      const rows = await this.pendingRows(address, null, 1);
      return rows.length > 0;
    });
  }

  private async pendingRows(address: ActivationAddress, after: string | null, limit: number) {
    if (address.scope.tenantId !== address.participant.tenantId)
      throw new DeliveryRefusedError("delivery_target_invalid");
    const rows = await this.client.query(
      `SELECT d.receipt FROM clockgrove.deliveries d
       JOIN clockgrove.conversation_sessions s USING (tenant_id,session_id)
       WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.timeline_id=$3
         AND d.actor_id=$4 AND d.principal_id=$5 AND d.status='delayed' AND s.state<>'deleted'
         AND clockgrove.runtime_delivery_authorized(d.tenant_id,d.world_id,d.timeline_id,d.space_id,d.principal_id,d.actor_id)
         AND ($6::text IS NULL OR d.dedupe_key>$6)
       ORDER BY d.dedupe_key LIMIT $7`,
      [
        address.scope.tenantId,
        address.scope.worldId,
        address.scope.timelineId,
        address.actorId,
        address.participant.principalId,
        after,
        limit,
      ],
    );
    return rows.rows.map((row) => (row as Row).receipt as DeliveryReceipt);
  }

  /** The cursor is only a fairness hint; loss restarts from canonical pending receipts. */
  async resumePending(address: ActivationAddress, after: string | null): Promise<string | null> {
    // Decision: sixteen sequential resumes bound each callback's database work; later callbacks
    // rotate past quiet requests so one recipient's earlier requests cannot starve later ones.
    const limit = 16;
    const receipts = await withClientTransaction(
      this.client,
      { authorization: address.participant },
      () => this.pendingRows(address, after, limit),
    );
    for (const receipt of receipts) {
      try {
        await this.resume(
          address.participant,
          {
            scope: receipt.request.scope,
            actorId: address.actorId,
            sessionId: receipt.request.sessionId,
          },
          receipt.request.dedupeKey,
        );
      } catch (error) {
        // Revocation/deletion between the scan and resume must not strand other targets.
        if (!(error instanceof DeliveryRefusedError) || error.code !== "delivery_target_invalid")
          throw error;
      }
    }
    return receipts.length === limit ? receipts[receipts.length - 1]!.request.dedupeKey : null;
  }

  replay(
    a: RuntimeAuthorizationContext,
    t: DeliveryTarget,
    dedupeKey: string,
  ): Promise<DeliveryReceipt | undefined> {
    return withClientTransaction(this.client, { authorization: a }, async () => {
      await this.target(a, t);
      const r = await this.client.query(
        `SELECT receipt FROM clockgrove.deliveries WHERE ${KEY} AND dedupe_key=$6 AND session_id=$7 AND space_id=$8`,
        [...key(a, t), dedupeKey, t.sessionId, t.scope.spaceId],
      );
      return (r.rows[0] as Row | undefined)?.receipt as DeliveryReceipt | undefined;
    });
  }
}
