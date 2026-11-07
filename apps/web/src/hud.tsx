import type {
  LivingScene,
  WorldClock,
  WorldFeedCategory,
  WorldStatus,
} from "@clockgrove/contracts";
import { Portrait } from "./portrait.js";
import { whyOpener } from "./why.js";
import type { YardSession } from "./yard-api.js";
import { useEntityRail, useFeedSheet, useYardView } from "./yard-state.js";

/** A time of day on a 24-hour face, scaled from the pack's day length. */
function clockFace(timeOfDayMs: string, dayLengthMs: string): string {
  const minutes = (BigInt(timeOfDayMs) * 1440n) / BigInt(dayLengthMs);
  const pad = (value: bigint) => value.toString().padStart(2, "0");
  return `${pad(minutes / 60n)}:${pad(minutes % 60n)}`;
}

function dayText(clock: WorldClock): string {
  return clock.day === null || clock.timeOfDayMs === null || clock.dayLengthMs === null
    ? `Day unavailable, simulation time ${clock.simulationTime} ms`
    : `Day ${clock.day}, ${clockFace(clock.timeOfDayMs, clock.dayLengthMs)}`;
}

/** Rain is canonical basis points (0 through 10000); it is named in words, never by color alone. */
export function weatherText(scene: LivingScene): string {
  const rain = scene.weather.rainIntensity;
  return rain === 0 ? "Dry" : `Rain ${rain / 100}%`;
}

/** The HUD's centered world clock and weather, from canonical state only. */
export function WorldClockHud({
  status,
  scene,
}: {
  readonly status: WorldStatus | "unavailable" | undefined;
  readonly scene: LivingScene;
}) {
  const clock = typeof status === "object" ? status.clock : undefined;
  // A clock read for an earlier revision than the scene is shown as updating, never as current.
  const behind = typeof status === "object" && BigInt(status.revision) < BigInt(scene.revision);
  return (
    <section className="rw-clock" aria-label="World clock" aria-busy={behind}>
      <span className="rw-clock-time">
        {clock ? dayText(clock) : status === "unavailable" ? "Clock unavailable" : "Clock loading"}
        {behind && ", updating"}
      </span>
      <span className="rw-clock-state" data-run-state={clock?.runState}>
        {clock ? (clock.runState === "running" ? "Running" : "Paused") : ""}
      </span>
      <span className="rw-clock-speed">{clock ? `Speed ×${clock.speed}` : ""}</span>
      <span className="rw-clock-weather" data-rain={scene.weather.rainIntensity > 0}>
        {weatherText(scene)}
      </span>
    </section>
  );
}

export const CATEGORY_LABELS: Readonly<Record<WorldFeedCategory, string>> = {
  weather: "Weather",
  routine: "Routine",
  wellbeing: "Wellbeing",
  growth: "Growth",
  movement: "Movement",
  portal: "Portal",
  resource: "Resource",
};

/** The time an event happened, as the HUD shows the clock. */
export function eventTime(simTimeMs: bigint, clock: WorldClock | undefined): string {
  if (!clock || clock.dayLengthMs === null) return `${simTimeMs} ms`;
  const length = BigInt(clock.dayLengthMs);
  return `Day ${simTimeMs / length + 1n}, ${clockFace((simTimeMs % length).toString(), clock.dayLengthMs)}`;
}

type FeedIconKind = "raindrop" | "leaf" | "heart" | "door" | "portrait";

const ICONS: Readonly<
  Record<WorldFeedCategory, { kind: Exclude<FeedIconKind, "portrait">; name: string } | undefined>
> = {
  weather: { kind: "raindrop", name: "Weather" },
  growth: { kind: "leaf", name: "Ecology" },
  resource: { kind: "leaf", name: "Ecology" },
  wellbeing: { kind: "heart", name: "Wellbeing" },
  portal: { kind: "door", name: "Portal" },
  routine: undefined,
  movement: undefined,
};

const GLYPHS: Readonly<Record<Exclude<FeedIconKind, "portrait">, string>> = {
  raindrop: "M12 3C9 8 6 11 6 15a6 6 0 0 0 12 0c0-4-3-7-6-12z",
  leaf: "M5 19C5 9 11 5 19 5c0 9-4 14-12 14M5 19l7-7",
  heart: "M12 19C5 14 4 10 4 8a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 2-1 6-8 11z",
  door: "M6 20V10a6 6 0 0 1 12 0v10zM12 14v2",
};

function FeedIcon({ category, label }: { category: WorldFeedCategory; label: string }) {
  const icon = ICONS[category];
  // Actor activity shows the actor's portrait; no projected binding references portrait art yet.
  if (!icon) return <Portrait className="rw-feed-icon" label={label} />;
  return (
    <span className="rw-feed-icon" data-icon={icon.kind} role="img" aria-label={icon.name}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={GLYPHS[icon.kind]} />
      </svg>
    </span>
  );
}

/**
 * Recent material events from the authorized world-status read, newest first. A row selects the
 * entity it concerns (when in view), opens the entity rail and opens the event's causal record.
 */
export function MaterialFeed({
  session,
  status,
  scene,
}: {
  readonly session: YardSession;
  readonly status: WorldStatus | "unavailable" | undefined;
  readonly scene: LivingScene;
}) {
  const open = useFeedSheet((sheet) => sheet.open);
  const toggle = useFeedSheet((sheet) => sheet.toggle);
  const select = useYardView((view) => view.select);
  const labelOf = (objectId: string) =>
    scene.entities.find((entity) => entity.objectId === objectId)?.presentation.label;
  return (
    <section className="rw-feed" aria-label="Event feed" data-open={open}>
      <h2 className="rw-panel-title">Events</h2>
      <button type="button" aria-expanded={open} aria-controls="rw-feed-items" onClick={toggle}>
        {open ? "Collapse event feed" : "Open event feed"}
      </button>
      <ol id="rw-feed-items" hidden={!open}>
        {status === undefined && <li>Events loading.</li>}
        {status === "unavailable" && <li>Events unavailable.</li>}
        {typeof status === "object" && status.feed.length === 0 && <li>No recent events.</li>}
        {typeof status === "object" &&
          status.feed.map((item) => {
            const objectId = item.objectId;
            const label = objectId === null ? undefined : labelOf(objectId);
            const inView = objectId !== null && label !== undefined;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="rw-feed-item"
                  data-event-id={item.sourceEventIds[0]}
                  onClick={(event) => {
                    if (inView) {
                      select(objectId);
                      useEntityRail.getState().show();
                    }
                    const eventId = item.sourceEventIds[0];
                    if (eventId === undefined) return;
                    whyOpener.current = event.currentTarget;
                    session.explainEvent(eventId);
                  }}
                >
                  <FeedIcon category={item.category} label={label ?? objectId ?? "Actor"} />
                  <span className="rw-feed-text">
                    {item.text}
                    {objectId !== null && !inView && (
                      <span className="rw-feed-muted"> (not in view)</span>
                    )}
                  </span>
                  <time>{eventTime(item.simTimeMs, status.clock)}</time>
                </button>
              </li>
            );
          })}
      </ol>
    </section>
  );
}
