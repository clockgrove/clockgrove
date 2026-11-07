import {
  type ConversationParticipant,
  ConversationRefusedError,
  type ConversationResponse,
  type ConversationStore,
} from "@clockgrove/application";
import {
  type BrowserScope,
  type ConversationSession,
  decodeConversationArchiveRequest,
  decodeConversationDeleteRequest,
  decodeConversationListRequest,
  decodeConversationReadRequest,
  decodeConversationTitleRequest,
  decodeCreateConversationRequest,
  decodeTalkRequest,
  type ObjectId,
} from "@clockgrove/contracts";

/** The conversation routes of the HTTP API (`docs/protocols/conversations.openapi.json`). */
export const CONVERSATION_ROUTES = [
  "/v1/runtime/conversations/create",
  "/v1/runtime/conversations/list",
  "/v1/runtime/conversations/read",
  "/v1/runtime/conversations/title",
  "/v1/runtime/conversations/archive",
  "/v1/runtime/conversations/delete",
  "/v1/runtime/talk",
] as const;
export type ConversationRoute = (typeof CONVERSATION_ROUTES)[number];

/** Runs one operation against a store over its own connection. */
export type ConversationStores = <T>(
  operation: (store: ConversationStore) => Promise<T>,
) => Promise<T>;

/**
 * The scripted model fixture's answer (Wave 5 §17: scripted models stay deterministic fixtures). It
 * depends only on its own session, so two sessions' answers show their histories are separate.
 *
 * The fixture is scripted by its input: a first line `fixture:propose <path>` makes it propose the
 * rest of the text as that document's content, the way a model returns a path it chose. The
 * proposal is validated as any model proposal is (`docs/protocols/context-assembly.md`).
 */
export function scriptedConversationReply(
  _session: ConversationSession,
  caretakerMessages: number,
  input: string,
): ConversationResponse {
  const text = `Scripted fixture reply: you have said ${caretakerMessages} ${
    caretakerMessages === 1 ? "thing" : "things"
  } to me in this conversation.`;
  const script = /^fixture:propose (\S+)\n([\s\S]*)$/.exec(input);
  const [, path, content] = script ?? [];
  if (path === undefined || content === undefined) return { text };
  return { text, proposal: { path, content } };
}

export interface ConversationCall {
  /** The scope to authorize: the request's world timeline and space. */
  readonly scope: BrowserScope;
  /** The actor a new session addresses; the caller checks it is projected first. */
  readonly actorId?: ObjectId;
  readonly run: (
    store: ConversationStore,
    participant: ConversationParticipant,
  ) => Promise<unknown>;
}

/** Decodes a conversation route's body into its scope and its store operation. */
export function conversationCall(route: ConversationRoute, body: unknown): ConversationCall {
  switch (route) {
    case "/v1/runtime/conversations/create": {
      const input = decodeCreateConversationRequest(body);
      return {
        scope: input.scope,
        actorId: input.actorId,
        // Every Talk-addressable actor speaks for itself: no pack object declares an interpreted
        // or canonical Conversation mode yet.
        run: (store, participant) => store.open(participant, { ...input, voiceMode: "cognitive" }),
      };
    }
    case "/v1/runtime/conversations/list": {
      const input = decodeConversationListRequest(body);
      return {
        scope: input.scope,
        run: async (store, participant) => ({
          sessions: await store.list(participant, input.scope, input.actorId),
        }),
      };
    }
    case "/v1/runtime/conversations/read": {
      const input = decodeConversationReadRequest(body);
      return {
        scope: input.scope,
        run: (store, participant) =>
          store.read(participant, input.scope, input.sessionId, input.afterSequence, input.limit),
      };
    }
    case "/v1/runtime/conversations/title": {
      const input = decodeConversationTitleRequest(body);
      return {
        scope: input.scope,
        run: (store, participant) =>
          store.title(participant, input.scope, input.sessionId, input.title),
      };
    }
    case "/v1/runtime/conversations/archive": {
      const input = decodeConversationArchiveRequest(body);
      return {
        scope: input.scope,
        run: (store, participant) =>
          store.archive(participant, input.scope, input.sessionId, input.archived),
      };
    }
    case "/v1/runtime/conversations/delete": {
      const input = decodeConversationDeleteRequest(body);
      return {
        scope: input.scope,
        run: async (store, participant) => {
          await store.delete(participant, input.scope, input.sessionId);
          return { deleted: true };
        },
      };
    }
    case "/v1/runtime/talk": {
      const input = decodeTalkRequest(body);
      return {
        scope: input.scope,
        run: (store, participant) => store.talk(participant, input, scriptedConversationReply),
      };
    }
  }
}

/** The HTTP status of each refusal. */
export const CONVERSATION_REFUSAL_STATUS: Readonly<
  Record<ConversationRefusedError["code"], number>
> = {
  conversation_not_found: 404,
  conversation_not_active: 409,
  conversation_full: 409,
  conversation_limit_reached: 409,
  message_id_reused: 409,
  conversation_busy: 409,
};

export { ConversationRefusedError };
