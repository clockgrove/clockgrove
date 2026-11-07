import {
  type PortalCommandType,
  type PortalUsePayload,
  portalEdges,
  portalInTransit,
  portalIsOpen,
  regionsContaining,
  sameCoordinates,
  type WorldEntity,
  type WorldState,
} from "@clockgrove/domain";
import { buildRecord, type MovementRuntime, observe, type Plan } from "./movement.js";

function find(state: WorldState, objectId: string): WorldEntity | undefined {
  return state.entities.find((entity) => entity.objectId === objectId);
}

function isActive(entity: WorldEntity): boolean {
  return entity.lifecycle === undefined || entity.lifecycle.status === "active";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The one-hop movement of `portal.use`: from the anchor the actor stands on, through the open
 * portal, to the anchor it joins on the other side (the smallest anchor id when a region endpoint
 * stands for several). Fails at `payload.portalId` when the portal is closed or does not lead
 * away from where the actor stands.
 */
export function planPortalUse(
  state: WorldState,
  actor: WorldEntity,
  portalId: string,
  unitsPerSecond: bigint,
  commandId: string,
): Plan {
  if (!portalIsOpen(state, portalId)) return { ok: false, path: "payload.portalId" };
  for (const graph of state.anchorGraphs ?? []) {
    if (graph.frameId !== actor.pose.frameId || graph.frameVersion !== actor.pose.frameVersion)
      continue;
    const origin = graph.anchors.find((anchor) =>
      sameCoordinates(anchor.coordinates, actor.pose.coordinates),
    );
    if (origin === undefined) continue;
    const far = portalEdges(state, graph)
      .filter(
        (edge) =>
          edge.portalId === portalId &&
          (edge.from === origin.anchorId || edge.to === origin.anchorId),
      )
      .map((edge) => (edge.from === origin.anchorId ? edge.to : edge.from))
      .sort(compareText)[0];
    if (far === undefined) continue;
    const target = graph.anchors.find((anchor) => anchor.anchorId === far)!;
    return buildRecord(
      state,
      actor,
      [origin.coordinates, target.coordinates],
      [origin.anchorId, far],
      [portalId],
      { kind: "anchor", anchorId: far, graphVersion: graph.version },
      unitsPerSecond,
      state.simulationTime,
      commandId,
      {
        initialInside: regionsContaining(
          state.spatialRegions ?? [],
          actor.pose.frameId,
          actor.pose.frameVersion,
          actor.pose.coordinates,
        ),
        exitedAtStart: [],
      },
    );
  }
  return { ok: false, path: "payload.portalId" };
}

/** `portal.use`: starts the one-hop movement and observes it like `movement.start`. */
export function runPortalUse(rt: MovementRuntime): void {
  const payload = rt.payload as PortalUsePayload;
  const actor = find(rt.state, payload.objectId)!;
  const plan = planPortalUse(
    rt.state,
    actor,
    payload.portalId,
    payload.unitsPerSecond,
    rt.command.commandId,
  );
  if (!plan.ok) throw new RangeError("portal is not usable");
  rt.emit(
    "movement.started",
    { objectId: actor.objectId, movement: plan.record },
    rt.state.simulationTime,
  );
  observe(rt, actor, plan.record, payload.observeUntil);
}

export const PORTAL_CHECKS = Object.freeze([
  "active-object",
  "known",
  "reachable",
  "state",
  "timing",
  "transit",
] as const);
export type PortalCheck = (typeof PORTAL_CHECKS)[number];

/**
 * The offending payload path of a portal precondition (`portal.<check>@1`), or undefined. Every
 * check is total: one that does not apply, or whose subject another check refuses, passes.
 * - `known`: no object with a Portal component is named (`payload.portalId`).
 * - `active-object`: the portal object is retired or dead (`payload.portalId`); for `use`, the
 *   actor is unknown, retired, dead or already moving (`payload.objectId`).
 * - `state`: `open` of an open portal, `close` of a closed one (`payload.portalId`).
 * - `transit`: `close` while an active movement still has to cross the portal (`payload.portalId`).
 * - `reachable`: `use` of a closed portal, or from a place it does not lead away from
 *   (`payload.portalId`).
 * - `timing`: `use` with `observeUntil` before the world time (`payload.observeUntil`).
 */
export function portalPreconditionPath(
  check: PortalCheck,
  state: WorldState,
  commandType: PortalCommandType,
  commandId: string,
  payload: unknown,
): string | undefined {
  const p = payload as PortalUsePayload;
  const portal = find(state, p.portalId);
  const known = portal?.portal !== undefined;
  const use = commandType === "portal.use";
  switch (check) {
    case "known":
      return known ? undefined : "payload.portalId";
    case "active-object": {
      if (known && !isActive(portal!)) return "payload.portalId";
      if (!use) return undefined;
      const actor = find(state, p.objectId);
      return actor === undefined || !isActive(actor) || actor.movement?.status === "active"
        ? "payload.objectId"
        : undefined;
    }
    case "state": {
      if (!known || use) return undefined;
      const wanted = commandType === "portal.open" ? "open" : "closed";
      return portal!.portal!.status === wanted ? "payload.portalId" : undefined;
    }
    case "transit":
      return commandType === "portal.close" &&
        known &&
        portalInTransit(state, p.portalId) !== undefined
        ? "payload.portalId"
        : undefined;
    case "reachable": {
      if (!use || !known || !isActive(portal!)) return undefined;
      const actor = find(state, p.objectId);
      if (actor === undefined || !isActive(actor) || actor.movement?.status === "active")
        return undefined;
      return planPortalUse(state, actor, p.portalId, p.unitsPerSecond, commandId).ok
        ? undefined
        : "payload.portalId";
    }
    case "timing":
      return use && p.observeUntil !== undefined && p.observeUntil < state.simulationTime
        ? "payload.observeUntil"
        : undefined;
  }
}
