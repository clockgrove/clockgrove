import type { ZodType } from "zod";
import type { EffectiveObject } from "./archetypes/index.js";
import {
  archetypeSchema,
  type AccessPolicy as CatalogAccessPolicy,
  type ComponentValidationContext as CatalogContext,
  containmentSchema,
  createInitialComponentCatalog,
  identitySchema,
  lifecycleSchema,
  needsSchema,
  portalSchema,
  resourceSchema,
  spatialTransformSchema,
  weatherExposureSchema,
} from "./components/catalog/index.js";
import {
  type CanonicalCodec,
  type ComponentRegistration,
  type ComponentRegistry,
  CompositionError,
  compareUtf16,
  createComponentRegistry,
  type DomainIssue,
  immutableCopy,
} from "./components/registry/index.js";
import { createWorldState, type WorldEntity, type WorldState } from "./world.js";

/** Preserve production schemas/codecs; translate only the catalog's privacy argument wrapper. */
function registration<T>(descriptor: {
  readonly type: string;
  readonly version: number;
  readonly schema: ZodType<T>;
  readonly canonicalCodec: CanonicalCodec<T>;
  validateState(value: T, context: CatalogContext): DomainIssue[];
  redact(value: T, access: CatalogAccessPolicy): unknown;
  readonly upcasters: readonly never[];
}): ComponentRegistration<T> {
  return {
    ...descriptor,
    validateState: (value, context) => descriptor.validateState(value, context),
    redact: (value, access) => descriptor.redact(value, { privacyCeiling: access }),
  };
}

/** The supported production registry/catalog composition root for this bounded slice. */
export function createInitialComponentRegistry(): ComponentRegistry {
  const components = createComponentRegistry();
  const [
    identity,
    archetype,
    spatial,
    needs,
    weather,
    containment,
    resource,
    lifecycle,
    portal,
    presentation,
    conversationMode,
  ] = createInitialComponentCatalog();
  components.register(registration(identity));
  components.register(registration(archetype));
  components.register(registration(spatial));
  components.register(registration(needs));
  components.register(registration(weather));
  components.register(registration(containment));
  components.register(registration(resource));
  components.register(registration(lifecycle));
  components.register(registration(portal));
  components.register(registration(presentation));
  components.register(registration(conversationMode));
  return components;
}

function refuse(path: string, message: string): never {
  throw new CompositionError("WORLD_ADAPTER_REFUSAL", path, message);
}

/**
 * Project a complete object collection, never merge into stale entity state. Metadata remains
 * in the caller's effective objects; the physical kernel consumes only this validated projection.
 */
export function projectEffectiveObjectsToWorldState(
  base: Omit<WorldState, "entities">,
  objects: readonly EffectiveObject[],
  components: ComponentRegistry = createInitialComponentRegistry(),
): WorldState {
  const ownedBase = immutableCopy(base, "world");
  const ownedObjects = immutableCopy(objects, "objects");
  const supported = new Set(createInitialComponentCatalog().map(({ type }) => type));
  const entities: WorldEntity[] = ownedObjects.map((object, index) => {
    const path = `objects[${index}]`;
    if (
      object.tenantId !== ownedBase.tenantId ||
      object.state.worldId !== ownedBase.worldId ||
      object.definition.worldId !== ownedBase.worldId ||
      object.state.timelineId !== ownedBase.timelineId ||
      object.simulationTime !== ownedBase.simulationTime ||
      object.definition.id !== object.state.objectId
    )
      refuse(path, "object identity, scope and simulation time must match the world");
    const lifecycle = object.state.components["clockgrove.lifecycle"];
    const containment = object.state.components["clockgrove.containment"];
    if (
      (lifecycle === undefined ? "active" : lifecycleSchema.parse(lifecycle.state).status) !==
      object.state.lifecycleStatus
    )
      refuse(`${path}.state.lifecycleStatus`, "lifecycle component and timeline state must match");
    if (
      (containment === undefined
        ? undefined
        : containmentSchema.parse(containment.state).containerId) !== object.state.containerId
    )
      refuse(`${path}.state.containerId`, "containment component and timeline state must match");
    if (typeof object.state.revision !== "bigint" || object.state.revision < 0n)
      refuse(`${path}.state.revision`, "expected a nonnegative bigint revision");
    const context = {
      tenantId: ownedBase.tenantId,
      worldId: ownedBase.worldId,
      timelineId: ownedBase.timelineId,
      objectId: object.state.objectId,
      partitionId: ownedBase.partitionId,
      simulationTime: ownedBase.simulationTime,
      spatialFrames: ownedBase.spatialFrames,
      expectedArchetype: object.definition.archetype,
      expectedTraits: object.traitPins,
    };
    const snapshots = object.state.components;
    for (const type of Object.keys(snapshots).sort(compareUtf16)) {
      const snapshot = snapshots[type]!;
      if (!supported.has(type) || snapshot.type !== type || snapshot.version !== 1)
        refuse(`${path}.components.${type}`, "unsupported component key or version");
      components.validate(snapshot, context, `${path}.components.${type}`);
      components.encode(snapshot, context, `${path}.components.${type}`);
    }
    function required(type: string): unknown {
      const snapshot = snapshots[type];
      if (snapshot === undefined)
        refuse(`${path}.components.${type}`, "required component missing");
      return snapshot.state;
    }
    const identity = identitySchema.parse(required("clockgrove.identity"));
    const archetype = archetypeSchema.parse(required("clockgrove.archetype"));
    const spatial = spatialTransformSchema.parse(required("clockgrove.spatial-transform"));
    if (
      identity.objectId !== object.state.objectId ||
      archetype.archetype.id !== object.definition.archetype.id ||
      archetype.archetype.version !== object.definition.archetype.version ||
      archetype.traits.length !== object.traitPins.length ||
      archetype.traits.some(
        (pin, index) =>
          pin.id !== object.traitPins[index]?.id ||
          pin.version !== object.traitPins[index]?.version,
      )
    )
      refuse(`${path}.components`, "Identity and Archetype must match the effective object pins");
    if (spatial.spaceId !== object.state.spaceId)
      refuse(`${path}.state.spaceId`, "component and timeline physical space must match");
    if (identity.owner !== object.definition.owner)
      refuse(`${path}.definition.owner`, "definition and Identity ownership must match");
    const needs = snapshots["clockgrove.needs"];
    const weather = snapshots["clockgrove.weather-exposure"];
    const portal = snapshots["clockgrove.portal"];
    return {
      objectId: identity.objectId,
      archetypeId: `${archetype.archetype.id}@${archetype.archetype.version}`,
      spaceId: spatial.spaceId,
      pose: spatial.pose,
      ...(spatial.locationId === undefined ? {} : { locationId: spatial.locationId }),
      ...(containment === undefined
        ? {}
        : { containment: containmentSchema.parse(containment.state) }),
      ...(lifecycle === undefined ? {} : { lifecycle: lifecycleSchema.parse(lifecycle.state) }),
      ...(snapshots["clockgrove.resource"] === undefined
        ? {}
        : { resource: resourceSchema.parse(snapshots["clockgrove.resource"].state) }),
      ...(needs === undefined ? {} : { needs: needsSchema.parse(needs.state) }),
      ...(weather === undefined ? {} : { shelter: weatherExposureSchema.parse(weather.state) }),
      ...(portal === undefined ? {} : { portal: portalSchema.parse(portal.state) }),
    };
  });
  return createWorldState({ ...ownedBase, entities });
}
