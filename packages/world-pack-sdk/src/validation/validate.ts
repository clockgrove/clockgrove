import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  type ArchetypeDefinition,
  CompositionError,
  createDefinitionRegistry,
  createInitialComponentRegistry,
  regionContains,
  resolveEffectiveObject,
  type TraitDefinition,
  type WorldBehaviorPolicy,
} from "@clockgrove/domain";
import { fail } from "../errors.js";
import { decodeResource } from "../manifest/encoding.js";
import {
  type ActorDefinitionDocument,
  type ActorLifecycleSeed,
  type ActorPlacement,
  type AssetEntry,
  BEHAVIOR_POLICY_TYPE,
  CLOCK_POLICY_TYPE,
  type ClockPolicy,
  NAMED_RANDOM_ALGORITHM,
  type RandomStreamEntry,
  type ResolvedDependency,
  type ResourceEntry,
  type TraitDefinitionDocument,
  type ValidatedWorldPack,
  WORLD_PACK_ENGINE_VERSION,
  WORLD_PACK_SCHEMA_VERSION,
  type WorldPackArtifactRef,
  type WorldPackPorts,
} from "../manifest/types.js";
import { upcastWorldPackManifest } from "../manifest/upcast.js";
import { checkMigrationChains, parseMigration } from "../migrations.js";
import {
  catalogOf,
  checkPlaceHierarchy,
  commandKey,
  deepFreeze,
  parseBehaviorPolicy,
  parseCapabilities,
  parseRule,
  parseSeedCommands,
  parseSpace,
} from "./collections.js";
import {
  array,
  compareText,
  exact,
  hash,
  identity,
  inRange,
  isRecord,
  nonNegativeInteger,
  positiveVersion,
  type Rec,
  range,
  resourcePath,
  semver,
  text,
} from "./shape.js";

const MAX_SIM_TIME = (1n << 63n) - 1n;
const MAX_RESOURCES = 256;
const MAX_RESOURCE_BYTES = 1_048_576;
const WALL_EPOCH =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/u;
const REVIEW_STATUS = ["approved", "pending", "rejected"];

const MANIFEST_FIELDS = [
  "schemaVersion",
  "id",
  "version",
  "engineCompatibility",
  "dependencies",
  "components",
  "archetypes",
  "traits",
  "spaces",
  "actors",
  "rules",
  "capabilities",
  "policies",
  "cognitiveSeeds",
  "randomStreams",
  "assets",
  "seedCommands",
  "migrations",
  "expectedSeedProjectionHash",
];
/** Schema 1 predates these collections; they must be declared as empty lists. */
const SCHEMA_1_EMPTY = ["spaces", "rules", "capabilities", "seedCommands", "migrations"];
const ARTIFACT_FIELDS = [
  "packId",
  "version",
  "contentHash",
  "engineCompatibility",
  "resourceManifestHash",
  "assetManifestHash",
  "migrationSetHash",
  "buildToolVersion",
];

interface Located<T> {
  readonly entry: T;
  readonly loc: string;
}
type Ref = { id: string; version: number };

/** Domain refusals keep their code and path, relocated under the owning manifest entry. */
function relocate<T>(loc: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof CompositionError)
      return fail(error.code, loc === "" ? error.path : `${loc}#${error.path}`, error.message);
    throw error;
  }
}

function artifactRef(value: unknown, path: string): WorldPackArtifactRef {
  const record = exact(value, ARTIFACT_FIELDS, [], path);
  semver(record.version, `${path}.version`);
  return {
    packId: identity(record.packId, `${path}.packId`),
    version: record.version as string,
    contentHash: hash(record.contentHash, `${path}.contentHash`),
    engineCompatibility: text(record.engineCompatibility, `${path}.engineCompatibility`),
    resourceManifestHash: hash(record.resourceManifestHash, `${path}.resourceManifestHash`),
    assetManifestHash: hash(record.assetManifestHash, `${path}.assetManifestHash`),
    migrationSetHash: hash(record.migrationSetHash, `${path}.migrationSetHash`),
    buildToolVersion: text(record.buildToolVersion, `${path}.buildToolVersion`),
  };
}

const NEW_ASSET_FIELDS = ["generation", "dimensions", "anchors", "footprint"];
const MAX_DIMENSION = 16384;
const MAX_FOOTPRINT = 256;
const MAX_ANCHORS = 64;

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail("INVALID_ASSET", path, `expected an integer from ${min} to ${max}`);
  return value;
}

