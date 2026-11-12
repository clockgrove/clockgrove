import {
  type CapabilityValue,
  MCP_HTTP_LIMITS,
  MCP_READ_LIMITS,
  type McpCapabilityBinding,
  type McpRegistryInstallation,
  mcpReadArgumentsHash,
  resolveMcpCapabilityRegistry,
} from "@clockgrove/application";
import {
  approvedEffectHash,
  approvedEffectIdempotencyKey,
  PostgreSqlApprovedEffects,
} from "./postgres-approved-effects.js";
import { type EffectApprovalBinding } from "./postgres-effect-approvals.js";
import {
  type EffectIntentMetadata,
  PostgreSqlEffects,
  type RecordedEffect,
} from "./postgres-effects.js";
import { type PostgreSqlClient, withClientTransaction } from "./postgres-transaction.js";

export interface McpReadTurnPolicy {
  readonly maxCalls: number;
  readonly maxModelSteps: number;
  readonly maxCostMicrousd: number;
  readonly maxTimeMs: number;
  readonly maxOutputBytes: number;
}
// Owner decisions, issue 165 (2026-11-09). Time reserves initialize, notify and tools/call;
// each HTTP request has one deadline across redirects. Output reserves the full adapter cap.
export const MCP_READ_TURN_DEFAULTS: McpReadTurnPolicy = {
  maxCalls: 3,
  maxModelSteps: 4,
  maxCostMicrousd: 250_000,
  maxTimeMs: 3 * 3 * MCP_HTTP_LIMITS.timeoutMs,
  maxOutputBytes: 3 * MCP_READ_LIMITS.outputBytes,
};
const callTimeMs = 3 * MCP_HTTP_LIMITS.timeoutMs;
export interface McpReadReservation {
  readonly intent: EffectIntentMetadata;
  /** Canonical inbound message ID, including activation-created turns. */
  readonly turnId: string;
  readonly sessionId: string | null;
  readonly installationId: string;
  readonly arguments: unknown;
  readonly dispatchId: string;
  readonly eventId: string;
  readonly policy: McpReadTurnPolicy;
}
export type McpReadSwitch =
  | { readonly scope: "global" }
  | { readonly scope: "world"; readonly tenantId: string; readonly worldId: string }
  | {
      readonly scope: "installation";
      readonly tenantId: string;
      readonly worldId: string;
      readonly timelineId: string;
      readonly installationId: string;
    };
type Budget = { calls: number; cost: string; time: string; output: string };
type Installation = McpRegistryInstallation & { url: string; ownerId: string; spaceId: string };
function scope(i: EffectIntentMetadata): string[] {
  return [i.tenantId, i.worldId, i.timelineId];
}
function validPolicy(policy: McpReadTurnPolicy): boolean {
  return (
    Object.keys(policy).sort().join() ===
      "maxCalls,maxCostMicrousd,maxModelSteps,maxOutputBytes,maxTimeMs" &&
    Object.values(policy).every((v) => Number.isSafeInteger(v) && v > 0) &&
    policy.maxCalls <= 2_147_483_647
  );
}

export interface AdmittedMcpCall {
  readonly endpoint: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, CapabilityValue>>;
}
export interface McpAdmissionReservation extends McpReadReservation {
  readonly approval?: EffectApprovalBinding;
  readonly admissionKind?: "write";
}

