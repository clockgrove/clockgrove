import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import {
  type ChannelIngressMetadata,
  CONVERSATION_CHANNELS,
  type ConversationChannel,
  decodeChannelId,
  decodeChannelIngressMetadata,
} from "./channels.js";
import {
  decodeOpaqueId,
  type EventId,
  type ObjectId,
  type PrincipalId,
  type SpaceId,
  type WorldPersonaId,
} from "./ids.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  literal,
  record,
  string,
  unsignedDecimal,
  utcTimestamp,
} from "./validation.js";

export interface FeedSummary {
  readonly id: string;
  readonly simTimeMs: bigint;
  readonly kind: "material";
  readonly text: string;
  readonly sourceEventIds: readonly EventId[];
}

export type InteractionMode = "inspectable" | "reactive" | "cognitive" | "interpreted";

/** The §10 mode disclosures; a card renders the one its summary's mode names, never its own. */
export const INTERACTION_DISCLOSURES: Readonly<Record<InteractionMode, string>> = Object.freeze({
  inspectable: "Inspection from world evidence",
  reactive: "Deterministic/reactive object",
  cognitive: "Actor's subjective perspective",
  interpreted: "Interpretation; object is not sentient",
});

export const INTERACTION_ACTION_KINDS = [
  "talk",
  "observe",
  "inspect",
  "remember",
  "history",
  "influence",
  "why",
] as const;
export type InteractionActionKind = (typeof INTERACTION_ACTION_KINDS)[number];

/** Why the server's policy evaluation denied a capability the entity has. */
export const INTERACTION_DENIAL_REASONS = Object.freeze({
  command_grant_required: "Your world membership does not allow influencing the world.",
  conversation_not_permitted: "Your privacy ceiling does not allow conversation.",
} as const);
export type InteractionDenialReason = keyof typeof INTERACTION_DENIAL_REASONS;

/**
 * One capability of the entity, as the caller's policy evaluated it. A capability the entity lacks
 * is absent from the summary, never listed as disabled.
 */
export type InteractionAction =
  | { readonly kind: InteractionActionKind; readonly availability: "enabled" }
  | {
      readonly kind: InteractionActionKind;
      readonly availability: "disabled";
      readonly reason: InteractionDenialReason;
    };

export interface InteractionSummary {
  readonly entityId: ObjectId;
  readonly mode: InteractionMode;
  readonly actions: readonly InteractionAction[];
}

/** Requests a server-authorized projection, never embodiment or transfer. */
export interface ChangeViewedSpace {
  readonly type: "change_viewed_space";
  readonly requestId: string;
  readonly scope: BrowserScope;
  readonly targetSpaceId: SpaceId;
  readonly selectedEntityId?: ObjectId;
}

/** A refusal carries no scope, so it cannot name the hidden destination it refused. */
export type FollowDisposition = {
  readonly requestId: string;
} & (
  | {
      readonly disposition: "followed" | "stayed_within_space";
      readonly scope: BrowserScope;
      readonly selectedEntityId: ObjectId;
      readonly authorized: true;
      readonly projectable: true;
    }
  | {
      readonly disposition: "permission_denied" | "target_hidden" | "unavailable";
      readonly selectedEntityId: null;
    }
);

/** Private attributed communication; it is never a spatial speech cue. */
export interface PrivateCaretakerTalk {
  readonly type: "private_caretaker_talk";
  readonly messageId: string;
  readonly scope: BrowserScope;
  readonly principalId: PrincipalId;
  readonly caretakerId: WorldPersonaId;
  readonly caretakerName: string;
  readonly actorId: ObjectId;
  readonly text: string;
  readonly sentAt: string;
}

export interface PublicSpeech {
  readonly type: "public_speech";
  readonly messageId: string;
  readonly scope: BrowserScope;
  readonly speakerId: ObjectId;
  readonly text: string;
  readonly sentAt: string;
}

