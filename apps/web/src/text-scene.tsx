import {
  INTERACTION_DISCLOSURES,
  type InteractionSummary,
  type LivingScene,
  type ObjectId,
  type WorldFeedItem,
} from "@clockgrove/contracts";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { weatherText } from "./hud.js";
import { ACTION_LABELS } from "./interaction-card.js";

/** Follows `value` at most once per interval: the first value at once, then only the latest. */
export function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    // Anchor the interval to publication, rather than scheduling a React update.
    if (shown !== undefined) last.current = Date.now();
  }, [shown]);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const commit = () => setShown(value);
    const wait = last.current + intervalMs - Date.now();
    if (value === undefined || wait <= 0) return commit();
    const timer = setTimeout(commit, wait);
    return () => clearTimeout(timer);
  }, [value, shown, intervalMs]);
  return shown;
}

/**
 * Live announcements are bounded to one per interval: a polite announcement of about ten words
 * takes about 3 s at a typical screen-reader rate of about 200 words per minute (issue 812 plan, assumption 4).
 */
export const ANNOUNCE_INTERVAL_MS = 3000;
/** The live log keeps its last five announcements (issue 812 plan, assumption 4). */
const LOG_LENGTH = 5;

const NAVIGATION: Readonly<Record<string, (at: number, last: number) => number>> = {
  ArrowDown: (at) => at + 1,
  ArrowRight: (at) => at + 1,
  ArrowUp: (at) => at - 1,
  ArrowLeft: (at) => at - 1,
  Home: () => 0,
  End: (_, last) => last,
};

/** Arrow keys, Home and End move focus between entity buttons; Tab and Enter work as before. */
function moveEntityFocus(event: KeyboardEvent<HTMLUListElement>): void {
  const move = NAVIGATION[event.key];
  if (!move) return;
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-focus-key]"),
  ];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  buttons[Math.min(Math.max(move(at, buttons.length - 1), 0), buttons.length - 1)]?.focus();
}

function publicState(summary: InteractionSummary | undefined): string {
  if (!summary) return "Interactions: none";
  const enabled = summary.actions.filter((action) => action.availability === "enabled");
  return `Interactions: ${summary.mode}, ${INTERACTION_DISCLOSURES[summary.mode]}; available actions ${enabled.map((action) => ACTION_LABELS[action.kind]).join(", ") || "none"}`;
}

/** The text scene's entity list: every perceivable entity, its pose and its interactions. */
export function TextSceneEntities({
  scene,
  interactions,
  selected,
  select,
  focus,
}: {
  readonly scene: LivingScene;
  readonly interactions: readonly InteractionSummary[];
  readonly selected: ObjectId | undefined;
  readonly select: (objectId: ObjectId) => void;
  readonly focus: (objectId: ObjectId | undefined) => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys reach the list's own buttons.
    <ul onKeyDown={moveEntityFocus}>
      {scene.entities.map((entity) => (
        <li key={entity.objectId}>
          <button
            type="button"
            data-focus-key={`entity:${entity.objectId}`}
            aria-pressed={selected === entity.objectId}
            onClick={() => select(entity.objectId)}
            onFocus={() => focus(entity.objectId)}
            onBlur={() => focus(undefined)}
          >
            {entity.presentation.label}
          </button>
          <span>
            {" "}
            Identity: {entity.objectId}; archetype: {entity.archetypeId}; frame:{" "}
            {entity.pose.frameId} version {entity.pose.frameVersion}; position:{" "}
            {entity.pose.coordinates.join(", ")}
          </span>
          <span>
            {"; "}
            {publicState(interactions.find((summary) => summary.entityId === entity.objectId))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One sentence naming the space, the viewed place, the weather and how many entities are perceived. */
export function spaceSummary(
  scene: LivingScene,
  world: string,
  space: string,
  viewing: string,
): string {
  const count = scene.entities.length;
  return `${world}, space ${space}, viewing ${viewing}. Weather: ${weatherText(scene)}. ${count} perceivable ${count === 1 ? "entity" : "entities"}.`;
}

interface Observed {
  readonly scene: LivingScene | undefined;
  readonly feed: readonly WorldFeedItem[] | undefined;
}

/** What changed between two announced observations, as one sentence; empty when nothing did. */
function describeChanges(before: Observed, after: Observed): string {
  const parts: string[] = [];
  const previous = before.scene;
  const current = after.scene;
  if (previous && current) {
    if (previous.weather.rainIntensity !== current.weather.rainIntensity)
      parts.push(`Weather now ${weatherText(current)}`);
    const earlier = new Map(previous.entities.map((entity) => [entity.objectId, entity]));
    for (const entity of current.entities) {
      const was = earlier.get(entity.objectId);
      const label = entity.presentation.label;
      if (!was) parts.push(`${label} appeared`);
      else if (was.pose.coordinates.join() !== entity.pose.coordinates.join())
        parts.push(`${label} moved to ${entity.pose.coordinates.join(", ")}`);
      earlier.delete(entity.objectId);
    }
    for (const gone of earlier.values()) parts.push(`${gone.presentation.label} left the view`);
  }
  if (before.feed && after.feed) {
    const known = new Set(before.feed.map((item) => item.id));
    const label = (objectId: ObjectId | null) =>
      current?.entities.find((entity) => entity.objectId === objectId)?.presentation.label;
    for (const item of after.feed.filter((candidate) => !known.has(candidate.id)).reverse()) {
      const name = label(item.objectId);
      parts.push(`Event: ${name ? `${name}: ${item.text}` : item.text}`);
    }
  }
  return parts.length === 0 ? "" : `${parts.join(". ")}.`;
}

/**
 * Announces actor movement, arrivals, departures, weather and new material events politely, at
 * most once per `ANNOUNCE_INTERVAL_MS`; the first observation of a scope is the baseline.
 */
export function LiveChanges({
  scene,
  feed,
}: {
  readonly scene: LivingScene | undefined;
  readonly feed: readonly WorldFeedItem[] | undefined;
}) {
  const latest = useMemo<Observed>(() => ({ scene, feed }), [scene, feed]);
  const announced = useThrottled(latest, ANNOUNCE_INTERVAL_MS);
  const previous = useRef<Observed>(announced);
  const [log, setLog] = useState<readonly { readonly id: number; readonly text: string }[]>([]);
  const sequence = useRef(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = announced;
    if (before === announced) return;
    const text = describeChanges(before, announced);
    if (text)
      setLog((entries) => [...entries, { id: ++sequence.current, text }].slice(-LOG_LENGTH));
  }, [announced]);
  return (
    <section aria-labelledby="rw-live-changes">
      <h2 id="rw-live-changes">Live changes</h2>
      <div role="log" aria-live="polite" aria-labelledby="rw-live-changes">
        {log.length === 0 && <p>No changes since arrival.</p>}
        {log.map((entry) => (
          <p key={entry.id}>{entry.text}</p>
        ))}
      </div>
    </section>
  );
}
