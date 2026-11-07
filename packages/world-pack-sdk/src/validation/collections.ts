import { decodeOpaqueId } from "@clockgrove/contracts";
import {
  DomainValidationError,
  parseAnchorGraph,
  parseSpatialRegion,
  type RuleDefinition,
  RuleValidationError,
  type SpatialFrame,
  type SpatialRegion,
  semanticHierarchyIssues,
  shapeDimensions,
  validateRuleDefinition,
  validateSpatialFrame,
  validateWorldBehaviorPack,
  type WorldBehaviorPolicy,
} from "@clockgrove/domain";
import { fail } from "../errors.js";
import {
  CAPABILITY_KINDS,
  type CapabilityDefinition,
  type CapabilityKind,
  type ResourceEntry,
  type SeedCommand,
  type SpaceEntry,
  type WorldPackPorts,
} from "../manifest/types.js";
import {
  array,
  compareText,
  exact,
  identity,
  isRecord,
  positiveVersion,
  type Rec,
  text,
} from "./shape.js";

export const MAX_REGIONS = 64;
export const MAX_CAPABILITIES = 256;
export const MAX_CAPABILITY_COMMANDS = 64;
export const MAX_SEED_COMMANDS = 1024;
const MAX_PAYLOAD_DEPTH = 32;

export type Catalog = ReadonlySet<string>;

export const commandKey = (type: string, version: number) => JSON.stringify([type, version]);

export function catalogOf(ports: WorldPackPorts): Catalog {
  return new Set((ports.commandCatalog ?? []).map((item) => commandKey(item.type, item.version)));
}

/** The structured path of a domain validation error; empty for anything else. */
function domainPath(error: unknown): string {
  return error instanceof DomainValidationError ? error.path : "";
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Rec)[key]);
  }
  return value;
}

export { deepFreeze };

function listOf(value: unknown, loc: string): unknown[] {
  if (!Array.isArray(value)) return fail("MALFORMED_RESOURCE", loc, "expected an array");
  return value;
}

/** Spaces: frame, regions in that frame and an optional anchor graph, all domain-validated. */
export function parseSpace(decoded: unknown, entry: ResourceEntry, loc: string): SpaceEntry {
  const record = exact(
    decoded,
    ["id", "version", "frame", "regions", "anchorGraph"],
    ["parent"],
    loc,
    "MALFORMED_RESOURCE",
  );
  let parent = null;
  if (Object.hasOwn(record, "parent")) {
    const raw = exact(record.parent, ["id", "version"], [], `${loc}.parent`, "INVALID_SPACE");
    parent = {
      id: text(raw.id, `${loc}.parent.id`, "INVALID_SPACE"),
      version: positiveVersion(raw.version, `${loc}.parent.version`),
    };
  }
  if (record.id !== entry.id || record.version !== entry.version)
    fail("RESOURCE_IDENTITY_MISMATCH", loc, "resource id/version differ from the manifest");
  try {
    decodeOpaqueId(entry.id, "SpaceId");
  } catch {
    fail("INVALID_IDENTITY", loc, "identity cannot be used as a space id");
  }

  const framePath = `${loc}#frame`;
  exact(
    record.frame,
    ["frameId", "version", "dimensions", "unit", "axes", "origin", "gravity"],
    ["parentFrameId", "parentTransform"],
    framePath,
    "INVALID_SPACE",
  );
  const frame = record.frame as unknown as SpatialFrame;
  try {
    validateSpatialFrame(frame);
  } catch (error) {
    const sub = domainPath(error).replace(/^spatialFrame/u, "");
    fail(
      "INVALID_SPACE",
      `${framePath}${sub}`,
      error instanceof Error ? error.message : "invalid spatial frame",
    );
  }
  if (frame.dimensions !== 2 && frame.dimensions !== 3)
    fail("INVALID_SPACE", `${framePath}.dimensions`, "expected 2 or 3 dimensions");

  const rawRegions = listOf(record.regions, `${loc}#regions`);
  if (rawRegions.length > MAX_REGIONS)
    fail("LIMIT_EXCEEDED", `${loc}#regions`, `at most ${MAX_REGIONS} regions`);
  const regionIds = new Set<string>();
  const regions: SpatialRegion[] = rawRegions.map((raw, index) => {
    const path = `regions[${index}]`;
    let region: SpatialRegion;
    try {
      region = parseSpatialRegion(raw, path);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      fail("INVALID_SPACE", `${loc}#${domainPath(error) || path}`, error.message);
    }
    if (region.frameId !== frame.frameId || region.frameVersion !== frame.version)
      fail("INVALID_SPACE", `${loc}#${path}.frameId`, "region is not in the space frame");
    if (shapeDimensions(region.shape) !== frame.dimensions)
      fail("INVALID_SPACE", `${loc}#${path}.shape`, "region dimensions differ from the frame");
    if (regionIds.has(region.regionId))
      fail("DUPLICATE_IDENTITY", `${loc}#${path}.regionId`, "duplicate region id");
    regionIds.add(region.regionId);
    return region;
  });

  let anchorGraph = null;
  if (record.anchorGraph !== null) {
    try {
      anchorGraph = parseAnchorGraph(record.anchorGraph, "anchorGraph");
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      fail("INVALID_SPACE", `${loc}#${domainPath(error) || "anchorGraph"}`, error.message);
    }
    if (anchorGraph.frameId !== frame.frameId || anchorGraph.frameVersion !== frame.version)
      fail("INVALID_SPACE", `${loc}#anchorGraph.frameId`, "anchor graph is not in the space frame");
  }
  return deepFreeze({ ...entry, frame, regions, anchorGraph, parent });
}

