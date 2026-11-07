import { decodeOpaqueId, type SimTimeMs } from "@clockgrove/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ArchetypeDefinition,
  createDefinitionRegistry,
  resolveEffectiveObject,
  serializeEffectiveObject,
  type TimelineObjectState,
  type TraitDefinition,
  type VersionedTraitRef,
  type WorldObjectDefinition,
} from "../../src/archetypes/index.js";
import {
  type ComponentRegistration,
  type ComponentSnapshot,
  type ComponentValidationContext,
  createCanonicalCodec,
  createComponentRegistry,
} from "../../src/components/registry/index.js";

const counterSchema = z.strictObject({ count: z.number().int().nonnegative(), time: z.bigint() });
type Counter = z.infer<typeof counterSchema>;
function counterRegistration(version = 1): ComponentRegistration<Counter> {
  return {
    type: "test.counter",
    version,
    schema: counterSchema,
    canonicalCodec: createCanonicalCodec("test.counter", version, counterSchema),
    validateState: (value, context) =>
      value.time > context.simulationTime
        ? [{ code: "INVALID_STATE", path: "time", message: "must not be in the future" }]
        : [],
    redact: (value, access) => (access.allowedCategories.includes("public_scene") ? value : null),
    upcasters: [],
  };
}
function snapshot(count: number, version = 1): ComponentSnapshot<Counter> {
  return { type: "test.counter", version, state: { count, time: 0n } };
}
function traitRef(id: string, version = 1): VersionedTraitRef {
  return { id: decodeOpaqueId(id, "TraitId"), version };
}
function trait(
  id: string,
  count: number,
  traits: readonly VersionedTraitRef[] = [],
): TraitDefinition {
  return { ...traitRef(id), traits, components: { "test.counter": snapshot(count) } };
}
function fixture(traits: readonly TraitDefinition[] = []) {
  const components = createComponentRegistry([counterRegistration()]);
  const archetype: ArchetypeDefinition = {
    id: decodeOpaqueId("example.archetype", "ArchetypeId"),
    version: 1,
    traits: [],
    components: { "test.counter": snapshot(1) },
  };
  const definitions = createDefinitionRegistry({ archetypes: [archetype], traits });
  const definition: WorldObjectDefinition = {
    id: decodeOpaqueId("object", "ObjectId"),
    worldId: decodeOpaqueId("world", "WorldId"),
    archetype: { id: archetype.id, version: 1 },
    traits: traits.map(({ id, version }) => ({ id, version })),
    overrides: [],
    capabilities: [],
  };
  const state: TimelineObjectState = {
    worldId: definition.worldId,
    objectId: definition.id,
    timelineId: decodeOpaqueId("timeline", "TimelineId"),
    spaceId: decodeOpaqueId("space", "SpaceId"),
    components: {},
    lifecycleStatus: "active",
    revision: 4n,
  };
  const context: ComponentValidationContext = {
    tenantId: decodeOpaqueId("tenant", "TenantId"),
    worldId: state.worldId,
    timelineId: state.timelineId,
    objectId: state.objectId,
    simulationTime: 5n as SimTimeMs,
    spatialFrames: [],
    expectedArchetype: definition.archetype,
    expectedTraits: definition.traits,
  };
  const input = { components, definitions, definition, state, context };
  return { ...input, archetype, input };
}

// The goldens compose every committed object; this keeps the hostile-input, conflict, cycle and ordering properties no pack reaches.
describe("object composition", () => {
  it("maps noncanonical override data to INVALID_OVERRIDE without accessing or freezing it", () => {
    const f = fixture();
    let invoked = false;
    const accessor = {
      get count() {
        invoked = true;
        throw new Error("must never run");
      },
      time: 0n,
    };
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const state of [
      { count: 1.5, time: 0n },
      { count: undefined, time: 0n },
      accessor,
      cycle,
    ]) {
      const definition = {
        ...f.definition,
        overrides: [{ type: "test.counter", version: 1, state }],
      };
      expect(() => resolveEffectiveObject({ ...f.input, definition })).toThrow(
        expect.objectContaining({ code: "INVALID_OVERRIDE" }),
      );
      expect(Object.isFrozen(state)).toBe(false);
    }
    expect(invoked).toBe(false);
  });

  it("detects self and indirect cycles before returning any output", () => {
    for (const traits of [
      [trait("self", 1, [traitRef("self")])],
      [trait("a", 1, [traitRef("b")]), trait("b", 1, [traitRef("a")])],
    ]) {
      const f = fixture(traits);
      expect(() => resolveEffectiveObject(f.input)).toThrow(
        expect.objectContaining({ code: "DEFINITION_CYCLE" }),
      );
    }
  });

  it("treats prototype member names as ordinary component keys, never implicit resolutions", () => {
    const f = fixture();
    const registration = counterRegistration();
    f.components.register({
      ...registration,
      type: "constructor",
      canonicalCodec: createCanonicalCodec("constructor", 1, counterSchema),
    });
    const write = { ...snapshot(2), type: "constructor" };
    f.definitions.registerTrait({
      ...traitRef("prototype"),
      traits: [],
      components: { constructor: write },
    });
    const definition = { ...f.definition, traits: [traitRef("prototype")] };
    const resolved = resolveEffectiveObject({
      ...f.input,
      definition,
      context: { ...f.context, expectedTraits: definition.traits },
    });
    expect(resolved.state.components.constructor).toEqual(write);
  });

  it("refuses conflicting writes even if an instance or timeline replacement would mask them", () => {
    const f = fixture([trait("a", 2), trait("b", 3)]);
    for (const input of [
      f.input,
      { ...f.input, definition: { ...f.definition, overrides: [snapshot(5)] } },
      { ...f.input, state: { ...f.state, components: { "test.counter": snapshot(6) } } },
    ])
      expect(() => resolveEffectiveObject(input)).toThrow(
        expect.objectContaining({
          code: "TRAIT_CONFLICT",
          path: 'traits.components["test.counter"]',
        }),
      );
  });

  it("produces equal canonical output across reference, registration and component insertion orders", () => {
    const alpha = trait("\ud800\udc00", 2);
    const omega = trait("\ue000", 2);
    const left = fixture([alpha, omega]);
    const right = fixture([omega, alpha]);
    right.definitions.registerArchetype({ ...right.archetype, version: 2 });
    expect(serializeEffectiveObject(resolveEffectiveObject(left.input))).toBe(
      serializeEffectiveObject(resolveEffectiveObject(right.input)),
    );
    expect(resolveEffectiveObject(left.input).traitPins.map((ref) => ref.id)).toEqual([
      alpha.id,
      omega.id,
    ]);
    const permuted = {
      ...left.input,
      definition: { ...left.definition, overrides: [snapshot(8)] },
      state: {
        ...left.state,
        components: {
          "test.counter": { state: { time: 0n, count: 9 }, version: 1, type: "test.counter" },
        },
      },
    };
    const ordered = {
      ...left.input,
      definition: { ...left.definition, overrides: [snapshot(8)] },
      state: { ...left.state, components: { "test.counter": snapshot(9) } },
    };
    expect(serializeEffectiveObject(resolveEffectiveObject(permuted))).toBe(
      serializeEffectiveObject(resolveEffectiveObject(ordered)),
    );
  });
});
