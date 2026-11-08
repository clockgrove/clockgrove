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
  decodeTalkStreamFrame,
  decodeTurnRequest,
  type ObjectId,
  type TalkRequest,
  type TalkStreamFrame,
  type TurnRequest,
  type TurnStatus,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";

/** The conversation routes of the HTTP API (`docs/protocols/conversations.openapi.json`). */
export const CONVERSATION_ROUTES = [
  "/v1/runtime/conversations/create",
  "/v1/runtime/conversations/list",
  "/v1/runtime/conversations/read",
  "/v1/runtime/conversations/title",
  "/v1/runtime/conversations/archive",
  "/v1/runtime/conversations/delete",
  "/v1/runtime/talk",
  "/v1/runtime/turns/status",
  "/v1/runtime/turns/cancel",
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
  // `fixture:offer <objectId> <kind>` proposes a world command; `fixture:call <capability>` proposes
  // an arbitrary capability, which the registry's grants then decide (the injection journey).
  const offer = /^fixture:offer (\S+) (\S+)$/.exec(input);
  if (offer !== null)
    return {
      text,
      command: {
        capability: "world.command",
        input: { type: "resource.offer", objectId: offer[1], kind: offer[2] },
      },
    };
  const call = /^fixture:call (\S+) (\S+)$/.exec(input);
  if (call !== null)
    return {
      text,
      command: {
        capability: call[1] as string,
        input: { type: call[2], objectId: "any", kind: "any" },
      },
    };
  const script = /^fixture:propose (\S+)\n([\s\S]*)$/.exec(input);
  const [, path, content] = script ?? [];
  if (path === undefined || content === undefined) return { text };
  return { text, proposal: { path, content } };
}

/** A turn owner's answer across RPC, where error classes do not survive: a value or a refusal. */
export type TurnOwnerAnswer<T> =
  | { readonly value: T; readonly refused?: undefined }
  | { readonly refused: ConversationRefusedError["code"]; readonly value?: undefined };

/**
 * The actor owners that run turns (`ActorAgentDO`), addressed by the session's actor. Talk answers
 * an NDJSON stream of `TalkStreamFrame`s that ends with the receipt or the refusal.
 */
export interface TurnOwners {
  talk(
    actorId: string,
    participant: ConversationParticipant,
    context: TrustedExecutionContext,
    request: TalkRequest,
  ): Promise<ReadableStream<Uint8Array>>;
  status(
    actorId: string,
    participant: ConversationParticipant,
    context: TrustedExecutionContext,
    request: TurnRequest,
  ): Promise<TurnOwnerAnswer<TurnStatus>>;
  cancel(
    actorId: string,
    participant: ConversationParticipant,
    context: TrustedExecutionContext,
    request: TurnRequest,
  ): Promise<TurnOwnerAnswer<TurnStatus>>;
}

export interface ConversationCall {
  /** The scope to authorize: the request's world timeline and space. */
  readonly scope: BrowserScope;
  /** The actor a new session addresses; the caller checks it is projected first. */
  readonly actorId?: ObjectId;
  readonly run?: (
    store: ConversationStore,
    participant: ConversationParticipant,
  ) => Promise<unknown>;
  /** A call its session's actor owner answers: Talk, a turn's status, a cancel. */
  readonly owner?: {
    readonly sessionId: string;
    readonly run: (
      owners: TurnOwners,
      actorId: string,
      participant: ConversationParticipant,
      context: TrustedExecutionContext,
    ) => Promise<ReadableStream<Uint8Array> | TurnOwnerAnswer<TurnStatus>>;
  };
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
        owner: {
          sessionId: input.sessionId,
          run: (owners, actorId, participant, context) =>
            owners.talk(actorId, participant, context, input),
        },
      };
    }
    case "/v1/runtime/turns/status":
    case "/v1/runtime/turns/cancel": {
      const input = decodeTurnRequest(body);
      const cancel = route === "/v1/runtime/turns/cancel";
      return {
        scope: input.scope,
        owner: {
          sessionId: input.sessionId,
          run: (owners, actorId, participant, context) =>
            cancel
              ? owners.cancel(actorId, participant, context, input)
              : owners.status(actorId, participant, context, input),
        },
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
  turn_not_found: 404,
  turn_cancelled: 409,
};

/** NDJSON framing of a streamed Talk: one frame per line. */
export function encodeTalkFrame(frame: TalkStreamFrame): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

/** Reads a streamed Talk to its last frame, the durable outcome; undefined if the stream broke. */
export async function lastTalkFrame(
  stream: ReadableStream<Uint8Array>,
): Promise<TalkStreamFrame | undefined> {
  const decoder = new TextDecoder();
  let buffered = "";
  let last: TalkStreamFrame | undefined;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line !== "") last = decodeTalkStreamFrame(JSON.parse(line));
    }
  } catch {
    return undefined;
  }
  return last?.type === "delta" ? undefined : last;
}

export { ConversationRefusedError };
