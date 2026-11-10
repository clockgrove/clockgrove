import {
  AuthorizationRefusedError,
  advanceDueWork,
  allowDecision,
  CanonicalNodeError,
  type CatchUpWorkflowEnvelope,
  type CatchUpWorkflowOperation,
  type ClockCommand,
  canonicalBytes,
  catchUpWorkflowReference,
  clockEarnedSimulationTime,
  continueWorldCommand,
  decodeCanonicalNode,
  decodeClockCommand,
  denyDecision,
  encodeCanonicalNode,
  executeWorldCommand,
  isClockCommand,
  isTrustedId,
  type JournalPostCommitNotifier,
  JournalRevisionConflictError,
  type JournalRevisionConflictKind,
  JournalRouteNotFoundError,
  NO_METRICS,
  NO_PRIVACY_CEILING,
  PartitionStateIntegrityError,
  type PartitionStateIntegrityReason,
  plainValue,
  type RuntimeAuthorizationContext,
  type RuntimeAuthorizationDenial,
  type RuntimeFailureClass,
  type RuntimeLogger,
  type RuntimeLogIds,
  type RuntimeMetrics,
  recordMetric,
  restoreWorldCommandValue,
  runtimeLogRecord,
  validateWorldBehaviorPack,
  type WorldBehaviorPack,
  type WorldCommandResult,
  type WorldCommandValue,
  WorldContinuationPendingError,
  WorldTimeWorkPendingError,
} from "@clockgrove/application";
import type { SimTimeMs } from "@clockgrove/contracts";
import {
  type CommandEnvelope,
  type CommandId,
  CommandIdempotencyInvariantError,
  ContractDecodeError,
  decodeBrowserScope,
  decodeCommandEnvelope,
  decodeOpaqueId,
  type WorldPersonaId,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import { worldContinuousAt } from "@clockgrove/kernel";
import {
  type ClockOwnerState,
  databaseFailureClass,
  PostgreSqlCatchUpWorkflowStore,
  type PostgreSqlClient,
  PostgreSqlClockAdmissionReader,
  PostgreSqlDueWorkReader,
  PostgreSqlJournal,
  PostgreSqlWorldCommandJournal,
  PostgreSqlWorldOwnerReader,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { OwnerMailboxError, type OwnerMailboxRefusal } from "./mailbox.js";
import { StoredRejectionError } from "./owners.js";
import {
  RuntimeEpochConflictError,
  type RuntimeEpochs,
  RuntimeRouteNotFoundError,
  type RuntimeScope,
} from "./types.js";

export interface WorldCommandInput {
  readonly clockCommand?: ClockCommand;
  readonly scope: RuntimeScope;
  readonly epochs: RuntimeEpochs;
  readonly command: CommandEnvelope<string, unknown>;
}

/** Strict transport boundary; domain payload validation belongs to the application kernel. */
export function decodeWorldCommandInput(value: unknown): WorldCommandInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ContractDecodeError("request", "object required");
  const input = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "tenantId",
    "worldId",
    "timelineId",
    "spaceId",
    "routingEpoch",
    "authorityEpoch",
    "command",
  ];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    input.schemaVersion !== 1
  )
    throw new ContractDecodeError("request", "invalid envelope");
  const scope = decodeBrowserScope({
    tenantId: input.tenantId,
    worldId: input.worldId,
    timelineId: input.timelineId,
    spaceId: input.spaceId,
  });
  if (
    typeof input.routingEpoch !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(input.routingEpoch) ||
    typeof input.authorityEpoch !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(input.authorityEpoch)
  )
    throw new ContractDecodeError("epochs", "canonical decimal strings required");
  const command = decodeCommandEnvelope<string, unknown>(
    plainValue(decodeCanonicalNode(input.command)),
    {
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      kind: "world",
      id: scope.worldId,
    },
    (payload) => payload,
  );
  if (JSON.stringify(encodeCanonicalNode(command)) !== JSON.stringify(input.command))
    throw new CanonicalNodeError("command node is not canonical");
  if (isTrustedId(command.commandId))
    throw new ContractDecodeError("command.commandId", "reserved for trusted commands");
  return {
    scope,
    epochs: {
      routingEpoch: BigInt(input.routingEpoch),
      authorityEpoch: BigInt(input.authorityEpoch),
    },
    command,
    ...(isClockCommand(command.type)
      ? { clockCommand: decodeClockCommand(command.type, command.payload) }
      : {}),
  };
}

/** The fields a server-built command's server chooses; a retry reuses the first attempt's. */
export interface BuiltCommandFields {
  readonly epochs: RuntimeEpochs;
  readonly issuedAt?: string;
  readonly context?: { readonly correlationId: string; readonly requestId: string };
}

export interface PreparedBuiltCommand {
  readonly tenantMember: boolean;
  readonly ready: boolean;
  readonly input?: WorldCommandInput;
  readonly stored?: WorldCommandResult;
  readonly storedPersonaId?: WorldPersonaId;
}

