import type {
  PartitionId,
  PrivacyCeiling,
  SimTimeMs,
  TenantId,
  TimelineId,
  WorldId,
  WorldObjectId,
} from "@clockgrove/contracts";
import type { ZodType } from "zod";
import { DomainValidationError } from "../../actor-process.js";
import type { SpatialFrame } from "../../spatial.js";

export interface DefinitionRef {
  readonly id: string;
  readonly version: number;
}
export interface DomainIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type AccessPolicy = PrivacyCeiling;
export interface ComponentValidationContext {
  readonly tenantId: TenantId;
  readonly worldId: WorldId;
  readonly timelineId: TimelineId;
  readonly objectId: WorldObjectId;
  readonly partitionId?: PartitionId;
  readonly simulationTime: SimTimeMs;
  readonly spatialFrames: readonly SpatialFrame[];
  readonly expectedArchetype: DefinitionRef;
  readonly expectedTraits: readonly DefinitionRef[];
}
export interface ComponentSnapshot<T = unknown> {
  readonly type: string;
  readonly version: number;
  readonly state: T;
}
export type ComponentMap = Readonly<Record<string, ComponentSnapshot>>;
export interface CanonicalCodec<T> {
  encode(value: T): string;
  decode(canonical: string): T;
}
export interface ComponentUpcaster {
  readonly fromVersion: number;
  readonly toVersion: number;
  upcast(value: unknown): unknown;
}
export interface ComponentRegistration<T> {
  readonly type: string;
  readonly version: number;
  readonly schema: ZodType<T>;
  readonly canonicalCodec: CanonicalCodec<T>;
  validateState(value: T, context: ComponentValidationContext): DomainIssue[];
  redact(value: T, access: AccessPolicy): unknown;
  readonly upcasters: readonly ComponentUpcaster[];
}
export class CompositionError extends DomainValidationError {
  constructor(
    readonly code: string,
    path: string,
    message: string,
  ) {
    super(path, message);
    this.name = "CompositionError";
    this.message = message;
  }
}
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function fail(path: string, message: string): never {
  throw new CompositionError("INVALID_STATE", path, message);
}

