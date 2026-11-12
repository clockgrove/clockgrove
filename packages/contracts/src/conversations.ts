import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import {
  type ChannelIngressMetadata,
  CONVERSATION_CHANNELS,
  type ConversationChannel,
  decodeChannelId,
  decodeChannelIngressMetadata,
} from "./channels.js";
import { decodeOpaqueId, type ObjectId, type PrincipalId, type WorldPersonaId } from "./ids.js";
import {
  array,
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
  utcTimestamp,
} from "./validation.js";

/**
 * Who is answering (Wave 5 §6.3): an actor's subjective communication, a narrated interpretation of
 * modeled state, or an authorized explanation from world evidence. The Conversation mode component
 * (`clockgrove.conversation-mode`) holds one of these.
 */
export const VOICE_MODES = ["cognitive", "interpreted", "canonical"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

/** The label a session shows at creation and on each answer. */
export const VOICE_DISCLOSURES: Readonly<Record<VoiceMode, string>> = Object.freeze({
  cognitive: "Actor's subjective communication",
  interpreted: "Narrated interpretation of modeled state; the object is not sentient",
  canonical: "Authorized explanation from world evidence",
});

/** `locked` is reserved for later moderation; `deleted` is terminal. */
export const CONVERSATION_STATES = ["active", "archived", "locked", "deleted"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** Decision: a chat line's bound, the Wave 4 Talk fixture's 1024 octets. */
export const MAX_CONVERSATION_TEXT_OCTETS = 1024;
/** Decision: a title fits one selector row. */
export const MAX_CONVERSATION_TITLE_CHARACTERS = 120;
/** Decision: one read page; a client pages with `afterSequence`. */
export const MAX_CONVERSATION_PAGE = 100;

/** A human participant of a session: a principal and their world persona. */
export interface ConversationSessionParticipant {
  readonly principalId: PrincipalId;
  readonly personaId: WorldPersonaId;
}

/**
 * A private session with one addressed actor and its own history, scoped by its participant set
 * (Wave 5 §6.1). A Caretaker Talk session has exactly one participant.
 */
export interface ConversationSession {
  readonly sessionId: string;
  /** Where the session was opened; it is read from any space of its world timeline. */
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  /** At least one, ordered by principal ID; a principal and a persona appear at most once each. */
  readonly participants: readonly ConversationSessionParticipant[];
  readonly channel: ConversationChannel;
  readonly threadId?: string;
  readonly privacyClass: "conversation";
  readonly voiceMode: VoiceMode;
  readonly disclosure: string;
  readonly title: string;
  readonly state: ConversationState;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModerationShadowJudgement {
  readonly mode: "shadow";
  readonly status: "picked" | "low-confidence" | "cant-tell" | "failed" | "skipped";
  readonly disposition: "allow" | "flag" | "block" | null;
  readonly injection: boolean | null;
  readonly confidenceBp: number | null;
  readonly modelAlias: string;
  readonly model: string | null;
  readonly latencyMs: number | null;
  readonly costMicrousd: number | null;
}

export function decodeModerationShadowJudgement(
  value: unknown,
  path = "moderationShadow",
): ModerationShadowJudgement {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "mode",
      "status",
      "disposition",
      "injection",
      "confidenceBp",
      "modelAlias",
      "model",
      "latencyMs",
      "costMicrousd",
    ],
    [],
    path,
  );
  const confidenceBp =
    v.confidenceBp === null ? null : nonNegativeInteger(v.confidenceBp, `${path}.confidenceBp`);
  if (confidenceBp !== null && confidenceBp > 10000)
    throw new ContractDecodeError(path, "confidence out of range");
  if (v.injection !== null && typeof v.injection !== "boolean")
    throw new ContractDecodeError(path, "expected nullable injection boolean");
  return Object.freeze({
    mode: literal(v.mode, ["shadow"], `${path}.mode`),
    status: literal(
      v.status,
      ["picked", "low-confidence", "cant-tell", "failed", "skipped"],
      `${path}.status`,
    ),
    disposition:
      v.disposition === null
        ? null
        : literal(v.disposition, ["allow", "flag", "block"], `${path}.disposition`),
    injection: v.injection as boolean | null,
    confidenceBp,
    modelAlias: string(v.modelAlias, `${path}.modelAlias`),
    model: v.model === null ? null : string(v.model, `${path}.model`),
    latencyMs: v.latencyMs === null ? null : nonNegativeInteger(v.latencyMs, `${path}.latencyMs`),
    costMicrousd:
      v.costMicrousd === null ? null : nonNegativeInteger(v.costMicrousd, `${path}.costMicrousd`),
  });
}

/** An immutable transcript entry; `sequence` orders a session's messages from 1. */
export interface ConversationMessage {
  readonly sessionId: string;
  readonly sequence: number;
  readonly messageId: string;
  readonly role: "caretaker" | "actor";
  /** The Caretaker's world persona, or the addressed actor. */
  readonly authorId: string;
  /** An actor answer's voice mode; null on the Caretaker's own words. */
  readonly voiceMode: VoiceMode | null;
  readonly text: string;
  readonly createdAt: string;
  /** On an actor reply: the world command proposed in that turn and what became of it, read from run evidence. */
  readonly command?: TalkCommandOutcome;
  readonly moderationShadow?: ModerationShadowJudgement;
  /** Runtime degradation is a service disposition, not an actor's authored behavior. */
  readonly serviceOutcome?:
    | "model_unavailable"
    | "model_steps_exhausted"
    | "cost_budget_exhausted"
    | "tool_calls_exhausted";
}

/** One input message and its answer. The scripted fixture completes a turn in its request. */
export interface ConversationTurn {
  readonly sessionId: string;
  readonly turn: number;
  readonly inputSequence: number;
  readonly outputSequence: number;
  /** The model that answered: `scripted-fixture-v1`, or the route alias a real model answered under. */
  readonly model: string;
  readonly state: "completed";
  readonly createdAt: string;
}

export interface ConversationList {
  readonly sessions: readonly ConversationSession[];
}

export interface ConversationTranscript {
  readonly session: ConversationSession;
  readonly messages: readonly ConversationMessage[];
  readonly turns: readonly ConversationTurn[];
  /** The `afterSequence` of the next page, or null at the end. */
  readonly nextAfterSequence: number | null;
}

/**
 * Private Caretaker Talk: the participant's message to the session's actor. It is stored in the
 * session and never becomes spatial speech.
 */
export interface TalkReceipt {
  readonly type: "private_caretaker_talk";
  readonly session: ConversationSession;
  readonly message: ConversationMessage;
  readonly reply: ConversationMessage;
  readonly turn: ConversationTurn;
  /** The world command the actor proposed this turn, if any, and what became of it. */
  readonly command?: TalkCommandOutcome;
}

/** A model-proposed world command's outcome: committed, or refused with the stable reason code. */
export interface TalkCommandOutcome {
  readonly capability: string;
  readonly commandId: string | null;
  readonly status: "committed" | "refused";
  readonly code: string | null;
  readonly summary: string;
}

export interface CreateConversationRequest {
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  readonly title?: string;
  readonly channel?: ConversationChannel;
  readonly threadId?: string;
}
export interface ConversationListRequest {
  readonly scope: BrowserScope;
  readonly actorId?: ObjectId;
}
export interface ConversationReadRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly afterSequence: number;
  readonly limit: number;
}
export interface ConversationTitleRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly title: string;
}
export interface ConversationArchiveRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly archived: boolean;
}
export interface ConversationDeleteRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
}
export interface TalkRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
  readonly ingress?: ChannelIngressMetadata;
}

const SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"] as const;

function scoped(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const v = record(value, path);
  exactKeys(v, [...SCOPE_KEYS, ...required], optional, path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return { v, scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }) };
}

// Matches the inspector requests' ID bound (migrations 0022, 0031).
function boundedId(value: unknown, path: string): string {
  const id = string(value, path);
  if (id.trim() !== id || new TextEncoder().encode(id).length > 1024)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}

/** The answer to message `x` is stored as `x:reply`, so a client message ID may not end with it. */
const REPLY_MESSAGE_ID_SUFFIX = ":reply";

function talkMessageId(value: unknown, path: string): string {
  const id = boundedId(value, path);
  if (id.endsWith(REPLY_MESSAGE_ID_SUFFIX))
    throw new ContractDecodeError(path, `message ID must not end with ${REPLY_MESSAGE_ID_SUFFIX}`);
  return id;
}

export function decodeConversationText(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.trim() === "" || new TextEncoder().encode(text).length > MAX_CONVERSATION_TEXT_OCTETS)
    throw new ContractDecodeError(path, "text length out of range");
  return text;
}

export function decodeConversationTitle(value: unknown, path: string): string {
  const title = string(value, path);
  if (title.trim() !== title || [...title].length > MAX_CONVERSATION_TITLE_CHARACTERS)
    throw new ContractDecodeError(path, "title length out of range");
  return title;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractDecodeError(path, "expected a boolean");
  return value;
}

