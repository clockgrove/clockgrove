import {
  type AdmittedMcpRead,
  type ArtifactStore,
  allowDecision,
  CAPABILITY_REGISTRY,
  type ConversationParticipant,
  computePayloadHash,
  MCP_HTTP_LIMITS,
  MCP_READ_LIMITS,
  type McpCapabilityBinding,
  type McpNetworkPort,
  type McpReadEvidence,
  type McpRegistryInstallation,
  mcpReadArgumentsHash,
  resolveMcpCapabilityRegistry,
  SafeMcpHttpClient,
  type StoredCommandProposal,
  sanitizeMcpReadEvidence,
  sweepDispatches,
  type TurnFiber,
  type TurnToolCall,
} from "@clockgrove/application";
import {
  type BrowserScope,
  constructActorAddress,
  decodeActorTargetBinding,
  decodeAttributionEnvelope,
  decodeCommandEnvelope,
  decodeOpaqueId,
  type QueueEnvelope,
} from "@clockgrove/contracts";
import { simulationTimeMs } from "@clockgrove/kernel";
import {
  type EffectIntentMetadata,
  MCP_READ_TURN_DEFAULTS,
  type PostgreSqlClient,
  PostgreSqlDispatchStore,
  PostgreSqlEffects,
  PostgreSqlJournal,
  PostgreSqlMcpReadAdmission,
  type RecordedEffect,
  withClientTransaction,
} from "@clockgrove/persistence";
import { externalEffectsConsumer } from "./external-effects.js";

export interface ResearchResumeTarget {
  readonly scope: BrowserScope;
  readonly actorId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly principalId: string;
  readonly personaId: string;
}
export interface ResearchPolicy {
  readonly maxCalls: number;
  readonly maxModelSteps: number;
  readonly maxCostMicrousd: number;
  readonly modelStepReserveMicrousd: number;
}
export interface ResearchConfiguration {
  readonly environment: string;
  /** Isolated privileged internal connection; never the ordinary runtime pool. */
  readonly withClient: <T>(operation: (client: PostgreSqlClient) => Promise<T>) => Promise<T>;
  readonly artifacts: (client: PostgreSqlClient) => ArtifactStore;
  readonly network: McpNetworkPort;
  readonly adapter: {
    execute(request: AdmittedMcpRead, intent: EffectIntentMetadata): Promise<McpReadEvidence>;
  };
  readonly publish: (message: QueueEnvelope<unknown>) => Promise<void>;
  readonly wake: (target: ResearchResumeTarget) => Promise<void>;
  readonly internalRead?: (
    target: ResearchResumeTarget,
    capability: string,
    input: unknown,
  ) => Promise<McpReadEvidence>;
  readonly policy?: ResearchPolicy;
  readonly toolCallReserveMicrousd?: number;
}

interface Context extends ResearchResumeTarget {
  readonly partitionId: string;
  readonly streamId: string;
  readonly membershipId: string;
  readonly grants: string[];
  readonly roles: string[];
  readonly privacyCeiling: ConversationParticipant["privacyCeiling"];
  readonly simulationTime: string;
}
const metadataColumns = `tenant_id AS "tenantId",world_id AS "worldId",timeline_id AS "timelineId",
  effect_id AS "effectId",space_id AS "spaceId",idempotency_key AS "idempotencyKey",actor_id AS "actorId",
  principal_id AS "principalId",run_id AS "runId",call_id AS "callId",capability_id AS "capabilityId",
  grant_id AS "grantId",policy_version AS "policyVersion",arguments_hash AS "argumentsHash",
  arguments_artifact_id AS "argumentsArtifactId",reserved_microusd::float8 AS "reservedMicrousd"`;
const scoped = (intent: EffectIntentMetadata) => [
  intent.tenantId,
  intent.worldId,
  intent.timelineId,
  intent.effectId,
];
const internal = (capability: string) => capability === "inspect" || capability === "why";
// Three HTTP deadlines (45 s) plus a 15 s persistence allowance, after which only uncertainty is safe.
const ATTEMPT_RECONCILIATION_MS = 60_000;

