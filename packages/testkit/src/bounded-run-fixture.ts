import type {
  CapabilityProposal,
  ContextCompilationPort,
  ContextCompilationRequest,
  EvidenceRecordingPort,
  ModelExecutionPort,
  ModelRoutePolicyPort,
  RunBounds,
  RunCheckpoint,
  RunCheckpointStore,
  RunEvidenceRecord,
  RunEvidenceStep,
  RuntimeLogger,
  ToolExecutionPort,
} from "@clockgrove/application";
import { assertCapabilityProposal } from "../../application/src/capabilities.js";
import { runtimeLogRecord } from "../../application/src/logging.js";

/**
 * Wave 0 executable fixture only. It has no journal, command executor, or mutation capability.
 * Each model and tool adapter call writes one `capability_adapter_called` record to `logger`.
 */
export async function runBoundedCapabilityFixture(
  input: ContextCompilationRequest,
  bounds: RunBounds,
  ports: {
    readonly model: ModelExecutionPort;
    readonly route: ModelRoutePolicyPort;
    readonly tool: ToolExecutionPort;
    readonly context: ContextCompilationPort;
    readonly checkpoints: RunCheckpointStore;
    readonly evidence: EvidenceRecordingPort;
  },
  logger?: RuntimeLogger,
): Promise<RunEvidenceRecord> {
  for (const bound of [bounds.maxSteps, bounds.maxTokens]) {
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new RangeError("run bounds must be positive safe integers");
  }
  input.inputs.forEach(assertCapabilityProposal);
  const context = await ports.context.compile(input);
  context.content.forEach(assertCapabilityProposal);
  const route = await ports.route.resolve({
    semanticRoute: "fixture.tool-turn",
    requiresTools: true,
    requiresStructuredOutput: false,
  });
  const outputs: CapabilityProposal[] = [];
  const steps: RunEvidenceStep[] = [];
  const checkpoints: RunCheckpoint[] = [];
  let tokensUsed = 0;
  let completed = false;
  const bounded = () => steps.length >= bounds.maxSteps || tokensUsed >= bounds.maxTokens;
  const checkpoint = async () => {
    const entry = {
      runId: input.runId,
      step: steps.length,
      tokensUsed,
      outputs: structuredClone(outputs),
    };
    await ports.checkpoints.save(entry);
    checkpoints.push(entry);
  };
  /** One record per adapter call: `failed` if it threw, `refused` if its output was refused. */
  const adapterCall = async <T>(
    port: "model" | "tool",
    invoke: () => Promise<T>,
    accept: (output: T) => void,
  ): Promise<T> => {
    const log = (outcome: "succeeded" | "refused" | "failed") =>
      logger?.log(
        runtimeLogRecord(outcome === "succeeded" ? "info" : "warn", "capability_adapter_called", {
          runId: input.runId,
          port,
          step: steps.length + 1,
          outcome,
        }),
      );
    let output: T;
    try {
      output = await invoke();
    } catch (error) {
      log("failed");
      throw error;
    }
    try {
      accept(output);
    } catch (error) {
      log("refused");
      throw error;
    }
    log("succeeded");
    return output;
  };
  while (!bounded() && !completed) {
    const request = {
      runId: input.runId,
      route,
      context,
      priorOutputs: structuredClone(outputs),
      maxTokens: bounds.maxTokens - tokensUsed,
      output: { kind: "proposals" },
    } as const;
    const result = await adapterCall(
      "model",
      () => ports.model.execute(request),
      (result) => {
        if (
          !Number.isSafeInteger(result.tokensUsed) ||
          result.tokensUsed < 0 ||
          result.tokensUsed > request.maxTokens
        ) {
          throw new Error("model token usage violates declared bound");
        }
        result.proposals.forEach(assertCapabilityProposal);
      },
    );
    tokensUsed += result.tokensUsed;
    outputs.push(...result.proposals);
    steps.push({ kind: "model", input: request, output: result });
    await checkpoint();
    for (const call of result.toolCalls) {
      if (bounded()) break;
      if (
        Object.keys(call).sort().join(",") !== "input,toolId" ||
        typeof call.toolId !== "string" ||
        call.toolId.length === 0
      ) {
        throw new Error("invalid tool-call proposal");
      }
      const request = { runId: input.runId, toolId: call.toolId, input: call.input };
      const result = await adapterCall(
        "tool",
        () => ports.tool.execute(request),
        (result) => result.forEach(assertCapabilityProposal),
      );
      outputs.push(...result);
      steps.push({ kind: "tool", input: request, output: result });
      await checkpoint();
    }
    completed = result.finished && result.toolCalls.length === 0;
  }
  const record: RunEvidenceRecord = {
    version: 1,
    input,
    bounds,
    route,
    context,
    steps,
    checkpoints,
    outputs,
    termination:
      tokensUsed >= bounds.maxTokens
        ? "token-bound"
        : steps.length >= bounds.maxSteps
          ? "step-bound"
          : "completed",
  };
  await ports.evidence.record(record);
  return record;
}
