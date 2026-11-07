import { fail } from "../errors.js";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      throw new TypeError("resource numbers must be safe integers");
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  throw new TypeError("unsupported resource value");
}

/** Compact key-sorted UTF-8 JSON; bigint values are written as {"$bigint":"n"}. */
export function encodeResource(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalize(value)));
}

const BIGINT_TEXT = /^(0|-?[1-9][0-9]*)$/u;

function revive(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      return fail("MALFORMED_RESOURCE", path, "resource numbers must be safe integers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => revive(item, path));
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const [first] = entries;
    if (entries.length === 1 && first?.[0] === "$bigint") {
      if (typeof first[1] !== "string" || !BIGINT_TEXT.test(first[1]))
        return fail("MALFORMED_RESOURCE", path, "invalid $bigint text");
      return BigInt(first[1]);
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, revive(item, path)]));
  }
  return fail("MALFORMED_RESOURCE", path, "unsupported resource value");
}

/** Strict inverse of encodeResource; every failure is a MALFORMED_RESOURCE at `path`. */
export function decodeResource(bytes: Uint8Array, path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("MALFORMED_RESOURCE", path, "resource is not valid UTF-8 JSON");
  }
  return revive(parsed, path);
}