/**
 * The pack's semantic place hierarchy (graph 5): every space `parent` names a space of the pack
 * and every region `parent` a region of the pack (any space), without cycles. Refusals are
 * `UNKNOWN_PARENT` at `<space>.parent` or `<space>#regions[j].parent.regionId|version`, and
 * `PARENT_CYCLE` at the first space or region on a cycle. World and timeline scope is checked
 * against the seeded world (`validateWorldState`), which a pack does not know.
 */
export function checkPlaceHierarchy(spaces: readonly { space: SpaceEntry; loc: string }[]): void {
  const spaceKey = (ref: { id: string; version: number }) => commandKey(ref.id, ref.version);
  const byKey = new Map(spaces.map((item) => [spaceKey(item.space), item.space]));
  for (const { space, loc } of spaces) {
    if (space.parent === null) continue;
    if (!byKey.has(spaceKey(space.parent)))
      fail("UNKNOWN_PARENT", `${loc}.parent`, "parent is not a space of the pack");
    const seen = new Set<string>();
    for (
      let next: SpaceEntry | undefined = space;
      next?.parent;
      next = byKey.get(spaceKey(next.parent))
    ) {
      if (seen.has(spaceKey(next))) {
        if (next === space)
          fail("PARENT_CYCLE", `${loc}.parent`, "the space hierarchy must be acyclic");
        break;
      }
      seen.add(spaceKey(next));
    }
  }
  const located = spaces.flatMap(({ space, loc }) =>
    space.regions.map((region, index) => ({ region, path: `${loc}#regions[${index}]` })),
  );
  const issue = semanticHierarchyIssues(
    located.map((item) => item.region),
    undefined,
    "regions",
  )[0];
  if (issue === undefined) return;
  const [, index, rest] = /^regions\[(\d+)\](.*)$/u.exec(issue.path)!;
  fail(
    issue.code === "parent-cycle" ? "PARENT_CYCLE" : "UNKNOWN_PARENT",
    `${located[Number(index)]!.path}${rest}`,
    issue.message,
  );
}

/** Rules: a domain RuleDefinition checked against the command catalog. */
export function parseRule(
  decoded: unknown,
  entry: ResourceEntry,
  loc: string,
  catalog: WorldPackPorts["commandCatalog"],
): RuleDefinition {
  let rule: RuleDefinition;
  try {
    rule = validateRuleDefinition(decoded, catalog ?? [], "rule");
  } catch (error) {
    if (error instanceof RuleValidationError)
      return fail("INVALID_RULE", `${loc}#${error.path}`, error.message);
    return fail("INVALID_RULE", `${loc}#rule`, "rule could not be read");
  }
  if (rule.id !== entry.id || rule.version !== entry.version)
    fail("RESOURCE_IDENTITY_MISMATCH", loc, "resource id/version differ from the manifest");
  return deepFreeze(rule);
}

