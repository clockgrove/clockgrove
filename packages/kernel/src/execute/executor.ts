import type { CommandEnvelope } from "@clockgrove/contracts";
import type { NamedRandomState } from "@clockgrove/domain";
import { canonicalSerialize } from "../canonical.js";
import { createDeterministicIdSource } from "../deterministic-id.js";
import {
  EventRegistry,
  ReducerRegistry,
  validType,
  validVersion,
  verifyReducers,
} from "../reducers/registry.js";
import type { KernelTransitionResult, ProjectionDelta, ScheduleMutation } from "../transition.js";
import { type Refusal, RefusalSignal, type RegistrationResult, refusal } from "./refusal.js";
import {
  CheckRegistry,
  type CommandRegistration,
  CommandRegistry,
  type DraftEvent,
  type EmittedEvent,
  type ExecutorInput,
  type InvariantContext,
  type KernelVersionSet,
  type PreconditionContext,
  type VerificationMode,
} from "./registry.js";

export interface KernelDefinition<
  TState,
  TInput extends ExecutorInput,
  TEvent extends DraftEvent,
  TExtra,
> {
  readonly commands: CommandRegistry<TState, TInput, TEvent, TExtra>;
  /**
   * Optional scheduled-input registrations, keyed by the scheduled `(type, schemaVersion)`. When
   * absent, scheduled stimuli stay `unsupported-input` at `input.kind`.
   */
  readonly scheduled?: CommandRegistry<TState, TInput, TEvent, TExtra>;
  readonly events: EventRegistry;
  readonly reducers: ReducerRegistry<TState, TEvent>;
  readonly preconditions: CheckRegistry<PreconditionContext<TState, TInput>>;
  readonly invariants: CheckRegistry<InvariantContext<TState, TEvent> & { readonly state: TState }>;
  /** Validates the full input and returns the immutable decoded partition state; throws signals. */
  readonly decodeInput: (input: TInput) => TState;
  readonly revisionOf: (state: TState) => bigint;
  readonly deriveDelta: (initial: TState, final: TState) => ProjectionDelta<TState>;
}

export interface ExecuteOptions {
  /** Explicit; never read from the environment. Delta verification runs outside production. */
  readonly mode: VerificationMode;
}

export interface KernelExecution<TState, TEvent extends DraftEvent, TExtra>
  extends KernelTransitionResult<EmittedEvent<TEvent>, ScheduleMutation, ProjectionDelta<TState>> {
  readonly state: TState;
  readonly extra: TExtra | undefined;
}

export type KernelOutcome<TState, TEvent extends DraftEvent, TExtra> =
  | Readonly<{ ok: true; result: KernelExecution<TState, TEvent, TExtra> }>
  | Readonly<{ ok: false; error: Refusal }>;

export interface Kernel<TState, TInput extends ExecutorInput, TEvent extends DraftEvent, TExtra> {
  readonly definition: KernelDefinition<TState, TInput, TEvent, TExtra>;
  /** Total: always returns, never throws. */
  readonly execute: (
    input: TInput,
    options: ExecuteOptions,
  ) => KernelOutcome<TState, TEvent, TExtra>;
  readonly identity: () => Readonly<{
    commands: readonly (readonly [string, number])[];
    scheduled: readonly (readonly [string, number])[];
    events: readonly (readonly [string, number])[];
    reducers: readonly (readonly [string, number])[];
    preconditions: readonly (readonly [string, number])[];
    invariants: readonly (readonly [string, number])[];
  }>;
}

export type KernelCreation<
  TState,
  TInput extends ExecutorInput,
  TEvent extends DraftEvent,
  TExtra,
> =
  | Readonly<{ ok: true; kernel: Kernel<TState, TInput, TEvent, TExtra> }>
  | Readonly<{ ok: false; error: Refusal }>;

const MODES: readonly unknown[] = ["development", "test", "production"];
const SCHEDULED_KEYS = Object.freeze([
  "schemaVersion",
  "scheduleId",
  "commandId",
  "type",
  "payload",
] as const);

/** Verifies reducer exhaustiveness once, then binds the pure executor to the registries. */
export function createKernel<
  TState,
  TInput extends ExecutorInput,
  TEvent extends DraftEvent,
  TExtra,