/** Reads the server-chosen fields back out of a receipt's canonical command bytes. */
function builtFieldsOf(bytes: Uint8Array, commandId: CommandId): BuiltCommandFields {
  const field = (node: unknown, key: string): unknown => {
    if (!Array.isArray(node) || node[0] !== "record" || !Array.isArray(node[1]))
      throw new CommandIdempotencyInvariantError(commandId);
    return (node[1] as [string, unknown][]).find(([name]) => name === key)?.[1];
  };
  const leaf = (node: unknown, kind: "string" | "bigint"): string => {
    if (!Array.isArray(node) || node[0] !== kind || typeof node[1] !== "string")
      throw new CommandIdempotencyInvariantError(commandId);
    return node[1];
  };
  const [, root] = JSON.parse(new TextDecoder().decode(bytes)) as [string, unknown];
  const epochs = field(root, "epochs");
  const command = field(root, "command");
  const context = field(command, "context");
  return {
    epochs: {
      routingEpoch: BigInt(leaf(field(epochs, "routingEpoch"), "bigint")),
      authorityEpoch: BigInt(leaf(field(epochs, "authorityEpoch"), "bigint")),
    },
    issuedAt: leaf(field(command, "issuedAt"), "string"),
    context: {
      correlationId: leaf(field(context, "correlationId"), "string"),
      requestId: leaf(field(context, "requestId"), "string"),
    },
  };
}

/** Receipt identity includes authenticated principal and epoch preconditions, independently of grants. */
export function worldCommandBytes(input: WorldCommandInput, principalId: string): Uint8Array {
  return canonicalBytes({
    schemaVersion: 1,
    scope: input.scope,
    epochs: input.epochs,
    command: input.command,
    principalId,
  });
}

export function worldAuthorization(context: TrustedExecutionContext): RuntimeAuthorizationContext {
  return {
    tenantId: context.tenantId,
    principalId: context.principalId,
    privacyCeiling: context.privacyCeiling,
  };
}

