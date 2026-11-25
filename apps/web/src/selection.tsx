import type {
  FlashbackMarks,
  ObjectId,
  SelectionDerived,
  SelectionValues,
} from "@clockgrove/contracts";
import { useEffect } from "react";
import { flashbackOpener } from "./flashback.js";
import { InteractionCard } from "./interaction-card.js";
import type { SceneSession } from "./scene-api.js";
import {
  type SelectionProjection,
  useFlashbackMarksQuery,
  useSceneStateProjection,
  useSelectionQuery,
} from "./scene-queries.js";
import { useEntityRail } from "./scene-state.js";
import { whyOpener } from "./why.js";

export function EntityValues({ values }: { readonly values: SelectionValues | SelectionDerived }) {
  return (
    <dl>
      <dt>Needs</dt>
      <dd>
        {values.needs
          ? `Hunger ${values.needs.hunger}; wetness ${values.needs.wetness}; integrated at ${values.needs.integratedAt}; hunger remainder ${values.needs.hungerRemainder}; wetness remainder ${values.needs.wetnessRemainder}`
          : "Not applicable"}
      </dd>
      <dt>Wellbeing</dt>
      <dd>
        {values.wellbeing
          ? `Thirst ${values.wellbeing.thirst}; health ${values.wellbeing.health}; thirst remainder ${values.wellbeing.thirstRemainder}; health remainder ${values.wellbeing.healthRemainder}${"comfort" in values.wellbeing ? `; comfort ${values.wellbeing.comfort}; integrated at ${values.wellbeing.integratedAt}` : ""}`
          : "Not applicable"}
      </dd>
      <dt>Plant</dt>
      <dd>
        {values.plant
          ? `Wetness ${values.plant.wetness}; growing milliseconds ${values.plant.growingMs}; wetness remainder ${values.plant.wetnessRemainder}${"stage" in values.plant ? `; stage ${values.plant.stage}; integrated at ${values.plant.integratedAt}` : ""}`
          : "Not applicable"}
      </dd>
    </dl>
  );
}

/**
 * The entity rail: the selected entity's name, public state and location from the entity-selection
 * read, then its full selection panel. Collapsing the rail leaves the shared selection unchanged.
 */
export function EntityRail({
  session,
  selected,
}: {
  readonly session: SceneSession;
  readonly selected: ObjectId | undefined;
}) {
  const open = useEntityRail((rail) => rail.open);
  const toggle = useEntityRail((rail) => rail.toggle);
  const selection = useSelectionQuery(session);
  const summary = useSceneStateProjection(session).projection?.interactions.find(
    (interaction) => interaction.entityId === selected,
  );
  // The transient intent also gates rendering before a subscription has started its request.
  const current = selected && selection.objectId === selected ? selection : undefined;
  const value = current?.value;
  const pending = !current || current.status === "loading" ? "Loading." : "Unavailable.";
  return (
    <section aria-label="Entity rail">
      <button type="button" aria-expanded={open} onClick={toggle}>
        {open ? "Collapse entity rail" : "Open entity rail"}
      </button>
      {open && selected && (
        <dl>
          <dt>Name</dt>
          {/* Until the read returns its scene label, the entity is named by its object id. */}
          <dd>{value?.entity.presentation.label ?? selected}</dd>
          <dt>Public state</dt>
          <dd>
            {value
              ? `Lifecycle ${value.physical.lifecycle ?? "not applicable"}; action ${value.physical.selectedAction?.kind ?? "none"}`
              : pending}
          </dd>
          <dt>Location</dt>
          <dd>{value ? (value.physical.locationId ?? "None") : pending}</dd>
        </dl>
      )}
      {open && selected && (
        <InteractionCard session={session} entityId={selected} summary={summary} />
      )}
      {open && <EntitySelectionPanel session={session} selected={selected} current={current} />}
    </section>
  );
}

