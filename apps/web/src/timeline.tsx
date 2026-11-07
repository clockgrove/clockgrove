import type { LivingScene, WorldStatus } from "@clockgrove/contracts";
import { useState } from "react";
import { focusWhenPresent } from "./focus.js";
import { CATEGORY_LABELS, eventTime } from "./hud.js";
import { whyOpener } from "./why.js";
import type { YardSession } from "./yard-api.js";
import { useEntityRail, useYardView } from "./yard-state.js";

/**
 * Timeline metadata and stepping through the authorized recent material events, each opening its
 * entity's history or its recorded Why. Branches are a placeholder until branching exists (Wave 7).
 */
export function Timeline({
  session,
  scene,
  status,
}: {
  readonly session: YardSession;
  readonly scene: LivingScene;
  readonly status: WorldStatus | "unavailable" | undefined;
}) {
  const [stepId, setStepId] = useState<string>();
  const select = useYardView((view) => view.select);
  const clock = typeof status === "object" ? status.clock : undefined;
  const feed = typeof status === "object" ? status.feed : [];
  // The feed is newest first; a step no longer in it falls back to the newest event.
  const index = Math.max(
    0,
    feed.findIndex((item) => item.id === stepId),
  );
  const item = feed[index];
  const label =
    item?.objectId == null
      ? undefined
      : scene.entities.find((entity) => entity.objectId === item.objectId)?.presentation.label;
  const describe = (at: number) => {
    const event = feed[at];
    if (!event) return "";
    const name =
      event.objectId == null
        ? undefined
        : scene.entities.find((entity) => entity.objectId === event.objectId)?.presentation.label;
    return `Event ${feed.length - at} of ${feed.length}: ${CATEGORY_LABELS[event.category]}; ${name ? `${name}: ${event.text}` : event.text}; ${eventTime(event.simTimeMs, clock)}.`;
  };
  // Only a step is announced: new events arriving in the feed do not re-read the event line.
  const [announcement, setAnnouncement] = useState("");
  const step = (to: number) => {
    const target = feed[to];
    if (!target) return;
    setStepId(target.id);
    setAnnouncement(describe(to));
  };
  const eventId = item?.sourceEventIds[0];
  return (
    <section aria-labelledby="rw-timeline">
      <h2 id="rw-timeline">Timeline</h2>
      <dl>
        <dt>Timeline</dt>
        <dd>{scene.timelineId}</dd>
        <dt>Canonical revision</dt>
        <dd>{scene.revision}</dd>
        <dt>Canonical time</dt>
        <dd>{scene.simulationTime}</dd>
        <dt>Clock</dt>
        <dd>
          {clock
            ? `${clock.runState === "running" ? "Running" : "Paused"}, speed ×${clock.speed}`
            : status === "unavailable"
              ? "Clock unavailable"
              : "Clock loading"}
        </dd>
        <dt>Branches</dt>
        <dd>No branches shown. Branching is not available yet.</dd>
      </dl>
      <h3>Recent material events</h3>
      {!item ? (
        <p>{status === undefined ? "Events loading." : "No recent events."}</p>
      ) : (
        <>
          <p id="rw-timeline-event">{describe(index)}</p>
          <p className="rw-visually-hidden" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          {/* aria-disabled keeps focus on a stepper at either end, where disabled would drop it. */}
          <button
            type="button"
            id="rw-timeline-earlier"
            aria-disabled={index >= feed.length - 1}
            onClick={() => step(index + 1)}
          >
            Earlier event
          </button>
          <button
            type="button"
            id="rw-timeline-later"
            aria-disabled={index === 0}
            onClick={() => step(index - 1)}
          >
            Later event
          </button>
          {label && item.objectId !== null && (
            <button
              type="button"
              onClick={() => {
                select(item.objectId ?? undefined);
                useEntityRail.getState().show();
                focusWhenPresent("rw-recent-actions");
              }}
            >
              {`Open history of ${label}`}
            </button>
          )}
          {eventId !== undefined && (
            <button
              type="button"
              onClick={(event) => {
                whyOpener.current = event.currentTarget;
                session.explainEvent(eventId);
              }}
            >
              {`Why event ${eventId}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
