import type {
  ConversationResponder,
  ShadowDecider,
  WakeTriagePolicy,
} from "@clockgrove/application";
import {
  AuthenticationRefusedError,
  AuthorizationRefusedError,
  type CatchUpWorkflowEnvelope,
  decodeProvisioningSource,
  encodeCanonicalNode,
  InMemoryRuntimeMetrics,
  type LifecycleWorkflowEnvelope,
  type ProvisionWorldRequest,
  provisionWorld,
  type RuntimeMetrics,
  type TurnFiber,
  WorldGenesisDefectError,
  type WorldProvisioningStore,
} from "@clockgrove/application";
import {
  decodeBrowserScope,
  decodeOpaqueId,
  decodePrivacyCategory,
  decodeSceneConnectionAttachment,
  decodeSceneTransientCue,
  NO_SCENE_INTEREST,
} from "@clockgrove/contracts";
import {
  createModelGateway,
  decisionAlias,
  InMemoryModelBudget,
  ScriptedDecider,
  type ScriptedDecisionStep,
} from "@clockgrove/model-gateway";
import {
  type PostgreSqlClient,
  PostgreSqlWorldProvisioningStore,
  ProvisioningFaultInjectedError,
  type ProvisioningFaultPoint,
  sha256Hex,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import {
  type ActivationArming,
  type ActivationArmingStep,
  type BirthWorkflowStepConfig,
  type DurableObjectState,
  ActorAgentDO as ProductionActorAgentDO,
  SpaceDO as ProductionSpaceDO,
  WorldCatchUpWorkflow as ProductionWorldCatchUpWorkflow,
  WorldDO as ProductionWorldDO,
  WorldProvisioningWorkflow as ProductionWorldProvisioningWorkflow,
  WorldReadinessWorkflow as ProductionWorldReadinessWorkflow,
} from "../../src/cloudflare-adapters.js";
import worker, {
  cancelWorldProvisioning,
  composeArtifactStore,
  composeRuntime,
  type DurableObjectNamespace,
  type MessageBatch,
  type RuntimeEnvironment,
  reconcileWorldProvisioning,
  sweepPartitionSnapshots,
  type WorldProvisioningEntrypoint,
} from "../../src/cloudflare-entry.js";
import { gatewayShadowDecider } from "../../src/decision-shadow.js";
import { withHyperdrivePostgreSqlClient } from "../../src/hyperdrive-postgres.js";
import type { OwnerMailboxBounds } from "../../src/mailbox.js";
import { stableRuntimeRouteName } from "../../src/routing.js";
import { signSceneJoin } from "../../src/scene-connections.js";
import { TrustedRuntimeRequestAuthenticator } from "../../src/trusted-composition.js";
import type { RuntimeLocalState, RuntimeScope } from "../../src/types.js";
import { seedProvisioningBirth } from "../../src/workflows.js";
import { unwrapWorldCommandRpc } from "../../src/world-commands.js";

export * from "../../src/cloudflare-entry.js";

const interruptedCases = new Set<string>();
let failCatchUpReconciliation: string | undefined;
let scheduledResult: Awaited<ReturnType<typeof worker.scheduled>> | undefined;
const scheduledCatchUpAttempts: {
  readonly applicationRunId: string;
  readonly outcome: "created" | "provider-outage";
}[] = [];
/**
 * What the composed `analyticsEngineMetrics` writes during scheduled work and `/artifacts` calls, for
 * `/snapshots/metrics`.
 */
const metricPoints: unknown[] = [];
const recordedMetrics = { writeDataPoint: (point: unknown) => void metricPoints.push(point) };

/** Existing store hooks interrupt actual native attempts, rather than simulating a Workflow. */
export class NativeProvisioningStore extends PostgreSqlWorldProvisioningStore {
  constructor(
    client: PostgreSqlClient,
    private readonly envelope: LifecycleWorkflowEnvelope,
  ) {
    if (envelope.caseId === "native-defect") throw new TypeError("native internal defect");
    const points: readonly ProvisioningFaultPoint[] = [
      "genesis",
      "seed-command-0",
      "seed-command-1",
      "projection-verified",
      "ready",
    ];
    const selected = points
      .flatMap((point) =>
        (["before-commit", "after-commit"] as const).map((when) => ({ point, when })),
      )
      .find(
        ({ point, when }) =>
          envelope.caseId === `native-fault:${point}:${when}` ||
          envelope.caseId === `native-exhausted:${point}:${when}`,
      );
    super(
      client,
      selected === undefined || interruptedCases.has(envelope.caseId)
        ? undefined
        : { fault: selected },
    );
  }
  private async interrupted<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ProvisioningFaultInjectedError &&
        !this.envelope.caseId.startsWith("native-exhausted:")
      )
        interruptedCases.add(this.envelope.caseId);
      throw error;
    }
  }
  override recordGenesis(input: Parameters<WorldProvisioningStore["recordGenesis"]>[0]) {
    if (this.envelope.caseId === "native-genesis-defect")
      throw new WorldGenesisDefectError("NATIVE_DEFECT", "genesis", "native deterministic defect");
    return this.interrupted(() => super.recordGenesis(input));
  }
  override applySeedCommand(input: Parameters<WorldProvisioningStore["applySeedCommand"]>[0]) {
    return this.interrupted(() => super.applySeedCommand(input));
  }
  override commitProjectionVerified(
    input: Parameters<WorldProvisioningStore["commitProjectionVerified"]>[0],
  ) {
    return this.interrupted(() => super.commitProjectionVerified(input));
  }
  override commitReady(input: Parameters<WorldProvisioningStore["commitReady"]>[0]) {
    return this.interrupted(() => super.commitReady(input));
  }
}

