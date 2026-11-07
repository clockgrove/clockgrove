import type {
  ComponentMap,
  ComponentRegistry,
  ComponentSnapshot,
  ComponentValidationContext,
} from "../components/registry/index.js";
import {
  CompositionError,
  canonicalSerialize,
  compareUtf16,
  immutableCopy,
} from "../components/registry/index.js";
import {
  compareRefs,
  componentMap,
  type DefinitionRegistry,
  exact,
  fail,
  name,
  positiveVersion,
  reference,
  references,
  refKey,
  resolutions,
} from "./definitions.js";
import type {
  EffectiveObject,
  TimelineObjectState,
  TraitDefinition,
  VersionedTraitRef,
  WorldObjectDefinition,
} from "./types.js";

export interface ResolveEffectiveObjectInput {
  readonly components: ComponentRegistry;
  readonly definitions: DefinitionRegistry;
  readonly definition: WorldObjectDefinition;
  readonly state: TimelineObjectState;
  readonly context: ComponentValidationContext;
}

/** Pure composition only: no implicit migration, installation, or physical mutation. */
export function resolveEffectiveObject(input: ResolveEffectiveObjectInput): EffectiveObject {
  let definition: WorldObjectDefinition;
  try {
    definition = immutableCopy(input.definition, "definition");
  } catch (error) {
    if (
      error instanceof CompositionError &&
      (error.path === "definition.overrides" || error.path.startsWith("definition.overrides."))
    )
      fail("INVALID_OVERRIDE", error.path, error.message);
    throw error;
  }
  const state = immutableCopy(input.state, "state");
  const context = immutableCopy(input.context, "context");
  objectShape(definition, state, context);
  const archetype = input.definitions.archetype(definition.archetype, "definition.archetype");
  const traits = new Map<string, TraitDefinition>();
  const visiting = new Set<string>();
  function visit(ref: VersionedTraitRef): void {
    const key = refKey(ref);
    const path = `traits[${key}]`;
    if (visiting.has(key)) fail("DEFINITION_CYCLE", path, "trait references form a cycle");
    if (traits.has(key)) return;
    const trait = input.definitions.trait(ref, path);
    visiting.add(key);
    for (const child of [...trait.traits].sort(compareRefs)) visit(child);
    visiting.delete(key);
    traits.set(key, trait);
  }
  for (const ref of [...archetype.traits, ...definition.traits].sort(compareRefs)) visit(ref);
  const orderedTraits = [...traits.values()].sort(compareRefs);
  const traitPins = orderedTraits.map(({ id, version }) => ({ id, version }));
  if (
    canonicalSerialize([...context.expectedTraits].sort(compareRefs)) !==
    canonicalSerialize(traitPins)
  )
    fail(
      "IDENTITY_SCOPE_MISMATCH",
      "context.expectedTraits",
      "expected pins must match all resolved traits",
    );

  const components: Record<string, ComponentSnapshot> = Object.create(null);
  function validateMap(values: ComponentMap, path: string): void {
    componentMap(values, path);
    for (const type of Object.keys(values).sort(compareUtf16))
      components[type] = input.components.validate(
        values[type]!,
        context,
        `${path}[${JSON.stringify(type)}]`,
      );
  }
  validateMap(archetype.components, "archetype.components");

  const writes = new Map<
    string,
    { writer: VersionedTraitRef; snapshot: ComponentSnapshot; canonical: string }[]
  >();
  for (const trait of orderedTraits) {
    for (const type of Object.keys(trait.components).sort(compareUtf16)) {
      const path = `traits[${refKey(trait)}].components[${JSON.stringify(type)}]`;
      const snapshot = input.components.validate(trait.components[type]!, context, path);
      const write = {
        writer: { id: trait.id, version: trait.version },
        snapshot,
        canonical: input.components.encode(snapshot, context, path),
      };
      const previous = writes.get(type) ?? [];
      previous.push(write);
      writes.set(type, previous);
    }
  }
  const declared: Record<string, VersionedTraitRef> = Object.assign(
    Object.create(null),
    archetype.conflictResolutions,
    definition.conflictResolutions,
  );
  for (const type of Object.keys(archetype.conflictResolutions ?? {}).sort(compareUtf16)) {
    const instance =
      definition.conflictResolutions && Object.hasOwn(definition.conflictResolutions, type)
        ? definition.conflictResolutions[type]
        : undefined;
    if (instance && refKey(instance) !== refKey(archetype.conflictResolutions![type]!))
      fail(
        "TRAIT_CONFLICT",
        `definition.conflictResolutions[${JSON.stringify(type)}]`,
        "cannot contradict an archetype's declared writer",
      );
  }
  for (const type of Object.keys(declared).sort(compareUtf16)) {
    const writer = declared[type]!;
    if (!writes.get(type)?.some((write) => refKey(write.writer) === refKey(writer)))
      fail(
        "TRAIT_CONFLICT",
        `conflictResolutions[${JSON.stringify(type)}]`,
        "resolution must name a participating pinned trait writer",
      );
  }
  for (const type of [...writes.keys()].sort(compareUtf16)) {
    const candidates = writes.get(type)!;
    const first = candidates[0]!;
    const resolution = declared[type];
    const selected = resolution
      ? candidates.find((write) => refKey(write.writer) === refKey(resolution))!
      : first;
    if (
      !resolution &&
      candidates.some(
        (write) =>
          write.snapshot.version !== first.snapshot.version || write.canonical !== first.canonical,
      )
    )
      fail(
        "TRAIT_CONFLICT",
        `traits.components[${JSON.stringify(type)}]`,
        "distinct pinned trait writes require an explicit writer resolution",
      );
    components[type] = selected.snapshot;
  }
  const overrides = [...definition.overrides].sort((left, right) =>
    compareUtf16(left.type, right.type),
  );
  const overridden = new Set<string>();
  for (const override of overrides) {
    const path = `definition.overrides[${JSON.stringify(override.type)}]`;
    if (overridden.has(override.type))
      fail("INVALID_OVERRIDE", path, "a component may be replaced only once");
    overridden.add(override.type);
    try {
      exact(override, ["type", "version", "state"], [], path);
      components[override.type] = input.components.validate(override, context, path);
    } catch (error) {
      if (error instanceof CompositionError) fail("INVALID_OVERRIDE", error.path, error.message);
      fail("INVALID_OVERRIDE", path, "invalid whole-component replacement");
    }
  }
  validateMap(state.components, "state.components");
  const finalMap = Object.fromEntries(
    Object.keys(components)
      .sort(compareUtf16)
      .map((type) => [type, components[type]!]),
  );
  return immutableCopy(
    {
      tenantId: context.tenantId,
      simulationTime: context.simulationTime,
      definition: {
        ...definition,
        traits: [...definition.traits].sort(compareRefs),
        overrides,
        capabilities: [...definition.capabilities].sort((left, right) =>
          compareUtf16(left.id, right.id),
        ),
      },
      traitPins,
      state: { ...state, components: finalMap },
    },
    "effectiveObject",
  );
}

