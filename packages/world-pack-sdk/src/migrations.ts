import { fail, WorldPackError, type WorldPackIssue } from "./errors.js";
import type {
  MigrationEntry,
  MigrationStep,
  PlannedMigrationStep,
  ResourceEntry,
  WorldPackPorts,
} from "./manifest/types.js";
import {
  type Catalog,
  cloneData,
  commandKey,
  deepFreeze,
  plainData,
} from "./validation/collections.js";
import {
  compareSemver,
  compareText,
  exact,
  identity,
  isRecord,
  positiveVersion,
  semver,
  text,
} from "./validation/shape.js";

export const MAX_MIGRATION_STEPS = 256;

/** Parses one migration resource document against its manifest entry. */
export function parseMigration(
  decoded: unknown,
  entry: ResourceEntry,
  loc: string,
  manifestVersion: string,
  catalog: Catalog,
  ports: WorldPackPorts,
): MigrationEntry {
  const record = exact(
    decoded,
    ["id", "version", "fromPackVersion", "toPackVersion", "steps"],
    [],
    loc,
    "MALFORMED_RESOURCE",
  );
  if (record.id !== entry.id || record.version !== entry.version)
    fail("RESOURCE_IDENTITY_MISMATCH", loc, "resource id/version differ from the manifest");
  const from = semver(record.fromPackVersion, `${loc}.fromPackVersion`);
  const to = semver(record.toPackVersion, `${loc}.toPackVersion`);
  if (compareSemver(from, to) >= 0)
    fail(
      "INVALID_MIGRATION",
      `${loc}.toPackVersion`,
      "fromPackVersion must be below toPackVersion",
    );
  if (compareSemver(to, semver(manifestVersion, "manifest.version")) > 0)
    fail("INVALID_MIGRATION", `${loc}.toPackVersion`, "toPackVersion is above the pack version");

  const stepsPath = `${loc}#steps`;
  if (!Array.isArray(record.steps))
    return fail("MALFORMED_RESOURCE", stepsPath, "expected an array");
  const raw: unknown[] = record.steps;
  if (raw.length === 0) fail("INVALID_MIGRATION", stepsPath, "at least one step is required");
  if (raw.length > MAX_MIGRATION_STEPS)
    fail("LIMIT_EXCEEDED", stepsPath, `at most ${MAX_MIGRATION_STEPS} steps`);
  const keys = new Set<string>();
  const steps = raw.map((item, index): MigrationStep => {
    const at = `${stepsPath}[${index}]`;
    const step = exact(item, ["key", "type", "version", "payload"], [], at, "MALFORMED_RESOURCE");
    const key = identity(step.key, `${at}.key`);
    if (keys.has(key)) fail("DUPLICATE_IDENTITY", `${at}.key`, "duplicate step key");
    keys.add(key);
    const type = text(step.type, `${at}.type`);
    const version = positiveVersion(step.version, `${at}.version`);
    if (!catalog.has(commandKey(type, version)))
      fail("UNKNOWN_COMMAND", `${at}.type`, "command is not in the command catalog");
    if (!isRecord(step.payload) || !plainData(step.payload, 0))
      fail("INVALID_MIGRATION", `${at}.payload`, "expected a plain data record");
    try {
      ports.canonicalBytes(step.payload);
    } catch {
      fail("INVALID_MIGRATION", `${at}.payload`, "payload cannot be canonically encoded");
    }
    return {
      key,
      type,
      version,
      payload: cloneData(step.payload) as Readonly<Record<string, unknown>>,
    };
  });
  return deepFreeze({
    ...entry,
    fromPackVersion: record.fromPackVersion as string,
    toPackVersion: record.toPackVersion as string,
    steps,
  });
}

/**
 * Chain rules over migrations in manifest order: one migration per origin version and every
 * destination is the pack version or another migration's origin. Returns them by origin.
 */
