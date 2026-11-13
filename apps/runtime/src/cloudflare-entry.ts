import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  Journal,
  JournalOutcomeReader,
  JournalPostCommitNotifier,
  RuntimeAuthorizationContext,
  RuntimeAuthorizationDenial,
  RuntimeMetrics,
} from "@clockgrove/application";
import {
  type AdmittedMcpExecution,
  AuthenticationRefusedError,
  type CatchUpWorkflowEnvelope,
  DispatchHintNotifier,
  decodeCatchUpWorkflowEnvelope,
  decodeLifecycleWorkflowEnvelope,
  JOURNAL_EVENT_REGISTRY,
  JournalRangeReader,
  type LifecycleWorkflowEnvelope,
  type McpReadEvidence,
  McpReadFailure,
  McpRefusal,
  maintainPartitionSnapshot,
  NO_METRICS,
  NO_PRIVACY_CEILING,
  type ProvisionWorldRequest,
  type RuntimeLogger,
  releaseRuntimeLogger,
  safeMcpNetworkRefusal,
  sweepDispatches,
  WorldMcpAdmission,
} from "@clockgrove/application";
import {
  type BrowserScope,
  type ContextInspectRequest,
  type DocumentChangeRequest,
  type DocumentReadRequest,
  decodeOpaqueId,
  decodeQueueEnvelope,
  type PrincipalId,
  type QueueEnvelope,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext as TrustedContext } from "@clockgrove/contracts/trusted";
import {
  activationEventSubscribers,
  type EffectIntentMetadata,
  PostgreSqlActivations,
  PostgreSqlActorProcesses,
  PostgreSqlArtifactStore,
  PostgreSqlCatchUpWorkflowStore,
  type PostgreSqlClient,
  PostgreSqlConversationStore,
  PostgreSqlDispatchStore,
  PostgreSqlGovernedDelivery,
  PostgreSqlJournal,
  PostgreSqlJournalRangeSource,
  PostgreSqlLifecycleWorkflowStore,
  PostgreSqlManagementReaders,
  PostgreSqlMcpReadAdmission,
  PostgreSqlMcpWriteAdmission,
  PostgreSqlSnapshotStore,
  PostgreSqlWorldAuthorizationReader,
  PostgreSqlWorldMcpAdmission,
  PostgreSqlWorldOwnerReader,
  PostgreSqlWorldProvisioningStore,
  type R2BucketLike,
  WebCryptoKeyring,
  withClientTransaction,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import type { ActivationOwners } from "./activation-routes.js";
import { type ActorScene, describeScene } from "./actor-model.js";
import {
  composeReferenceAuthentication,
  composeWorldMcpAuthentication,
  type ReferenceAuthenticationConfiguration,
  type WorldMcpAuthentication,
  type WorldMcpAuthenticationConfiguration,
} from "./better-auth-adapter.js";
import {
  type CanonicalRuntimeStateSource,
  PostgreSqlCanonicalRuntimeStateSource,
} from "./canonical-state.js";
import type { ActorAgentDO, SpaceDO, WorldDO } from "./cloudflare-adapters.js";
import {
  consoleRuntimeLogger,
  logActivationHintFailure,
  logPartitionSnapshotFailure,
  logPublicationFailure,
  logQueueDeadLetter,
  logQueueDeliveryFailure,
  logWorkflowReconcileFailure,
  logWorldReactionSweepFailure,
} from "./cloudflare-logs.js";
import { type AnalyticsEngineDataset, analyticsEngineMetrics } from "./cloudflare-metrics.js";
import { PostgreSqlCognitionInspector } from "./cognition.js";
import type { ConversationStores, TurnOwners } from "./conversations.js";
import { handleEffectEndpoint, isEffectRoute } from "./effect-endpoint.js";
import {
  HyperdrivePostgreSqlClient,
  withHyperdrivePostgreSqlClient,
} from "./hyperdrive-postgres.js";
import {
  PostgreSqlCausalInspector,
  PostgreSqlRuntimeOperator,
  PostgreSqlRuntimeStateInspector,
  type RuntimeStatePorts,
} from "./inspector.js";
import { composeMcpOperator } from "./mcp-composition.js";
import {
  PostgreSqlEntitySelectionReader,
  PostgreSqlLivingSceneReader,
  PostgreSqlViewedSpaceReader,
  PostgreSqlWorldStatusReader,
  readWorldDirectory,
  readWorldReadiness,
} from "./observation.js";
import type { OwnerActivation } from "./owner-activation.js";
import type { SpaceDO as PortableSpaceDO } from "./owners.js";
import {
  QueueMessageRefusedError,
  type RuntimeQueueConsumers,
  refusingRuntimeQueueConsumers,
  TypedQueueConsumer,
} from "./queues.js";
import {
  composeResearch,
  type ResearchConfiguration,
  type ResearchResumeTarget,
} from "./research.js";
import { runtimeRouteName, stableWorkflowInstanceId } from "./routing.js";
import { PostgreSqlRunInspector } from "./runs.js";
import { SCENE_JOIN_HEADER, signSceneJoin } from "./scene-connections.js";
import {
  type RuntimeAuthenticationDependencies,
  TrustedRuntimeRequestAuthenticator,
} from "./trusted-composition.js";
import type { RuntimeScope } from "./types.js";
import { PostgreSqlClientViewInspector } from "./view-trace.js";
import { type RuntimeOwnerBindings, RuntimeWorker } from "./worker.js";
import type { WorkflowShellInput } from "./workflows.js";
import { callWorldOwner, PostgreSqlCommandOwner, unwrapWorldCommandRpc } from "./world-commands.js";
import { handleWorldMcpEndpoint, isWorldMcpRoute } from "./world-mcp-endpoint.js";

/**
 * One invocation owns the connection for its reads and journal work, then closes it. Inside an owner
 * activation, the connection's statements count toward it.
 */
export function withCommandOwner<T>(
  connectionString: string,
  operation: (owner: PostgreSqlCommandOwner) => Promise<T>,
  metrics: RuntimeMetrics = NO_METRICS,
  notifier?: JournalPostCommitNotifier,
  activation?: OwnerActivation,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(connectionString, (client) =>
    operation(new PostgreSqlCommandOwner(activation?.counted(client) ?? client, metrics, notifier)),
  );
}

export {
  ActorAgentDO,
  AgentJobWorkflow,
  AuthoringWorkflow,
  ConsolidationWorkflow,
  IngestionWorkflow,
  SpaceDO,
  TransferRecoveryWorkflow,
  WorldCatchUpWorkflow,
  WorldDO,
  WorldPackUpgradeWorkflow,
  WorldProvisioningWorkflow,
  WorldReadinessWorkflow,
} from "./cloudflare-adapters.js";

export interface DurableObjectNamespace<T> {
  idFromName(name: string): { readonly name?: string; toString(): string };
  get(id: ReturnType<DurableObjectNamespace<T>["idFromName"]>): T;
}
export interface QueueBinding {
  send(body: unknown): Promise<void>;
}
export interface WorkflowBinding {
  create(input: { readonly id: string; readonly params: WorkflowShellInput }): Promise<unknown>;
}
export interface LifecycleWorkflowInstance {
  status(): Promise<{
    readonly status: string;
    readonly output?: unknown;
    readonly error?: { readonly name: string; readonly message: string };
  }>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
}
export interface LifecycleWorkflowBinding {
  create(input: {
    readonly id: string;
    readonly params: LifecycleWorkflowEnvelope;
  }): Promise<unknown>;
  createBatch(
    inputs: readonly { readonly id: string; readonly params: LifecycleWorkflowEnvelope }[],
  ): Promise<readonly unknown[]>;
  get(id: string): Promise<LifecycleWorkflowInstance>;
}
export interface CatchUpWorkflowBinding {
  createBatch(
    inputs: readonly { readonly id: string; readonly params: CatchUpWorkflowEnvelope }[],
  ): Promise<readonly unknown[]>;
  get(id: string): Promise<LifecycleWorkflowInstance>;
}

/** Recover accepted canonical work even when native execution history has disappeared or exhausted. */
export async function reconcileWorldCatchUp(
  env: RuntimeEnvironment,
  input: unknown,
  ownerGeneration?: bigint,
) {
  const envelope = decodeCatchUpWorkflowEnvelope(input);
  const canonical = await withLifecycleWorkflowClient(env, (client) =>
    new PostgreSqlCatchUpWorkflowStore(client).read(envelope),
  );
  if (canonical === undefined) return { disposition: "not-needed" } as const;
  const binding = env.WORLD_CATCH_UP_WORKFLOW;
  if (binding === undefined) throw new Error("world catch-up Workflow required");
  let replacement: boolean;
  if (ownerGeneration === undefined) {
    const name = await runtimeRouteName("space", envelope);
    const owner = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
    if (owner.prepareCatchUp === undefined) throw new Error("physical catch-up owner required");
    const prepared = await owner.prepareCatchUp(envelope);
    if (prepared.disposition === "superseded") return { disposition: "not-needed" } as const;
    replacement = prepared.replacement;
  } else {
    replacement = canonical.ownerGeneration !== ownerGeneration;
  }
  const id = await stableWorkflowInstanceId("WorldCatchUpWorkflow", envelope.applicationRunId);
  await binding.createBatch([{ id, params: envelope }]);
  const instance = await binding.get(id);
  const execution = await instance.status();
  // A completed native run with an open canonical operation also needs reconstruction.
  if (replacement || ["errored", "terminated", "complete"].includes(execution.status))
    await instance.restart();
  return { disposition: "scheduled", instanceId: id } as const;
}

/** Same finite page as provisioning; a failing candidate cannot strand its neighbours. */
export async function reconcileOpenWorldCatchUp(env: RuntimeEnvironment) {
  const open = await withLifecycleWorkflowClient(env, (client) =>
    new PostgreSqlCatchUpWorkflowStore(client).openCases(PROVISIONING_RECONCILE_LIMIT),
  );
  const counts = { reconciled: 0, caseFailures: 0 };
  const logger = runtimeLogger(env);
  for (const envelope of open) {
    try {
      await reconcileWorldCatchUp(env, envelope);
      counts.reconciled += 1;
    } catch (error) {
      counts.caseFailures += 1;
      logWorkflowReconcileFailure(
        logger,
        "world_catch_up_reconcile_failed",
        {
          tenantId: envelope.tenantId,
          worldId: envelope.worldId,
          timelineId: envelope.timelineId,
          spaceId: envelope.spaceId,
          runId: envelope.applicationRunId,
        },
        queueFailureClass(error),
      );
    }
  }
  return counts;
}

export interface HyperdriveBinding {
  readonly connectionString: string;
}

/**
 * The Workers R2 binding methods the artifact store uses. R2 checks the `sha256` option against the
 * received bytes and refuses a mismatched put (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions).
 */
export interface R2BucketBinding {
  put(
    key: string,
    value: Uint8Array,
    options: { readonly sha256: string; readonly httpMetadata: { readonly contentType: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Only `put` and `get` reach the store: it can neither list nor delete objects. */
export function workersR2Bucket(binding: R2BucketBinding): R2BucketLike {
  return {
    put: (key, value, options) => binding.put(key, value, options),
    get: (key) => binding.get(key),
  };
}

/**
 * The artifact store over this invocation's connection, spilling to the environment's artifacts
 * bucket. No keyring is bound, so every class but `public_scene` fails closed
 * (`ArtifactKeyUnavailableError`) instead of being stored unencrypted. Artifact sizes, integrity
 * failures and RLS refusals go to `METRICS`.
 */
export function composeArtifactStore(
  env: Pick<RuntimeEnvironment, "ARTIFACTS_BUCKET" | "METRICS">,
  client: PostgreSqlClient,
): PostgreSqlArtifactStore {
  const bucket = env.ARTIFACTS_BUCKET;
  return new PostgreSqlArtifactStore(client, {
    metrics: analyticsEngineMetrics(env.METRICS),
    ...(bucket === undefined ? {} : { bucket: workersR2Bucket(bucket) }),
  });
}

const keyrings = new Map<string, Promise<WebCryptoKeyring>>();

/**
 * Private conversations over this invocation's connection. Their text is stored as `conversation`
 * artifacts sealed under the environment's keyring, imported once per isolate and secret value.
 */
export function composeConversations(
  env: Pick<RuntimeEnvironment, "ARTIFACT_KEYRING" | "ARTIFACTS_BUCKET" | "METRICS" | "HYPERDRIVE">,
  model?: string,
): ConversationStores | undefined {
  const secret = env.ARTIFACT_KEYRING;
  if (secret === undefined) return undefined;
  return async (operation) => {
    let keyring = keyrings.get(secret);
    if (keyring === undefined) {
      keyring = WebCryptoKeyring.fromJson(secret);
      keyrings.set(secret, keyring);
    }
    const loaded = await keyring;
    return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) => {
      const bucket = env.ARTIFACTS_BUCKET;
      const artifacts = new PostgreSqlArtifactStore(client, {
        keyring: loaded,
        metrics: analyticsEngineMetrics(env.METRICS),
        ...(bucket === undefined ? {} : { bucket: workersR2Bucket(bucket) }),
      });
      return operation(new PostgreSqlConversationStore(client, artifacts, undefined, model));
    });
  };
}

/** What the actor perceives: the member's authorized public scene, read over this invocation's connection. */
export function perceiveScene(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  scope: BrowserScope,
  context: TrustedContext,
): Promise<ActorScene> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", async (client) => {
    const { scene, stored } = await new PostgreSqlLivingSceneReader(
      new PostgreSqlWorldOwnerReader(client),
    ).observeCanonical(scope, context);
    return describeScene(scene, stored.document.state);
  });
}

