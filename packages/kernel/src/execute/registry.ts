import type { CommandEnvelope, SimTimeMs } from "@clockgrove/contracts";
import type { NamedRandomState } from "@clockgrove/domain";
import { sortedIdentity, validType, validVersion, versionKey } from "../reducers/registry.js";
import type {
  DecisionDraft,
  EvidenceDraft,
  KernelStimulus,
  KernelTransitionInput,
  ProjectionDelta,
  ScheduleMutation,
  SemanticEventDraft,
} from "../transition.js";
import { REGISTERED, type RegistrationResult, registrationRefusal } from "./refusal.js";

export const EXPECTED_REVISION_POLICIES = Object.freeze([
  "none",
  "optional",
  "required",
  "continuation-or-optional",
] as const);
export type ExpectedRevisionPolicy = (typeof EXPECTED_REVISION_POLICIES)[number];

/** Minimal shape every emitted event shares; concrete events add scope fields. */
export interface DraftEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly simulationTime: SimTimeMs;
  readonly payload: unknown;
}

/** Input the executor accepts: the existing transition shape plus an optional continuation. */
export type ExecutorInput = KernelTransitionInput<
  unknown,
  KernelStimulus<CommandEnvelope<string, unknown>>,
  unknown,
  unknown
> & { readonly continuation?: { readonly expectedRevision: bigint } };

export type VerificationMode = "development" | "test" | "production";

/** Structural description of the pinned artifact; the kernel never imports the pack SDK. */
export interface KernelVersionSet {
  readonly worldPack: Readonly<{ packId: string; packVersion: string; contentHash: string }>;
  readonly policies: Readonly<Record<string, string>>;
  readonly command: Readonly<{ type: string; version: number }>;
}

export type EmittedEvent<TEvent> = TEvent & SemanticEventDraft;

export interface HandlerContext<TState, TInput, TEvent> {
  readonly input: TInput;
  readonly command: CommandEnvelope<string, unknown>;
  readonly payload: unknown;
  /** Immutable decoded partition state the command was submitted against. */
  readonly state: TState;
  readonly versions: KernelVersionSet;
  /** State after the events emitted so far, derived only through registered reducers. */
  readonly workingState: () => TState;
  readonly eventCount: () => number;
  /** Assigns the provisional identity, applies the registered reducer and records the event. */
  readonly emit: (event: TEvent) => void;
}

export interface HandlerOutput<TState, TExtra> {
  readonly scheduleMutations?: readonly ScheduleMutation[];
  readonly decisionDrafts?: readonly DecisionDraft[];
  readonly evidenceDrafts?: readonly EvidenceDraft[];
  /** Declared delta; compared with the reducer-derived delta in development and test. */
  readonly projectionDelta: ProjectionDelta<TState>;
  readonly randomState?: NamedRandomState;
  readonly extra?: TExtra;
}

export interface CommandRegistration<TState, TInput, TEvent, TExtra> {
  readonly type: string;
  readonly version: number;
  readonly owner: string;
  readonly expectedRevision: ExpectedRevisionPolicy;
  /** Only registrations declared idempotent may succeed with zero events. */
  readonly idempotentNoOp?: boolean;
  /** Throws to refuse; a thrown signal becomes `invalid-input`. */
  readonly validatePayload: (payload: unknown, context: { readonly state: TState }) => void;
  readonly handler: (
    context: HandlerContext<TState, TInput, TEvent>,
  ) => HandlerOutput<TState, TExtra>;
}

export class CommandRegistry<TState, TInput, TEvent, TExtra> {
  readonly #commands = new Map<string, CommandRegistration<TState, TInput, TEvent, TExtra>>();
  readonly #types = new Set<string>();

  register(registration: CommandRegistration<TState, TInput, TEvent, TExtra>): RegistrationResult {
    const candidate = registration as Partial<
      CommandRegistration<TState, TInput, TEvent, TExtra>
    > | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !validType(candidate.type) ||
      !validVersion(candidate.version) ||
      !validType(candidate.owner) ||
      typeof candidate.validatePayload !== "function" ||
      typeof candidate.handler !== "function" ||
      candidate.expectedRevision === undefined
    )
      return registrationRefusal("missing-registration-part", "command");
    if (!(EXPECTED_REVISION_POLICIES as readonly unknown[]).includes(candidate.expectedRevision))
      return registrationRefusal(
        "unknown-policy-kind",
        versionKey(candidate.type, candidate.version),
      );
    const key = versionKey(candidate.type, candidate.version);
    if (this.#commands.has(key)) return registrationRefusal("duplicate-registration", key);
    this.#commands.set(key, Object.freeze({ ...registration }));
    this.#types.add(candidate.type);
    return REGISTERED;
  }

  lookup(
    type: string,
    version: number,
  ): CommandRegistration<TState, TInput, TEvent, TExtra> | undefined {
    return this.#commands.get(versionKey(type, version));
  }

  hasType(type: string): boolean {
    return this.#types.has(type);
  }

  identity(): readonly (readonly [string, number])[] {
    return sortedIdentity([...this.#commands.values()].map((c) => [c.type, c.version] as const));
  }
}

export interface PreconditionContext<TState, TInput> {
  readonly input: TInput;
  readonly command: CommandEnvelope<string, unknown>;
  readonly payload: unknown;
  readonly state: TState;
  readonly versions: KernelVersionSet;
}

export interface InvariantContext<TState, TEvent> {
  readonly initial: TState;
  readonly events: readonly EmittedEvent<TEvent>[];
}

/** Named, versioned check returning the offending canonical path, or undefined when satisfied. */
export interface NamedCheck<TSubject> {
  readonly name: string;
  readonly version: number;
  /** Commands the check applies to; omitted means every command. */
  readonly commands?: readonly string[];
  readonly check: (subject: TSubject) => string | undefined;
}

export class CheckRegistry<TSubject> {
  readonly #checks = new Map<string, NamedCheck<TSubject>>();

  register(check: NamedCheck<TSubject>): RegistrationResult {
    const candidate = check as Partial<NamedCheck<TSubject>> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !validType(candidate.name) ||
      !validVersion(candidate.version) ||
      typeof candidate.check !== "function"
    )
      return registrationRefusal("missing-registration-part", "check");
    const key = versionKey(candidate.name, candidate.version);
    if (this.#checks.has(key)) return registrationRefusal("duplicate-registration", key);
    this.#checks.set(key, Object.freeze({ ...check }));
    return REGISTERED;
  }

  /** Checks applicable to a command, in canonical `name@version` UTF-16 order. */
  ordered(commandType: string): readonly NamedCheck<TSubject>[] {
    return [...this.#checks.entries()]
      .filter(([, c]) => c.commands === undefined || c.commands.includes(commandType))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, c]) => c);
  }

  identity(): readonly (readonly [string, number])[] {
    return sortedIdentity([...this.#checks.values()].map((c) => [c.name, c.version] as const));
  }
}
