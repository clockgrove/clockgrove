import { REGISTERED, type RegistrationResult, registrationRefusal } from "../execute/refusal.js";

export type Reducer<TState, TEvent> = (state: TState, event: TEvent) => TState;

export interface EventRegistration {
  readonly type: string;
  readonly version: number;
  readonly owner: string;
}

export interface ReducerRegistration<TState, TEvent> {
  readonly type: string;
  readonly version: number;
  readonly reduce: Reducer<TState, TEvent>;
}

export function versionKey(type: string, version: number): string {
  return `${type}@${version}`;
}

export function validType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorted (UTF-16 order) `[type, version]` list of a key map. */
export function sortedIdentity(
  entries: Iterable<readonly [string, number]>,
): readonly (readonly [string, number])[] {
  return Object.freeze(
    [...entries]
      .sort((left, right) => compare(versionKey(...left), versionKey(...right)))
      .map(([type, version]) => Object.freeze([type, version] as const)),
  );
}

/** Registered semantic event type/version pairs. */
export class EventRegistry {
  readonly #events = new Map<string, EventRegistration>();

  register(registration: EventRegistration): RegistrationResult {
    const candidate = registration as Partial<EventRegistration> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !validType(candidate.type) ||
      !validVersion(candidate.version) ||
      !validType(candidate.owner)
    )
      return registrationRefusal("missing-registration-part", "event");
    const key = versionKey(candidate.type, candidate.version);
    if (this.#events.has(key)) return registrationRefusal("duplicate-registration", key);
    this.#events.set(key, Object.freeze({ ...registration }));
    return REGISTERED;
  }

  has(type: string, version: number): boolean {
    return this.#events.has(versionKey(type, version));
  }

  identity(): readonly (readonly [string, number])[] {
    return sortedIdentity([...this.#events.values()].map((e) => [e.type, e.version] as const));
  }
}

/** Exactly one reducer per registered event type/version. */
export class ReducerRegistry<TState, TEvent> {
  readonly #reducers = new Map<string, ReducerRegistration<TState, TEvent>>();

  register(registration: ReducerRegistration<TState, TEvent>): RegistrationResult {
    const candidate = registration as Partial<ReducerRegistration<TState, TEvent>> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !validType(candidate.type) ||
      !validVersion(candidate.version) ||
      typeof candidate.reduce !== "function"
    )
      return registrationRefusal("missing-registration-part", "reducer");
    const key = versionKey(candidate.type, candidate.version);
    if (this.#reducers.has(key)) return registrationRefusal("duplicate-registration", key);
    this.#reducers.set(key, Object.freeze({ ...registration }));
    return REGISTERED;
  }

  lookup(type: string, version: number): Reducer<TState, TEvent> | undefined {
    return this.#reducers.get(versionKey(type, version))?.reduce;
  }

  identity(): readonly (readonly [string, number])[] {
    return sortedIdentity([...this.#reducers.values()].map((r) => [r.type, r.version] as const));
  }
}

/** Refuses an event with no reducer (`missing-reducer`) and a reducer for no event (`orphan-reducer`). */
export function verifyReducers<TState, TEvent>(
  events: EventRegistry,
  reducers: ReducerRegistry<TState, TEvent>,
): RegistrationResult {
  const registered = events.identity().map(([type, version]) => versionKey(type, version));
  const reduced = reducers.identity().map(([type, version]) => versionKey(type, version));
  for (const key of registered)
    if (!reduced.includes(key)) return registrationRefusal("missing-reducer", key);
  for (const key of reduced)
    if (!registered.includes(key)) return registrationRefusal("orphan-reducer", key);
  return REGISTERED;
}
