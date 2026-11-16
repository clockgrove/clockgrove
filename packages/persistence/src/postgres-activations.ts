import type {
  ActivationAddress,
  ActivationConfiguration,
  ActivationInspection,
  ActivationPolicy,
  ActivationWake,
  ActorActivation,
  RuntimeAuthorizationContext,
  TurnFiber,
} from "@clockgrove/application";
import {
  CAPABILITY_REGISTRY,
  MAX_ACTOR_ACTIVATIONS,
  MAX_REVOKED_CAPABILITIES,
} from "@clockgrove/application";
import { PostgreSqlGovernedDelivery } from "./postgres-deliveries.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;
/** Journal events one activation check reads. */
const ACTIVATION_EVENT_PAGE = 64;

/** One activation check's journal read. */
export interface ActivationEventPage {
  readonly events: readonly {
    eventId: string;
    eventType: string;
    causalRoot: string;
    /** The event's subject (`payload.objectId`) is this actor, journaled in its policy's space. */
    own: boolean;
    /** The event's `payload.need` (a `needs.threshold-crossed` event's need), else null. */
    need: string | null;
  }[];
  /** More events may be waiting: the page is full, or a visible event's transaction is unsettled. */
  readonly more: boolean;
}
const KEY = "tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND actor_id=$4";
const values = (a: ActivationAddress) => [
  a.scope.tenantId,
  a.scope.worldId,
  a.scope.timelineId,
  a.actorId,
];
const activation = (r: Row): ActorActivation => ({
  activationId: String(r.activation_id),
  causalRoot: String(r.causal_root),
  configurationId: String(r.configuration_id),
  reason: r.reason as ActorActivation["reason"],
  evidence: String(r.evidence),
  sessionId: String(r.session_id),
  messageId: String(r.message_id),
  input: String(r.input),
  status: r.status as ActorActivation["status"],
  outcome: String(r.outcome),
  principalId: String(r.principal_id),
  ...(r.delivery_intent == null
    ? {}
    : { delivery: r.delivery_intent as NonNullable<ActorActivation["delivery"]> }),
});

/** Canonical bounded actor activation receipts; the policy row serializes causal admission. */
export class PostgreSqlActivations {
  constructor(private readonly client: PostgreSqlClient) {}

