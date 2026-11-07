import { DomainValidationError } from "../actor-process.js";
import type { FixedPoint } from "../spatial.js";

/** Fixed-point coordinates, extents, costs and speeds are bigint values with |value| <= this bound. */
export const FIXED_POINT_LIMIT = 1n << 47n;
/** Maximum simulation time accepted by spatial records and movement commands. */
export const SPATIAL_MAX_TIME = (1n << 63n) - 1n;

export function fail(path: string, message: string): never {
  throw new DomainValidationError(path, message);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Requires an exact-key plain record (no extra, missing or accessor fields). */
export function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value)) return fail(path, "must be a plain object");
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") return fail(path, "must not have symbol keys");
    if (!required.includes(key) && !optional.includes(key))
      return fail(`${path}.${key}`, "is not a permitted field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined)
      return fail(`${path}.${key}`, "must be a defined data property");
  }
  for (const key of required) if (!keys.includes(key)) return fail(`${path}.${key}`, "is required");
  return value;
}

export function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    return fail(path, "must be a nonempty name without outer whitespace");
  return value;
}

export function version(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    Object.is(value, -0)
  )
    return fail(path, "must be a positive safe integer");
  return value;
}

export function literal<T extends string | number>(value: unknown, path: string, expected: T): T {
  if (value !== expected) return fail(path, `must be ${String(expected)}`);
  return expected;
}

export function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    return fail(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** A bigint fixed-point scalar; numbers, strings and fractional values are never accepted. */
export function fixed(value: unknown, path: string, minimum = -FIXED_POINT_LIMIT): FixedPoint {
  if (typeof value !== "bigint") return fail(path, "must be a bigint fixed-point integer");
  if (value > FIXED_POINT_LIMIT || value < -FIXED_POINT_LIMIT)
    return fail(path, "is outside the fixed-point range");
  if (value < minimum)
    return fail(path, minimum >= 0n ? "must not be negative" : "is below its minimum");
  return value as FixedPoint;
}

export function positiveFixed(value: unknown, path: string): FixedPoint {
  const result = fixed(value, path, 0n);
  if (result === 0n) return fail(path, "must be positive");
  return result;
}

export function time(value: unknown, path: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > SPATIAL_MAX_TIME)
    return fail(path, "must be nonnegative signed-64-bit simulation milliseconds");
  return value;
}

export function list(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (value.length < minimum || value.length > maximum)
    return fail(path, `must contain ${minimum} through ${maximum} items`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return fail(path, "must be a dense plain array");
  return [...(value as unknown[])];
}

export function point(value: unknown, path: string, dimensions: 2 | 3): FixedPoint[] {
  return list(value, path, dimensions, dimensions).map((item, index) =>
    fixed(item, `${path}[${index}]`),
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Floor integer square root of a nonnegative bigint. */
export function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("square root of a negative value");
  if (value < 2n) return value;
  let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

/** Floor division (toward negative infinity) for a positive divisor. */
export function floorDiv(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError("divisor must be positive");
  const quotient = numerator / divisor;
  return numerator % divisor !== 0n && numerator < 0n ? quotient - 1n : quotient;
}

/** Ceiling division for a positive divisor. */
export function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  return -floorDiv(-numerator, divisor);
}

/** Round half up (toward positive infinity) of numerator / divisor with a positive divisor. */
export function roundDiv(numerator: bigint, divisor: bigint): bigint {
  return floorDiv(2n * numerator + divisor, 2n * divisor);
}
