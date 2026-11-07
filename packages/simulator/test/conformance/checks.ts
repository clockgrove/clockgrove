import {
  buildWorldPack,
  decodeResource,
  encodeResource,
  validateWorldPack,
  type WorldPackBuild,
} from "@clockgrove/world-pack-sdk";
import { packPorts, ports } from "../../cli/ports.js";
import { previewSeedProjection, seedGenesis, verifyGenesisBundle } from "../../src/index.js";
import { type FixtureSource, reorderSource, sha256Hex } from "../fixtures/lamp-yard.js";
import { CHECKS, type ConformanceProblem, failCheck, throwIfProblems } from "./failure.js";
import { bytesEqual } from "./golden.js";
import type { LoadedPack } from "./pack-source.js";

type Rec = Record<string, any>;

export { packPorts, ports };

const BUILD_BYTE_FIELDS = [
  "artifact",
  "content",
  "resourceManifest",
  "assetManifest",
  "migrationSet",
] as const;

const REFERENCE_HASH_FIELDS = [
  "contentHash",
  "resourceManifestHash",
  "assetManifestHash",
  "migrationSetHash",
] as const;

const RESOURCE_FIELDS = [
  "archetypes",
  "traits",
  "spaces",
  "rules",
  "actors",
  "policies",
  "cognitiveSeeds",
  "assets",
  "migrations",
] as const;

/**
 * Author feedback for a refused pack: every manifest resource hash (and asset length) that differs
 * from the committed bytes, and the actual seed projection of the pack with those values corrected.
 * Information only; the check still fails.
 */
async function actualValues(pack: LoadedPack): Promise<string[]> {
  const manifest = structuredClone(pack.source.manifest) as Rec;
  const values: string[] = [];
  for (const field of RESOURCE_FIELDS) {
    const entries: unknown = manifest[field];
    if (!Array.isArray(entries)) continue;
    for (const [index, entry] of (entries as Rec[]).entries()) {
      const bytes = typeof entry?.path === "string" ? pack.source.resources[entry.path] : undefined;
      if (bytes === undefined) continue;
      const loc = `manifest.${field}[${index}]`;
      const sha256 = await sha256Hex(bytes);
      if (entry.sha256 !== sha256) values.push(`${loc}.sha256 (${entry.path}) ${sha256}`);
      entry.sha256 = sha256;
      if (field === "assets" && entry.byteLength !== bytes.byteLength) {
        values.push(`${loc}.byteLength (${entry.path}) ${bytes.byteLength}`);
        entry.byteLength = bytes.byteLength;
      }
    }
  }
  const recorded: unknown = manifest.expectedSeedProjectionHash;
  manifest.expectedSeedProjectionHash = "0".repeat(64);
  const preview = await previewSeedProjection({ ...pack.source, manifest }, ports);
  if (preview.ok && preview.value.actual !== recorded)
    values.push(`manifest.expectedSeedProjectionHash ${preview.value.actual}`);
  return values;
}

/** `validateWorldPack` and `buildWorldPack` with the simulator ports must both succeed. */
export async function checkValidateAndBuild(pack: LoadedPack): Promise<WorldPackBuild> {
  const validated = await validateWorldPack(pack.source, packPorts);
  if (!validated.ok) {
    const values = await actualValues(pack);
    return failCheck(
      pack.name,
      CHECKS.validateBuild,
      `validateWorldPack refused: ${validated.error.code} at ${validated.error.path}: ${validated.error.message}${
        values.length === 0 ? "" : `; actual values: ${values.join("; ")}`
      }`,
    );
  }
  const built = await buildWorldPack(pack.source, packPorts);
  if (!built.ok)
    return failCheck(
      pack.name,
      CHECKS.validateBuild,
      `buildWorldPack refused: ${built.error.code} at ${built.error.path}: ${built.error.message}`,
    );
  return built.value;
}