export class PostgreSqlCommandOwner {
  readonly reader: PostgreSqlWorldOwnerReader;
  constructor(
    private readonly client: PostgreSqlClient,
    private readonly metrics: RuntimeMetrics = NO_METRICS,
    private readonly notifier?: JournalPostCommitNotifier,
  ) {
    this.reader = new PostgreSqlWorldOwnerReader(client);
  }
  async stored(input: WorldCommandInput, principalId: import("@clockgrove/contracts").PrincipalId) {
    return (await this.storedWithAttribution(input, principalId))?.result;
  }
  private async storedWithAttribution(
    input: WorldCommandInput,
    principalId: import("@clockgrove/contracts").PrincipalId,
  ) {
    const principal = principalId;
    const stored = await new PostgreSqlJournal(this.client).storedOutcome<WorldCommandValue>(
      {
        tenantId: input.scope.tenantId,
        principalId: principal,
        privacyCeiling: NO_PRIVACY_CEILING,
      },
      input.command.commandId,
      worldCommandBytes(input, principal),
    );
    if (stored === undefined) return undefined;
    return {
      result: {
        commandId: input.command.commandId,
        outcome: stored.status,
        value: restoreWorldCommandValue(stored.result.value),
        events: stored.result.events,
      } satisfies WorldCommandResult,
      personaId: stored.attribution?.personaId,
    };
  }
  /**
   * Prepares a command the server builds (an Influence intent, issue 811) in this one connection:
   * membership, then either the prior attempt's server-chosen fields or the space's epochs, then
   * the stored receipt or readiness. A retry of the same intent rebuilds the same accepted bytes,
   * so it replays; different bytes under the same command ID are a reuse.
   */
  async prepareBuilt(
    scope: RuntimeScope,
    principalId: import("@clockgrove/contracts").PrincipalId,
    commandId: CommandId,
    build: (fields: BuiltCommandFields) => WorldCommandInput,
  ): Promise<PreparedBuiltCommand> {
    const authorization = {
      tenantId: scope.tenantId,
      principalId,
      privacyCeiling: NO_PRIVACY_CEILING,
    };
    if (!(await this.reader.isTenantMember(authorization, scope)))
      return { tenantMember: false, ready: false };
    const prior = await new PostgreSqlJournal(this.client).storedCommandBytes(
      authorization,
      commandId,
    );
    if (prior !== undefined) {
      const input = build(builtFieldsOf(prior, commandId));
      const bytes = worldCommandBytes(input, principalId);
      if (bytes.length !== prior.length || bytes.some((octet, index) => octet !== prior[index]))
        throw new CommandIdempotencyInvariantError(commandId);
      const stored = await this.storedWithAttribution(input, principalId);
      if (stored !== undefined) {
        const { personaId, result } = stored;
        return {
          tenantMember: true,
          ready: true,
          input,
          stored: result,
          ...(personaId === undefined ? {} : { storedPersonaId: personaId }),
        };
      }
      return { tenantMember: true, ready: await this.reader.isReady(authorization, scope), input };
    }
    const route = await this.reader.route(authorization, scope);
    const input = build({
      epochs: { routingEpoch: route.routingEpoch, authorityEpoch: route.routingEpoch },
    });
    return { tenantMember: true, ready: await this.reader.isReady(authorization, scope), input };
  }
  async deny(
    input: WorldCommandInput,
    principalId: import("@clockgrove/contracts").PrincipalId,
    denial: RuntimeAuthorizationDenial,
  ): Promise<WorldCommandResult> {
    const authorization = {
      tenantId: input.scope.tenantId,
      principalId,
      privacyCeiling: NO_PRIVACY_CEILING,
    };
    let canonical: Awaited<ReturnType<PostgreSqlWorldOwnerReader["route"]>>;
    try {
      canonical = await this.reader.route(authorization, input.scope);
    } catch (error) {
      // An unauthorized caller learns nothing about placement: an unknown space answers exactly
      // like a recorded denial, without a durable effect.
      if (!(error instanceof JournalRouteNotFoundError)) throw error;
      return {
        commandId: input.command.commandId,
        outcome: "rejected",
        value: { status: "denied", reasonCode: denial.reasonCode },
        events: [],
      } as WorldCommandResult;
    }
    const command: CommandEnvelope<string, unknown> = {
      ...input.command,
      attribution: {
        effectiveActorId: input.command.attribution.effectiveActorId,
        causalRootActionId: input.command.attribution.causalRootActionId,
        principalId,
        ...(denial.inputs.worldMembershipId === undefined
          ? {}
          : { worldMembershipId: denial.inputs.worldMembershipId }),
        ...(denial.inputs.personaId === undefined ? {} : { personaId: denial.inputs.personaId }),
      },
    };
    return executeWorldCommand(
      {
        authorization,
        command,
        ...(input.clockCommand === undefined
          ? {}
          : { clockCommand: input.clockCommand, trustedWallTime: () => BigInt(Date.now()) }),
        commandBytes: worldCommandBytes(input, principalId),
        route: {
          partitionId: canonical.partitionId,
          spaceId: input.scope.spaceId,
          streamId: canonical.streamId,
        },
        authorityDecision: denyDecision(
          {
            ...input.scope,
            commandId: command.commandId,
            attribution: command.attribution,
            inputs: denial.inputs,
          },
          denial.reasonCode,
        ),
      },
      {
        journal: new PostgreSqlWorldCommandJournal(
          this.client,
          this.notifier,
          {},
          undefined,
          input.epochs,
          undefined,
          undefined,
          this.metrics,
        ),
        behavior: { behaviorFor: () => this.behavior(authorization, input.scope) },
      },
    );
  }
  async submit(
    input: WorldCommandInput,
    context: TrustedExecutionContext,
    trustedWallTime = () => BigInt(Date.now()),
    ownerGeneration?: bigint,
  ): Promise<WorldCommandResult> {
    if (input.clockCommand !== undefined || isClockCommand(input.command.type))
      return this.submitAt(input, context, trustedWallTime, ownerGeneration);
    const budget = { used: 0 };
    for (;;) {
      const run = await this.catchUpToEarned(
        input.scope,
        trustedWallTime(),
        ownerGeneration,
        budget,
      );
      try {
        return await this.submitAt(input, context, trustedWallTime, ownerGeneration, run);
      } catch (error) {
        if (run === undefined) throw error;
        if (error instanceof WorldTimeWorkPendingError) {
          // The boundaries ran as their own step; the command's transaction runs again after them.
          await this.boundaryStep(input.scope, trustedWallTime(), ownerGeneration, budget);
          this.retried(input.scope, "catching_up");
        }
        // A pause or speed change between catch-up and the command: catch up again.
        else if (
          !(error instanceof JournalRevisionConflictError && error.kind === "clock-policy") ||
          ++budget.used > OVERDUE_DEADLINE_LIMIT
        )
          throw error;
        else this.retried(input.scope);
      }
    }
  }

