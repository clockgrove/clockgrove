import type { ClientViewTrace, LivingScene, SceneProjection, SpaceId } from "@clockgrove/contracts";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserAuthenticationPort } from "./api.js";
import { useFocusRecovery } from "./focus.js";
import { MaterialFeed, WorldClockHud } from "./hud.js";
import { clientMeasurements, measure, measurePoint } from "./measurements.js";
import { ArrivalReadiness, CompatibilityRecovery } from "./recovery.js";
import type { RendererContent } from "./renderer-content.js";
import { SceneSession, type ViewTraceProjection } from "./scene-api.js";
import { sameSceneScope, sceneStatusText } from "./scene-projection.js";
import {
  useDirectoryQuery,
  useSceneStateProjection,
  useViewTraceQuery,
  useWorldReadinessQuery,
  useWorldStatusQuery,
} from "./scene-queries.js";
import {
  followEmphasis,
  useEntityFocus,
  useEntityRail,
  useSceneView,
  useViewedSpace,
  useWorldBoot,
  useWorldChoice,
} from "./scene-state.js";
import { EntityRail } from "./selection.js";
import { worldShell } from "./shell.js";
import { browserSceneSocket } from "./socket.js";
import {
  ANNOUNCE_INTERVAL_MS,
  LiveChanges,
  spaceSummary,
  TextSceneEntities,
  useThrottled,
} from "./text-scene.js";
import { Timeline } from "./timeline.js";
import { RecordedWhyPanel } from "./why.js";
import { bootStatusText } from "./world-boot.js";
import { parseWorldRoute, worldRoutePath } from "./world-route.js";
import { effectsText, pickOrder, type WorldSceneAdapter } from "./world-scene-adapter.js";

/** The world-status read follows the scene's revision at most once per interval, per browser. */
const STATUS_INTERVAL_MS = 1000;