export function parseCapabilities(value: unknown, catalog: Catalog): CapabilityDefinition[] {
  const items = array(value, "manifest.capabilities");
  if (items.length > MAX_CAPABILITIES)
    fail("LIMIT_EXCEEDED", "manifest.capabilities", `at most ${MAX_CAPABILITIES} capabilities`);
  const seen = new Set<string>();
  const result = items.map((raw, index): CapabilityDefinition => {
    const loc = `manifest.capabilities[${index}]`;
    const record = exact(raw, ["id", "version", "kind", "commands"], [], loc);
    const id = identity(record.id, `${loc}.id`);
    const version = positiveVersion(record.version, `${loc}.version`);
    if (
      typeof record.kind !== "string" ||
      !(CAPABILITY_KINDS as readonly string[]).includes(record.kind)
    )
      fail("INVALID_CAPABILITY", `${loc}.kind`, `expected one of ${CAPABILITY_KINDS.join(", ")}`);
    const commandList = array(record.commands, `${loc}.commands`);
    if (commandList.length > MAX_CAPABILITY_COMMANDS)
      fail("LIMIT_EXCEEDED", `${loc}.commands`, "too many commands");
    const commandKeys = new Set<string>();
    const commands = commandList.map((item, position) => {
      const at = `${loc}.commands[${position}]`;
      const command = exact(item, ["type", "version"], [], at);
      const type = text(command.type, `${at}.type`);
      const commandVersion = positiveVersion(command.version, `${at}.version`);
      const key = commandKey(type, commandVersion);
      if (!catalog.has(key)) fail("UNKNOWN_COMMAND", at, "command is not in the command catalog");
      if (commandKeys.has(key)) fail("DUPLICATE_IDENTITY", at, "duplicate capability command");
      commandKeys.add(key);
      return { type, version: commandVersion };
    });
    const identityKey = commandKey(id, version);
    if (seen.has(identityKey)) fail("DUPLICATE_IDENTITY", loc, "duplicate identity and version");
    seen.add(identityKey);
    commands.sort(
      (left, right) => compareText(left.type, right.type) || left.version - right.version,
    );
    return { id, version, kind: record.kind as CapabilityKind, commands };
  });
  result.sort((left, right) => compareText(left.id, right.id) || left.version - right.version);
  return deepFreeze(result);
}

export function plainData(value: unknown, depth: number): boolean {
  if (depth > MAX_PAYLOAD_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
  if (typeof value === "bigint") return true;
  if (Array.isArray(value)) return value.every((item) => plainData(item, depth + 1));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.keys(value).every((key) => plainData((value as Rec)[key], depth + 1));
  }
  return false;
}

export function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneData);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, cloneData((value as Rec)[key])]),
    );
  return value;
}

export function parseSeedCommands(
  value: unknown,
  catalog: Catalog,
  ports: WorldPackPorts,
): SeedCommand[] {
  const items = array(value, "manifest.seedCommands");
  if (items.length > MAX_SEED_COMMANDS)
    fail("LIMIT_EXCEEDED", "manifest.seedCommands", `at most ${MAX_SEED_COMMANDS} seed commands`);
  const keys = new Set<string>();
  const result = items.map((raw, index): SeedCommand => {
    const loc = `manifest.seedCommands[${index}]`;
    const record = exact(raw, ["key", "type", "version", "payload"], [], loc);
    const key = identity(record.key, `${loc}.key`);
    if (keys.has(key)) fail("DUPLICATE_IDENTITY", `${loc}.key`, "duplicate seed command key");
    keys.add(key);
    const type = text(record.type, `${loc}.type`);
    const version = positiveVersion(record.version, `${loc}.version`);
    if (!catalog.has(commandKey(type, version)))
      fail("UNKNOWN_COMMAND", `${loc}.type`, "command is not in the command catalog");
    if (!isRecord(record.payload) || !plainData(record.payload, 0))
      fail("INVALID_SEED_COMMAND", `${loc}.payload`, "expected a plain data record");
    try {
      ports.canonicalBytes(record.payload);
    } catch {
      fail("INVALID_SEED_COMMAND", `${loc}.payload`, "payload cannot be canonically encoded");
    }
    return {
      key,
      type,
      version,
      payload: deepFreeze(cloneData(record.payload)) as Readonly<Record<string, unknown>>,
    };
  });
  return deepFreeze(result);
}

/** A world behaviour policy resource: `{ type, policy }` validated by the domain. */
export function parseBehaviorPolicy(
  decoded: Rec,
  packId: string,
  packVersion: string,
  loc: string,
): WorldBehaviorPolicy {
  const record = exact(decoded, ["type", "policy"], [], loc, "MALFORMED_RESOURCE");
  if (!isRecord(record.policy)) fail("INVALID_POLICY", `${loc}#policy`, "expected a policy record");
  const policy = record.policy as unknown as WorldBehaviorPolicy;
  try {
    validateWorldBehaviorPack({
      schemaVersion: 1,
      packId,
      packVersion,
      contentHash: "0".repeat(64),
      archetypes: [packId],
      policy,
    });
  } catch (error) {
    fail(
      "INVALID_POLICY",
      `${loc}#${domainPath(error) || "policy"}`,
      error instanceof Error ? error.message : "invalid behaviour policy",
    );
  }
  return deepFreeze(policy);
}