export class WorldProvisioningWorkflow extends ProductionWorldProvisioningWorkflow {
  protected override stepConfig() {
    return nativeBirthStepConfig(super.stepConfig());
  }
  protected override createProvisioningStore(
    client: PostgreSqlClient,
    envelope: LifecycleWorkflowEnvelope,
  ) {
    return nativeBirthStore(client, envelope, this.env as NativeEnvironment);
  }
}
export class WorldCatchUpWorkflow extends ProductionWorldCatchUpWorkflow {
  protected override stepConfig() {
    return nativeBirthStepConfig(super.stepConfig());
  }
}

export class WorldReadinessWorkflow extends ProductionWorldReadinessWorkflow {
  protected override stepConfig() {
    return nativeBirthStepConfig(super.stepConfig());
  }
  protected override createProvisioningStore(
    client: PostgreSqlClient,
    envelope: LifecycleWorkflowEnvelope,
  ) {
    return nativeBirthStore(client, envelope, this.env as NativeEnvironment);
  }
}

export function nativeBirthStepConfig(config: BirthWorkflowStepConfig): BirthWorkflowStepConfig {
  return { ...config, retries: { ...config.retries, delay: 0 } };
}

export function nativeBirthStore(
  client: PostgreSqlClient,
  envelope: LifecycleWorkflowEnvelope,
  env: NativeEnvironment,
): WorldProvisioningStore {
  return env.NATIVE_PROVISIONING_FAULTS_DISABLED
    ? new PostgreSqlWorldProvisioningStore(client)
    : new NativeProvisioningStore(client, envelope);
}

type CatchUpFault =
  | "none"
  | "after-commit-once"
  | "outage"
  | "hold-result"
  | "hold-error"
  | "hold-failure";

interface AlarmTestControl {
  readonly wallTime: string;
  readonly commandLimit: number;
  readonly enabled?: boolean;
  readonly workflowCatchUp?: boolean;
  /**
   * False lifts `startWithinMs`, so every activation starts exactly `commandLimit` attempts however
   * long a loaded host takes to reach the first one.
   */
  readonly startBudget?: boolean;
}
interface NativeEnvironment extends RuntimeEnvironment {
  readonly PROVISIONING_ENTRY: Pick<WorldProvisioningEntrypoint, "launch">;
  readonly NATIVE_PROVISIONING_FAULTS_DISABLED: boolean;
  readonly WORLD_REACTIONS_QUEUE: RuntimeEnvironment["WORLD_REACTIONS_QUEUE"] & {
    sendBatch(messages: readonly { readonly body: unknown }[]): Promise<void>;
  };
  readonly SPACE_DO: DurableObjectNamespace<SpaceDO>;
  readonly WORLD_DO: DurableObjectNamespace<WorldDO>;
  readonly ACTOR_AGENT_DO: DurableObjectNamespace<ActorAgentDO>;
}

/**
 * Turn crash injection (issue 18): the incarnation ends right after the named phase checkpoint,
 * once per turn and phase, as an eviction or crash there would.
 */
export class ActorAgentDO extends ProductionActorAgentDO {
  private readonly triageScript: string | undefined;
  private readonly triageTurnCost: number | undefined;
  constructor(...args: ConstructorParameters<typeof ProductionActorAgentDO>) {
    super(...args);
    const cost = (
      args[1] as RuntimeEnvironment & { NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD?: string }
    ).NATIVE_WAKE_TRIAGE_FULL_TURN_COST_MICROUSD;
    this.triageTurnCost = cost === undefined ? undefined : Number(cost);
    this.triageScript = (
      args[1] as RuntimeEnvironment & { NATIVE_WAKE_TRIAGE_SCRIPT?: string }
    ).NATIVE_WAKE_TRIAGE_SCRIPT;
  }
  protected override responder(): ConversationResponder {
    const respond = super.responder();
    return async (...args) => {
      const response = await respond(...args);
      return this.triageTurnCost === undefined
        ? response
        : {
            ...response,
            usage: { inputTokens: null, outputTokens: null, costMicrousd: this.triageTurnCost },
          };
    };
  }
  protected override triageDecider(
    policy: WakeTriagePolicy,
    fiber: TurnFiber,
  ): ShadowDecider | undefined {
    const source = this.triageScript;
    if (source === undefined) return super.triageDecider(policy, fiber);
    return {
      pick: async (request) => {
        const steps = JSON.parse(source) as ScriptedDecisionStep[];
        const count = (await this.objectState.storage.get<number>("triage-calls")) ?? 0;
        await this.objectState.storage.put("triage-calls", count + 1);
        const alias = decisionAlias({
          alias: policy.modelAlias,
          model: policy.model,
          maxCostMicrousd: policy.maxCostMicrousd,
        });
        const decider = new ScriptedDecider({
          [alias.route.id]:
            steps[count] === undefined ? [] : [steps[count] as ScriptedDecisionStep],
        });
        const gateway = createModelGateway({
          aliases: [],
          adapters: {},
          decisionAliases: [alias],
          decisionAdapters: { "vercel-ai-gateway": decider },
          budget: new InMemoryModelBudget(() => policy.maxCostMicrousd),
          accounting: { record: () => undefined },
        });
        return gatewayShadowDecider(gateway, {
          tenantId: fiber.scope.tenantId,
          worldId: fiber.scope.worldId,
          actorId: fiber.actorId,
        }).pick(request);
      },
    };
  }