  private async submitAt(
    input: WorldCommandInput,
    context: TrustedExecutionContext,
    trustedWallTime: () => bigint,
    ownerGeneration: bigint | undefined,
    run?: Readonly<{ earned: bigint; policyVersion: bigint }>,
  ): Promise<WorldCommandResult> {
    assertWorldCommandContext(context, input.scope, worldCommandGrant(input));
    const authorization = worldAuthorization(context);
    const canonical = await this.reader.route(authorization, input.scope);
    const command: CommandEnvelope<string, unknown> = {
      ...input.command,
      attribution: {
        effectiveActorId: input.command.attribution.effectiveActorId,
        causalRootActionId: input.command.attribution.causalRootActionId,
        principalId: context.principalId,
        ...(context.worldMembershipId === undefined
          ? {}
          : { worldMembershipId: context.worldMembershipId }),
        ...(context.personaId === undefined ? {} : { personaId: context.personaId }),
      },
    };
    return executeWorldCommand(
      {
        authorization,
        command,
        ...(input.clockCommand === undefined
          ? {}
          : { clockCommand: input.clockCommand, trustedWallTime }),
        ...(run === undefined ? {} : { runAt: run.earned }),
        commandBytes: worldCommandBytes(input, context.principalId),
        route: {
          partitionId: canonical.partitionId,
          spaceId: input.scope.spaceId,
          streamId: canonical.streamId,
        },
        authorityDecision: allowDecision({
          ...input.scope,
          commandId: command.commandId,
          attribution: command.attribution,
          inputs: {
            principalId: context.principalId,
            roles: context.roles,
            grants: context.grants,
            privacyCeiling: context.privacyCeiling,
            ...(context.worldMembershipId === undefined
              ? {}
              : { worldMembershipId: context.worldMembershipId }),
            ...(context.personaId === undefined ? {} : { personaId: context.personaId }),
          },
        }),
      },
      {
        journal: new PostgreSqlWorldCommandJournal(
          this.client,
          this.notifier,
          {},
          undefined,
          input.epochs,
          run?.policyVersion,
          ownerGeneration,
          this.metrics,
        ),
        behavior: { behaviorFor: () => this.behavior(authorization, input.scope) },
      },
    );
  }
  /**
   * Before a client command: run the overdue due work (due at or before earned time) as the alarm
   * would, one deadline per transaction, and return the earned time to run the command at. The fast
   * path is the one owner read. A paused clock earns nothing: `undefined`, and the command runs at
   * the stored time. Each step re-reads the owner, so progress by a concurrent alarm or catch-up
   * counts and a pause between steps is seen. More than `OVERDUE_DEADLINE_LIMIT` steps refuse with
   * `WorldCatchingUpError`.
   */
  async catchUpToEarned(
    scope: RuntimeScope,
    wallTime: bigint,
    ownerGeneration?: bigint,
    budget = { used: 0 },
  ) {
    let owner = await this.reader.clockOwner(scope, ownerGeneration);
    for (;;) {
      if (owner === undefined || !owner.policy.running) return undefined;
      const earned = clockEarnedSimulationTime(owner.policy, wallTime);
      if (!owner.continuation && (owner.nextDueAt === null || owner.nextDueAt > earned))
        return earned > owner.simulationTime
          ? { earned, policyVersion: owner.policy.version }
          : undefined;
      if (budget.used++ >= OVERDUE_DEADLINE_LIMIT) throw new WorldCatchingUpError();
      try {
        await this.dueWorkStep(owner, scope, ownerGeneration, nextThrough(owner));
      } catch (error) {
        // Another writer got there first: re-read below and decide on what is left.
        if (
          !(
            error instanceof JournalRevisionConflictError &&
            (error.kind === "partition" || error.kind === "clock-policy")
          )
        )
          throw error;
        this.retried(scope);
      }
      owner = await this.reader.clockOwner(scope, ownerGeneration);
    }
  }

