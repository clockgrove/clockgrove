/** Provider-neutral values. Untrusted content carries no execution context or authority. */
export type CapabilityValue =
  | null
  | boolean
  | number
  | string
  | readonly CapabilityValue[]
  | { readonly [key: string]: CapabilityValue };

export type CapabilityProposal =
  | Readonly<{ kind: "command"; type: string; payload: CapabilityValue }>
  | Readonly<{ kind: "content"; content: CapabilityValue }>;

/** A command proposal is intent only; the ordinary command path supplies and validates authority. */
export function assertCapabilityProposal(value: unknown): asserts value is CapabilityProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability output refused: proposals only; direct mutation is forbidden");
  }
  const proposal = value as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (
    (proposal.kind === "command" &&
      keys === "kind,payload,type" &&
      typeof proposal.type === "string" &&
      proposal.type.length > 0 &&
      isCapabilityValue(proposal.payload)) ||
    (proposal.kind === "content" && keys === "content,kind" && isCapabilityValue(proposal.content))
  )
    return;
  throw new Error("capability output refused: proposals only; direct mutation is forbidden");
}

function isCapabilityValue(value: unknown): value is CapabilityValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCapabilityValue);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isCapabilityValue);
  }
  return false;
}

export interface ModelRouteRequest {
  readonly semanticRoute: string;
  readonly requiresTools: boolean;
  readonly requiresStructuredOutput: boolean;
}

export interface ModelRoute {
  readonly semanticRoute: string;
  /** Opaque adapter configuration reference, never a provider SDK object. */
  readonly adapterRoute: string;
  readonly policyVersion: string;
}

export interface ModelRoutePolicyPort {
  resolve(request: ModelRouteRequest): Promise<ModelRoute>;
}

export interface ContextCompilationRequest {
  readonly runId: string;
  readonly inputs: readonly CapabilityProposal[];
}

export interface CompiledRunContext {
  readonly version: string;
  readonly content: readonly CapabilityProposal[];
}

export interface ContextCompilationPort {
  compile(request: ContextCompilationRequest): Promise<CompiledRunContext>;
}

export interface ToolCallProposal {
  readonly toolId: string;
  readonly input: CapabilityValue;
}

export interface ModelExecutionRequest {
  readonly runId: string;
  readonly route: ModelRoute;
  readonly context: CompiledRunContext;
  readonly priorOutputs: readonly CapabilityProposal[];
  /** Total input plus output tokens allowed for this call. */
  readonly maxTokens: number;
  readonly output:
    | Readonly<{ kind: "proposals" }>
    | Readonly<{ kind: "structured"; schema: CapabilityValue }>;
}

export interface ModelExecutionResult {
  readonly proposals: readonly CapabilityProposal[];
  readonly toolCalls: readonly ToolCallProposal[];
  readonly tokensUsed: number;
  readonly finished: boolean;
}

export type ModelStreamEvent =
  | Readonly<{ kind: "content-delta"; proposal: Readonly<{ kind: "content"; content: string }> }>
  | Readonly<{ kind: "result"; result: ModelExecutionResult }>;

/** Structured responses and stream deltas remain untrusted proposals/content. */
export interface ModelExecutionPort {
  execute(request: ModelExecutionRequest): Promise<ModelExecutionResult>;
  stream(request: ModelExecutionRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ToolExecutionRequest extends ToolCallProposal {
  readonly runId: string;
}

export interface ToolExecutionPort {
  execute(request: ToolExecutionRequest): Promise<readonly CapabilityProposal[]>;
}

export interface McpDiscoveryRequest {
  readonly bindingId: string;
}

export interface McpCapability {
  readonly id: string;
  readonly kind: "tool" | "resource" | "prompt";
  readonly inputSchema: CapabilityValue;
}

export interface McpInvocationRequest extends McpDiscoveryRequest {
  readonly runId: string;
  readonly capabilityId: string;
  readonly input: CapabilityValue;
}

export interface McpTransportPort {
  discover(request: McpDiscoveryRequest): Promise<readonly McpCapability[]>;
  invoke(request: McpInvocationRequest): Promise<readonly CapabilityProposal[]>;
}

export interface RunBounds {
  /** Model and tool invocations both consume a step. */
  readonly maxSteps: number;
  readonly maxTokens: number;
}

export interface RunCheckpoint {
  readonly runId: string;
  readonly step: number;
  readonly tokensUsed: number;
  readonly outputs: readonly CapabilityProposal[];
}

/** Recoverable execution progress, never canonical world state. */
export interface RunCheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  read(runId: string): Promise<RunCheckpoint | undefined>;
}

export type RunEvidenceStep =
  | Readonly<{ kind: "model"; input: ModelExecutionRequest; output: ModelExecutionResult }>
  | Readonly<{ kind: "tool"; input: ToolExecutionRequest; output: readonly CapabilityProposal[] }>;

export interface RunEvidenceRecord {
  readonly version: 1;
  readonly input: ContextCompilationRequest;
  readonly bounds: RunBounds;
  readonly route: ModelRoute;
  readonly context: CompiledRunContext;
  readonly steps: readonly RunEvidenceStep[];
  readonly checkpoints: readonly RunCheckpoint[];
  readonly outputs: readonly CapabilityProposal[];
  readonly termination: "step-bound" | "token-bound" | "completed";
}

export interface EvidenceRecordingPort {
  record(record: RunEvidenceRecord): Promise<void>;
  read(runId: string): Promise<RunEvidenceRecord | undefined>;
}