/** Domain-owned type-preserving representation; deliberately independent of kernel encoding. */
export function serializeEffectiveObject(object: EffectiveObject): string {
  return canonicalSerialize({ type: "clockgrove.effective-object", version: 1, object });
}

function objectShape(
  definition: WorldObjectDefinition,
  state: TimelineObjectState,
  context: ComponentValidationContext,
): void {
  exact(
    definition,
    ["id", "worldId", "archetype", "traits", "overrides", "capabilities"],
    ["owner", "conflictResolutions"],
    "definition",
  );
  name(definition.id, "definition.id");
  name(definition.worldId, "definition.worldId");
  if (definition.owner !== undefined) name(definition.owner, "definition.owner");
  reference(definition.archetype, "definition.archetype");
  references(definition.traits, "definition.traits");
  if (!Array.isArray(definition.overrides))
    fail("INVALID_OVERRIDE", "definition.overrides", "expected whole-component replacements");
  definition.overrides.forEach((override, index) => {
    try {
      exact(override, ["type", "version", "state"], [], `definition.overrides[${index}]`);
      name(override.type, `definition.overrides[${index}].type`);
    } catch (error) {
      if (error instanceof CompositionError) fail("INVALID_OVERRIDE", error.path, error.message);
      throw error;
    }
  });
  if (definition.conflictResolutions !== undefined)
    resolutions(definition.conflictResolutions, "definition.conflictResolutions");
  if (!Array.isArray(definition.capabilities))
    fail("INVALID_STATE", "definition.capabilities", "expected capability declarations");
  const bindings = new Set<string>();
  for (const binding of definition.capabilities) {
    exact(binding, ["id", "capabilityId", "version"], [], "definition.capabilities");
    name(binding.id, "definition.capabilities.id");
    name(binding.capabilityId, "definition.capabilities.capabilityId");
    positiveVersion(binding.version, "definition.capabilities.version");
    if (bindings.has(binding.id))
      fail("INVALID_STATE", "definition.capabilities.id", "duplicate binding identity");
    bindings.add(binding.id);
  }
  exact(
    state,
    ["worldId", "timelineId", "objectId", "spaceId", "components", "lifecycleStatus", "revision"],
    ["containerId"],
    "state",
  );
  for (const key of ["worldId", "timelineId", "objectId", "spaceId"] as const)
    name(state[key], `state.${key}`);
  if (state.containerId !== undefined) {
    name(state.containerId, "state.containerId");
    if (state.containerId === state.objectId)
      fail("INVALID_STATE", "state.containerId", "object cannot contain itself");
  }
  if (!["active", "dormant", "retired", "dead"].includes(state.lifecycleStatus))
    fail("INVALID_STATE", "state.lifecycleStatus", "unknown lifecycle status");
  if (typeof state.revision !== "bigint" || state.revision < 0n)
    fail("INVALID_STATE", "state.revision", "expected nonnegative bigint revision");
  for (const key of ["tenantId", "worldId", "timelineId", "objectId"] as const)
    name(context[key], `context.${key}`);
  if (
    typeof context.simulationTime !== "bigint" ||
    context.simulationTime < 0n ||
    context.simulationTime > (1n << 63n) - 1n
  )
    fail(
      "INVALID_STATE",
      "context.simulationTime",
      "expected nonnegative signed-64-bit simulation milliseconds",
    );
  reference(context.expectedArchetype, "context.expectedArchetype");
  references(context.expectedTraits as readonly VersionedTraitRef[], "context.expectedTraits");
  if (!Array.isArray(context.spatialFrames))
    fail("INVALID_STATE", "context.spatialFrames", "expected spatial frames");
  for (const [path, matches] of [
    ["state.worldId", state.worldId === definition.worldId],
    ["state.objectId", state.objectId === definition.id],
    ["context.worldId", context.worldId === state.worldId],
    ["context.timelineId", context.timelineId === state.timelineId],
    ["context.objectId", context.objectId === state.objectId],
    [
      "context.expectedArchetype",
      refKey(context.expectedArchetype) === refKey(definition.archetype),
    ],
  ] as const)
    if (!matches)
      fail("IDENTITY_SCOPE_MISMATCH", path, "identity or scope does not match pinned object state");
}