  /**
   * Environment boundaries up to earned time as one trusted lazy advance (boundary events only, no
   * per-actor integration). It counts as a step; a refused or incomplete advance (event budget)
   * refuses the command with `WorldCatchingUpError`.
   */
  private async boundaryStep(
    scope: RuntimeScope,
    wallTime: bigint,
    ownerGeneration: bigint | undefined,
    budget: { used: number },
  ) {
    if (budget.used++ >= OVERDUE_DEADLINE_LIMIT) throw new WorldCatchingUpError();
    // Earned time comes from the same policy read the step runs under. A clock-policy conflict
    // (pause or speed change since the read) retries once with a fresh read, as the command step does.
    let result: Awaited<ReturnType<typeof this.dueWorkStep>>;
    for (let attempt = 0; ; attempt++) {
      const owner = await this.reader.clockOwner(scope, ownerGeneration);
      if (owner === undefined || !owner.policy.running) return;
      const earned = clockEarnedSimulationTime(owner.policy, wallTime);
      try {
        result = await this.dueWorkStep(owner, scope, ownerGeneration, earned, true);
        break;
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof JournalRevisionConflictError && error.kind === "clock-policy")
        )
          throw error;
        this.retried(scope);
      }
    }
    const last = result.commands.at(-1)?.value;
    if (result.status === "refused" || (last?.status === "committed" && !last.complete))
      throw new WorldCatchingUpError();
  }

  /** One due-work command under the owner's generation and policy version: what the alarm runs. */
  private dueWorkStep(
    owner: ClockOwnerState,
    scope: RuntimeScope,
    ownerGeneration: bigint | undefined,
    through: bigint,
    settle = false,
  ) {
    const { authorization, policy } = owner;
    return advanceDueWork(
      {
        authorization,
        target: scope,
        route: {
          partitionId: owner.partitionId,
          spaceId: scope.spaceId,
          streamId: owner.streamId,
        },
        through,
        maxCommands: 1,
        settle,
      },
      {
        journal: new PostgreSqlWorldCommandJournal(
          this.client,
          this.notifier,
          {},
          undefined,
          { routingEpoch: owner.routingEpoch, authorityEpoch: owner.routingEpoch },
          policy.version,
          ownerGeneration,
          this.metrics,
        ),
        behavior: { behaviorFor: () => this.behavior(authorization, scope) },
        dueWork: new PostgreSqlDueWorkReader(this.client),
        metrics: this.metrics,
      },
    );
  }

  /** One command transaction run again: after a revision conflict, or after its boundary step. */
  private retried(
    scope: RuntimeScope,
    label: "revision_conflict" | "catching_up" = "revision_conflict",
  ): void {
    recordMetric(this.metrics, {
      name: "transaction_retries",
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      label,
      value: 1,
    });
  }

  /** The owner generation a native incarnation observes before its first claim attempt. */
  async clockOwnerGeneration(scope: RuntimeScope): Promise<bigint> {
    return new PostgreSqlClockAdmissionReader(this.client).ownerGeneration(
      await this.clockAuthorization(scope),
      scope,
    );
  }

  /** A native incarnation claims one fenced generation before it can run autonomous work. */
  async claimClockOwner(
    scope: RuntimeScope,
    ownerId: string,
    observedGeneration: bigint,
  ): Promise<bigint> {
    return new PostgreSqlClockAdmissionReader(this.client).claimOwner(
      await this.clockAuthorization(scope),
      scope,
      ownerId,
      observedGeneration,
    );
  }

  private async clockAuthorization(scope: RuntimeScope) {
    const authorization = await this.reader.autonomousAuthorization(scope);
    if (authorization === undefined)
      throw new AuthorizationRefusedError("ready clock scope required");
    return authorization;
  }

  /** Register only from the physical owner, using its world system principal and durable fences. */
  async registerCatchUp(
    scope: RuntimeScope,
    ownerGeneration: bigint,
    wallTime: bigint,
    policyVersion: bigint,
    applicationRunId?: CatchUpWorkflowEnvelope["applicationRunId"],
  ) {
    return new PostgreSqlCatchUpWorkflowStore(this.client).register(
      await this.clockAuthorization(scope),
      scope,
      {
        ownerGeneration,
        policyVersion,
        wallTime,
        ...(applicationRunId === undefined ? {} : { applicationRunId }),
      },
    );
  }

  async currentCatchUp(scope: RuntimeScope, ownerGeneration: bigint) {
    const owner = await this.reader.clockOwner(scope, ownerGeneration);
    if (owner === undefined || !owner.policy.running) return undefined;
    const operation = await new PostgreSqlCatchUpWorkflowStore(this.client).current(
      owner.authorization,
      scope,
    );
    return operation?.policyVersion === owner.policy.version ? operation : undefined;
  }

  readCatchUp(envelope: CatchUpWorkflowEnvelope) {
    return new PostgreSqlCatchUpWorkflowStore(this.client).read(envelope);
  }

  async finishCatchUp(operation: CatchUpWorkflowOperation, complete: boolean) {
    return new PostgreSqlCatchUpWorkflowStore(this.client).advance(
      await this.clockAuthorization(operation),
      catchUpWorkflowReference(operation),
      { ...operation, complete },
    );
  }

  /** Due deadlines and accepted continuations, rather than elapsed physical deltas, define work. */
  async catchUpPending(scope: RuntimeScope, wallTime: bigint, ownerGeneration: bigint) {
    const owner = await this.reader.clockOwner(scope, ownerGeneration);
    if (owner === undefined || !owner.policy.running) return false;
    return (
      owner.continuation ||
      (owner.nextDueAt !== null &&
        owner.nextDueAt <= clockEarnedSimulationTime(owner.policy, wallTime))
    );
  }

  /** Recoverable alarm mapping; deadlines and admitted horizon are canonical database facts. */
  async clockAlarmPlan(
    scope: RuntimeScope,
    wallTime = BigInt(Date.now()),
    ownerGeneration?: bigint,
  ) {
    const owner = await this.reader.clockOwner(scope, ownerGeneration);
    if (owner === undefined) throw new AuthorizationRefusedError("ready clock scope required");
    const { policy, horizon, nextDueAt } = owner;
    if (!policy.running || (!owner.continuation && nextDueAt === null))
      return { policyVersion: policy.version, nextAlarmAt: null };
    const earned = clockEarnedSimulationTime(policy, wallTime);
    const immediate =
      owner.continuation ||
      (nextDueAt !== null && nextDueAt <= horizon) ||
      (nextDueAt !== null && nextDueAt <= earned && earned > horizon);
    const nextDue = nextDueAt ?? owner.simulationTime;
    const deficit = nextDue > earned ? nextDue - earned : 0n;
    const speed = BigInt(policy.simulationMillisecondsPerWallMillisecond);
    const delay = immediate ? 0n : (deficit + speed - 1n) / speed;
    // Date's maximum timestamp is also within the integer-safe range used by native alarms.
    const deadline = BigInt(Date.now()) + delay;
    return {
      policyVersion: policy.version,
      nextAlarmAt: Number(deadline < 8_640_000_000_000_000n ? deadline : 8_640_000_000_000_000n),
    };
  }

  /** One trusted command attempt; an activation admits once, independently of physical targets. */
  async advanceClock(scope: RuntimeScope, wallTime = BigInt(Date.now()), activation?: Activation) {
    let owner: ClockOwnerState | undefined;
    try {
      owner = await this.activate(scope, wallTime, activation);
    } catch (error) {
      // The activation's own owner-generation and policy checks answer no request. A conflict the
      // due-work journal finds is recorded by the journal.
      if (error instanceof JournalRevisionConflictError)
        recordMetric(this.metrics, {
          name: "autonomous_conflicts",
          tenantId: scope.tenantId,
          worldId: scope.worldId,
          label: error.kind,
          value: 1,
        });
      throw error;
    }
    if (owner === undefined) return { status: "idle", commands: [] } as const;
    // A cap or late delivery must never create a new physical integration boundary.
    // Open continuations ignore this hint and retain their accepted immutable target.
    return this.dueWorkStep(owner, scope, activation?.ownerGeneration, nextThrough(owner));
  }

  /** The activation's checks and admission: the owner when due work waits, else undefined. */
  private async activate(scope: RuntimeScope, wallTime: bigint, activation?: Activation) {
    const owner = await this.reader.clockOwner(scope, activation?.ownerGeneration);
    if (owner === undefined) throw new AuthorizationRefusedError("ready clock scope required");
    const { authorization, policy } = owner;
    if (activation !== undefined && activation.policyVersion !== policy.version)
      throw new JournalRevisionConflictError(
        "clock-policy",
        activation.policyVersion,
        policy.version,
      );
    if (!policy.running) return undefined;
    // Projection lag: how long the partition state has trailed its clock, from the earliest
    // pending due time the clock has already earned; zero when no earned work is pending.
    const earned = clockEarnedSimulationTime(policy, wallTime);
    const behind =
      owner.nextDueAt !== null && owner.nextDueAt < earned ? earned - owner.nextDueAt : 0n;
    recordMetric(this.metrics, {
      name: "projection_lag_ms",
      tenantId: scope.tenantId,
      worldId: scope.worldId,
      label: "partition-state",
      value: Number(behind / BigInt(policy.simulationMillisecondsPerWallMillisecond)),
      count: Number(behind),
    });
    const horizon =
      activation?.admit === false
        ? owner.horizon
        : (
            await new PostgreSqlClockAdmissionReader(this.client).admit(authorization, scope, {
              activationId: activation?.activationId ?? crypto.randomUUID(),
              policyVersion: policy.version,
              ...(activation?.ownerGeneration === undefined
                ? {}
                : { ownerGeneration: activation.ownerGeneration }),
              wallTime,
            })
          ).horizon;
    // Admission moves only the horizon; due work re-reads pending work and re-checks under its locks.
    return !owner.continuation && (owner.nextDueAt === null || owner.nextDueAt > horizon)
      ? undefined
      : owner;
  }

  async resume(
    scope: RuntimeScope,
    context: TrustedExecutionContext,
    ownerGeneration?: bigint,
  ): Promise<WorldCommandResult | undefined> {
    assertWorldCommandContext(context, scope);
    const authorization = worldAuthorization(context);
    const canonical = await this.reader.route(authorization, scope);
    return continueWorldCommand(
      {
        authorization,
        target: scope,
        route: {
          partitionId: canonical.partitionId,
          spaceId: scope.spaceId,
          streamId: canonical.streamId,
        },
      },
      {
        journal: new PostgreSqlWorldCommandJournal(
          this.client,
          this.notifier,
          {},
          undefined,
          {
            routingEpoch: canonical.routingEpoch,
            authorityEpoch: canonical.routingEpoch,
          },
          undefined,
          ownerGeneration,
          this.metrics,
        ),
        behavior: { behaviorFor: () => this.behavior(authorization, scope) },
        dueWork: new PostgreSqlDueWorkReader(this.client),
      },
    );
  }
  /**
   * The stored state, unchanged, with a derived view beside it: the continuous values (needs,
   * wellbeing, plant growth) at earned time, from the kernel's lazy integration. Not canonical and
   * never written; a paused clock's earned time is its retained time.
   */
  async inspect(authorization: RuntimeAuthorizationContext, scope: RuntimeScope, wallTime: bigint) {
    const stored = await this.reader.hydrate(authorization, scope);
    const state = stored.document.state;
    const earned =
      stored.clockPolicy === undefined
        ? state.simulationTime
        : clockEarnedSimulationTime(stored.clockPolicy, wallTime);
    const { policy } = await this.behavior(authorization, scope);
    return {
      ...stored,
      earned: {
        canonical: false as const,
        ...worldContinuousAt(state, policy, earned as SimTimeMs),
      },
    };
  }
  async behavior(
    authorization: RuntimeAuthorizationContext,
    scope: RuntimeScope,
  ): Promise<WorldBehaviorPack> {
    const installed = await this.reader.installedResources(authorization, scope);
    const policies = installed.resources
      .filter((resource) => resource.kind === "policies")
      .map((resource) => decodeResource(resource.content, resource.path));
    const decoded = policies.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "clockgrove.world-behavior-policy",
    );
    if (typeof decoded !== "object" || decoded === null || !("policy" in decoded))
      throw new Error("installed behavior policy absent");
    const pack = {
      schemaVersion: 1,
      packId: installed.packId,
      packVersion: installed.packVersion,
      contentHash: installed.contentHash,
      archetypes: installed.resources
        .filter((resource) => resource.kind === "archetypes")
        .map((resource) => `${resource.id}@${resource.version}`),
      policy: decoded.policy,
    } as WorldBehaviorPack;
    validateWorldBehaviorPack(pack);
    return pack;
  }
}

