import { decodeOpaqueId, type SimTimeMs } from "@clockgrove/contracts";
import {
  type ArchetypeDefinition,
  type ComponentMap,
  type ComponentSnapshot,
  createDefinitionRegistry,
  createInitialComponentRegistry,
  fixedPoint,
  projectEffectiveObjectsToWorldState,
  resolveEffectiveObject,
  serializeEffectiveObject,
  type TimelineObjectState,
  type TraitDefinition,
  type VersionedArchetypeRef,
  type VersionedTraitRef,
  type WorldObjectDefinition,
  type WorldScenario,
  type WorldState,
} from "@clockgrove/domain";

import { canonicalSerialize } from "../../src/canonical.js";

export const componentFixtureNames = ["raccoon", "garden"] as const;
export type ComponentFixtureName = (typeof componentFixtureNames)[number];
const snapshot = (type: string, state: unknown): ComponentSnapshot => ({ type, version: 1, state });
const map = (...values: ComponentSnapshot[]): ComponentMap =>
  Object.fromEntries(values.map((value) => [value.type, value]));

/** Independent typed inputs; no historical JSON or behavior-pack decoder participates. */
export function composeComponentFixture(
  name: ComponentFixtureName,
  override = false,
  reverse = false,
) {
  const components = createInitialComponentRegistry();
  const dimensions = name === "raccoon" ? 2 : 3;
  const zero = 0n as SimTimeMs;
  const coordinates =
    dimensions === 2
      ? ([fixedPoint(0n), fixedPoint(0n)] as const)
      : ([fixedPoint(0n), fixedPoint(0n), fixedPoint(0n)] as const);
  const frameId = decodeOpaqueId(`${name}-frame`, "SpatialFrameId");
  const base: Omit<WorldState, "entities"> = {
    schemaVersion: 1,
    tenantId: decodeOpaqueId("component-local", "TenantId"),
    worldId: decodeOpaqueId(`${name}-world`, "WorldId"),
    timelineId: decodeOpaqueId(`${name}-main`, "TimelineId"),
    partitionId: decodeOpaqueId(`${name}-partition`, "PartitionId"),
    revision: 0n,
    simulationTime: zero,
    weather: { rainIntensity: 0 },
    spatialFrames: [
      {
        frameId,
        version: 1,
        dimensions,
        unit: { name: "metre", fractionalDigits: 3 },
        axes: {
          axes:
            dimensions === 2
              ? [
                  { name: "east", positiveDirection: "eastward" },
                  { name: "north", positiveDirection: "northward" },
                ]
              : [
                  { name: "east", positiveDirection: "eastward" },
                  { name: "north", positiveDirection: "northward" },
                  { name: "up", positiveDirection: "skyward" },
                ],
        },
        origin: coordinates,
        gravity: { kind: "constant-vector", vector: coordinates },
      },
    ],
  };
  const needsPin: VersionedTraitRef = {
    id: decodeOpaqueId("routine.needs", "TraitId"),
    version: 1,
  };
  const shelterPin: VersionedTraitRef = {
    id: decodeOpaqueId("routine.shelter", "TraitId"),
    version: 1,
  };
  const actorPin: VersionedArchetypeRef = {
    id: decodeOpaqueId(`${name}.resident`, "ArchetypeId"),
    version: 1,
  };
  const coverPin: VersionedArchetypeRef = {
    id: decodeOpaqueId(`${name}.cover`, "ArchetypeId"),
    version: 1,
  };
  const traits: TraitDefinition[] = [
    {
      ...needsPin,
      traits: [],
      components: map(
        snapshot("clockgrove.needs", {
          hunger: 3000,
          wetness: 0,
          integratedAt: zero,
          hungerRemainder: 0n,
          wetnessRemainder: 0n,
        }),
      ),
    },
    {
      ...shelterPin,
      traits: [],
      components: map(snapshot("clockgrove.weather-exposure", { rainProtection: 10000 })),
    },
  ];
  const archetypes: ArchetypeDefinition[] = [
    { ...actorPin, traits: [needsPin], components: {} },
    { ...coverPin, traits: [shelterPin], components: {} },
  ];
  const definitions = createDefinitionRegistry({
    archetypes: reverse ? [...archetypes].reverse() : archetypes,
    traits: reverse ? [...traits].reverse() : traits,
  });
  const declarations = [
    { id: name === "raccoon" ? "stevie" : "mae", archetype: actorPin, trait: needsPin },
    { id: "primary-cover", archetype: coverPin, trait: shelterPin },
    { id: "secondary-cover", archetype: coverPin, trait: shelterPin },
  ].map(({ id, archetype, trait }) => {
    const objectId = decodeOpaqueId(id, "ObjectId");
    const definition: WorldObjectDefinition = {
      id: objectId,
      worldId: base.worldId,
      archetype,
      traits: [],
      capabilities: [],
      overrides:
        id === "secondary-cover"
          ? [snapshot("clockgrove.weather-exposure", { rainProtection: 7500 })]
          : override && id === "primary-cover"
            ? [snapshot("clockgrove.weather-exposure", { rainProtection: 1000 })]
            : [],
    };
    const state: TimelineObjectState = {
      worldId: base.worldId,
      timelineId: base.timelineId,
      objectId,
      spaceId: decodeOpaqueId(`${name}-space`, "SpaceId"),
      lifecycleStatus: "active",
      revision: 0n,
      components: map(
        snapshot("clockgrove.identity", { objectId, displayName: id, aliases: [] }),
        snapshot("clockgrove.archetype", { archetype, traits: [trait] }),
        snapshot("clockgrove.spatial-transform", {
          spaceId: decodeOpaqueId(`${name}-space`, "SpaceId"),
          pose: { frameId, frameVersion: 1, coordinates },
        }),
      ),
    };
    return { definition, state, trait };
  });
  const sources = { archetypes, traits, declarations, base };
  const sourceCanonicalBefore = canonicalSerialize(sources);
  const objects = (reverse ? [...declarations].reverse() : declarations)
    .map(({ definition, state, trait }) =>
      resolveEffectiveObject({
        components,
        definitions,
        definition,
        state,
        context: {
          tenantId: base.tenantId,
          worldId: base.worldId,
          timelineId: base.timelineId,
          objectId: definition.id,
          simulationTime: zero,
          spatialFrames: base.spatialFrames,
          expectedArchetype: definition.archetype,
          expectedTraits: [trait],
        },
      }),
    )
    .sort((left, right) =>
      left.definition.id < right.definition.id
        ? -1
        : left.definition.id > right.definition.id
          ? 1
          : 0,
    );
  const scenario: WorldScenario = {
    initialState: projectEffectiveObjectsToWorldState(base, objects, components),
    pack: {
      schemaVersion: 1,
      packId: `clockgrove.component.${name}`,
      packVersion: "0.1.0",
      contentHash: "0".repeat(64),
      archetypes: [actorPin, coverPin].map((pin) => `${pin.id}@${pin.version}`),
      policy: {
        schemaVersion: 1,
        version: "rain-shelter@1",
        decisionIntervalMs: 60000n as SimTimeMs,
        hungerPerInterval: 400,
        wetnessPerInterval: 1200,
        dryingPerInterval: 600,
        hungerWeight: 1000,
        shelterWeight: 2500,
      },
    },
  };
  return {
    scenario,
    objects,
    canonicalObjects: objects.map(serializeEffectiveObject),
    sources,
    sourceCanonicalBefore,
  };
}
