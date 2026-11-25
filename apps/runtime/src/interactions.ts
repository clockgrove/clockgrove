import type { WorldCommandResult } from "@clockgrove/application";
import {
  type CommandEnvelope,
  decodeOpaqueId,
  type InboundEnvelope,
  type InfluenceReceipt,
  type InfluenceRequest,
  type InteractionAction,
  type InteractionAttribution,
  type InteractionMode,
  type InteractionSummary,
  type PrincipalId,
  type SayReceipt,
  type SayRequest,
  type WorldPersonaId,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import { placeOf, type WorldState } from "@clockgrove/domain";
import { RESOLVER_VERSION, resolveAudience, sha256Hex } from "@clockgrove/kernel";
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
 * so a missing capability is absent and a denied one carries its reason. Talk is offered for an
 * entity that declares a Conversation mode (`clockgrove.conversation-mode`), whatever else it
 * carries; Why stays an actor's (an entity with needs), since it explains a routine choice. The
 * card's `mode` is that declared Conversation mode (`cognitive`, `interpreted` or `canonical`), so
 * the card discloses the voice the entity answers in; it never comes from needs, resources or a
 * name. An entity that declares none is `reactive` when it is an actor, holds a resource or is a
 * plant, and `inspectable` otherwise.
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
      if (actor) actions.push(enabled("why"));
      if (entity.conversationMode !== undefined)
        actions.push(
          authority.talk
            ? enabled("talk")
            : { kind: "talk", availability: "disabled", reason: "conversation_not_permitted" },
        );
      if (entity.resource !== undefined)
        actions.push(
          authority.influence
            ? enabled("influence")
            : { kind: "influence", availability: "disabled", reason: "command_grant_required" },
        );
      const reactive = actor || entity.resource !== undefined || plants.has(entity.objectId);
      const mode: InteractionMode =
        entity.conversationMode ?? (reactive ? "reactive" : "inspectable");
      return {
        entityId: entity.objectId,
        mode,
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
 * A Say's `sound` range: no distance bound, so the speaker's space is its range. This is the
 * runtime's existing perception rule (`perceivedEntities` in `actor-model.ts`): a runtime world
 * declares no perception policy, so no modality range is declared, and the space stands in for one
 * until a world can declare it. The resolver still range-checks every location-derived observer,
 * and its range test holds only within one frame, so an observer in another frame than the
 * speaker's is never in range; the bound is the largest the resolver accepts.
 */
export const SAY_SOUND_RANGE = Number.MAX_SAFE_INTEGER;

/**
 * Who hears a Say: the kernel resolver over a synthetic, never-recorded `sound` event at the
 * state's revision, in the speaker's space and the place it stands in (`placeOf` its pose), so the
 * observers in the space (`space-contents`), in that place (`nearby-peer`) and in its ancestor
 * places (`ancestor-space`) hear it: those in and near the space. Every location-derived observer
 * is range-checked, and the resolver's range test holds only within one frame (`withinRange`), so
 * an observer in another frame than the speaker's, even of its space, does not hear it. The world
 * records no occlusion or access rule for sound, so the policy declares none. The receipt names
 * only entities of the caller's authorized space (`scopeSpaceId`, the space its observe grant
 * reads): an entity of another space standing in the speaker's place or an ancestor place is
 * left out, and a speaker outside that space names no one. Its event id is a digest of the message
 * id, so any message id the request accepts (up to 1,024 bytes) fits the resolver's 256-character
 * id bound. The speaker is listed when the resolver includes it (as `event-actor`). A speaker
 * missing from the state or a refused resolution fails closed: the kernel's resolver version with
 * no observers, which the receipt's decoder accepts.
 */
export function sayAudience(
  state: WorldState,
  scopeSpaceId: string,
  speakerId: string,
  messageId: string,
): NonNullable<SayReceipt["audience"]> {
  const speaker = state.entities.find((entity) => entity.objectId === speakerId);
  const spaceId = speaker?.spaceId === scopeSpaceId ? scopeSpaceId : undefined;
  const inScope = new Set<string>(
    state.entities.flatMap((entity) => (entity.spaceId === scopeSpaceId ? [entity.objectId] : [])),
  );
  const place =
    speaker === undefined
      ? undefined
      : placeOf(
          state.spatialRegions ?? [],
          speaker.pose.frameId,
          speaker.pose.frameVersion,
          speaker.pose.coordinates,
        );
  const outcome =
    spaceId === undefined
      ? undefined
      : resolveAudience(
          {
            version: 1,
            type: "object.created",
            eventId: `say:${sha256Hex(new TextEncoder().encode(messageId))}`,
            modality: "sound",
            sourceRevision: state.revision,
            spaceId,
            actorId: speakerId,
            targetId: null,
            regionIds: place === undefined ? [] : [place],
          },
          state,
          {
            version: 2,
            modalities: [{ modality: "sound", range: SAY_SOUND_RANGE }],
            occlusions: [],
            access: [],
            subscribers: [],
            viewers: [],
          },
        );
  return outcome?.ok
    ? {
        resolverVersion: outcome.value.resolverVersion,
        observers: outcome.value.reasons.flatMap((reason) =>
          reason.outcome === "included" && inScope.has(reason.observerId)
            ? [
                {
                  observerId: reason.observerId,
                  reason: reason.code,
                  detailLevel: reason.detailLevel,
                },
              ]
            : [],
        ),
      }
    : { resolverVersion: RESOLVER_VERSION, observers: [] };
}

/**
 * Public Say: the addressed actor speaks a fixed scripted line aloud, never the caller's words
 * (that would be control), attributed to the trusted principal and persona whose explicit action
 * made it speak. Nothing is stored; the receipt names who heard it (`sayAudience`).
 */
export function scriptedSay(
  request: SayRequest,
  context: TrustedExecutionContext & { readonly personaId: WorldPersonaId },
  sentAt: string,
  envelope?: InboundEnvelope,
  audience?: SayReceipt["audience"],
): SayReceipt {
  if (
    envelope !== undefined &&
    (envelope.action !== "say" ||
      envelope.privacyPolicy !== "public_scene" ||
      envelope.actorId !== request.actorId ||
      envelope.resolvedPrincipal !== context.principalId)
  )
    throw new TypeError("Say requires a public normalized envelope");
  return {
    type: "public_say",
    speech: {
      type: "public_speech",
      messageId: envelope?.idempotencyKey ?? request.messageId,
      scope: envelope?.scope ?? request.scope,
      speakerId:
        envelope === undefined ? request.actorId : decodeOpaqueId(envelope.actorId, "ObjectId"),
      text: "Chitters aloud (scripted fixture line).",
      sentAt,
    },
    attribution: { principalId: context.principalId, personaId: context.personaId },
    ...(audience === undefined ? {} : { audience }),
  };
}
