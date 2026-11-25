import {
  type ConversationParticipant,
  JOURNAL_EVENT_REGISTRY,
  journalWakeTriage,
  judgeWake,
  SHADOW_USAGE_UNKNOWN,
  type ShadowDecider,
  type TurnFiber,
  type TurnInput,
  VerifiedJournal,
  type WakeTriagePolicy,
} from "@clockgrove/application";
import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  AiSdkDecisionAdapter,
  createModelGateway,
  decisionAlias,
  InMemoryModelBudget,
  z,
} from "@clockgrove/model-gateway";
import {
  type PostgreSqlClient,
  PostgreSqlJournal,
  PostgreSqlWakeTriage,
  PostgreSqlWorldOwnerReader,
} from "@clockgrove/persistence";
import { decodeResource } from "@clockgrove/world-pack-sdk";
import { gatewayShadowDecider } from "./decision-shadow.js";

interface WakeTriageEnvironment {
  readonly AI_GATEWAY_API_KEY?: string;
}

/** The calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
export function wallClockDay(nowMs: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function wakeTriagePolicy(source: string | undefined): WakeTriagePolicy | undefined {
  if (source === undefined) return undefined;
  // Decisions for the opt-in pilot: 65% confidence; $0.10 reserved per world/day and $0.001
  // per call. Model and ceiling follow issue 111 and the existing decision alias defaults.
  return z
    .object({
      policyVersion: z.string().min(1).default("wake-triage@1"),
      modelAlias: z.string().min(1).default("wake.triage"),
      model: z.string().min(1).default("perplexity/pplx-decider-v1.2"),
      confidenceThreshold: z.number().int().min(0).max(10000).default(6500),
      dailyBudgetMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(100000),
      dailyBudgetZone: z
        .string()
        .default("UTC")
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat("en-CA", { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }, "dailyBudgetZone must be an IANA time zone"),
      maxCostMicrousd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1000),
    })
    .strict()
    .parse(JSON.parse(source));
}
export function wakeTriageDecider(
  environment: Pick<WakeTriageEnvironment, "AI_GATEWAY_API_KEY">,
  policy: WakeTriagePolicy,
  fiber: TurnFiber,
): ShadowDecider | undefined {
  if (!environment.AI_GATEWAY_API_KEY) return undefined;
  const alias = decisionAlias({
    alias: policy.modelAlias,
    model: policy.model,
    maxCostMicrousd: policy.maxCostMicrousd,
  });
  const gateway = createModelGateway({
    aliases: [],
    adapters: {},
    decisionAliases: [alias],
    decisionAdapters: {
      "vercel-ai-gateway": new AiSdkDecisionAdapter(() => environment.AI_GATEWAY_API_KEY),
    },
    budget: new InMemoryModelBudget(() => policy.maxCostMicrousd),
    accounting: { record: () => undefined },
  });
  return gatewayShadowDecider(gateway, {
    tenantId: fiber.scope.tenantId,
    worldId: fiber.scope.worldId,
    actorId: fiber.actorId,
    principalId: fiber.principalId,
    personaId: fiber.personaId,
  });
}
export async function shadowActorWake(
  client: PostgreSqlClient,
  participant: ConversationParticipant,
  fiber: TurnFiber,
  input: TurnInput,
  policy: WakeTriagePolicy,
  decider: ShadowDecider | undefined,
): Promise<void> {
  const installed = await new PostgreSqlWorldOwnerReader(client).installedResources(
    participant,
    fiber.scope,
  );
  const behavior = installed.resources
    .filter((resource) => resource.kind === "policies")
    .map((resource) => decodeResource(resource.content, resource.path))
    .find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "clockgrove.world-behavior-policy",
    ) as { policy?: { environment?: { dayLengthMs: bigint } } } | undefined;
  const dayLengthMs = behavior?.policy?.environment?.dayLengthMs ?? 86400000n;
  const store = new PostgreSqlWakeTriage(client);
  const reservation = await store.reserve(
    participant,
    fiber,
    policy,
    dayLengthMs,
    wallClockDay(Date.now(), policy.dailyBudgetZone),
  );
  const record =
    reservation.record ??
    (await judgeWake({
      policy,
      decider: reservation.existing ? undefined : decider,
      reserved: reservation.reserved === true,
      subject: {
        requestId: `${fiber.sessionId}:${fiber.messageId}`,
        objectId: fiber.actorId,
        sessionId: fiber.sessionId,
        messageId: fiber.messageId,
        reason: reservation.reason ?? "direct_message",
        simulationTime: reservation.simulationTime ?? "0",
        input: input.input,
        prompt: input.prompt,
        wakes: reservation.wakes ?? [],
        routines: reservation.routines ?? [],
      },
    }));
  const evidence =
    reservation.existing && reservation.record == null
      ? {
          ...record,
          suppressionCause: "interrupted-decision",
          costMicrousd: null,
          // The replaced owner may have reached the model: unknown, never zero.
          usage: SHADOW_USAGE_UNKNOWN,
          signature: `${record.signature}:interrupted`,
        }
      : record;
  const raw = new PostgreSqlJournal(client);
  await journalWakeTriage(
    new VerifiedJournal(raw, JOURNAL_EVENT_REGISTRY),
    {
      ...fiber.scope,
      partitionId: reservation.partitionId ?? "",
      streamId: reservation.streamId ?? "",
      authorization: {
        tenantId: decodeOpaqueId(participant.tenantId, "TenantId"),
        principalId: decodeOpaqueId(participant.principalId, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: ["operator_evidence"] },
      },
    },
    evidence,
    raw,
  );
  await store.finish(participant, fiber, evidence);
}