export function decodeCreateConversationRequest(value: unknown): CreateConversationRequest {
  const path = "createConversation";
  const { v, scope } = scoped(value, path, ["actorId"], ["title", "channel", "threadId"]);
  return Object.freeze({
    scope,
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    ...(v.channel === undefined
      ? {}
      : { channel: literal(v.channel, CONVERSATION_CHANNELS, `${path}.channel`) }),
    ...(v.threadId === undefined
      ? {}
      : { threadId: decodeChannelId(v.threadId, `${path}.threadId`) }),
    ...(v.title === undefined ? {} : { title: decodeConversationTitle(v.title, `${path}.title`) }),
  });
}

export function decodeConversationListRequest(value: unknown): ConversationListRequest {
  const path = "listConversations";
  const { v, scope } = scoped(value, path, [], ["actorId"]);
  return Object.freeze({
    scope,
    ...(v.actorId === undefined
      ? {}
      : { actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`) }),
  });
}

export function decodeConversationReadRequest(value: unknown): ConversationReadRequest {
  const path = "readConversation";
  const { v, scope } = scoped(value, path, ["sessionId"], ["afterSequence", "limit"]);
  const limit = v.limit === undefined ? MAX_CONVERSATION_PAGE : nonNegativeInteger(v.limit, path);
  if (limit < 1 || limit > MAX_CONVERSATION_PAGE)
    throw new ContractDecodeError(`${path}.limit`, "limit out of range");
  return Object.freeze({
    scope,
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    afterSequence:
      v.afterSequence === undefined
        ? 0
        : nonNegativeInteger(v.afterSequence, `${path}.afterSequence`),
    limit,
  });
}

export function decodeConversationTitleRequest(value: unknown): ConversationTitleRequest {
  const path = "titleConversation";
  const { v, scope } = scoped(value, path, ["sessionId", "title"]);
  return Object.freeze({
    scope,
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    title: decodeConversationTitle(v.title, `${path}.title`),
  });
}

export function decodeConversationArchiveRequest(value: unknown): ConversationArchiveRequest {
  const path = "archiveConversation";
  const { v, scope } = scoped(value, path, ["sessionId", "archived"]);
  return Object.freeze({
    scope,
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    archived: boolean(v.archived, `${path}.archived`),
  });
}

export function decodeConversationDeleteRequest(value: unknown): ConversationDeleteRequest {
  const path = "deleteConversation";
  const { v, scope } = scoped(value, path, ["sessionId"]);
  return Object.freeze({ scope, sessionId: boundedId(v.sessionId, `${path}.sessionId`) });
}

export function decodeTalkRequest(value: unknown): TalkRequest {
  const path = "talk";
  const { v, scope } = scoped(value, path, ["sessionId", "messageId", "text"], ["ingress"]);
  return Object.freeze({
    scope,
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    messageId: talkMessageId(v.messageId, `${path}.messageId`),
    text: decodeConversationText(v.text, `${path}.text`),
    ...(v.ingress === undefined ? {} : { ingress: decodeChannelIngressMetadata(v.ingress) }),
  });
}

export function decodeConversationSession(
  value: unknown,
  path = "conversationSession",
): ConversationSession {
  const v = record(value, path);
  exactKeys(
    v,
    [
      "sessionId",
      "scope",
      "actorId",
      "participants",
      "channel",
      "privacyClass",
      "voiceMode",
      "disclosure",
      "title",
      "state",
      "messageCount",
      "createdAt",
      "updatedAt",
    ],
    ["threadId"],
    path,
  );
  const participants = array(v.participants, `${path}.participants`, (item, itemPath) => {
    const participant = record(item, itemPath);
    exactKeys(participant, ["principalId", "personaId"], [], itemPath);
    return Object.freeze({
      principalId: decodeOpaqueId(
        participant.principalId,
        "PrincipalId",
        `${itemPath}.principalId`,
      ),
      personaId: decodeOpaqueId(participant.personaId, "WorldPersonaId", `${itemPath}.personaId`),
    });
  });
  if (
    participants.length === 0 ||
    new Set(participants.map((p) => p.principalId)).size !== participants.length ||
    new Set(participants.map((p) => p.personaId)).size !== participants.length
  )
    throw new ContractDecodeError(`${path}.participants`, "expected distinct participants");
  const voiceMode = literal(v.voiceMode, VOICE_MODES, `${path}.voiceMode`);
  if (v.disclosure !== VOICE_DISCLOSURES[voiceMode])
    throw new ContractDecodeError(`${path}.disclosure`, "does not match the voice mode");
  return Object.freeze({
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    scope: decodeBrowserScope(v.scope),
    actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`),
    participants,
    channel: literal(v.channel, CONVERSATION_CHANNELS, `${path}.channel`),
    ...(v.threadId === undefined
      ? {}
      : { threadId: decodeChannelId(v.threadId, `${path}.threadId`) }),
    privacyClass: literal(v.privacyClass, ["conversation"], `${path}.privacyClass`),
    voiceMode,
    disclosure: VOICE_DISCLOSURES[voiceMode],
    title: v.title === "" ? "" : decodeConversationTitle(v.title, `${path}.title`),
    state: literal(v.state, CONVERSATION_STATES, `${path}.state`),
    messageCount: nonNegativeInteger(v.messageCount, `${path}.messageCount`),
    createdAt: utcTimestamp(v.createdAt, `${path}.createdAt`),
    updatedAt: utcTimestamp(v.updatedAt, `${path}.updatedAt`),
  });
}

export function decodeConversationMessage(
  value: unknown,
  path = "conversationMessage",
): ConversationMessage {
  const v = record(value, path);
  exactKeys(
    v,
    ["sessionId", "sequence", "messageId", "role", "authorId", "voiceMode", "text", "createdAt"],
    ["command", "moderationShadow", "serviceOutcome"],
    path,
  );
  const role = literal(v.role, ["caretaker", "actor"], `${path}.role`);
  if (role === "caretaker" && v.voiceMode !== null)
    throw new ContractDecodeError(`${path}.voiceMode`, "a Caretaker message has no voice mode");
  const voiceMode =
    role === "caretaker" ? null : literal(v.voiceMode, VOICE_MODES, `${path}.voiceMode`);
  return Object.freeze({
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    sequence: nonNegativeInteger(v.sequence, `${path}.sequence`),
    messageId: boundedId(v.messageId, `${path}.messageId`),
    role,
    authorId: boundedId(v.authorId, `${path}.authorId`),
    voiceMode,
    text: string(v.text, `${path}.text`),
    createdAt: utcTimestamp(v.createdAt, `${path}.createdAt`),
    ...(v.serviceOutcome === undefined
      ? {}
      : {
          serviceOutcome: literal(
            v.serviceOutcome,
            [
              "model_unavailable",
              "model_steps_exhausted",
              "cost_budget_exhausted",
              "tool_calls_exhausted",
            ],
            `${path}.serviceOutcome`,
          ),
        }),
    ...(v.command === undefined
      ? {}
      : { command: decodeTalkCommandOutcome(v.command, `${path}.command`) }),
    ...(v.moderationShadow === undefined
      ? {}
      : {
          moderationShadow: decodeModerationShadowJudgement(
            v.moderationShadow,
            `${path}.moderationShadow`,
          ),
        }),
  });
}

export function decodeConversationTurn(
  value: unknown,
  path = "conversationTurn",
): ConversationTurn {
  const v = record(value, path);
  exactKeys(
    v,
    ["sessionId", "turn", "inputSequence", "outputSequence", "model", "state", "createdAt"],
    [],
    path,
  );
  return Object.freeze({
    sessionId: boundedId(v.sessionId, `${path}.sessionId`),
    turn: nonNegativeInteger(v.turn, `${path}.turn`),
    inputSequence: nonNegativeInteger(v.inputSequence, `${path}.inputSequence`),
    outputSequence: nonNegativeInteger(v.outputSequence, `${path}.outputSequence`),
    model: modelName(v.model, `${path}.model`),
    state: literal(v.state, ["completed"], `${path}.state`),
    createdAt: utcTimestamp(v.createdAt, `${path}.createdAt`),
  });
}

export function decodeConversationList(value: unknown): ConversationList {
  const v = record(value, "conversationList");
  exactKeys(v, ["sessions"], [], "conversationList");
  return Object.freeze({
    sessions: array(v.sessions, "conversationList.sessions", decodeConversationSession),
  });
}

export function decodeConversationTranscript(value: unknown): ConversationTranscript {
  const path = "conversationTranscript";
  const v = record(value, path);
  exactKeys(v, ["session", "messages", "turns", "nextAfterSequence"], [], path);
  return Object.freeze({
    session: decodeConversationSession(v.session, `${path}.session`),
    messages: array(v.messages, `${path}.messages`, decodeConversationMessage),
    turns: array(v.turns, `${path}.turns`, decodeConversationTurn),
    nextAfterSequence:
      v.nextAfterSequence === null
        ? null
        : nonNegativeInteger(v.nextAfterSequence, `${path}.nextAfterSequence`),
  });
}

export function decodeTalkReceipt(value: unknown): TalkReceipt {
  const path = "talkReceipt";
  const v = record(value, path);
  exactKeys(v, ["type", "session", "message", "reply", "turn"], ["command"], path);
  return Object.freeze({
    type: literal(v.type, ["private_caretaker_talk"], `${path}.type`),
    session: decodeConversationSession(v.session, `${path}.session`),
    message: decodeConversationMessage(v.message, `${path}.message`),
    reply: decodeConversationMessage(v.reply, `${path}.reply`),
    turn: decodeConversationTurn(v.turn, `${path}.turn`),
    ...(v.command === undefined
      ? {}
      : { command: decodeTalkCommandOutcome(v.command, `${path}.command`) }),
  });
}

function modelName(value: unknown, path: string): string {
  const text = string(value, path);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(text))
    throw new ContractDecodeError(path, "expected a model name");
  return text;
}

function decodeTalkCommandOutcome(value: unknown, path: string): TalkCommandOutcome {
  const v = record(value, path);
  exactKeys(v, ["capability", "commandId", "status", "code", "summary"], [], path);
  return Object.freeze({
    capability: boundedId(v.capability, `${path}.capability`),
    commandId: v.commandId === null ? null : boundedId(v.commandId, `${path}.commandId`),
    status: literal(v.status, ["committed", "refused"], `${path}.status`),
    code: v.code === null ? null : boundedId(v.code, `${path}.code`),
    summary: string(v.summary, `${path}.summary`),
  });
}