export function composeResearch(configuration: ResearchConfiguration) {
  if (configuration.environment !== "local")
    throw new Error("Research hosted activation pending issue 3");
  const policy: ResearchPolicy = configuration.policy ?? {
    maxCalls: MCP_READ_TURN_DEFAULTS.maxCalls,
    maxModelSteps: MCP_READ_TURN_DEFAULTS.maxModelSteps,
    maxCostMicrousd: MCP_READ_TURN_DEFAULTS.maxCostMicrousd,
    // Existing per-model envelope, retained conservatively even when actual cost is unknown.
    modelStepReserveMicrousd: 50_000,
  };
  // Engineering reservation, not a claimed price: unknown tool cost remains NULL and counted.
  const toolReserve = configuration.toolCallReserveMicrousd ?? 1_000;
  if (![...Object.values(policy), toolReserve].every((v) => Number.isSafeInteger(v) && v > 0))
    throw new Error("Research policy unavailable");

  async function context(
    client: PostgreSqlClient,
    target: ResearchResumeTarget,
  ): Promise<Context | null> {
    const result = await client.query(
      `SELECT s.partition_id AS "partitionId",st.stream_id AS "streamId",m.membership_id AS "membershipId",
        m.grants,m.roles,m.privacy_ceiling AS "privacyCeiling",(SELECT coalesce(max(e.simulation_time),0)::text FROM clockgrove.events e WHERE e.tenant_id=s.tenant_id AND e.world_id=s.world_id AND e.timeline_id=s.timeline_id AND e.partition_id=s.partition_id) AS "simulationTime"
        FROM clockgrove.conversation_turn_fibers f
        JOIN clockgrove.conversation_sessions s USING(tenant_id,session_id)
        JOIN clockgrove.conversation_participants cp ON cp.tenant_id=f.tenant_id AND cp.session_id=f.session_id
          AND cp.principal_id=f.principal_id AND cp.persona_id=f.persona_id
        JOIN clockgrove.world_memberships m ON m.tenant_id=f.tenant_id AND m.world_id=f.world_id
          AND m.timeline_id=f.timeline_id AND m.space_id=s.space_id AND m.principal_id=f.principal_id
          AND m.persona_id=f.persona_id AND m.revoked_at IS NULL AND m.committed_at<=statement_timestamp()
        JOIN clockgrove.timeline_partitions p ON p.tenant_id=s.tenant_id AND p.world_id=s.world_id
          AND p.timeline_id=s.timeline_id AND p.partition_id=s.partition_id
        JOIN LATERAL (SELECT stream_id FROM clockgrove.streams WHERE tenant_id=s.tenant_id
          AND world_id=s.world_id AND timeline_id=s.timeline_id AND partition_id=s.partition_id
          AND space_id=s.space_id ORDER BY stream_id LIMIT 1) st ON true
        WHERE f.tenant_id=$1 AND f.world_id=$2 AND f.timeline_id=$3 AND s.space_id=$4
          AND f.session_id=$5 AND f.message_id=$6 AND f.actor_id=$7 AND s.actor_id=$7
          AND f.principal_id=$8 AND f.persona_id=$9 AND s.state='active'
          AND f.phase NOT IN ('completed','failed','cancelled','rejected','abandoned')`,
      [
        target.scope.tenantId,
        target.scope.worldId,
        target.scope.timelineId,
        target.scope.spaceId,
        target.sessionId,
        target.messageId,
        target.actorId,
        target.principalId,
        target.personaId,
      ],
    );
    const row = result.rows[0] as Omit<Context, keyof ResearchResumeTarget> | undefined;
    return row?.privacyCeiling.allowedCategories.includes("conversation")
      ? { ...target, ...row }
      : null;
  }
  function authorization(c: Context): ConversationParticipant {
    return {
      tenantId: c.scope.tenantId,
      principalId: decodeOpaqueId(c.principalId, "PrincipalId"),
      personaId: decodeOpaqueId(c.personaId, "WorldPersonaId"),
      privacyCeiling: c.privacyCeiling,
    };
  }
  function locator(c: Context, artifactId: string) {
    return {
      ...c.scope,
      partitionId: decodeOpaqueId(c.partitionId, "PartitionId"),
      artifactId: decodeOpaqueId(artifactId, "ArtifactId"),
    };
  }
  async function put(client: PostgreSqlClient, c: Context, id: string, value: unknown) {
    await configuration.artifacts(client).put(authorization(c), {
      ...locator(c, id),
      bytes: new TextEncoder().encode(JSON.stringify(value)),
      mediaType: "application/json",
      privacyClass: "conversation",
      retentionClass: "durable",
    });
  }
  async function get(client: PostgreSqlClient, c: Context, id: string): Promise<unknown> {
    const stored = await configuration.artifacts(client).get(authorization(c), locator(c, id));
    if (stored.ref.privacyClass !== "conversation" || stored.ref.encryption !== "aes-256-gcm-v1")
      throw new Error("Research artifact unavailable");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
  }
  async function target(
    client: PostgreSqlClient,
    intent: EffectIntentMetadata,
  ): Promise<Context | null> {
    const result = await client.query(
      `SELECT f.session_id AS "sessionId",f.message_id AS "messageId",f.persona_id AS "personaId"
      FROM clockgrove.conversation_turn_fibers f JOIN clockgrove.agent_runs r ON r.tenant_id=f.tenant_id AND r.session_id=f.session_id
        AND r.input_message_id=f.message_id WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.timeline_id=$3
        AND r.run_id=$4 AND f.actor_id=$5 AND f.principal_id=$6`,
      [
        intent.tenantId,
        intent.worldId,
        intent.timelineId,
        intent.runId,
        intent.actorId,
        intent.principalId,
      ],
    );
    const row = result.rows[0] as
      | { sessionId: string; messageId: string; personaId: string }
      | undefined;
    return row
      ? context(client, {
          scope: {
            tenantId: decodeOpaqueId(intent.tenantId, "TenantId"),
            worldId: decodeOpaqueId(intent.worldId, "WorldId"),
            timelineId: decodeOpaqueId(intent.timelineId, "TimelineId"),
            spaceId: decodeOpaqueId(intent.spaceId, "SpaceId"),
          },
          actorId: intent.actorId,
          principalId: intent.principalId,
          ...row,
        })
      : null;
  }
  async function killed(client: PostgreSqlClient, c: Context): Promise<boolean> {
    return (
      (
        await client.query(
          `SELECT 1 FROM clockgrove.mcp_read_switches WHERE disabled AND
      (scope='global' OR scope='world' AND tenant_id=$1 AND world_id=$2)`,
          [c.scope.tenantId, c.scope.worldId],
        )
      ).rows.length > 0
    );
  }
  function presentedHash(input: unknown): string {
    try {
      return mcpReadArgumentsHash(input);
    } catch {
      return mcpReadArgumentsHash({ invalidArguments: true });
    }
  }
  async function intentOf(client: PostgreSqlClient, scope: BrowserScope, effectId: string) {
    const found = await client.query(
      `SELECT ${metadataColumns} FROM clockgrove.effect_intents WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4`,
      [scope.tenantId, scope.worldId, scope.timelineId, effectId],
    );
    return found.rows[0] as EffectIntentMetadata | undefined;
  }
  async function resolve(client: PostgreSqlClient, c: Context, proposal: StoredCommandProposal) {
    const installations = await client.query(
      `SELECT installation_id AS "installationId",url,status,snapshot,reviews,drifted,
      tenant_id AS "tenantId",world_id AS "worldId",timeline_id AS "timelineId" FROM clockgrove.mcp_installations
      WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3`,
      [c.scope.tenantId, c.scope.worldId, c.scope.timelineId],
    );
    const bindings = await client.query(
      `SELECT binding||jsonb_build_object('tenantId',tenant_id,'worldId',world_id,'timelineId',timeline_id) AS binding
      FROM clockgrove.mcp_bindings WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3`,
      [c.scope.tenantId, c.scope.worldId, c.scope.timelineId],
    );
    const bindingList = bindings.rows.map((v) => (v as { binding: McpCapabilityBinding }).binding);
    const resolved = resolveMcpCapabilityRegistry(
      installations.rows as McpRegistryInstallation[],
      bindingList,
      {
        ...c.scope,
        actorId: c.actorId,
        sessionId: c.sessionId,
        runtimeGrants: c.grants,
      },
    );
    const definition = resolved.registry.get(proposal.capability);
    const installation = installations.rows.find(
      (v) =>
        (v as { installationId: string }).installationId === definition?.remoteMcp?.installationId,
    ) as { url: string } | undefined;
    const scopes = ["tenant", "world", "timeline", "actor", "session"];
    const scopeIds = [
      c.scope.tenantId,
      c.scope.worldId,
      c.scope.timelineId,
      c.actorId,
      c.sessionId,
    ];
    const selected = bindingList
      .filter(
        (b) =>
          b.installationId === definition?.remoteMcp?.installationId &&
          b.candidateId === definition.remoteMcp.candidateId &&
          b.schemaHash === definition.remoteMcp.schemaHash &&
          b.protocolVersion === definition.remoteMcp.protocolVersion &&
          b.enabled &&
          b.effect === "allow" &&
          scopeIds[scopes.indexOf(b.scopeType)] === b.scopeId,
      )
      .sort((a, b) => scopes.indexOf(b.scopeType) - scopes.indexOf(a.scopeType));
    const decision = resolved.grants.authorize(proposal, undefined, {
      ...(installation ? { destination: installation.url } : {}),
      estimatedCostMicrousd: toolReserve,
      spentMicrousd: 0,
    });
    return { definition, installation, binding: selected[0], decision };
  }
  async function event(
    client: PostgreSqlClient,
    c: Context,
    intent: EffectIntentMetadata,
    proposal: StoredCommandProposal,
  ) {
    const commandId = decodeOpaqueId(`trusted:research:${intent.effectId}`, "CommandId");
    const prior = await client.query(
      `SELECT 1 FROM clockgrove.events WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND event_id=$4 AND payload_hash=$5`,
      [
        c.scope.tenantId,
        c.scope.worldId,
        c.scope.timelineId,
        `${commandId}:event`,
        computePayloadHash({
          effectId: intent.effectId,
          callId: intent.callId,
          capabilityId: intent.capabilityId,
          argumentsHash: intent.argumentsHash,
        }),
      ],
    );
    if (prior.rows.length) return `${commandId}:event`;
    const binding = decodeActorTargetBinding({
      tenantId: c.scope.tenantId,
      worldId: c.scope.worldId,
      timelineId: c.scope.timelineId,
      kind: "world",
      id: c.scope.worldId,
    });
    const attribution = {
      principalId: decodeOpaqueId(c.principalId, "PrincipalId"),
      worldMembershipId: decodeOpaqueId(c.membershipId, "WorldMembershipId"),
      personaId: decodeOpaqueId(c.personaId, "WorldPersonaId"),
      initiatorId: decodeOpaqueId(c.principalId, "PrincipalId"),
      effectiveActorId: decodeOpaqueId(c.actorId, "SubjectId"),
      causalRootActionId: decodeOpaqueId(commandId, "ActionId"),
    };
    const payload = {
      effectId: intent.effectId,
      callId: intent.callId,
      capabilityId: intent.capabilityId,
      argumentsHash: intent.argumentsHash,
    };
    const raw = {
      schemaVersion: 2,
      commandId,
      type: "McpReadRequest",
      target: constructActorAddress(binding),
      expected: {},
      issuedAt: proposal.issuedAt,
      context: { version: 1, correlationId: commandId, requestId: commandId },
      attribution,
      payload,
    };
    const command = decodeCommandEnvelope(raw, binding, (v) => v);
    const authorityDecision = allowDecision({
      tenantId: c.scope.tenantId,
      worldId: c.scope.worldId,
      timelineId: c.scope.timelineId,
      commandId,
      attribution,
      inputs: {
        principalId: attribution.principalId,
        worldMembershipId: attribution.worldMembershipId,
        personaId: attribution.personaId,
        roles: c.roles.map((v) => decodeOpaqueId(v, "RoleId")),
        grants: c.grants.map((v) => decodeOpaqueId(v, "GrantRef")),
        privacyCeiling: c.privacyCeiling,
      },
    });
    const route = {
      partitionId: decodeOpaqueId(c.partitionId, "PartitionId"),
      spaceId: c.scope.spaceId,
      streamId: decodeOpaqueId(c.streamId, "StreamId"),
    };
    await new PostgreSqlJournal(client).execute({
      authorization: authorization(c),
      command,
      commandBytes: new TextEncoder().encode(JSON.stringify(raw)),
      route,
      authorityDecision,
      events: [
        {
          schemaVersion: 2,
          eventId: decodeOpaqueId(`${commandId}:event`, "EventId"),
          type: "McpReadRequested",
          ...route,
          simulationTime: simulationTimeMs(BigInt(c.simulationTime)),
          correlationId: decodeOpaqueId(commandId, "CorrelationId"),
          attribution: decodeAttributionEnvelope({
            ...attribution,
            authorityDecisionId: authorityDecision.authorityDecisionId,
          }),
          principalId: attribution.principalId,
          policyVersions: { research: "research-v1" },
          privacyClass: "conversation",
          payloadHash: computePayloadHash(payload),
          payload,
        },
      ],
      dispatches: [],
      stableResult: { effectId: intent.effectId },
      projectionDelta: null,
    });
    return `${commandId}:event`;
  }
  async function reserveInternal(
    client: PostgreSqlClient,
    c: Context,
    intent: EffectIntentMetadata,
    eventId: string,
  ) {
    const turnId = mcpReadArgumentsHash({ sessionId: c.sessionId, turnId: c.messageId });
    const turnPolicy = {
      ...MCP_READ_TURN_DEFAULTS,
      maxCalls: policy.maxCalls,
      maxModelSteps: policy.maxModelSteps,
      maxCostMicrousd: policy.maxCostMicrousd,
    };
    const input = await get(client, c, intent.argumentsArtifactId!);
    await withClientTransaction(client, {}, async () => {
      const fiber = await client.query(
        `SELECT research_reserved_microusd::float8 AS reserved FROM clockgrove.conversation_turn_fibers
        WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 FOR UPDATE`,
        [c.scope.tenantId, c.sessionId, c.messageId],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${c.scope.tenantId}/${c.scope.worldId}/${c.scope.timelineId}/mcp`,
      ]);
      const prior = await new PostgreSqlEffects(client).readInTransaction(intent);
      if (prior) return;
      await client.query(
        `INSERT INTO clockgrove.mcp_read_turn_budgets(tenant_id,world_id,timeline_id,turn_id,actor_id,principal_id,session_id,policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
        [
          c.scope.tenantId,
          c.scope.worldId,
          c.scope.timelineId,
          turnId,
          c.actorId,
          c.principalId,
          c.sessionId,
          JSON.stringify(turnPolicy),
        ],
      );
      const budgets = await client.query(
        `SELECT calls,reserved_microusd::float8 AS cost,reserved_time_ms::float8 AS time,
        reserved_output_bytes::float8 AS output,policy=$5::jsonb AS match FROM clockgrove.mcp_read_turn_budgets
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND turn_id=$4 FOR UPDATE`,
        [c.scope.tenantId, c.scope.worldId, c.scope.timelineId, turnId, JSON.stringify(turnPolicy)],
      );
      const budget = budgets.rows[0] as {
        calls: number;
        cost: number;
        time: number;
        output: number;
        match: boolean;
      };
      if (!budget.match) throw new Error("Research policy conflicts");
      const count = await client.query(
        `SELECT count(*)::integer AS calls FROM clockgrove.mcp_read_admissions a
        JOIN clockgrove.effect_intents i USING(tenant_id,world_id,timeline_id,effect_id)
        WHERE a.tenant_id=$1 AND a.world_id=$2 AND a.timeline_id=$3 AND a.turn_id=$4 AND a.admitted AND i.capability_id=$5`,
        [c.scope.tenantId, c.scope.worldId, c.scope.timelineId, turnId, intent.capabilityId],
      );
      const decision = CAPABILITY_REGISTRY.grantsFor(c.grants).authorize(
        { capability: intent.capabilityId, input },
        new Map([[intent.capabilityId, (count.rows[0] as { calls: number }).calls]]),
      );
      const timeline = await client.query(
        "SELECT kind FROM clockgrove.timelines WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3",
        [c.scope.tenantId, c.scope.worldId, c.scope.timelineId],
      );
      const preview = (timeline.rows[0] as { kind: string }).kind !== "live";
      let reason = preview
        ? "preview_blocked"
        : (await killed(client, c))
          ? "kill_switch"
          : !decision.accepted
            ? decision.code
            : null;
      const time = 3 * MCP_HTTP_LIMITS.timeoutMs;
      if (
        !reason &&
        (budget.calls >= policy.maxCalls ||
          budget.cost + Number((fiber.rows[0] as { reserved: number }).reserved) >
            policy.maxCostMicrousd ||
          budget.time + time > turnPolicy.maxTimeMs ||
          budget.output + MCP_READ_LIMITS.outputBytes > turnPolicy.maxOutputBytes)
      )
        reason = "budget_exhausted";
      await new PostgreSqlEffects(client).reserveInTransaction(
        reason
          ? { ...intent, disposition: preview ? "blocked" : "refused", outcomeCode: reason }
          : {
              ...intent,
              disposition: "pending",
              dispatchId: `${intent.effectId}:dispatch`,
              eventId,
            },
      );
      const identity = {
        intent,
        turnId: c.messageId,
        sessionId: c.sessionId,
        installationId: "internal",
        dispatchId: `${intent.effectId}:dispatch`,
        eventId,
        policy: turnPolicy,
        presentedArgumentsHash: intent.argumentsHash,
      };
      await client.query(
        `INSERT INTO clockgrove.mcp_read_admissions(tenant_id,world_id,timeline_id,effect_id,turn_id,installation_id,identity,reserved_time_ms,reserved_output_bytes,admitted)
        VALUES($1,$2,$3,$4,$5,'internal',$6::jsonb,$7,$8,$9)`,
        [
          ...scoped(intent),
          turnId,
          JSON.stringify(identity),
          time,
          MCP_READ_LIMITS.outputBytes,
          reason === null,
        ],
      );
      if (!reason)
        await client.query(
          `UPDATE clockgrove.mcp_read_turn_budgets SET calls=calls+1,reserved_time_ms=reserved_time_ms+$5,reserved_output_bytes=reserved_output_bytes+$6
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND turn_id=$4`,
          [
            c.scope.tenantId,
            c.scope.worldId,
            c.scope.timelineId,
            turnId,
            time,
            MCP_READ_LIMITS.outputBytes,
          ],
        );
    });
  }
  async function publish(client: PostgreSqlClient, c: Context) {
    await sweepDispatches(
      {
        authorization: authorization(c),
        channel: "external-effects",
        limit: 16,
        leaseOwner: `research:${crypto.randomUUID()}`,
        leaseMs: 300_000,
        maxAttempts: 4,
        retryAfterMs: 1_000,
      },
      { store: new PostgreSqlDispatchStore(client), publisher: { publish: configuration.publish } },
    );
  }
  async function recorded(
    client: PostgreSqlClient,
    c: Context,
    intent: EffectIntentMetadata,
    call: TurnToolCall,
  ): Promise<TurnToolCall | undefined> {
    const result = await new PostgreSqlEffects(client).reconcile(intent);
    if (!result || result.disposition === "pending" || result.disposition === "started")
      return undefined;
    let text = result.outcomeCode ?? "tool_failed";
    if (result.resultArtifactId !== null) {
      const evidence = sanitizeMcpReadEvidence(await get(client, c, result.resultArtifactId));
      if (evidence.trust !== "untrusted_evidence" || !Array.isArray(evidence.content))
        throw new Error("Research result unavailable");
      text = JSON.stringify(evidence);
    }
    const times = await client.query(
      `SELECT extract(epoch FROM (a.started_at-i.created_at))*1000 AS latency FROM clockgrove.effect_intents i LEFT JOIN clockgrove.effect_attempts a USING(tenant_id,world_id,timeline_id,effect_id)
      WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.timeline_id=$3 AND i.effect_id=$4`,
      scoped(intent),
    );
    return {
      ...call,
      status: result.disposition === "blocked" ? "simulated" : result.disposition,
      code: result.outcomeCode,
      text,
      resultArtifactId: result.resultArtifactId,
      grantId: intent.grantId,
      queueLatencyMs:
        (times.rows[0] as { latency: unknown }).latency === null
          ? null
          : Number((times.rows[0] as { latency: unknown }).latency),
      costMicrousd: result.costMicrousd,
    };
  }
  async function executeTool(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    proposal: StoredCommandProposal,
    call: TurnToolCall,
  ) {
    try {
      return await configuration.withClient(async (client) => {
        const c = await context(client, {
          scope: fiber.scope,
          actorId: fiber.actorId,
          sessionId: fiber.sessionId,
          messageId: fiber.messageId,
          principalId: participant.principalId,
          personaId: participant.personaId,
        });
        if (!c)
          return {
            ...call,
            status: "refused" as const,
            code: "context_revoked",
            text: "Tool refused: context_revoked",
          };
        let intent = await intentOf(client, fiber.scope, call.effectId);
        if (!intent) {
          const resolved = await resolve(client, c, proposal);
          let reason: string | null = resolved.decision.accepted ? null : resolved.decision.code;
          let input: unknown = resolved.decision.accepted
            ? resolved.decision.input
            : proposal.input;
          let hash: string;
          try {
            hash = mcpReadArgumentsHash(input);
          } catch {
            input = {};
            hash = mcpReadArgumentsHash({ invalidArguments: true });
            reason = "invalid_input";
          }
          intent = {
            ...fiber.scope,
            effectId: call.effectId,
            idempotencyKey: call.effectId,
            actorId: fiber.actorId,
            principalId: participant.principalId,
            runId: fiber.runId,
            callId: call.callId,
            capabilityId: proposal.capability,
            grantId:
              resolved.binding?.bindingId ??
              resolved.definition?.requiredRuntimeGrant ??
              "not_granted",
            policyVersion: "research-v1",
            argumentsHash: hash,
            argumentsArtifactId: `${call.effectId}:arguments`,
            reservedMicrousd: internal(proposal.capability) ? 0 : toolReserve,
          };
          await put(client, c, intent.argumentsArtifactId!, input);
          const eventId = await event(client, c, intent, proposal);
          if (reason)
            await new PostgreSqlEffects(client).reserve({
              ...intent,
              disposition: "refused",
              outcomeCode: reason,
            });
          else if (internal(proposal.capability)) {
            await reserveInternal(client, c, intent, eventId);
          } else
            await new PostgreSqlMcpReadAdmission(client, (admitted) =>
              new SafeMcpHttpClient(configuration.network).validate(admitted.endpoint),
            ).reserve({
              intent,
              turnId: fiber.messageId,
              sessionId: fiber.sessionId,
              installationId: resolved.definition?.remoteMcp?.installationId ?? "unavailable",
              arguments: input,
              dispatchId: `${call.effectId}:dispatch`,
              eventId,
              policy: {
                ...MCP_READ_TURN_DEFAULTS,
                maxCalls: policy.maxCalls,
                maxModelSteps: policy.maxModelSteps,
                maxCostMicrousd: policy.maxCostMicrousd,
              },
            });
        } else if (
          intent.argumentsHash !== presentedHash(proposal.input) ||
          intent.capabilityId !== proposal.capability ||
          intent.principalId !== participant.principalId ||
          intent.actorId !== fiber.actorId
        ) {
          const originalIntent = intent;
          await withClientTransaction(client, {}, () =>
            client.query(
              `INSERT INTO clockgrove.mcp_read_retry_refusals
            (tenant_id,world_id,timeline_id,effect_id,retry_hash,presented_arguments_hash,outcome_code)
            VALUES($1,$2,$3,$4,$5,$6,'arguments_changed') ON CONFLICT DO NOTHING`,
              [
                ...scoped(originalIntent),
                mcpReadArgumentsHash({
                  callId: call.callId,
                  capability: proposal.capability,
                  argumentsHash: presentedHash(proposal.input),
                }),
                presentedHash(proposal.input),
              ],
            ),
          );
          return {
            ...call,
            status: "refused" as const,
            code: "arguments_changed",
            text: "Tool refused: arguments_changed",
          };
        }
        const completed = await recorded(client, c, intent, call);
        if (completed) return completed;
        await publish(client, c);
        return undefined;
      });
    } catch {
      throw new Error("Research unavailable");
    }
  }

  async function waitForToolStart(
    participant: ConversationParticipant,
    fiber: TurnFiber,
    call: TurnToolCall,
  ): Promise<boolean> {
    try {
      if (participant.tenantId !== fiber.scope.tenantId) return false;
      // Reuse the existing recovery window and one-second publication-recovery cadence.
      const deadline = Date.now() + ATTEMPT_RECONCILIATION_MS;
      while (Date.now() < deadline) {
        const progress = await configuration.withClient(async (client) => {
          const found = await client.query(
            `SELECT i.disposition,a.attempt_id FROM clockgrove.effect_intents i
              JOIN clockgrove.agent_runs r ON r.tenant_id=i.tenant_id AND r.run_id=i.run_id
              JOIN clockgrove.conversation_turn_fibers f ON f.tenant_id=r.tenant_id
                AND f.session_id=r.session_id AND f.message_id=r.input_message_id
              LEFT JOIN clockgrove.effect_attempts a ON a.tenant_id=i.tenant_id
                AND a.world_id=i.world_id AND a.timeline_id=i.timeline_id AND a.effect_id=i.effect_id
              WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.timeline_id=$3 AND i.space_id=$4
                AND i.effect_id=$5 AND i.call_id=$6 AND i.actor_id=$7 AND i.principal_id=$8
                AND r.session_id=$9 AND r.input_message_id=$10 AND f.principal_id=$8 AND f.persona_id=$11
                AND f.actor_id=$7 AND f.world_id=$2 AND f.timeline_id=$3
                AND r.actor_id=$7 AND r.principal_id=$8 AND r.world_id=$2 AND r.timeline_id=$3 AND r.space_id=$4`,
            [
              fiber.scope.tenantId,
              fiber.scope.worldId,
              fiber.scope.timelineId,
              fiber.scope.spaceId,
              call.effectId,
              call.callId,
              fiber.actorId,
              participant.principalId,
              fiber.sessionId,
              fiber.messageId,
              participant.personaId,
            ],
          );
          return found.rows[0] as { disposition: string; attempt_id: string | null } | undefined;
        });
        if (!progress) return false;
        if (progress.attempt_id !== null) return true;
        if (progress.disposition !== "pending") return false;
        // The connection has closed before waiting; this observes progress and never republishes.
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      return false;
    } catch {
      throw new Error("Research progress unavailable");
    }
  }

  async function failUnsent(
    client: PostgreSqlClient,
    intent: EffectIntentMetadata,
    outcomeCode = "queue_failed",
  ) {
    const effects = new PostgreSqlEffects(client);
    const existing = await effects.read(intent);
    if (existing?.disposition !== "pending") return;
    const attemptId = crypto.randomUUID();
    if ((await effects.claim(intent, attemptId)).claimed)
      await effects.complete(intent, attemptId, {
        disposition: "failed",
        outcomeCode,
        resultArtifactId: null,
        costMicrousd: 0,
      });
  }
  async function reconcileStale(
    client: PostgreSqlClient,
    intent: EffectIntentMetadata,
  ): Promise<RecordedEffect | null> {
    const effects = new PostgreSqlEffects(client);
    const existing = await effects.reconcile(intent);
    if (existing?.disposition !== "started") return existing;
    const stale = await client.query(
      `SELECT 1 FROM clockgrove.effect_attempts WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4
      AND disposition='started' AND started_at<=statement_timestamp()-$5::integer*interval '1 millisecond'`,
      [...scoped(intent), ATTEMPT_RECONCILIATION_MS],
    );
    if (stale.rows.length === 0 || !existing.attemptId) return existing;
    const c = await target(client, intent);
    let completion = {
      disposition: "uncertain" as "succeeded" | "failed" | "uncertain",
      outcomeCode: "tool_uncertain",
      resultArtifactId: null as string | null,
      costMicrousd: null,
    };
    if (c) {
      try {
        const id = `${intent.effectId}:result`;
        const evidence = sanitizeMcpReadEvidence(await get(client, c, id));
        if (
          evidence.trust === "untrusted_evidence" &&
          ["ok", "tool_error"].includes(evidence.status)
        )
          completion = {
            ...completion,
            disposition: evidence.status === "ok" ? "succeeded" : "failed",
            outcomeCode: evidence.status === "ok" ? "ok" : "tool_error",
            resultArtifactId: id,
          };
      } catch {
        /* A result not durably sealed cannot establish success. */
      }
    }
    try {
      return await effects.complete(intent, existing.attemptId, completion);
    } catch {
      return effects.reconcile(intent);
    }
  }
  const consumer = externalEffectsConsumer({
    effects: {
      resolveDispatch: (message) =>
        configuration.withClient((client) =>
          new PostgreSqlEffects(client).resolveDispatch(message),
        ),
      claim: (intent, id) =>
        configuration.withClient((client) => new PostgreSqlEffects(client).claim(intent, id)),
      complete: (intent, id, result) =>
        configuration.withClient((client) =>
          new PostgreSqlEffects(client).complete(intent, id, result),
        ),
      reconcile: (address) =>
        configuration.withClient(async (client) => {
          const found = await client.query(
            `SELECT ${metadataColumns} FROM clockgrove.effect_intents WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4`,
            [address.tenantId, address.worldId, address.timelineId, address.effectId],
          );
          const intent = found.rows[0] as EffectIntentMetadata | undefined;
          return intent ? reconcileStale(client, intent) : null;
        }),
    },
    admit: (intent) =>
      configuration.withClient(async (client) => {
        const c = await target(client, intent);
        if (!c || !intent.argumentsArtifactId) return null;
        const args = await get(client, c, intent.argumentsArtifactId);
        if (internal(intent.capabilityId)) {
          if (await killed(client, c)) return null;
          const decision = CAPABILITY_REGISTRY.grantsFor(c.grants).authorize({
            capability: intent.capabilityId,
            input: args,
          });
          return decision.accepted
            ? {
                admittedReadOnly: true,
                endpoint: `https://clockgrove.invalid/${intent.capabilityId}`,
                toolName: intent.capabilityId,
                arguments: decision.input as AdmittedMcpRead["arguments"],
              }
            : null;
        }
        return new PostgreSqlMcpReadAdmission(client).admit(intent, args);
      }),
    adapter: {
      execute: async (request, intent) => {
        if (!internal(intent.capabilityId)) return configuration.adapter.execute(request, intent);
        return configuration.withClient(async (client) => {
          const c = await target(client, intent);
          if (!c || !configuration.internalRead) throw new Error("Internal tool unavailable");
          return configuration.internalRead(c, intent.capabilityId, request.arguments);
        });
      },
    },
    persistResult: (intent, evidence) =>
      configuration.withClient(async (client) => {
        const c = await target(client, intent);
        if (!c) throw new Error("Research context unavailable");
        const id = `${intent.effectId}:result`;
        await put(client, c, id, sanitizeMcpReadEvidence(evidence));
        return id;
      }),
    attemptId: () => crypto.randomUUID(),
    knownCost: (intent) => (internal(intent.capabilityId) ? 0 : null),
    completed: (intent) =>
      configuration.withClient(async (client) => {
        const c = await target(client, intent);
        if (c) await configuration.wake(c);
      }),
  });
  async function sweep() {
    return configuration.withClient(async (client) => {
      const due = await client.query(
        `SELECT ${metadataColumns} FROM clockgrove.effect_intents i WHERE disposition IN ('pending','started') OR EXISTS (
          SELECT 1 FROM clockgrove.agent_runs r JOIN clockgrove.conversation_turn_fibers f ON f.tenant_id=r.tenant_id
            AND f.session_id=r.session_id AND f.message_id=r.input_message_id
          JOIN clockgrove.conversation_sessions s ON s.tenant_id=f.tenant_id AND s.session_id=f.session_id AND s.state='active'
          JOIN clockgrove.world_memberships m ON m.tenant_id=f.tenant_id AND m.world_id=f.world_id
            AND m.timeline_id=f.timeline_id AND m.space_id=s.space_id AND m.principal_id=f.principal_id AND m.persona_id=f.persona_id
            AND m.revoked_at IS NULL AND m.committed_at<=statement_timestamp() AND m.privacy_ceiling->'allowedCategories' ? 'conversation'
          WHERE r.tenant_id=i.tenant_id AND r.run_id=i.run_id AND f.phase='tool_waiting'
        ) ORDER BY created_at LIMIT 1000`,
      );
      for (const value of due.rows) {
        const intent = value as EffectIntentMetadata;
        const dispatch = await client.query(
          `SELECT 1 FROM clockgrove.event_dispatches WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3
          AND channel='external-effects' AND payload=jsonb_build_object('effectId',$4::text) AND (status='failed' OR dead_lettered_at IS NOT NULL)`,
          scoped(intent),
        );
        if (dispatch.rows.length) await failUnsent(client, intent);
        const result = await reconcileStale(client, intent);
        const c = await target(client, intent);
        if (!c) {
          if (result?.disposition === "pending")
            await failUnsent(client, intent, "context_revoked");
          continue;
        }
        if (result?.disposition === "pending") await publish(client, c);
        else if (result?.disposition !== "started") await configuration.wake(c);
      }
    });
  }
  async function deadLetter(
    message: QueueEnvelope<unknown>,
    failureClass: "malformed" | "inconsistent" | "transient" | "internal",
  ) {
    return configuration.withClient(async (client) => {
      const intent = await new PostgreSqlEffects(client).resolveDispatch(message);
      if (!intent) return;
      await withClientTransaction(client, {}, () =>
        client.query(
          `UPDATE clockgrove.event_dispatches SET dead_letter_class=$5,dead_lettered_at=statement_timestamp()
        WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND dispatch_id=$4 AND channel='external-effects'`,
          [intent.tenantId, intent.worldId, intent.timelineId, message.messageId, failureClass],
        ),
      );
      await failUnsent(client, intent);
      await reconcileStale(client, intent);
      const c = await target(client, intent);
      if (c) await configuration.wake(c);
    });
  }
  return { policy, executeTool, waitForToolStart, consumer, sweep, deadLetter };
}
