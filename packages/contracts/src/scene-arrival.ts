import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import {
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
  unsignedDecimal,
} from "./validation.js";

export interface WorldBootProgress {
  readonly completed: number;
  readonly total: number;
  readonly resumeToken: string;
}

export type WorldBootState = {
  readonly requestId: string;
  readonly progress: WorldBootProgress;
} & (
  | {
      readonly state: "route_resolving";
      readonly route: string;
    }
  | {
      readonly state: "identity_resolved" | "membership_authorized" | "joining_space";
      readonly scope: BrowserScope;
    }
  | {
      readonly state: "snapshot_ready" | "critical_assets_ready";
      readonly scope: BrowserScope;
      readonly projectionRevision: bigint;
    }
  | {
      readonly state: "scene_ready";
      readonly scope: BrowserScope;
      readonly projectionRevision: bigint;
      readonly terminal: true;
    }
  | {
      readonly state: "text_ready";
      readonly scope: BrowserScope;
      readonly projectionRevision: bigint;
      readonly terminal: true;
      readonly reason: "assets_unavailable" | "renderer_unavailable";
    }
);

export function decodeWorldBootProgress(value: unknown, path = "boot.progress"): WorldBootProgress {
  const v = record(value, path);
  exactKeys(v, ["completed", "total", "resumeToken"], [], path);
  const completed = nonNegativeInteger(v.completed, `${path}.completed`);
  const total = nonNegativeInteger(v.total, `${path}.total`);
  if (completed > total) throw new ContractDecodeError(path, "completed exceeds total");
  return Object.freeze({
    completed,
    total,
    resumeToken: string(v.resumeToken, `${path}.resumeToken`),
  });
}

/** Ordered milestones; progress counts those completed after `route_resolving`. */
const BOOT_MILESTONES = [
  "route_resolving",
  "identity_resolved",
  "membership_authorized",
  "joining_space",
  "snapshot_ready",
  "critical_assets_ready",
  "scene_ready",
] as const;

/** Decoding describes arrival and resumability; it grants no membership or navigation authority. */
export function decodeWorldBootState(value: unknown): WorldBootState {
  const path = "boot";
  const v = record(value, path);
  const state = literal(v.state, [...BOOT_MILESTONES, "text_ready"], `${path}.state`);
  const common = {
    requestId: string(v.requestId, `${path}.requestId`),
    progress: decodeWorldBootProgress(v.progress),
  };
  // Both terminal states are complete; every other state has completed exactly its predecessors.
  const total = BOOT_MILESTONES.length - 1;
  const completed = state === "text_ready" ? total : BOOT_MILESTONES.indexOf(state);
  if (common.progress.completed !== completed || common.progress.total !== total)
    throw new ContractDecodeError(`${path}.progress`, `${state} implies ${completed}/${total}`);
  const keys = ["requestId", "progress", "state"];
  if (state === "route_resolving") {
    exactKeys(v, [...keys, "route"], [], path);
    return Object.freeze({ ...common, state, route: string(v.route, `${path}.route`) });
  }
  const scope = decodeBrowserScope(v.scope);
  if (
    state === "identity_resolved" ||
    state === "membership_authorized" ||
    state === "joining_space"
  ) {
    exactKeys(v, [...keys, "scope"], [], path);
    return Object.freeze({ ...common, state, scope });
  }
  const projectionRevision = unsignedDecimal(v.projectionRevision, `${path}.projectionRevision`);
  if (state === "snapshot_ready" || state === "critical_assets_ready") {
    exactKeys(v, [...keys, "scope", "projectionRevision"], [], path);
    return Object.freeze({ ...common, state, scope, projectionRevision });
  }
  if (v.terminal !== true)
    throw new ContractDecodeError(`${path}.terminal`, "ready states are terminal");
  if (state === "scene_ready") {
    exactKeys(v, [...keys, "scope", "projectionRevision", "terminal"], [], path);
    return Object.freeze({ ...common, state, scope, projectionRevision, terminal: true });
  }
  exactKeys(v, [...keys, "scope", "projectionRevision", "terminal", "reason"], [], path);
  return Object.freeze({
    ...common,
    state,
    scope,
    projectionRevision,
    terminal: true,
    reason: literal(v.reason, ["assets_unavailable", "renderer_unavailable"], `${path}.reason`),
  });
}