/** Copies only canonical plain data. No caller-owned object is frozen. */
export function immutableCopy<T>(value: T, path = "value"): T {
  const ancestors = new Set<object>();
  function copy(input: unknown, current: string): unknown {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean" ||
      typeof input === "bigint"
    )
      return input;
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || Object.is(input, -0))
        fail(current, "noncanonical number");
      return input;
    }
    if (typeof input !== "object") fail(current, "unsupported canonical value");
    if (ancestors.has(input)) fail(current, "cyclic value");
    const isArray = Array.isArray(input);
    if (
      !isArray &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      fail(current, "expected plain data");
    if (Object.getOwnPropertySymbols(input).length) fail(current, "symbol keys are unsupported");
    ancestors.add(input);
    const output: Record<string, unknown> | unknown[] = isArray ? [] : {};
    const keys = Object.getOwnPropertyNames(input)
      .filter((key) => !(isArray && key === "length"))
      .sort(compareUtf16);
    if (
      isArray &&
      (keys.length !== input.length ||
        keys.some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length))
    )
      fail(current, "expected dense array");
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        fail(`${current}.${key}`, "expected enumerable data property");
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, `${current}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(input);
    return Object.freeze(output);
  }
  return copy(value, path) as T;
}

// Every node has an explicit tag, so ordinary strings and bigint text never collide.
function node(value: unknown): unknown {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array", value.map(node)];
  if (typeof value === "object")
    return [
      "object",
      Object.keys(value)
        .sort(compareUtf16)
        .map((key) => [key, node((value as Record<string, unknown>)[key])]),
    ];
  return [typeof value, typeof value === "bigint" ? value.toString() : value];
}
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify({ version: 1, value: node(immutableCopy(value)) });
}
function restore(value: unknown): unknown {
  if (!Array.isArray(value)) fail("canonical", "invalid canonical node");
  const [tag, data] = value;
  if (tag === "null" && value.length === 1) return null;
  if (value.length !== 2) fail("canonical", "invalid canonical node");
  if (tag === "bigint" && typeof data === "string" && /^(0|-?[1-9][0-9]*)$/.test(data))
    return BigInt(data);
  if (
    (tag === "string" && typeof data === "string") ||
    (tag === "boolean" && typeof data === "boolean") ||
    (tag === "number" && typeof data === "number")
  )
    return data;
  if (tag === "array" && Array.isArray(data)) return data.map(restore);
  if (tag === "object" && Array.isArray(data)) {
    const result: Record<string, unknown> = {};
    for (const pair of data) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        Object.hasOwn(result, pair[0])
      )
        fail("canonical", "invalid object entry");
      Object.defineProperty(result, pair[0], { value: restore(pair[1]), enumerable: true });
    }
    return result;
  }
  return fail("canonical", "invalid canonical tag");
}
export function createCanonicalCodec<T>(
  type: string,
  version: number,
  schema: ZodType<T>,
): CanonicalCodec<T> {
  return {
    encode(value) {
      const input = immutableCopy(value);
      const state = immutableCopy(schema.parse(input));
      if (canonicalSerialize(state) !== canonicalSerialize(input))
        fail("canonical", "schema must validate without transforming canonical state");
      return canonicalSerialize({ type, version, state });
    },
    decode(canonical) {
      try {
        const input = JSON.parse(canonical) as { version?: unknown; value?: unknown };
        const decoded = restore(input.value) as ComponentSnapshot;
        if (
          input.version !== 1 ||
          canonicalSerialize(decoded) !== canonical ||
          decoded.type !== type ||
          decoded.version !== version
        )
          fail("canonical", "noncanonical component encoding");
        const state = immutableCopy(schema.parse(immutableCopy(decoded.state)));
        if (canonicalSerialize(state) !== canonicalSerialize(decoded.state))
          fail("canonical", "schema must validate without transforming canonical state");
        return state;
      } catch {
        return fail("canonical", "invalid canonical component encoding");
      }
    },
  };
}

export function createComponentRegistry(initial: readonly ComponentRegistration<unknown>[] = []) {
  const entries = new Map<string, Map<number, ComponentRegistration<unknown>>>();
  function lookup(
    type: string,
    version: number,
    path = "component",
  ): ComponentRegistration<unknown> {
    const versions = entries.get(type);
    if (!versions)
      throw new CompositionError(
        "UNKNOWN_COMPONENT_TYPE",
        `${path}.type`,
        "unknown component type",
      );
    const registration = versions.get(version);
    if (!registration)
      throw new CompositionError(
        "UNKNOWN_COMPONENT_VERSION",
        `${path}.version`,
        "unknown component version",
      );
    return registration;
  }
  function register<T>(registration: ComponentRegistration<T>): void {
    if (
      typeof registration.type !== "string" ||
      !registration.type ||
      registration.type.trim() !== registration.type ||
      !Number.isSafeInteger(registration.version) ||
      registration.version < 1
    )
      fail("registration", "explicit type and positive version required");
    const versions = entries.get(registration.type) ?? new Map();
    if (versions.has(registration.version))
      throw new CompositionError(
        "DUPLICATE_REGISTRATION",
        "registration.version",
        "duplicate component registration",
      );
    const edges = registration.upcasters.map((edge) => {
      if (
        !Number.isSafeInteger(edge.fromVersion) ||
        edge.fromVersion < 1 ||
        edge.toVersion !== registration.version ||
        edge.fromVersion >= edge.toVersion
      )
        throw new CompositionError(
          "UNSUPPORTED_UPCAST",
          "registration.upcasters",
          "invalid directed upcaster",
        );
      return Object.freeze({ ...edge });
    });
    if (new Set(edges.map((edge) => edge.fromVersion)).size !== edges.length)
      throw new CompositionError(
        "UNSUPPORTED_UPCAST",
        "registration.upcasters",
        "duplicate upcaster edge",
      );
    versions.set(
      registration.version,
      Object.freeze({
        ...registration,
        canonicalCodec: Object.freeze({
          encode: registration.canonicalCodec.encode.bind(registration.canonicalCodec),
          decode: registration.canonicalCodec.decode.bind(registration.canonicalCodec),
        }),
        upcasters: Object.freeze(edges),
      }) as unknown as ComponentRegistration<unknown>,
    );
    entries.set(registration.type, versions);
  }
  function validate(
    snapshot: ComponentSnapshot,
    context: ComponentValidationContext,
    path = "component",
  ): ComponentSnapshot {
    const input = immutableCopy(snapshot, path);
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort(compareUtf16).join(",") !== "state,type,version"
    )
      fail(path, "expected component snapshot");
    if (
      typeof input.type !== "string" ||
      input.type.length === 0 ||
      input.type.trim() !== input.type
    )
      fail(`${path}.type`, "expected nonempty component type without outer whitespace");
    if (!Number.isSafeInteger(input.version) || input.version < 1)
      fail(`${path}.version`, "expected positive safe-integer component version");
    const registration = lookup(input.type, input.version, path);
    try {
      const parsed = registration.schema.safeParse(immutableCopy(input.state, `${path}.state`));
      if (!parsed.success) {
        const issue = [...parsed.error.issues].sort(
          (a, b) =>
            compareUtf16(a.path.map(String).join("."), b.path.map(String).join(".")) ||
            compareUtf16(a.message, b.message),
        )[0]!;
        fail(
          `${path}.state${issue.path.length ? `.${issue.path.map(String).join(".")}` : ""}`,
          issue.message,
        );
      }
      const state = immutableCopy(parsed.data, `${path}.state`);
      if (canonicalSerialize(state) !== canonicalSerialize(input.state))
        fail(`${path}.state`, "schema must validate without transforming canonical state");
      const issues = [...registration.validateState(state, immutableCopy(context))].sort(
        (a, b) =>
          compareUtf16(a.path, b.path) ||
          compareUtf16(a.code, b.code) ||
          compareUtf16(a.message, b.message),
      );
      if (issues[0])
        throw new CompositionError(
          issues[0].code,
          `${path}.state${issues[0].path ? `.${issues[0].path}` : ""}`,
          issues[0].message,
        );
      return immutableCopy({ type: input.type, version: input.version, state });
    } catch (error) {
      if (error instanceof CompositionError) throw error;
      return fail(`${path}.state`, "component validation failed");
    }
  }
  function encode(
    snapshot: ComponentSnapshot,
    context: ComponentValidationContext,
    path = "component",
  ): string {
    const valid = validate(snapshot, context, path);
    try {
      const codec = lookup(valid.type, valid.version, path).canonicalCodec;
      const canonical = codec.encode(valid.state);
      if (typeof canonical !== "string") fail(`${path}.state`, "expected canonical text");
      const decoded = immutableCopy(codec.decode(canonical));
      if (
        canonicalSerialize(decoded) !== canonicalSerialize(valid.state) ||
        codec.encode(decoded) !== canonical
      )
        fail(`${path}.state`, "component codec must preserve state exactly");
      return canonical;
    } catch {
      return fail(`${path}.state`, "component encoding failed");
    }
  }
  function decode(
    type: string,
    version: number,
    canonical: string,
    context: ComponentValidationContext,
    path = "component",
  ): ComponentSnapshot {
    const registration = lookup(type, version, path);
    let state: unknown;
    try {
      state = registration.canonicalCodec.decode(canonical);
      if (registration.canonicalCodec.encode(immutableCopy(state)) !== canonical)
        fail(`${path}.state`, "noncanonical component encoding");
    } catch {
      return fail(`${path}.state`, "component decoding failed");
    }
    const valid = validate({ type, version, state }, context, path);
    if (canonicalSerialize(valid.state) !== canonicalSerialize(state))
      fail(`${path}.state`, "canonical state cannot require schema transformation");
    return valid;
  }
  function upcast(
    snapshot: ComponentSnapshot,
    targetVersion: number,
    context: ComponentValidationContext,
    path = "component",
  ): ComponentSnapshot {
    let current = validate(snapshot, context, path);
    lookup(current.type, targetVersion, path);
    const search = (version: number, visited: Set<number>): ComponentUpcaster[] | undefined => {
      if (version === targetVersion) return [];
      if (visited.has(version)) return undefined;
      visited.add(version);
      const destinations = [...entries.get(current.type)!.values()]
        .filter((reg) => reg.version <= targetVersion)
        .sort((a, b) => a.version - b.version);
      for (const reg of destinations)
        for (const edge of reg.upcasters)
          if (edge.fromVersion === version) {
            const tail = search(edge.toVersion, new Set(visited));
            if (tail) return [edge, ...tail];
          }
      return undefined;
    };
    const route = search(current.version, new Set());
    if (!route)
      throw new CompositionError(
        "UNSUPPORTED_UPCAST",
        `${path}.version`,
        "no declared migration path",
      );
    for (const edge of route) {
      let state: unknown;
      try {
        state = edge.upcast(immutableCopy(current.state));
      } catch {
        return fail(`${path}.state`, "upcaster failed");
      }
      current = validate({ type: current.type, version: edge.toVersion, state }, context, path);
    }
    return current;
  }
  function redact(
    snapshot: ComponentSnapshot,
    context: ComponentValidationContext,
    access: AccessPolicy,
    path = "component",
  ): unknown {
    const valid = validate(snapshot, context, path);
    try {
      return immutableCopy(
        lookup(valid.type, valid.version, path).redact(valid.state, immutableCopy(access)),
      );
    } catch {
      return fail(`${path}.state`, "redaction failed");
    }
  }
  for (const registration of initial) register(registration);
  return Object.freeze({ register, lookup, validate, encode, decode, upcast, redact });
}
export type ComponentRegistry = ReturnType<typeof createComponentRegistry>;
