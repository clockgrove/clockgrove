import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeOpaqueId, type ObjectId } from "./ids.js";
import {
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

/**
 * Run and step evidence (Wave 5 §8, RW-0502). Every cognitive attempt for an actor is one run of
 * ordered steps; each ends in exactly one terminal disposition (`docs/protocols/runs.md`).
 */
export const RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "superseded",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const STEP_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
  "superseded",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
/** The step kinds of Wave 5 §8. */
export const STEP_KINDS = [
  "context_retrieval",
  "model_attempt",
  "tool_proposal",
  "approval",
  "tool_execution",
  "world_command_proposal",
  "validation",
  "commit",
  "delivery",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Decision: one search page, as a conversation read page. */
export const MAX_RUN_SEARCH_PAGE = 100;

/**
 * A protected artifact a run or step names. `text` is its exact content, present only for a
 * participant reader whose ceiling holds `conversation` and the artifact's class; otherwise it is
 * `null` and only the ID and class show. A prompt that includes actor documents is
 * `private_cognition` (`docs/protocols/context-assembly.md`).
 */
export interface ProtectedPayload {
  readonly artifactId: string;
  readonly privacyClass: "conversation" | "private_cognition";
  readonly text: string | null;
}

export interface RunStepView {
  readonly step: number;
  readonly kind: StepKind;
  readonly status: StepStatus;
  readonly outcomeCode: string | null;
  readonly model: string | null;
  readonly tool: string | null;
  /** What the step led to: a world command (follow it with the causal chain) or a message. */
  readonly commandId: string | null;
  readonly outputMessageId: string | null;
  /** Usage and cost where known; `null` is unknown. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicrousd: number | null;
  readonly summary: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly input: ProtectedPayload | null;
  readonly output: ProtectedPayload | null;
}

/** A run's safe metadata: what metadata search returns. It never holds a payload. */
export interface RunSummary {
  readonly runId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly principalId: string;
  readonly personaId: string;
  readonly activation: "conversation_message";
  readonly inputMessageId: string;
  readonly parentRunId: string | null;
  readonly parentStep: number | null;
  readonly rootRunId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputRevision: number;
  readonly status: RunStatus;
  readonly outcomeCode: string | null;
  readonly turn: number | null;
  readonly summary: string;
  readonly stepCount: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface RunView extends RunSummary {
  readonly prompt: ProtectedPayload | null;
  readonly steps: readonly RunStepView[];
}

/** Where a walk starts: a run, a conversation turn, a message, or a world command. */
export type RunEntry =
  | { readonly runId: string }
  | { readonly sessionId: string; readonly turn: number }
  | { readonly sessionId: string; readonly messageId: string }
  | { readonly commandId: string };

/** Every run of the causal trees the entry touches, each with its steps, oldest first. */
export interface RunWalk {
  readonly entry: RunEntry;
  readonly runs: readonly RunView[];
}

export interface RunSearch {
  readonly runs: readonly RunSummary[];
}

export interface RunInspectRequest {
  readonly scope: BrowserScope;
  readonly entry: RunEntry;
}

export interface RunSearchRequest {
  readonly scope: BrowserScope;
  readonly actorId?: ObjectId;
  readonly sessionId?: string;
  readonly status?: RunStatus;
  readonly limit: number;
}

const SCOPE_KEYS = ["version", "tenantId", "worldId", "timelineId", "spaceId"] as const;

function scoped(value: unknown, path: string, optional: readonly string[]) {
  const v = record(value, path);
  exactKeys(v, SCOPE_KEYS, optional, path);
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return { v, scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }) };
}

// Matches the inspector requests' ID bound (migrations 0022, 0031); a reply message ID may add
// `:reply` (0034).
function boundedId(value: unknown, path: string, octets = 1024): string {
  const id = string(value, path);
  if (id === "" || id.trim() !== id || new TextEncoder().encode(id).length > octets)
    throw new ContractDecodeError(path, "ID length out of range");
  return id;
}

/** Exactly one entry: `runId`, `commandId`, or `sessionId` with `turn` or `messageId`. */
export function decodeRunInspectRequest(value: unknown): RunInspectRequest {
  const path = "inspectRuns";
  const { v, scope } = scoped(value, path, [
    "runId",
    "commandId",
    "sessionId",
    "turn",
    "messageId",
  ]);
  const given = ["runId", "commandId", "sessionId", "turn", "messageId"].filter(
    (key) => v[key] !== undefined,
  );
  const shape = given.sort().join(",");
  let entry: RunEntry;
  if (shape === "runId") entry = { runId: boundedId(v.runId, `${path}.runId`) };
  else if (shape === "commandId")
    entry = { commandId: boundedId(v.commandId, `${path}.commandId`) };
  else if (shape === "sessionId,turn") {
    const turn = nonNegativeInteger(v.turn, `${path}.turn`);
    if (turn < 1 || turn > 500) throw new ContractDecodeError(`${path}.turn`, "turn out of range");
    entry = { sessionId: boundedId(v.sessionId, `${path}.sessionId`), turn };
  } else if (shape === "messageId,sessionId")
    entry = {
      sessionId: boundedId(v.sessionId, `${path}.sessionId`),
      messageId: boundedId(v.messageId, `${path}.messageId`, 1030),
    };
  else throw new ContractDecodeError(path, "exactly one entry required");
  return Object.freeze({ scope, entry: Object.freeze(entry) });
}

export function decodeRunSearchRequest(value: unknown): RunSearchRequest {
  const path = "searchRuns";
  const { v, scope } = scoped(value, path, ["actorId", "sessionId", "status", "limit"]);
  const limit = v.limit === undefined ? MAX_RUN_SEARCH_PAGE : nonNegativeInteger(v.limit, path);
  if (limit < 1 || limit > MAX_RUN_SEARCH_PAGE)
    throw new ContractDecodeError(`${path}.limit`, "limit out of range");
  return Object.freeze({
    scope,
    ...(v.actorId === undefined
      ? {}
      : { actorId: decodeOpaqueId(v.actorId, "ObjectId", `${path}.actorId`) }),
    ...(v.sessionId === undefined
      ? {}
      : { sessionId: boundedId(v.sessionId, `${path}.sessionId`) }),
    ...(v.status === undefined
      ? {}
      : { status: literal(v.status, RUN_STATUSES, `${path}.status`) }),
    limit,
  });
}
