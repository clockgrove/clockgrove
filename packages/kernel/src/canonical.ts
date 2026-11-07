export const CANONICAL_ENCODING_VERSION = "clockgrove-canonical-v1";

/** Versioned, type-preserving JSON. Ordering is UTF-16 code-unit order, never locale order. */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify([CANONICAL_ENCODING_VERSION, encode(value, new Set())]);
}

/** SHA-256 consumers hash these exact UTF-8 bytes outside the pure kernel boundary. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalSerialize(value));
}

function encode(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return ["null"];
  switch (typeof value) {
    case "boolean":
      return ["boolean", value];
    case "string":
      return ["string", value];
    case "bigint":
      return ["bigint", value.toString()];
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError("canonical numbers must be safe integers, excluding negative zero");
      }
      return ["integer", value.toString()];
    case "object":
      break;
    default:
      throw new TypeError(`unsupported canonical value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonical values cannot contain cycles");
  ancestors.add(value);
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (prototype !== Array.prototype || keys.length !== value.length + 1) {
        throw new TypeError("canonical arrays must be dense plain arrays without extra properties");
      }
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(encode(dataProperty(value, String(index)), ancestors));
      }
      return ["array", items];
    }
    if (prototype === Map.prototype && value instanceof Map) {
      if (Reflect.ownKeys(value).length > 0) {
        throw new TypeError("canonical maps cannot have extra properties");
      }
      const entries = [...value.entries()].map(([key, item]: [unknown, unknown]) => {
        const encodedKey = encode(key, ancestors);
        return { key: JSON.stringify(encodedKey), entry: [encodedKey, encode(item, ancestors)] };
      });
      entries.sort((left, right) => compare(left.key, right.key));
      rejectDuplicates(
        entries.map(({ key }) => key),
        "map keys",
      );
      return ["map", entries.map(({ entry }) => entry)];
    }
    if (prototype === Set.prototype && value instanceof Set) {
      if (Reflect.ownKeys(value).length > 0) {
        throw new TypeError("canonical sets cannot have extra properties");
      }
      const entries = [...value.values()].map((item: unknown) => {
        const encoded = encode(item, ancestors);
        return { key: JSON.stringify(encoded), encoded };
      });
      entries.sort((left, right) => compare(left.key, right.key));
      rejectDuplicates(
        entries.map(({ key }) => key),
        "set members",
      );
      return ["set", entries.map(({ encoded }) => encoded)];
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical records must be plain objects");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("canonical records cannot have symbol keys");
    }
    return [
      "record",
      (keys as string[])
        .sort(compare)
        .map((key) => [key, encode(dataProperty(value, key), ancestors)]),
    ];
  } finally {
    ancestors.delete(value);
  }
}

function dataProperty(owner: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("canonical properties must be own enumerable data properties");
  }
  return descriptor.value as unknown;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectDuplicates(keys: readonly string[], kind: string): void {
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index] === keys[index - 1]) {
      throw new TypeError(`canonical ${kind} must have distinct encodings`);
    }
  }
}
