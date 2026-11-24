import type {
  EntitySelection,
  EventId,
  LivingScene,
  ObjectId,
  PublicDecisionTrace,
  PublicRoutineCandidate,
  RecordedWhy,
  RunSummary,
  RunView,
  RunWalk,
  WorldStatus,
} from "@clockgrove/contracts";
import { useEffect, useState } from "react";
import { CATEGORY_LABELS, eventTime } from "./hud.js";
import { playgroundHosted } from "./playground-pack.js";
import type { SceneSession } from "./scene-api.js";
import { whyOpener } from "./why.js";

type Refused = { readonly refused: string };
interface PackChecks {
  readonly metadata: { readonly name: string; readonly version: string };
  readonly checks: {
    readonly status: string;
    readonly results: readonly {
      readonly name: string;
      readonly scenario: string | null;
      readonly status: string;
    }[];
  };
}

const ACTOR_NEEDS = ["hunger", "thirst", "wetness", "health", "rain", "uncomfortable", "U"];

function cost(steps: readonly { readonly costMicrousd: number | null }[]): string {
  const known = steps.filter((step) => step.costMicrousd !== null);
  if (known.length === 0) return "unknown";
  return `$${(known.reduce((sum, step) => sum + (step.costMicrousd ?? 0), 0) / 1e6).toFixed(6)}`;
}

const list = (ids: readonly string[]) => (ids.length === 0 ? "None" : ids.join(", "));
const describe = (action: {
  readonly kind: string;
  readonly targetObjectId: string | null;
}): string => `${action.kind} → ${action.targetObjectId ?? "None"}`;
const featureOf = (candidate: PublicRoutineCandidate, name: string) =>
  candidate.features.find((feature) => feature.name === name)?.value;

/** Owner-only, read-only evidence: renders nothing unless the runtime-state read answers 200. */
export function WorldDebugger({
  session,
  scene,
  status,
}: {
  readonly session: SceneSession;
  readonly scene: LivingScene;
  readonly status: WorldStatus | "unavailable" | undefined;
}) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    void session.debuggerAccess().then((ok) => {
      if (live) setAllowed(ok);
    });
    return () => {
      live = false;
    };
  }, [session]);
  if (!allowed) return null;
  return (
    <details>
      <summary>World debugger</summary>
      <p>
        Owner-only and read-only: every value here is recorded evidence read with your credential;
        nothing here changes the world.
      </p>
      <DebuggerJournal session={session} status={status} />
      <section aria-label="Debugger timeline">
        <h3>Debugger timeline</h3>
        <p>
          The timeline and its replay are the Timeline panel beside the scene: step through recorded
          events, each opening its Why.
        </p>
        <button
          type="button"
          onClick={() => {
            const target =
              document.getElementById("rw-timeline-earlier") ??
              document.getElementById("rw-timeline");
            target?.setAttribute("tabindex", "-1");
            target?.focus();
          }}
        >
          Go to Timeline
        </button>
      </section>
      <DebuggerRuns session={session} />
      <DebuggerChecks session={session} />
      <DebuggerActors session={session} scene={scene} />
    </details>
  );
}