  /**
   * Writes one configuration and the actor's policy. Without a configuration (issue 323) only the
   * policy changes: an operator revokes a capability without adding a configuration.
   */
  configure(
    a: ActivationAddress,
    config: ActivationConfiguration | undefined,
    policy: ActivationPolicy,
  ): Promise<ActivationInspection> {
    return this.transaction(a, async () => {
      validatePolicy(policy);
      if (config !== undefined) {
        validateConfiguration(config);
        const session = await this.client.query(
          `SELECT actor_id FROM clockgrove.conversation_sessions
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND session_id=$5 AND actor_id=$4 AND space_id=$6 AND state='active'`,
          [...values(a), config.sessionId, a.scope.spaceId],
        );
        if (session.rows.length !== 1) throw new Error("activation conversation not found");
      }
      // The cursor starts after every transaction this snapshot can know of: an event committed
      // before the policy existed is not read, and an append that has not started yet is.
      await this.client.query(
        `INSERT INTO clockgrove.actor_activation_policies
        (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,event_cursor_transaction)
        VALUES ($1,$2,$3,$4,$5,$6,pg_snapshot_xmax(pg_current_snapshot()))
        ON CONFLICT DO NOTHING`,
        [...values(a), a.participant.principalId, a.scope.spaceId],
      );
      const row = await this.policy(a);
      if (row.space_id !== a.scope.spaceId) throw new Error("activation policy not found");
      const configs = row.configurations as ActivationConfiguration[];
      if (config !== undefined) {
        const prior = configs.find((c) => c.id === config.id);
        configs.splice(0, configs.length, ...configs.filter((c) => c.id !== config.id));
        // An operator sees and may disable an actor's own configuration; it stays the actor's.
        configs.push(prior?.origin === undefined ? config : { ...config, origin: prior.origin });
        if (configs.length > 64) throw new Error("activation configuration limit reached");
      }
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb,
        allow_model=$6,model_budget=$7,revoked_capabilities=coalesce($8::text[],revoked_capabilities)
        WHERE ${KEY}`,
        [
          ...values(a),
          JSON.stringify(configs),
          policy.allowModel,
          policy.modelBudget,
          policy.revokedCapabilities === undefined ? null : [...policy.revokedCapabilities],
        ],
      );
      return this.inspectHere(a);
    });
  }

  /**
   * Writes one of the actor's own configurations (issue 322) under the turn's participant: the
   * policy's budget and model permission are the operator's and stay unchanged. A new one beyond
   * `MAX_ACTOR_ACTIVATIONS` standing actor configurations answers `limit`; a participant who does
   * not own the actor's policy answers `not_owned`.
   */
  actorConfigure(
    a: ActivationAddress,
    config: ActivationConfiguration & { readonly origin: "actor" },
  ): Promise<"configured" | "limit" | "not_owned"> {
    return this.transaction(a, async () => {
      validateConfiguration(config);
      const session = await this.client.query(
        `SELECT actor_id FROM clockgrove.conversation_sessions
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND session_id=$5 AND actor_id=$4 AND space_id=$6 AND state='active'`,
        [...values(a), config.sessionId, a.scope.spaceId],
      );
      if (session.rows.length !== 1) throw new Error("activation conversation not found");
      await this.client.query(
        `INSERT INTO clockgrove.actor_activation_policies
        (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,event_cursor_transaction)
        VALUES ($1,$2,$3,$4,$5,$6,pg_snapshot_xmax(pg_current_snapshot()))
        ON CONFLICT DO NOTHING`,
        [...values(a), a.participant.principalId, a.scope.spaceId],
      );
      // Another member's policy for this actor stays invisible here: it is not this one's to change.
      const visible = await this.client.query(
        `SELECT 1 FROM clockgrove.actor_activation_policies WHERE ${KEY}`,
        values(a),
      );
      if (visible.rows.length === 0) return "not_owned";
      const row = await this.policy(a);
      if (row.space_id !== a.scope.spaceId) return "not_owned";
      const configs = (row.configurations as ActivationConfiguration[]).filter(
        (c) => c.id !== config.id,
      );
      const replacing = configs.length !== (row.configurations as unknown[]).length;
      if (!replacing && configs.filter((c) => c.origin === "actor").length >= MAX_ACTOR_ACTIVATIONS)
        return "limit";
      configs.push(config);
      if (configs.length > 64) return "limit";
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb WHERE ${KEY}`,
        [...values(a), JSON.stringify(configs)],
      );
      return "configured";
    });
  }

  /**
   * Removes one of the actor's own configurations of `kind`. `absent` when the policy holds no
   * configuration `id` at all, `not_found` when it holds one that is not the actor's own of `kind`,
   * and `not_owned` when another member owns the actor's policy.
   */
  actorRemove(
    a: ActivationAddress,
    id: string,
    kind: "subscription" | "scheduled_intention",
  ): Promise<"removed" | "absent" | "not_found" | "not_owned"> {
    return this.transaction(a, async () => {
      const policy = await this.capabilityPolicy(a);
      if (policy === undefined) return "absent";
      if (!policy.owned) return "not_owned";
      const row = await this.policy(a);
      const stored = row.configurations as ActivationConfiguration[];
      if (!stored.some((c) => c.id === id)) return "absent";
      const configs = stored.filter(
        (c) => !(c.id === id && c.kind === kind && c.origin === "actor"),
      );
      if (configs.length === stored.length) return "not_found";
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb WHERE ${KEY}`,
        [...values(a), JSON.stringify(configs)],
      );
      return "removed";
    });
  }

  /**
   * The capabilities revoked for this actor, for every live member of its policy's space, whoever
   * owns the policy (migration 0067); none without a policy.
   */
  revokedCapabilities(a: ActivationAddress): Promise<readonly string[]> {
    return this.transaction(a, async () => (await this.capabilityPolicy(a))?.revoked ?? []);
  }

  /**
   * The actor's policy as any live member sees it: whether the caller owns it, and its revocations;
   * undefined without a policy.
   */
  capabilityPolicyOf(
    a: ActivationAddress,
  ): Promise<{ readonly owned: boolean; readonly revoked: readonly string[] } | undefined> {
    return this.transaction(a, () => this.capabilityPolicy(a));
  }

  private async capabilityPolicy(
    a: ActivationAddress,
  ): Promise<{ readonly owned: boolean; readonly revoked: readonly string[] } | undefined> {
    const result = await this.client.query(
      "SELECT owned, revoked_capabilities FROM clockgrove.actor_capability_policy($1,$2,$3,$4)",
      values(a),
    );
    const row = result.rows[0] as Row | undefined;
    return row === undefined
      ? undefined
      : { owned: row.owned === true, revoked: (row.revoked_capabilities as string[]).map(String) };
  }

  inspect(a: ActivationAddress): Promise<ActivationInspection> {
    return this.transaction(a, () => this.inspectHere(a));
  }

  /** The actor's configurations alone, the policy row's one column (empty with no policy). */
  configurations(a: ActivationAddress): Promise<readonly ActivationConfiguration[]> {
    return this.transaction(a, async () => {
      const result = await this.client.query(
        `SELECT configurations FROM clockgrove.actor_activation_policies WHERE ${KEY}`,
        values(a),
      );
      const row = result.rows[0] as Row | undefined;
      return (row?.configurations ?? []) as ActivationConfiguration[];
    });
  }

  admit(a: ActivationAddress, wake: ActivationWake): Promise<ActorActivation> {
    return this.transaction(a, async () => {
      if (
        !wake.causalRoot ||
        new TextEncoder().encode(wake.causalRoot).length > 1024 ||
        typeof wake.evidence !== "string" ||
        new TextEncoder().encode(wake.evidence).length > 8192
      )
        throw new Error("invalid activation evidence");
      const row = await this.policy(a);
      const previous = await this.client.query(
        `SELECT * FROM clockgrove.actor_activations WHERE ${KEY} AND causal_root=$5`,
        [...values(a), wake.causalRoot],
      );
      const prior = previous.rows[0] ? activation(previous.rows[0] as Row) : undefined;
      if (prior && prior.status !== "deferred") return prior;
      if (!prior && Number(row.receipt_count) >= 1000)
        throw new Error("activation receipt limit reached");
      const configs = row.configurations as ActivationConfiguration[];
      const config = configs.find((c) => c.id === wake.configurationId);
      if (!config) throw new Error("activation configuration not found");
      if (wake.reason.kind !== config.kind && wake.reason.kind !== "perception")
        throw new Error("activation reason mismatch");
      const pending = await this.client.query(
        `SELECT * FROM clockgrove.actor_activations WHERE ${KEY} AND status='pending' ORDER BY activation_id LIMIT 1`,
        values(a),
      );
      let status: ActorActivation["status"] = "pending";
      let outcome = "admitted";
      if (!config.enabled || !row.allow_model) {
        status = "deferred";
        outcome = "policy_denied";
      } else if (config.compiledRoutine === "noop") {
        status = "noop";
        outcome = "compiled_noop";
      } else if (Number(row.model_calls_reserved) >= Number(row.model_budget) && !pending.rows[0]) {
        status = "deferred";
        outcome = "budget_exhausted";
      }
      const joined =
        status === "pending" && pending.rows[0] ? activation(pending.rows[0] as Row) : undefined;
      if (prior && joined) return prior;
      const id = prior?.activationId ?? joined?.activationId ?? crypto.randomUUID();
      const sessionId = prior?.sessionId ?? joined?.sessionId ?? config.sessionId;
      const messageId = prior?.messageId ?? joined?.messageId ?? `activation:${id}`;
      const input = prior?.input ?? joined?.input ?? config.input;
      if (status === "pending" && !joined && !prior)
        await this.client.query(
          `UPDATE clockgrove.actor_activation_policies SET model_calls_reserved=model_calls_reserved+1 WHERE ${KEY}`,
          values(a),
        );
      if (status === "noop") {
        const updated = configs.map((c) =>
          c.id === config.id ? { ...c, enabled: false, nextWakeAt: null } : c,
        );
        await this.client.query(
          `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb WHERE ${KEY}`,
          [...values(a), JSON.stringify(updated)],
        );
      }
      if (prior) {
        await this.client.query(
          `UPDATE clockgrove.actor_activations SET status=$6,outcome=$7
          WHERE ${KEY} AND causal_root=$5`,
          [...values(a), wake.causalRoot, status, outcome],
        );
        return { ...prior, status, outcome };
      }
      const result = await this.client.query(
        `INSERT INTO clockgrove.actor_activations
        (tenant_id,world_id,timeline_id,actor_id,causal_root,activation_id,principal_id,configuration_id,
         reason,evidence,session_id,message_id,input,status,outcome,space_id,leader,has_reservation,delivery_intent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) RETURNING *`,
        [
          ...values(a),
          wake.causalRoot,
          id,
          a.participant.principalId,
          config.id,
          JSON.stringify(wake.reason),
          wake.evidence,
          sessionId,
          messageId,
          input,
          status,
          outcome,
          a.scope.spaceId,
          joined === undefined,
          status === "pending",
          (joined ? joined.delivery : config.delivery) === undefined
            ? null
            : JSON.stringify(joined ? joined.delivery : config.delivery),
        ],
      );
      return activation(result.rows[0] as Row);
    });
  }

  deliver(a: ActivationAddress, activationId: string) {
    return new PostgreSqlGovernedDelivery(this.client).requestActivation(a, activationId);
  }

  beforeModel(a: ActivationAddress, fiber: TurnFiber): Promise<string | undefined> {
    return this.transaction(a, async () => {
      const result = await this.client.query(
        `SELECT clockgrove.activation_model_gate($1,$2,$3,$4,$5,$6,$7,$8) AS status`,
        [
          ...values(a),
          a.participant.principalId,
          fiber.sessionId,
          fiber.messageId,
          fiber.leaseEpoch,
        ],
      );
      const status = (result.rows[0] as Row).status;
      return status === null ? undefined : String(status);
    });
  }

  settle(a: ActivationAddress, id: string, outcome: string): Promise<void> {
    return this.transaction(a, async () => {
      await this.policy(a);
      const settled = await this.client.query(
        `UPDATE clockgrove.actor_activations SET status='completed',outcome=$6
        WHERE ${KEY} AND activation_id=$5 AND status='pending' RETURNING configuration_id`,
        [...values(a), id, outcome],
      );
      if (settled.rows.length === 0) return;
      const row = await this.policy(a);
      const records = await this.client.query(
        `SELECT configuration_id FROM clockgrove.actor_activations
        WHERE ${KEY} AND activation_id=$5`,
        [...values(a), id],
      );
      const ids = new Set((records.rows as Row[]).map((r) => String(r.configuration_id)));
      // An actor's own one-shot intention retires once it has fired (issue 322): its receipt stays
      // and a replayed wake answers from it, but it no longer holds a standing place.
      const retired = (c: ActivationConfiguration) =>
        ids.has(c.id) &&
        c.origin === "actor" &&
        c.kind === "scheduled_intention" &&
        c.intervalMs === null &&
        c.nextWakeAt !== null;
      const configs = (row.configurations as ActivationConfiguration[])
        .filter((c) => !retired(c))
        .map((c) =>
          ids.has(c.id) && c.nextWakeAt !== null
            ? {
                ...c,
                nextWakeAt:
                  c.intervalMs === null
                    ? null
                    : c.nextWakeAt +
                      Math.max(1, Math.floor((Date.now() - c.nextWakeAt) / c.intervalMs) + 1) *
                        c.intervalMs,
              }
            : c,
        );
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb WHERE ${KEY}`,
        [...values(a), JSON.stringify(configs)],
      );
    });
  }

  /**
   * Read each journal event once, in (transaction, position) order after the cursor; configuration
   * matches are evaluated without invoking a model. Partitions commit in parallel, so a lower
   * position can become visible after a higher one (migration 0043). Only events whose appending
   * transaction is older than this snapshot's xmin are read: those transactions have all ended, so
   * the cursor never passes an event that can still appear. A visible later event waits for the
   * next check, and `more` asks for that check promptly.
   */
  events(a: ActivationAddress): Promise<ActivationEventPage> {
    return this.transaction(a, async () => {
      const policy = await this.policy(a);
      const result = await this.client.query(
        `SELECT event_id,event_type,coalesce(causation_id,event_id) AS causal_root,
          coalesce(space_id = $8 AND subject.object_id = $7, false) AS own,
          subject.need,
          transaction_id < settled.horizon AS settled
        FROM clockgrove.events
        CROSS JOIN (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon) settled
        CROSS JOIN LATERAL (
          SELECT coalesce(payload->>'objectId', kernel.object_id) AS object_id,
            coalesce(payload->>'need', kernel.need) AS need
          FROM (
            -- A kernel event is journaled as {kernelEvent: canonical record}: its subject and need
            -- are the objectId and need fields of the record's payload field.
            SELECT max(field->1->>1) FILTER (WHERE field->>0 = 'objectId') AS object_id,
              max(field->1->>1) FILTER (WHERE field->>0 = 'need') AS need
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload #> '{kernelEvent,1}') = 'array'
                THEN payload #> '{kernelEvent,1}' ELSE '[]'::jsonb END) AS part,
              jsonb_array_elements(CASE WHEN part->>0 = 'payload'
                AND jsonb_typeof(part #> '{1,1}') = 'array' THEN part #> '{1,1}' ELSE '[]'::jsonb END)
                AS field
          ) kernel
        ) subject
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3
          AND (transaction_id,journal_position) > ($4::xid8,$5::bigint)
        ORDER BY transaction_id,journal_position LIMIT $6`,
        [
          a.scope.tenantId,
          a.scope.worldId,
          a.scope.timelineId,
          policy.event_cursor_transaction,
          policy.event_cursor,
          ACTIVATION_EVENT_PAGE + 1,
          a.actorId,
          policy.space_id,
        ],
      );
      // Settled rows sort before every unsettled one: their transactions are older.
      const rows = result.rows as Row[];
      const settled = rows.filter((r) => r.settled === true).slice(0, ACTIVATION_EVENT_PAGE);
      return {
        events: settled.map((r) => ({
          eventId: String(r.event_id),
          eventType: String(r.event_type),
          causalRoot: String(r.causal_root),
          own: r.own === true,
          need: typeof r.need === "string" ? r.need : null,
        })),
        more: rows.length > settled.length,
      };
    });
  }

  /** Moves the cursor to `eventId`, never back. */
  acknowledgeEvent(a: ActivationAddress, eventId: string): Promise<void> {
    return this.transaction(a, async () => {
      await this.policy(a);
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies AS p
        SET event_cursor_transaction=e.transaction_id,event_cursor=e.journal_position
        FROM clockgrove.events AS e
        WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.timeline_id=$3 AND p.actor_id=$4
          AND e.tenant_id=$1 AND e.world_id=$2 AND e.timeline_id=$3 AND e.event_id=$5
          AND (e.transaction_id,e.journal_position) > (p.event_cursor_transaction,p.event_cursor)`,
        [...values(a), eventId],
      );
    });
  }

  private async policy(a: ActivationAddress): Promise<Row> {
    const result = await this.client.query(
      `SELECT * FROM clockgrove.actor_activation_policies WHERE ${KEY} FOR UPDATE`,
      values(a),
    );
    if (!result.rows[0]) throw new Error("activation policy not found");
    return result.rows[0] as Row;
  }
  private async inspectHere(a: ActivationAddress): Promise<ActivationInspection> {
    const result = await this.client.query(
      `SELECT * FROM clockgrove.actor_activation_policies WHERE ${KEY}`,
      values(a),
    );
    const row = result.rows[0] as Row | undefined;
    const configs = (row?.configurations ?? []) as ActivationConfiguration[];
    const records = await this.client.query(
      `SELECT * FROM clockgrove.actor_activations WHERE ${KEY} ORDER BY activation_id,causal_root`,
      values(a),
    );
    const times = configs
      .filter((c) => c.enabled && c.nextWakeAt !== null)
      .map((c) => c.nextWakeAt as number);
    return {
      configurations: configs,
      activations: (records.rows as Row[]).map(activation),
      policy: {
        allowModel: row?.allow_model === true,
        modelBudget: Number(row?.model_budget ?? 0),
        revokedCapabilities: ((row?.revoked_capabilities ?? []) as string[]).map(String),
      },
      modelCallsReserved: Number(row?.model_calls_reserved ?? 0),
      nextWakeAt: times.length ? Math.min(...times) : null,
    };
  }
  private transaction<T>(a: ActivationAddress, operation: () => Promise<T>): Promise<T> {
    return withClientTransaction(this.client, { authorization: a.participant }, operation);
  }
}

/**
 * The actors of one world timeline whose enabled subscription or threshold names one of
 * `eventTypes`, for the committing world's system principal (`authorization`). Answers each
 * actor's route only: its ID and the space of its policy.
 */
export function activationEventSubscribers(
  client: PostgreSqlClient,
  authorization: RuntimeAuthorizationContext,
  scope: { readonly worldId: string; readonly timelineId: string },
  eventTypes: readonly string[],
): Promise<readonly { readonly actorId: string; readonly spaceId: string }[]> {
  return withClientTransaction(client, { authorization }, async () => {
    const result = await client.query(
      "SELECT actor_id, space_id FROM clockgrove.activation_event_subscribers($1,$2,$3,$4::text[])",
      [authorization.tenantId, scope.worldId, scope.timelineId, eventTypes],
    );
    return (result.rows as Row[]).map((r) => ({
      actorId: String(r.actor_id),
      spaceId: String(r.space_id),
    }));
  });
}

function validateConfiguration(c: ActivationConfiguration): void {
  if (c.delivery !== undefined) {
    try {
      CAPABILITY_REGISTRY.get("delivery.request")!.parse(c.delivery);
    } catch {
      throw new Error("invalid activation configuration");
    }
  }
  const kinds = [
    "scheduled_intention",
    "subscription",
    "perception",
    "threshold",
    "heartbeat",
    "tool_completed",
    "operator",
  ];
  if (
    !c.id ||
    c.id.length > 128 ||
    !c.sessionId ||
    !kinds.includes(c.kind) ||
    typeof c.input !== "string" ||
    new TextEncoder().encode(c.input).length > 1024 ||
    (c.compiledRoutine === "escalate" && c.input.trim() === "") ||
    !Number.isSafeInteger(c.priority) ||
    c.priority < 0 ||
    c.priority > 100 ||
    typeof c.enabled !== "boolean" ||
    !["noop", "escalate"].includes(c.compiledRoutine) ||
    (c.nextWakeAt !== null && (!Number.isSafeInteger(c.nextWakeAt) || c.nextWakeAt < 0)) ||
    (c.intervalMs !== null && (!Number.isSafeInteger(c.intervalMs) || c.intervalMs < 60000)) ||
    (c.eventType !== undefined && (typeof c.eventType !== "string" || c.eventType.length > 256)) ||
    (c.need !== undefined &&
      (c.kind !== "threshold" || (c.need !== "hunger" && c.need !== "thirst"))) ||
    (c.condition !== undefined &&
      (typeof c.condition !== "string" || new TextEncoder().encode(c.condition).length > 1024))
  )
    throw new Error("invalid activation configuration");
}

function validatePolicy(p: ActivationPolicy): void {
  if (
    typeof p.allowModel !== "boolean" ||
    !Number.isSafeInteger(p.modelBudget) ||
    p.modelBudget < 0 ||
    p.modelBudget > 1000 ||
    (p.revokedCapabilities !== undefined &&
      (p.revokedCapabilities.length > MAX_REVOKED_CAPABILITIES ||
        p.revokedCapabilities.some(
          (name) => typeof name !== "string" || name.length === 0 || name.length > 4096,
        )))
  )
    throw new Error("invalid activation configuration");
}