/** Clock controls need their own grant; `runtime:world-command` alone never allows them. */
export function worldCommandGrant(input: WorldCommandInput): string {
  return isClockCommand(input.command.type) ? "runtime:world-clock" : "runtime:world-command";
}

export function assertWorldCommandContext(
  context: TrustedExecutionContext,
  scope: RuntimeScope,
  grant = "runtime:world-command",
): void {
  if (
    context.tenantId !== scope.tenantId ||
    context.worldId !== scope.worldId ||
    context.timelineId !== scope.timelineId ||
    context.spaceId !== scope.spaceId ||
    context.worldMembershipId === undefined ||
    !context.grants.includes(decodeOpaqueId(grant, "GrantRef"))
  )
    throw new AuthorizationRefusedError("world command scope or authority refused");
}

/** One alarm or catch-up activation of the clock, fenced by policy version and owner generation. */
type Activation = Readonly<{
  activationId: string;
  policyVersion: bigint;
  admit: boolean;
  ownerGeneration?: bigint;
}>;

/** The deadline a due-work step advances to: the next one, never behind the stored time. */
function nextThrough(owner: ClockOwnerState): bigint {
  const { nextDueAt, simulationTime } = owner;
  return nextDueAt === null || nextDueAt < simulationTime ? simulationTime : nextDueAt;
}

