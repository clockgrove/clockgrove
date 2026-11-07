import type {
  CapabilityProposal,
  ModelExecutionRequest,
  ModelExecutionResult,
  RunBounds,
} from "@clockgrove/application";
import { expect, it } from "vitest";
import { InMemoryRuntimeLogger, releaseRuntimeLogger } from "../../application/src/logging.js";
import {
  CapabilityScript,
  InMemoryEvidenceRecording,
  InMemoryRunCheckpointStore,
  runBoundedCapabilityFixture,
  ScriptedContextCompilation,
  ScriptedMcpTransport,
  ScriptedModelExecution,
  ScriptedModelRoutePolicy,
  ScriptedToolExecution,
} from "../src/index.js";

// Wave 0 exit: a fixture exercises a bounded fake model/tool run without adding provider authority.
const proposal: CapabilityProposal = { kind: "command", type: "RuntimeNoOp", payload: {} };
const input = { runId: "run-fixture", inputs: [{ kind: "content", content: "propose" }] } as const;
const context = { version: "fixture-1", content: input.inputs };
const route = { semanticRoute: "fixture.tool-turn", adapterRoute: "scripted", policyVersion: "1" };
const toolInput = { runId: input.runId, toolId: "suggest-no-op", input: null };

function ports(bounds: RunBounds, modelOutput: ModelExecutionResult) {
  const modelInput: ModelExecutionRequest = {
    runId: input.runId,
    route,
    context,
    priorOutputs: [],
    maxTokens: bounds.maxTokens,
    output: { kind: "proposals" },
  };
  return {
    model: new ScriptedModelExecution(
      new CapabilityScript([{ input: modelInput, output: modelOutput }]),
      new CapabilityScript([]),
    ),
    route: new ScriptedModelRoutePolicy(
      new CapabilityScript([
        {
          input: {
            semanticRoute: route.semanticRoute,
            requiresTools: true,
            requiresStructuredOutput: false,
          },
          output: route,
        },
      ]),
    ),
    context: new ScriptedContextCompilation(new CapabilityScript([{ input, output: context }])),
    tool: new ScriptedToolExecution(
      new CapabilityScript([{ input: toolInput, output: [proposal] }]),
    ),
    checkpoints: new InMemoryRunCheckpointStore(),
    evidence: new InMemoryEvidenceRecording(),
  };
}
const toolTurn = {
  proposals: [],
  toolCalls: [{ toolId: "suggest-no-op", input: null }],
  tokensUsed: 3,
  finished: false,
};

/** The records a run wrote, without their wall time. */
function released() {
  const sink = new InMemoryRuntimeLogger();
  return {
    logger: releaseRuntimeLogger(sink, { codeVersion: "fixture", environment: "local" }),
    records: () => sink.records.map(({ timestamp, ...record }) => record),
  };
}
const adapterCall = (port: string, step: number, outcome: string) => ({
  schemaVersion: 5,
  level: outcome === "succeeded" ? "info" : "warn",
  event: "capability_adapter_called",
  runId: "run-fixture",
  port,
  step,
  outcome,
  codeVersion: "fixture",
  environment: "local",
});

