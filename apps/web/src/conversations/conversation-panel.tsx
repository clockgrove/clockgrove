import {
  type ConversationMessage,
  type ConversationSession,
  type ObjectId,
  VOICE_DISCLOSURES,
} from "@clockgrove/contracts";
import { useCallback, useEffect, useState } from "react";
import type { YardSession } from "../yard-api.js";

const VOICE_PENDING = "The actor is";
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
  const [provisional, setProvisional] = useState("");
  const [phase, setPhase] = useState<string>();
  const hooks = { onProvisional: setProvisional, onPhase: setPhase };

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
    const load = () =>
      session.readConversation(selectedId).then((page) => {
        if (!live) return;
        if ("refused" in page) return setRefusal(page.refused);
        setCurrent(page.session);
        setTitle(page.session.title);
        setMessages(page.messages);
        setNext(page.nextAfterSequence);
      });
    void load().then(async () => {
      // A turn this browser left in flight is settled from its durable status, then re-read.
      const resumed = await session.resumeTurn(selectedId, {
        onProvisional: (text) => live && setProvisional(text),
        onPhase: (value) => live && setPhase(value),
      });
      if (!live || !resumed) return;
      setPhase(undefined);
      if ("refused" in resumed) setRefusal(resumed.refused);
      else await load();
    });
    return () => {
      live = false;
    };
  }, [session, selectedId]);

  const settled = async (sessionId: string) => {
    const page = await session.readConversation(sessionId);
    if ("refused" in page) return refuse(page);
    setCurrent(page.session);
    setMessages(page.messages);
    setNext(page.nextAfterSequence);
    await reload(sessionId);
  };

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
    setDraft("");
    const receipt = await session.talk(current.sessionId, text, hooks);
    setPhase(undefined);
    if ("refused" in receipt) {
      setDraft(text);
      return refuse(receipt);
    }
    if ("reloaded" in receipt) return settled(current.sessionId);
    setCurrent(receipt.session);
    // The receipt holds both new messages. Append them when the loaded tail is the end of the
    // transcript; otherwise the next "load more" page reaches them. No transcript or list re-read.
    if (next === null) setMessages((all) => [...all, receipt.message, receipt.reply]);
    setSessions((all) => [
      receipt.session,
      ...all.filter((s) => s.sessionId !== receipt.session.sessionId),
    ]);
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
          <div aria-live="polite">
            {phase && <p>Reply in progress ({phase.replaceAll("_", " ")})</p>}
            {provisional && (
              <p>
                <em>{VOICE_PENDING} replying…</em> {provisional}
              </p>
            )}
          </div>
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