/** Schema-2 asset metadata: generation provenance, dimensions, anchors and footprint. */
function assetMetadata(
  full: Rec,
  loc: string,
): Pick<AssetEntry, "generation" | "dimensions" | "anchors" | "footprint"> {
  let generation: AssetEntry["generation"] = null;
  if (full.generation !== null) {
    const path = `${loc}.generation`;
    const record = exact(
      full.generation,
      ["provider", "model", "parametersSha256"],
      [],
      path,
      "INVALID_PROVENANCE",
    );
    const parametersSha256 = record.parametersSha256;
    if (typeof parametersSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(parametersSha256))
      fail(
        "INVALID_PROVENANCE",
        `${path}.parametersSha256`,
        "expected lowercase hexadecimal SHA-256",
      );
    generation = {
      provider: text(record.provider, `${path}.provider`, "INVALID_PROVENANCE"),
      model: text(record.model, `${path}.model`, "INVALID_PROVENANCE"),
      parametersSha256: parametersSha256 as string,
    };
  }

  let dimensions: AssetEntry["dimensions"] = null;
  if (full.dimensions !== null) {
    const path = `${loc}.dimensions`;
    const record = exact(full.dimensions, ["width", "height"], [], path, "INVALID_ASSET");
    dimensions = {
      width: boundedInteger(record.width, `${path}.width`, 1, MAX_DIMENSION),
      height: boundedInteger(record.height, `${path}.height`, 1, MAX_DIMENSION),
    };
  }

  const anchorsPath = `${loc}.anchors`;
  if (!Array.isArray(full.anchors)) fail("INVALID_ASSET", anchorsPath, "expected an anchor list");
  const rawAnchors = full.anchors as unknown[];
  if (rawAnchors.length > MAX_ANCHORS) fail("LIMIT_EXCEEDED", anchorsPath, "too many anchors");
  if (rawAnchors.length > 0 && dimensions === null)
    fail("INVALID_ASSET", anchorsPath, "anchors require dimensions");
  const anchorNames = new Set<string>();
  const anchors = rawAnchors.map((raw, index) => {
    const path = `${anchorsPath}[${index}]`;
    const record = exact(raw, ["name", "x", "y"], [], path, "INVALID_ASSET");
    const name = text(record.name, `${path}.name`, "INVALID_ASSET");
    if (anchorNames.has(name)) fail("DUPLICATE_IDENTITY", `${path}.name`, "duplicate anchor name");
    anchorNames.add(name);
    return {
      name,
      x: boundedInteger(record.x, `${path}.x`, 0, dimensions!.width),
      y: boundedInteger(record.y, `${path}.y`, 0, dimensions!.height),
    };
  });

  let footprint: AssetEntry["footprint"] = null;
  if (full.footprint !== null) {
    const path = `${loc}.footprint`;
    const record = exact(full.footprint, ["width", "depth"], [], path, "INVALID_ASSET");
    footprint = {
      width: boundedInteger(record.width, `${path}.width`, 1, MAX_FOOTPRINT),
      depth: boundedInteger(record.depth, `${path}.depth`, 1, MAX_FOOTPRINT),
    };
  }
  return { generation, dimensions, anchors, footprint };
}

function parseRefs(
  manifest: Rec,
  field: string,
  withAsset: boolean,
  paths: Set<string>,
): Located<ResourceEntry & Partial<AssetEntry>>[] {
  const result: Located<ResourceEntry & Partial<AssetEntry>>[] = [];
  const identities = new Set<string>();
  array(manifest[field], `manifest.${field}`).forEach((raw, index) => {
    const loc = `manifest.${field}[${index}]`;
    const record = exact(
      raw,
      ["id", "version", "path", "sha256"],
      withAsset ? ["mediaType", "byteLength", "license", "provenance", ...NEW_ASSET_FIELDS] : [],
      loc,
    );
    const id = identity(record.id, `${loc}.id`);
    const version = positiveVersion(record.version, `${loc}.version`);
    if (identities.has(`${id}@${version}`))
      fail("DUPLICATE_IDENTITY", loc, "duplicate identity and version");
    identities.add(`${id}@${version}`);
    const path = resourcePath(record.path, `${loc}.path`);
    const sha256 = hash(record.sha256, `${loc}.sha256`);
    if (paths.has(path)) fail("DUPLICATE_IDENTITY", `${loc}.path`, "resource path used twice");
    paths.add(path);
    const entry: ResourceEntry & Partial<AssetEntry> = { id, version, path, sha256 };
    if (withAsset) {
      const full = exact(
        raw,
        [
          "id",
          "version",
          "path",
          "sha256",
          "mediaType",
          "byteLength",
          "license",
          "provenance",
          ...NEW_ASSET_FIELDS,
        ],
        [],
        loc,
      );
      const mediaType = text(full.mediaType, `${loc}.mediaType`, "INVALID_ASSET");
      if (!MEDIA_TYPE.test(mediaType)) fail("INVALID_ASSET", `${loc}.mediaType`, "bad media type");
      const byteLength = nonNegativeInteger(full.byteLength, `${loc}.byteLength`, "INVALID_ASSET");
      const license = text(full.license, `${loc}.license`, "INVALID_LICENSE");
      if (!LICENSE.test(license)) fail("INVALID_LICENSE", `${loc}.license`, "expected an SPDX id");
      const source = exact(
        full.provenance,
        ["source", "method", "reviewStatus"],
        [],
        `${loc}.provenance`,
        "INVALID_PROVENANCE",
      );
      const reviewStatus = text(
        source.reviewStatus,
        `${loc}.provenance.reviewStatus`,
        "INVALID_PROVENANCE",
      );
      if (!REVIEW_STATUS.includes(reviewStatus))
        fail("INVALID_PROVENANCE", `${loc}.provenance.reviewStatus`, "unknown review status");
      Object.assign(entry, {
        mediaType,
        byteLength,
        license,
        provenance: {
          source: text(source.source, `${loc}.provenance.source`, "INVALID_PROVENANCE"),
          method: text(source.method, `${loc}.provenance.method`, "INVALID_PROVENANCE"),
          reviewStatus,
        },
        ...assetMetadata(full, loc),
      });
    }
    result.push({ entry, loc });
  });
  return result;
}