/** `ActorProcess` state over this invocation's connection (migration 0038). */
export function withActorProcesses<T>(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  operation: (processes: PostgreSqlActorProcesses) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
    operation(new PostgreSqlActorProcesses(client)),
  );
}

/** Proactive activation metadata over canonical PostgreSQL, never local owner storage. */
export function withActivations<T>(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  operation: (activations: PostgreSqlActivations) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
    operation(new PostgreSqlActivations(client)),
  );
}

export function withGovernedDelivery<T>(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  operation: (delivery: PostgreSqlGovernedDelivery) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
    operation(new PostgreSqlGovernedDelivery(client)),
  );
}

export function composeActivationOwners(
  env: Pick<RuntimeEnvironment, "ACTOR_AGENT_DO">,
): ActivationOwners {
  const owner = async (scope: BrowserScope, actorId: string) =>
    env.ACTOR_AGENT_DO.get(
      env.ACTOR_AGENT_DO.idFromName(
        await runtimeRouteName("actor-agent", scope, decodeOpaqueId(actorId, "SubjectId")),
      ),
    );
  return {
    moderationReport: async (scope, context, participant, actorId) =>
      (await owner(scope, actorId)).moderationShadowReport(scope, context, participant, actorId),
    triageReport: async (scope, context, participant, actorId) =>
      (await owner(scope, actorId)).wakeTriageReport(scope, context, participant, actorId),
    configure: async (scope, context, participant, actorId, configuration, policy) =>
      (await owner(scope, actorId)).configureActivation(
        scope,
        context,
        participant,
        actorId,
        configuration,
        policy,
      ),
    wake: async (scope, context, participant, actorId, wake) =>
      (await owner(scope, actorId)).wakeActivation(scope, context, participant, actorId, wake),
    inspect: async (scope, context, participant, actorId) =>
      (await owner(scope, actorId)).inspectActivations(scope, context, participant, actorId),
  };
}

/** Talk turns run in the session actor's `ActorAgentDO`, over Workers RPC. */
export function composeTurnOwners(env: Pick<RuntimeEnvironment, "ACTOR_AGENT_DO">): TurnOwners {
  const owner = async (scope: BrowserScope, actorId: string) =>
    env.ACTOR_AGENT_DO.get(
      env.ACTOR_AGENT_DO.idFromName(
        await runtimeRouteName("actor-agent", scope, decodeOpaqueId(actorId, "SubjectId")),
      ),
    );
  return {
    talk: async (actorId, participant, context, request) =>
      (await owner(request.scope, actorId)).talk(
        request.scope,
        context,
        participant,
        actorId,
        request,
      ),
    status: async (actorId, participant, context, request) =>
      (await owner(request.scope, actorId)).turnStatus(
        request.scope,
        context,
        participant,
        actorId,
        request,
      ),
    cancel: async (actorId, participant, context, request) =>
      (await owner(request.scope, actorId)).cancelTurn(
        request.scope,
        context,
        participant,
        actorId,
        request,
      ),
  };
}

/**
 * Run walks and search (0036) under the conversations' keyring: a walk decrypts a protected
 * payload for a reader whose ceiling holds its class. Absent without the keyring, so they fail
 * closed as `inspector_unavailable`.
 */
export function composeRunInspector(
  env: Pick<RuntimeEnvironment, "ARTIFACT_KEYRING" | "ARTIFACTS_BUCKET" | "METRICS" | "HYPERDRIVE">,
): RuntimeOwnerBindings["runs"] {
  const session = artifactSession(env);
  if (session === undefined) return undefined;
  const inspector = <T>(operation: (inspector: PostgreSqlRunInspector) => Promise<T>) =>
    session((client, artifacts) => operation(new PostgreSqlRunInspector(client, artifacts)));
  const deny: PostgreSqlRunInspector["deny"] = (input, principalId, denial) =>
    inspector((runs) => runs.deny(input, principalId, denial));
  return {
    walk: { inspect: (input, context) => inspector((runs) => runs.walk(input, context)), deny },
    search: { inspect: (input, context) => inspector((runs) => runs.search(input, context)), deny },
  };
}

/**
 * Context manifests and governed actor documents (0037) under the same keyring: reassembly reads
 * the session's protected messages. Absent without it, so they fail closed as
 * `inspector_unavailable`.
 */
export function composeCognition(
  env: Pick<RuntimeEnvironment, "ARTIFACT_KEYRING" | "ARTIFACTS_BUCKET" | "METRICS" | "HYPERDRIVE">,
): RuntimeOwnerBindings["cognition"] {
  const session = artifactSession(env);
  if (session === undefined) return undefined;
  const cognition = <T>(operation: (inspector: PostgreSqlCognitionInspector) => Promise<T>) =>
    session((client, artifacts) => operation(new PostgreSqlCognitionInspector(client, artifacts)));
  const port = <I extends { readonly scope: BrowserScope }, O>(
    subject: "context-manifest" | "actor-documents",
    inspect: (
      inspector: PostgreSqlCognitionInspector,
      input: I,
      context: TrustedContext,
    ) => Promise<O>,
  ) => ({
    inspect: (input: I, context: TrustedContext) =>
      cognition((inspector) => inspect(inspector, input, context)),
    deny: (input: I, principalId: PrincipalId, denial: RuntimeAuthorizationDenial | undefined) =>
      cognition((inspector) => inspector.deny(input, subject, principalId, denial)),
  });
  return {
    context: port("context-manifest", (inspector, input: ContextInspectRequest, context) =>
      inspector.inspectContext(input, context),
    ),
    read: port("actor-documents", (inspector, input: DocumentReadRequest, context) =>
      inspector.readDocument(input, context),
    ),
    change: port("actor-documents", (inspector, input: DocumentChangeRequest, context) =>
      inspector.changeDocuments(input, context),
    ),
  };
}

/** One PostgreSQL connection with the artifact store under the conversations' keyring. */
function artifactSession(
  env: Pick<RuntimeEnvironment, "ARTIFACT_KEYRING" | "ARTIFACTS_BUCKET" | "METRICS" | "HYPERDRIVE">,
) {
  const secret = env.ARTIFACT_KEYRING;
  if (secret === undefined) return undefined;
  return async <T>(
    operation: (client: PostgreSqlClient, artifacts: PostgreSqlArtifactStore) => Promise<T>,
  ): Promise<T> => {
    let keyring = keyrings.get(secret);
    if (keyring === undefined) {
      keyring = WebCryptoKeyring.fromJson(secret);
      keyrings.set(secret, keyring);
    }
    const loaded = await keyring;
    return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) => {
      const bucket = env.ARTIFACTS_BUCKET;
      const artifacts = new PostgreSqlArtifactStore(client, {
        keyring: loaded,
        metrics: analyticsEngineMetrics(env.METRICS),
        ...(bucket === undefined ? {} : { bucket: workersR2Bucket(bucket) }),
      });
      return operation(client, artifacts);
    });
  };
}

