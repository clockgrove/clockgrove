import {
  type BrowserScope,
  type ChangeViewedSpace,
  decodeVisibleSpace,
  type FollowDisposition,
  type ObjectId,
  type PrivacyCategory,
  type VisibleSpace,
} from "@clockgrove/contracts";
import { placeOf, regionAncestors, type WorldState } from "@clockgrove/domain";
import { decideSceneAudience } from "./scene-audience.js";

/**
 * The projected space, then every declared region by region ID whose frame descends from a root
 * frame of the space (the root of any frame its entities use). Membership follows declared frame
 * ancestry, not which region an entity currently stands in. A region's parent is its semantic
 * parent when that is listed, else the authority space; each chain therefore ends at the space.
 */
export function sceneHierarchyOf(spaceId: string, state: WorldState): readonly VisibleSpace[] {
  const parentOf = new Map<string, string | undefined>(
    state.spatialFrames.map((frame) => [frame.frameId, frame.parentFrameId]),
  );
  const rootOf = (frameId: string): string => {
    let current = frameId;
    for (let depth = 0; depth <= parentOf.size; depth += 1) {
      const parent = parentOf.get(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  };
  const roots = new Set(
    state.entities
      .filter((entity) => entity.spaceId === spaceId)
      .map((e) => rootOf(e.pose.frameId)),
  );
  const frames = new Set(
    state.spatialFrames.map((f) => f.frameId).filter((f) => roots.has(rootOf(f))),
  );
  const regions = (state.spatialRegions ?? [])
    .filter((region) => frames.has(region.frameId) && region.regionId !== spaceId)
    .sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));
  const listed = new Set(regions.map((region) => region.regionId));
  return [
    { spaceId, label: spaceId },
    ...regions.map((region) => ({
      spaceId: region.regionId,
      label: region.regionId,
      parentSpaceId:
        region.parent !== undefined && listed.has(region.parent.regionId)
          ? region.parent.regionId
          : spaceId,
    })),
  ].map((space) => decodeVisibleSpace(space));
}

/** A target inside the current authority space (itself or a region) keeps the connection scope. */
export function isNestedTarget(request: ChangeViewedSpace, state: WorldState): boolean {
  return sceneHierarchyOf(request.scope.spaceId, state).some(
    (space) => space.spaceId === request.targetSpaceId,
  );
}

export function connectionScopeOf(request: ChangeViewedSpace, state: WorldState): BrowserScope {
  return isNestedTarget(request, state)
    ? request.scope
    : { ...request.scope, spaceId: request.targetSpaceId };
}

const hidden = (request: ChangeViewedSpace): FollowDisposition => ({
  requestId: request.requestId,
  disposition: "target_hidden",
  selectedEntityId: null,
});

/** Whether this audience's decided interest keeps the entity: hidden and absent look the same. */
function projectable(
  state: WorldState,
  scope: BrowserScope,
  entityId: ObjectId,
  categories: readonly PrivacyCategory[],
): boolean {
  if (!state.entities.some((e) => e.objectId === entityId && e.spaceId === scope.spaceId))
    return false;
  const decision = decideSceneAudience(
    state,
    {
      ...scope,
      privacyClass: "public_scene",
      interest: { selection: entityId, conversation: false, operator: false },
    },
    { categories, inspect: false, command: false },
  );
  return decision.descriptor.interest.selection === entityId;
}

export interface FollowInput {
  readonly request: ChangeViewedSpace;
  /** The connection scope of the request and its hydrated state. */
  readonly scope: BrowserScope;
  readonly state: WorldState;
  /** The request's current scope state, when the connection scope is another authority space. */
  readonly currentState?: WorldState;
  readonly categories: readonly PrivacyCategory[];
}

/** Null when the request selects no entity. Pure: it reads state and changes none. */
export function followDispositionOf(input: FollowInput): FollowDisposition | null {
  const { request, scope, state, categories } = input;
  const entityId = request.selectedEntityId;
  if (entityId === undefined) return null;
  const answer = (disposition: "followed" | "stayed_within_space", to: BrowserScope) => ({
    requestId: request.requestId,
    scope: to,
    disposition,
    selectedEntityId: entityId,
    authorized: true as const,
    projectable: true as const,
  });
  if (!projectable(state, scope, entityId, categories)) {
    // Not in the target space, but still visible where the observer already is: stay there.
    const { currentState } = input;
    return currentState !== undefined &&
      projectable(currentState, request.scope, entityId, categories)
      ? answer("stayed_within_space", request.scope)
      : hidden(request);
  }
  const entity = state.entities.find((e) => e.objectId === entityId);
  if (entity === undefined) return hidden(request);
  if (request.targetSpaceId === scope.spaceId) return answer("followed", scope);
  const regions = state.spatialRegions ?? [];
  const place = placeOf(
    regions,
    entity.pose.frameId,
    entity.pose.frameVersion,
    entity.pose.coordinates,
  );
  const stands =
    place !== undefined &&
    (place === request.targetSpaceId ||
      regionAncestors(regions, place).includes(request.targetSpaceId));
  return answer(stands ? "followed" : "stayed_within_space", scope);
}
