import type {
  BrowserScope,
  ConversationSession,
  ConversationTranscript,
  ObjectId,
  TalkReceipt,
  TalkRequest,
  VoiceMode,
  WorldPersonaId,
} from "@clockgrove/contracts";

import type { DocumentProposal } from "./cognition.js";
import type { RuntimeAuthorizationContext } from "./persistence.js";

/** The participant a conversation call acts for: the authorized principal and their world persona. */
export interface ConversationParticipant extends RuntimeAuthorizationContext {
  readonly personaId: WorldPersonaId;
}

/** What the store needs to open a session; the caller has already checked the addressed actor. */
export interface OpenConversation {
  readonly scope: BrowserScope;
  readonly actorId: ObjectId;
  readonly voiceMode: VoiceMode;
  readonly title?: string;
}

/**
 * The answer a turn records. It sees the session and the number of Caretaker messages it will hold
 * once this one is stored; it never sees another session.
 */
export type ConversationResponder = (
  session: ConversationSession,
  caretakerMessages: number,
  input: string,
) => ConversationResponse;

/** The model's answer: its reply, and at most one document change it proposes (issue 17). */
export interface ConversationResponse {
  readonly text: string;
  readonly proposal?: DocumentProposal;
}

/**
 * Canonical private conversations. Every call is scoped to the participant: a session of another
 * principal, tenant, world or timeline, or a deleted one, is not found.
 */
export interface ConversationStore {
  open(participant: ConversationParticipant, input: OpenConversation): Promise<ConversationSession>;
  list(
    participant: ConversationParticipant,
    scope: BrowserScope,
    actorId?: ObjectId,
  ): Promise<readonly ConversationSession[]>;
  read(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): Promise<ConversationTranscript>;
  title(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    title: string,
  ): Promise<ConversationSession>;
  archive(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
    archived: boolean,
  ): Promise<ConversationSession>;
  delete(
    participant: ConversationParticipant,
    scope: BrowserScope,
    sessionId: string,
  ): Promise<void>;
  talk(
    participant: ConversationParticipant,
    request: TalkRequest,
    respond: ConversationResponder,
  ): Promise<TalkReceipt>;
}

export type ConversationRefusalCode =
  | "conversation_not_found"
  | "conversation_not_active"
  | "conversation_full"
  | "conversation_limit_reached"
  | "message_id_reused"
  | "conversation_busy";

/** A refused conversation call; nothing was changed. */
export class ConversationRefusedError extends Error {
  constructor(readonly code: ConversationRefusalCode) {
    super(`conversation refused: ${code}`);
    this.name = "ConversationRefusedError";
  }
}