/** Keep the provider connection in the composition root; orchestration consumes the project port. */
export function withLifecycleWorkflowClient<T>(
  env: RuntimeEnvironment,
  operation: (client: PostgreSqlClient) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", operation);
}

export function withActorCapabilityClient<T>(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  operation: (client: PostgreSqlClient) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", operation);
}

export function withWakeTriageClient<T>(
  env: Pick<RuntimeEnvironment, "HYPERDRIVE">,
  operation: (client: PostgreSqlClient) => Promise<T>,
): Promise<T> {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", operation);
}

/** Trusted Management/CLI composition entry; never exposed by the Runtime HTTP router. */
export async function launchWorldProvisioning(
  env: RuntimeEnvironment,
  request: ProvisionWorldRequest,
  applicationRunId: string,
) {
  const envelope = await withLifecycleWorkflowClient(env, (client) =>
    new PostgreSqlLifecycleWorkflowStore(client).register(request, applicationRunId),
  );
  return reconcileWorldProvisioning(env, envelope);
}

/** Private Management binding; callers have already authorized and pinned this creation. */
export class WorldProvisioningEntrypoint extends WorkerEntrypoint<RuntimeEnvironment> {
  launch(request: ProvisionWorldRequest, applicationRunId: string) {
    return launchWorldProvisioning(this.env, request, applicationRunId);
  }
}

/** Reconstruct execution from the accepted PostgreSQL case, including after provider history loss. */
export async function reconcileWorldProvisioning(env: RuntimeEnvironment, input: unknown) {
  const envelope = decodeLifecycleWorkflowEnvelope(input);
  const canonical = await withLifecycleWorkflowClient(env, (client) =>
    new PostgreSqlLifecycleWorkflowStore(client).status(envelope),
  );
  const runId = envelope.applicationRunId;
  const instanceId = await stableWorkflowInstanceId("WorldProvisioningWorkflow", runId);
  const readinessInstanceId = await stableWorkflowInstanceId("WorldReadinessWorkflow", runId);
  if (canonical.status === "ready" || canonical.status === "failed") {
    return {
      version: 1,
      envelope,
      instanceId,
      readinessInstanceId,
      canonical,
      executionStatus: "not-needed",
    };
  }
  const readiness = canonical.status === "verified";
  const binding = readiness ? env.WORLD_READINESS_WORKFLOW : env.WORLD_PROVISIONING_WORKFLOW;
  const id = readiness ? readinessInstanceId : instanceId;
  // Native createBatch is idempotent for existing IDs. Infrastructure failures propagate intact.
  await binding.createBatch([{ id, params: envelope }]);
  const instance = await binding.get(id);
  const execution = await instance.status();
  if (execution.status === "errored" || execution.status === "terminated") await instance.restart();
  return {
    version: 1,
    envelope,
    instanceId,
    readinessInstanceId,
    canonical,
    executionStatus: (await instance.status()).status,
  };
}

/**
 * Decision: 25 cases per cron run, least recently picked first; cases stopped by a
 * deterministic genesis defect are left to an operator or a code fix. Each reconcile opens one PostgreSQL
 * connection and makes at most five Workflow binding calls, so a run stays well inside the Workers
 * per-invocation subrequest limit (https://developers.cloudflare.com/workers/platform/limits/)
 * next to the world-reactions sweep. A larger backlog drains over later runs.
 */
const PROVISIONING_RECONCILE_LIMIT = 25;

/**
 * Scheduled recovery of open registered births: restarts an instance whose step retries ran out
 * (for example during an outage longer than the retry window). One case's failure is logged by
 * class only and counted; the others still run, and the case is picked up again next cron.
 */
export async function reconcileOpenWorldProvisioning(env: RuntimeEnvironment) {
  const open = await withLifecycleWorkflowClient(env, (client) =>
    new PostgreSqlLifecycleWorkflowStore(client).openCases(PROVISIONING_RECONCILE_LIMIT),
  );
  const counts = { reconciled: 0, caseFailures: 0 };
  const logger = runtimeLogger(env);
  for (const envelope of open) {
    try {
      await reconcileWorldProvisioning(env, envelope);
      counts.reconciled += 1;
    } catch (error) {
      counts.caseFailures += 1;
      logWorkflowReconcileFailure(
        logger,
        "world_provisioning_reconcile_failed",
        { tenantId: envelope.tenantId, runId: envelope.applicationRunId },
        queueFailureClass(error),
      );
    }
  }
  return counts;
}

/** Fence canonical work first; provider termination alone is never a durable cancellation. */
export async function cancelWorldProvisioning(env: RuntimeEnvironment, input: unknown) {
  const envelope = decodeLifecycleWorkflowEnvelope(input);
  return withLifecycleWorkflowClient(env, async (client) => {
    const store = new PostgreSqlLifecycleWorkflowStore(client);
    await store.cancel(envelope);
    return store.status(envelope);
  });
}

export interface RuntimeEnvironment {
  readonly WORLD_PRESENTATION?: string;
  readonly WORLD_MODEL_CONFIG?: string;
  readonly WAKE_TRIAGE_CONFIG?: string;
  readonly MODERATION_SHADOW_CONFIG?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly AUTH_DATABASE_URL?: string;
  /** Dedicated credential writer; omitted means first-party MCP is unavailable. */
  readonly MCP_AUTH_DATABASE_URL?: string;
  readonly MANAGEMENT_DATABASE_URL?: string;
  readonly WORLD_AUTHORIZATION_DATABASE_URL?: string;
  readonly AUTH_ORIGIN?: string;
  readonly PROVIDER_ENVIRONMENT?: string;
  readonly HYPERDRIVE?: HyperdriveBinding;
  readonly METRICS?: AnalyticsEngineDataset;
  /** `resources.buckets.artifacts` of the environment; without it, spilling artifacts fail closed. */
  readonly ARTIFACTS_BUCKET?: R2BucketBinding;
  /** `resources.buckets.assets`: content-addressed reviewed assets; the asset pipeline uploads to it and the runtime never writes it. */
  readonly ASSETS_BUCKET?: R2BucketBinding;
  /**
   * The versioned KEK secret `WebCryptoKeyring` reads. Conversations are stored only under it:
   * without it every conversation route answers `503 conversation_unavailable`.
   */
  readonly ARTIFACT_KEYRING?: string;
  /** The production model route's keys (the actor); without either, the actor answers from the scripted fixture. */
  readonly ANTHROPIC_API_KEY?: string;
  readonly AI_GATEWAY_API_KEY?: string;
  readonly WORLD_DO: DurableObjectNamespace<
    Pick<
      WorldDO,
      "initialize" | "validateRequestEpochs" | "submitWorldCommand" | "resumeWorldCommand"
    >
  >;
  readonly SPACE_DO: DurableObjectNamespace<
    Pick<
      SpaceDO,
      "initialize" | "submitNoOp" | "submitWorldCommand" | "resumeWorldCommand" | "inspectWorld"
    > &
      Partial<Pick<SpaceDO, "catchUp" | "prepareCatchUp" | "runtimeState" | "fetch">>
  >;
  /** Local-only retained credential owner; never exposed as a public route. */
  readonly MCP_OPERATOR_DO?: DurableObjectNamespace<
    Pick<McpOperatorDO, "execute" | "read" | "close">
  >;
  readonly ACTOR_AGENT_DO: DurableObjectNamespace<
    Pick<
      ActorAgentDO,
      | "initialize"
      | "validateRequestEpochs"
      | "talk"
      | "turnStatus"
      | "cancelTurn"
      | "receivePerception"
      | "reconcileCapabilities"
      | "inspectAgent"
      | "advanceProcess"
      | "configureActivation"
      | "wakeActivation"
      | "inspectActivations"
      | "hintActivations"
      | "wakeTriageReport"
      | "moderationShadowReport"
      | "toolCompleted"
    >
  >;
  readonly WORLD_REACTIONS_QUEUE: QueueBinding;
  readonly COGNITIVE_INDEXING_QUEUE: QueueBinding;
  readonly EXTERNAL_EFFECTS_QUEUE: QueueBinding;
  readonly WORLD_PROVISIONING_WORKFLOW: LifecycleWorkflowBinding;
  readonly WORLD_READINESS_WORKFLOW: LifecycleWorkflowBinding;
  readonly WORLD_CATCH_UP_WORKFLOW?: CatchUpWorkflowBinding;
  readonly WORLD_PACK_UPGRADE_WORKFLOW: WorkflowBinding;
  readonly INGESTION_WORKFLOW: WorkflowBinding;
  readonly CONSOLIDATION_WORKFLOW: WorkflowBinding;
  readonly AUTHORING_WORKFLOW: WorkflowBinding;
  readonly AGENT_JOB_WORKFLOW: WorkflowBinding;
  readonly TRANSFER_RECOVERY_WORKFLOW: WorkflowBinding;
  readonly WORLD_REACTIONS_QUEUE_NAME: string;
  readonly COGNITIVE_INDEXING_QUEUE_NAME: string;
  readonly EXTERNAL_EFFECTS_QUEUE_NAME: string;
}

/** Exact deployment surface for the later infrastructure objective. */
export const runtimeBindingManifest = {
  hyperdrive: ["HYPERDRIVE"],
  analyticsEngine: ["METRICS"],
  /** Binding to its `resources.buckets` key in `infra/environments/<env>.json`. */
  r2Buckets: { ARTIFACTS_BUCKET: "artifacts", ASSETS_BUCKET: "assets" },
  secrets: [
    "BETTER_AUTH_SECRET",
    "AUTH_DATABASE_URL",
    "MANAGEMENT_DATABASE_URL",
    "WORLD_AUTHORIZATION_DATABASE_URL",
    "ARTIFACT_KEYRING",
  ],
  durableObjects: {
    WORLD_DO: "WorldDO",
    SPACE_DO: "SpaceDO",
    ACTOR_AGENT_DO: "ActorAgentDO",
  },
  localDurableObjects: { MCP_OPERATOR_DO: "McpOperatorDO" },
  queues: ["WORLD_REACTIONS_QUEUE", "COGNITIVE_INDEXING_QUEUE", "EXTERNAL_EFFECTS_QUEUE"],
  workflows: {
    WORLD_PROVISIONING_WORKFLOW: "WorldProvisioningWorkflow",
    WORLD_READINESS_WORKFLOW: "WorldReadinessWorkflow",
    WORLD_CATCH_UP_WORKFLOW: "WorldCatchUpWorkflow",
    WORLD_PACK_UPGRADE_WORKFLOW: "WorldPackUpgradeWorkflow",
    INGESTION_WORKFLOW: "IngestionWorkflow",
    CONSOLIDATION_WORKFLOW: "ConsolidationWorkflow",
    AUTHORING_WORKFLOW: "AuthoringWorkflow",
    AGENT_JOB_WORKFLOW: "AgentJobWorkflow",
    TRANSFER_RECOVERY_WORKFLOW: "TransferRecoveryWorkflow",
  },
  variables: [
    "AUTH_ORIGIN",
    "PROVIDER_ENVIRONMENT",
    "WORLD_REACTIONS_QUEUE_NAME",
    "COGNITIVE_INDEXING_QUEUE_NAME",
    "EXTERNAL_EFFECTS_QUEUE_NAME",
  ],
  /**
   * Cron Triggers, in `triggers.crons` order. Both every 5 minutes; the snapshot sweep runs 2 minutes
   * after the recoveries in its own invocation. Written as a minute list, the cron syntax's `,`.
   */
  crons: {
    recoveries: "*/5 * * * *",
    snapshots: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  },
} as const;

