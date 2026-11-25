import type {
  Flashback,
  FlashbackActorState,
  FlashbackContext,
  FlashbackEntry,
  FlashbackLineKind,
  ObjectId,
} from "@clockgrove/contracts";
import { useEffect, useRef, useState } from "react";
import { FlashbackReplay, FlashbackStage } from "./flashback-pip.js";
import type { RendererContent } from "./renderer-content.js";
import type { SceneSession } from "./scene-api.js";
import { useFlashbackQuery } from "./scene-queries.js";
import { useLiveTier } from "./scene-state.js";

/** The control that opened the flashback, so closing it returns focus there. */
export const flashbackOpener: { current: HTMLElement | null } = { current: null };

const LINE_KINDS: Readonly<Record<FlashbackLineKind, string>> = {
  context: "Context",
  cause: "Cause",
  influence: "Influence",
  unknown: "Unknown",
  limit: "Limit",
};

function replayText(value: Flashback): string {
  const { replay, bounds } = value;
  if (replay.status !== "replayed")
    return replay.status === "beyond-catch-up-bound"
      ? `Not replayed: this moment is more than ${bounds.catchUpEvents} journaled events past its nearest snapshot. Its recorded causes follow.`
      : "Not replayed: the journal around this moment holds events this view may not see. Its recorded causes follow.";
  const start = replay.start === "birth" ? "the world's birth" : `snapshot ${replay.start}`;
  return `Replayed read-only from ${start}: ${replay.eventsReplayed} journaled events, ${value.frames.length} frames${replay.truncated ? "; the window was cut at its declared bound" : ""}.`;
}

/**
 * The moment's time as the runtime's own context line gives it (elapsed hours and minutes into the
 * recorded day), so the panel shows one time for one moment whatever the pack's day length.
 */
export function timeText(context: FlashbackContext): string {
  if (context.day === null || context.timeOfDayMs === null)
    return `${context.simulationTime} ms into the world`;
  const minutes = BigInt(context.timeOfDayMs) / 60_000n;
  return `Day ${context.day}, ${minutes / 60n}:${(minutes % 60n).toString().padStart(2, "0")} into the day`;
}

/** One step of an "and before that…" chain: the entry asked for and the entity it followed. */
interface ChainStep {
  readonly key: string;
  readonly entry: FlashbackEntry;
  readonly objectId: ObjectId | undefined;
}

const entryKeyOf = (entry: FlashbackEntry): string =>
  "eventId" in entry ? `event ${entry.eventId}` : `command ${entry.commandId}`;

function ActorState({ actor }: { readonly actor: FlashbackActorState }) {
  return (
    <dl aria-label={`State of ${actor.label}`}>
      <dt>Actor</dt>
      <dd>{actor.label}</dd>
      <dt>Needs</dt>
      <dd>
        {actor.needs
          ? `hunger ${actor.needs.hunger}, wetness ${actor.needs.wetness}`
          : "Not recorded"}
      </dd>
      <dt>Wellbeing</dt>
      <dd>
        {actor.wellbeing
          ? `thirst ${actor.wellbeing.thirst}, health ${actor.wellbeing.health}, ${actor.wellbeing.comfort}`
          : "Not recorded"}
      </dd>
      <dt>Selected action</dt>
      <dd>
        {actor.selectedAction
          ? `${actor.selectedAction.kind}; target ${actor.selectedAction.targetObjectId ?? "None"}`
          : "None recorded"}
      </dd>
    </dl>
  );
}

/**
 * Issue 273: a past moment rebuilt read-only from the journal, its picture-in-picture replay, and
 * its context and causes as cited text. The text is the floor every tier keeps.
 */
