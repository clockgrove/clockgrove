import type { SceneCompatibilityCode } from "@clockgrove/contracts";
import { useEffect, useId, useRef } from "react";
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