export interface RuntimeComposition {
  readonly research?: ReturnType<typeof composeResearch> | undefined;
  readonly researchConfiguration?: Omit<
    ResearchConfiguration,
    "environment" | "publish" | "wake" | "adapter" | "internalRead"
  >;

  /** Trusted local composition; hosted activation remains guarded pending issue 3. */
  readonly mcp?: import("./mcp.js").McpRuntimePort | undefined;
  readonly mcpConfiguration?: Omit<
    import("./mcp-composition.js").McpCompositionConfiguration,
    "environment" | "runtimeDatabaseUrl" | "changed" | "withClient" | "openSecretClient"
  >;
  readonly worldMcpAuthentication?: WorldMcpAuthentication | undefined;
  readonly worldMcpResourceURL?: string | undefined;
  readonly journal: Journal;
  readonly authentication: RuntimeAuthenticationDependencies;
  readonly canonical: CanonicalRuntimeStateSource;
  readonly consumers: RuntimeQueueConsumers;
  /** The composed sink, stamped with this composition's `codeVersion` and environment. */
  readonly logger: RuntimeLogger;
}
export type RuntimeCompositionFunction = (env: RuntimeEnvironment) => Omit<
  RuntimeComposition,
  "journal" | "canonical" | "logger"
> &
  Partial<Pick<RuntimeComposition, "journal" | "canonical" | "logger">> & {
    readonly referenceAuthentication?: ReferenceAuthenticationConfiguration;
    readonly worldMcpAuthenticationConfiguration?: WorldMcpAuthenticationConfiguration;
  };
let composition: RuntimeCompositionFunction | undefined;

/** Explicit local/test dependency injection; deployed isolates need no initializer. */
export function injectRuntimeComposition(factory: RuntimeCompositionFunction | undefined): void {
  composition = factory;
}

function suppliedComposition(env: RuntimeEnvironment): ReturnType<RuntimeCompositionFunction> {
  return composition === undefined ? defaultRuntimeComposition(env) : composition(env);
}

/** Every record carries the release the runtime is composed with and its canonical environment. */
function composedLogger(
  supplied: ReturnType<RuntimeCompositionFunction>,
  env: RuntimeEnvironment,
): RuntimeLogger {
  return releaseRuntimeLogger(supplied.logger ?? consoleRuntimeLogger, {
    codeVersion: supplied.authentication.codeVersion,
    environment: env.PROVIDER_ENVIRONMENT,
  });
}

/** The composed logger alone, for scheduled and Queue paths that need no journal binding. */
export function runtimeLogger(env: RuntimeEnvironment): RuntimeLogger {
  return composedLogger(suppliedComposition(env), env);
}

export function composeRuntime(env: RuntimeEnvironment): RuntimeComposition {
  const supplied = suppliedComposition(env);
  const injected = {
    ...supplied,
    logger: composedLogger(supplied, env),
    authentication: {
      ...supplied.authentication,
      provider: composeReferenceAuthentication(
        env.BETTER_AUTH_SECRET,
        supplied.referenceAuthentication,
      ),
    },
  };
  let worldMcpAuthentication: WorldMcpAuthentication | undefined;
  try {
    if (supplied.worldMcpAuthenticationConfiguration !== undefined)
      worldMcpAuthentication = composeWorldMcpAuthentication(
        env.BETTER_AUTH_SECRET ?? "",
        supplied.worldMcpAuthenticationConfiguration,
      );
  } catch {
    // Invalid optional MCP credentials never alter ordinary web authentication.
  }
  const worldMcp = {
    worldMcpAuthentication,
    worldMcpResourceURL: supplied.worldMcpAuthenticationConfiguration?.resourceURL,
  };
  const connectionString = env.HYPERDRIVE?.connectionString;
  const mcp = composeGuardedMcpOperator(env, injected);
  const research = composeGuardedResearch(env, injected);
  const consumers = research
    ? { ...injected.consumers, externalEffects: research.consumer }
    : injected.consumers;
  if (injected.journal !== undefined && injected.canonical !== undefined)
    return { ...injected, ...worldMcp, mcp, research, consumers } as RuntimeComposition;
  if (connectionString === undefined && composition !== undefined)
    throw new Error("Hyperdrive binding required for PostgreSQL composition");
  // Each call owns one connection; exact retries are answered from stored outcomes.
  const postgreSqlJournal: Journal & JournalOutcomeReader = {
    execute: (request) =>
      withHyperdrivePostgreSqlClient(connectionString ?? "", (client) =>
        new PostgreSqlJournal(client).execute(request),
      ),
    storedOutcome: (authorization, commandId, commandBytes) =>
      withHyperdrivePostgreSqlClient(connectionString ?? "", (client) =>
        new PostgreSqlJournal(client).storedOutcome(authorization, commandId, commandBytes),
      ),
  };
  return {
    ...injected,
    ...worldMcp,
    mcp,
    research,
    consumers,
    journal: injected.journal ?? postgreSqlJournal,
    canonical: injected.canonical ?? {
      loadReadyRuntimeState: (context, scope) =>
        withHyperdrivePostgreSqlClient(connectionString ?? "", (client) =>
          new PostgreSqlCanonicalRuntimeStateSource(client).loadReadyRuntimeState(context, scope),
        ),
    },
  };
}

/** Shared local read adapter; fresh member authority governs both native execution and fixtures. */
export function composeResearchInternalRead(
  env: RuntimeEnvironment,
  authentication: RuntimeAuthenticationDependencies,
): NonNullable<ResearchConfiguration["internalRead"]> {
  const contextFor = async (target: ResearchResumeTarget) => {
    const authority = await authentication.world.resolveWorld(
      decodeOpaqueId(target.principalId, "PrincipalId"),
      target.scope,
    );
    if (
      !authority ||
      authority.tenantId !== target.scope.tenantId ||
      authority.worldId !== target.scope.worldId ||
      authority.timelineId !== target.scope.timelineId ||
      authority.spaceId !== target.scope.spaceId ||
      authority.principalId !== target.principalId ||
      authority.personaId !== target.personaId ||
      !authority.grants.some((grant) => grant === "runtime:world-observe")
    )
      throw new Error("Research authority unavailable");
    const { constructTrustedExecutionContext } = await import("@clockgrove/contracts/trusted");
    return constructTrustedExecutionContext({
      version: 1,
      ...target.scope,
      principalId: authority.principalId,
      worldMembershipId: authority.membershipId,
      personaId: authority.personaId,
      roles: authority.roles,
      grants: authority.grants,
      privacyCeiling: authority.privacyCeiling,
      correlationId: target.messageId,
      requestId: target.messageId,
      codeVersion: authentication.codeVersion,
      protocolVersion: 1,
    });
  };
  return async (target, capability, input) => {
    const context = await contextFor(target);
    const value =
      capability === "inspect"
        ? await perceiveScene(env, target.scope, context)
        : await withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
            new PostgreSqlCausalInspector(client).recordedWhy(
              {
                scope: target.scope,
                commandId: decodeOpaqueId((input as { commandId: string }).commandId, "CommandId"),
              },
              context,
            ),
          );
    return {
      trust: "untrusted_evidence",
      status: "ok",
      content: [{ type: "text", text: JSON.stringify(value) }],
      sanitized: false,
      costMicrousd: null,
    };
  };
}

function composeGuardedResearch(
  env: RuntimeEnvironment,
  supplied: Pick<RuntimeComposition, "research" | "researchConfiguration" | "authentication">,
): ReturnType<typeof composeResearch> | undefined {
  if (env.PROVIDER_ENVIRONMENT !== "local") return undefined;
  if (supplied.research) return supplied.research;
  const configuration = supplied.researchConfiguration;
  if (!configuration) return undefined;
  const execute = async (request: AdmittedMcpExecution, intent: EffectIntentMetadata) => {
    const owners = env.MCP_OPERATOR_DO;
    if (!owners) throw new McpReadFailure("credential_unavailable", "not_sent");
    const result = await owners.get(owners.idFromName("local-mcp-operator")).read(intent, request);
    if (!result.ok) throw new McpReadFailure(result.code, result.disposition);
    return result.value;
  };
  return composeResearch({
    ...configuration,
    environment: "local",
    publish: (message) => env.EXTERNAL_EFFECTS_QUEUE.send(message),
    wake: async (target) => {
      const route = await runtimeRouteName(
        "actor-agent",
        target.scope,
        decodeOpaqueId(target.actorId, "SubjectId"),
      );
      await env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(route)).toolCompleted(target);
    },
    adapter: { execute, executeWrite: execute },
    internalRead: composeResearchInternalRead(env, supplied.authentication),
  });
}

function composeGuardedMcpOperator(
  env: RuntimeEnvironment,
  supplied: Pick<RuntimeComposition, "mcp" | "mcpConfiguration">,
): import("./mcp.js").McpRuntimePort | undefined {
  if (env.PROVIDER_ENVIRONMENT !== "local") return undefined;
  if (supplied.mcp !== undefined) return supplied.mcp;
  if (supplied.mcpConfiguration === undefined) return undefined;
  const owners = env.MCP_OPERATOR_DO;
  if (owners === undefined) return undefined;
  return {
    execute: async (action, input, context) => {
      const result = await owners
        .get(owners.idFromName("local-mcp-operator"))
        .execute(action, input, context);
      if (result.ok) return result.value;
      const refusal = safeMcpNetworkRefusal(new McpRefusal(result.code));
      throw refusal ?? new Error("MCP operation failed");
    },
  };
}

