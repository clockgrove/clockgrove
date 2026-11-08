import type { SceneCompatibilityCode } from "@clockgrove/contracts";
import { Component, type ReactNode, useEffect, useId, useRef } from "react";
import { measure } from "./measurements.js";
import { SCENE_SNAPSHOT_RETRY } from "./projection.js";
import { incompatibilityNames } from "./scene-projection.js";
import type { ReadinessProjection } from "./scene-queries.js";
import { worldShell } from "./shell.js";

const deployment = "Refresh to load the current deployment.";
// Only a refreshed client can match a client or asset-manifest version; the others were retried.
const recoveries: Readonly<
  Record<SceneCompatibilityCode, { readonly explanation: string; readonly refresh: boolean }>
> = {
  unsupported_client_version: {
    explanation: `This client version is not supported by the world, so no scene is shown. ${deployment}`,
    refresh: true,
  },
  unsupported_asset_manifest_version: {
    explanation: `The world's asset-manifest version is not supported by this client, so no scene is shown. ${deployment}`,
    refresh: true,
  },
  unsupported_protocol_version: {
    explanation: `The world's scene protocol version stayed unsupported after ${SCENE_SNAPSHOT_RETRY.attempts} snapshot retries, so no scene is shown.`,
    refresh: false,
  },
  unsupported_projection_version: {
    explanation: `The world's projection version stayed unsupported after ${SCENE_SNAPSHOT_RETRY.attempts} snapshot retries, so no scene is shown.`,
    refresh: false,
  },
};

/** The stable screen of a final incompatibility; it takes focus and announces its explanation. */
export function CompatibilityRecovery({ code }: { readonly code: SceneCompatibilityCode }) {
  const screen = useRef<HTMLElement>(null);
  const heading = useId();
  useEffect(() => {
    screen.current?.focus();
  }, []);
  const { explanation, refresh } = recoveries[code];
  return (
    <section ref={screen} tabIndex={-1} aria-labelledby={heading}>
      <h2 id={heading}>Unsupported {incompatibilityNames[code]} version</h2>
      <p role="alert">{explanation}</p>
      {refresh && (
        <button type="button" onClick={() => location.reload()}>
          Refresh
        </button>
      )}
    </section>
  );
}

const readinessScreens: Readonly<
  Record<
    Exclude<ReadinessProjection, "refused">,
    { readonly title: string; readonly explanation: string; readonly alert: boolean }
  >
> = {
  checking: {
    title: "Checking world readiness",
    explanation: "Checking whether this world is ready to observe.",
    alert: false,
  },
  provisioning: {
    title: "World provisioning",
    explanation:
      "This world is still being provisioned, so no scene is shown yet. The scene opens once the world is ready.",
    alert: false,
  },
  failed: {
    title: "World provisioning failed",
    explanation:
      "Provisioning this world failed, so no scene is shown. Retry once its provisioning has been retried.",
    alert: true,
  },
  unavailable: {
    title: "World readiness unavailable",
    explanation:
      "This world's readiness could not be read, so no scene is shown. Retry to read it again.",
    alert: true,
  },
  ready: {
    title: "World ready",
    explanation: "The world is ready. Opening the scene.",
    alert: false,
  },
};

/**
 * The arrival screen of a routed world the directory does not list yet: it takes focus whenever
 * the readiness it announces changes, and offers Retry until the world is ready.
 */
export function ArrivalReadiness({
  readiness,
  retry,
}: {
  readonly readiness: Exclude<ReadinessProjection, "refused">;
  readonly retry: () => void;
}) {
  const screen = useRef<HTMLElement>(null);
  const heading = useId();
  useEffect(() => {
    if (readiness) screen.current?.focus();
  }, [readiness]);
  const { title, explanation, alert } = readinessScreens[readiness];
  return (
    <section ref={screen} tabIndex={-1} aria-labelledby={heading}>
      <h2 id={heading}>{title}</h2>
      {alert ? (
        <p role="alert">{explanation}</p>
      ) : (
        <p role="status" aria-live="polite" aria-atomic="true">
          {explanation}
        </p>
      )}
      {readiness !== "ready" && readiness !== "checking" && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </section>
  );
}

/**
 * The shell's error boundary: a component that throws while rendering leaves a recoverable error
 * screen instead of a blank page. Only the closed `shell` category is recorded: an error's message
 * or stack may name entities.
 */
export class ShellErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    measure("client_errors", "shell");
  }
  override render() {
    return this.state.failed ? <ShellError /> : this.props.children;
  }
}

/** Takes focus and announces the failure; reloading starts a fresh client on unchanged world truth. */
function ShellError() {
  const screen = useRef<HTMLElement>(null);
  const heading = useId();
  useEffect(() => {
    screen.current?.focus();
  }, []);
  return (
    <main className="rw-main">
      <section ref={screen} tabIndex={-1} aria-labelledby={heading}>
        <h1 id={heading}>{worldShell.copy.stopped}</h1>
        <p role="alert">
          The view stopped after an error. The world is unchanged. Reload to observe it again.
        </p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    </main>
  );
}
