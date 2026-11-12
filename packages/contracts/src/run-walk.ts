import {
  type ProtectedPayload,
  RUN_STATUSES,
  type RunEntry,
  type RunStepView,
  type RunView,
  type RunWalk,
  STEP_KINDS,
  STEP_STATUSES,
} from "./runs.js";
import { ContractDecodeError, literal, nonNegativeInteger, record, string } from "./validation.js";

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractDecodeError(path, "expected text");
  return value;
}
function nullable<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T | null {
  return value === null ? null : decode(value, path);
}
function list<T>(
  value: unknown,
  path: string,
  max: number,
  decode: (v: unknown, p: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ContractDecodeError(path, "expected bounded array");
  return value.map((v, index) => decode(v, `${path}[${index}]`));
}
function payload(value: unknown, path: string): ProtectedPayload {
  const v = record(value, path);
  return {
    artifactId: string(v.artifactId, `${path}.artifactId`),
    privacyClass: literal(
      v.privacyClass,
      ["conversation", "private_cognition"],
      `${path}.privacyClass`,
    ),
    text: nullable(v.text, `${path}.text`, text),
  };
}
function duration(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ContractDecodeError(path, "expected a finite nonnegative duration");
  return value;
}
function toolEvidence(value: unknown, path: string): NonNullable<RunStepView["toolEvidence"]> {
  const v = record(value, path);
  return {
    callId: string(v.callId, `${path}.callId`),
    effectId: string(v.effectId, `${path}.effectId`),
    grantId: nullable(v.grantId, `${path}.grantId`, string),
    resultArtifactId: nullable(v.resultArtifactId, `${path}.resultArtifactId`, string),
    status: string(v.status, `${path}.status`),
    queueLatencyMs: nullable(v.queueLatencyMs, `${path}.queueLatencyMs`, duration),
  };
}
function step(value: unknown, path: string): RunStepView {
  const v = record(value, path);
  return {
    step: nonNegativeInteger(v.step, `${path}.step`),
    kind: literal(v.kind, STEP_KINDS, `${path}.kind`),
    status: literal(v.status, STEP_STATUSES, `${path}.status`),
    outcomeCode: nullable(v.outcomeCode, `${path}.outcomeCode`, string),
    model: nullable(v.model, `${path}.model`, string),
    tool: nullable(v.tool, `${path}.tool`, string),
    commandId: nullable(v.commandId, `${path}.commandId`, string),
    outputMessageId: nullable(v.outputMessageId, `${path}.outputMessageId`, string),
    inputTokens: nullable(v.inputTokens, `${path}.inputTokens`, nonNegativeInteger),
    outputTokens: nullable(v.outputTokens, `${path}.outputTokens`, nonNegativeInteger),
    costMicrousd: nullable(v.costMicrousd, `${path}.costMicrousd`, nonNegativeInteger),
    summary: text(v.summary, `${path}.summary`),
    startedAt: string(v.startedAt, `${path}.startedAt`),
    endedAt: nullable(v.endedAt, `${path}.endedAt`, string),
    input: nullable(v.input, `${path}.input`, payload),
    output: nullable(v.output, `${path}.output`, payload),
    ...(v.toolEvidence === undefined
      ? {}
      : { toolEvidence: toolEvidence(v.toolEvidence, `${path}.toolEvidence`) }),
  };
}
function run(value: unknown, path: string): RunView {
  const v = record(value, path);
  return {
    runId: string(v.runId, `${path}.runId`),
    sessionId: string(v.sessionId, `${path}.sessionId`),
    actorId: string(v.actorId, `${path}.actorId`),
    principalId: string(v.principalId, `${path}.principalId`),
    personaId: string(v.personaId, `${path}.personaId`),
    activation: literal(v.activation, ["conversation_message"], `${path}.activation`),
    inputMessageId: string(v.inputMessageId, `${path}.inputMessageId`),
    parentRunId: nullable(v.parentRunId, `${path}.parentRunId`, string),
    parentStep: nullable(v.parentStep, `${path}.parentStep`, nonNegativeInteger),
    rootRunId: string(v.rootRunId, `${path}.rootRunId`),
    model: string(v.model, `${path}.model`),
    promptVersion: string(v.promptVersion, `${path}.promptVersion`),
    inputRevision: nonNegativeInteger(v.inputRevision, `${path}.inputRevision`),
    status: literal(v.status, RUN_STATUSES, `${path}.status`),
    outcomeCode: nullable(v.outcomeCode, `${path}.outcomeCode`, string),
    turn: nullable(v.turn, `${path}.turn`, nonNegativeInteger),
    summary: text(v.summary, `${path}.summary`),
    stepCount: nonNegativeInteger(v.stepCount, `${path}.stepCount`),
    startedAt: string(v.startedAt, `${path}.startedAt`),
    endedAt: nullable(v.endedAt, `${path}.endedAt`, string),
    prompt: nullable(v.prompt, `${path}.prompt`, payload),
    steps: list(v.steps, `${path}.steps`, 32, step),
  };
}
function entry(value: unknown): RunEntry {
  const v = record(value, "runWalk.entry");
  const keys = Object.keys(v).sort().join(",");
  if (keys === "runId") return { runId: string(v.runId, "runWalk.entry.runId") };
  if (keys === "commandId") return { commandId: string(v.commandId, "runWalk.entry.commandId") };
  if (keys === "messageId,sessionId")
    return {
      sessionId: string(v.sessionId, "runWalk.entry.sessionId"),
      messageId: string(v.messageId, "runWalk.entry.messageId"),
    };
  if (keys === "sessionId,turn")
    return {
      sessionId: string(v.sessionId, "runWalk.entry.sessionId"),
      turn: nonNegativeInteger(v.turn, "runWalk.entry.turn"),
    };
  throw new ContractDecodeError("runWalk.entry", "expected one run entry");
}

/** Read the inspector's bounded view without trusting unvalidated response fields in the browser. */
export function decodeRunWalk(value: unknown): RunWalk {
  const v = record(value, "runWalk");
  return { entry: entry(v.entry), runs: list(v.runs, "runWalk.runs", 100, run) };
}