>(
  definition: KernelDefinition<TState, TInput, TEvent, TExtra>,
): KernelCreation<TState, TInput, TEvent, TExtra> {
  const verified: RegistrationResult = verifyReducers(definition.events, definition.reducers);
  if (!verified.ok) return Object.freeze({ ok: false, error: verified.error });
  const kernel: Kernel<TState, TInput, TEvent, TExtra> = Object.freeze({
    definition,
    execute: (input: TInput, options: ExecuteOptions) => run(definition, input, options),
    identity: () =>
      Object.freeze({
        commands: definition.commands.identity(),
        scheduled: definition.scheduled?.identity() ?? [],
        events: definition.events.identity(),
        reducers: definition.reducers.identity(),
        preconditions: definition.preconditions.identity(),
        invariants: definition.invariants.identity(),
      }),
  });
  return Object.freeze({ ok: true, kernel });
}

function fail<TState, TEvent extends DraftEvent, TExtra>(
  error: Refusal,
): KernelOutcome<TState, TEvent, TExtra> {
  return Object.freeze({ ok: false, error });
}

function signal(code: Refusal["code"], path: string, check?: string): RefusalSignal {
  return new RefusalSignal(refusal(code, path, check));
}

function run<TState, TInput extends ExecutorInput, TEvent extends DraftEvent, TExtra>(
  definition: KernelDefinition<TState, TInput, TEvent, TExtra>,
  input: TInput,
  options: ExecuteOptions,
): KernelOutcome<TState, TEvent, TExtra> {
  try {
    return Object.freeze({ ok: true, result: execute(definition, input, options) });
  } catch (error) {
    // Only the stable envelope survives: messages, stacks and host details are discarded.
    return fail(error instanceof RefusalSignal ? error.refusal : refusal("invalid-input", "input"));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function deriveVersions(input: ExecutorInput, type: string, version: number): KernelVersionSet {
  const pack = input.pack as unknown;
  const policies = input.policies as unknown;
  if (!isRecord(pack) || !validType(pack.packId) || !validType(pack.packVersion))
    throw signal("invalid-input", "pack");
  const artifact = pack.pack;
  if (!isRecord(artifact) || typeof artifact.contentHash !== "string")
    throw signal("invalid-input", "pack.pack.contentHash");
  if (!isRecord(policies) || !isRecord(policies.policyVersions))
    throw signal("invalid-input", "policies.policyVersions");
  const policyVersions: Record<string, string> = {};
  for (const [name, value] of Object.entries(policies.policyVersions)) {
    if (typeof value !== "string") throw signal("invalid-input", "policies.policyVersions");
    policyVersions[name] = value;
  }
  return Object.freeze({
    worldPack: Object.freeze({
      packId: pack.packId,
      packVersion: pack.packVersion,
      contentHash: artifact.contentHash,
    }),
    policies: Object.freeze(policyVersions),
    command: Object.freeze({ type, version }),
  });
}

function freezeRandomState(state: NamedRandomState): NamedRandomState {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(state).map(([name, stream]) => [
        name,
        Object.freeze({
          ...stream,
          algorithm: Object.freeze({ ...stream.algorithm }),
          state: Object.freeze([...stream.state]),
        }),
      ]),
    ),
  );
}

