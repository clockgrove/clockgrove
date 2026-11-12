import {
  type CommandId,
  type ConversationMessage,
  type ConversationSession,
  type InteractionActionKind,
  type InteractionSummary,
  type ObjectId,
  type RunWalk,
  type TalkCommandOutcome,
  VOICE_DISCLOSURES,
} from "@clockgrove/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Portrait } from "../portrait.js";
import type { SceneSession } from "../scene-api.js";
import { useSelectionQuery } from "../scene-queries.js";
import { useEntityRail } from "../scene-state.js";
import { whyOpener } from "../why.js";

const RAIL_ACTIONS = [
  ["talk", "Talk"],
  ["observe", "Observe"],
  ["remember", "Remember"],
  ["why", "Why?"],
] as const;

const LEAF = "M5 19C5 9 11 5 19 5c0 9-4 14-12 14M5 19l7-7";

function displayName(label: string): string {
  const segment = label.split(".").pop() || label;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function worldTime(createdAt: string): string {
  return new Date(createdAt).toISOString().slice(11, 16);
}

const UNTITLED = "Untitled conversation";

function sessionLabel(session: ConversationSession): string {
  return `${session.title || UNTITLED}${session.state === "archived" ? " (archived)" : ""}`;
}

/** Durable private sessions with one actor; everything shown is read back from the server. */
export function ConversationPanel({
  session,
  actorId,
  summary,
  onAction,
}: {
  readonly session: SceneSession;
  readonly actorId: ObjectId;
  /** When given, the rail's Talk / Observe / Remember / Why? grid is drawn from its actions. */
  readonly summary?: InteractionSummary | undefined;
  readonly onAction?: (kind: InteractionActionKind, opener: HTMLElement) => void;
}) {
  const selected = useSelectionQuery(session).value;
  const name = displayName(
    selected?.objectId === actorId ? selected.entity.presentation.label : actorId,
  );
  const input = useRef<HTMLInputElement>(null);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, TalkCommandOutcome>>>({});
  const [lastCommand, setLastCommand] = useState<string>();
  const publicAction = selected?.objectId === actorId ? selected.history.actions[0] : undefined;
  const statusLine =
    publicAction === undefined
      ? `${name} has done nothing public lately`
      : `Last public action: ${publicAction.type.replaceAll(/[._]/g, " ")}`;
  const closeRail = useEntityRail((rail) => rail.toggle);
  const [sessions, setSessions] = useState<readonly ConversationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  // The chosen conversation and a creation in flight, read by a send before the next render.
  const chosen = useRef<string>(undefined);
  const creating = useRef<Promise<ConversationSession | { readonly refused: string }>>(undefined);
  const [current, setCurrent] = useState<ConversationSession>();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [refusal, setRefusal] = useState<string>();
  const [provisional, setProvisional] = useState("");
  const [phase, setPhase] = useState<string>();
  const [toolEvidence, setToolEvidence] = useState<RunWalk>();
  const evidenceRequest = useRef(0);
  const hooks = { onProvisional: setProvisional, onPhase: setPhase };

  const enabledAction = (kind: InteractionActionKind) =>
    summary?.actions.some((a) => a.kind === kind && a.availability === "enabled") ?? false;
  const openWhy = (commandId: string, opener: HTMLElement) => {
    whyOpener.current = opener;
    session.explainReceipt(commandId as CommandId);
  };
  const inspectTools = async (messageId: string) => {
    if (!current) return;
    const request = ++evidenceRequest.current;
    setToolEvidence(undefined);
    setRefusal(undefined);
    // Reply IDs append :reply to their canonical input; entering by input reaches every attempt.
    const inputMessageId = messageId.endsWith(":reply") ? messageId.slice(0, -6) : messageId;
    const evidence = await session.inspectConversationRun(current.sessionId, inputMessageId);
    if (request !== evidenceRequest.current) return;
    if ("refused" in evidence) setRefusal(evidence.refused);
    else setToolEvidence(evidence);
  };
  const railAction = (kind: InteractionActionKind, opener: HTMLElement) => {
    if (kind === "talk") input.current?.focus();
    else if (kind === "why" && whyCommand) openWhy(whyCommand, opener);
    else onAction?.(kind, opener);
  };

  const refuse = (value: { readonly refused: string }) => {
    setRefusal(value.refused);
  };

  const choose = useCallback((id: string | undefined) => {
    chosen.current = id;
    ++evidenceRequest.current;
    setToolEvidence(undefined);
    setSelectedId(id);
  }, []);

  const reload = useCallback(
    async (preferred?: string) => {
      const list = await session.listConversations(actorId);
      if ("refused" in list) return setRefusal(list.refused);
      setSessions(list.sessions);
      // On opening, the conversation whose reply this tab left in progress comes first: a turn's
      // acceptance does not make its conversation the most recently updated.
      const wanted =
        preferred ??
        chosen.current ??
        list.sessions.find((s) => session.hasPendingTurn(s.sessionId))?.sessionId;
      choose(
        list.sessions.some((s) => s.sessionId === wanted) ? wanted : list.sessions[0]?.sessionId,
      );
    },
    [session, actorId, choose],
  );

  useEffect(() => {
    setRefusal(undefined);
    choose(undefined);
    void reload();
  }, [reload, choose]);

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
  /** Creates a conversation and chooses it; a send while it is in flight waits for it. */
  const startConversation = async () => {
    const pending = session.createConversation(actorId).then((created) => {
      if (!("refused" in created)) choose(created.sessionId);
      return created;
    });
    creating.current = pending;
    try {
      return await pending;
    } finally {
      if (creating.current === pending) creating.current = undefined;
    }
  };
  const create = async () => {
    setRefusal(undefined);
    const created = await startConversation();
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
    choose(undefined);
    await reload();
  };
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setRefusal(undefined);
    // The message goes to the chosen conversation, or to the one being created, even before it has
    // loaded; only with neither is a conversation created for it.
    const started = await creating.current;
    if (started !== undefined && "refused" in started) return refuse(started);
    let sessionId = chosen.current;
    if (sessionId === undefined) {
      const created = await startConversation();
      if ("refused" in created) return refuse(created);
      sessionId = created.sessionId;
    }
    setDraft("");
    const receipt = await session.talk(sessionId, text, hooks);
    setPhase(undefined);
    if ("refused" in receipt) {
      setDraft(text);
      return refuse(receipt);
    }
    if ("reloaded" in receipt) return settled(sessionId);
    const command = receipt.command;
    if (command) {
      if (command.commandId !== null) setLastCommand(command.commandId);
      setOutcomes((all) => ({ ...all, [receipt.reply.messageId]: command }));
    }
    setCurrent(receipt.session);
    // The receipt holds both new messages. Append them when the loaded tail is the end of the
    // transcript; otherwise the next "load more" page reaches them. No transcript or list re-read.
    if (next === null) setMessages((all) => [...all, receipt.message, receipt.reply]);
    setSessions((all) => [
      receipt.session,
      ...all.filter((s) => s.sessionId !== receipt.session.sessionId),
    ]);
  };

  // A reloaded transcript carries each turn's outcome from run evidence; this session's receipts add to it.
  const outcomeOf = (message: ConversationMessage) =>
    outcomes[message.messageId] ?? message.command;
  const whyCommand =
    lastCommand ?? messages.findLast((m) => m.command?.commandId)?.command?.commandId ?? undefined;
  const shown = RAIL_ACTIONS.filter(([kind]) =>
    kind === "why" ? whyCommand !== undefined || enabledAction(kind) : enabledAction(kind),
  );
  return (
    <section className="rw-actor" aria-label="Private conversation">
      <header className="rw-actor-head">
        <h2>{name}</h2>
        <button type="button" aria-label="Close conversation" onClick={closeRail}>
          ×
        </button>
      </header>
      <div className="rw-actor-portrait">
        <Portrait label={name} className="rw-actor-avatar" />
        <span
          className="rw-voice-badge"
          role="img"
          aria-label={VOICE_DISCLOSURES[current?.voiceMode ?? "cognitive"]}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={LEAF} />
          </svg>
        </span>
      </div>
      <p className="rw-actor-status">{statusLine}</p>
      {shown.length > 0 && (
        <div className="rw-actor-actions">
          {shown.map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              onClick={(event) => railAction(kind, event.currentTarget)}
            >
              {text}
            </button>
          ))}
        </div>
      )}
      <p className="rw-disclosure">
        {name} is model-backed. This conversation is private to you and never spoken aloud in the
        world.
      </p>
      <label>
        Conversation
        <select
          value={selectedId ?? ""}
          onChange={(event) => choose(event.target.value || undefined)}
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
        <details>
          <summary>Manage conversation</summary>
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
        </details>
      )}
      <>
        <ol className="rw-chat" aria-label="Conversation history">
          {messages.map((message) => {
            const mine = message.role === "caretaker";
            const service = message.serviceOutcome !== undefined;
            const outcome = outcomeOf(message);
            return (
              <li
                key={message.messageId}
                className="rw-bubble"
                data-from={mine ? "you" : service ? "system" : "actor"}
              >
                {!mine && !service && <Portrait label={name} className="rw-bubble-avatar" />}
                <div>
                  <strong>{mine ? "You" : service ? "Runtime status" : name}</strong>
                  {!service && message.voiceMode && (
                    <em> ({VOICE_DISCLOSURES[message.voiceMode]})</em>
                  )}
                  <p>{message.text}</p>
                  {!mine && message.text.includes("[tool:") && (
                    <button type="button" onClick={() => void inspectTools(message.messageId)}>
                      Why? Tool evidence
                    </button>
                  )}
                  <time dateTime={message.createdAt} data-wall-clock>
                    {worldTime(message.createdAt)}
                  </time>
                  {outcome && (
                    <p className="rw-outcome" data-status={outcome.status}>
                      {outcome.status === "committed"
                        ? `${name}'s proposal committed`
                        : `refused: ${outcome.summary}`}{" "}
                      {outcome.commandId !== null && (
                        <button
                          type="button"
                          onClick={(event) =>
                            openWhy(outcome.commandId as string, event.currentTarget)
                          }
                        >
                          Why?
                        </button>
                      )}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div aria-live="polite">
          {phase && (
            <p>
              {phase === "tool_using"
                ? "Using tool…"
                : phase === "tool_waiting"
                  ? "Waiting for tool…"
                  : `Reply in progress (${phase.replaceAll("_", " ")})`}
            </p>
          )}
          {provisional && (
            <p>
              <em>{name} is replying…</em> {provisional}
            </p>
          )}
        </div>
        {toolEvidence && (
          <aside aria-label="Tool evidence">
            <h3>Tool evidence</h3>
            <button type="button" onClick={() => setToolEvidence(undefined)}>
              Close evidence
            </button>
            {toolEvidence.runs.map((run) => (
              <div key={run.runId}>
                <p>
                  Run {run.runId} · message {run.inputMessageId} · {run.status}
                </p>
                <ol>
                  {run.steps
                    .filter(
                      (step) => step.kind === "tool_proposal" || step.kind === "tool_execution",
                    )
                    .map((step) => (
                      <li key={step.step}>
                        <p>
                          {step.tool} · {step.status} · {step.outcomeCode ?? "ok"}
                        </p>
                        <p>{step.summary}</p>
                        {step.toolEvidence && (
                          <dl>
                            <dt>Call</dt>
                            <dd>{step.toolEvidence.callId}</dd>
                            <dt>Effect</dt>
                            <dd>{step.toolEvidence.effectId}</dd>
                            <dt>Grant</dt>
                            <dd>{step.toolEvidence.grantId ?? "none"}</dd>
                            <dt>Result</dt>
                            <dd>{step.toolEvidence.resultArtifactId ?? "none"}</dd>
                            <dt>Queue latency</dt>
                            <dd>
                              {step.toolEvidence.queueLatencyMs === null
                                ? "unknown"
                                : `${step.toolEvidence.queueLatencyMs} ms`}
                            </dd>
                          </dl>
                        )}
                        {step.output && <p>Protected result: {step.output.artifactId}</p>}
                      </li>
                    ))}
                </ol>
              </div>
            ))}
          </aside>
        )}
        {next !== null && (
          <button type="button" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
        {(!current || current.state === "active") && (
          <form
            className="rw-actor-send"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <input
              ref={input}
              aria-label={`Message ${name}…`}
              placeholder={`Message ${name}…`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" aria-label="Send">
              Send
            </button>
          </form>
        )}
      </>
      {refusal && <p role="status">Conversation refused: {refusal}</p>}
    </section>
  );
}
