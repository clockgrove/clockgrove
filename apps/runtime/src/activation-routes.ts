import type {
  ActivationConfiguration,
  ActivationInspection,
  ActivationPolicy,
  ActivationReason,
  ActivationWake,
  ActorActivation,
  ConversationParticipant,
} from "@clockgrove/application";
import { type BrowserScope, ContractDecodeError, decodeBrowserScope } from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";

export const ACTIVATION_ROUTES = [
  "/v1/runtime/activations/configure",
  "/v1/runtime/activations/wake",
  "/v1/runtime/activations/inspect",
  "/v1/runtime/activations/triage-report",
  "/v1/runtime/activations/moderation-report",
] as const;
export type ActivationRoute = (typeof ACTIVATION_ROUTES)[number];

export interface ActivationOwners {
  moderationReport?(
    scope: BrowserScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ): Promise<unknown>;
  triageReport(
    scope: BrowserScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ): Promise<unknown>;
  configure(
    scope: BrowserScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    configuration: ActivationConfiguration,
    policy: ActivationPolicy,
  ): Promise<ActivationInspection>;
  wake(
    scope: BrowserScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
    wake: ActivationWake,
  ): Promise<ActorActivation>;
  inspect(
    scope: BrowserScope,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
    actorId: string,
  ): Promise<ActivationInspection>;
}

function invalid(field: string): never {
  throw new ContractDecodeError(`activation.${field}`, "invalid value");
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("fields");
}
function text(value: unknown, field: string, max = 1024, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    new TextEncoder().encode(value).length > max
  )
    invalid(field);
  return value;
}
function integer(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    invalid(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
const reasonFields = {
  scheduled_intention: ["scheduleId"],
  subscription: ["subscriptionId", "eventId"],
  perception: ["perceptionId"],
  threshold: ["conditionId"],
  heartbeat: ["heartbeatId"],
  tool_completed: ["effectId"],
  operator: ["commandId"],
} as const;
function kind(value: unknown): ActivationReason["kind"] {
  if (typeof value !== "string" || !Object.hasOwn(reasonFields, value)) invalid("kind");
  return value as ActivationReason["kind"];
}
function reason(value: unknown): ActivationReason {
  const record = object(value, "reason");
  const reasonKind = kind(record.kind);
  const fields = reasonFields[reasonKind];
  keys(record, ["kind", ...fields]);
  const result = Object.fromEntries([
    ["kind", reasonKind],
    ...fields.map((field) => [field, text(record[field], field)]),
  ]);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 4096) invalid("reason");
  return result as unknown as ActivationReason;
}

export interface ActivationCall {
  readonly scope: BrowserScope;
  readonly actorId: string;
  run(
    owners: ActivationOwners,
    context: TrustedExecutionContext,
    participant: ConversationParticipant,
  ): Promise<unknown>;
}

export function activationCall(route: ActivationRoute, value: unknown): ActivationCall {
  const body = object(value, "request");
  keys(body, [
    "version",
    "scope",
    "actorId",
    ...(route.endsWith("/configure")
      ? ["configuration", "policy"]
      : route.endsWith("/wake")
        ? ["wake"]
        : []),
  ]);
  if (body.version !== 1) invalid("version");
  const scope = decodeBrowserScope(body.scope);
  const actorId = text(body.actorId, "actorId");
  if (route === "/v1/runtime/activations/moderation-report")
    return {
      scope,
      actorId,
      run: (owners, context, participant) => {
        if (owners.moderationReport === undefined) throw new Error("moderation report unavailable");
        return owners.moderationReport(scope, context, participant, actorId);
      },
    };
  if (route === "/v1/runtime/activations/triage-report")
    return {
      scope,
      actorId,
      run: (owners, context, participant) =>
        owners.triageReport(scope, context, participant, actorId),
    };
  if (route === "/v1/runtime/activations/inspect")
    return {
      scope,
      actorId,
      run: (owners, context, participant) => owners.inspect(scope, context, participant, actorId),
    };
  if (route === "/v1/runtime/activations/wake") {
    const wake = object(body.wake, "wake");
    keys(wake, ["configurationId", "causalRoot", "reason", "evidence"]);
    const input: ActivationWake = {
      configurationId: text(wake.configurationId, "configurationId", 128),
      causalRoot: text(wake.causalRoot, "causalRoot"),
      reason: reason(wake.reason),
      evidence: text(wake.evidence, "evidence", 8192),
    };
    return {
      scope,
      actorId,
      run: (owners, context, participant) =>
        owners.wake(scope, context, participant, actorId, input),
    };
  }
  const config = object(body.configuration, "configuration");
  keys(config, [
    "id",
    "sessionId",
    "kind",
    "nextWakeAt",
    "intervalMs",
    "eventType",
    "input",
    "priority",
    "enabled",
    "compiledRoutine",
  ]);
  const compiledRoutine = config.compiledRoutine;
  if (compiledRoutine !== "noop" && compiledRoutine !== "escalate") invalid("compiledRoutine");
  if (
    config.intervalMs !== null &&
    (typeof config.intervalMs !== "number" || config.intervalMs < 60_000)
  )
    invalid("intervalMs");
  const configuration: ActivationConfiguration = {
    id: text(config.id, "id", 128),
    sessionId: text(config.sessionId, "sessionId"),
    kind: kind(config.kind),
    nextWakeAt:
      config.nextWakeAt === null
        ? null
        : integer(config.nextWakeAt, "nextWakeAt", 8_640_000_000_000_000),
    intervalMs:
      config.intervalMs === null
        ? null
        : integer(config.intervalMs, "intervalMs", Number.MAX_SAFE_INTEGER),
    ...(config.eventType === undefined
      ? {}
      : { eventType: text(config.eventType, "eventType", 256) }),
    input: text(config.input, "input", 1024, true),
    priority: integer(config.priority, "priority", 100),
    enabled: boolean(config.enabled, "enabled"),
    compiledRoutine,
  };
  if (compiledRoutine === "escalate" && configuration.input.trim().length === 0) invalid("input");
  const policyValue = object(body.policy, "policy");
  keys(policyValue, ["allowModel", "modelBudget"]);
  const policy: ActivationPolicy = {
    allowModel: boolean(policyValue.allowModel, "allowModel"),
    modelBudget: integer(policyValue.modelBudget, "modelBudget", 1000),
  };
  return {
    scope,
    actorId,
    run: (owners, context, participant) =>
      owners.configure(scope, context, participant, actorId, configuration, policy),
  };
}

const ACTIVATION_REFUSALS: Readonly<
  Record<string, { readonly error: string; readonly status: number }>
> = {
  "activation policy not found": { error: "activation_not_found", status: 404 },
  "activation configuration not found": { error: "activation_not_found", status: 404 },
  "activation conversation not found": { error: "conversation_not_found", status: 404 },
  "activation configuration limit reached": {
    error: "activation_configuration_limit",
    status: 409,
  },
  "activation receipt limit reached": { error: "activation_receipt_limit", status: 409 },
  "invalid activation evidence": { error: "invalid_activation_request", status: 400 },
  "invalid activation configuration": { error: "invalid_activation_request", status: 400 },
  "activation reason mismatch": { error: "invalid_activation_reason", status: 400 },
};

/** RPC preserves error messages, but not domain error prototypes. */
export function activationRefusal(
  error: unknown,
): { readonly error: string; readonly status: number } | undefined {
  return error instanceof Error ? ACTIVATION_REFUSALS[error.message] : undefined;
}
