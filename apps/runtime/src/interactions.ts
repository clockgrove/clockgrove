import type { WorldCommandResult } from "@clockgrove/application";
import {
  type CommandEnvelope,
  decodeOpaqueId,
  type InfluenceReceipt,
  type InfluenceRequest,
  type InteractionAction,
  type InteractionAttribution,
  type InteractionSummary,
  type ObjectId,
  type PrincipalId,
  type TalkReceipt,
  type TalkRequest,
  type WorldPersonaId,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import type { WorldState } from "@clockgrove/domain";
import type { BuiltCommandFields, WorldCommandInput } from "./world-commands.js";

/** The reader's authority that interaction policy evaluates, as its decided audience records it. */
export interface InteractionAuthority {
  /** The `conversation` privacy category, which Talk needs. */
  readonly talk: boolean;
  /** `runtime:world-command`, the grant an Influence intent is authorized under. */
  readonly influence: boolean;
}

/**
 * The server's policy evaluation of every projected entity's interaction card. Capabilities come
 * from canonical components only; the caller's grants and ceiling then enable or disable each one,
 * so a missing capability is absent and a denied one carries its reason. Wave 4 has no cognition:
 * actors decide by deterministic utility, so no entity is `cognitive` or `interpreted` here.
 */
export function interactionsOf(
  state: WorldState,
  projected: ReadonlySet<string>,
  authority: InteractionAuthority,
): InteractionSummary[] {
  const enabled = (kind: InteractionAction["kind"]): InteractionAction => ({
    kind,
    availability: "enabled",
  });
  const plants = new Set(state.ecology?.plants.map((plant) => plant.objectId) ?? []);
  return state.entities
    .filter((entity) => projected.has(entity.objectId))
    .map((entity) => {
      const actor = entity.needs !== undefined;
      const actions: InteractionAction[] = [enabled("inspect"), enabled("history")];
      if (actor) {
        actions.push(enabled("why"));
        actions.push(
          authority.talk
            ? enabled("talk")
            : { kind: "talk", availability: "disabled", reason: "conversation_not_permitted" },
        );
      }
      if (entity.resource !== undefined)
        actions.push(
          authority.influence
            ? enabled("influence")
            : { kind: "influence", availability: "disabled", reason: "command_grant_required" },
        );
      const reactive = actor || entity.resource !== undefined || plants.has(entity.objectId);
      return {
        entityId: entity.objectId,
        mode: reactive ? ("reactive" as const) : ("inspectable" as const),
        actions,
      };
    })
    .sort((left, right) =>
      left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
    );
}

/** The command ID of an Influence intent: one per principal and intent ID, used once. */
export function influenceCommandId(principalId: PrincipalId, intentId: string): string {
  return `influence:${principalId}:${intentId}`;
}

/**
 * The world command an Influence intent proposes, built by the server: one unit of the entity's
 * resource (decision, issue 811: one unit, as the existing offer journeys use). It is built before
 * authorization, so the authenticated principal is the effective actor; the principal, membership
 * and persona are sealed from the trusted context when the command is submitted or denied. A retry
 * reuses the first attempt's server-chosen fields, so it rebuilds the same accepted bytes.
 */
export function influenceCommand(
  request: InfluenceRequest,
  principalId: PrincipalId,
  { epochs, context: ids, issuedAt }: Required<BuiltCommandFields>,
): WorldCommandInput {
  const { tenantId, worldId, timelineId } = request.scope;
  const commandId = decodeOpaqueId(influenceCommandId(principalId, request.intentId), "CommandId");
  const command = {
    schemaVersion: 1,
    commandId,
    type: "resource.offer",
    target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
    expected: { partitionRevision: request.expectedRevision },
    issuedAt,
    context: { version: 1, ...ids },
    attribution: {
      effectiveActorId: principalId,
      causalRootActionId: `action-${commandId}`,
    },
    payload: {
      schemaVersion: 1,
      objectId: request.objectId,
      kind: request.resourceKind,
      quantity: 1,
    },
  } as unknown as CommandEnvelope<string, unknown>;
  return { scope: request.scope, epochs, command };
}

/** What happened to the intent, from the world command's own receipt. */
export function influenceReceipt(
  request: InfluenceRequest,
  result: WorldCommandResult,
  attribution: InteractionAttribution,
): InfluenceReceipt {
  const common = {
    intentId: request.intentId,
    commandId: result.commandId,
    objectId: request.objectId,
    attribution,
  };
  const value = result.value;
  if (value.status === "committed")
    return {
      ...common,
      status: "committed",
      revision: value.revision,
      consequences: result.events.map((event) => ({
        eventId: event.eventId,
        type: event.type,
      })),
    };
  return {
    ...common,
    status: "rejected",
    reason:
      value.status === "denied"
        ? value.reasonCode
        : `${value.refusal.code} at ${value.refusal.path}`,
  };
}

/**
 * The scripted Talk fixture. Nothing is stored or delivered to another observer, and the reply
 * says so: the actor has no conversation memory in Wave 4. Private talk is attributed to the
 * trusted principal and persona; public speech is a scripted line spoken by the addressed actor.
 */
export function scriptedTalk(
  request: TalkRequest,
  context: TrustedExecutionContext & { readonly personaId: WorldPersonaId },
  sentAt: string,
): TalkReceipt {
  const base = { messageId: request.messageId, scope: request.scope, text: request.text, sentAt };
  if (request.channel === "public")
    return {
      channel: "public",
      // The actor speaks a fixed scripted line, never the caller's words: that would be control.
      speech: {
        type: "public_speech",
        ...base,
        speakerId: request.actorId as ObjectId,
        text: "Chitters aloud (scripted fixture line).",
      },
      attribution: { principalId: context.principalId, personaId: context.personaId },
    };
  return {
    channel: "private",
    talk: {
      type: "private_caretaker_talk",
      ...base,
      principalId: context.principalId,
      caretakerId: context.personaId,
      // No canonical record names a persona yet, so it is named by its identifier.
      caretakerName: context.personaId,
      actorId: request.actorId,
    },
    reply:
      "Scripted Talk fixture: this actor has no conversation memory and will not remember this.",
  };
}
