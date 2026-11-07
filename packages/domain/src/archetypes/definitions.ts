import {
  type ComponentMap,
  CompositionError,
  compareUtf16,
  type DefinitionRef,
  immutableCopy,
} from "../components/registry/index.js";
import type { ArchetypeDefinition, TraitDefinition, VersionedTraitRef } from "./types.js";

export interface DefinitionRegistry {
  registerArchetype(definition: ArchetypeDefinition): void;
  registerTrait(definition: TraitDefinition): void;
  archetype(ref: DefinitionRef, path?: string): ArchetypeDefinition;
  trait(ref: DefinitionRef, path?: string): TraitDefinition;
}

export function createDefinitionRegistry(
  initial: {
    readonly archetypes?: readonly ArchetypeDefinition[];
    readonly traits?: readonly TraitDefinition[];
  } = {},
): DefinitionRegistry {
  const archetypes = new Map<string, Map<number, ArchetypeDefinition>>();
  const traits = new Map<string, Map<number, TraitDefinition>>();
  function register<T extends ArchetypeDefinition | TraitDefinition>(
    table: Map<string, Map<number, T>>,
    input: T,
    path: string,
  ): void {
    const value = immutableCopy(input, path);
    definitionShape(value, path, path === "archetype");
    let versions = table.get(value.id);
    if (versions?.has(value.version))
      fail("DUPLICATE_DEFINITION", path, "definition identity is already registered");
    if (!versions) {
      versions = new Map();
      table.set(value.id, versions);
    }
    versions.set(value.version, value);
  }
  function lookup<T>(table: Map<string, Map<number, T>>, ref: DefinitionRef, path: string): T {
    const ownedRef = immutableCopy(ref, path);
    reference(ownedRef, path);
    const value = table.get(ownedRef.id)?.get(ownedRef.version);
    if (!value) fail("MISSING_DEFINITION", path, "pinned definition is not registered");
    return value;
  }
  const registry: DefinitionRegistry = Object.freeze({
    registerArchetype: (value: ArchetypeDefinition) => register(archetypes, value, "archetype"),
    registerTrait: (value: TraitDefinition) => register(traits, value, "trait"),
    archetype: (ref: DefinitionRef, path = "archetype") => lookup(archetypes, ref, path),
    trait: (ref: DefinitionRef, path = "trait") => lookup(traits, ref, path),
  });
  const initialArchetypes = immutableCopy(initial.archetypes ?? [], "archetypes");
  const initialTraits = immutableCopy(initial.traits ?? [], "traits");
  if (!Array.isArray(initialArchetypes) || !Array.isArray(initialTraits))
    fail("INVALID_STATE", "definitions", "expected definition arrays");
  for (const value of initialArchetypes) definitionShape(value, "archetype", true);
  for (const value of initialTraits) definitionShape(value, "trait", false);
  for (const value of [...initialArchetypes].sort(compareRefs)) registry.registerArchetype(value);
  for (const value of [...initialTraits].sort(compareRefs)) registry.registerTrait(value);
  return registry;
}

function definitionShape(
  input: ArchetypeDefinition | TraitDefinition,
  path: string,
  archetype: boolean,
): void {
  exact(
    input,
    ["id", "version", "traits", "components"],
    archetype ? ["conflictResolutions"] : [],
    path,
  );
  name(input.id, `${path}.id`);
  positiveVersion(input.version, `${path}.version`);
  references(input.traits, `${path}.traits`);
  componentMap(input.components, `${path}.components`);
  if ("conflictResolutions" in input && input.conflictResolutions !== undefined)
    resolutions(input.conflictResolutions, `${path}.conflictResolutions`);
}

export function fail(code: string, path: string, message: string): never {
  throw new CompositionError(code, path, message);
}
export function name(input: unknown, path: string): asserts input is string {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input)
    fail("INVALID_STATE", path, "expected a nonempty identity without outer whitespace");
}
export function positiveVersion(input: unknown, path: string): asserts input is number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    fail("INVALID_STATE", path, "expected a positive safe-integer version");
}
export function exact(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("INVALID_STATE", path, "expected a record");
  for (const key of Object.keys(input).sort(compareUtf16))
    if (![...required, ...optional].includes(key))
      fail("INVALID_STATE", `${path}[${JSON.stringify(key)}]`, "unknown field");
  for (const key of required)
    if (!Object.hasOwn(input, key)) fail("INVALID_STATE", `${path}.${key}`, "missing field");
}
export function reference(input: DefinitionRef, path: string): void {
  exact(input, ["id", "version"], [], path);
  name(input.id, `${path}.id`);
  positiveVersion(input.version, `${path}.version`);
}
export function compareRefs(left: DefinitionRef, right: DefinitionRef): number {
  return compareUtf16(left.id, right.id) || left.version - right.version;
}
export function refKey(ref: DefinitionRef): string {
  return JSON.stringify([ref.id, ref.version]);
}
export function references(input: readonly VersionedTraitRef[], path: string): void {
  if (!Array.isArray(input)) fail("INVALID_STATE", path, "expected pinned trait references");
  input.forEach((ref, index) => reference(ref, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const ref of [...input].sort(compareRefs)) {
    if (seen.has(refKey(ref)))
      fail("DUPLICATE_DEFINITION", `${path}[${refKey(ref)}]`, "duplicate trait reference");
    seen.add(refKey(ref));
  }
}
export function componentMap(input: ComponentMap, path: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("INVALID_STATE", path, "expected a component map");
  for (const key of Object.keys(input).sort(compareUtf16)) {
    name(key, `${path}.key`);
    const snapshot = input[key]!;
    exact(snapshot, ["type", "version", "state"], [], `${path}[${JSON.stringify(key)}]`);
    if (snapshot.type !== key)
      fail(
        "INVALID_STATE",
        `${path}[${JSON.stringify(key)}].type`,
        "component key must match snapshot type",
      );
  }
}
export function resolutions(
  input: Readonly<Record<string, VersionedTraitRef>>,
  path: string,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("TRAIT_CONFLICT", path, "expected a pinned writer resolution map");
  for (const key of Object.keys(input).sort(compareUtf16)) {
    name(key, `${path}.key`);
    reference(input[key]!, `${path}[${JSON.stringify(key)}]`);
  }
}