function parseRandomStreams(manifest: Rec): RandomStreamEntry[] {
  const raw = array(manifest.randomStreams, "manifest.randomStreams");
  if (raw.length === 0)
    fail("MISSING_RANDOM_STREAM", "manifest.randomStreams", "explicit named streams required");
  const names = new Set<string>();
  const streams = raw.map((item, index): RandomStreamEntry => {
    const loc = `manifest.randomStreams[${index}]`;
    const record = exact(
      item,
      ["name", "algorithm", "algorithmVersion", "seed", "state", "draws"],
      [],
      loc,
    );
    const name = text(record.name, `${loc}.name`);
    if (names.has(name)) fail("DUPLICATE_IDENTITY", `${loc}.name`, "duplicate stream name");
    names.add(name);
    if (record.algorithm !== NAMED_RANDOM_ALGORITHM)
      fail("UNSUPPORTED_RANDOM_ALGORITHM", `${loc}.algorithm`, "unsupported algorithm");
    if (record.algorithmVersion !== 1)
      fail("UNSUPPORTED_RANDOM_ALGORITHM", `${loc}.algorithmVersion`, "unsupported version");
    const seed = text(record.seed, `${loc}.seed`, "INVALID_RANDOM_STREAM");
    const state = array(record.state, `${loc}.state`);
    const words = state.filter(
      (word): word is number =>
        typeof word === "number" &&
        Number.isInteger(word) &&
        word >= -2147483648 &&
        word <= 2147483647,
    );
    if (state.length !== 4 || words.length !== 4 || words.every((word) => word === 0))
      fail("INVALID_RANDOM_STREAM", `${loc}.state`, "expected four int32 words, not all zero");
    const draws = nonNegativeInteger(record.draws, `${loc}.draws`, "INVALID_RANDOM_STREAM");
    return {
      name,
      algorithm: NAMED_RANDOM_ALGORITHM,
      algorithmVersion: 1,
      seed,
      state: words,
      draws,
    };
  });
  return streams.sort((left, right) => compareText(left.name, right.name));
}

function parseClockPolicy(value: unknown, loc: string): ClockPolicy {
  const record = exact(
    value,
    [
      "type",
      "epoch",
      "wallEpoch",
      "simulationMillisecondsPerWallMillisecond",
      "decisionIntervalMs",
    ],
    [],
    loc,
    "MALFORMED_RESOURCE",
  );
  const bad = (field: string, message: string) =>
    fail("INVALID_CLOCK_POLICY", `${loc}.${field}`, message);
  const epoch = record.epoch;
  if (typeof epoch !== "bigint" || epoch < 0n || epoch > MAX_SIM_TIME)
    bad("epoch", "expected a nonnegative bigint simulation epoch");
  if (typeof record.wallEpoch !== "string" || !WALL_EPOCH.test(record.wallEpoch))
    bad("wallEpoch", "expected a UTC millisecond timestamp");
  const ratio = record.simulationMillisecondsPerWallMillisecond;
  if (typeof ratio !== "number" || !Number.isSafeInteger(ratio) || ratio < 1 || ratio > 1_000_000)
    bad("simulationMillisecondsPerWallMillisecond", "expected an integer ratio from 1 to 1000000");
  const interval = record.decisionIntervalMs;
  if (typeof interval !== "bigint" || interval < 1n || interval > MAX_SIM_TIME)
    bad("decisionIntervalMs", "expected a positive bigint interval");
  return {
    epoch: epoch as bigint,
    wallEpoch: record.wallEpoch as string,
    simulationMillisecondsPerWallMillisecond: ratio as number,
    decisionIntervalMs: interval as bigint,
  };
}

