import {
  INTERACTION_DENIAL_REASONS,
  INTERACTION_DISCLOSURES,
  type InfluenceReceipt,
  type InteractionActionKind,
  type InteractionAttribution,
  type InteractionSummary,
  type ObjectId,
  type PrivateCaretakerTalk,
  type PublicSpeech,
} from "@clockgrove/contracts";
import { useId, useState } from "react";
import { whyOpener } from "./why.js";
import type { YardSession } from "./yard-api.js";
import { useSelectionQuery } from "./yard-queries.js";

export const ACTION_LABELS: Readonly<Record<InteractionActionKind, string>> = {
  talk: "Talk",
  observe: "Observe",
  inspect: "Inspect",
  remember: "Remember",
  history: "History",
  influence: "Influence",
  why: "Why",
};

type Outcome = InfluenceReceipt | { readonly refused: string } | "proposed";

function focusSection(id: string): void {
  const target = document.getElementById(id);
  target?.scrollIntoView?.({ block: "start" });
  target?.focus();
}

/** The selected entity's server-evaluated capabilities; nothing is inferred client-side. */
export function InteractionCard({
  session,
  entityId,
  summary,
}: {
  readonly session: YardSession;
  readonly entityId: ObjectId;
  readonly summary: InteractionSummary | undefined;
}) {
  const idBase = useId();
  const selection = useSelectionQuery(session).value;
  const [note, setNote] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [draft, setDraft] = useState("");
  const [privateLog, setPrivateLog] = useState<readonly PrivateCaretakerTalk[]>([]);
  const [replies, setReplies] = useState<readonly string[]>([]);
  const [speech, setSpeech] = useState<readonly PublicSpeech[]>([]);
  const [attributions, setAttributions] = useState<readonly InteractionAttribution[]>([]);
  const [talkRefusal, setTalkRefusal] = useState<string>();
  if (!summary)
    return (
      <section aria-label="Interactions">
        <p>No interactions available for this entity.</p>
      </section>
    );
  const resource = selection?.objectId === entityId ? selection.physical.resource : undefined;

  const run = async (kind: InteractionActionKind, opener: HTMLElement) => {
    setNote(undefined);
    if (kind === "inspect" || kind === "observe") focusSection("rw-selected-entity");
    else if (kind === "history" || kind === "remember") focusSection("rw-recent-actions");
    else if (kind === "why" && selection?.objectId === entityId) {
      whyOpener.current = opener;
      const found = await session.explainNewestDecision(selection).catch(() => false);
      if (!found) return setNote("No recorded decision in this entity's history.");
      focusSection("rw-recorded-why");
    }
  };
  const offer = async () => {
    if (!resource) return;
    setOutcome("proposed");
    setOutcome(await session.influence(entityId, resource.kind));
  };
  const talk = async (channel: "private" | "public") => {
    const text = draft.trim();
    if (!text) return;
    setTalkRefusal(undefined);
    const receipt = await session.talk(entityId, channel, text);
    if ("refused" in receipt) return setTalkRefusal(receipt.refused);
    if (receipt.channel === "private") {
      setPrivateLog((log) => [...log, receipt.talk]);
      setReplies((all) => [...all, receipt.reply]);
    } else {
      setSpeech((all) => [...all, receipt.speech]);
      setAttributions((all) => [...all, receipt.attribution]);
    }
    setDraft("");
  };

  const has = (kind: InteractionActionKind) => summary.actions.some((a) => a.kind === kind);
  return (
    <section aria-label="Interactions">
      <p className="rw-disclosure">{INTERACTION_DISCLOSURES[summary.mode]}</p>
      <ul>
        {summary.actions.map((action) => {
          const reasonId = `${idBase}-${action.kind}`;
          return (
            <li key={action.kind}>
              <button
                type="button"
                disabled={action.availability === "disabled"}
                aria-describedby={action.availability === "disabled" ? reasonId : undefined}
                onClick={(event) => void run(action.kind, event.currentTarget)}
              >
                {ACTION_LABELS[action.kind]}
              </button>
              {action.availability === "disabled" && (
                <span id={reasonId}> {INTERACTION_DENIAL_REASONS[action.reason]}</span>
              )}
            </li>
          );
        })}
      </ul>
      {note && <p role="status">{note}</p>}
      {enabled(summary, "influence") && resource && (
        <button type="button" onClick={offer}>
          Offer 1 {resource.kind} (a suggestion; the world decides)
        </button>
      )}
      {outcome && <InfluenceStages outcome={outcome} />}
      {enabled(summary, "talk") && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void talk("private");
          }}
        >
          <p>Scripted Talk fixture: this actor has no conversation memory.</p>
          <label>
            Message
            <input value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <button type="submit">Talk privately</button>
          <button type="button" onClick={() => void talk("public")}>
            Say publicly (scripted)
          </button>
          {talkRefusal && <p role="status">Talk refused: {talkRefusal}</p>}
        </form>
      )}
      {has("talk") && (
        <>
          <ol aria-label="Private Caretaker talk">
            {privateLog.map((talk, i) => (
              <li key={talk.messageId}>
                {talk.caretakerName}: {talk.text}
                <br />
                {replies[i]}
              </li>
            ))}
          </ol>
          <div aria-label="Public speech" aria-live="polite" role="log">
            {speech.map((line, i) => (
              <p key={line.messageId}>
                {line.speakerId} says: {line.text} (asked by persona{" "}
                {attributions[i]?.personaId ?? "none"})
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function enabled(summary: InteractionSummary, kind: InteractionActionKind): boolean {
  return summary.actions.some((a) => a.kind === kind && a.availability === "enabled");
}

function InfluenceStages({ outcome }: { readonly outcome: Outcome }) {
  const stages = ["Proposed: offer submitted"];
  if (outcome !== "proposed") {
    if ("refused" in outcome) stages.push(`Influence refused: ${outcome.refused}`);
    else if (outcome.status === "rejected") stages.push(`Rejected: ${outcome.reason}`);
    else
      stages.push(
        "Accepted by the world",
        `Committed at revision ${outcome.revision}`,
        `Consequence: ${outcome.consequences.map((c) => c.type).join(", ") || "none"}`,
      );
  }
  const receipt = outcome === "proposed" || "refused" in outcome ? undefined : outcome;
  return (
    <div role="status">
      <ol aria-label="Influence stages">
        {stages.map((stage) => (
          <li key={stage}>{stage}</li>
        ))}
      </ol>
      {receipt && (
        <p>
          Attributed to persona {receipt.attribution.personaId ?? "none"} (principal{" "}
          {receipt.attribution.principalId})
        </p>
      )}
    </div>
  );
}