/**
 * Decision: 8 overdue due-work steps run inline before a client command. Each step is one
 * transaction, the same one the alarm runs, so 8 bounds the extra latency to a few hundred
 * milliseconds. Normally none are overdue because the alarm keeps up; more means the world is far
 * behind, and the command is refused while the alarm and catch-up path drain it. A lazy boundary
 * advance that exceeds its event budget refuses the same way. Measured by the Wave 3 load curves
 * (issue 851; docs/runbooks/runtime.md "Runtime budgets and load curves"): a command after 6 minutes of
 * sleep ran 7 steps in 280 to 462 ms, and after 8 minutes it was refused after 8 (280 to 419 ms).
 */
export const OVERDUE_DEADLINE_LIMIT = 8;

/** Too much due work to run before a client command; retryable once the catch-up path drains it. */
export class WorldCatchingUpError extends Error {
  constructor() {
    super("world is catching up");
    this.name = "WorldCatchingUpError";
  }
}

export type WorldCommandRpcFailure =
  | Readonly<{ code: "world_catching_up" }>
  | Readonly<{
      code: "world_command_conflict";
      kind: JournalRevisionConflictKind;
      expected: bigint | number;
      actual: bigint | number;
    }>
  | Readonly<{ code: "durable_state_corrupt"; reason: PartitionStateIntegrityReason }>
  | Readonly<{ code: "authorization_refused" }>
  | Readonly<{ code: "command_id_reused"; commandId: CommandId }>
  | Readonly<{ code: "route_not_found"; route: string }>
  | Readonly<{ code: "continuation_pending"; commandId: string; openCommandId?: string }>
  | Readonly<{
      code: "stale_epoch";
      kind: RuntimeEpochConflictError["kind"];
      expected: bigint;
      actual: bigint;
    }>
  | Readonly<{ code: "runtime_route_not_found" }>
  | Readonly<{ code: "stored_rejection"; value: unknown }>
  | Readonly<{ code: "owner_unavailable" }>
  | Readonly<{ code: OwnerMailboxRefusal; retryAfterSeconds: number }>
  | Readonly<{ code: "world_command_failed"; failureClass?: RuntimeFailureClass }>;

/**
 * The owner could not be reached or failed in transport. The commit outcome is unknown: the caller
 * retries with the same accepted bytes, which returns the stored outcome if it committed.
 */
export class WorldOwnerUnavailableError extends Error {
  constructor() {
    super("world-command owner unavailable");
    this.name = "WorldOwnerUnavailableError";
  }
}

/** Calls an owner stub; a thrown transport failure (not a reply) means the owner was unavailable. */
export async function callWorldOwner<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new WorldOwnerUnavailableError();
  }
}
export type WorldCommandRpcReply<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: WorldCommandRpcFailure }>;

/**
 * An owner's server failure relayed through RPC. The owner that caught the cause logged it, so a
 * relay answers `world_command_failed` without logging again: one failure, one record. Only the
 * cause's class crosses, for the Worker's answered record.
 */
export class WorldOwnerFailedError extends Error {
  constructor(readonly failureClass: RuntimeFailureClass = "internal") {
    super("world owner failed");
    this.name = "WorldOwnerFailedError";
  }
}

/**
 * A runtime failure's class for logs, from typed errors and structured driver codes, never text.
 * Undefined for refusals that are not failures (authentication, authorization, decoding, routing).
 */