function execute<TState, TInput extends ExecutorInput, TEvent extends DraftEvent, TExtra>(
  definition: KernelDefinition<TState, TInput, TEvent, TExtra>,
  input: TInput,
  options: ExecuteOptions,
): KernelExecution<TState, TEvent, TExtra> {
  const mode: unknown = isRecord(options) ? options.mode : undefined;
  if (!MODES.includes(mode)) throw signal("invalid-input", "options.mode");
  const stimulus = input.input as { readonly kind: unknown; readonly [key: string]: unknown };
  const scheduledRegistry = definition.scheduled;
  let command: CommandEnvelope<string, unknown>;
  let type: string;
  let payload: Record<string, unknown>;
  let version: number;
  let registration: CommandRegistration<TState, TInput, TEvent, TExtra>;
  if (stimulus.kind === "command") {
    command = stimulus.command as CommandEnvelope<string, unknown>;
    const commandType: unknown = command.type;
    if (typeof commandType !== "string") throw signal("invalid-input", "command.type");
    type = commandType;
    const commandPayload: unknown = command.payload;
    if (!isRecord(commandPayload)) throw signal("invalid-input", "command.payload");
    payload = commandPayload;
    const commandVersion: unknown = payload.schemaVersion;
    if (!validVersion(commandVersion))
      throw signal("invalid-input", "command.payload.schemaVersion");
    version = commandVersion;
    const found = definition.commands.lookup(type, version);
    if (found === undefined)
      throw signal(
        "unknown-command-version",
        definition.commands.hasType(type) ? "command.payload.schemaVersion" : "command.type",
      );
    registration = found;
  } else if (stimulus.kind === "scheduled" && scheduledRegistry !== undefined) {
    const scheduled = stimulus.scheduled;
    if (!isRecord(scheduled) || Array.isArray(scheduled))
      throw signal("invalid-input", "input.scheduled");
    const record = scheduled as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    for (const key of SCHEDULED_KEYS)
      if (!keys.includes(key) || record[key] === undefined)
        throw signal("invalid-input", `input.scheduled.${key}`);
    const extra = keys.filter((key) => !(SCHEDULED_KEYS as readonly unknown[]).includes(key));
    if (extra.length > 0) throw signal("invalid-input", `input.scheduled.${String(extra[0])}`);
    if (typeof record.scheduleId !== "string" || record.scheduleId.length === 0)
      throw signal("invalid-input", "input.scheduled.scheduleId");
    if (typeof record.commandId !== "string" || record.commandId.length === 0)
      throw signal("invalid-input", "input.scheduled.commandId");
    if (typeof record.type !== "string" || !validType(record.type))
      throw signal("invalid-input", "input.scheduled.type");
    if (!validVersion(record.schemaVersion))
      throw signal("invalid-input", "input.scheduled.schemaVersion");
    type = record.type;
    version = record.schemaVersion;
    const found = scheduledRegistry.lookup(type, version);
    if (found === undefined)
      throw signal(
        "unknown-command-version",
        scheduledRegistry.hasType(type) ? "input.scheduled.schemaVersion" : "input.scheduled.type",
      );
    registration = found;
    if (!isRecord(record.payload) || Array.isArray(record.payload))
      throw signal("invalid-input", "input.scheduled.payload");
    payload = record.payload as Record<string, unknown>;
    command = Object.freeze({
      commandId: record.commandId,
      type,
      payload,
    }) as unknown as CommandEnvelope<string, unknown>;
  } else throw signal("unsupported-input", "input.kind");

  const state = definition.decodeInput(input);
  const versions = deriveVersions(input, type, version);
  const partitionRevision = definition.revisionOf(state);

  // Expected-revision policy, checked before any handler code runs.
  const policy = registration.expectedRevision;
  const continuation = input.continuation;
  let expected: unknown;
  if (policy !== "none" && stimulus.kind === "command") {
    const fromContinuation = policy === "continuation-or-optional" && continuation !== undefined;
    expected = fromContinuation
      ? continuation.expectedRevision
      : (command.expected as { partitionRevision?: unknown } | undefined)?.partitionRevision;
    if (expected === undefined) {
      if (policy === "required")
        throw signal("invalid-input", "command.expected.partitionRevision");
    } else if (typeof expected !== "bigint") {
      throw signal(
        "invalid-input",
        fromContinuation ? "continuation.expectedRevision" : "command.expected.partitionRevision",
      );
    } else if (expected !== partitionRevision) {
      throw signal(
        "revision-conflict",
        fromContinuation ? "continuation.expectedRevision" : "command.expected.partitionRevision",
      );
    }
  }

  try {
    registration.validatePayload(payload, { state });
  } catch (error) {
    if (error instanceof RefusalSignal) throw error;
    throw signal("invalid-input", "payload");
  }

  const context: PreconditionContext<TState, TInput> = Object.freeze({
    input,
    command,
    payload,
    state,
    versions,
  });
  for (const precondition of definition.preconditions.ordered(type)) {
    const name = `${precondition.name}@${precondition.version}`;
    let offending: string | undefined;
    try {
      offending = precondition.check(context);
    } catch {
      throw signal("check-error", "precondition", name);
    }
    if (offending !== undefined) throw signal("precondition-failed", offending, name);
  }

  const snapshot = (): string =>
    canonicalSerialize([input.partition.state, payload, input.randomState, input.ids.seed]);
  const before = snapshot();

  const events: EmittedEvent<TEvent>[] = [];
  let working = state;
  const emit = (event: TEvent): void => {
    const index = events.length;
    const fields = event as unknown as Record<string, unknown>;
    if (
      !isRecord(fields) ||
      !validType(fields.type) ||
      !validVersion(fields.schemaVersion) ||
      !definition.events.has(fields.type, fields.schemaVersion)
    )
      throw signal("unknown-event-version", `events[${index}].type`);
    const reducer = definition.reducers.lookup(fields.type, fields.schemaVersion);
    if (reducer === undefined) throw signal("unknown-event-version", `events[${index}].type`);
    const revision = definition.revisionOf(working);
    if (revision > BigInt(Number.MAX_SAFE_INTEGER))
      throw signal("handler-failed", `events[${index}].eventIndex`);
    // Provisional identity: the originating command identity plus the event index (the
    // partition revision before the event), through the stateless deterministic id source.
    const eventIndex = Number(revision);
    const ids = createDeterministicIdSource({ ...input.ids.seed, eventIndex });
    const draft = Object.freeze({
      ...event,
      payload: Object.freeze({ ...(event.payload as object) }),
      ...(isRecord(fields.policyVersions)
        ? { policyVersions: Object.freeze({ ...fields.policyVersions }) }
        : {}),
      eventIndex,
      commandId: command.commandId,
      eventId: ids.next("EventId"),
    }) as unknown as EmittedEvent<TEvent>;
    try {
      working = reducer(working, draft);
    } catch {
      throw signal("reducer-failed", `events[${index}]`);
    }
    events.push(draft);
  };

  let output;
  try {
    output = registration.handler({
      input,
      command,
      payload,
      state,
      versions,
      workingState: () => working,
      eventCount: () => events.length,
      emit,
    });
  } catch (error) {
    if (error instanceof RefusalSignal) throw error;
    throw signal("handler-failed", "handler");
  }
  if (!isRecord(output)) throw signal("handler-failed", "handler");

  if (events.length === 0 && registration.idempotentNoOp !== true)
    throw signal("empty-result", "events");

  // Authoritative state: only the emitted events, applied in emitted order.
  let final = state;
  events.forEach((event, index) => {
    const reducer = definition.reducers.lookup(event.type, event.schemaVersion);
    if (reducer === undefined) throw signal("unknown-event-version", `events[${index}].type`);
    try {
      final = reducer(final, event);
    } catch {
      throw signal("reducer-failed", `events[${index}]`);
    }
  });

  if (snapshot() !== before) throw signal("mutation-detected", "input");

  const invariantContext = Object.freeze({ payload, initial: state, events, state: final });
  for (const invariant of definition.invariants.ordered(type)) {
    const name = `${invariant.name}@${invariant.version}`;
    let offending: string | undefined;
    try {
      offending = invariant.check(invariantContext);
    } catch {
      throw signal("check-error", "invariant", name);
    }
    if (offending !== undefined) throw signal("invariant-violated", offending, name);
  }

  const derived = definition.deriveDelta(state, final);
  if (mode !== "production") {
    let declared: string;
    try {
      declared = canonicalSerialize(output.projectionDelta);
    } catch {
      declared = "unencodable";
    }
    const reducerDerived = canonicalSerialize(derived);
    if (declared !== reducerDerived)
      throw signal(
        "delta-mismatch",
        `projectionDelta#declared=${declared};derived=${reducerDerived}`,
      );
  }

  const result: KernelExecution<TState, TEvent, TExtra> = Object.freeze({
    events: Object.freeze(events),
    scheduleMutations: Object.freeze([...(output.scheduleMutations ?? [])]),
    projectionDelta: Object.freeze(derived),
    decisionDrafts: Object.freeze([...(output.decisionDrafts ?? [])]),
    evidenceDrafts: Object.freeze([...(output.evidenceDrafts ?? [])]),
    updatedRandomState: freezeRandomState(output.randomState ?? input.randomState),
    state: final,
    extra: output.extra,
  });
  return result;
}