/** Resource-content arrays: any other shape is a malformed resource, never a thrown TypeError. */
function resourceList(value: unknown, loc: string): unknown[] {
  if (!Array.isArray(value)) return fail("MALFORMED_RESOURCE", loc, "expected an array");
  return value;
}

function refs(value: unknown, loc: string): Ref[] {
  return resourceList(value, loc).map((item, index) => {
    const record = exact(item, ["id", "version"], [], `${loc}[${index}]`, "MALFORMED_RESOURCE");
    return {
      id: text(record.id, `${loc}[${index}].id`, "MALFORMED_RESOURCE"),
      version: positiveVersion(record.version, `${loc}[${index}].version`),
    };
  });
}

function resourceIdentity(record: Rec, entry: ResourceEntry, loc: string): void {
  // Actor documents carry no version of their own: the manifest entry pins it.
  if (record.id !== entry.id || ("version" in record && record.version !== entry.version))
    fail("RESOURCE_IDENTITY_MISMATCH", `${loc}`, "resource id/version differ from the manifest");
}

function definition(decoded: unknown, entry: ResourceEntry, loc: string, archetype: boolean) {
  const record = exact(
    decoded,
    ["id", "version", "traits", "components"],
    archetype ? ["conflictResolutions"] : [],
    loc,
    "MALFORMED_RESOURCE",
  );
  resourceIdentity(record, entry, loc);
  const traits = refs(record.traits, `${loc}.traits`);
  if (!isRecord(record.components))
    fail("MALFORMED_RESOURCE", `${loc}.components`, "expected a component map");
  return { record, traits, components: record.components };
}

function closure(roots: readonly Ref[], traits: Map<string, readonly Ref[]>): Ref[] {
  const seen = new Map<string, Ref>();
  const pending = [...roots];
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    const key = JSON.stringify([ref.id, ref.version]);
    if (seen.has(key)) continue;
    seen.set(key, ref);
    pending.push(...(traits.get(key) ?? []));
  }
  return [...seen.values()].sort(
    (left, right) => compareText(left.id, right.id) || left.version - right.version,
  );
}

const byIdentity = (
  left: { id: string; version: number },
  right: { id: string; version: number },
) => compareText(left.id, right.id) || left.version - right.version;

/** A detached copy of a decoded trait or archetype document. */
function documentOf(record: Rec, entry: ResourceEntry): TraitDefinitionDocument {
  const copy = structuredClone(record) as unknown as TraitDefinitionDocument;
  return { ...copy, id: entry.id, version: entry.version };
}

/**
 * Validates complete source: manifest, actual resource bytes and supplied dependency
 * artifacts. Every refusal is a WorldPackError with a stable code and a source path.
 */