it("records a bounded model/tool run and stops before a tool at the step bound", async () => {
  const run = ports({ maxSteps: 2, maxTokens: 10 }, toolTurn);
  const log = released();
  const record = await runBoundedCapabilityFixture(
    input,
    { maxSteps: 2, maxTokens: 10 },
    run,
    log.logger,
  );
  // One record per adapter call, in call order, with the step it produced.
  expect(log.records()).toEqual([
    adapterCall("model", 1, "succeeded"),
    adapterCall("tool", 2, "succeeded"),
  ]);
  expect(record.steps.map((step) => step.kind)).toEqual(["model", "tool"]);
  expect(record.outputs).toEqual([proposal]);
  expect(record.termination).toBe("step-bound");
  const afterModel = { runId: "run-fixture", step: 1, tokensUsed: 3, outputs: [] };
  const afterTool = { runId: "run-fixture", step: 2, tokensUsed: 3, outputs: [proposal] };
  expect(record.checkpoints).toEqual([afterModel, afterTool]);
  expect(await run.checkpoints.read("run-fixture")).toEqual(afterTool);
  const evidence = await run.evidence.read("run-fixture");
  expect(evidence).toEqual(record);
  // Saved, recorded and read-back objects are copies: mutating them changes no later read.
  const dropOutput = (value: unknown) => (value as { outputs: unknown[] }).outputs.pop();
  dropOutput(record.checkpoints[1]);
  (record.steps as unknown[]).pop();
  dropOutput(evidence);
  dropOutput(await run.checkpoints.read("run-fixture"));
  expect(await run.checkpoints.read("run-fixture")).toEqual(afterTool);
  const reread = await run.evidence.read("run-fixture");
  expect([reread?.steps.map((step) => step.kind), reread?.outputs]).toEqual([
    ["model", "tool"],
    [proposal],
  ]);
  expect(await run.checkpoints.read("run-unknown")).toBeUndefined();
  expect(await run.evidence.read("run-unknown")).toBeUndefined();
  const bounded = ports({ maxSteps: 1, maxTokens: 10 }, toolTurn);
  expect(
    (await runBoundedCapabilityFixture(input, { maxSteps: 1, maxTokens: 10 }, bounded)).outputs,
  ).toEqual([]);
  expect(bounded.tool.script.consumed).toBe(0);
  expect(await bounded.checkpoints.read("run-fixture")).toEqual(afterModel);
});

it("replays scripted MCP discovery and invocation and refuses a direct mutation", async () => {
  const binding = { bindingId: "mcp-fixture" };
  const capability = { id: "suggest-no-op", kind: "tool", inputSchema: null } as const;
  const call = { ...binding, runId: input.runId, capabilityId: capability.id, input: null };
  const mutation = { kind: "direct-mutation", state: { revision: 999 } };
  const log = released();
  const mcp = new ScriptedMcpTransport(
    new CapabilityScript([{ input: binding, output: [capability] }]),
    new CapabilityScript([
      { input: call, output: [proposal] },
      { input: call, output: [mutation as unknown as CapabilityProposal] },
    ]),
    log.logger,
  );
  const mismatch = "capability script input mismatch";
  await expect(mcp.discover({ bindingId: "mcp-other" })).rejects.toThrow(mismatch);
  expect(await mcp.discover(binding)).toEqual([capability]);
  await expect(mcp.discover(binding)).rejects.toThrow("capability script exhausted");
  await expect(mcp.invoke({ ...call, input: "other" })).rejects.toThrow(mismatch);
  expect(await mcp.invoke(call)).toEqual([proposal]);
  await expect(mcp.invoke(call)).rejects.toThrow(
    "capability output refused: proposals only; direct mutation is forbidden",
  );
  await expect(mcp.invoke(call)).rejects.toThrow("capability script exhausted");
  // One record per call, without a step; discovery belongs to no run.
  const mcpCall = (outcome: string, runId?: string) => ({
    ...adapterCall("mcp", 0, outcome),
    step: undefined,
    runId,
  });
  expect(log.records()).toEqual([
    mcpCall("failed"),
    mcpCall("succeeded"),
    mcpCall("failed"),
    mcpCall("failed", "run-fixture"),
    mcpCall("succeeded", "run-fixture"),
    mcpCall("refused", "run-fixture"),
    mcpCall("failed", "run-fixture"),
  ]);
});

it("refuses a direct mutation proposed by a fake model", async () => {
  const mutation = {
    kind: "direct-mutation",
    state: { revision: 999 },
  } as unknown as CapabilityProposal;
  const run = ports({ maxSteps: 2, maxTokens: 10 }, { ...toolTurn, proposals: [mutation] });
  const log = released();
  await expect(
    runBoundedCapabilityFixture(input, { maxSteps: 2, maxTokens: 10 }, run, log.logger),
  ).rejects.toThrow("direct mutation");
  expect(log.records()).toEqual([adapterCall("model", 1, "refused")]);
});
