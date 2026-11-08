import type {
  ActivationAddress,
  ActivationConfiguration,
  ActivationInspection,
  ActivationPolicy,
  ActivationWake,
  ActorActivation,
  TurnFiber,
} from "@clockgrove/application";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

type Row = Record<string, unknown>;
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
});

/** Canonical bounded actor activation receipts; the policy row serializes causal admission. */
export class PostgreSqlActivations {
  constructor(private readonly client: PostgreSqlClient) {}

  configure(
    a: ActivationAddress,
    config: ActivationConfiguration,
    policy: ActivationPolicy,
  ): Promise<ActivationInspection> {
    return this.transaction(a, async () => {
      validateConfiguration(config, policy);
      const session = await this.client.query(
        `SELECT actor_id FROM clockgrove.conversation_sessions
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND session_id=$5 AND actor_id=$4 AND space_id=$6 AND state='active'`,
        [...values(a), config.sessionId, a.scope.spaceId],
      );
      if (session.rows.length !== 1) throw new Error("activation conversation not found");
      await this.client.query(
        `INSERT INTO clockgrove.actor_activation_policies
        (tenant_id,world_id,timeline_id,actor_id,principal_id,space_id,event_cursor) VALUES ($1,$2,$3,$4,$5,$6,
        (SELECT coalesce(max(journal_position),0) FROM clockgrove.events WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3))
        ON CONFLICT DO NOTHING`,
        [...values(a), a.participant.principalId, a.scope.spaceId],
      );
      const row = await this.policy(a);
      if (row.space_id !== a.scope.spaceId) throw new Error("activation policy not found");
      const configs = (row.configurations as ActivationConfiguration[]).filter(
        (c) => c.id !== config.id,
      );
      configs.push(config);
      if (configs.length > 64) throw new Error("activation configuration limit reached");
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET configurations=$5::jsonb,
        allow_model=$6,model_budget=$7 WHERE ${KEY}`,
        [...values(a), JSON.stringify(configs), policy.allowModel, policy.modelBudget],
      );
      return this.inspectHere(a);
    });
  }

  inspect(a: ActivationAddress): Promise<ActivationInspection> {
    return this.transaction(a, () => this.inspectHere(a));
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
         reason,evidence,session_id,message_id,input,status,outcome,space_id,leader,has_reservation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
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
        ],
      );
      return activation(result.rows[0] as Row);
    });
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
      const configs = (row.configurations as ActivationConfiguration[]).map((c) =>
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

  /** Read each journal event once; configuration matches are evaluated without invoking a model. */
  events(
    a: ActivationAddress,
  ): Promise<readonly { eventId: string; eventType: string; causalRoot: string }[]> {
    return this.transaction(a, async () => {
      const policy = await this.policy(a);
      const result = await this.client.query(
        `SELECT event_id,event_type,coalesce(causation_id,event_id) AS causal_root,journal_position
        FROM clockgrove.events WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND journal_position>$4
        ORDER BY journal_position LIMIT 64`,
        [a.scope.tenantId, a.scope.worldId, a.scope.timelineId, policy.event_cursor],
      );
      return (result.rows as Row[]).map((r) => ({
        eventId: String(r.event_id),
        eventType: String(r.event_type),
        causalRoot: String(r.causal_root),
      }));
    });
  }

  acknowledgeEvent(a: ActivationAddress, eventId: string): Promise<void> {
    return this.transaction(a, async () => {
      await this.policy(a);
      await this.client.query(
        `UPDATE clockgrove.actor_activation_policies SET event_cursor=greatest(event_cursor,
        (SELECT journal_position FROM clockgrove.events WHERE tenant_id=$1 AND event_id=$5)) WHERE ${KEY}`,
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
      },
      modelCallsReserved: Number(row?.model_calls_reserved ?? 0),
      nextWakeAt: times.length ? Math.min(...times) : null,
    };
  }
  private transaction<T>(a: ActivationAddress, operation: () => Promise<T>): Promise<T> {
    return withClientTransaction(this.client, { authorization: a.participant }, operation);
  }
}

function validateConfiguration(c: ActivationConfiguration, p: ActivationPolicy): void {
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
    typeof p.allowModel !== "boolean" ||
    !Number.isSafeInteger(p.modelBudget) ||
    p.modelBudget < 0 ||
    p.modelBudget > 1000
  )
    throw new Error("invalid activation configuration");
}
