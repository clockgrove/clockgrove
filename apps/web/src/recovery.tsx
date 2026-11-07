import type { SceneCompatibilityCode } from "@clockgrove/contracts";
import { Component, type ReactNode, useEffect, useId, useRef } from "react";
import { measure } from "./measurements.js";
import { SCENE_SNAPSHOT_RETRY } from "./projection.js";
import { incompatibilityNames } from "./yard-projection.js";

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
        <h1 id={heading}>Raccoon World stopped</h1>
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
