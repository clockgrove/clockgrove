import type {
  BrowserScope,
  LivingScene,
  ObjectId,
  PlaceholderPresentation,
  SceneCompatibilityCode,
  SceneProjection,
} from "@clockgrove/contracts";

/** Renderer-neutral resource choices; object IDs remain the lookup identity. */
export interface SceneMaterial {
  readonly resource: string;
  readonly animation: string;
  readonly label: string;
  readonly delivery?: import("@clockgrove/contracts").SceneMaterialDelivery;
}
export interface SceneEntityPresentation {
  readonly placeholder: PlaceholderPresentation;
  readonly material?: SceneMaterial;
}

/** Resolve presentation bindings once for the current authorized semantic objects. */
export function scenePresentations(
  projection: Pick<SceneProjection, "entities" | "presentationBindings">,
): ReadonlyMap<ObjectId, SceneEntityPresentation> {
  const bindings = new Map(
    projection.presentationBindings.map((binding) => [binding.objectId, binding]),
  );
  const presentations = new Map<ObjectId, SceneEntityPresentation>();
  for (const entity of projection.entities) {
    const binding = bindings.get(entity.objectId);
    const presentation: SceneEntityPresentation = {
      placeholder: entity.presentation,
      ...(binding
        ? {
            material: {
              resource: binding.assetId,
              animation: binding.animationFamily,
              label: binding.accessibilityLabel,
              ...(binding.material === undefined ? {} : { delivery: binding.material }),
            },
          }
        : {}),
    };
    presentations.set(entity.objectId, presentation);
  }
  return presentations;
}

/** Renderer-neutral committed projection boundary; the legacy view retains semantic fields. */
export function livingSceneOf(next: SceneProjection): LivingScene {
  return {
    version: 1,
    tenantId: next.tenantId,
    worldId: next.worldId,
    timelineId: next.timelineId,
    spaceId: next.spaceId,
    privacyClass: next.privacyClass,
    revision: next.revision.toString(),
    simulationTime: next.simulationTime.toString(),
    weather: next.weather,
    frames: next.frames,
    entities: next.entities,
  };
}

export interface SceneStateProjection {
  readonly intent: number;
  readonly scope: BrowserScope | undefined;
  readonly scene: LivingScene | undefined;
  readonly projection?: SceneProjection | undefined;
  readonly status:
    | "signed out"
    | "connecting"
    | "ready"
    | "degraded"
    | "unavailable"
    | "unsupported version"
    | "Authorization lost";
  /** The final incompatibility, set only with status "unsupported version". */
  readonly incompatibility?: SceneCompatibilityCode | undefined;
}
export const emptyScene: SceneStateProjection = {
  intent: 0,
  scope: undefined,
  scene: undefined,
  status: "signed out",
};
/** What each compatibility code names as unsupported. */
export const incompatibilityNames: Readonly<Record<SceneCompatibilityCode, string>> = {
  unsupported_protocol_version: "scene protocol",
  unsupported_projection_version: "projection",
  unsupported_asset_manifest_version: "asset-manifest",
  unsupported_client_version: "client",
};
export function sceneStatusText(state: SceneStateProjection): string {
  if (state.status === "Authorization lost") return "unavailable. Authorization lost";
  if (state.status === "degraded") return "degraded. Recovering committed scene";
  if (state.incompatibility)
    return `unsupported ${incompatibilityNames[state.incompatibility]} version`;
  return state.status;
}
export type SceneStateProjectionEvent =
  | {
      readonly type: "replace";
      readonly intent: number;
      readonly scope: BrowserScope | undefined;
      readonly denied?: boolean;
    }
  | {
      readonly type: "snapshot";
      readonly intent: number;
      readonly scene: LivingScene;
      readonly projection?: SceneProjection | undefined;
    }
  | {
      readonly type: "recovering";
      readonly intent: number;
      readonly scene: LivingScene | undefined;
      readonly projection: SceneProjection | undefined;
    }
  | { readonly type: "failure"; readonly intent: number }
  | {
      readonly type: "incompatible";
      readonly intent: number;
      readonly code: SceneCompatibilityCode;
    }
  | { readonly type: "connecting"; readonly intent: number };

export function sameSceneScope(a: BrowserScope, b: BrowserScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.worldId === b.worldId &&
    a.timelineId === b.timelineId &&
    a.spaceId === b.spaceId
  );
}
export function reduceSceneState(
  state: SceneStateProjection,
  event: SceneStateProjectionEvent,
): SceneStateProjection {
  if (event.type === "replace") {
    if (event.intent <= state.intent) return state;
    return {
      intent: event.intent,
      scope: event.scope,
      scene: undefined,
      status: event.scope ? "connecting" : event.denied ? "Authorization lost" : "signed out",
    };
  }
  if (event.intent !== state.intent || !state.scope) return state;
  if (event.type === "incompatible")
    return {
      ...state,
      scene: undefined,
      projection: undefined,
      status: "unsupported version",
      incompatibility: event.code,
    };
  // Every other stream outcome supersedes a reported incompatibility.
  const current: SceneStateProjection = { ...state, incompatibility: undefined };
  if (event.type === "connecting")
    return { ...current, scene: undefined, projection: undefined, status: "connecting" };
  if (event.type === "recovering")
    return { ...current, scene: event.scene, projection: event.projection, status: "degraded" };
  if (event.type === "failure")
    return { ...current, scene: undefined, projection: undefined, status: "unavailable" };
  if (!sameSceneScope(state.scope, event.scene)) return state;
  if (state.scene && BigInt(event.scene.revision) < BigInt(state.scene.revision)) return state;
  return { ...current, scene: event.scene, projection: event.projection, status: "ready" };
}