export function runtimeFailureClass(error: unknown): RuntimeFailureClass | undefined {
  if (error instanceof WorldOwnerFailedError) return error.failureClass;
  if (error instanceof RuntimeEpochConflictError) return "epoch_conflict";
  if (error instanceof WorldContinuationPendingError) return "continuation_pending";
  if (error instanceof WorldCatchingUpError) return "catching_up";
  if (error instanceof WorldOwnerUnavailableError) return "owner_unavailable";
  if (error instanceof OwnerMailboxError) return "owner_mailbox";
  return databaseFailureClass(error);
}

/** The log IDs of an owner call: its scope, the trusted correlation and the command, where known. */
export function ownerLogIds(
  scope: RuntimeScope,
  context?: TrustedExecutionContext,
  commandId?: string,
): RuntimeLogIds {
  return {
    ...scope,
    ...(context === undefined
      ? {}
      : { correlationId: context.correlationId, requestId: context.requestId }),
    ...(commandId === undefined ? {} : { commandId }),
  };
}

/** RPC transports copy standard Error fields but not application exception types or their fences. */
export async function worldCommandRpc<T>(
  logger: RuntimeLogger,
  ids: RuntimeLogIds,
  operation: () => Promise<T>,
): Promise<WorldCommandRpcReply<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof JournalRevisionConflictError)
      return {
        ok: false,
        failure: {
          code: "world_command_conflict",
          kind: error.kind,
          expected: error.expected,
          actual: error.actual,
        },
      };
    if (error instanceof PartitionStateIntegrityError)
      return { ok: false, failure: { code: "durable_state_corrupt", reason: error.reason } };
    if (error instanceof WorldCatchingUpError)
      return { ok: false, failure: { code: "world_catching_up" } };
    if (error instanceof AuthorizationRefusedError)
      return { ok: false, failure: { code: "authorization_refused" } };
    if (error instanceof CommandIdempotencyInvariantError)
      return { ok: false, failure: { code: "command_id_reused", commandId: error.commandId } };
    if (error instanceof JournalRouteNotFoundError)
      return { ok: false, failure: { code: "route_not_found", route: error.route } };
    if (error instanceof WorldContinuationPendingError)
      return {
        ok: false,
        failure: {
          code: "continuation_pending",
          commandId: error.commandId,
          ...(error.openCommandId === undefined ? {} : { openCommandId: error.openCommandId }),
        },
      };
    if (error instanceof RuntimeEpochConflictError)
      return {
        ok: false,
        failure: {
          code: "stale_epoch",
          kind: error.kind,
          expected: error.expected,
          actual: error.actual,
        },
      };
    if (error instanceof RuntimeRouteNotFoundError)
      return { ok: false, failure: { code: "runtime_route_not_found" } };
    if (error instanceof StoredRejectionError)
      return { ok: false, failure: { code: "stored_rejection", value: error.value } };
    if (error instanceof WorldOwnerUnavailableError)
      return { ok: false, failure: { code: "owner_unavailable" } };
    if (error instanceof OwnerMailboxError)
      return {
        ok: false,
        failure: { code: error.code, retryAfterSeconds: error.retryAfterSeconds },
      };
    // Anything else is a server failure. Its cause is logged here and stays inside the owner.
    const failureClass = runtimeFailureClass(error) ?? "internal";
    if (!(error instanceof WorldOwnerFailedError))
      logger.log(runtimeLogRecord("error", "world_owner_failed", { ...ids, failureClass }, error));
    return { ok: false, failure: { code: "world_command_failed", failureClass } };
  }
}

/** Detach provider ownership and restore project-owned error types before application handling. */
export function unwrapWorldCommandRpc<T>(reply: WorldCommandRpcReply<T>): T {
  try {
    if (reply.ok) return reply.value;
    const failure = reply.failure;
    switch (failure.code) {
      case "world_command_conflict":
        throw new JournalRevisionConflictError(failure.kind, failure.expected, failure.actual);
      case "durable_state_corrupt":
        throw new PartitionStateIntegrityError(failure.reason);
      case "world_catching_up":
        throw new WorldCatchingUpError();
      case "authorization_refused":
        throw new AuthorizationRefusedError("world owner authorization refused");
      case "command_id_reused":
        throw new CommandIdempotencyInvariantError(failure.commandId);
      case "route_not_found":
        throw new JournalRouteNotFoundError(failure.route);
      case "continuation_pending":
        throw new WorldContinuationPendingError(failure.commandId, failure.openCommandId);
      case "stale_epoch":
        throw new RuntimeEpochConflictError(failure.kind, failure.expected, failure.actual);
      case "runtime_route_not_found":
        throw new RuntimeRouteNotFoundError();
      case "stored_rejection":
        throw new StoredRejectionError(failure.value);
      case "owner_unavailable":
        throw new WorldOwnerUnavailableError();
      case "owner_mailbox_full":
      case "owner_mailbox_expired":
      case "owner_mailbox_timeout":
        throw new OwnerMailboxError(failure.code, failure.retryAfterSeconds);
      case "world_command_failed":
        throw new WorldOwnerFailedError(failure.failureClass);
    }
    throw new Error("unrecognized world owner reply");
  } finally {
    if (Symbol.dispose in reply) {
      const dispose = reply[Symbol.dispose];
      if (typeof dispose === "function") dispose.call(reply);
    }
  }
}
