import { fail } from "../errors.js";

export type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Exactly the listed keys: unknown fields first, then missing ones, in UTF-16 order. */
export function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  code = "MALFORMED_SOURCE",
): Rec {
  if (!isRecord(value)) return fail(code, path, "expected a record");
  for (const key of Object.keys(value).sort(compareText))
    if (!required.includes(key) && !optional.includes(key))
      fail("UNKNOWN_FIELD", `${path}.${key}`, "unknown field");
  for (const key of required)
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", `${path}.${key}`, "missing field");
  return value;
}

export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return fail("MALFORMED_SOURCE", path, "expected an array");
  return value;
}

export function text(value: unknown, path: string, code = "MALFORMED_SOURCE"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    return fail(code, path, "expected a nonempty string without outer whitespace");
  return value;
}

const IDENTITY = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;
export function identity(value: unknown, path: string): string {
  const id = text(value, path, "INVALID_IDENTITY");
  if (!IDENTITY.test(id)) return fail("INVALID_IDENTITY", path, "expected a namespaced identity");
  return id;
}

export function positiveVersion(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return fail("INVALID_VERSION", path, "expected an explicit positive integer version");
  return value;
}

export function nonNegativeInteger(value: unknown, path: string, code: string): number {
  const valid = typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!valid || Object.is(value, -0))
    return fail(code, path, "expected a nonnegative safe integer");
  return value as number;
}

const HASH = /^[a-f0-9]{64}$/u;
export function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value))
    return fail("INVALID_HASH", path, "expected lowercase hexadecimal SHA-256");
  return value;
}

const RESOURCE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
export function resourcePath(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 256 || !RESOURCE_PATH.test(value))
    return fail("INVALID_RESOURCE_PATH", path, "expected a relative normalized resource path");
  return value;
}

export type Semver = readonly [number, number, number];
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;
export function semver(value: unknown, path: string, code = "INVALID_VERSION"): Semver {
  const match = typeof value === "string" ? SEMVER.exec(value) : null;
  if (!match) return fail(code, path, "expected an explicit A.B.C version");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: Semver, right: Semver): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

const RANGE = /^>=(\S+) <(\S+)$/u;
export interface Range {
  readonly min: Semver;
  readonly max: Semver;
}
/** The only range form: ">=A.B.C <D.E.F". */
export function range(value: unknown, path: string): Range {
  const match = typeof value === "string" ? RANGE.exec(value) : null;
  if (!match) return fail("INVALID_VERSION_RANGE", path, 'expected ">=A.B.C <D.E.F"');
  return {
    min: semver(match[1], path, "INVALID_VERSION_RANGE"),
    max: semver(match[2], path, "INVALID_VERSION_RANGE"),
  };
}

export function inRange(version: Semver, bounds: Range): boolean {
  return compareSemver(version, bounds.min) >= 0 && compareSemver(version, bounds.max) < 0;
}
