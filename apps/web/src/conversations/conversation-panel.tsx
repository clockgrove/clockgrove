import {
  type ConversationMessage,
  type ConversationSession,
  type ObjectId,
  VOICE_DISCLOSURES,
} from "@clockgrove/contracts";
import { useCallback, useEffect, useState } from "react";
import type { YardSession } from "../yard-api.js";

const UNTITLED = "Untitled conversation";

function sessionLabel(session: ConversationSession): string {
  return `${session.title || UNTITLED}${session.state === "archived" ? " (archived)" : ""}`;
}

/** Durable private sessions with one actor; everything shown is read back from the server. */
export function ConversationPanel({
  session,
  actorId,
}: {
  readonly session: YardSession;
  readonly actorId: ObjectId;
}) {
  const [sessions, setSessions] = useState<readonly ConversationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [current, setCurrent] = useState<ConversationSession>();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [refusal, setRefusal] = useState<string>();

  const refuse = (value: { readonly refused: string }) => {
    setRefusal(value.refused);
  };

  const reload = useCallback(
    async (preferred?: string) => {
      const list = await session.listConversations(actorId);
      if ("refused" in list) return setRefusal(list.refused);
      setSessions(list.sessions);
      setSelectedId((id) => {
        const wanted = preferred ?? id;
        return list.sessions.some((s) => s.sessionId === wanted)
          ? wanted
          : list.sessions[0]?.sessionId;
      });
    },
    [session, actorId],
  );

  useEffect(() => {
    setRefusal(undefined);
    setSelectedId(undefined);
    void reload();
  }, [reload]);

  useEffect(() => {
    setMessages([]);
    setNext(null);
    setCurrent(undefined);
    if (!selectedId) return;
    let live = true;
    void session.readConversation(selectedId).then((page) => {
      if (!live) return;
      if ("refused" in page) return setRefusal(page.refused);
      setCurrent(page.session);
      setTitle(page.session.title);
      setMessages(page.messages);
      setNext(page.nextAfterSequence);
    });
    return () => {
      live = false;
    };
  }, [session, selectedId]);

  const loadMore = async () => {
    if (!current || next === null) return;
    const page = await session.readConversation(current.sessionId, next);
    if ("refused" in page) return refuse(page);
    setMessages((all) => [...all, ...page.messages]);
    setNext(page.nextAfterSequence);
  };
  const create = async () => {
    setRefusal(undefined);
    const created = await session.createConversation(actorId);
    if ("refused" in created) return refuse(created);
    await reload(created.sessionId);
  };
  const update = async (action: Promise<ConversationSession | { readonly refused: string }>) => {
    setRefusal(undefined);
    const result = await action;
    if ("refused" in result) return refuse(result);
    setCurrent(result);
    await reload(result.sessionId);
  };
  const remove = async () => {
    if (!current) return;
    setRefusal(undefined);
    const result = await session.deleteConversation(current.sessionId);
    if (result !== true) return refuse(result);
    setSelectedId(undefined);
    await reload();
  };
  const send = async () => {
    const text = draft.trim();
    if (!current || !text) return;
    setRefusal(undefined);
    const receipt = await session.talk(current.sessionId, text);
    if ("refused" in receipt) return refuse(receipt);
    setDraft("");
    setCurrent(receipt.session);
    // Reload the tail so the view matches the stored transcript, including paged-over messages.
    const page = await session.readConversation(receipt.session.sessionId);
    if ("refused" in page) return refuse(page);
    const all = [...page.messages];
    let cursor = page.nextAfterSequence;
    while (cursor !== null) {
      const more = await session.readConversation(receipt.session.sessionId, cursor);
      if ("refused" in more) return refuse(more);
      all.push(...more.messages);
      cursor = more.nextAfterSequence;
    }
    setMessages(all);
    setNext(null);
    await reload(receipt.session.sessionId);
  };

  return (
    <section aria-label="Private conversation">
      <p>Private to you; never spoken aloud in the world.</p>
      <label>
        Conversation
        <select
          value={selectedId ?? ""}
          onChange={(event) => setSelectedId(event.target.value || undefined)}
        >
          {sessions.length === 0 && <option value="">No conversations yet</option>}
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void create()}>
        New conversation
      </button>
      {current && (
        <>
          <p className="rw-disclosure">{current.disclosure}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void update(session.titleConversation(current.sessionId, title.trim()));
            }}
          >
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <button type="submit">Rename</button>
          </form>
          <button
            type="button"
            onClick={() =>
              void update(
                session.archiveConversation(current.sessionId, current.state !== "archived"),
              )
            }
          >
            {current.state === "archived" ? "Unarchive" : "Archive"}
          </button>
          <button type="button" onClick={() => void remove()}>
            Delete conversation
          </button>
          <ol aria-label="Conversation history">
            {messages.map((message) => (
              <li key={message.messageId}>
                <strong>{message.role === "caretaker" ? "You" : "Actor"}</strong>
                {message.voiceMode && <em> ({VOICE_DISCLOSURES[message.voiceMode]})</em>}:{" "}
                {message.text}
              </li>
            ))}
          </ol>
          {next !== null && (
            <button type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
          {current.state === "active" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <label>
                Message
                <input value={draft} onChange={(event) => setDraft(event.target.value)} />
              </label>
              <button type="submit">Talk privately</button>
            </form>
          )}
        </>
      )}
      {refusal && <p role="status">Conversation refused: {refusal}</p>}
    </section>
  );
}