export function checkMigrationChains(
  migrations: readonly MigrationEntry[],
  manifestVersion: string,
): MigrationEntry[] {
  const origins = new Set<string>();
  migrations.forEach((item, index) => {
    if (origins.has(item.fromPackVersion))
      fail("AMBIGUOUS_MIGRATION", `manifest.migrations[${index}]`, "origin version used twice");
    origins.add(item.fromPackVersion);
  });
  migrations.forEach((item, index) => {
    if (item.toPackVersion !== manifestVersion && !origins.has(item.toPackVersion))
      fail(
        "MIGRATION_GAP",
        `manifest.migrations[${index}].toPackVersion`,
        "destination is neither the pack version nor another migration's origin",
      );
  });
  return [...migrations].sort(
    (left, right) =>
      compareSemver(semver(left.fromPackVersion, ""), semver(right.fromPackVersion, "")) ||
      compareText(left.id, right.id),
  );
}

/** The canonical, normalized migration-set entries. */
export const migrationSetEntries = (migrations: readonly MigrationEntry[]) =>
  migrations.map((item) => ({
    id: item.id,
    version: item.version,
    path: item.path,
    sha256: item.sha256,
    fromPackVersion: item.fromPackVersion,
    toPackVersion: item.toPackVersion,
    steps: item.steps.map((step) => ({
      key: step.key,
      type: step.type,
      version: step.version,
      payload: step.payload,
    })),
  }));

export type MigrationPlanResult =
  | { readonly ok: true; readonly value: readonly PlannedMigrationStep[] }
  | { readonly ok: false; readonly error: WorldPackIssue };

function chainOf(pack: unknown, from: string): readonly MigrationEntry[] {
  if (!isRecord(pack) || typeof pack.version !== "string" || !Array.isArray(pack.migrations))
    return fail("MALFORMED_SOURCE", "pack", "expected a validated world pack");
  const migrations = pack.migrations as MigrationEntry[];
  const byOrigin = new Map(migrations.map((item) => [item.fromPackVersion, item]));
  const chain: MigrationEntry[] = [];
  let at = from;
  if (at !== pack.version && !byOrigin.has(at))
    return fail("UNSUPPORTED_MIGRATION", "fromPackVersion", "no migration starts at this version");
  while (at !== pack.version) {
    const next = byOrigin.get(at);
    if (next === undefined || chain.length > migrations.length)
      return fail("UNSUPPORTED_MIGRATION", "fromPackVersion", "the chain does not reach the pack");
    chain.push(next);
    at = next.toPackVersion;
  }
  return chain;
}

/**
 * Pure, total and frozen: the ordered steps still to apply when `completedSteps` of the full
 * chain from `fromPackVersion` to the pack version are already done.
 */
export function planWorldPackMigration(
  pack: unknown,
  fromPackVersion: unknown,
  completedSteps: unknown,
): MigrationPlanResult {
  try {
    if (typeof fromPackVersion !== "string")
      return fail("UNSUPPORTED_MIGRATION", "fromPackVersion", "expected a version string");
    const chain = chainOf(pack, fromPackVersion);
    const all: PlannedMigrationStep[] = chain.flatMap((item) =>
      item.steps.map((step) => ({
        stepId: `${item.id}@${item.version}/${step.key}`,
        fromPackVersion: item.fromPackVersion,
        toPackVersion: item.toPackVersion,
        type: step.type,
        version: step.version,
        payload: cloneData(step.payload) as Readonly<Record<string, unknown>>,
      })),
    );
    if (
      typeof completedSteps !== "number" ||
      !Number.isSafeInteger(completedSteps) ||
      completedSteps < 0 ||
      completedSteps > all.length
    )
      return fail(
        "INVALID_MIGRATION_CURSOR",
        "completedSteps",
        `expected an integer from 0 to ${all.length}`,
      );
    return { ok: true, value: deepFreeze(all.slice(completedSteps)) };
  } catch (error) {
    if (error instanceof WorldPackError)
      return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
    return {
      ok: false,
      error: { code: "MALFORMED_SOURCE", path: "pack", message: "pack could not be read" },
    };
  }
}