function EntitySelectionPanel({
  session,
  selected,
  current,
}: {
  readonly session: SceneSession;
  readonly selected: ObjectId | undefined;
  readonly current: SelectionProjection | undefined;
}) {
  const marks = useFlashbackMarksQuery(session);
  const marksKey = session.getMarksKey();
  useEffect(() => session.loadMarks(marksKey), [session, marksKey]);
  if (!selected) return <p>Select an entity using the canvas or an entity button.</p>;
  const value = current?.value;
  return (
    <section
      id="rw-selected-entity"
      tabIndex={-1}
      aria-label="Selected entity"
      aria-busy={!current || current.status === "loading"}
    >
      <h2>Selected entity: {selected}</h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {!current || current.status === "loading"
          ? "Loading selected entity."
          : current.status === "unavailable"
            ? "Selected entity unavailable."
            : value
              ? `Selected entity at canonical revision ${value.revision}, canonical time ${value.simulationTime}. Derived non-canonical earned time ${value.derived.simulationTime}.`
              : "Selected entity unavailable."}
      </p>
      <button
        type="button"
        disabled={!current || current.status === "loading"}
        onClick={() => {
          session.refreshSelection();
        }}
      >
        Refresh selected entity
      </button>
      {value && (
        <>
          <p>
            Evidence classes:{" "}
            {Object.entries(value.evidence)
              .map(([part, label]) => `${part} ${label}`)
              .join("; ")}
          </p>
          <h3>Canonical public physical state</h3>
          <p>Canonical revision: {value.revision}</p>
          <p>Canonical time: {value.simulationTime}</p>
          <p>
            Identity: {value.objectId}; archetype: {value.entity.archetypeId}; frame:{" "}
            {value.entity.pose.frameId} version {value.entity.pose.frameVersion}; position:{" "}
            {value.entity.pose.coordinates.join(", ")}
          </p>
          <EntityValues values={value.physical} />
          <dl>
            <dt>Resource</dt>
            <dd>
              {value.physical.resource
                ? `${value.physical.resource.kind}; quantity ${value.physical.resource.quantity}`
                : "Not applicable"}
            </dd>
            <dt>Shelter</dt>
            <dd>
              {value.physical.shelter
                ? `Rain protection ${value.physical.shelter.rainProtection}`
                : "Not applicable"}
            </dd>
            <dt>Location</dt>
            <dd>{value.physical.locationId ?? "None"}</dd>
            <dt>Selected action</dt>
            <dd>
              {value.physical.selectedAction
                ? `${value.physical.selectedAction.kind}; target ${value.physical.selectedAction.targetObjectId ?? "None"}`
                : "None"}
            </dd>
            <dt>Lifecycle</dt>
            <dd>{value.physical.lifecycle ?? "Not applicable"}</dd>
          </dl>
          <h3>Derived current-time values (non-canonical)</h3>
          <p>Earned simulation time: {value.derived.simulationTime}</p>
          <p>These values are a read-only view; canonical state remains at the time above.</p>
          <EntityValues values={value.derived} />
          <h3 id="rw-recent-actions" tabIndex={-1}>
            Recent authorized actions
          </h3>
          <p>
            Observed revision: {value.history.observedRevision}. Newest partition sequence first.
          </p>
          {value.history.actions.length === 0 ? (
            <p>No authorized actions in this page.</p>
          ) : (
            <ol>
              {value.history.actions.map((action) => (
                <li key={action.eventId}>
                  Action {action.actionId}; event {action.eventId}; command {action.commandId};{" "}
                  {action.type}; partition sequence {action.partitionSequence}; recorded simulation
                  time {action.simulationTime}; recorded at{" "}
                  <time dateTime={action.recordedAt} data-wall-clock>
                    {action.recordedAt}
                  </time>{" "}
                  <button
                    type="button"
                    data-why-opener={`history:${action.eventId}`}
                    onClick={(event) => {
                      whyOpener.current = event.currentTarget;
                      session.explain(action.commandId);
                    }}
                  >
                    Why action {action.actionId}
                  </button>{" "}
                  <button
                    type="button"
                    data-flashback-opener={`history:${action.eventId}`}
                    onClick={(event) => {
                      flashbackOpener.current = event.currentTarget;
                      session.flashback({ eventId: action.eventId });
                    }}
                  >
                    Flashback action {action.actionId}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {value.history.beforeSequence !== null && (
            <button
              type="button"
              onClick={() => {
                session.earlierActions();
              }}
            >
              Earlier authorized actions
            </button>
          )}
          {marks.value && marks.value.zones.length > 0 && (
            <MarksSection session={session} marks={marks.value} />
          )}
        </>
      )}
    </section>
  );
}

const MARK_KIND_WORDS = {
  interacted: "interacted",
  worn: "worn by traffic",
  "band-crossed": "crossed a band",
  repaired: "repaired",
} as const;

/** A marks read's zones and moments, each moment opening its flashback (issues 273 and 267). */
export function MarksSection({
  session,
  marks,
  title = "Marks",
}: {
  readonly session: SceneSession;
  readonly marks: FlashbackMarks;
  readonly title?: string;
}) {
  return (
    <>
      <h3>{title}</h3>
      {marks.zones.map((zone) => (
        <div key={zone.zoneId}>
          <p>
            Zone {zone.zoneId}: {zone.marks} marks now
          </p>
          <ol>
            {zone.moments.map((moment) => (
              <li key={moment.eventId}>
                {MARK_KIND_WORDS[moment.kind]}; {moment.actorId ?? "no actor"}; interaction{" "}
                {moment.interactionId ?? "none"}; recorded simulation time {moment.simulationTime};
                partition sequence {moment.partitionSequence}
                {moment.leftMark ? "; left a mark" : ""}{" "}
                <button
                  type="button"
                  data-flashback-opener={`marks:${moment.eventId}`}
                  onClick={(event) => {
                    flashbackOpener.current = event.currentTarget;
                    session.flashback({ eventId: moment.eventId });
                  }}
                >
                  Flashback moment {moment.partitionSequence}
                </button>
              </li>
            ))}
          </ol>
          {zone.more > 0 && <p>{zone.more} earlier moments in the scan are not listed.</p>}
        </div>
      ))}
      {!marks.reachesStart && marks.scanned && (
        <p>
          Earlier moments are beyond the scanned journal range (from partition sequence{" "}
          {marks.scanned.from}) and are not listed.
        </p>
      )}
      {marks.status === "not-visible" && (
        <p>Part of the journal is not visible to you, so no moments are listed.</p>
      )}
    </>
  );
}