async function buildOf(pack: LoadedPack, label: string, source: unknown): Promise<WorldPackBuild> {
  const built = await buildWorldPack(source, packPorts);
  if (!built.ok)
    return failCheck(
      pack.name,
      CHECKS.reproducible,
      `the ${label} build refused: ${built.error.code} at ${built.error.path}`,
    );
  return built.value;
}

function compareBuilds(
  pack: LoadedPack,
  label: string,
  expected: WorldPackBuild,
  actual: WorldPackBuild,
  problems: ConformanceProblem[],
): void {
  for (const field of REFERENCE_HASH_FIELDS)
    if (expected.artifact[field] !== actual.artifact[field])
      problems.push({
        pack: pack.name,
        check: CHECKS.reproducible,
        detail: `${label}: artifact ${field} differs (${expected.artifact[field]} != ${actual.artifact[field]})`,
      });
  if (JSON.stringify(expected.artifact) !== JSON.stringify(actual.artifact))
    problems.push({
      pack: pack.name,
      check: CHECKS.reproducible,
      detail: `${label}: artifact references differ`,
    });
  for (const field of BUILD_BYTE_FIELDS)
    if (!bytesEqual(expected.bytes[field], actual.bytes[field]))
      problems.push({
        pack: pack.name,
        check: CHECKS.reproducible,
        detail: `${label}: artifact bytes "${field}" differ`,
      });
}

/** The same source twice and a reordered copy give identical artifact references and bytes. */
export async function checkReproducibleBuild(pack: LoadedPack): Promise<void> {
  const first = await buildOf(pack, "first", structuredClone(pack.source));
  const second = await buildOf(pack, "repeat", structuredClone(pack.source));
  const reordered = await buildOf(
    pack,
    "reordered",
    reorderSource(structuredClone(pack.source) as FixtureSource),
  );
  const problems: ConformanceProblem[] = [];
  compareBuilds(pack, "repeat build", first, second, problems);
  compareBuilds(pack, "reordered build", first, reordered, problems);
  throwIfProblems(problems);
}

function snapshotSource(source: FixtureSource): {
  manifest: Uint8Array;
  resources: Map<string, Uint8Array>;
} {
  return {
    manifest: encodeResource(source.manifest),
    resources: new Map(
      Object.entries(source.resources).map(([path, bytes]) => [path, bytes.slice()]),
    ),
  };
}

/** The artifact is frozen and not changeable by the caller; building leaves the source unchanged. */
export async function checkArtifactImmutability(pack: LoadedPack): Promise<void> {
  const problems: ConformanceProblem[] = [];
  const add = (detail: string) =>
    problems.push({ pack: pack.name, check: CHECKS.immutable, detail });
  const before = snapshotSource(pack.source);
  const built = await buildOf(pack, "immutability", pack.source);
  const after = snapshotSource(pack.source);
  if (!bytesEqual(before.manifest, after.manifest))
    add("building changed the loaded source manifest");
  if (before.resources.size !== after.resources.size)
    add("building changed the set of loaded resources");
  for (const [path, bytes] of before.resources) {
    const other = after.resources.get(path);
    if (other === undefined || !bytesEqual(bytes, other))
      add(`building changed loaded resource ${path}`);
  }

  for (const [label, value] of [
    ["build", built],
    ["artifact", built.artifact],
    ["bytes", built.bytes],
  ] as const)
    if (!Object.isFrozen(value)) add(`the built ${label} is not frozen`);
  const recorded = JSON.stringify(built.artifact);
  for (const field of REFERENCE_HASH_FIELDS) {
    try {
      (built.artifact as Rec)[field] = "0".repeat(64);
      add(`the caller could assign artifact.${field}`);
    } catch {
      // Assignment to a frozen object throws in strict mode: the expected outcome.
    }
  }
  try {
    (built.artifact as Rec).injected = true;
    add("the caller could add a field to the artifact");
  } catch {
    // Expected.
  }
  if (JSON.stringify(built.artifact) !== recorded)
    add("the artifact changed after caller mutation");

  const original = Object.fromEntries(
    BUILD_BYTE_FIELDS.map((field) => [field, built.bytes[field].slice()] as const),
  );
  for (const field of BUILD_BYTE_FIELDS) {
    const bytes = built.bytes[field];
    if (bytes.length > 0) bytes[0] = (bytes[0]! + 1) % 256;
  }
  const rebuilt = await buildOf(pack, "post-mutation", pack.source);
  for (const field of BUILD_BYTE_FIELDS)
    if (!bytesEqual(original[field]!, rebuilt.bytes[field]))
      add(`mutating returned bytes "${field}" changed a later build`);
  throwIfProblems(problems);
}