/** Socket I/O belongs to this object across RPCs, never to a Worker request context. */
class McpOperatorDO extends DurableObject<RuntimeEnvironment> {
  private operator: ReturnType<typeof composeOwnedMcpOperator> | undefined;

  constructor(
    state: unknown,
    private readonly environment: RuntimeEnvironment,
  ) {
    super(state, environment);
  }

  async execute(
    action: import("./mcp.js").McpRuntimeAction,
    input: Record<string, unknown>,
    context: TrustedContext,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> {
    try {
      if (this.environment.PROVIDER_ENVIRONMENT !== "local") throw new Error("MCP unavailable");
      const supplied = suppliedComposition(this.environment);
      if (supplied.mcpConfiguration === undefined) throw new Error("MCP unavailable");
      this.operator ??= composeOwnedMcpOperator(this.environment, supplied.mcpConfiguration);
      return { ok: true, value: await this.operator.execute(action, input, context) };
    } catch (error) {
      // RPC serializes Errors without their class identity. Reconstruct only closed policy codes.
      return { ok: false, code: safeMcpNetworkRefusal(error)?.code ?? "mcp_operation_failed" };
    }
  }

  async read(
    intent: EffectIntentMetadata,
    request: AdmittedMcpExecution,
  ): Promise<
    | { ok: true; value: McpReadEvidence }
    | { ok: false; code: string; disposition: "not_sent" | "uncertain" | "result_refused" }
  > {
    try {
      if (this.environment.PROVIDER_ENVIRONMENT !== "local") throw new Error();
      const supplied = suppliedComposition(this.environment);
      if (!supplied.researchConfiguration || !supplied.mcpConfiguration) throw new Error();
      const installationId = await supplied.researchConfiguration.withClient(async (client) => {
        const admitted = request.admittedReadOnly
          ? await new PostgreSqlMcpReadAdmission(client).admit(intent, request.arguments)
          : await new PostgreSqlMcpWriteAdmission(client)
              .admit(intent, request.arguments)
              .then(async (value) => {
                const call =
                  value ??
                  (await new PostgreSqlMcpReadAdmission(client).admit(intent, request.arguments));
                return call ? { ...call, admittedReadOnly: false as const } : null;
              });
        if (!admitted) return null;
        const result = await client.query(
          `SELECT installation_id FROM clockgrove.mcp_read_admissions
          WHERE tenant_id=$1 AND world_id=$2 AND timeline_id=$3 AND effect_id=$4 AND admitted`,
          [intent.tenantId, intent.worldId, intent.timelineId, intent.effectId],
        );
        const id = (result.rows[0] as { installation_id: string } | undefined)?.installation_id;
        return id ? { installationId: id, request: admitted } : null;
      });
      if (!installationId) throw new Error();
      this.operator ??= composeOwnedMcpOperator(this.environment, supplied.mcpConfiguration);
      return {
        ok: true,
        value: installationId.request.admittedReadOnly
          ? await this.operator.executeRead(
              { ...intent, installationId: installationId.installationId },
              installationId.request,
            )
          : await this.operator.executeWrite(
              { ...intent, installationId: installationId.installationId },
              installationId.request,
            ),
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof McpReadFailure ? error.code : "read_unavailable",
        disposition: error instanceof McpReadFailure ? error.disposition : "not_sent",
      };
    }
  }

  async close(): Promise<void> {
    await this.operator?.close();
  }
}

export { McpOperatorDO };

function composeOwnedMcpOperator(
  env: RuntimeEnvironment,
  configuration: NonNullable<RuntimeComposition["mcpConfiguration"]>,
): ReturnType<typeof composeMcpOperator> {
  return composeMcpOperator({
    ...configuration,
    environment: env.PROVIDER_ENVIRONMENT ?? "",
    runtimeDatabaseUrl: env.HYPERDRIVE?.connectionString ?? "",
    withClient: (operation) =>
      withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", operation),
    openSecretClient: () => new HyperdrivePostgreSqlClient(configuration.secretDatabaseUrl),
    changed: async (authorization, scope) => {
      const targets = await withHyperdrivePostgreSqlClient(
        env.HYPERDRIVE?.connectionString ?? "",
        (client) =>
          withClientTransaction(client, { authorization }, async () => {
            const result = await client.query(
              "SELECT clockgrove.mcp_actor_revision_targets($1,$2,$3,$4) AS targets",
              [authorization.tenantId, scope.worldId, scope.timelineId, scope.spaceId],
            );
            return (result.rows[0] as { targets: { revision: string; actorIds: string[] } })
              .targets;
          }),
      );
      const revision = Number(targets.revision);
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error("MCP revision unavailable");
      for (const actorId of targets.actorIds) {
        const route = await runtimeRouteName(
          "actor-agent",
          {
            tenantId: authorization.tenantId,
            worldId: decodeOpaqueId(scope.worldId, "WorldId"),
            timelineId: decodeOpaqueId(scope.timelineId, "TimelineId"),
            spaceId: decodeOpaqueId(scope.spaceId, "SpaceId"),
          },
          decodeOpaqueId(actorId, "SubjectId"),
        );
        await env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(route)).reconcileCapabilities(
          revision,
        );
      }
    },
  });
}

/** Scalar bindings only; generated credentials use distinct least-privilege roles. */
function defaultRuntimeComposition(
  env: RuntimeEnvironment,
): ReturnType<RuntimeCompositionFunction> {
  const management = <T>(operation: (reader: PostgreSqlManagementReaders) => Promise<T>) =>
    authenticationRead(env.MANAGEMENT_DATABASE_URL, "clockgrove_management_reader", (client) =>
      operation(new PostgreSqlManagementReaders(client, env.PROVIDER_ENVIRONMENT ?? "")),
    );
  const authentication: RuntimeAuthenticationDependencies = {
    provider: composeReferenceAuthentication(undefined, undefined),
    mapping: {
      resolvePrincipal: (identity) => management((reader) => reader.resolvePrincipal(identity)),
    },
    workspace: {
      resolveWorkspace: (principal, tenant) =>
        management((reader) => reader.resolveWorkspace(principal, tenant)),
    },
    world: {
      resolveWorld: (principal, scope) =>
        authenticationRead(
          env.WORLD_AUTHORIZATION_DATABASE_URL,
          "clockgrove_world_reader",
          (client) => new PostgreSqlWorldAuthorizationReader(client).resolveWorld(principal, scope),
        ),
    },
    codeVersion: "wave0",
    requestMetadata: (commandId) => ({
      requestId: commandId,
      correlationId: decodeOpaqueId(crypto.randomUUID(), "CorrelationId"),
    }),
  };
  let referenceAuthentication: ReferenceAuthenticationConfiguration | undefined;
  try {
    const origin = new URL(env.AUTH_ORIGIN ?? "");
    assertReaderConnection(env.HYPERDRIVE?.connectionString, "clockgrove_runtime");
    for (const [connection, role] of [
      [env.AUTH_DATABASE_URL, "clockgrove_auth_verifier"],
      [env.MANAGEMENT_DATABASE_URL, "clockgrove_management_reader"],
      [env.WORLD_AUTHORIZATION_DATABASE_URL, "clockgrove_world_reader"],
    ])
      assertReaderConnection(connection, role!);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== env.AUTH_ORIGIN ||
      !["local", "ci", "development", "staging", "production"].includes(
        env.PROVIDER_ENVIRONMENT ?? "",
      )
    )
      throw new Error("invalid authentication configuration");
    const authStorage = new URL(env.AUTH_DATABASE_URL!);
    for (const connection of [
      env.MANAGEMENT_DATABASE_URL!,
      env.WORLD_AUTHORIZATION_DATABASE_URL!,
    ]) {
      const readerStorage = new URL(connection);
      if (
        readerStorage.hostname !== authStorage.hostname ||
        readerStorage.port !== authStorage.port ||
        readerStorage.pathname !== authStorage.pathname ||
        readerStorage.searchParams.get("host") !== authStorage.searchParams.get("host")
      )
        throw new Error("mismatched authority storage");
    }
    if (new URL(env.HYPERDRIVE!.connectionString).pathname !== authStorage.pathname)
      throw new Error("mismatched canonical database");
    if (!["local", "ci"].includes(env.PROVIDER_ENVIRONMENT!)) {
      for (const connection of [
        env.AUTH_DATABASE_URL!,
        env.MANAGEMENT_DATABASE_URL!,
        env.WORLD_AUTHORIZATION_DATABASE_URL!,
      ])
        if (
          new URL(connection).searchParams.get("sslmode") !== "verify-full" ||
          new URL(connection).searchParams.has("host")
        )
          throw new Error("invalid direct PostgreSQL transport");
    }
    referenceAuthentication = {
      baseURL: env.AUTH_ORIGIN!,
      environment: env.PROVIDER_ENVIRONMENT!,
      connectionString: env.AUTH_DATABASE_URL!,
      resolveIdentity: (environment, subject) =>
        management((reader) => reader.resolveIdentity(environment, subject)),
    };
  } catch {
    /* Missing/invalid configuration selects the refusing provider. */
  }
  let worldMcpAuthenticationConfiguration: WorldMcpAuthenticationConfiguration | undefined;
  if (referenceAuthentication !== undefined && env.MCP_AUTH_DATABASE_URL !== undefined) {
    try {
      const writer = new URL(env.MCP_AUTH_DATABASE_URL);
      const verifier = new URL(referenceAuthentication.connectionString);
      if (
        writer.hostname !== verifier.hostname ||
        writer.port !== verifier.port ||
        writer.pathname !== verifier.pathname ||
        writer.searchParams.get("host") !== verifier.searchParams.get("host") ||
        (!["local", "ci"].includes(referenceAuthentication.environment) &&
          (writer.searchParams.get("sslmode") !== "verify-full" || writer.searchParams.has("host")))
      )
        throw new Error("mismatched credential storage");
      worldMcpAuthenticationConfiguration = {
        ...referenceAuthentication,
        connectionString: env.MCP_AUTH_DATABASE_URL,
        resourceURL: `${referenceAuthentication.baseURL}/mcp`,
      };
    } catch {
      /* Invalid optional credential storage leaves MCP unavailable. */
    }
  }
  return {
    authentication,
    consumers: worldReactionConsumers(env),
    ...(referenceAuthentication === undefined ? {} : { referenceAuthentication }),
    ...(worldMcpAuthenticationConfiguration === undefined
      ? {}
      : { worldMcpAuthenticationConfiguration }),
  };
}