export function FlashbackPanel({
  session,
  content,
  dayLengthMs,
}: {
  readonly session: SceneSession;
  readonly content?: RendererContent;
  readonly dayLengthMs: bigint | undefined;
}) {
  const flashback = useFlashbackQuery(session);
  const tier = useLiveTier((live) => live.tier);
  const heading = useRef<HTMLHeadingElement>(null);
  const open = flashback.status !== "none";
  const entry = flashback.entry;
  const entryKey = entry === undefined ? "" : entryKeyOf(entry);
  // The chain walked so far, ending at the open moment. A failed step keeps it, so the human can
  // retry that step or go back to the moment just left rather than re-walk from the first opener.
  const [chain, setChain] = useState<readonly ChainStep[]>([]);
  // Focus returns to the opener once the panel has gone, so a layout that hid it can show it again.
  const refocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (entryKey !== "") heading.current?.focus();
  }, [entryKey]);
  // Issue 273: one PiP renderer for the whole time the flashback is open, released on close.
  const [stage] = useState(() => new FlashbackStage());
  useEffect(() => () => stage.stop(), [stage]);
  useEffect(() => {
    if (open) return;
    stage.stop();
    setChain([]);
    refocus.current?.focus();
    refocus.current = null;
  }, [open, stage]);
  if (!open || entry === undefined) return null;
  const path: readonly ChainStep[] =
    chain.at(-1)?.key === entryKey ? chain : [{ key: entryKey, entry, objectId: undefined }];
  const current = path[path.length - 1] as ChainStep;
  const previous = path.length > 1 ? path[path.length - 2] : undefined;
  const failed =
    flashback.status === "refused" ||
    flashback.status === "unavailable" ||
    flashback.status === "not-found";
  const value = flashback.value;
  const step = (next: FlashbackEntry, objectId: ObjectId | undefined) => {
    setChain([...path, { key: entryKeyOf(next), entry: next, objectId }]);
    session.flashback(next, objectId);
  };
  const onClose = () => {
    const opener = flashbackOpener.current;
    const key = opener?.dataset.flashbackOpener;
    refocus.current = opener?.isConnected
      ? opener
      : key === undefined
        ? null
        : document.querySelector<HTMLElement>(`[data-flashback-opener="${CSS.escape(key)}"]`);
    session.flashback(undefined);
  };
  return (
    <section
      id="rw-flashback"
      className="rw-flashback"
      tabIndex={-1}
      aria-label="Flashback"
      aria-busy={flashback.status === "loading"}
    >
      <h3 ref={heading} tabIndex={-1}>
        Flashback: {"eventId" in entry ? `event ${entry.eventId}` : `command ${entry.commandId}`}
      </h3>
      <p>
        This past moment is rebuilt from the journal exactly as recorded. It changes nothing, and
        its summary comes only from recorded state and decisions.
      </p>
      <p role="status" aria-live="polite" aria-atomic="true">
        {flashback.status === "loading"
          ? "Loading flashback."
          : flashback.status === "refused"
            ? "Flashback request refused. Try again later."
            : flashback.status === "not-found"
              ? `Flashback not found: the journal holds no ${entryKey} in this space.`
              : flashback.status === "unavailable"
                ? "Flashback unavailable."
                : "Flashback loaded."}
      </p>
      {failed && (
        <button type="button" onClick={() => session.flashback(current.entry, current.objectId)}>
          Retry flashback
        </button>
      )}
      {failed && previous && (
        <button
          type="button"
          onClick={() => {
            setChain(path.slice(0, -1));
            session.flashback(previous.entry, previous.objectId);
          }}
        >
          {`Back to ${previous.key}`}
        </button>
      )}
      <button type="button" onClick={onClose}>
        Close flashback
      </button>
      {value && (
        <>
          <p>
            {`Moment: command ${value.moment.commandId}, partition sequence ${value.moment.partitionSequence}, simulation time ${value.moment.simulationTime} ms${value.moment.objectId === null ? "" : `, concerning ${value.moment.objectId}`}.`}
          </p>
          <p>{replayText(value)}</p>
          <p>
            {`Bounds: ${value.bounds.framesBefore} frames before and ${value.bounds.framesAfter} after; a window of ${value.bounds.windowEvents} events; a catch-up of ${value.bounds.catchUpEvents} events.`}
          </p>
          <FlashbackReplay
            key={`${value.moment.commandId}:${value.moment.partitionSequence}`}
            flashback={value}
            stage={stage}
            tier={tier}
            dayLengthMs={dayLengthMs}
            {...(content && { content })}
          />
          <section aria-label="Context at the moment">
            <h4>Context</h4>
            {value.context === null ? (
              <p>Context not replayed.</p>
            ) : (
              <>
                <dl>
                  <dt>Time</dt>
                  <dd>{timeText(value.context)}</dd>
                  <dt>Weather</dt>
                  <dd>
                    {value.context.rainIntensity === 0
                      ? "Dry"
                      : `Rain ${value.context.rainIntensity / 100}%`}
                  </dd>
                  <dt>Who was there</dt>
                  <dd>
                    {value.context.present.map((present) => present.label).join(", ") ||
                      "No one recorded"}
                  </dd>
                  <dt>Recorded revision</dt>
                  <dd>{value.context.revision}</dd>
                </dl>
                {value.context.actor && <ActorState actor={value.context.actor} />}
              </>
            )}
          </section>
          <section aria-label="Flashback summary">
            <h4>Summary</h4>
            <ul>
              {value.summary.map((line, index) => (
                // Lines are an ordered record; their text can repeat.
                // biome-ignore lint/suspicious/noArrayIndexKey: the summary never reorders.
                <li key={index} data-line-kind={line.kind}>
                  {`${LINE_KINDS[line.kind]}: ${line.text}`}
                  {line.cites.length > 0 && (
                    <span className="rw-flashback-cites">{` Cites ${line.cites.join(", ")}.`}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="And before that">
            <h4>And before that…</h4>
            {value.before.length === 0 ? (
              <p>Nothing earlier is recorded for this moment.</p>
            ) : (
              <ul>
                {value.before.map((commandId) => (
                  <li key={commandId}>
                    <button
                      type="button"
                      // Closing a chain returns focus to the control that opened its first flashback.
                      onClick={() => step({ commandId }, value.moment.objectId ?? undefined)}
                    >
                      {`And before that: command ${commandId}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