  private held: (() => void) | undefined;
  async injectTurnFault(phase: string | null): Promise<void> {
    await this.objectState.storage.put("test-turn-fault", phase);
  }
  async modelCallsTest(): Promise<number> {
    return (await this.objectState.storage.get<number>("test-model-calls")) ?? 0;
  }
  /** Releases a turn held by a `hold:<phase>` fault, or a callback held at activation planning. */
  async releaseTurn(): Promise<void> {
    this.held?.();
    this.held = undefined;
  }
  /** Armings this incarnation counted: configure's (`initial`) requests, and those in the section. */
  private readonly armings = { configured: 0, started: 0, settled: 0 };
  protected override activationArmingStep(arming: ActivationArming, step: ActivationArmingStep) {
    if (step === "requested") {
      if (arming.initial) this.armings.configured += 1;
    } else this.armings[step] += 1;
  }
  /**
   * Whether a turn or callback is held, how many configure armings were requested, and how many
   * armings are inside the arming section now. One requested but not yet in the section waits for it.
   */
  async armingTest(): Promise<{ held: boolean; configured: number; running: number }> {
    return {
      held: this.held !== undefined,
      configured: this.armings.configured,
      running: this.armings.started - this.armings.settled,
    };
  }
  /** `hold:activation-planning` holds a scheduled callback's last arming before it plans. */
  protected override async activationPlanning(arming: ActivationArming): Promise<void> {
    if (!arming.fromCallback || arming.forceRecovery) return;
    if ((await this.objectState.storage.get("test-turn-fault")) !== "hold:activation-planning")
      return;
    await new Promise<void>((resolve) => {
      this.held = resolve;
    });
  }
  protected override async turnCheckpointed(fiber: TurnFiber, phase: string): Promise<void> {
    const storage = this.objectState.storage;
    if (phase === "model_running:streaming")
      await storage.put("test-model-calls", (await this.modelCallsTest()) + 1);
    const fault = await storage.get<string | null>("test-turn-fault");
    if (fault === `hold:${phase}`) {
      await new Promise<void>((resolve) => {
        this.held = resolve;
      });
      return;
    }
    if (fault !== phase) return;
    const fired = `test-turn-fault:${fiber.sessionId}:${fiber.messageId}:${phase}`;
    if ((await storage.get<boolean>(fired)) === true) return;
    await storage.put(fired, true);
    // Abort drops unflushed writes: flush the marker, so the restarted incarnation passes on.
    await (storage as unknown as { sync(): Promise<void> }).sync();
    this.objectState.abort(`injected turn fault at ${phase}`);
  }
}

/** World inspection adds no production scheduling or mutation path. */
export class WorldDO extends ProductionWorldDO {
  async recordQueueTransport(records: readonly unknown[]) {
    const previous = (await this.state.storage.get<unknown[]>("native-queue-transport")) ?? [];
    await this.state.storage.put("native-queue-transport", [...previous, ...records]);
  }
  async queueTransport() {
    return (await this.state.storage.get<unknown[]>("native-queue-transport")) ?? [];
  }
  async recordDeadLetter(body: unknown, attempts: number) {
    const records = (await this.state.storage.get<unknown[]>("native-dead-letters")) ?? [];
    records.push({ body, attempts });
    await this.state.storage.put("native-dead-letters", records);
  }
  async deadLetters() {
    return (await this.state.storage.get<unknown[]>("native-dead-letters")) ?? [];
  }
  async alarmTestStatus() {
    return this.state.storage.getAlarm();
  }
}