function assertReaderConnection(
  connection: string | undefined,
  role: string,
): asserts connection is string {
  const url = new URL(connection ?? "");
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== role ||
    new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length ||
    url.pathname.length < 2 ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => !["host", "sslmode"].includes(key)) ||
    (url.searchParams.has("host") && !url.searchParams.get("host")?.startsWith("\0"))
  )
    throw new Error("invalid reader connection");
}
async function authenticationRead<T>(
  connection: string | undefined,
  role: string,
  operation: Parameters<typeof withHyperdrivePostgreSqlClient<T>>[1],
): Promise<T> {
  try {
    assertReaderConnection(connection, role);
    // A termination after the read's last reply refuses, as for the Better Auth verifier.
    return await withHyperdrivePostgreSqlClient(connection, operation, { confirm: true });
  } catch {
    throw new AuthenticationRefusedError("authentication refused");
  }
}

export interface MessageBatch {
  readonly queue: string;
  readonly messages: readonly {
    readonly id: string;
    readonly body: unknown;
    readonly attempts: number;
    ack(): void;
    retry(options: { readonly delaySeconds: number }): void;
  }[];
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    const dependencies = composeRuntime(env);
    if (isEffectRoute(new URL(request.url).pathname)) {
      const configuration = dependencies.researchConfiguration;
      const research = dependencies.research;
      if (env.PROVIDER_ENVIRONMENT !== "local" || !configuration || !research)
        return Response.json({ error: "effect_controls_unavailable" }, { status: 503 });
      return handleEffectEndpoint(request, {
        authentication: dependencies.authentication,
        research,
        configuration,
        wake: async (target) => {
          const route = await runtimeRouteName(
            "actor-agent",
            target.scope,
            decodeOpaqueId(target.actorId, "SubjectId"),
          );
          await env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(route)).toolCompleted(target);
        },
      });
    }
    const connection = env.HYPERDRIVE?.connectionString ?? "";
    const conversations = composeConversations(env);
    const runs = composeRunInspector(env);
    const cognition = composeCognition(env);
    const inspector = <T>(operation: (inspector: PostgreSqlCausalInspector) => Promise<T>) =>
      withHyperdrivePostgreSqlClient(connection, (client) =>
        operation(new PostgreSqlCausalInspector(client)),
      );
    const runtimeState = <T>(
      operation: (inspector: PostgreSqlRuntimeStateInspector) => Promise<T>,
    ) =>
      withHyperdrivePostgreSqlClient(connection, (client) =>
        operation(new PostgreSqlRuntimeStateInspector(client, runtimeStatePorts(env))),
      );
    const operator = <T>(operation: (operator: PostgreSqlRuntimeOperator) => Promise<T>) =>
      withHyperdrivePostgreSqlClient(connection, (client) =>
        operation(
          new PostgreSqlRuntimeOperator(client, async (message) => {
            if (env.WORLD_REACTIONS_QUEUE === undefined)
              throw new Error("world reactions Queue required");
            await env.WORLD_REACTIONS_QUEUE.send(message);
          }),
        ),
      );
    const mcpRequest = isWorldMcpRoute(new URL(request.url).pathname);
    const runtimeAuthentication =
      mcpRequest && dependencies.worldMcpAuthentication !== undefined
        ? { ...dependencies.authentication, provider: dependencies.worldMcpAuthentication.provider }
        : dependencies.authentication;
    const worker = new RuntimeWorker(
      new TrustedRuntimeRequestAuthenticator(runtimeAuthentication),
      {
        mcp: env.PROVIDER_ENVIRONMENT === "local" ? dependencies.mcp : undefined,
        sceneConnection: async (scope, context, interest) => {
          const canonical = await dependencies.canonical.loadReadyRuntimeState(context, scope);
          const assertion = await signSceneJoin(env.BETTER_AUTH_SECRET ?? "", {
            principalId: context.principalId,
            audience: { ...scope, privacyClass: "public_scene", interest },
            protocol: "clockgrove.scene.v1",
            authorityEpoch: canonical.authorityEpoch,
          });
          const route = await runtimeRouteName("space", scope);
          const stub = env.SPACE_DO.get(env.SPACE_DO.idFromName(route));
          if (stub.fetch === undefined) return new Response(null, { status: 503 });
          return stub.fetch(
            new Request("https://scene.internal/v1/projection", {
              headers: {
                upgrade: "websocket",
                "sec-websocket-protocol": "clockgrove.scene.v1",
                [SCENE_JOIN_HEADER]: assertion,
              },
            }),
          );
        },
        journal: dependencies.journal,
        ...(conversations === undefined
          ? {}
          : {
              conversations,
              deliveries: (operation) => withGovernedDelivery(env, operation),
              turns: composeTurnOwners(env),
              activations: composeActivationOwners(env),
            }),
        ...(runs === undefined ? {} : { runs }),
        ...(cognition === undefined ? {} : { cognition }),
        changeViewedSpace: (request, authorize) =>
          withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
            new PostgreSqlViewedSpaceReader(client).change(request, authorize),
          ),
        observation: {
          select: (input, context) =>
            withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
              new PostgreSqlEntitySelectionReader(client).select(
                input,
                context,
                BigInt(Date.now()),
              ),
            ),
          observe: (scope, context) =>
            withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
              new PostgreSqlLivingSceneReader(new PostgreSqlWorldOwnerReader(client)).observe(
                scope,
                context,
              ),
            ),
          status: (scope, context) =>
            withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
              new PostgreSqlWorldStatusReader(client).read(scope, context),
            ),
        },
        // Membership rows are visible only to the world reader, through its directory function.
        worldDirectory: (principalId) => {
          const connection = env.WORLD_AUTHORIZATION_DATABASE_URL;
          assertReaderConnection(connection, "clockgrove_world_reader");
          return withHyperdrivePostgreSqlClient(connection, (client) =>
            readWorldDirectory(client, principalId),
          );
        },
        worldReadiness: (principalId, scope) => {
          const connection = env.WORLD_AUTHORIZATION_DATABASE_URL;
          assertReaderConnection(connection, "clockgrove_world_reader");
          return withHyperdrivePostgreSqlClient(connection, (client) =>
            readWorldReadiness(client, principalId, scope),
          );
        },
        inspector: {
          inspect: (input, context) => inspector((owner) => owner.inspect(input, context)),
          recordedWhy: (input, context) => inspector((owner) => owner.recordedWhy(input, context)),
          deny: (input, principalId, denial) =>
            inspector((owner) => owner.deny(input, principalId, denial)),
        },
        viewTrace: {
          inspect: (input, context) =>
            withHyperdrivePostgreSqlClient(connection, (client) =>
              new PostgreSqlClientViewInspector(client).inspect(input, context),
            ),
          deny: (input, principalId, denial) =>
            withHyperdrivePostgreSqlClient(connection, (client) =>
              new PostgreSqlClientViewInspector(client).deny(input, principalId, denial),
            ),
        },
        runtimeState: {
          inspect: (input, context) => runtimeState((owner) => owner.inspect(input, context)),
          deny: (input, principalId, denial) =>
            runtimeState((owner) => owner.deny(input, principalId, denial)),
        },
        operator: {
          inspect: (input, context) => operator((owner) => owner.act(input, context)),
          deny: (input, principalId, denial) =>
            operator((owner) => owner.deny(input, principalId, denial)),
        },
        worldCommands: {
          prepare: (input, principalId) =>
            withCommandOwner(env.HYPERDRIVE?.connectionString ?? "", async (owner) => {
              const tenantMember = await owner.reader.isTenantMember(
                { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
                input.scope,
              );
              if (!tenantMember) return { tenantMember: false, ready: false };
              const stored = await owner.stored(input, principalId);
              if (stored !== undefined) return { tenantMember: true, ready: true, stored };
              return {
                tenantMember: true,
                ready: await owner.reader.isReady(
                  {
                    tenantId: input.scope.tenantId,
                    principalId,
                    privacyCeiling: NO_PRIVACY_CEILING,
                  },
                  input.scope,
                ),
              };
            }),
          deny: (input, principalId, denial) =>
            withCommandOwner(
              env.HYPERDRIVE?.connectionString ?? "",
              (owner) => owner.deny(input, principalId, denial),
              analyticsEngineMetrics(env.METRICS),
            ),
          prepareBuilt: (scope, principalId, commandId, build) =>
            withCommandOwner(env.HYPERDRIVE?.connectionString ?? "", (owner) =>
              owner.prepareBuilt(scope, principalId, commandId, build),
            ),
          submit: async (input, context) => {
            const route = await runtimeRouteName("world", input.scope);
            const result = await callWorldOwner(() =>
              env.WORLD_DO.get(env.WORLD_DO.idFromName(route)).submitWorldCommand(input, context),
            );
            return unwrapWorldCommandRpc(result);
          },
        },
        getSpace(routeName: string, scope: RuntimeScope): PortableSpaceDO {
          const stub = env.SPACE_DO.get(env.SPACE_DO.idFromName(routeName));
          // The portable binding names a concrete shell. Only this provider seam
          // adapts its two used methods to RPC; no portable signature is changed.
          return {
            initialize: async (context) =>
              unwrapWorldCommandRpc(await callWorldOwner(() => stub.initialize(scope, context))),
            // Owner refusals cross RPC as typed replies; class identity does not survive it.
            submitNoOp: async (context, input, disposition) =>
              unwrapWorldCommandRpc(
                await callWorldOwner(() => stub.submitNoOp(scope, context, input, disposition)),
              ),
          } as PortableSpaceDO;
        },
      },
      dependencies.logger,
    );
    if (mcpRequest) {
      const authentication = dependencies.worldMcpAuthentication;
      const resourceURL = dependencies.worldMcpResourceURL;
      if (authentication === undefined || resourceURL === undefined)
        return Response.json({ error: "mcp_unavailable" }, { status: 503 });
      return handleWorldMcpEndpoint(request, {
        resourceURL,
        authentication,
        admission: new WorldMcpAdmission({
          provider: authentication.provider,
          mapping: dependencies.authentication.mapping,
          store: {
            reserve: (principalId, phase, work) =>
              withHyperdrivePostgreSqlClient(connection, (client) =>
                new PostgreSqlWorldMcpAdmission(client).reserve(principalId, phase, work),
              ),
          },
        }),
        application: (clientId) => ({
          fetch: (input: Request) => worker.fetch(input),
          submitCommand: (input: Request) => worker.fetchMcpCommand(input, clientId),
        }),
      });
    }
    return worker.fetch(request);
  },
  async queue(batch: MessageBatch, env: RuntimeEnvironment): Promise<void> {
    const names = [
      env.WORLD_REACTIONS_QUEUE_NAME,
      env.COGNITIVE_INDEXING_QUEUE_NAME,
      env.EXTERNAL_EFFECTS_QUEUE_NAME,
    ];
    if (new Set(names).size !== names.length) throw new Error("queue names must be distinct");
    const { consumers, logger, research } = composeRuntime(env);
    const queue = new Map([
      [names[0], ["world-reactions", consumers.worldReactions] as const],
      [names[1], ["cognitive-indexing", consumers.cognitiveIndexing] as const],
      [names[2], ["external-effects", consumers.externalEffects] as const],
    ]).get(batch.queue);
    if (queue === undefined) throw new Error("unknown runtime queue");
    const [channel, consumer] = queue;
    for (const message of batch.messages) {
      try {
        await consumer.consume(message.body, (value) => value);
        // Acknowledgement always follows the durable consumption transaction and client cleanup.
        message.ack();
      } catch (error) {
        // Only transport identity is logged: untrusted envelope IDs and private bodies stay in
        // the access-controlled physical DLQ. No exception text or connection details are logged.
        const failureClass = queueFailureClass(error);
        logQueueDeliveryFailure(logger, channel, message.id, message.attempts, failureClass);
        // The last attempt the consumer's `max_retries` allows: this retry dead-letters it.
        if (message.attempts > QUEUE_MAX_RETRIES) {
          logQueueDeadLetter(logger, channel, message.id, message.attempts, failureClass);
          if (channel === "world-reactions")
            await recordDeadLetter(env, message.body, failureClass);
          if (channel === "external-effects" && research) {
            try {
              await research.deadLetter(
                decodeQueueEnvelope(message.body, (value) => value),
                failureClass,
              );
            } catch {
              /* Malformed data has no canonical source row. */
            }
          }
        }
        message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
      }
    }
  },
  async scheduled(controller: { readonly cron: string }, env: RuntimeEnvironment) {
    // Snapshot maintenance has its own trigger, so its own invocation and limits.
    if (controller.cron === runtimeBindingManifest.crons.snapshots)
      return { snapshots: await sweepPartitionSnapshots(env) };
    // Independent recoveries: one failing does not stop the others.
    const [reactions, provisioning, catchUp, research] = await Promise.allSettled([
      processWorldReactionDispatches(env),
      reconcileOpenWorldProvisioning(env),
      reconcileOpenWorldCatchUp(env),
      composeRuntime(env).research?.sweep(),
    ]);
    if (reactions.status === "rejected") throw reactions.reason;
    if (provisioning.status === "rejected") throw provisioning.reason;
    if (catchUp.status === "rejected") throw catchUp.reason;
    if (research.status === "rejected") throw research.reason;
    return {
      reactions: reactions.value,
      provisioning: provisioning.value,
      catchUp: catchUp.value,
      research: research.value,
    };
  },
};

