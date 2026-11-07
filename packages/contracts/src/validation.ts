export class ContractDecodeError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractDecodeError";
  }
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractDecodeError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContractDecodeError(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!(key in value)) throw new ContractDecodeError(`${path}.${key}`, "missing field");
  }
}

export function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractDecodeError(path, "expected a non-empty string");
  }
  return value;
}

export function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw new ContractDecodeError(path, "expected a safe integer");
  return value as number;
}

export function nonNegativeInteger(value: unknown, path: string): number {
  const decoded = integer(value, path);
  if (decoded < 0) throw new ContractDecodeError(path, "expected a non-negative integer");
  return decoded;
}

export function bigintValue(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  throw new ContractDecodeError(path, "expected a bigint or canonical decimal string");
}

export function literalVersion(value: unknown, expected: number, path: string): void {
  if (value !== expected) {
    throw new ContractDecodeError(path, `unsupported version; expected ${expected}`);
  }
}

export function optional<T>(
  owner: Record<string, unknown>,
  key: string,
  decode: (value: unknown, path: string) => T,
  path: string,
): T | undefined {
  if (!(key in owner)) return undefined;
  return decode(owner[key], `${path}.${key}`);
}

export function defined<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new ContractDecodeError(path, "missing field");
  return value;
}

export function array<T>(
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new ContractDecodeError(path, "expected an array");
  return Object.freeze(value.map((item, index) => decode(item, `${path}[${index}]`)));
}

export function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function literal<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  for (const choice of choices) if (value === choice) return choice;
  throw new ContractDecodeError(path, "unsupported discriminator");
}

export function unsignedDecimal(value: unknown, path: string): bigint {
  const result = bigintValue(value, path);
  if (result < 0n || (typeof value === "string" && result.toString() !== value))
    throw new ContractDecodeError(path, "expected canonical unsigned decimal");
  return result;
}

/** An RFC 3339 UTC timestamp with a real calendar date, kept in its supplied representation. */
export function utcTimestamp(value: unknown, path: string): string {
  const text = string(value, path);
  const seconds = text.slice(0, 19);
  const instant = Date.parse(`${seconds}Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(text) ||
    Number.isNaN(instant) ||
    new Date(instant).toISOString().slice(0, 19) !== seconds
  )
    throw new ContractDecodeError(path, "expected an RFC 3339 UTC timestamp");
  return text;
}

/** A fixed-width key whose string order is the order of decoded `utcTimestamp` instants, to the nanosecond. */
export function utcInstantKey(timestamp: string): string {
  return `${timestamp.slice(0, 19)}${timestamp.slice(20, -1).padEnd(9, "0")}`;
}

/** A W3C trace-context `traceparent`: no invalid version and no all-zero trace or parent ID. */
export function w3cTraceparent(value: unknown, path: string): string {
  const text = string(value, path);
  if (!/^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u.test(text))
    throw new ContractDecodeError(path, "expected a W3C traceparent");
  return text;
}
