import { CANONICAL_ENCODING_VERSION, canonicalSerialize } from "@clockgrove/kernel";

/** A kernel canonical-encoding node: a tagged JSON array that preserves integer, bigint and key order. */
export type CanonicalNode = readonly unknown[];

export class CanonicalNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalNodeError";
  }
}

/** The tagged node of a value, exactly as `canonicalSerialize` encodes it (without the version wrapper). */
export function encodeCanonicalNode(value: unknown): CanonicalNode {
  const wrapper: unknown = JSON.parse(canonicalSerialize(value));
  if (
    !Array.isArray(wrapper) ||
    wrapper.length !== 2 ||
    wrapper[0] !== CANONICAL_ENCODING_VERSION
  ) {
    throw new CanonicalNodeError("canonical serialization produced an unexpected wrapper");
  }
  const node: unknown = wrapper[1];
  if (!Array.isArray(node))
    throw new CanonicalNodeError("canonical serialization produced no node");
  return node;
}

function fail(message: string): never {
  throw new CanonicalNodeError(message);
}

function integerText(body: unknown, what: string): string {
  if (typeof body !== "string" || !/^-?\d+$/u.test(body)) return fail(`malformed ${what}`);
  return body;
}

function entries(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) return fail(`malformed ${what}`);
  return body;
}

/** The value of a stored node. Records are null-prototype records, as the kernel encoder accepts. */
export function decodeCanonicalNode(node: unknown): unknown {
  if (!Array.isArray(node) || node.length < 1 || typeof node[0] !== "string") {
    return fail("malformed node");
  }
  const tag: string = node[0];
  if (tag === "null") {
    if (node.length !== 1) return fail("malformed null");
    return null;
  }
  if (node.length !== 2) return fail("malformed node");
  const body: unknown = node[1];
  switch (tag) {
    case "boolean":
      if (typeof body !== "boolean") return fail("malformed boolean");
      return body;
    case "string":
      if (typeof body !== "string") return fail("malformed string");
      return body;
    case "bigint":
      return BigInt(integerText(body, "bigint"));
    case "integer": {
      const value = Number(integerText(body, "integer"));
      if (!Number.isSafeInteger(value)) return fail("integer out of range");
      return value;
    }
    case "array":
      return entries(body, "array").map(decodeCanonicalNode);
    case "set":
      return new Set(entries(body, "set").map(decodeCanonicalNode));
    case "map": {
      const map = new Map<unknown, unknown>();
      for (const entry of entries(body, "map")) {
        if (!Array.isArray(entry) || entry.length !== 2) return fail("malformed map entry");
        map.set(decodeCanonicalNode(entry[0]), decodeCanonicalNode(entry[1]));
      }
      return map;
    }
    case "record": {
      const record: Record<string, unknown> = Object.create(null);
      for (const entry of entries(body, "record")) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          return fail("malformed record entry");
        }
        Object.defineProperty(record, entry[0], {
          value: decodeCanonicalNode(entry[1]),
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