/** Existing native owner recovery delay (1 s), with the dispatch store's one-day ceiling. */
export function queueRetryDelaySeconds(attempt: number): number {
  return Math.min(86_400, 2 ** (attempt - 1));
}

/**
 * Every runtime Queue consumer's `max_retries` in `infra/wrangler/*.json`, which
 * `infra/check-configuration.mjs` pins to 3: a message's delivery attempts are 1 to 4, and a failure
 * of the fourth sends it to the dead-letter queue.
 */
const QUEUE_MAX_RETRIES = 3;

/**
 * Records a dead-lettered world-reactions message's failure class on its source dispatch, where the
 * body names one; a malformed body names none. Diagnostic only, and best effort: the alert record is
 * already written, and a failure here (often the same outage) must not change the delivery's retry.
 */
async function recordDeadLetter(
  env: RuntimeEnvironment,
  body: unknown,
  failureClass: ReturnType<typeof queueFailureClass>,
): Promise<void> {
  let envelope: QueueEnvelope<unknown>;
  try {
    envelope = decodeQueueEnvelope(body, (payload) => payload);
  } catch {
    return;
  }
  await withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
    new PostgreSqlDispatchStore(client).recordWorldReactionDeadLetter(
      envelope.tenantId,
      envelope.messageId,
      failureClass,
    ),
  ).catch(() => undefined);
}

/** The space owner's own state and the catch-up Workflow's native status, for the runtime state. */
function runtimeStatePorts(env: RuntimeEnvironment): RuntimeStatePorts {
  return {
    owner: async (scope, context) => {
      const name = await runtimeRouteName("space", scope);
      const owner = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      if (owner.runtimeState === undefined) throw new Error("space owner runtime state required");
      return owner.runtimeState(scope, context);
    },
    catchUpWorkflow: async (applicationRunId) => {
      const run = decodeOpaqueId(applicationRunId, "RunId");
      const instanceId = await stableWorkflowInstanceId("WorldCatchUpWorkflow", run);
      let status = "unavailable";
      try {
        const binding = env.WORLD_CATCH_UP_WORKFLOW;
        if (binding !== undefined) status = (await (await binding.get(instanceId)).status()).status;
      } catch {
        /* The provider did not answer: reported unavailable, never guessed. */
      }
      return { instanceId, status, observedAt: Date.now() };
    },
  };
}

/** Shared world-reactions publication settings; only the claim page size differs per caller. */
function sweepWorldReactions(
  env: RuntimeEnvironment,
  store: PostgreSqlDispatchStore,
  authorization: RuntimeAuthorizationContext,
  limit: number,
) {
  const queue = env.WORLD_REACTIONS_QUEUE;
  if (queue === undefined) throw new Error("world reactions Queue required");
  return sweepDispatches(
    {
      authorization,
      channel: "world-reactions",
      limit,
      leaseOwner: `world-reactions:${crypto.randomUUID()}`,
      // Existing reconciliation cadence: */5 cron in every environment manifest.
      leaseMs: 300_000,
      // Publication attempts recorded on the dispatch row: one send plus three retries, matching
      // the Queue's `max_retries: 3` for symmetry. Queue consumer retries are counted separately.
      maxAttempts: 4,
      retryAfterMs: 1_000,
    },
    {
      store,
      publisher: { publish: (message) => queue.send(message) },
      // Alert: the attempt budget is spent; the row stays `failed` until an operator repairs it.
      failed: (dispatch, cause) =>
        logPublicationFailure(
          runtimeLogger(env),
          {
            tenantId: dispatch.tenantId,
            worldId: dispatch.worldId,
            timelineId: dispatch.timelineId,
            messageId: dispatch.dispatchId,
          },
          dispatch.attempt,
          queueFailureClass(cause),
        ),
    },
  );
}

/**
 * Scheduled recovery: each sweep owns its client and drains every due principal. One principal's
 * failure is logged and counted; the rest still run, and its rows stay due for the next cron.
 */
export async function processWorldReactionDispatches(env: RuntimeEnvironment) {
  if (env.WORLD_REACTIONS_QUEUE === undefined) throw new Error("world reactions Queue required");
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", async (client) => {
    const store = new PostgreSqlDispatchStore(client, analyticsEngineMetrics(env.METRICS));
    const authorizations = await store.listDueWorldReactionAuthorizations();
    const counts = { delivered: 0, retried: 0, failed: 0, stale: 0, principalFailures: 0 };
    const logger = runtimeLogger(env);
    for (const authorization of authorizations) {
      try {
        // Existing store maximum; scopes and claims each have this finite bound.
        const result = await sweepWorldReactions(env, store, authorization, 1_000);
        counts.delivered += result.delivered;
        counts.retried += result.retried;
        counts.failed += result.failed;
        counts.stale += result.stale;
      } catch (error) {
        counts.principalFailures += 1;
        logWorldReactionSweepFailure(logger, "cron", queueFailureClass(error));
        // Every principal shares this client: once its session is gone the rest would each fail
        // and log in turn. One probe after a failure stops the run at the first broken session.
        await client.query("SELECT 1").catch(() => {
          throw error;
        });
      }
    }
    return counts;
  });
}

/**
 * Decision: a partition is due once its head is 2,000 events past its latest compatible snapshot, the
 * replay page (`REPLAY_PAGE`, partition-replay.ts), so replay from the latest snapshot reads about one
 * page of suffix. A partition with no compatible snapshot (new, after migration 0029, or after a
 * registry or pack change) is due once its head is past its snapshots. Not exported: workerd accepts
 * only functions and handlers as the entry module's exports.
 */
const SNAPSHOT_INTERVAL_EVENTS = 2_000n;

/**
 * Decision: 4 partitions per cron run, one after another on one connection. Each costs an exact replay
 * of its whole journal from birth and one snapshot write, so a run stays a few replays long; a larger
 * backlog drains over later runs. Migration 0030 hands them out least recently attempted first and
 * stamps each pick, so partitions that keep failing take turns with the rest instead of every slot.
 */
const SNAPSHOT_SWEEP_LIMIT = 4;

/**
 * Decision: no partition starts once the run is 20 s old, two thirds of the 30 s CPU limit of a Cron
 * Trigger with an interval under an hour (https://developers.cloudflare.com/workers/platform/limits/).
 * Wall time bounds CPU time from above, so the run stops taking work while a third of the limit is
 * left. Partitions it did not start were stamped with the rest and rejoin the rotation.
 */
const SNAPSHOT_SWEEP_START_DEADLINE_MS = 20_000;

/**
 * Scheduled snapshot maintenance, on its own Cron Trigger (`runtimeBindingManifest.crons`) so
 * its invocation limits are its own: a replay cut off at the CPU limit takes no recovery with it. For
 * each due partition, as its world's system principal, verify the live projection by exact replay and
 * then snapshot the verified head (`maintainPartitionSnapshot`). Never inside a journal transaction;
 * writes only snapshot rows and artifacts, and 0030's attempt stamp. Replay throughput and
 * mismatches, snapshot age, size, creation time and verification result, and artifact metrics go to
 * `METRICS`. A non-integrity failure of one partition is logged by class and counted, and the others
 * still run, unless the shared connection itself is gone.
 */