/** Only the native fixture replaces trusted time; delivery still uses the physical DO alarm. */
interface NativeSceneState extends DurableObjectState {
  readonly storage: DurableObjectState["storage"] & {
    list(): Promise<Map<string, unknown>>;
    readonly sql: { exec(query: string): Iterable<{ readonly name: string }> };
  };
}
export class SpaceDO extends ProductionSpaceDO {
  private readonly nativeSceneState: NativeSceneState;
  async sceneStorageTest() {
    const local = await this.state.storage.get<RuntimeLocalState>("runtime-local-state");
    return {
      keys: [...(await this.nativeSceneState.storage.list()).keys()].sort(),
      localFields: Object.keys(local ?? {}).sort(),
      placementFields: Object.keys(local?.placement ?? {}).sort(),
      tables: [
        ...this.nativeSceneState.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ),
      ].map(({ name }) => name),
    };
  }
  private sceneReadRelease: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private sceneReadPending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private sceneReadHeld = false;
  private sceneReadFail = false;
  async sceneHoldTest(fail: boolean) {
    this.sceneReadFail = fail;
    this.sceneReadRelease = Promise.withResolvers<void>();
    return { held: this.sceneReadHeld };
  }
  async sceneReleaseTest() {
    this.sceneReadPending?.resolve();
    this.sceneReadPending = undefined;
    return { released: true };
  }
  async sceneHeldTest() {
    return { held: this.sceneReadHeld };
  }
  private sceneReads = 0;
  async sceneReadsTest() {
    return { reads: this.sceneReads };
  }
  protected override async readScene(
    ...[attachment, authority, from]: Parameters<ProductionSpaceDO["readScene"]>
  ) {
    this.sceneReads += 1;
    const release = this.sceneReadRelease;
    const fail = this.sceneReadFail;
    this.sceneReadRelease = undefined;
    const result = await super.readScene(attachment, authority, from);
    if (release !== undefined) {
      this.sceneReadPending = release;
      this.sceneReadHeld = true;
      await release.promise;
      this.sceneReadHeld = false;
      if (fail) throw new TypeError("native obsolete scene read failure");
    }
    return result;
  }
  async sceneAttachmentsTest() {
    return (this.state.getWebSockets?.() ?? []).map((socket) => {
      const attachment = decodeSceneConnectionAttachment(socket.deserializeAttachment());
      return {
        ...attachment,
        acknowledgedRevision: attachment.acknowledgedRevision?.toString() ?? null,
      };
    });
  }
  /** Local replacement fixture: model the platform restoring its opaque socket attachment. */
  async sceneRestoreTest(value: unknown) {
    const attachment = decodeSceneConnectionAttachment(value);
    const sockets = this.state.getWebSockets?.() ?? [];
    const socket = sockets[0];
    if (sockets.length !== 1 || socket === undefined)
      throw new TypeError("attachment restoration requires exactly one admitted socket");
    socket.serializeAttachment(attachment);
    const [restored] = await this.sceneAttachmentsTest();
    if (restored === undefined) throw new TypeError("restored scene attachment missing");
    return restored;
  }
  async sceneCueTest(cue: unknown) {
    const decoded = decodeSceneTransientCue(cue);
    for (const socket of this.state.getWebSockets?.() ?? [])
      await this.sceneDelivery.cue(socket, decoded);
    return { emitted: true };
  }
  async sceneResetTest() {
    this.sceneDelivery.reset();
    return { reset: true };
  }
  private control: AlarmTestControl = { wallTime: "", commandLimit: 4 };
  private deliveries = 0;
  private completed = 0;
  private failReconciliation = false;
  /** Whether an alarm batch advanced since the interruption was armed. */
  private advanced = false;
  private interruptions = 0;
  private catchUpCalls = 0;
  private catchUpInterruptions = 0;
  private catchUpFault: CatchUpFault = "none";
  private releaseCatchUp: (() => void) | undefined;
  async configureCatchUpTest(fault: CatchUpFault) {
    this.catchUpFault = fault;
    return this.catchUpTestStatus();
  }
  async catchUpTestStatus() {
    return {
      calls: this.catchUpCalls,
      interruptions: this.catchUpInterruptions,
      held: this.releaseCatchUp !== undefined,
    };
  }
  async releaseCatchUpTest() {
    this.catchUpFault = "none";
    this.releaseCatchUp?.();
    this.releaseCatchUp = undefined;
    return this.catchUpTestStatus();
  }
  override async catchUp(envelope: CatchUpWorkflowEnvelope) {
    this.catchUpCalls += 1;
    if (this.catchUpFault === "outage")
      throw new Error("native catch-up infrastructure unavailable");
    let result: Awaited<ReturnType<ProductionSpaceDO["catchUp"]>>;
    try {
      result = await super.catchUp(envelope);
    } catch (error) {
      if (this.catchUpFault === "hold-failure") {
        this.catchUpInterruptions += 1;
        await new Promise<void>((resolve) => {
          this.releaseCatchUp = resolve;
        });
      }
      throw error;
    }
    const fault = this.catchUpFault;
    if (fault === "after-commit-once") {
      this.catchUpFault = "none";
      this.catchUpInterruptions += 1;
      throw new Error("native catch-up interrupted after canonical commit");
    }
    if (fault === "hold-result" || fault === "hold-error") {
      await new Promise<void>((resolve) => {
        this.releaseCatchUp = resolve;
      });
      if (fault === "hold-error") throw new Error("native late catch-up failure");
    }
    return result;
  }
  constructor(state: NativeSceneState, environment: RuntimeEnvironment) {
    super(state, environment);
    this.nativeSceneState = state;
    state.blockConcurrencyWhile(async () => {
      this.control =
        (await state.storage.get<AlarmTestControl>("native-alarm-control")) ?? this.control;
    });
  }
  protected override now(): bigint {
    return this.control.wallTime === "" ? BigInt(Date.now()) : BigInt(this.control.wallTime);
  }
  protected override catchUpEnabled(): boolean {
    return this.control.workflowCatchUp === true;
  }
  protected override activationBudget() {
    const budget = super.activationBudget();
    return {
      maxCommands: this.control.commandLimit,
      startWithinMs:
        this.control.startBudget === false ? Number.POSITIVE_INFINITY : budget.startWithinMs,
    };
  }
  private mailboxTestBounds: OwnerMailboxBounds | null = null;
  protected override mailboxBounds(): OwnerMailboxBounds {
    return this.mailboxTestBounds ?? super.mailboxBounds();
  }
  /** Narrows the production bounds (null restores them) and reads the in-memory mailbox state. */
  async mailboxTest(bounds?: OwnerMailboxBounds | null) {
    if (bounds !== undefined) this.mailboxTestBounds = bounds;
    return this.mailboxState();
  }
  async configureAlarmTest(control: AlarmTestControl, scope: RuntimeScope, schedule: boolean) {
    this.control = { ...control, enabled: schedule };
    await this.state.storage.put("native-alarm-control", this.control);
    if (schedule) await this.reconcileAlarm(scope);
    else await this.state.storage.deleteAlarm();
    return this.alarmTestStatus();
  }
  async interruptAlarmTest(scope: RuntimeScope) {
    this.control = { ...this.control, enabled: true };
    await this.state.storage.put("native-alarm-control", this.control);
    await this.reconcileAlarm(scope);
    this.advanced = false;
    this.failReconciliation = true;
    return this.alarmTestStatus();
  }
  protected override async reconcile(
    ...reconciled: Parameters<ProductionSpaceDO["reconcile"]>
  ): Promise<void> {
    // Only a delivery that committed work takes the interruption: one that spent its start budget
    // before its first attempt reconciles normally, and the next delivery does the work.
    if (this.failReconciliation && this.advanced) {
      this.failReconciliation = false;
      this.interruptions += 1;
      this.control = { ...this.control, enabled: false };
      await this.state.storage.put("native-alarm-control", this.control);
      throw new Error("native interruption after journal commit before alarm reconciliation");
    }
    await super.reconcile(...reconciled);
  }
  private readonly recorded = new InMemoryRuntimeMetrics();
  private readonly observed: RuntimeMetrics = {
    record: (point) => {
      if (point.name === "alarm_batch_ms" && (point.count ?? 0) > 0) this.advanced = true;
      this.recorded.record(point);
    },
  };
  protected override get metrics(): RuntimeMetrics {
    return this.observed;
  }
  /** Drains the points this owner recorded since the last call. */
  async metricsTest() {
    return this.recorded.points.splice(0);
  }
  /** One production alarm activation for `scope`, delivered now rather than at its alarm time. */
  async advanceClockTest(scope: RuntimeScope) {
    await this.state.storage.put("clock-alarm-scope", scope);
    await super.alarm();
    return this.alarmTestStatus();
  }
  async redeliverAlarmTest() {
    await this.state.storage.setAlarm(Date.now());
    return this.alarmTestStatus();
  }
  async alarmTestStatus() {
    return {
      deliveries: this.deliveries,
      completed: this.completed,
      interruptions: this.interruptions,
      alarm: await this.state.storage.getAlarm(),
      ...this.control,
    };
  }
  override async alarm(): Promise<void> {
    if (this.control.enabled === false) return;
    this.deliveries += 1;
    await super.alarm();
    this.completed += 1;
  }
}