/** `seedGenesis` succeeds, the recorded seed projection equals the actual one, and the bundle verifies. */
export async function checkSeedGenesis(pack: LoadedPack, build: WorldPackBuild): Promise<void> {
  const recorded = pack.source.manifest.expectedSeedProjectionHash;
  const preview = await previewSeedProjection(pack.source, ports);
  if (!preview.ok)
    return failCheck(
      pack.name,
      CHECKS.seed,
      `previewSeedProjection refused: ${preview.error.code} at ${preview.error.path}`,
    );
  if (preview.value.actual !== recorded)
    return failCheck(
      pack.name,
      CHECKS.seed,
      `recorded expected seed projection ${String(recorded)} differs from the actual ${preview.value.actual}`,
    );
  const seeded = await seedGenesis({ artifact: build.artifact, source: pack.source }, ports);
  if (!seeded.ok)
    return failCheck(
      pack.name,
      CHECKS.seed,
      `seedGenesis refused: ${seeded.error.code} at ${seeded.error.path}: ${seeded.error.message}`,
    );
  const projection = seeded.value.bundle.seedProjection;
  if (projection.expected !== projection.actual || projection.actual !== recorded)
    return failCheck(
      pack.name,
      CHECKS.seed,
      `bundle seed projection expected ${projection.expected} actual ${projection.actual}`,
    );
  const verified = await verifyGenesisBundle(
    { bundle: seeded.value.bytes, artifact: build.artifact, source: pack.source },
    ports,
  );
  if (!verified.ok)
    return failCheck(
      pack.name,
      CHECKS.seed,
      `verifyGenesisBundle refused: ${verified.error.code} at ${verified.error.path}`,
    );
  if (verified.value.bundleHash !== seeded.value.bundle.bundleHash)
    return failCheck(
      pack.name,
      CHECKS.seed,
      "verified bundle hash differs from the seeded bundle hash",
    );
}

const CONVERSATIONAL_KINDS = new Set(["embodied-dialogue", "interpreted-perspective"]);
const keyOf = (ref: { id: string; version: number }): string => `${ref.id}@${ref.version}`;

/**
 * The component types an actor definition resolves to: the archetype, the actor's traits and every
 * trait they reference, plus the archetype's own components.
 */
function componentTypesOf(
  traits: Map<string, Rec>,
  archetypes: Map<string, Rec>,
  actor: Rec,
): Set<string> {
  const types = new Set<string>();
  const seen = new Set<string>();
  const visit = (document: Rec | undefined): void => {
    if (document === undefined) return;
    for (const type of Object.keys(document.components ?? {})) types.add(type);
    for (const ref of (document.traits ?? []) as { id: string; version: number }[]) {
      if (seen.has(keyOf(ref))) continue;
      seen.add(keyOf(ref));
      visit(traits.get(keyOf(ref)));
    }
  };
  visit(archetypes.get(keyOf(actor.archetype)));
  for (const ref of (actor.traits ?? []) as { id: string; version: number }[]) {
    if (seen.has(keyOf(ref))) continue;
    seen.add(keyOf(ref));
    visit(traits.get(keyOf(ref)));
  }
  for (const type of Object.keys(actor.components ?? {})) types.add(type);
  return types;
}

