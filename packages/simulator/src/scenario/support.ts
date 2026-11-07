import { canonicalSerialize } from "@clockgrove/kernel";

/** A malformed-input refusal; anything else thrown inside the runner is an internal defect. */
export class ScenarioRefusal extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export function refuse(code: string, path: string, message: string): never {
  throw new ScenarioRefusal(code, path, message);
}

export type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deep copy into plain objects and arrays (null-prototype records become ordinary records). */
export function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePlain(item as unknown)) as T;
  if (isRecord(value)) {
    const copy: Rec = {};
    for (const key of Object.keys(value)) copy[key] = clonePlain(value[key]);
    return copy as T;
  }
  return value;
}

/** Canonical-safe deep copy: plain objects and arrays only, properties holding `undefined` are dropped. */
export function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => plain(item as unknown)) as T;
  if (isRecord(value)) {
    const copy: Rec = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) copy[key] = plain(item);
    }
    return copy as T;
  }
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value)) {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Whether `value` is one of the listed strings. */
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

export const canon = (value: unknown): string => canonicalSerialize(value);

export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Reads `path` (object keys and array indices) from `root`; `found` is false when a step is missing. */
export type PathSegment = string | number | { readonly key: string; readonly equals: unknown };

export function readPath(
  root: unknown,
  path: readonly PathSegment[],
): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length)
        return { found: false, value: null };
      current = current[segment];
    } else if (typeof segment === "string") {
      if (!isRecord(current) || !Object.hasOwn(current, segment))
        return { found: false, value: null };
      current = current[segment];
    } else {
      if (!Array.isArray(current)) return { found: false, value: null };
      const wanted = canon(segment.equals);
      const hit: unknown = current.find(
        (item) =>
          isRecord(item) && Object.hasOwn(item, segment.key) && canon(item[segment.key]) === wanted,
      );
      if (hit === undefined) return { found: false, value: null };
      current = hit;
    }
  }
  return { found: true, value: current };
}

/** Copy of `root` without the value at `path` (object keys and array indices only). */
export function withoutPath(root: unknown, path: readonly (string | number)[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return root;
  if (typeof head === "number") {
    if (!Array.isArray(root) || head >= root.length) return root;
    const items = [...root] as unknown[];
    if (rest.length === 0) items.splice(head, 1);
    else items[head] = withoutPath(items[head], rest);
    return items;
  }
  if (!isRecord(root) || !Object.hasOwn(root, head)) return root;
  const copy: Rec = { ...root };
  if (rest.length === 0) delete copy[head];
  else copy[head] = withoutPath(copy[head], rest);
  return copy;
}
