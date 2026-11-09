import {
  type BrowserScope,
  decodeWorldBootState,
  type WorldBootProgress,
  type WorldBootState,
} from "@clockgrove/contracts";
import { sameSceneScope } from "./scene-projection.js";
import { worldRoutePath } from "./world-route.js";

// The contract's milestone order (wave plan §6.5); scene-arrival.ts keeps its own copy private.
const milestones = [
  "route_resolving",
  "identity_resolved",
  "membership_authorized",
  "joining_space",
  "snapshot_ready",
  "critical_assets_ready",
  "scene_ready",
] as const;

type WorldBootPhase = WorldBootState["state"];
export type TextReadyReason = Extract<WorldBootState, { readonly state: "text_ready" }>["reason"];

/** Arrival inputs after the route; each applies only to its predecessor state. */
export type WorldBootEvent =
  | { readonly type: "identify"; readonly scope: BrowserScope }
  | { readonly type: "authorize" }
  | { readonly type: "join"; readonly scope: BrowserScope }
  | { readonly type: "snapshot"; readonly scope: BrowserScope; readonly revision: bigint }
  // Renderer outcomes name the boot that mounted the renderer.
  | { readonly type: "assets"; readonly requestId: string }
  | { readonly type: "present"; readonly requestId: string; readonly revision: bigint }
  // A fallback names the revision of the projection the shell holds when it falls back.
  | {
      readonly type: "fallback";
      readonly requestId: string;
      readonly reason: TextReadyReason;
      readonly revision: bigint;
    };

/** The shell holds only values the contract decoder accepts. */
function checked(boot: WorldBootState): WorldBootState {
  return decodeWorldBootState(
    "projectionRevision" in boot
      ? { ...boot, projectionRevision: boot.projectionRevision.toString() }
      : boot,
  );
}

/** Progress counts completed milestones; the world route path resumes the boot. */
function progress(state: WorldBootPhase, resumeToken: string): WorldBootProgress {
  const total = milestones.length - 1;
  return {
    completed: state === "text_ready" ? total : milestones.indexOf(state),
    total,
    resumeToken,
  };
}

export function routeResolving(requestId: string, route: string): WorldBootState {
  return checked({
    requestId,
    progress: progress("route_resolving", route),
    state: "route_resolving",
    route,
  });
}

export function reduceBoot(boot: WorldBootState, event: WorldBootEvent): WorldBootState {
  const { requestId } = boot;
  if (boot.state === "route_resolving") {
    if (event.type !== "identify") return boot;
    const { scope } = event;
    const state = "identity_resolved";
    return checked({ requestId, progress: progress(state, worldRoutePath(scope)), state, scope });
  }
  const { scope } = boot;
  const at = (state: WorldBootPhase) => progress(state, worldRoutePath(scope));
  if (boot.state === "identity_resolved")
    return event.type === "authorize"
      ? checked({
          requestId,
          progress: at("membership_authorized"),
          state: "membership_authorized",
          scope,
        })
      : boot;
  if (boot.state === "membership_authorized")
    return event.type === "join" && sameSceneScope(scope, event.scope)
      ? checked({ requestId, progress: at("joining_space"), state: "joining_space", scope })
      : boot;
  if (boot.state === "joining_space")
    return event.type === "snapshot" && sameSceneScope(scope, event.scope)
      ? checked({
          requestId,
          progress: at("snapshot_ready"),
          state: "snapshot_ready",
          scope,
          projectionRevision: event.revision,
        })
      : boot;
  // A renderer outcome of an earlier boot cannot touch this one.
  if (!("projectionRevision" in boot) || !("requestId" in event) || event.requestId !== requestId)
    return boot;
  const { projectionRevision } = boot;
  // After arrival this boot's canvas still decides which ready state the shell reports: a retried
  // canvas that presents restores scene_ready, and a lost or refused one falls back to text_ready.
  if (
    "terminal" in boot &&
    !(event.type === "present" && boot.state === "text_ready") &&
    !(event.type === "fallback" && (boot.state === "scene_ready" || boot.reason !== event.reason))
  )
    return boot;
  if (event.type === "assets" && boot.state === "snapshot_ready")
    return checked({
      requestId,
      progress: at("critical_assets_ready"),
      state: "critical_assets_ready",
      scope,
      projectionRevision,
    });
  if (
    event.type === "present" &&
    (boot.state === "critical_assets_ready" || boot.state === "text_ready")
  )
    return checked({
      requestId,
      progress: at("scene_ready"),
      state: "scene_ready",
      scope,
      projectionRevision: event.revision,
      terminal: true,
    });
  if (event.type === "fallback")
    return checked({
      requestId,
      progress: at("text_ready"),
      state: "text_ready",
      scope,
      projectionRevision: event.revision,
      terminal: true,
      reason: event.reason,
    });
  return boot;
}

const announcements = {
  identity_resolved: "identity resolved",
  membership_authorized: "membership authorized",
  joining_space: "joining space",
  snapshot_ready: "snapshot ready",
  critical_assets_ready: "critical assets ready",
  scene_ready: "scene ready",
  text_ready: "text scene ready",
} as const;

/** The accessible text of the current boot state, the shell's only arrival progress. */
export function bootStatusText(boot: WorldBootState): string {
  if (boot.state === "route_resolving") return `Arrival: resolving world route ${boot.route}.`;
  const label = announcements[boot.state];
  if (!("projectionRevision" in boot)) return `Arrival: ${label}.`;
  const at = `Arrival: ${label} at revision ${boot.projectionRevision}`;
  if (boot.state !== "text_ready") return `${at}.`;
  return `${at}; ${boot.reason === "renderer_unavailable" ? "renderer" : "assets"} unavailable.`;
}