/** Observation only: malformed payloads still go to the production envelope decoder. */
export function observedMessageId(body: unknown): unknown {
  return typeof body === "object" && body !== null && "messageId" in body
    ? body.messageId
    : undefined;
}

/** Only the local test bundle exposes inspection and trusted work; public traffic uses production. */
export default {
  async scheduled(controller: { readonly cron: string }, env: NativeEnvironment) {
    const binding = env.WORLD_CATCH_UP_WORKFLOW;
    scheduledCatchUpAttempts.length = 0;
    scheduledResult = undefined;
    const effective =
      binding === undefined
        ? env
        : {
            ...env,
            WORLD_CATCH_UP_WORKFLOW: {
              createBatch: async (
                inputs: Parameters<
                  NonNullable<RuntimeEnvironment["WORLD_CATCH_UP_WORKFLOW"]>["createBatch"]
                >[0],
              ) => {
                for (const { params } of inputs) {
                  if (params.applicationRunId === failCatchUpReconciliation) {
                    scheduledCatchUpAttempts.push({
                      applicationRunId: params.applicationRunId,
                      outcome: "provider-outage",
                    });
                    throw new TypeError("native candidate-specific catch-up provider outage");
                  }
                }
                const created = await binding.createBatch(inputs);
                for (const { params } of inputs)
                  scheduledCatchUpAttempts.push({
                    applicationRunId: params.applicationRunId,
                    outcome: "created",
                  });
                return created;
              },
              get: (id: string) => binding.get(id),
            },
          };
    scheduledResult = await worker.scheduled(controller, {
      ...effective,
      METRICS: recordedMetrics,
    });
    return scheduledResult;
  },
  async queue(batch: MessageBatch, env: NativeEnvironment) {
    if (batch.queue === "rw-production-world-reactions-dlq") {
      const observer = env.WORLD_DO.get(env.WORLD_DO.idFromName("native-dlq-observer"));
      for (const message of batch.messages)
        await observer.recordDeadLetter(message.body, message.attempts);
      return;
    }
    // Native at-least-once duplicate delivery races two fresh production compositions on the
    // first committed batch. Only the first copy owns transport acknowledgement.
    if (
      batch.messages.some(
        ({ body, attempts }) =>
          attempts === 1 && observedMessageId(body) === "queue-first:dispatch:world-reactions",
      )
    ) {
      await Promise.all([
        worker.queue(batch, env),
        worker.queue(
          {
            ...batch,
            messages: batch.messages.map((message) => ({ ...message, ack: () => undefined })),
          },
          env,
        ),
      ]);
      return;
    }
    const records: unknown[] = [];
    if (
      batch.messages.length === 3 &&
      batch.messages.some(
        ({ body }) => typeof body === "object" && body !== null && "privatePayload" in body,
      )
    ) {
      records.push({
        siblings: batch.messages.map(({ body }) => observedMessageId(body) ?? "malformed"),
      });
    }
    await worker.queue(
      {
        ...batch,
        messages: batch.messages.map((message) => ({
          ...message,
          ack: () => {
            if (observedMessageId(message.body) === "queue-ack-loss:dispatch:world-reactions") {
              records.push({
                messageId: observedMessageId(message.body),
                attempt: message.attempts,
                disposition: "ack",
              });
              if (message.attempts === 1)
                throw new Error(
                  "native interruption after durable consumption before acknowledgement",
                );
            }
            message.ack();
          },
          retry: (options: { readonly delaySeconds: number }) => {
            if (
              typeof message.body === "object" &&
              message.body !== null &&
              "privatePayload" in message.body
            )
              records.push({ attempt: message.attempts, delaySeconds: options.delaySeconds });
            if (
              [
                "queue-exhausted:dispatch:world-reactions",
                "queue-internal:dispatch:world-reactions",
              ].includes(String(observedMessageId(message.body)))
            )
              records.push({
                transportMessageId: message.id,
                attempt: message.attempts,
                delaySeconds: options.delaySeconds,
                source: observedMessageId(message.body),
              });
            message.retry(options);
          },
        })),
      },
      env,
    );
    if (records.length > 0) {
      const observer = env.WORLD_DO.get(env.WORLD_DO.idFromName("native-dlq-observer"));
      await observer.recordQueueTransport(records);
    }
  },
  async fetch(request: Request, env: NativeEnvironment): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (
      pathname === "/scene/attachments" ||
      pathname === "/scene/internal" ||
      pathname === "/scene/reset" ||
      pathname === "/scene/cue" ||
      pathname === "/scene/hold" ||
      pathname === "/scene/release" ||
      pathname === "/scene/held" ||
      pathname === "/scene/reads" ||
      pathname === "/scene/storage" ||
      pathname === "/scene/restore"
    ) {
      const url = new URL(request.url);
      const scope = decodeBrowserScope(
        Object.fromEntries(
          ["tenantId", "worldId", "timelineId", "spaceId"].map((key) => [
            key,
            url.searchParams.get(key),
          ]),
        ),
      );
      const name = await stableRuntimeRouteName("space", Object.values(scope));
      const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      if (pathname === "/scene/restore")
        return Response.json(await space.sceneRestoreTest(await request.json()));
      if (pathname === "/scene/storage") return Response.json(await space.sceneStorageTest());
      if (pathname === "/scene/hold")
        return Response.json(await space.sceneHoldTest(url.searchParams.get("fail") === "true"));
      if (pathname === "/scene/release") return Response.json(await space.sceneReleaseTest());
      if (pathname === "/scene/held") return Response.json(await space.sceneHeldTest());
      if (pathname === "/scene/reads") return Response.json(await space.sceneReadsTest());
      if (pathname === "/scene/cue")
        return Response.json(await space.sceneCueTest(await request.json()));
      if (pathname === "/scene/reset") return Response.json(await space.sceneResetTest());
      if (pathname === "/scene/attachments")
        return Response.json(await space.sceneAttachmentsTest());
      const fault = url.searchParams.get("fault");
      const assertion = await signSceneJoin(
        env.BETTER_AUTH_SECRET ?? "",
        {
          principalId: decodeOpaqueId("principal-runtime", "PrincipalId"),
          audience: { ...scope, privacyClass: "public_scene", interest: NO_SCENE_INTEREST },
          protocol: "clockgrove.scene.v1",
          authorityEpoch: fault === "stale" ? 0n : 1n,
        },
        fault === "expired" ? 0 : Date.now(),
      );
      url.pathname = "/v1/projection";
      return space.fetch(
        new Request(url, {
          headers: {
            upgrade: "websocket",
            "sec-websocket-protocol":
              fault === "protocol" ? "clockgrove.scene.v0" : "clockgrove.scene.v1",
            "x-clockgrove-scene-join":
              fault === "forged"
                ? assertion.slice(0, -1) + (assertion.endsWith("0") ? "1" : "0")
                : assertion,
          },
        }),
      );
    }
    if (pathname === "/catch-up/reconciliation-failure") {
      const body = (await request.json()) as { readonly applicationRunId?: string };
      failCatchUpReconciliation = body.applicationRunId;
      return Response.json({ applicationRunId: failCatchUpReconciliation ?? null });
    }
    if (pathname === "/catch-up/reconciliation-status") {
      return Response.json({
        result: scheduledResult ?? null,
        catchUpAttempts: scheduledCatchUpAttempts,
      });
    }
    if (pathname === "/snapshots/sweep") {
      const { interval } = (await request.json()) as { readonly interval: string };
      const traced = { ...env, METRICS: recordedMetrics };
      return Response.json(await sweepPartitionSnapshots(traced, BigInt(interval)));
    }
    if (pathname === "/snapshots/metrics") return Response.json(metricPoints.splice(0));
    if (pathname === "/artifacts") {
      const { op, text, key, reader, privacyClass, ...locator } = (await request.json()) as Record<
        string,
        string
      >;
      if (op === "corrupt") {
        const bytes = new TextEncoder().encode(text);
        const options = {
          sha256: await sha256Hex(bytes),
          httpMetadata: { contentType: "text/plain" },
        };
        await env.ARTIFACTS_BUCKET?.put(key ?? "", bytes, options);
        return Response.json({ corrupted: key });
      }
      const at = locator as never as Parameters<ReturnType<typeof composeArtifactStore>["get"]>[1];
      const authorization = {
        tenantId: decodeOpaqueId(reader ?? at.tenantId, "TenantId"),
        principalId: decodeOpaqueId(`system:world:${at.worldId}`, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: [decodePrivacyCategory("public_scene")] },
      } as const;
      try {
        const result = await withHyperdrivePostgreSqlClient(
          env.HYPERDRIVE?.connectionString ?? "",
          async (client) => {
            const store = composeArtifactStore({ ...env, METRICS: recordedMetrics }, client);
            if (op !== "put")
              return new TextDecoder().decode((await store.get(authorization, at)).bytes);
            const bytes = new TextEncoder().encode(text);
            const input = {
              ...at,
              bytes,
              mediaType: "application/json",
              retentionClass: "durable" as const,
            };
            return store.put(authorization, {
              ...input,
              privacyClass: decodePrivacyCategory(privacyClass),
            } as const);
          },
        );
        return Response.json({ result });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const { reason } = error as { readonly reason?: string };
        return Response.json({ error: error.name, reason: reason ?? null }, { status: 409 });
      }
    }
    if (pathname === "/provisioning/faults") return Response.json([...interruptedCases]);
    if (pathname === "/provisioning/direct") {
      const input = decodeProvisioningSource(await request.json()) as ProvisionWorldRequest;
      try {
        const result = await withHyperdrivePostgreSqlClient(
          env.HYPERDRIVE?.connectionString ?? "",
          (client) =>
            provisionWorld(input, {
              store: new PostgreSqlWorldProvisioningStore(client),
              genesis: { seed: ({ artifact, source }) => seedProvisioningBirth(artifact, source) },
              decodeResource,
            }),
        );
        return Response.json(result);
      } catch (error) {
        if (error instanceof Error) return Response.json({ error: error.name }, { status: 409 });
        throw error;
      }
    }
    if (pathname === "/provisioning/launch") {
      const body = (await request.json()) as {
        readonly request: unknown;
        readonly applicationRunId: string;
      };
      try {
        return Response.json(
          await env.PROVISIONING_ENTRY.launch(
            decodeProvisioningSource(body.request) as ProvisionWorldRequest,
            body.applicationRunId,
          ),
        );
      } catch (error) {
        if (error instanceof Error) return Response.json({ error: error.name }, { status: 409 });
        throw error;
      }
    }
    if (pathname === "/provisioning/reconcile") {
      const envelope = (await request.json()) as LifecycleWorkflowEnvelope;
      return Response.json(await reconcileWorldProvisioning(env, envelope));
    }
    if (pathname === "/provisioning/cancel") {
      const envelope = (await request.json()) as LifecycleWorkflowEnvelope;
      return Response.json(await cancelWorldProvisioning(env, envelope));
    }
    if (
      pathname === "/provisioning/status" ||
      pathname === "/provisioning/terminate" ||
      pathname === "/provisioning/raw"
    ) {
      const body = (await request.json()) as {
        readonly id: string;
        readonly workflow?: "readiness" | "catch-up";
        readonly params?: unknown;
      };
      if (body.workflow === "catch-up") {
        const binding = env.WORLD_CATCH_UP_WORKFLOW;
        if (binding === undefined) throw new Error("native catch-up binding unavailable");
        if (pathname === "/provisioning/raw") {
          await binding.createBatch([
            { id: body.id, params: body.params as CatchUpWorkflowEnvelope },
          ]);
          return Response.json({ id: body.id });
        }
        const instance = await binding.get(body.id);
        if (pathname === "/provisioning/terminate") await instance.terminate();
        return Response.json(await instance.status());
      }
      const binding =
        body.workflow === "readiness"
          ? env.WORLD_READINESS_WORKFLOW
          : env.WORLD_PROVISIONING_WORKFLOW;
      if (pathname === "/provisioning/raw") {
        // Deliberately deliver malformed provider input to the production adapter's decoder.
        await binding.create({ id: body.id, params: body.params as LifecycleWorkflowEnvelope });
        return Response.json({ id: body.id });
      }
      const instance = await binding.get(body.id);
      if (pathname === "/provisioning/terminate") await instance.terminate();
      return Response.json(await instance.status());
    }
    if (pathname.startsWith("/catch-up/")) {
      const body = (await request.json()) as {
        readonly scope: unknown;
        readonly fault: CatchUpFault;
        readonly envelope: CatchUpWorkflowEnvelope;
      };
      const scope = decodeBrowserScope(body.scope);
      const name = await stableRuntimeRouteName("space", Object.values(scope));
      const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      return Response.json(
        pathname === "/catch-up/configure"
          ? await space.configureCatchUpTest(body.fault)
          : pathname === "/catch-up/release"
            ? await space.releaseCatchUpTest()
            : pathname === "/catch-up/deliver"
              ? await space.catchUp(body.envelope)
              : await space.catchUpTestStatus(),
      );
    }
    if (pathname === "/mailbox" || pathname === "/owner-metrics") {
      const body = (await request.json()) as {
        readonly scope: unknown;
        readonly bounds?: OwnerMailboxBounds | null;
      };
      const name = await stableRuntimeRouteName(
        "space",
        Object.values(decodeBrowserScope(body.scope)),
      );
      const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      if (pathname === "/owner-metrics") return Response.json(await space.metricsTest());
      const state = await space.mailboxTest(body.bounds);
      return Response.json(
        JSON.parse(
          JSON.stringify(state, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ),
      );
    }
    if (pathname === "/dispatches/enqueue") {
      const body = await request.json();
      if (Array.isArray(body))
        await env.WORLD_REACTIONS_QUEUE.sendBatch(body.map((body) => ({ body })));
      else await env.WORLD_REACTIONS_QUEUE.send(body);
      return Response.json({ disposition: "enqueued" });
    }
    if (pathname === "/dispatches/transport") {
      const observer = env.WORLD_DO.get(env.WORLD_DO.idFromName("native-dlq-observer"));
      return Response.json(await observer.queueTransport());
    }
    if (pathname === "/dispatches/dlq") {
      const observer = env.WORLD_DO.get(env.WORLD_DO.idFromName("native-dlq-observer"));
      return Response.json(await observer.deadLetters());
    }
    if (
      pathname === "/autonomous/configure" ||
      pathname === "/autonomous/status" ||
      pathname === "/autonomous/redeliver" ||
      pathname === "/autonomous/interrupt"
    ) {
      const body = (await request.json()) as {
        readonly scope: unknown;
        readonly wallTime: string;
        readonly commandLimit: number;
        readonly enabled?: boolean;
        readonly workflowCatchUp?: boolean;
        readonly startBudget?: boolean;
        readonly schedule: boolean;
      };
      const scope = decodeBrowserScope(body.scope);
      const name = await stableRuntimeRouteName("space", Object.values(scope));
      const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      const worldName = await stableRuntimeRouteName("world", [
        scope.tenantId,
        scope.worldId,
        scope.timelineId,
      ]);
      const world = env.WORLD_DO.get(env.WORLD_DO.idFromName(worldName));
      return Response.json(
        pathname === "/autonomous/status"
          ? { ...(await space.alarmTestStatus()), worldAlarm: await world.alarmTestStatus() }
          : pathname === "/autonomous/redeliver"
            ? await space.redeliverAlarmTest()
            : pathname === "/autonomous/interrupt"
              ? await space.interruptAlarmTest(scope)
              : await space.configureAlarmTest(body, scope, body.schedule),
      );
    }
    if (pathname === "/advance-clock") {
      const body: unknown = await request.json();
      const { decodeBrowserScope } = await import("@clockgrove/contracts");
      const scope = decodeBrowserScope(body);
      const name = await stableRuntimeRouteName("space", [
        scope.tenantId,
        scope.worldId,
        scope.timelineId,
        scope.spaceId,
      ]);
      const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(name));
      return Response.json(await space.advanceClockTest(scope));
    }
    if (pathname === "/actor-agent") {
      const identifying = request.clone();
      const body = (await request.json()) as Record<string, unknown>;
      const scope = decodeBrowserScope(body.scope);
      const actorId = String(body.actorId);
      const actor = env.ACTOR_AGENT_DO.get(
        env.ACTOR_AGENT_DO.idFromName(
          await stableRuntimeRouteName("actor-agent", [
            scope.tenantId,
            scope.worldId,
            scope.timelineId,
            actorId,
          ]),
        ),
      );
      if (body.op === "fault")
        return Response.json((await actor.injectTurnFault(body.phase as string | null)) ?? null);
      if (body.op === "release") return Response.json((await actor.releaseTurn()) ?? null);
      if (body.op === "arming") return Response.json(await actor.armingTest());
      if (body.op === "inspect") return Response.json(await actor.inspectAgent());
      if (body.op === "model-calls") return Response.json(await actor.modelCallsTest());
      if (body.op === "capabilities")
        return Response.json(await actor.reconcileCapabilities(Number(body.revision)));
      if (body.op === "perception")
        return Response.json(
          await actor.receivePerception({
            kind: "direct_message",
            sessionId: String(body.sessionId),
            messageId: String(body.messageId),
          }),
        );
      const auth = new TrustedRuntimeRequestAuthenticator(composeRuntime(env).authentication);
      const context = await auth.authorize(
        await auth.identify(identifying),
        {
          requestId: "native-actor-process",
          correlationId: decodeOpaqueId("native-actor-process", "CorrelationId"),
        },
        "runtime:world-observe",
      );
      return Response.json(
        await actor.advanceProcess(scope, context, {
          processId: String(body.processId),
          actorId,
          target: Number(body.target),
          steps: Number(body.steps),
        }),
      );
    }
    if (pathname !== "/inspect" && pathname !== "/resume") return worker.fetch(request, env);
    try {
      const auth = new TrustedRuntimeRequestAuthenticator(composeRuntime(env).authentication);
      const identified = await auth.identify(request);
      const context = await auth.authorize(
        identified,
        {
          requestId: "native-inspection",
          correlationId: decodeOpaqueId("native-inspection", "CorrelationId"),
        },
        "runtime:world-command",
      );
      if (
        context.worldId === undefined ||
        context.timelineId === undefined ||
        context.spaceId === undefined
      )
        throw new Error("world context required");
      const scope = {
        tenantId: context.tenantId,
        worldId: context.worldId,
        timelineId: context.timelineId,
        spaceId: context.spaceId,
      };
      const worldName = await stableRuntimeRouteName("world", [
        scope.tenantId,
        scope.worldId,
        scope.timelineId,
      ]);
      const spaceName = await stableRuntimeRouteName("space", Object.values(scope));
      const worldId = env.WORLD_DO.idFromName(worldName);
      const spaceId = env.SPACE_DO.idFromName(spaceName);
      const world = env.WORLD_DO.get(worldId);
      const space = env.SPACE_DO.get(spaceId);
      const result =
        pathname === "/resume"
          ? unwrapWorldCommandRpc(await world.resumeWorldCommand(scope, context))
          : {
              worldId: worldId.toString(),
              spaceId: spaceId.toString(),
              worldName,
              spaceName,
              local: Object.fromEntries(
                Object.entries(unwrapWorldCommandRpc(await space.initialize(scope, context))),
              ),
              partition: Object.fromEntries(
                Object.entries(await space.inspectWorld(scope, context)),
              ),
            };
      return Response.json(
        encodeCanonicalNode(
          result === undefined ? null : Object.fromEntries(Object.entries(result)),
        ),
      );
    } catch (error) {
      if (error instanceof AuthenticationRefusedError)
        return Response.json({ error: "authentication_refused" }, { status: 401 });
      if (error instanceof AuthorizationRefusedError)
        return Response.json({ error: "authorization_refused" }, { status: 403 });
      throw error;
    }
  },
};
