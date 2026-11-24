import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiRefusal } from "./api.js";
import { PlaygroundRefusal, type SceneSession } from "./scene-api.js";

declare const __PLAYGROUND__: unknown;
/** True only in a shell built by a `pnpm playground` session (apps/web/vite.config.ts). */
export const playgroundHosted = typeof __PLAYGROUND__ !== "undefined" && __PLAYGROUND__ === true;

interface Refusal {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
interface WorldEntry {
  readonly id: string;
  readonly packId: string;
  readonly version: string;
  readonly directory: string;
  readonly status: "starting" | "ready" | "stopped";
  readonly url: string | null;
  readonly current: boolean;
  readonly checks: { readonly status: Checks["status"]; readonly refusal?: Refusal };
}
interface Checks {
  readonly status: "running" | "passed" | "failed" | "unavailable";
  readonly results: readonly {
    readonly name: string;
    readonly scenario: string | null;
    readonly status: "passed" | "failed" | "skipped";
    readonly refusal: Refusal | null;
  }[];
  readonly refusal?: Refusal;
}
interface PackSummary {
  readonly world: WorldEntry;
  readonly metadata: {
    readonly name: string;
    readonly version: string;
    readonly content: Readonly<
      Record<"entities" | "places" | "rules" | "scenarios" | "art", number>
    >;
  };
  readonly checks: Checks;
}
interface MigrationPreview {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly steps: readonly {
    readonly stepId: string;
    readonly type: string;
    readonly version: number | string;
  }[];
}

const pollMs = 2000;
/** A failed poll is retried at this slower pace, so a refusing host is not pressed. */
const retryMs = 10_000;
const counts = [
  ["entities", "Entities"],
  ["places", "Places"],
  ["rules", "Rules"],
  ["scenarios", "Scenarios"],
  ["art", "Art"],
] as const;

const failure = (error: unknown) =>
  error instanceof PlaygroundRefusal ? error.detail : "Request failed";
/** A refusal of the caller itself (401, 403) is final; anything else (429, 5xx, network) is retried. */
const retryable = (error: unknown) =>
  !(error instanceof ApiRefusal && (error.status === 401 || error.status === 403));

/** Owner-only pack inspector; renders nothing unless the local playground API answers. */
export function PlaygroundPack({ session }: { readonly session: SceneSession }) {
  const [pack, setPack] = useState<PackSummary>();
  const running = pack?.checks.status === "running";

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      session.playgroundRequest<PackSummary>("pack").then(
        (next) => {
          if (!live) return;
          setPack(next);
          if (next.checks.status === "running") timer = setTimeout(load, pollMs);
        },
        (cause: unknown) => {
          if (live && retryable(cause)) timer = setTimeout(load, retryMs);
        },
      );
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session]);

  if (!pack) return null;
  const { metadata, checks } = pack;
  return (
    <details>
      <summary>Pack</summary>
      <section aria-label="Pack metadata">
        <h3>
          {metadata.name} {metadata.version}
        </h3>
        <dl>
          {counts.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{metadata.content[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label="Pack checks">
        <p>Checks: {checks.status}</p>
        {running && <p>Checks are running.</p>}
        {checks.refusal && (
          <p role="alert">
            {checks.refusal.code}: {checks.refusal.message}
          </p>
        )}
        <ul>
          {checks.results.map((result) => (
            <li key={`${result.name}/${result.scenario ?? ""}`}>
              {result.name}
              {result.scenario !== null && ` (${result.scenario})`}: {result.status}
              {result.refusal && ` — ${result.refusal.code}`}
            </li>
          ))}
        </ul>
      </section>
      <HostedWorlds session={session} />
      <MigrationForm session={session} />
    </details>
  );
}

function HostedWorlds({ session }: { readonly session: SceneSession }) {
  const [worlds, setWorlds] = useState<readonly WorldEntry[]>([]);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const starting = worlds.some((world) => world.status === "starting");

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-runs the request after a load
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      session.playgroundRequest<{ worlds: WorldEntry[] }>("worlds").then(
        (next) => {
          if (!live) return;
          setWorlds(next.worlds);
          setListError(undefined);
          if (next.worlds.some((world) => world.status === "starting")) {
            timer = setTimeout(load, pollMs);
          }
        },
        (cause: unknown) => {
          if (!live) return;
          setListError(failure(cause));
          if (retryable(cause)) timer = setTimeout(load, retryMs);
        },
      );
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, tick, starting]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    session
      .playgroundRequest("load", { directory })
      .then(refresh, (cause: unknown) => setError(failure(cause)));
  };
  const stop = (world: WorldEntry) => {
    setError(undefined);
    session
      .playgroundRequest("stop", { world: world.id })
      .then(refresh, (cause: unknown) => setError(failure(cause)));
  };

  return (
    <section aria-label="Hosted worlds">
      <h3>Hosted worlds</h3>
      {listError && <p role="alert">{listError}</p>}
      <ul>
        {worlds.map((world) => (
          <li key={world.id}>
            {world.packId}@{world.version} — {world.status}, checks {world.checks.status}
            {world.current && " (this world)"}
            {world.checks.refusal &&
              ` — ${world.checks.refusal.code} at ${world.checks.refusal.path}: ${world.checks.refusal.message}`}
            {world.url && !world.current && (
              <>
                {" "}
                <a href={world.url}>
                  Open {world.packId}@{world.version}
                </a>
              </>
            )}
            {!world.current && world.status !== "stopped" && (
              <>
                {" "}
                <button type="button" onClick={() => stop(world)}>
                  Stop {world.packId}@{world.version}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form aria-label="Load a pack from a local directory" onSubmit={submit}>
        <label>
          Pack directory
          <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
        </label>
        <button type="submit">Load pack</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}

function MigrationForm({ session }: { readonly session: SceneSession }) {
  const [directory, setDirectory] = useState("");
  const [preview, setPreview] = useState<MigrationPreview>();
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setPreview(undefined);
    session
      .playgroundRequest<MigrationPreview>("migration-preview", { directory })
      .then(setPreview, (cause: unknown) => setError(failure(cause)));
  };

  return (
    <section aria-label="Migration preview">
      <form aria-label="Preview a migration" onSubmit={submit}>
        <label>
          Newer pack directory
          <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
        </label>
        <button type="submit">Preview migration</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p>
            From {preview.fromVersion} to {preview.toVersion}: {preview.steps.length} steps
          </p>
          <ol>
            {preview.steps.map((step) => (
              <li key={step.stepId}>
                {step.stepId} ({step.type} v{step.version})
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
