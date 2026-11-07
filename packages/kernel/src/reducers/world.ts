import {
  reduceWorldEvent,
  WORLD_EVENT_DEFINITIONS,
  type WorldEvent,
  type WorldState,
} from "@clockgrove/domain";
import { REGISTERED, type RegistrationResult } from "../execute/refusal.js";
import { EventRegistry, ReducerRegistry } from "./registry.js";

export const WORLD_OWNER = "clockgrove.world";
export const PORTAL_OWNER = "clockgrove.portal";

/**
 * Registers every world event and exactly one reducer per type/version. Each reducer applies the
 * domain's reduceWorldEvent to its own event type only, so behavior is equivalent to the
 * unversioned reducer for the four registered events.
 */
export function registerWorldReducers(
  events: EventRegistry,
  reducers: ReducerRegistry<WorldState, WorldEvent>,
): RegistrationResult {
  for (const { type, version } of WORLD_EVENT_DEFINITIONS) {
    const registeredEvent = events.register({
      type,
      version,
      owner: type.startsWith("resource.")
        ? "clockgrove.resource"
        : type.startsWith("movement.")
          ? "clockgrove.movement"
          : type.startsWith("portal.")
            ? PORTAL_OWNER
            : /^(?:object|containment)\./u.test(type)
              ? "clockgrove.containment"
              : WORLD_OWNER,
    });
    if (!registeredEvent.ok) return registeredEvent;
    const registeredReducer = reducers.register({
      type,
      version,
      reduce: (state, event) => {
        if (event.type !== type || event.schemaVersion !== version)
          throw new TypeError("reducer received a different event type or version");
        return reduceWorldEvent(state, event);
      },
    });
    if (!registeredReducer.ok) return registeredReducer;
  }
  return REGISTERED;
}
