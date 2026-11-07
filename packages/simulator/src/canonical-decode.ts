import { CANONICAL_ENCODING_VERSION, canonicalBytes } from "@clockgrove/kernel";

class DecodeError extends Error {}

function fail(message: string): never {
  throw new DecodeError(message);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function decodeNode(node: unknown): unknown {
  if (!isArray(node) || node.length < 1 || typeof node[0] !== "string") fail("malformed node");
  const tag = node[0];
  if (tag === "null") {
    if (node.length !== 1) fail("malformed null");
    return null;
  }
  if (node.length !== 2) fail("malformed node");
  const body = node[1];
  switch (tag) {
    case "boolean":
      if (typeof body !== "boolean") fail("malformed boolean");
      return body;
    case "string":
      if (typeof body !== "string") fail("malformed string");
      return body;
    case "bigint":
      if (typeof body !== "string" || !/^-?\d+$/u.test(body)) fail("malformed bigint");
      return BigInt(body);
    case "integer": {
      if (typeof body !== "string" || !/^-?\d+$/u.test(body)) fail("malformed integer");
      const value = Number(body);
      if (!Number.isSafeInteger(value)) fail("integer out of range");
      return value;
    }
    case "array":
      if (!isArray(body)) fail("malformed array");
      return body.map(decodeNode);
    case "set":
      if (!isArray(body)) fail("malformed set");
      return new Set(body.map(decodeNode));
    case "map": {
      if (!isArray(body)) fail("malformed map");
      const map = new Map<unknown, unknown>();
      for (const entry of body) {
        if (!isArray(entry) || entry.length !== 2) fail("malformed map entry");
        map.set(decodeNode(entry[0]), decodeNode(entry[1]));
      }
      return map;
    }
    case "record": {
      if (!isArray(body)) fail("malformed record");
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const entry of body) {
        if (!isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
          fail("malformed record entry");
        Object.defineProperty(record, entry[0], {
          value: decodeNode(entry[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return record;
    }
    default:
      return fail("unknown tag");
  }
}

/** Whether two byte strings hold exactly the same bytes. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

/**
 * Strict decoder of kernel `canonicalBytes`. Returns `{ ok: false }` unless the bytes are valid UTF-8
 * and re-encoding the decoded value reproduces them exactly.
 */
export function decodeCanonicalBytes(
  bytes: Uint8Array,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isArray(parsed) || parsed.length !== 2 || parsed[0] !== CANONICAL_ENCODING_VERSION)
      return { ok: false };
    const value = decodeNode(parsed[1]);
    if (!bytesEqual(canonicalBytes(value), bytes)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