export async function validateWorldPackSource(
  input: unknown,
  ports: WorldPackPorts,
): Promise<ValidatedWorldPack> {
  const top = exact(input, ["manifest", "resources", "dependencyArtifacts"], [], "source");
  if (!isRecord(top.manifest)) return fail("MALFORMED_SOURCE", "manifest", "expected a record");
  const artifacts = array(top.dependencyArtifacts, "source.dependencyArtifacts").map(
    (item, index) => artifactRef(item, `source.dependencyArtifacts[${index}]`),
  );
  if (!isRecord(top.resources))
    return fail("MALFORMED_SOURCE", "source.resources", "expected a resource inventory");
  const resources = new Map<string, Uint8Array>();
  const names = Object.keys(top.resources).sort(compareText);
  if (names.length > MAX_RESOURCES)
    fail("LIMIT_EXCEEDED", "source.resources", "too many resources");
  for (const name of names) {
    const path = `resources[${JSON.stringify(name)}]`;
    resourcePath(name, path);
    const bytes = top.resources[name];
    if (!(bytes instanceof Uint8Array)) fail("MALFORMED_SOURCE", path, "expected resource bytes");
    if (bytes.byteLength > MAX_RESOURCE_BYTES)
      fail("LIMIT_EXCEEDED", path, "resource exceeds the byte limit");
    resources.set(name, bytes);
  }

  const original = exact(top.manifest, MANIFEST_FIELDS, [], "manifest");
  if (original.schemaVersion !== 1 && original.schemaVersion !== WORLD_PACK_SCHEMA_VERSION)
    fail("UNSUPPORTED_SCHEMA_VERSION", "manifest.schemaVersion", "only schema versions 1 and 2");
  if (original.schemaVersion === 1 && Array.isArray(original.assets))
    original.assets.forEach((asset: unknown, index: number) => {
      if (!isRecord(asset)) return;
      for (const key of NEW_ASSET_FIELDS)
        if (Object.hasOwn(asset, key))
          fail("UNKNOWN_FIELD", `manifest.assets[${index}].${key}`, "unknown field in schema 1");
    });
  const manifest = upcastWorldPackManifest(original);
  const id = identity(manifest.id, "manifest.id");
  const version = text(manifest.version, "manifest.version", "INVALID_VERSION");
  semver(version, "manifest.version");
  const engineCompatibility = text(
    manifest.engineCompatibility,
    "manifest.engineCompatibility",
    "INVALID_VERSION_RANGE",
  );
  if (
    !inRange(
      semver(WORLD_PACK_ENGINE_VERSION, "engine"),
      range(engineCompatibility, "manifest.engineCompatibility"),
    )
  )
    fail("ENGINE_INCOMPATIBLE", "manifest.engineCompatibility", "engine version is not accepted");

  const dependencies: ResolvedDependency[] = [];
  const dependencyIds = new Set<string>();
  array(manifest.dependencies, "manifest.dependencies").forEach((raw, index) => {
    const loc = `manifest.dependencies[${index}]`;
    const record = exact(raw, ["id", "versionRange"], [], loc);
    const dependencyId = identity(record.id, `${loc}.id`);
    const versionRange = text(record.versionRange, `${loc}.versionRange`, "INVALID_VERSION_RANGE");
    const bounds = range(versionRange, `${loc}.versionRange`);
    if (dependencyId === id)
      fail("DEPENDENCY_CYCLE", `${loc}.id`, "a pack cannot depend on itself");
    if (dependencyIds.has(dependencyId)) fail("DUPLICATE_IDENTITY", loc, "duplicate dependency");
    dependencyIds.add(dependencyId);
    const candidates = artifacts.filter((artifact) => artifact.packId === dependencyId);
    if (candidates.length === 0)
      fail("MISSING_DEPENDENCY", loc, "no artifact supplied for the dependency");
    const matches = candidates.filter((artifact) => inRange(semver(artifact.version, loc), bounds));
    if (matches.length === 0)
      fail("INCOMPATIBLE_DEPENDENCY", loc, "no supplied artifact satisfies the range");
    if (matches.length > 1)
      fail("AMBIGUOUS_DEPENDENCY", loc, "several supplied artifacts satisfy the range");
    const [match] = matches;
    dependencies.push({
      id: dependencyId,
      versionRange,
      version: match!.version,
      contentHash: match!.contentHash,
    });
  });
  dependencies.sort((left, right) => compareText(left.id, right.id));

  const componentRegistry = createInitialComponentRegistry();
  const declared = new Set<string>();
  const components = array(manifest.components, "manifest.components").map((raw, index) => {
    const loc = `manifest.components[${index}]`;
    const record = exact(raw, ["type", "version"], [], loc);
    const type = text(record.type, `${loc}.type`);
    const componentVersion = positiveVersion(record.version, `${loc}.version`);
    if (declared.has(type)) fail("DUPLICATE_IDENTITY", loc, "duplicate component declaration");
    declared.add(type);
    relocate("", () => componentRegistry.lookup(type, componentVersion, loc));
    return { type, version: componentVersion };
  });
  components.sort((left, right) => compareText(left.type, right.type));

  if (original.schemaVersion === 1)
    for (const field of SCHEMA_1_EMPTY) {
      const items = array(manifest[field], `manifest.${field}`);
      if (items.length > 0)
        fail(
          "UNSUPPORTED_CAPABILITY",
          `manifest.${field}[0]`,
          "not implemented by this checkpoint",
        );
    }
  const catalog = catalogOf(ports);
  const capabilities = parseCapabilities(manifest.capabilities, catalog);
  const capabilityKeys = new Set(capabilities.map((item) => commandKey(item.id, item.version)));
  const seedCommands = parseSeedCommands(manifest.seedCommands, catalog, ports);

  const claimed = new Set<string>();
  const archetypes = parseRefs(manifest, "archetypes", false, claimed);
  const traits = parseRefs(manifest, "traits", false, claimed);
  const spaces = parseRefs(manifest, "spaces", false, claimed);
  const rules = parseRefs(manifest, "rules", false, claimed);
  const actors = parseRefs(manifest, "actors", false, claimed);
  const policies = parseRefs(manifest, "policies", false, claimed);
  const cognitive = parseRefs(manifest, "cognitiveSeeds", false, claimed);
  const assets = parseRefs(manifest, "assets", true, claimed) as Located<AssetEntry>[];
  const migrationRefs = parseRefs(manifest, "migrations", false, claimed);
  const randomStreams = parseRandomStreams(manifest);
  const expected = hash(manifest.expectedSeedProjectionHash, "manifest.expectedSeedProjectionHash");

  const bytesOf = new Map<string, Uint8Array>();
  for (const { entry, loc } of [
    ...archetypes,
    ...traits,
    ...spaces,
    ...rules,
    ...actors,
    ...policies,
    ...cognitive,
    ...assets,
    ...migrationRefs,
  ]) {
    const bytes = resources.get(entry.path);
    if (bytes === undefined) fail("MISSING_RESOURCE", `${loc}.path`, "resource bytes not supplied");
    const actual = await ports.sha256(bytes);
    if (actual !== entry.sha256)
      fail(
        "HASH_MISMATCH",
        `${loc}.sha256`,
        `declared hash differs from the supplied bytes: expected ${entry.sha256}, actual ${actual}`,
      );
    if ("byteLength" in entry && entry.byteLength !== bytes.byteLength)
      fail(
        "ASSET_LENGTH_MISMATCH",
        `${loc}.byteLength`,
        `declared length differs: expected ${entry.byteLength}, actual ${bytes.byteLength}`,
      );
    bytesOf.set(entry.path, bytes);
  }
  for (const name of names)
    if (!claimed.has(name))
      fail("UNREFERENCED_RESOURCE", `resources[${JSON.stringify(name)}]`, "no manifest reference");

  const decode = ({ entry, loc }: Located<ResourceEntry>) =>
    decodeResource(bytesOf.get(entry.path)!, loc);

  const clocks: ClockPolicy[] = [];
  const behaviors: WorldBehaviorPolicy[] = [];
  policies.forEach((policy) => {
    const decoded = decode(policy);
    if (isRecord(decoded) && decoded.type === BEHAVIOR_POLICY_TYPE) {
      if (behaviors.length > 0)
        fail("DUPLICATE_POLICY", policy.loc, "at most one world behaviour policy");
      behaviors.push(parseBehaviorPolicy(decoded, id, version, policy.loc));
      return;
    }
    if (!isRecord(decoded) || decoded.type !== CLOCK_POLICY_TYPE)
      fail(
        "UNSUPPORTED_POLICY",
        policy.loc,
        `only ${CLOCK_POLICY_TYPE} and ${BEHAVIOR_POLICY_TYPE} policies are supported`,
      );
    if (clocks.length > 0) fail("DUPLICATE_CLOCK_POLICY", policy.loc, "exactly one clock policy");
    clocks.push(parseClockPolicy(decoded, policy.loc));
  });
  const behaviorPolicy = behaviors[0] ?? null;
  const [clockPolicy] = clocks;
  if (clockPolicy === undefined)
    return fail("MISSING_CLOCK_POLICY", "manifest.policies", "a clock policy is required");
  for (const seed of cognitive)
    if (!isRecord(decode(seed)))
      fail("MALFORMED_RESOURCE", seed.loc, "expected a cognitive seed record");

  const parsedSpaces = spaces
    .map((item) => ({ space: parseSpace(decode(item), item.entry, item.loc), loc: item.loc }))
    .sort((left, right) => byIdentity(left.space, right.space));
  checkPlaceHierarchy(parsedSpaces);
  const spaceEntries = parsedSpaces.map((item) => item.space);
  const spaceByKey = new Map(spaceEntries.map((item) => [commandKey(item.id, item.version), item]));
  const ruleList = rules
    .map((item) => ({
      rule: parseRule(decode(item), item.entry, item.loc, ports.commandCatalog),
      entry: item.entry,
    }))
    .sort(
      (left, right) =>
        compareText(left.rule.id, right.rule.id) || left.rule.version - right.rule.version,
    );

  const migrations = checkMigrationChains(
    migrationRefs.map((item) =>
      parseMigration(decode(item), item.entry, item.loc, version, catalog, ports),
    ),
    version,
  );

  const traitDefinitions = traits.map((trait) => ({
    ...definition(decode(trait), trait.entry, trait.loc, false),
    located: trait,
  }));
  const archetypeDefinitions = archetypes.map((item) => ({
    ...definition(decode(item), item.entry, item.loc, true),
    located: item,
  }));
  const actorDefinitions = actors.map((item) => {
    const record = exact(
      decode(item),
      ["id", "archetype", "traits", "overrides", "capabilities"],
      ["placement", "lifecycle"],
      item.loc,
      "MALFORMED_RESOURCE",
    );
    resourceIdentity(record, item.entry, item.loc);
    const archetype = exact(
      record.archetype,
      ["id", "version"],
      [],
      `${item.loc}.archetype`,
      "MALFORMED_RESOURCE",
    );
    const archetypeRef = {
      id: text(archetype.id, `${item.loc}.archetype.id`, "MALFORMED_RESOURCE"),
      version: positiveVersion(archetype.version, `${item.loc}.archetype.version`),
    };
    const traitRefs = refs(record.traits, `${item.loc}.traits`);
    const overrides = resourceList(record.overrides, `${item.loc}.overrides`);
    const bound = refs(record.capabilities, `${item.loc}.capabilities`);
    const boundKeys = new Set<string>();
    bound.forEach((ref, index) => {
      const key = commandKey(ref.id, ref.version);
      const at = `${item.loc}.capabilities[${index}]`;
      if (!capabilityKeys.has(key))
        fail("UNKNOWN_CAPABILITY", at, "capability is not declared in manifest.capabilities");
      if (boundKeys.has(key)) fail("DUPLICATE_IDENTITY", at, "capability bound twice");
      boundKeys.add(key);
    });
    let placement: ActorPlacement | null = null;
    if (Object.hasOwn(record, "placement")) {
      const at = `${item.loc}.placement`;
      const raw = exact(record.placement, ["space", "coordinates"], [], at, "MALFORMED_RESOURCE");
      const [spaceRef] = refs([raw.space], `${at}.space`);
      const space = spaceByKey.get(commandKey(spaceRef!.id, spaceRef!.version));
      if (space === undefined)
        fail("UNKNOWN_SPACE", `${at}.space`, "space is not declared in manifest.spaces");
      const coordinates = resourceList(raw.coordinates, `${at}.coordinates`);
      if (coordinates.length !== space.frame.dimensions)
        fail("INVALID_PLACEMENT", `${at}.coordinates`, "coordinate count differs from the frame");
      coordinates.forEach((coordinate, index) => {
        if (typeof coordinate !== "bigint")
          fail("INVALID_PLACEMENT", `${at}.coordinates[${index}]`, "expected a bigint");
      });
      if (
        space.regions.length > 0 &&
        !space.regions.some((region) => regionContains(region, coordinates as bigint[]))
      )
        fail(
          "INVALID_PLACEMENT",
          `${at}.coordinates`,
          "coordinates lie outside every region of the space",
        );
      placement = { space: spaceRef!, coordinates: coordinates as bigint[] };
    }
    let lifecycle: ActorLifecycleSeed | null = null;
    if (Object.hasOwn(record, "lifecycle")) {
      const at = `${item.loc}#lifecycle`;
      const raw = exact(
        record.lifecycle,
        ["householdId", "parentIds", "generation", "bornAt"],
        [],
        at,
        "MALFORMED_RESOURCE",
      );
      const householdId = text(raw.householdId, `${at}.householdId`, "MALFORMED_RESOURCE");
      if (!Array.isArray(raw.parentIds))
        fail("MALFORMED_RESOURCE", `${at}.parentIds`, "expected an array");
      const parentIds = raw.parentIds.map((parent: unknown) => {
        try {
          return decodeOpaqueId(parent as string, "ObjectId") as string;
        } catch {
          return fail("MALFORMED_RESOURCE", `${at}.parentIds`, "expected object ids");
        }
      });
      parentIds.forEach((parent, index) => {
        if (index > 0 && compareText(parentIds[index - 1]!, parent) >= 0)
          fail("MALFORMED_RESOURCE", `${at}.parentIds`, "expected sorted unique parent ids");
      });
      const generation = nonNegativeInteger(
        raw.generation,
        `${at}.generation`,
        "MALFORMED_RESOURCE",
      );
      if (typeof raw.bornAt !== "bigint" || raw.bornAt < 0n)
        fail("MALFORMED_RESOURCE", `${at}.bornAt`, "expected a nonnegative bigint");
      lifecycle = { householdId, parentIds, generation, bornAt: raw.bornAt };
    }
    return { located: item, archetypeRef, traitRefs, overrides, bound, placement, lifecycle };
  });

  for (const { components: map, located } of [...traitDefinitions, ...archetypeDefinitions])
    for (const type of Object.keys(map).sort(compareText))
      if (!declared.has(type))
        fail(
          "UNDECLARED_COMPONENT",
          `${located.loc}#components[${JSON.stringify(type)}]`,
          "component type is not declared in manifest.components",
        );
  for (const { located, overrides } of actorDefinitions)
    overrides.forEach((override, index) => {
      if (isRecord(override) && typeof override.type === "string" && !declared.has(override.type))
        fail(
          "UNDECLARED_COMPONENT",
          `${located.loc}#overrides[${index}].type`,
          "component type is not declared in manifest.components",
        );
    });

  const registry = createDefinitionRegistry();
  for (const item of traitDefinitions)
    relocate(item.located.loc, () =>
      registry.registerTrait(item.record as unknown as TraitDefinition),
    );
  for (const item of archetypeDefinitions)
    relocate(item.located.loc, () =>
      registry.registerArchetype(item.record as unknown as ArchetypeDefinition),
    );

  const traitEdges = new Map<string, readonly Ref[]>(
    traitDefinitions.map((item) => [
      JSON.stringify([item.located.entry.id, item.located.entry.version]),
      item.traits,
    ]),
  );
  const archetypeTraits = new Map<string, readonly Ref[]>(
    archetypeDefinitions.map((item) => [
      JSON.stringify([item.located.entry.id, item.located.entry.version]),
      item.traits,
    ]),
  );
  const probe = (
    loc: string,
    objectName: string,
    archetype: Ref,
    traitRefs: readonly Ref[],
    overrides: readonly unknown[],
  ) => {
    let objectId;
    try {
      objectId = decodeOpaqueId(objectName, "ObjectId");
    } catch {
      return fail("INVALID_IDENTITY", loc, "identity cannot be used as an object id");
    }
    const tenantId = decodeOpaqueId("pack-validation", "TenantId");
    const worldId = decodeOpaqueId("pack-validation-world", "WorldId");
    const timelineId = decodeOpaqueId("pack-validation-timeline", "TimelineId");
    const spaceId = decodeOpaqueId("pack-validation-space", "SpaceId");
    const roots = [
      ...(archetypeTraits.get(JSON.stringify([archetype.id, archetype.version])) ?? []),
      ...traitRefs,
    ];
    relocate(loc, () =>
      resolveEffectiveObject({
        components: componentRegistry,
        definitions: registry,
        definition: {
          id: objectId,
          worldId,
          archetype,
          traits: traitRefs,
          overrides,
          capabilities: [],
        },
        state: {
          worldId,
          timelineId,
          objectId,
          spaceId,
          components: {},
          lifecycleStatus: "active",
          revision: 0n,
        },
        context: {
          tenantId,
          worldId,
          timelineId,
          objectId,
          simulationTime: MAX_SIM_TIME,
          spatialFrames: [],
          expectedArchetype: archetype,
          expectedTraits: closure(roots, traitEdges),
        },
      } as unknown as Parameters<typeof resolveEffectiveObject>[0]),
    );
  };
  for (const item of archetypeDefinitions)
    probe(
      item.located.loc,
      "pack-validation-object",
      { id: item.located.entry.id, version: item.located.entry.version },
      [],
      [],
    );
  for (const item of actorDefinitions)
    probe(
      item.located.loc,
      item.located.entry.id,
      item.archetypeRef,
      item.traitRefs,
      item.overrides,
    );

  const entries = (list: Located<ResourceEntry>[]) =>
    list.map(({ entry }) => ({ ...entry })).sort(byIdentity);
  return {
    schemaVersion: 2,
    id,
    version,
    engineCompatibility,
    dependencies,
    components,
    archetypes: entries(archetypes),
    traits: entries(traits),
    actors: entries(actors),
    policies: entries(policies),
    cognitiveSeeds: entries(cognitive),
    assets: assets.map(({ entry }) => ({ ...entry })).sort(byIdentity),
    randomStreams,
    expectedSeedProjectionHash: expected,
    clockPolicy,
    spaces: spaceEntries,
    rules: ruleList.map((item) => item.rule),
    ruleEntries: ruleList.map((item) => ({ ...item.entry })),
    capabilities,
    seedCommands,
    behaviorPolicy,
    migrations,
    definitions: deepFreeze({
      traits: traitDefinitions
        .map((item) => documentOf(item.record, item.located.entry))
        .sort(byIdentity),
      archetypes: archetypeDefinitions
        .map((item) => documentOf(item.record, item.located.entry))
        .sort(byIdentity),
      actors: actorDefinitions
        .map(
          (item): ActorDefinitionDocument => ({
            id: item.located.entry.id,
            version: item.located.entry.version,
            archetype: item.archetypeRef,
            traits: item.traitRefs,
            overrides: item.overrides,
            capabilities: item.bound,
            placement: item.placement,
            lifecycle: item.lifecycle,
          }),
        )
        .sort(byIdentity),
    }),
  };
}