/** Presents a committed projection for its boot; a projection the renderer refuses leaves assets unavailable. */
function presentScene(
  adapter: { current: WorldSceneAdapter | undefined },
  projection: SceneProjection,
  requestId: string,
): boolean {
  const current = adapter.current;
  if (!current) return true;
  const { advance } = useWorldBoot.getState();
  try {
    current.loadSnapshot(projection);
  } catch {
    current.destroy();
    adapter.current = undefined;
    advance({ type: "fallback", requestId, reason: "assets_unavailable" });
    return false;
  }
  advance({ type: "present", requestId, revision: projection.revision });
  return true;
}
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function SceneCanvas({
  projection,
  content,
  availability,
  retry,
}: {
  readonly projection: SceneProjection;
  readonly content?: RendererContent;
  readonly availability: (ready: boolean) => void;
  readonly retry: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  // Set once the renderer's reviewed assets are ready; only then does it receive projections.
  const adapter = useRef<WorldSceneAdapter | undefined>(undefined);
  const request = useRef("");
  const latest = useRef(projection);
  latest.current = projection;
  const [unavailable, setUnavailable] = useState(false);
  const select = useSceneView((state) => state.select);
  const advance = useWorldBoot((state) => state.advance);
  useEffect(() => {
    let active = true;
    let created: WorldSceneAdapter | undefined;
    const stops: (() => void)[] = [];
    const parent = element.current;
    if (!parent) return;
    // Renderer outcomes advance only the boot that mounted this canvas.
    const { requestId } = useWorldBoot.getState().boot;
    request.current = requestId;
    const motion = globalThis.matchMedia?.(REDUCED_MOTION);
    const release = () => {
      for (const stop of stops.splice(0)) stop();
      created?.destroy();
      created = undefined;
      adapter.current = undefined;
    };
    // Context loss (renderer) or a missing reviewed atlas (assets) falls back to the text path;
    // reducer state is untouched.
    const lose = (reason: "renderer_unavailable" | "assets_unavailable") => {
      if (!active || !created) return;
      release();
      setUnavailable(true);
      availability(false);
      advance({ type: "fallback", requestId, reason });
    };
    void import("./renderer.js")
      .then(({ ThreeWorldSceneAdapter }) => {
        if (!active) return;
        const renderer: WorldSceneAdapter = new ThreeWorldSceneAdapter(
          parent,
          () => {
            if (!active || created !== renderer) return;
            adapter.current = renderer;
            advance({ type: "assets", requestId });
            const ready = presentScene(adapter, latest.current, requestId);
            setUnavailable(!ready);
            availability(ready);
          },
          lose,
          (point) => {
            if (point.name === "asset_cache" && point.assetHash !== undefined)
              clientMeasurements.setWorld({ worldPack: point.assetHash });
            measurePoint(point);
          },
          content,
        );
        created = renderer;
        stops.push(renderer.onIntent(({ objectId }) => select(objectId)));
        // Selection and keyboard focus reach the renderer only through its adapter.
        stops.push(
          followEmphasis(({ selected, focused }) => {
            renderer.setSelection(selected);
            renderer.focus(focused);
          }),
        );
        const follow = () => renderer.setReducedMotion(motion?.matches ?? false);
        follow();
        motion?.addEventListener("change", follow);
        stops.push(() => motion?.removeEventListener("change", follow));
      })
      .catch(() => {
        if (!active) return;
        measure("client_errors", "renderer");
        setUnavailable(true);
        availability(false);
        advance({ type: "fallback", requestId, reason: "renderer_unavailable" });
      });
    return () => {
      active = false;
      release();
      availability(false);
    };
  }, [select, advance, availability, content]);
  useEffect(() => {
    if (!presentScene(adapter, projection, request.current)) {
      setUnavailable(true);
      availability(false);
    }
  }, [projection, availability]);
  return (
    <>
      <div ref={element} className="rw-canvas" aria-hidden="true" />
      {unavailable && (
        <div>
          <p>Canvas unavailable. The complete scene is available below.</p>
          <button type="button" onClick={retry}>
            Retry canvas
          </button>
        </div>
      )}
    </>
  );
}
/** Every entity in the shared pick order, then any whose frame version is not projected. */
function inPickOrder(scene: LivingScene): LivingScene["entities"] {
  const rank = new Map(pickOrder(scene).map(({ objectId }, index) => [objectId, index]));
  return [...scene.entities].sort(
    (a, b) => (rank.get(a.objectId) ?? rank.size) - (rank.get(b.objectId) ?? rank.size),
  );
}

const interestText = (interest: ClientViewTrace["requested"]) =>
  `selection ${interest.selection ?? "none"}; conversation ${interest.conversation}; operator ${interest.operator}`;

/** The viewer's own view traced: requested interest, the audience decided for it, its revision. */
function ClientViewTracePanel({
  trace,
  received,
}: {
  readonly trace: ViewTraceProjection;
  readonly received: string | undefined;
}) {
  const value = trace.value;
  return (
    <section aria-label="Client view trace" aria-busy={trace.status === "loading"}>
      <h3>Client view trace</h3>
      <p role="status" aria-live="polite" aria-atomic="true">
        {trace.status === "loading"
          ? "Loading view trace."
          : trace.status === "refused"
            ? "View trace request refused. Try again later."
            : trace.status === "unavailable"
              ? "View trace unavailable."
              : "View trace loaded."}
      </p>
      {value && (
        <>
          <p>
            Evidence classes:{" "}
            {Object.entries(value.evidence)
              .map(([part, label]) => `${part} ${label}`)
              .join("; ")}
          </p>
          <p>Requested interest: {interestText(value.requested)}</p>
          <p>Decided interest: {interestText(value.audience.interest)}</p>
          <p>Privacy categories: {value.audience.privacyCategories.join(", ") || "None"}</p>
          <p>
            Audience hash: {value.audience.hash};{" "}
            {received === value.audience.hash
              ? "matches the received projection"
              : "does not match the received projection"}
          </p>
          <ul>
            {value.audience.reasons.map((reason) => (
              <li key={reason.viewer}>
                {reason.viewer}: {reason.outcome}; {reason.code}; detail {reason.detailLevel}
              </li>
            ))}
          </ul>
          <p>
            Projection revision {value.projection.revision}, simulation time{" "}
            {value.projection.simulationTime}.
          </p>
        </>
      )}
    </section>
  );
}

export function WorldApp({
  origin = location.origin,
  authentication,
  content,
}: {
  readonly origin?: string;
  readonly authentication: BrowserAuthenticationPort;
  readonly content?: RendererContent;
}) {
  const [session] = useState(
    () =>
      new SceneSession(
        origin,
        () => useSceneView.getState().select(undefined),
        (scope, credential) => {
          // The session opens the one scene socket only after the previous observation retired.
          useWorldBoot.getState().advance({ type: "join", scope });
          return browserSceneSocket(scope, credential, origin);
        },
        authentication,
        (objectId) => useSceneView.getState().select(objectId),
        () => useViewedSpace.getState().reset(),
      ),
  );
  const boot = useWorldBoot((view) => view.boot);
  const startBoot = useWorldBoot((view) => view.start);
  const advanceBoot = useWorldBoot((view) => view.advance);
  const state = useSceneStateProjection(session);
  const [canvasAvailable, setCanvasAvailable] = useState(false);
  const [canvasAttempt, retryCanvas] = useState(0);
  // The mode the user sees: recorded once per transition into it.
  useEffect(() => {
    if (boot.state === "scene_ready") measure("accessibility_mode", "canvas");
    else if (boot.state === "text_ready") measure("accessibility_mode", "text");
  }, [boot.state]);
  useEffect(() => {
    if (globalThis.matchMedia?.(REDUCED_MOTION).matches)
      measure("accessibility_mode", "reduced_motion");
  }, []);
  const directory = useDirectoryQuery(session);
  const path = useWorldChoice((choice) => choice.path);
  const show = useWorldChoice((choice) => choice.show);
  const [credential, setCredential] = useState("");
  const selected = useSceneView((view) => view.selected);
  const select = useSceneView((view) => view.select);
  const focused = useEntityFocus((view) => view.focused);
  const focus = useEntityFocus((view) => view.focus);
  useEffect(() => {
    const unsubscribe = useSceneView.subscribe((view) => session.select(view.selected));
    return () => {
      unsubscribe();
      session.signOut();
    };
  }, [session]);
  useEffect(() => {
    const restore = () => show(location.pathname);
    restore();
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, [show]);
  const route = useMemo(() => (path === undefined ? undefined : parseWorldRoute(path)), [path]);
  // Only a directory entry is ever observed, so a route the directory lacks opens no scene.
  const entry =
    route?.kind === "world"
      ? directory.entries.find((candidate) => sameSceneScope(candidate, route.scope))
      : undefined;
  // A route or directory change starts the next boot before observation is replaced; without a
  // listed scope it stays at route_resolving.
  useEffect(() => {
    if (path !== undefined)
      startBoot(path, entry && route?.kind === "world" ? route.scope : undefined);
  }, [startBoot, path, route, entry]);
  useEffect(() => {
    session.open(entry);
  }, [session, entry]);
  // A routed world the directory lacks may still be provisioning; once ready, the directory lists it.
  const arrival = useWorldReadinessQuery(
    session,
    directory.status === "ready" && route?.kind === "world" && !entry ? route.scope : undefined,
  );
  useEffect(() => {
    if (arrival.readiness === "ready") session.refreshDirectory();
  }, [session, arrival.readiness]);
  const viewed = useViewedSpace((view) => view.viewed);
  const notice = useViewedSpace((view) => view.notice);
  const showViewed = useViewedSpace((view) => view.show);
  async function view(targetSpaceId: SpaceId) {
    const places = state.projection?.hierarchy ?? [];
    const labelOf = (spaceId: SpaceId | undefined) =>
      places.find((place) => place.spaceId === (spaceId ?? state.scope?.spaceId))?.label ??
      "this place";
    const target = labelOf(targetSpaceId);
    const entity = state.scene?.entities.find((candidate) => candidate.objectId === selected);
    const entityLabel = entity?.presentation.label ?? selected ?? "The selected entity";
    const answer = await session.changeViewedSpace(targetSpaceId);
    if (answer === undefined) return;
    if (answer === "changed") return showViewed(targetSpaceId, `Viewing ${target}.`);
    if (answer === "failed")
      return showViewed(viewed, `The request to view ${target} failed; nothing changed.`);
    switch (answer.disposition) {
      case "followed":
        return showViewed(targetSpaceId, `Followed ${entityLabel} to ${target}.`);
      case "stayed_within_space":
        return showViewed(
          viewed,
          `${entityLabel} is not within ${target}; the view stayed on ${labelOf(viewed)}.`,
        );
      case "permission_denied":
        return showViewed(viewed, `Viewing ${target} is not permitted. Selection cleared.`);
      case "target_hidden":
        return showViewed(viewed, `The selected entity is hidden in ${target}. Selection cleared.`);
      case "unavailable":
        return showViewed(viewed, `${target} is unavailable. Selection cleared.`);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void session.signIn(credential);
    setCredential("");
  }
  function choose(next: string) {
    history.pushState(null, "", next);
    show(next);
  }
  const signedIn = directory.status === "ready";
  const scene = state.scene;
  const shown = scene && directory.entries.find((candidate) => sameSceneScope(candidate, scene));
  const status = useWorldStatusQuery(
    session,
    state.scope,
    // Only the latest revision is read when the interval ends; intermediate ones are skipped.
    useThrottled(scene && shown ? scene.revision : undefined, STATUS_INTERVAL_MS),
  );
  const viewTrace = useViewTraceQuery(session);
  const railOpen = useEntityRail((rail) => rail.open);
  useEffect(() => {
    if (selected && !scene?.entities.some((entity) => entity.objectId === selected))
      select(undefined);
  }, [scene, selected, select]);
  // A removed entity control never reports blur, so its focus emphasis ends with the entity.
  useEffect(() => {
    if (focused && !scene?.entities.some((entity) => entity.objectId === focused)) focus(undefined);
  }, [scene, focused, focus]);
  useEffect(() => {
    if (scene) advanceBoot({ type: "snapshot", scope: scene, revision: BigInt(scene.revision) });
  }, [scene, advanceBoot]);
  // Arrival progress is the boot announcement alone; the live status resumes once arrival ends.
  const live = "terminal" in boot || (state.status !== "connecting" && state.status !== "ready");
  // Boot records arrival once; its displayed completion follows the current committed scene.
  const arrivalStatus =
    scene && "terminal" in boot && sameSceneScope(boot.scope, scene)
      ? bootStatusText({ ...boot, projectionRevision: BigInt(scene.revision) })
      : bootStatusText(boot);
  const observationStatus = live ? `Observation: ${sceneStatusText(state)}. ` : "";
  const observationAnnouncement = useThrottled(
    live && scene
      ? `Scene: ${sceneStatusText(state)}. Revision ${scene.revision}. Rain intensity ${scene.weather.rainIntensity}.`
      : observationStatus.replace(/^Observation:/u, "Scene:"),
    ANNOUNCE_INTERVAL_MS,
  );
  const shell = useRef<HTMLDivElement>(null);
  useFocusRecovery(shell);
  const viewing =
    state.projection?.hierarchy.find((place) => place.spaceId === (viewed ?? scene?.spaceId))
      ?.label ?? shown?.spaceLabel;
  return (
    <div
      ref={shell}
      className="rw-shell"
      data-tokens="world-shell@1"
      style={worldShell.tokens}
      data-canvas={canvasAvailable}
    >
      <header className="rw-hud">
        <div className="rw-hud-start">
          <h1 className="rw-wordmark">{worldShell.wordmark}</h1>
          {signedIn && (
            <nav aria-label="World selector">
              <label htmlFor="world">{worldShell.copy.worldLabel}</label>
              <select
                id="world"
                value={entry ? worldRoutePath(entry) : ""}
                onChange={(event) => choose(event.target.value)}
              >
                <option value="" disabled>
                  {worldShell.copy.chooseWorld}
                </option>
                {directory.entries.map((candidate) => (
                  <option key={worldRoutePath(candidate)} value={worldRoutePath(candidate)}>
                    {`${candidate.worldLabel} / ${candidate.spaceLabel}`}
                  </option>
                ))}
              </select>
            </nav>
          )}
        </div>
        {scene && shown && <WorldClockHud status={status} scene={scene} />}
        <div className="rw-hud-end">
          {scene && shown && (
            <button
              type="button"
              aria-expanded={viewTrace.status !== "none"}
              onClick={() => session.traceView(viewTrace.status === "none")}
            >
              Trace my view
            </button>
          )}
          {signedIn && (
            <button type="button" onClick={() => session.signOut()}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="rw-main">
        <p className="rw-observation-details">
          Observe an authorized world. This view grants no world mutation authority.
        </p>
        {!signedIn && (
          <form onSubmit={submit}>
            <label htmlFor="credential">Local session credential</label>
            <input
              id="credential"
              type="password"
              autoComplete="off"
              required
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <button type="submit" disabled={directory.status === "signing in"}>
              Sign in
            </button>
          </form>
        )}
        {directory.status === "refused" && <p role="alert">Sign-in refused.</p>}
        {directory.status === "unavailable" && (
          <p role="alert">World directory unavailable. Sign in again to retry.</p>
        )}
        {signedIn && route?.kind === "none" && <p>Choose a world from the selector.</p>}
        {signedIn &&
          route &&
          route.kind !== "none" &&
          !entry &&
          (route.kind === "unknown" || arrival.readiness === "refused" ? (
            <p role="alert">World not available.</p>
          ) : (
            <ArrivalReadiness readiness={arrival.readiness} retry={arrival.retry} />
          ))}
        {entry && state.status === "unavailable" && (
          <button type="button" onClick={() => session.open(entry)}>
            Retry observation
          </button>
        )}
        <p id="rw-observation-status">
          {observationStatus}
          <span className="rw-observation-details">
            {live && scene
              ? `Observing revision ${scene.revision}. Canonical time ${scene.simulationTime}. Rain intensity ${scene.weather.rainIntensity}. ${scene.entities.map((entity) => `${entity.presentation.label}, ${entity.objectId}, position ${entity.pose.coordinates.join(", ")}`).join("; ")}`
              : ""}
          </span>
        </p>
        <p id="rw-arrival-status">{!state.incompatibility && arrivalStatus}</p>
        <p
          id="rw-observation-announcement"
          className="rw-visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {observationAnnouncement}
        </p>
        <p className="rw-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {/* Boot milestones announce once; current revision details remain non-live. */}
          {!state.incompatibility && bootStatusText(boot).replace(/^Arrival:/u, "World arrival:")}
        </p>
        {state.incompatibility && <CompatibilityRecovery code={state.incompatibility} />}
        {scene && shown && (
          <section aria-label="Living scene">
            <h2>{shown.worldLabel}</h2>
            {state.projection && (
              <SceneCanvas
                key={canvasAttempt}
                projection={state.projection}
                {...(content && { content })}
                availability={setCanvasAvailable}
                retry={() => retryCanvas((value) => value + 1)}
              />
            )}
            <p>Canonical revision: {scene.revision}</p>
            <p>Canonical time: {scene.simulationTime}</p>
            <p>Rain intensity: {scene.weather.rainIntensity}</p>
            {state.projection && (
              <>
                <p>Puddles: {effectsText(state.projection).puddles}</p>
                <p>Lights: {effectsText(state.projection).lights}</p>
              </>
            )}
            <p>
              Space summary:{" "}
              {spaceSummary(scene, shown.worldLabel, shown.spaceLabel, viewing ?? shown.spaceLabel)}
            </p>
            <h3>Entities</h3>
            <TextSceneEntities
              scene={{ ...scene, entities: inPickOrder(scene) }}
              interactions={state.projection?.interactions ?? []}
              selected={selected}
              select={select}
              focus={focus}
            />
            {(state.projection?.privateCognition?.length ?? 0) > 0 && (
              <>
                <h3>Private memories</h3>
                <ul aria-label="Private memories">
                  {state.projection?.privateCognition?.map((entry) => (
                    <li key={entry.ref}>
                      {`${entry.actorId} ${entry.kind} about ${entry.targetObjectId}: ${entry.value}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <nav aria-label="Places">
              {(state.projection?.hierarchy ?? []).map((place) => (
                <button
                  key={place.spaceId}
                  type="button"
                  aria-pressed={(viewed ?? scene.spaceId) === place.spaceId}
                  onClick={() => void view(place.spaceId)}
                >
                  {`View ${place.label}`}
                </button>
              ))}
              <p>Viewing: {viewing}</p>
              <p role="status" aria-live="polite" aria-atomic="true">
                {notice}
              </p>
            </nav>
          </section>
        )}
        {scene && shown && (
          <LiveChanges scene={scene} feed={typeof status === "object" ? status.feed : undefined} />
        )}
        {scene && shown && <Timeline session={session} scene={scene} status={status} />}
        {scene && shown && <RecordedWhyPanel session={session} />}
        {scene && shown && viewTrace.status !== "none" && (
          <ClientViewTracePanel trace={viewTrace} received={state.projection?.audienceHash} />
        )}
      </main>
      {scene && shown && (
        <div className="rw-rail" data-open={railOpen}>
          <EntityRail session={session} selected={selected} />
        </div>
      )}
      {scene && shown && (
        <div className="rw-feed-dock">
          <MaterialFeed session={session} status={status} scene={scene} />
        </div>
      )}
    </div>
  );
}
