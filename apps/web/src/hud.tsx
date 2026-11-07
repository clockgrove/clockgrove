import type {
  LivingScene,
  WorldClock,
  WorldFeedCategory,
  WorldStatus,
} from "@clockgrove/contracts";
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

/**
 * Recent material events from the authorized world-status read, newest first. Choosing an event
 * that concerns one entity selects that entity and opens the entity rail.
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
            const label = item.objectId === null ? undefined : labelOf(item.objectId);
            const content = (
              <>
                <span className="rw-feed-category" data-category={item.category}>
                  {CATEGORY_LABELS[item.category]}
                </span>{" "}
                <span>{label ? `${label}: ${item.text}` : item.text}</span>{" "}
                <time>{eventTime(item.simTimeMs, status.clock)}</time>
              </>
            );
            const objectId = item.objectId;
            return (
              <li key={item.id}>
                {objectId !== null && label ? (
                  <button
                    type="button"
                    className="rw-feed-item"
                    onClick={() => {
                      select(objectId);
                      useEntityRail.getState().show();
                    }}
                  >
                    {content}
                  </button>
                ) : (
                  <>
                    {content}
                    {objectId !== null && " (entity not in view)"}
                  </>
                )}
                {item.sourceEventIds.map((eventId) => (
                  <button
                    key={eventId}
                    type="button"
                    onClick={(event) => {
                      whyOpener.current = event.currentTarget;
                      session.explainEvent(eventId);
                    }}
                  >
                    {`Trace event ${eventId}`}
                  </button>
                ))}
              </li>
            );
          })}
      </ol>
    </section>
  );
}