/** The pack supplies at least one of each element the engine contracts are written against. */
export async function checkContractCoverage(pack: LoadedPack): Promise<void> {
  const validated = await validateWorldPack(pack.source, packPorts);
  if (!validated.ok)
    return failCheck(
      pack.name,
      CHECKS.coverage,
      `the pack does not validate: ${validated.error.code} at ${validated.error.path}`,
    );
  const value = validated.value;
  const traits = new Map<string, Rec>(
    value.definitions.traits.map((trait): [string, Rec] => [keyOf(trait), trait as Rec]),
  );
  const archetypes = new Map<string, Rec>(
    value.definitions.archetypes.map((item): [string, Rec] => [keyOf(item), item as Rec]),
  );
  const capabilityKinds = new Map<string, string>(
    value.capabilities.map((item): [string, string] => [keyOf(item), item.kind]),
  );

  const missing: string[] = [];
  if (value.spaces.length === 0) missing.push("a space");
  let mobile = false;
  let conversational = false;
  let holder = false;
  let need = false;
  for (const actor of value.definitions.actors) {
    const types = componentTypesOf(traits, archetypes, actor as Rec);
    const placed = actor.placement !== null && actor.placement !== undefined;
    const needs = types.has("clockgrove.needs");
    if (needs) need = true;
    if (placed && needs) mobile = true;
    if (types.has("clockgrove.resource")) holder = true;
    if (
      placed &&
      !needs &&
      actor.capabilities.some((ref) =>
        CONVERSATIONAL_KINDS.has(capabilityKinds.get(keyOf(ref)) ?? ""),
      )
    )
      conversational = true;
  }
  for (const document of [...traits.values(), ...archetypes.values()])
    if ("clockgrove.needs" in (document.components ?? {})) need = true;
  if (!mobile) missing.push("a placed mobile subject with needs");
  if (!conversational)
    missing.push(
      "a stationary conversational object (a placed actor without needs bound to an embodied-dialogue or interpreted-perspective capability)",
    );
  if (!holder) missing.push("a resource holder");
  if (!need) missing.push("a need");

  let memory = false;
  for (const entry of value.cognitiveSeeds) {
    const bytes = pack.source.resources[entry.path];
    if (bytes === undefined) continue;
    const document = decodeResource(bytes, entry.path) as Rec;
    if (
      document?.type === "clockgrove.scripted-cognition" &&
      Array.isArray(document.entries) &&
      document.entries.some((item: Rec) => item?.kind === "memory")
    )
      memory = true;
  }
  if (!memory) missing.push("a scripted memory entry");
  if (value.rules.length === 0) missing.push("a rule");
  if (value.capabilities.length === 0) missing.push("a capability");
  if (missing.length > 0)
    failCheck(pack.name, CHECKS.coverage, `missing contract coverage: ${missing.join("; ")}`);
}

/** At least one scenario; scenario files and golden files pair one to one by name. */
export function checkScenarioGoldenLayout(pack: LoadedPack): void {
  const problems: ConformanceProblem[] = [];
  const add = (detail: string) => problems.push({ pack: pack.name, check: CHECKS.layout, detail });
  if (pack.scenarios.length === 0) add("the pack has no scenario under scenarios/");
  const goldens = new Set(pack.goldens.map((golden) => golden.name));
  const scenarios = new Set(pack.scenarios.map((scenario) => scenario.name));
  for (const scenario of pack.scenarios)
    if (!goldens.has(scenario.name)) add(`scenario ${scenario.name} has no golden`);
  for (const golden of pack.goldens)
    if (!scenarios.has(golden.name)) add(`golden ${golden.name} has no scenario`);
  for (const stray of pack.strayFiles)
    add(`unexpected entry ${stray}; only <name>.json files are allowed`);
  throwIfProblems(problems);
}

/** The ids of the pack's validated rules, for the rule-intent coverage check. */
export async function packRuleIds(pack: LoadedPack): Promise<string[]> {
  const validated = await validateWorldPack(pack.source, packPorts);
  return validated.ok ? validated.value.rules.map((rule) => rule.id) : [];
}