export async function sweepPartitionSnapshots(
  env: RuntimeEnvironment,
  interval: bigint = SNAPSHOT_INTERVAL_EVENTS,
) {
  return withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", async (client) => {
    const snapshots = new PostgreSqlSnapshotStore(client);
    const shared = {
      snapshots,
      artifacts: composeArtifactStore(env, client),
      birth: new PostgreSqlWorldProvisioningStore(client),
      decodeResource,
      metrics: analyticsEngineMetrics(env.METRICS),
    };
    const counts = {
      written: 0,
      notQuiescent: 0,
      verificationFailures: 0,
      partitionFailures: 0,
      deferred: 0,
    };
    const logger = runtimeLogger(env);
    const started = Date.now();
    const due = await snapshots.duePartitions(interval, SNAPSHOT_SWEEP_LIMIT);
    for (const { authorization, scope } of due) {
      if (Date.now() - started >= SNAPSHOT_SWEEP_START_DEADLINE_MS) {
        counts.deferred += 1;
        continue;
      }
      // Events are read under the partition's own authority, whose ceiling covers its snapshot class.
      const events = new JournalRangeReader(
        new PostgreSqlJournalRangeSource(client, authorization),
        JOURNAL_EVENT_REGISTRY,
      );
      const ports = { ...shared, events };
      try {
        const outcome = await maintainPartitionSnapshot(authorization, scope, ports, logger);
        if (outcome === "written") counts.written += 1;
        else if (outcome === "not-quiescent") counts.notQuiescent += 1;
        else counts.verificationFailures += 1;
      } catch (error) {
        counts.partitionFailures += 1;
        const { tenantId, worldId, timelineId, partitionId } = scope;
        logPartitionSnapshotFailure(
          logger,
          { tenantId, worldId, timelineId, partitionId },
          queueFailureClass(error),
        );
        await client.query("SELECT 1").catch(() => {
          throw error;
        });
      }
    }
    return counts;
  });
}

/**
 * Decision: 30 s per hint pass, the budget Workers gives `waitUntil` work after a response
 * (https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil). The pg client has no
 * connect or query timeout, and the cron sweep owns any rows a hint leaves behind.
 */
const HINT_PASS_DEADLINE_MS = 30_000;

/**
 * In-flight hint sweeps per world in this isolate. An entry older than one pass deadline is stale
 * (its sweep hung, or a Durable Object reset cancelled it before `finally`) and never blocks a hint.
 */
const worldHintSweeps = new Map<string, { rerun: boolean; passStartedAt: number }>();

/**
 * Post-commit wake for the committing world only. It is scheduled with `waitUntil` and never
 * awaited, so a command returns without the sweep's connection, claims or Queue sends. A lost or
 * failed hint costs latency only: the rows stay due for the cron sweep. Hints coalesce per world:
 * a commit during a running sweep requests one more pass instead of another connection.
 */
export function worldReactionNotifier(
  env: RuntimeEnvironment,
  waitUntil: (work: Promise<unknown>) => void,
): DispatchHintNotifier {
  return new DispatchHintNotifier((event) => {
    // No Queue binding means nothing can be published; the scheduled sweep refuses loudly instead.
    if (env.WORLD_REACTIONS_QUEUE === undefined) return;
    // The world's system principal: `system:world:<worldId>` is fixed by the tenant_principals
    // CHECK (0017), and claims still require that principal's world to match each dispatch.
    const authorization: RuntimeAuthorizationContext = {
      tenantId: event.tenantId,
      principalId: decodeOpaqueId(`system:world:${event.worldId}`, "PrincipalId"),
      privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
    };
    const key = JSON.stringify([event.tenantId, event.worldId]);
    const running = worldHintSweeps.get(key);
    if (running !== undefined && Date.now() - running.passStartedAt < HINT_PASS_DEADLINE_MS) {
      running.rerun = true;
      return;
    }
    const entry = { rerun: false, passStartedAt: Date.now() };
    worldHintSweeps.set(key, entry);
    const pass = () =>
      withHyperdrivePostgreSqlClient(env.HYPERDRIVE?.connectionString ?? "", (client) =>
        // Decision: 16 per claim. A command adds one world-reactions dispatch; a larger backlog
        // keeps each lease transaction short and the loop drains only this world's due rows.
        sweepWorldReactions(env, new PostgreSqlDispatchStore(client), authorization, 16),
      );
    const sweep = async () => {
      const logger = runtimeLogger(env);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        do {
          entry.rerun = false;
          entry.passStartedAt = Date.now();
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error("hint sweep deadline"), { code: "ETIMEDOUT" })),
              HINT_PASS_DEADLINE_MS,
            );
          });
          try {
            await Promise.race([pass(), deadline]);
          } catch (error) {
            logWorldReactionSweepFailure(logger, "hint", queueFailureClass(error));
            // A timed-out pass is abandoned, not retried: the database is likely unavailable.
            if ((error as { code?: unknown }).code === "ETIMEDOUT") break;
          } finally {
            clearTimeout(timer);
          }
        } while (entry.rerun && worldHintSweeps.get(key) === entry);
      } finally {
        // A newer sweep may have replaced a stale entry; only the owner clears it.
        if (worldHintSweeps.get(key) === entry) worldHintSweeps.delete(key);
      }
    };
    waitUntil(sweep());
  });
}

/**
 * In-flight activation hint passes per world timeline in this isolate, with the event types still
 * to hint. An entry older than one pass deadline is stale and never blocks a hint.
 */
const activationHints = new Map<string, { types: Set<string>; passStartedAt: number }>();

/**
 * Post-commit wake for the actors whose enabled subscription or threshold names an event type the
 * commit wrote (Wave 5 §5.2: subscriptions wake on events). It reads only which actors those are
 * and asks each actor's owner for a prompt check; the owner reads the journal itself. It is
 * scheduled with `waitUntil` and never awaited. A lost or failed hint costs latency only: the
 * actor's quiet poll still reads the journal. Hints coalesce per world timeline: a commit during a
 * running pass adds its event types to one more pass instead of another connection. A failed pass
 * logs `activation_hint_failed`; one more pass, if a commit asked for it, also retries the failed
 * pass's types, as the world-reactions hint does. A timed-out pass ends the loop.
 */
export function activationHintNotifier(
  env: RuntimeEnvironment,
  waitUntil: (work: Promise<unknown>) => void,
): JournalPostCommitNotifier {
  return {
    async notify(result) {
      const [first] = result.events;
      if (result.outcome === "rejected" || first === undefined) return;
      const types = result.events.map((event) => event.type);
      const key = JSON.stringify([first.tenantId, first.worldId, first.timelineId]);
      const running = activationHints.get(key);
      if (running !== undefined && Date.now() - running.passStartedAt < HINT_PASS_DEADLINE_MS) {
        for (const type of types) running.types.add(type);
        return;
      }
      const entry = { types: new Set(types), passStartedAt: Date.now() };
      activationHints.set(key, entry);
      const authorization: RuntimeAuthorizationContext = {
        tenantId: first.tenantId,
        principalId: decodeOpaqueId(`system:world:${first.worldId}`, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: ["public_scene"] },
      };
      const pass = async (eventTypes: readonly string[]) => {
        const actors = await withHyperdrivePostgreSqlClient(
          env.HYPERDRIVE?.connectionString ?? "",
          (client) => activationEventSubscribers(client, authorization, first, eventTypes),
        );
        await Promise.allSettled(
          actors.map(async ({ actorId, spaceId }) => {
            const route = await runtimeRouteName(
              "actor-agent",
              {
                tenantId: first.tenantId,
                worldId: first.worldId,
                timelineId: first.timelineId,
                spaceId: decodeOpaqueId(spaceId, "SpaceId"),
              },
              decodeOpaqueId(actorId, "SubjectId"),
            );
            await env.ACTOR_AGENT_DO.get(env.ACTOR_AGENT_DO.idFromName(route)).hintActivations();
          }),
        );
      };
      const hint = async () => {
        const logger = runtimeLogger(env);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          while (entry.types.size > 0 && activationHints.get(key) === entry) {
            const eventTypes = [...entry.types];
            entry.types.clear();
            entry.passStartedAt = Date.now();
            const deadline = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(Object.assign(new Error("hint deadline"), { code: "ETIMEDOUT" })),
                HINT_PASS_DEADLINE_MS,
              );
            });
            try {
              await Promise.race([pass(eventTypes), deadline]);
            } catch (error) {
              logActivationHintFailure(
                logger,
                { tenantId: first.tenantId, worldId: first.worldId, timelineId: first.timelineId },
                queueFailureClass(error),
              );
              // A timed-out pass is abandoned, not retried: the database is likely unavailable.
              // The actors' quiet polls still read every event its types named.
              if ((error as { code?: unknown }).code === "ETIMEDOUT") break;
              // A commit during the failed pass asked for one more: it retries these types too.
              if (entry.types.size > 0) for (const type of eventTypes) entry.types.add(type);
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          if (activationHints.get(key) === entry) activationHints.delete(key);
        }
      };
      waitUntil(hint());
    },
  };
}

/** Verification and durable disposition only: this handler executes no world effects. */
export function worldReactionConsumers(env: RuntimeEnvironment): RuntimeQueueConsumers {
  return {
    ...refusingRuntimeQueueConsumers(),
    worldReactions: new TypedQueueConsumer("world-reactions", {
      async handle(message) {
        const disposition = await withHyperdrivePostgreSqlClient(
          env.HYPERDRIVE?.connectionString ?? "",
          (client) => new PostgreSqlDispatchStore(client).consumeWorldReaction(message),
        );
        if (disposition === "invalid") throw new QueueMessageRefusedError("inconsistent");
      },
    }),
  };
}

/** Classification uses structured driver codes; exception text and payloads never enter logs. */
export function queueFailureClass(
  error: unknown,
): "malformed" | "inconsistent" | "transient" | "internal" {
  if (error instanceof QueueMessageRefusedError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (
      /^(08|40|53|57)/u.test(error.code) ||
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(error.code)
    )
      return "transient";
  }
  return "internal";
}