function DebuggerJournal({
  session,
  status,
}: {
  readonly session: SceneSession;
  readonly status: WorldStatus | "unavailable" | undefined;
}) {
  const clock = typeof status === "object" ? status.clock : undefined;
  const feed = typeof status === "object" ? status.feed : [];
  const [causes, setCauses] = useState<Readonly<Record<string, string>>>({});
  const read = (eventId: EventId) => {
    setCauses((current) => ({ ...current, [eventId]: "Reading cause." }));
    session.readEventWhy(eventId).then(
      (why: RecordedWhy) =>
        setCauses((current) => ({
          ...current,
          [eventId]: `Caused by command ${why.commandId}; receipt ${why.receiptStatus}; parent commands ${list(why.links.parents)}; child commands ${list(why.links.children)}`,
        })),
      () => setCauses((current) => ({ ...current, [eventId]: "Cause unavailable." })),
    );
  };
  return (
    <section aria-label="Debugger journal">
      <h3>Debugger journal</h3>
      {feed.length === 0 ? (
        <p>No recent events.</p>
      ) : (
        <ol aria-label="Journal events">
          {feed.map((item) => {
            const eventId = item.sourceEventIds[0];
            return (
              <li key={item.id}>
                {CATEGORY_LABELS[item.category]}; {item.text}; {eventTime(item.simTimeMs, clock)}
                {eventId !== undefined && (
                  <>
                    {" "}
                    <button type="button" onClick={() => read(eventId)}>
                      {`Cause of event ${eventId}`}
                    </button>
                    {causes[eventId] !== undefined && <p>{causes[eventId]}</p>}
                    {causes[eventId]?.startsWith("Caused by") && (
                      <button
                        type="button"
                        data-why-opener={`debugger:${eventId}`}
                        onClick={(event) => {
                          whyOpener.current = event.currentTarget;
                          session.explainEvent(eventId);
                        }}
                      >
                        {`Open Why for event ${eventId}`}
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function DebuggerRuns({ session }: { readonly session: SceneSession }) {
  const [runs, setRuns] = useState<readonly RunSummary[] | Refused>();
  const [walks, setWalks] = useState<Readonly<Record<string, RunWalk | Refused>>>({});
  const load = () => {
    void session.searchRuns(20).then(setRuns);
  };
  const inspect = (runId: string) => {
    void session
      .inspectRun(runId)
      .then((walk) => setWalks((current) => ({ ...current, [runId]: walk })));
  };
  return (
    <section aria-label="Debugger runs">
      <h3>Debugger runs</h3>
      <button type="button" onClick={load}>
        Load runs
      </button>
      {runs !== undefined && "refused" in runs && <p>Runs refused: {runs.refused}</p>}
      {runs !== undefined && !("refused" in runs) && runs.length === 0 && <p>No runs recorded.</p>}
      {runs !== undefined && !("refused" in runs) && runs.length > 0 && (
        <ul>
          {runs.map((run) => {
            const walk = walks[run.runId];
            return (
              <li key={run.runId}>
                {`Run ${run.runId}: ${run.status}, model ${run.model}, actor ${run.actorId}, ${run.stepCount} steps`}{" "}
                <button type="button" onClick={() => inspect(run.runId)}>
                  {`Inspect run ${run.runId}`}
                </button>
                {walk !== undefined && "refused" in walk && <p>Runs refused: {walk.refused}</p>}
                {walk !== undefined &&
                  !("refused" in walk) &&
                  walk.runs
                    .filter((view) => view.runId === run.runId)
                    .map((view) => <RunDetail key={view.runId} run={view} />)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RunDetail({ run }: { readonly run: RunView }) {
  const calls = (kind: string) => run.steps.filter((step) => step.kind === kind).length;
  return (
    <div>
      <p>Status: {run.status}</p>
      <p>Outcome: {run.outcomeCode ?? "none"}</p>
      <p>Model: {run.model}</p>
      <ol aria-label="Run steps">
        {run.steps.map((step) => (
          <li key={step.step}>
            {step.kind} · {step.status}
            {step.model !== null && ` · ${step.model}`}
            {step.tool !== null && ` · ${step.tool}`}
            {step.inputTokens !== null &&
              ` · ${step.inputTokens} in / ${step.outputTokens ?? 0} out tokens`}
            {step.costMicrousd !== null && ` · $${(step.costMicrousd / 1e6).toFixed(6)}`}
          </li>
        ))}
      </ol>
      <p>Model calls: {calls("model_attempt")}</p>
      <p>
        Tool calls: {calls("tool_execution") > 0 ? calls("tool_execution") : calls("tool_proposal")}
      </p>
      <p>Approvals: {calls("approval")}</p>
      <p>Cost: {cost(run.steps)}</p>
    </div>
  );
}

function DebuggerChecks({ session }: { readonly session: SceneSession }) {
  const [pack, setPack] = useState<PackChecks | "unavailable">();
  return (
    <section aria-label="Debugger checks">
      <h3>Debugger checks</h3>
      {playgroundHosted ? (
        <>
          <button
            type="button"
            onClick={() =>
              void session
                .playgroundRequest<PackChecks>("pack")
                .then(setPack, () => setPack("unavailable"))
            }
          >
            Load checks
          </button>
          {pack === "unavailable" && <p>Checks unavailable.</p>}
          {typeof pack === "object" && (
            <>
              <p>Checks: {pack.checks.status}</p>
              <ul>
                {pack.checks.results.map((result) => (
                  <li key={`${result.name}/${result.scenario ?? ""}`}>
                    {result.name}
                    {result.scenario !== null && ` (${result.scenario})`}: {result.status}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p>
          Pack checks run with the pack CLI: clockgrove pack build and clockgrove pack test
          (packages/simulator/docs/cli.md). This host serves no pack checks.
        </p>
      )}
    </section>
  );
}

type Decisions =
  | { readonly kind: "failed" }
  | {
      readonly kind: "read";
      readonly selection: EntitySelection;
      readonly traces: readonly {
        readonly status: string;
        readonly drafts: readonly PublicDecisionTrace[];
      }[];
    };

function DebuggerActors({
  session,
  scene,
}: {
  readonly session: SceneSession;
  readonly scene: LivingScene;
}) {
  const [actor, setActor] = useState<ObjectId | undefined>(scene.entities[0]?.objectId);
  const [result, setResult] = useState<Decisions>();
  const show = async () => {
    const objectId = actor ?? scene.entities[0]?.objectId;
    if (!objectId) return;
    try {
      const selection = await session.readEntity(objectId);
      const decisions = selection.history.actions
        .filter((action) => action.decision === true)
        .slice(0, 5);
      const whys = await Promise.all(
        decisions.map((action) => session.readEventWhy(action.eventId)),
      );
      setResult({ kind: "read", selection, traces: whys.map((why) => why.traces) });
    } catch {
      setResult({ kind: "failed" });
    }
  };
  const physical = result?.kind === "read" ? result.selection.physical : undefined;
  const derived = result?.kind === "read" ? result.selection.derived : undefined;
  const values = [
    ["hunger", physical?.needs?.hunger],
    ["thirst", derived?.wellbeing?.thirst ?? physical?.wellbeing?.thirst],
    ["wetness", physical?.needs?.wetness],
    ["health", derived?.wellbeing?.health ?? physical?.wellbeing?.health],
  ].filter(([, value]) => value !== undefined);
  const owned =
    result?.kind === "read"
      ? result.traces.map((evidence) => ({
          status: evidence.status,
          drafts: evidence.drafts.filter((draft) => draft.objectId === result.selection.objectId),
        }))
      : [];
  const drafts = owned.flatMap((evidence) => evidence.drafts);
  return (
    <section aria-label="Debugger actors">
      <h3>Debugger actors</h3>
      <label>
        Actor{" "}
        <select value={actor ?? ""} onChange={(event) => setActor(event.target.value as ObjectId)}>
          {scene.entities.map((entity) => (
            <option key={entity.objectId} value={entity.objectId}>
              {entity.presentation.label || entity.objectId}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="button" onClick={() => void show()}>
        Show decisions
      </button>
      {result?.kind === "failed" && <p>Actor evidence unavailable.</p>}
      {physical && (
        <>
          <p>
            Location {physical.locationId ?? "None"}; current action{" "}
            {physical.selectedAction ? describe(physical.selectedAction) : "None"}
          </p>
          {values.length > 0 && (
            <p>{values.map(([name, value]) => `${name} ${String(value)}`).join(", ")}</p>
          )}
          {owned.some((evidence) => evidence.status === "redacted") && (
            <p>Decision evidence redacted.</p>
          )}
          {owned.some((evidence) => evidence.status === "unavailable") && (
            <p>Decision evidence unavailable.</p>
          )}
          {drafts.length === 0 && owned.every((evidence) => evidence.status === "available") && (
            <p>No decisions recorded for this actor.</p>
          )}
          {drafts.map((draft) => (
            <Decision key={`${draft.simulationTime}:${draft.draftIndex}`} draft={draft} />
          ))}
        </>
      )}
    </section>
  );
}

function Decision({ draft }: { readonly draft: PublicDecisionTrace }) {
  const { selectedAction, candidates } = draft;
  const chosen = candidates.find(
    (candidate) =>
      candidate.action.kind === selectedAction.kind &&
      candidate.action.targetObjectId === selectedAction.targetObjectId,
  );
  const believed = candidates.filter(
    (candidate) => featureOf(candidate, "expectation") || featureOf(candidate, "freshness"),
  );
  return (
    <section aria-label={`Decision at ${draft.simulationTime}`}>
      <h4>Decision at simulation time {draft.simulationTime}</h4>
      <h5>Perception</h5>
      <ul>
        {candidates.map((candidate) => {
          const perceived = featureOf(candidate, "perceived");
          const text =
            perceived !== undefined && perceived !== "0" && perceived !== "no"
              ? "perceived"
              : candidate.excludedReason === "not-perceived"
                ? "not perceived"
                : (perceived ?? "not recorded");
          return (
            <li key={describe(candidate.action)}>{`${describe(candidate.action)}: ${text}`}</li>
          );
        })}
      </ul>
      <h5>Beliefs</h5>
      {believed.length === 0 ? (
        <p>No beliefs recorded.</p>
      ) : (
        <ul>
          {believed.map((candidate) => (
            <li key={describe(candidate.action)}>
              {`${describe(candidate.action)}: expectation ${featureOf(candidate, "expectation") ?? "not recorded"}, freshness ${featureOf(candidate, "freshness") ?? "not recorded"}`}
            </li>
          ))}
        </ul>
      )}
      <h5>Goals</h5>
      <p>
        {chosen?.features
          .filter((feature) => ACTOR_NEEDS.includes(feature.name))
          .map((feature) => `${feature.name} ${feature.value}`)
          .join(", ")}
      </p>
      <p>Candidates: {candidates.map((candidate) => describe(candidate.action)).join(", ")}</p>
      <h5>Choice</h5>
      <p>
        {`Chose ${describe(selectedAction)} (tier ${draft.selectionTier}, score ${chosen?.score ?? "n/a"})`}
      </p>
    </section>
  );
}
