import type {
  CapabilityProposal,
  CompiledRunContext,
  ContextCompilationPort,
  ContextCompilationRequest,
  EvidenceRecordingPort,
  McpCapability,
  McpDiscoveryRequest,
  McpInvocationRequest,
  McpTransportPort,
  ModelExecutionPort,
  ModelExecutionRequest,
  ModelExecutionResult,
  ModelRoute,
  ModelRoutePolicyPort,
  ModelRouteRequest,
  ModelStreamEvent,
  RunCheckpoint,
  RunCheckpointStore,
  RunEvidenceRecord,
  RuntimeLogger,
  ToolExecutionPort,
  ToolExecutionRequest,
} from "@clockgrove/application";
import { assertCapabilityProposal } from "../../application/src/capabilities.js";
import { runtimeLogRecord } from "../../application/src/logging.js";

export interface ScriptEntry<TInput, TOutput> {
  readonly input: TInput;
  readonly output: TOutput;
}

/** Finite, exact input/output scripts. Exhaustion fails instead of fabricating a response. */
export class CapabilityScript<TInput, TOutput> {
  private position = 0;
  private readonly entries: readonly ScriptEntry<TInput, TOutput>[];
  constructor(entries: readonly ScriptEntry<TInput, TOutput>[]) {
    this.entries = structuredClone(entries);
  }
  next(input: TInput): TOutput {
    const entry = this.entries[this.position];
    if (entry === undefined) throw new Error("capability script exhausted");
    if (stable(input) !== stable(entry.input)) throw new Error("capability script input mismatch");
    this.position += 1;
    return structuredClone(entry.output);
  }
  get consumed(): number {
    return this.position;
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ScriptedModelExecution implements ModelExecutionPort {
  constructor(
    readonly execution: CapabilityScript<ModelExecutionRequest, ModelExecutionResult>,
    readonly streaming: CapabilityScript<ModelExecutionRequest, readonly ModelStreamEvent[]>,
  ) {}
  async execute(input: ModelExecutionRequest): Promise<ModelExecutionResult> {
    return this.execution.next(input);
  }
  async *stream(input: ModelExecutionRequest): AsyncIterable<ModelStreamEvent> {
    for (const event of this.streaming.next(input)) yield event;
  }
}

export class ScriptedModelRoutePolicy implements ModelRoutePolicyPort {
  constructor(readonly script: CapabilityScript<ModelRouteRequest, ModelRoute>) {}
  async resolve(input: ModelRouteRequest): Promise<ModelRoute> {
    return this.script.next(input);
  }
}

export class ScriptedToolExecution implements ToolExecutionPort {
  constructor(
    readonly script: CapabilityScript<ToolExecutionRequest, readonly CapabilityProposal[]>,
  ) {}
  async execute(input: ToolExecutionRequest): Promise<readonly CapabilityProposal[]> {
    return this.script.next(input);
  }
}

export class ScriptedContextCompilation implements ContextCompilationPort {
  constructor(readonly script: CapabilityScript<ContextCompilationRequest, CompiledRunContext>) {}
  async compile(input: ContextCompilationRequest): Promise<CompiledRunContext> {
    return this.script.next(input);
  }
}

/**
 * An MCP server's results are untrusted: invocation output must be proposals, never mutations.
 * Each discovery and invocation writes one `capability_adapter_called` record to `logger`.
 */
export class ScriptedMcpTransport implements McpTransportPort {
  constructor(
    readonly discovery: CapabilityScript<McpDiscoveryRequest, readonly McpCapability[]>,
    readonly invocation: CapabilityScript<McpInvocationRequest, readonly CapabilityProposal[]>,
    private readonly logger?: RuntimeLogger,
  ) {}
  async discover(input: McpDiscoveryRequest): Promise<readonly McpCapability[]> {
    return this.call(undefined, () => this.discovery.next(input));
  }
  async invoke(input: McpInvocationRequest): Promise<readonly CapabilityProposal[]> {
    return this.call(
      input.runId,
      () => this.invocation.next(input),
      (output) => output.forEach(assertCapabilityProposal),
    );
  }
  /** One record per call: `failed` if the script threw, `refused` if its output was refused. */
  private call<T>(runId: string | undefined, next: () => T, accept?: (output: T) => void): T {
    const log = (outcome: "succeeded" | "refused" | "failed") =>
      this.logger?.log(
        runtimeLogRecord(outcome === "succeeded" ? "info" : "warn", "capability_adapter_called", {
          runId,
          port: "mcp",
          outcome,
        }),
      );
    let output: T;
    try {
      output = next();
    } catch (error) {
      log("failed");
      throw error;
    }
    try {
      accept?.(output);
    } catch (error) {
      log("refused");
      throw error;
    }
    log("succeeded");
    return output;
  }
}

/** Latest checkpoint per run ID, kept for this instance's lifetime. Saves and reads are copies. */
export class InMemoryRunCheckpointStore implements RunCheckpointStore {
  readonly #checkpoints = new Map<string, RunCheckpoint>();
  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.#checkpoints.set(checkpoint.runId, structuredClone(checkpoint));
  }
  async read(runId: string): Promise<RunCheckpoint | undefined> {
    return structuredClone(this.#checkpoints.get(runId));
  }
}

/** Latest evidence per `input.runId`, kept for this instance's lifetime. Records and reads are copies. */
export class InMemoryEvidenceRecording implements EvidenceRecordingPort {
  readonly #records = new Map<string, RunEvidenceRecord>();
  async record(record: RunEvidenceRecord): Promise<void> {
    this.#records.set(record.input.runId, structuredClone(record));
  }
  async read(runId: string): Promise<RunEvidenceRecord | undefined> {
    return structuredClone(this.#records.get(runId));
  }
}
