import {
  type ArtifactStore,
  mcpReadArgumentsHash,
  type RuntimeAuthorizationContext,
} from "@clockgrove/application";
import { type BrowserScope, decodeOpaqueId } from "@clockgrove/contracts";
import {
  type EffectApprovalAddress,
  type EffectResolutionRequest,
  type PostgreSqlClient,
  PostgreSqlEffectApprovals,
  PostgreSqlEffectResolutions,
  type RecordedEffectApproval,
  withClientTransaction,
} from "@clockgrove/persistence";

export type ApprovalCallBinding = Pick<
  RecordedEffectApproval,
  | "tenantId"
  | "worldId"
  | "timelineId"
  | "spaceId"
  | "approvalId"
  | "effectId"
  | "principalId"
  | "approverPrincipalId"
  | "argumentsHash"
  | "effectHash"
  | "argumentsArtifactId"
>;

export interface EffectControlsConfiguration {
  /** Server authentication only: this port must never be supplied by a model or tool result. */
  readonly authenticate: () => Promise<RuntimeAuthorizationContext | null>;
  /** A dedicated privileged client per operation; never a shared runtime connection. */
  readonly withClient: <T>(operation: (client: PostgreSqlClient) => Promise<T>) => Promise<T>;
  readonly artifacts: (client: PostgreSqlClient) => ArtifactStore;
  /** Reload exact capability, pin, binding and grants from the immutable proposed call.
   * A session result must name that call's session; an operator result needs operator authority.
   * Runs inside the control transaction: use transaction-aware readers, never start or commit one.
   * This checks existing authority and cannot create a capability grant. */
  readonly admitCall: (
    client: PostgreSqlClient,
    authorization: RuntimeAuthorizationContext,
    approval: ApprovalCallBinding,
  ) => Promise<{ readonly sessionId: string } | { readonly operator: true } | null>;
}
export interface ApprovalControlTarget {
  readonly scope: BrowserScope;
  readonly approvalId: string;
}
export interface UncertaintyControlTarget {
  readonly scope: BrowserScope;
  readonly effectId: string;
}
const unavailable = () => new Error("Effect control unavailable");
const scopeValues = (scope: BrowserScope) => [
  scope.tenantId,
  scope.worldId,
  scope.timelineId,
  scope.spaceId,
];