export function decodeFeedSummary(value: unknown, path = "feedSummary"): FeedSummary {
  const v = record(value, path);
  exactKeys(v, ["id", "simTimeMs", "kind", "text", "sourceEventIds"], [], path);
  return Object.freeze({
    id: string(v.id, `${path}.id`),
    simTimeMs: unsignedDecimal(v.simTimeMs, `${path}.simTimeMs`),
    kind: literal(v.kind, ["material"], `${path}.kind`),
    text: string(v.text, `${path}.text`),
    sourceEventIds: array(v.sourceEventIds, `${path}.sourceEventIds`, (id, p) =>
      decodeOpaqueId(id, "EventId", p),
    ),
  });
}

export function decodeInteractionSummary(
  value: unknown,
  path = "interactionSummary",
): InteractionSummary {
  const v = record(value, path);
  exactKeys(v, ["entityId", "mode", "actions"], [], path);
  const kinds = new Set<string>();
  return Object.freeze({
    entityId: decodeOpaqueId(v.entityId, "ObjectId", `${path}.entityId`),
    mode: literal(v.mode, ["inspectable", "reactive", "cognitive", "interpreted"], `${path}.mode`),
    actions: array(v.actions, `${path}.actions`, (action, p) => {
      const a = record(action, p);
      const kind = literal(a.kind, INTERACTION_ACTION_KINDS, `${p}.kind`);
      if (kinds.has(kind)) throw new ContractDecodeError(`${p}.kind`, "duplicate action");
      kinds.add(kind);
      const availability = literal(a.availability, ["enabled", "disabled"], `${p}.availability`);
      if (availability === "enabled") {
        exactKeys(a, ["kind", "availability"], [], p);
        return Object.freeze({ kind, availability });
      }
      exactKeys(a, ["kind", "availability", "reason"], [], p);
      const reasons = Object.keys(INTERACTION_DENIAL_REASONS) as InteractionDenialReason[];
      return Object.freeze({
        kind,
        availability,
        reason: literal(a.reason, reasons, `${p}.reason`),
      });
    }),
  });
}

export function decodeChangeViewedSpace(value: unknown): ChangeViewedSpace {
  const path = "changeViewedSpace";
  const v = record(value, path);
  exactKeys(v, ["type", "requestId", "scope", "targetSpaceId"], ["selectedEntityId"], path);
  return Object.freeze({
    type: literal(v.type, ["change_viewed_space"], `${path}.type`),
    requestId: string(v.requestId, `${path}.requestId`),
    scope: decodeBrowserScope(v.scope),
    targetSpaceId: decodeOpaqueId(v.targetSpaceId, "SpaceId", `${path}.targetSpaceId`),
    ...("selectedEntityId" in v
      ? {
          selectedEntityId: decodeOpaqueId(
            v.selectedEntityId,
            "ObjectId",
            `${path}.selectedEntityId`,
          ),
        }
      : {}),
  });
}

export function decodeFollowDisposition(value: unknown): FollowDisposition {
  const path = "followDisposition";
  const v = record(value, path);
  const disposition = literal(
    v.disposition,
    ["followed", "stayed_within_space", "permission_denied", "target_hidden", "unavailable"],
    `${path}.disposition`,
  );
  const requestId = string(v.requestId, `${path}.requestId`);
  if (disposition === "followed" || disposition === "stayed_within_space") {
    exactKeys(
      v,
      ["requestId", "scope", "disposition", "selectedEntityId", "authorized", "projectable"],
      [],
      path,
    );
    if (v.authorized !== true || v.projectable !== true)
      throw new ContractDecodeError(
        path,
        "retained selection requires an authorized projectable target",
      );
    return Object.freeze({
      requestId,
      scope: decodeBrowserScope(v.scope),
      disposition,
      selectedEntityId: decodeOpaqueId(v.selectedEntityId, "ObjectId", `${path}.selectedEntityId`),
      authorized: true,
      projectable: true,
    });
  }
  exactKeys(v, ["requestId", "disposition", "selectedEntityId"], [], path);
  if (v.selectedEntityId !== null)
    throw new ContractDecodeError(
      `${path}.selectedEntityId`,
      "unavailable selection must be cleared",
    );
  return Object.freeze({ requestId, disposition, selectedEntityId: null });
}

