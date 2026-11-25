import {
  type ActorReplyShadowRecord,
  type ConversationParticipant,
  JOURNAL_EVENT_REGISTRY,
  journalModerationShadow,
  judgeActorReply,
  judgeModeration,
  type ModerationShadowPolicy,
  type ShadowDecider,
  type TurnFiber,
  type TurnInput,
  VerifiedJournal,
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
  PostgreSqlModerationShadow,
} from "@clockgrove/persistence";
import { gatewayShadowDecider } from "./decision-shadow.js";

export function moderationShadowPolicy(
  source: string | undefined,
  defaultVersion = "moderation-shadow@3",
): ModerationShadowPolicy | undefined {
  if (source === undefined) return undefined;
  // Opt-in calibration defaults match wake triage's 65% threshold and the gateway's $0.001
  // call ceiling. Model and alias are always supplied by the operator, never selected in code.
  return z
    .object({
      policyVersion: z.string().min(1).default(defaultVersion),
      modelAlias: z.string().min(1),
      model: z.string().min(1),
      confidenceThreshold: z.number().int().min(0).max(10000).default(6500),
      maxCostMicrousd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1000),
    })
    .strict()
    .parse(JSON.parse(source));
}
/** `ACTOR_REPLY_SHADOW_CONFIG`: the same shape, its own policy version, alias and model. */
export const actorReplyShadowPolicy = (source: string | undefined) =>
  moderationShadowPolicy(source, "actor-reply-shadow@1");

/**
 * Judges one committed actor reply (issue 271) and hands its contentless record to `record`. Every
 * fault is swallowed into a `failed` record or dropped: the reply was already delivered.
 */
export async function shadowActorReply(
  fiber: TurnFiber,
  reply: string,
  policy: ModerationShadowPolicy,
  decider: ShadowDecider | undefined,
  record: (record: ActorReplyShadowRecord) => void | Promise<void>,
): Promise<void> {
  await record(
    await judgeActorReply({
      subject: {
        tenantId: fiber.scope.tenantId,
        worldId: fiber.scope.worldId,
        actorId: fiber.actorId,
        sessionId: fiber.sessionId,
        messageId: fiber.messageId,
        reply,
      },
      policy,
      decider,
    }),
  );
}
export function moderationShadowDecider(
  environment: { readonly AI_GATEWAY_API_KEY?: string },
  policy: ModerationShadowPolicy,
  fiber: TurnFiber,
): ShadowDecider | undefined {
  if (!environment.AI_GATEWAY_API_KEY) return undefined;
  const gateway = createModelGateway({
    aliases: [],
    adapters: {},
    decisionAliases: [
      decisionAlias({
        alias: policy.modelAlias,
        model: policy.model,
        maxCostMicrousd: policy.maxCostMicrousd,
      }),
    ],
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
export async function shadowActorMessage(
  client: PostgreSqlClient,
  participant: ConversationParticipant,
  fiber: TurnFiber,
  input: TurnInput,
  policy: ModerationShadowPolicy,
  decider: ShadowDecider | undefined,
): Promise<void> {
  const store = new PostgreSqlModerationShadow(client);
  const reservation = await store.reserve(participant, fiber);
  const record =
    reservation.record ??
    (await store.finish(
      participant,
      fiber,
      await judgeModeration({
        subject: {
          sessionId: fiber.sessionId,
          messageId: fiber.messageId,
          actorId: fiber.actorId,
          simulationTime: reservation.simulationTime,
          input: input.input,
        },
        policy,
        decider: reservation.existing ? undefined : decider,
        interrupted: reservation.existing,
      }),
    ));
  const raw = new PostgreSqlJournal(client);
  await journalModerationShadow(
    new VerifiedJournal(raw, JOURNAL_EVENT_REGISTRY),
    {
      ...fiber.scope,
      partitionId: reservation.partitionId,
      streamId: reservation.streamId,
      authorization: {
        tenantId: decodeOpaqueId(participant.tenantId, "TenantId"),
        principalId: decodeOpaqueId(participant.principalId, "PrincipalId"),
        privacyCeiling: { version: 1, allowedCategories: ["conversation"] },
      },
    },
    record,
    raw,
  );
}