/** Internal privileged client only. No SQL privilege or remote adapter is installed here. */
export class PostgreSqlMcpAdmission {
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly kind: "read" | "write",
    private readonly preflight?: (request: AdmittedMcpCall) => Promise<void>,
  ) {}

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withClientTransaction(this.client, {}, operation);
    } catch {
      throw new Error("MCP read admission unavailable");
    }
  }

  async setSwitch(target: McpReadSwitch, disabled: boolean): Promise<void> {
    if (typeof disabled !== "boolean") throw new Error("Invalid MCP read switch");
    await this.transaction(async () => {
      await this.client.query(
        `INSERT INTO clockgrove.mcp_read_switches
          (scope,tenant_id,world_id,timeline_id,installation_id,disabled) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT(scope,tenant_id,world_id,timeline_id,installation_id)
          DO UPDATE SET disabled=excluded.disabled`,
        [
          target.scope,
          "tenantId" in target ? target.tenantId : "",
          "worldId" in target ? target.worldId : "",
          "timelineId" in target ? target.timelineId : "",
          "installationId" in target ? target.installationId : "",
          disabled,
        ],
      );
    });
  }

  private async killed(i: EffectIntentMetadata, installationId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM clockgrove.mcp_read_switches WHERE disabled AND (
        scope='global' OR scope='world' AND tenant_id=$1 AND world_id=$2
        OR scope='installation' AND tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND installation_id=$4)`,
      [...scope(i), installationId],
    );
    return result.rows.length !== 0;
  }

  private async context(
    request: Omit<McpAdmissionReservation, "arguments">,
    existing = false,
  ): Promise<boolean> {
    const i = request.intent;
    // Proactive provenance must be supplied by canonical activation integration, never caller null.
    if (request.sessionId === null) return false;
    const result = await this.client.query(
      `SELECT 1 FROM clockgrove.conversation_turn_fibers f
          JOIN clockgrove.conversation_sessions s USING(tenant_id,session_id)
          JOIN clockgrove.conversation_participants p ON p.tenant_id=f.tenant_id
            AND p.session_id=f.session_id AND p.principal_id=f.principal_id AND p.persona_id=f.persona_id
          WHERE f.tenant_id=$1 AND f.world_id=$2 AND f.timeline_id=$3 AND s.space_id=$4
          AND f.actor_id=$5 AND s.actor_id=$5 AND f.principal_id=$6
          AND (f.run_id IS NOT DISTINCT FROM $7::text OR $10::boolean AND ($7::text IS NULL OR EXISTS(
            SELECT 1 FROM clockgrove.agent_runs r WHERE r.tenant_id=f.tenant_id AND r.run_id=$7
              AND r.world_id=f.world_id AND r.timeline_id=f.timeline_id AND r.space_id=s.space_id
              AND r.actor_id=f.actor_id AND r.principal_id=f.principal_id AND r.session_id=f.session_id
              AND r.input_message_id=f.message_id))) AND f.message_id=$8 AND f.session_id=$9
          AND s.world_id=$2 AND s.timeline_id=$3 AND s.state='active'
          AND f.phase NOT IN ('completed','rejected','cancelled','failed','abandoned')`,
      [
        ...scope(i),
        i.spaceId,
        i.actorId,
        i.principalId,
        i.runId,
        request.turnId,
        request.sessionId,
        existing,
      ],
    );
    return result.rows.length === 1;
  }

  private async resolve(
    request: Omit<McpAdmissionReservation, "arguments">,
    input: unknown,
    budget: Budget,
  ): Promise<{ request: AdmittedMcpCall; callsPerTurn: number } | { reason: string }> {
    const i = request.intent;
    const rows = await this.client.query(
      `SELECT tenant_id AS "tenantId",world_id AS "worldId",timeline_id AS "timelineId",
        installation_id AS "installationId",space_id AS "spaceId",owner_principal_id AS "ownerId",
        url,status,snapshot,reviews,drifted FROM clockgrove.mcp_installations
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND installation_id=$4`,
      [...scope(i), request.installationId],
    );
    const installation = rows.rows[0] as Installation | undefined;
    if (!installation) return { reason: "installation_unavailable" };
    const member = await this.client.query(
      `SELECT m.grants,m.roles,m.persona_id AS "personaId" FROM clockgrove.world_memberships m
        JOIN clockgrove.worlds w USING(tenant_id,world_id)
        WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.timeline_id=$3 AND m.space_id=$4
        AND m.principal_id=$5 AND m.revoked_at IS NULL AND m.committed_at<=statement_timestamp()
        AND m.principal_id NOT LIKE 'system:%' AND NOT ('actor'=ANY(m.roles))
        AND w.lifecycle_status='ready' AND m.privacy_ceiling->'allowedCategories' ? $6`,
      [...scope(i), i.spaceId, i.principalId, "conversation"],
    );
    const principal = member.rows[0] as
      | { grants: string[]; roles: string[]; personaId: string }
      | undefined;
    if (!principal) return { reason: "member_grant_required" };
    const participant = await this.client.query(
      `SELECT 1 FROM clockgrove.conversation_participants
        WHERE tenant_id=$1 AND session_id=$2 AND principal_id=$3 AND persona_id=$4`,
      [i.tenantId, request.sessionId, i.principalId, principal.personaId],
    );
    if (participant.rows.length !== 1) return { reason: "member_grant_required" };
    const activation = await this.client.query(
      `SELECT r.leader AND r.status='pending' AND r.has_reservation AND p.allow_model
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.configurations) c
          WHERE c->>'id'=r.configuration_id AND c->>'enabled'='true')
        AND clockgrove.runtime_activation_authorized(r.tenant_id,r.world_id,r.timeline_id,r.space_id,r.principal_id) AS valid
        FROM clockgrove.actor_activations r JOIN clockgrove.actor_activation_policies p
          USING(tenant_id,world_id,timeline_id,actor_id)
        WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.timeline_id=$3 AND r.space_id=$4
          AND r.actor_id=$5 AND r.principal_id=$6 AND r.session_id=$7 AND r.message_id=$8
        ORDER BY r.leader DESC LIMIT 1`,
      [...scope(i), i.spaceId, i.actorId, i.principalId, request.sessionId, request.turnId],
    );
    if (activation.rows.length && this.kind === "write")
      return { reason: "write_activation_unavailable" };
    if (activation.rows.length) {
      if (!(activation.rows[0] as { valid: boolean }).valid)
        return { reason: "activation_unavailable" };
      const owner = await this.client.query(
        `SELECT 1 FROM clockgrove.world_memberships WHERE tenant_id=$1 AND world_id=$2
          AND timeline_id=$3 AND space_id=$4 AND principal_id=$5 AND revoked_at IS NULL
          AND committed_at<=statement_timestamp() AND privacy_ceiling->'allowedCategories' ? 'operator_evidence'
          AND ('owner'=ANY(roles) OR 'runtime:mcp-install'=ANY(grants))`,
        [...scope(i), installation.spaceId, installation.ownerId],
      );
      if (i.principalId !== installation.ownerId || owner.rows.length !== 1)
        return { reason: "installer_authority_required" };
    } else if (!principal.grants.includes(i.capabilityId))
      return { reason: "member_grant_required" };
    const bindingRows = await this.client.query(
      `SELECT binding||jsonb_build_object('tenantId',tenant_id,'worldId',world_id,'timelineId',timeline_id) AS binding
        FROM clockgrove.mcp_bindings WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND installation_id=$4`,
      [...scope(i), request.installationId],
    );
    const bindings = bindingRows.rows.map((r) => (r as { binding: McpCapabilityBinding }).binding);
    const { registry, grants } = resolveMcpCapabilityRegistry([installation], bindings, {
      tenantId: i.tenantId,
      worldId: i.worldId,
      timelineId: i.timelineId,
      actorId: i.actorId,
      sessionId: request.sessionId ?? "",
      runtimeGrants: [],
    });
    const definition = registry.get(i.capabilityId);
    if (
      !definition?.remoteMcp ||
      (this.kind === "read"
        ? definition.effect !== "read"
        : !["external-write", "destructive", "cost", "network"].includes(definition.effect))
    )
      return { reason: this.kind === "read" ? "read_only_required" : "protected_write_required" };
    const scopeTypes = ["tenant", "world", "timeline", "actor", "session"];
    const scopeIds = [...scope(i), i.actorId, request.sessionId ?? ""];
    const selected = bindings.filter(
      (b) =>
        b.candidateId === definition.remoteMcp?.candidateId &&
        b.enabled &&
        b.effect === "allow" &&
        b.schemaHash ===
          installation.snapshot.candidates.find((c) => c.id === b.candidateId)?.schemaHash &&
        b.protocolVersion === installation.snapshot.protocolVersion &&
        b.scopeId === scopeIds[scopeTypes.indexOf(b.scopeType)],
    );
    const specificity = Math.max(-1, ...selected.map((b) => scopeTypes.indexOf(b.scopeType)));

    const held = grants.grants.find((g) => g.capability === i.capabilityId);
    if (
      !selected.some(
        (b) =>
          scopeTypes.indexOf(b.scopeType) === specificity &&
          b.bindingId === i.grantId &&
          b.enabled &&
          b.effect === "allow" &&
          b.candidateId === definition.remoteMcp?.candidateId,
      )
    )
      return { reason: "binding_required" };
    const usage = await this.client.query(
      `SELECT count(*)::integer AS calls FROM clockgrove.mcp_read_admissions a
        JOIN clockgrove.effect_intents e USING(tenant_id,world_id,timeline_id,effect_id)
        WHERE a.tenant_id=$1 AND a.world_id=$2 AND a.timeline_id=$3 AND a.turn_id=$4
        AND a.admitted AND e.capability_id=$5 AND e.effect_id<>$6`,
      [
        ...scope(i),
        mcpReadArgumentsHash({ sessionId: request.sessionId, turnId: request.turnId }),
        i.capabilityId,
        i.effectId,
      ],
    );
    const calls = (usage.rows[0] as { calls: number }).calls;
    const decision = grants.authorize(
      { capability: i.capabilityId, input },
      new Map([[i.capabilityId, calls]]),
      {
        destination: installation.url,
        estimatedCostMicrousd: i.reservedMicrousd,
        spentMicrousd: Number(budget.cost),
      },
    );
    if (!decision.accepted) return { reason: decision.code };
    let argumentsHash: string;
    try {
      argumentsHash = mcpReadArgumentsHash(decision.input);
    } catch {
      return { reason: "invalid_input" };
    }
    if (argumentsHash !== i.argumentsHash) return { reason: "arguments_changed" };
    return {
      request: {
        endpoint: installation.url,
        toolName: definition.remoteMcp.candidateId,
        arguments: decision.input as AdmittedMcpCall["arguments"],
      },
      callsPerTurn: held?.callsPerTurn ?? 0,
    };
  }

  private async approvalReason(
    request: McpAdmissionReservation,
    consumed = false,
  ): Promise<string | null> {
    const approval = request.approval;
    const i = request.intent;
    if (!approval || approval.approverPrincipalId !== i.principalId)
      return "approval_authority_required";
    const reservation = {
      ...i,
      disposition: "pending" as const,
      dispatchId: request.dispatchId,
      eventId: request.eventId,
    };
    if (
      i.idempotencyKey !== approvedEffectIdempotencyKey(approval) ||
      approval.effectHash !== approvedEffectHash(reservation) ||
      approval.argumentsHash !== i.argumentsHash ||
      approval.tenantId !== i.tenantId ||
      approval.worldId !== i.worldId ||
      approval.timelineId !== i.timelineId ||
      approval.spaceId !== i.spaceId ||
      approval.effectId !== i.effectId ||
      approval.principalId !== i.principalId ||
      approval.argumentsArtifactId !== i.argumentsArtifactId
    )
      return "approval_binding_changed";
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["approved-effect", i.tenantId, i.worldId, i.timelineId, i.effectId]),
    ]);
    // Approval revocation and consumption share this row lock; never spend it on refused admission.
    await this.client.query(
      `SELECT 1 FROM clockgrove.effect_approvals
      WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND approval_id=$4 FOR UPDATE`,
      [...scope(i), approval.approvalId],
    );
    const rows = await this.client.query(
      `SELECT state,expires_at>clock_timestamp() AS valid,
      expires_at::text AS expiry,expiry_seconds AS lifetime,arguments_hash AS arguments,
      effect_hash AS effect,principal_id AS principal,approver_principal_id AS approver,
      space_id AS space,effect_id AS id,arguments_artifact_id AS artifact
      FROM clockgrove.effect_approvals WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3
      AND approval_id=$4`,
      [...scope(i), approval.approvalId],
    );
    const held = rows.rows[0] as
      | {
          state: string;
          valid: boolean;
          expiry: string;
          lifetime: number;
          arguments: string;
          effect: string;
          principal: string;
          approver: string;
          space: string;
          id: string;
          artifact: string | null;
        }
      | undefined;
    if (
      !held ||
      held.expiry !== approval.expiresAt ||
      held.lifetime !== (approval.expirySeconds ?? 600) ||
      held.arguments !== approval.argumentsHash ||
      held.effect !== approval.effectHash ||
      held.principal !== approval.principalId ||
      held.approver !== approval.approverPrincipalId ||
      held.space !== approval.spaceId ||
      held.id !== approval.effectId ||
      held.artifact !== approval.argumentsArtifactId
    )
      return "approval_binding_changed";
    if (!held.valid) return "approval_expired";
    return held.state === (consumed ? "consumed" : "approved") ? null : `approval_${held.state}`;
  }

  async reserve(request: McpAdmissionReservation): Promise<RecordedEffect> {
    try {
      request = structuredClone(request);
    } catch {
      throw new Error("Invalid MCP read request");
    }
    if (
      this.kind === "read"
        ? request.approval !== undefined || request.admissionKind !== undefined
        : !request.approval || request.admissionKind !== "write"
    )
      throw new Error("Invalid MCP admission kind");
    const { arguments: input, ...metadata } = request;
    let presentedArgumentsHash: string;
    try {
      presentedArgumentsHash = mcpReadArgumentsHash(input);
    } catch {
      throw new Error("Invalid MCP read arguments");
    }
    // A refusal may deliberately record a mismatched claimed hash; bind retries to what was presented.
    const identity = { ...metadata, presentedArgumentsHash };
    const i = request.intent;
    const turnKey = mcpReadArgumentsHash({ sessionId: request.sessionId, turnId: request.turnId });
    if (
      !validPolicy(request.policy) ||
      !Number.isSafeInteger(i.reservedMicrousd) ||
      i.reservedMicrousd <= 0
    )
      throw new Error("Invalid MCP read policy");
    const result = await this.transaction(async () => {
      // Match model reservation lock order: one canonical turn owns the shared cost envelope.
      const fiberBudget = await this.client.query(
        `SELECT research_reserved_microusd,research_max_cost_microusd FROM clockgrove.conversation_turn_fibers
          WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND session_id=$4 AND message_id=$5 FOR UPDATE`,
        [...scope(i), request.sessionId, request.turnId],
      );
      const modelReserved = Number(
        (fiberBudget.rows[0] as { research_reserved_microusd: string } | undefined)
          ?.research_reserved_microusd ?? 0,
      );
      const pinnedCost = (
        fiberBudget.rows[0] as { research_max_cost_microusd: string | null } | undefined
      )?.research_max_cost_microusd;
      const sharedCeiling = Math.min(
        request.policy.maxCostMicrousd,
        pinnedCost == null ? request.policy.maxCostMicrousd : Number(pinnedCost),
      );
      // Same lock as installation/binding changes; turn budget row serializes concurrent calls.
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${scope(i).join("/")}/mcp`,
      ]);
      const prior = await this.client.query(
        `SELECT identity FROM clockgrove.mcp_read_admissions
          WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4`,
        [...scope(i), i.effectId],
      );
      if (prior.rows.length) {
        const equal = await this.client.query("SELECT $1::jsonb=$2::jsonb AS equal", [
          JSON.stringify((prior.rows[0] as { identity: unknown }).identity),
          JSON.stringify(identity),
        ]);
        if (!(equal.rows[0] as { equal: boolean }).equal) {
          const original = (prior.rows[0] as { identity: { presentedArgumentsHash: string } })
            .identity;
          await this.client.query(
            `INSERT INTO clockgrove.mcp_read_retry_refusals
              (tenant_id,world_id,timeline_id,effect_id,retry_hash,presented_arguments_hash,outcome_code)
              VALUES($1,$2,$3,$4,encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),$6,$7) ON CONFLICT DO NOTHING`,
            [
              ...scope(i),
              i.effectId,
              JSON.stringify(identity),
              presentedArgumentsHash,
              original.presentedArgumentsHash === presentedArgumentsHash
                ? "retry_conflict"
                : "arguments_changed",
            ],
          );
          return null;
        }
        return new PostgreSqlEffects(this.client).readInTransaction(i) as Promise<RecordedEffect>;
      }
      if (!(await this.context(identity))) throw new Error("MCP read context unavailable");
      await this.client.query(
        `INSERT INTO clockgrove.mcp_read_turn_budgets
          (tenant_id,world_id,timeline_id,turn_id,actor_id,principal_id,session_id,policy)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
        [
          ...scope(i),
          turnKey,
          i.actorId,
          i.principalId,
          request.sessionId,
          JSON.stringify(request.policy),
        ],
      );
      const budgetRows = await this.client.query(
        `SELECT calls,reserved_microusd::text AS cost,reserved_time_ms::text AS time,
          reserved_output_bytes::text AS output,actor_id,principal_id,session_id,policy
          FROM clockgrove.mcp_read_turn_budgets WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND turn_id=$4 FOR UPDATE`,
        [...scope(i), turnKey],
      );
      const budget = budgetRows.rows[0] as Budget & {
        actor_id: string;
        principal_id: string;
        session_id: string | null;
        policy: McpReadTurnPolicy;
      };
      const policyMatch = await this.client.query("SELECT $1::jsonb=$2::jsonb AS equal", [
        JSON.stringify(budget.policy),
        JSON.stringify(request.policy),
      ]);
      if (
        budget.actor_id !== i.actorId ||
        budget.principal_id !== i.principalId ||
        budget.session_id !== request.sessionId ||
        !(policyMatch.rows[0] as { equal: boolean }).equal
      )
        throw new Error("MCP read turn identity conflicts");
      const timeline = await this.client.query(
        "SELECT kind FROM clockgrove.timelines WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3",
        scope(i),
      );
      const preview = (timeline.rows[0] as { kind: string }).kind !== "live";
      let reason: string | null = null;
      if (preview) reason = "preview_blocked";
      else if (await this.killed(i, request.installationId)) reason = "kill_switch";
      const resolved = reason ? null : await this.resolve(identity, input, budget);
      if (resolved && "reason" in resolved) reason = resolved.reason;
      if (!reason && resolved && "request" in resolved && this.preflight) {
        try {
          await this.preflight(resolved.request);
        } catch {
          reason = "network_refused";
        }
      }
      if (!reason && this.kind === "write") reason = await this.approvalReason(request);
      if (!reason && i.argumentsArtifactId === null) reason = "arguments_artifact_required";
      if (
        !reason &&
        resolved &&
        "request" in resolved &&
        (budget.calls >= request.policy.maxCalls ||
          i.reservedMicrousd > sharedCeiling - Number(budget.cost) - modelReserved ||
          callTimeMs > request.policy.maxTimeMs - Number(budget.time) ||
          MCP_READ_LIMITS.outputBytes > request.policy.maxOutputBytes - Number(budget.output))
      )
        reason = "budget_exhausted";
      const reservation = {
        ...i,
        disposition: "pending" as const,
        dispatchId: request.dispatchId,
        eventId: request.eventId,
      };
      const effect = reason
        ? await new PostgreSqlEffects(this.client).reserveInTransaction({
            ...i,
            disposition: preview ? "blocked" : "refused",
            outcomeCode: reason,
          })
        : this.kind === "write"
          ? await new PostgreSqlApprovedEffects(this.client).reserveInTransaction({
              reservation,
              arguments: resolved && "request" in resolved ? resolved.request.arguments : input,
              approval: request.approval!,
            })
          : await new PostgreSqlEffects(this.client).reserveInTransaction(reservation);
      await this.client.query(
        `INSERT INTO clockgrove.mcp_read_admissions
          (tenant_id,world_id,timeline_id,effect_id,turn_id,installation_id,identity,reserved_time_ms,reserved_output_bytes,admitted)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
        [
          ...scope(i),
          i.effectId,
          turnKey,
          request.installationId,
          JSON.stringify(identity),
          callTimeMs,
          MCP_READ_LIMITS.outputBytes,
          reason === null,
        ],
      );
      if (!reason)
        await this.client.query(
          `UPDATE clockgrove.mcp_read_turn_budgets SET calls=calls+1,reserved_microusd=reserved_microusd+$5,
          reserved_time_ms=reserved_time_ms+$6,reserved_output_bytes=reserved_output_bytes+$7
          WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND turn_id=$4`,
          [...scope(i), turnKey, i.reservedMicrousd, callTimeMs, MCP_READ_LIMITS.outputBytes],
        );
      return effect;
    });
    // Throw after commit so a conflicting retry cannot erase its refusal receipt.
    if (result === null) throw new Error("MCP read admission unavailable");
    return result;
  }

  /** Fresh check immediately before the adapter. Arguments must come from the encrypted artifact. */
  async admit(intent: EffectIntentMetadata, input: unknown): Promise<AdmittedMcpCall | null> {
    try {
      intent = structuredClone(intent);
      input = structuredClone(input);
    } catch {
      throw new Error("Invalid MCP read request");
    }
    return this.transaction(async () => {
      const rows = await this.client.query(
        `SELECT a.identity,b.reserved_microusd::text AS cost FROM clockgrove.mcp_read_admissions a
          JOIN clockgrove.mcp_read_turn_budgets b USING(tenant_id,world_id,timeline_id,turn_id)
          JOIN clockgrove.effect_intents i USING(tenant_id,world_id,timeline_id,effect_id)
          JOIN clockgrove.timelines t USING(tenant_id,world_id,timeline_id)
          WHERE a.tenant_id=$1 AND a.world_id=$2 AND a.timeline_id=$3 AND a.effect_id=$4
          AND a.admitted AND i.disposition IN ('pending','started') AND t.kind='live'`,
        [...scope(intent), intent.effectId],
      );
      if (!rows.rows.length) return null;
      const row = rows.rows[0] as {
        identity: Omit<McpAdmissionReservation, "arguments">;
        cost: string;
      };
      const same = await this.client.query("SELECT $1::jsonb=$2::jsonb AS equal", [
        JSON.stringify(row.identity.intent),
        JSON.stringify(intent),
      ]);
      if (
        (this.kind === "read"
          ? row.identity.admissionKind !== undefined || row.identity.approval !== undefined
          : row.identity.admissionKind !== "write" || !row.identity.approval) ||
        !(same.rows[0] as { equal: boolean }).equal ||
        !(await this.context(row.identity, true)) ||
        (await this.killed(intent, row.identity.installationId))
      )
        return null;
      if (
        this.kind === "write" &&
        (await this.approvalReason({ ...row.identity, arguments: input }, true))
      )
        return null;
      const resolved = await this.resolve(row.identity, input, {
        calls: 0,
        cost: String(Number(row.cost) - intent.reservedMicrousd),
        time: "0",
        output: "0",
      });
      return "request" in resolved && !(await this.killed(intent, row.identity.installationId))
        ? resolved.request
        : null;
    });
  }
}