export function decodePrivateCaretakerTalk(value: unknown): PrivateCaretakerTalk {
  const path = "privateCaretakerTalk";
  const v = record(value, path);
  exactKeys(
    v,
    [
      "type",
      "messageId",
      "scope",
      "principalId",
      "caretakerId",
      "caretakerName",
      "actorId",
      "text",
      "sentAt",
    ],
    [],
    path,
  );
  return Object.freeze({
    type: literal(v.type, ["private_caretaker_talk"], `${path}.type`),
    messageId: string(v.messageId, `${path}.messageId`),
    scope: decodeBrowserScope(v.scope),
    principalId: decodeOpaqueId(v.principalId, "PrincipalId", `${path}.principalId`),
    caretakerId: decodeOpaqueId(v.caretakerId, "WorldPersonaId", `${path}.caretakerId`),
    caretakerName: string(v.caretakerName, `${path}.caretakerName`),
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    text: string(v.text, `${path}.text`),
    sentAt: utcTimestamp(v.sentAt, `${path}.sentAt`),
  });
}

export function decodePublicSpeech(value: unknown): PublicSpeech {
  const path = "publicSpeech";
  const v = record(value, path);
  exactKeys(v, ["type", "messageId", "scope", "speakerId", "text", "sentAt"], [], path);
  return Object.freeze({
    type: literal(v.type, ["public_speech"], `${path}.type`),
    messageId: string(v.messageId, `${path}.messageId`),
    scope: decodeBrowserScope(v.scope),
    speakerId: decodeOpaqueId(v.speakerId, "ObjectId", `${path}.speakerId`),
    text: string(v.text, `${path}.text`),
    sentAt: utcTimestamp(v.sentAt, `${path}.sentAt`),
  });
}

/** A typed Influence intent: offer one unit of the entity's resource. Attribution is the server's. */
export interface InfluenceRequest {
  readonly scope: BrowserScope;
  readonly intentId: string;
  readonly objectId: ObjectId;
  readonly resourceKind: string;
  /** The projection revision the caller saw; a later world state rejects the intent as stale. */
  readonly expectedRevision: bigint;
}

export function decodeInfluenceRequest(value: unknown): InfluenceRequest {
  const path = "influence";
  const v = record(value, path);
  exactKeys(
    v,
    [
      "version",
      "tenantId",
      "worldId",
      "timelineId",
      "spaceId",
      "intentId",
      "objectId",
      "resourceKind",
      "expectedRevision",
    ],
    [],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return Object.freeze({
    scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }),
    intentId: boundedId(v.intentId, `${path}.intentId`),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    resourceKind: boundedId(v.resourceKind, `${path}.resourceKind`),
    expectedRevision: unsignedDecimal(v.expectedRevision, `${path}.expectedRevision`),
  });
}

/** The server-resolved identity a submitted intent was attributed to. */
export interface InteractionAttribution {
  readonly principalId: PrincipalId;
  readonly personaId: WorldPersonaId | null;
}

/**
 * What happened to an Influence intent: the world accepted and committed it with its consequence,
 * or rejected it. It is a suggestion the world decided, never direct control of an actor.
 */
export type InfluenceReceipt = {
  readonly intentId: string;
  readonly commandId: string;
  readonly objectId: ObjectId;
  readonly attribution: InteractionAttribution;
} & (
  | {
      readonly status: "committed";
      readonly revision: string;
      readonly consequences: readonly { readonly eventId: EventId; readonly type: string }[];
    }
  | { readonly status: "rejected"; readonly reason: string }
);

function decodeAttribution(value: unknown, path: string): InteractionAttribution {
  const v = record(value, path);
  exactKeys(v, ["principalId", "personaId"], [], path);
  return Object.freeze({
    principalId: decodeOpaqueId(v.principalId, "PrincipalId", `${path}.principalId`),
    personaId:
      v.personaId === null
        ? null
        : decodeOpaqueId(v.personaId, "WorldPersonaId", `${path}.personaId`),
  });
}