/** Human-only controls; no control method is registered as an actor tool. */
export function composeEffectControls(configuration: EffectControlsConfiguration) {
  async function identity(scope: BrowserScope) {
    const authorization = structuredClone(
      await configuration.authenticate().catch(() => {
        throw unavailable();
      }),
    );
    if (
      !authorization ||
      authorization.tenantId !== scope.tenantId ||
      !authorization.privacyCeiling.allowedCategories.includes("conversation")
    )
      throw unavailable();
    return authorization;
  }
  async function authorize(
    client: PostgreSqlClient,
    authorization: RuntimeAuthorizationContext,
    scope: BrowserScope,
    operator: boolean,
  ) {
    const found = await client.query(
      `SELECT m.grants,m.persona_id AS "personaId",m.privacy_ceiling AS "privacyCeiling"
       FROM clockgrove.world_memberships m
       WHERE m.tenant_id=$1 AND m.world_id=$2 AND m.timeline_id=$3 AND m.space_id=$4
         AND m.principal_id=$5 AND m.revoked_at IS NULL AND m.committed_at<=clock_timestamp()
       FOR SHARE OF m`,
      [...scopeValues(scope), authorization.principalId],
    );
    const membership = found.rows[0] as
      | { grants: string[]; personaId: string; privacyCeiling: { allowedCategories: string[] } }
      | undefined;
    if (
      !membership?.privacyCeiling.allowedCategories.includes("conversation") ||
      (operator && !membership.grants.includes("runtime:world-operate"))
    )
      throw unavailable();
    return membership;
  }
  /** Ledger/artifact adapters own transactions. Recheck and lock current authority inside each
   * adapter's BEGIN, so a membership revocation cannot commit between admission and mutation. */
  function guarded(client: PostgreSqlClient, check: () => Promise<void>): PostgreSqlClient {
    return {
      async query(text, values) {
        const result = await client.query(text, values);
        if (text === "BEGIN") await check();
        return result;
      },
    };
  }
  async function approvalClient<T>(
    target: ApprovalControlTarget,
    operation: (
      client: PostgreSqlClient,
      authorization: RuntimeAuthorizationContext,
      approval: RecordedEffectApproval,
    ) => Promise<T>,
  ): Promise<T> {
    target = structuredClone(target);
    const authorization = await identity(target.scope);
    return configuration
      .withClient(async (client) => {
        const address: EffectApprovalAddress = { ...target.scope, approvalId: target.approvalId };
        let approval: RecordedEffectApproval | null = null;
        const checked = guarded(client, async () => {
          const membership = await authorize(client, authorization, target.scope, false);
          const existing = await client.query(
            `SELECT 1 FROM clockgrove.effect_approvals WHERE tenant_id=$1 AND world_id=$2
           AND timeline_id=$3 AND space_id=$4 AND approval_id=$5 AND approver_principal_id=$6`,
            [...scopeValues(target.scope), target.approvalId, authorization.principalId],
          );
          if (!existing.rows.length) throw unavailable();
          const rows = await client.query(
            `SELECT principal_id AS "principalId",effect_id AS "effectId",arguments_hash AS "argumentsHash",
            effect_hash AS "effectHash",arguments_artifact_id AS "argumentsArtifactId"
           FROM clockgrove.effect_approvals WHERE tenant_id=$1 AND world_id=$2
             AND timeline_id=$3 AND approval_id=$4`,
            [
              target.scope.tenantId,
              target.scope.worldId,
              target.scope.timelineId,
              target.approvalId,
            ],
          );
          const record = rows.rows[0] as Pick<
            RecordedEffectApproval,
            "principalId" | "effectId" | "argumentsHash" | "effectHash" | "argumentsArtifactId"
          >;
          // Call admission needs only immutable binding fields, not mutable approval state.
          const route = await configuration.admitCall(client, authorization, {
            ...address,
            ...target.scope,
            ...record,
            approverPrincipalId: authorization.principalId,
          });
          if (!route) throw unavailable();
          if ("operator" in route) {
            if (!membership.grants.includes("runtime:world-operate")) throw unavailable();
          } else {
            if (record.principalId !== authorization.principalId) throw unavailable();
            const session = await client.query(
              `SELECT 1 FROM clockgrove.conversation_sessions s
             JOIN clockgrove.conversation_participants p USING(tenant_id,session_id)
             WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.timeline_id=$3 AND s.space_id=$4
               AND s.session_id=$5 AND s.state='active' AND p.principal_id=$6 AND p.persona_id=$7
             FOR SHARE OF s,p`,
              [
                ...scopeValues(target.scope),
                route.sessionId,
                authorization.principalId,
                membership.personaId,
              ],
            );
            if (!session.rows.length) throw unavailable();
          }
        });
        approval = await new PostgreSqlEffectApprovals(checked).read(address);
        if (!approval) throw unavailable();
        return operation(checked, authorization, approval);
      })
      .catch(() => {
        throw unavailable();
      });
  }
  async function operatorClient<T>(
    scope: BrowserScope,
    operation: (client: PostgreSqlClient, authorization: RuntimeAuthorizationContext) => Promise<T>,
  ) {
    scope = structuredClone(scope);
    const authorization = await identity(scope);
    return configuration
      .withClient((client) =>
        operation(
          guarded(client, async () => {
            await authorize(client, authorization, scope, true);
          }),
          authorization,
        ),
      )
      .catch(() => {
        throw unavailable();
      });
  }
  async function verifiedArguments(
    client: PostgreSqlClient,
    authorization: RuntimeAuthorizationContext,
    approval: RecordedEffectApproval,
    scope: BrowserScope,
  ): Promise<unknown> {
    if (!approval.argumentsArtifactId) throw unavailable();
    const partition = await withClientTransaction(client, {}, () =>
      client.query(
        `SELECT partition_id FROM clockgrove.timeline_partitions WHERE tenant_id=$1 AND world_id=$2
           AND timeline_id=$3 AND space_id=$4`,
        scopeValues(scope),
      ),
    );
    const partitionId = (partition.rows[0] as { partition_id: string } | undefined)?.partition_id;
    if (!partitionId) throw unavailable();
    const stored = await configuration.artifacts(client).get(authorization, {
      ...scope,
      partitionId: decodeOpaqueId(partitionId, "PartitionId"),
      artifactId: decodeOpaqueId(approval.argumentsArtifactId, "ArtifactId"),
    });
    if (stored.ref.privacyClass !== "conversation" || stored.ref.encryption !== "aes-256-gcm-v1")
      throw unavailable();
    const argumentsValue: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
    );
    if (mcpReadArgumentsHash(argumentsValue) !== approval.argumentsHash) throw unavailable();
    return argumentsValue;
  }
  async function operationName(client: PostgreSqlClient, approval: RecordedEffectApproval) {
    const result = await withClientTransaction(client, {}, () =>
      client.query(
        `SELECT payload->>'capabilityId' AS capability FROM clockgrove.events
       WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND space_id=$4
         AND event_id=$5 AND payload->>'argumentsHash'=$6`,
        [
          approval.tenantId,
          approval.worldId,
          approval.timelineId,
          approval.spaceId,
          `trusted:research:${approval.effectId}:event`,
          approval.argumentsHash,
        ],
      ),
    );
    return (result.rows[0] as { capability: string } | undefined)?.capability;
  }
  return {
    async approvals(scope: BrowserScope, sessionId?: string) {
      scope = structuredClone(scope);
      const authorization = await identity(scope);
      const ids = await configuration.withClient((client) =>
        withClientTransaction(client, {}, async () => {
          await authorize(client, authorization, scope, false);
          return client.query(
            `SELECT approval_id AS "approvalId" FROM clockgrove.effect_approvals
             WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND space_id=$4
               AND approver_principal_id=$5 AND state IN ('pending','approved') ORDER BY created_at DESC LIMIT 100`,
            [...scopeValues(scope), authorization.principalId],
          );
        }),
      );
      const visible = [];
      for (const row of ids.rows as { approvalId: string }[]) {
        try {
          const preview = await approvalClient(
            { scope, approvalId: row.approvalId },
            async (client, who, approval) => {
              const route = await withClientTransaction(client, {}, () =>
                configuration.admitCall(client, who, approval),
              );
              if (
                !route ||
                (sessionId !== undefined &&
                  (!("sessionId" in route) || route.sessionId !== sessionId))
              )
                return null;
              return {
                approval,
                capability: await operationName(client, approval),
                arguments: await verifiedArguments(client, who, approval, scope),
              };
            },
          );
          if (preview) visible.push(preview);
        } catch {
          // A revoked grant must not reveal a formerly authorized argument preview.
        }
      }
      return visible;
    },
    approval(target: ApprovalControlTarget) {
      target = structuredClone(target);
      return approvalClient(target, async (client, authorization, approval) => {
        return {
          approval,
          capability: await operationName(client, approval),
          arguments: await verifiedArguments(client, authorization, approval, target.scope),
        };
      });
    },
    decide(target: ApprovalControlTarget, decision: "approved" | "denied") {
      target = structuredClone(target);
      return approvalClient(target, async (client, authorization, approval) => {
        if (decision === "approved")
          await verifiedArguments(client, authorization, approval, target.scope);
        return new PostgreSqlEffectApprovals(client).decide(
          approval,
          authorization.principalId,
          decision,
        );
      });
    },
    revoke(target: ApprovalControlTarget) {
      return approvalClient(target, (client, authorization, approval) =>
        new PostgreSqlEffectApprovals(client).revoke(approval, authorization.principalId),
      );
    },
    // Engineering page bound: a control read returns at most 100 records, without remote I/O.
    async uncertain(scope: BrowserScope, sessionId?: string) {
      scope = structuredClone(scope);
      const read = (client: PostgreSqlClient) =>
        client
          .query(
            `SELECT i.effect_id AS "effectId",i.call_id AS "callId",i.principal_id AS "principalId",
          a.attempt_id AS "attemptId",a.outcome_code AS "outcomeCode",a.ended_at::text AS "completedAt",
          EXISTS (SELECT 1 FROM clockgrove.events e WHERE e.tenant_id=i.tenant_id
            AND e.world_id=i.world_id AND e.timeline_id=i.timeline_id AND e.space_id=i.space_id
            AND e.event_id='trusted:research:'||i.effect_id||':event'
            AND e.payload->>'idempotency' IN ('application','provider')) AS "retryAllowed"
         FROM clockgrove.effect_intents i JOIN clockgrove.effect_attempts a
           USING(tenant_id,world_id,timeline_id,effect_id)
         WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.timeline_id=$3 AND i.space_id=$4
           AND i.disposition='uncertain' AND a.disposition='uncertain'
           AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM clockgrove.events e
             WHERE e.tenant_id=i.tenant_id AND e.world_id=i.world_id
               AND e.timeline_id=i.timeline_id AND e.space_id=i.space_id
               AND e.event_id='trusted:research:'||i.effect_id||':event'
               AND e.payload->>'sessionId'=$5))
           AND NOT EXISTS (SELECT 1 FROM clockgrove.effect_resolutions r WHERE r.tenant_id=i.tenant_id
             AND r.world_id=i.world_id AND r.timeline_id=i.timeline_id AND r.effect_id=i.effect_id)
         ORDER BY a.ended_at,i.effect_id LIMIT 100`,
            [...scopeValues(scope), sessionId ?? null],
          )
          .then((result) => result.rows);
      if (sessionId === undefined)
        return operatorClient(scope, (client) =>
          withClientTransaction(client, {}, () => read(client)),
        );
      const authorization = await identity(scope);
      return configuration.withClient((client) =>
        withClientTransaction(client, {}, async () => {
          const membership = await authorize(client, authorization, scope, false);
          if (
            !membership.grants.some(
              (grant) => grant === "runtime:world-observe" || grant === "runtime:world-operate",
            )
          )
            throw unavailable();
          const session = await client.query(
            `SELECT 1 FROM clockgrove.conversation_sessions s
             JOIN clockgrove.conversation_participants p USING(tenant_id,session_id)
             WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.timeline_id=$3 AND s.space_id=$4
               AND s.session_id=$5 AND p.principal_id=$6 AND p.persona_id=$7
             FOR SHARE OF s,p`,
            [...scopeValues(scope), sessionId, authorization.principalId, membership.personaId],
          );
          if (!session.rows.length) throw unavailable();
          return read(client);
        }),
      );
    },
    resolve(
      target: UncertaintyControlTarget,
      attemptId: string,
      disposition: EffectResolutionRequest["disposition"],
    ) {
      target = structuredClone(target);
      return operatorClient(target.scope, async (client, authorization) => {
        const found = await withClientTransaction(client, {}, () =>
          client.query(
            `SELECT 1 FROM clockgrove.effect_intents WHERE tenant_id=$1 AND world_id=$2
           AND timeline_id=$3 AND space_id=$4 AND effect_id=$5`,
            [...scopeValues(target.scope), target.effectId],
          ),
        );
        if (!found.rows.length) throw unavailable();
        return new PostgreSqlEffectResolutions(client).resolve({
          ...target.scope,
          effectId: target.effectId,
          attemptId,
          disposition,
          resolvedBy: authorization.principalId,
        });
      });
    },
  };
}