export function decodeInfluenceReceipt(value: unknown): InfluenceReceipt {
  const path = "influenceReceipt";
  const v = record(value, path);
  const status = literal(v.status, ["committed", "rejected"], `${path}.status`);
  const common = {
    intentId: string(v.intentId, `${path}.intentId`),
    commandId: string(v.commandId, `${path}.commandId`),
    objectId: decodeOpaqueId(v.objectId, "ObjectId", `${path}.objectId`),
    attribution: decodeAttribution(v.attribution, `${path}.attribution`),
  };
  const keys = ["intentId", "commandId", "objectId", "attribution", "status"];
  if (status === "rejected") {
    exactKeys(v, [...keys, "reason"], [], path);
    return Object.freeze({ ...common, status, reason: string(v.reason, `${path}.reason`) });
  }
  exactKeys(v, [...keys, "revision", "consequences"], [], path);
  return Object.freeze({
    ...common,
    status,
    revision: unsignedDecimal(v.revision, `${path}.revision`).toString(),
    consequences: array(v.consequences, `${path}.consequences`, (item, p) => {
      const c = record(item, p);
      exactKeys(c, ["eventId", "type"], [], p);
      return Object.freeze({
        eventId: decodeOpaqueId(c.eventId, "EventId", `${p}.eventId`),
        type: string(c.type, `${p}.type`),
      });
    }),
  });
}

/**
 * Public Say: the explicit action that has the addressed actor speak a scripted line aloud in its
 * space. It is distinct from private Caretaker Talk (`conversations.ts`), which is never spoken.
 */
export interface SayRequest {
  readonly scope: BrowserScope;
  readonly messageId: string;
  readonly actorId: ObjectId;
  readonly text: string;
  readonly channel?: ConversationChannel;
  readonly threadId?: string;
  readonly ingress?: ChannelIngressMetadata;
}

/** Bounds a Say line, like a chat line. */
const MAX_SAY_OCTETS = 1024;

export function decodeSayRequest(value: unknown): SayRequest {
  const path = "say";
  const v = record(value, path);
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId", "messageId", "actorId", "text"],
    ["channel", "threadId", "ingress"],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  const text = string(v.text, `${path}.text`);
  if (text.trim() === "" || new TextEncoder().encode(text).length > MAX_SAY_OCTETS)
    throw new ContractDecodeError(`${path}.text`, "text length out of range");
  return Object.freeze({
    scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }),
    messageId: boundedId(v.messageId, `${path}.messageId`),
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    text,
    ...(v.channel === undefined
      ? {}
      : { channel: literal(v.channel, CONVERSATION_CHANNELS, `${path}.channel`) }),
    ...(v.threadId === undefined
      ? {}
      : { threadId: decodeChannelId(v.threadId, `${path}.threadId`) }),
    ...(v.ingress === undefined ? {} : { ingress: decodeChannelIngressMetadata(v.ingress) }),
  });
}

/** Say's receipt: the public speech and who made the actor speak. Nothing is stored. */
export interface SayReceipt {
  readonly type: "public_say";
  readonly speech: PublicSpeech;
  /** The trusted principal and persona whose explicit action made the actor speak. */
  readonly attribution: InteractionAttribution;
}

export function decodeSayReceipt(value: unknown): SayReceipt {
  const path = "sayReceipt";
  const v = record(value, path);
  exactKeys(v, ["type", "speech", "attribution"], [], path);
  return Object.freeze({
    type: literal(v.type, ["public_say"], `${path}.type`),
    speech: decodePublicSpeech(v.speech),
    attribution: decodeAttribution(v.attribution, `${path}.attribution`),
  });
}

// Matches the inspector requests' ID bound (migrations 0022, 0031).
function boundedId(value: unknown, path: string): string {
  const id = string(value, path);
  if (id === "" || id.trim() !== id || new TextEncoder().encode(id).length > 1024)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}
