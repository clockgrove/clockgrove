import { type BrowserScope, decodeBrowserScope } from "./browser-protocol.js";
import { decodeTalkReceipt, type TalkReceipt } from "./conversations.js";
import {
  ContractDecodeError,
  exactKeys,
  literal,
  nonNegativeInteger,
  record,
  string,
} from "./validation.js";

/** The recoverable turn fiber's phases (Wave 5 §7.1), in order, then its terminal phases. */
export const TURN_PHASES = [
  "accepted",
  "context_pending",
  "context_ready",
  "model_running",
  "proposal_validating",
  "tool_waiting",
  "tool_completed",
  "committing",
  "finalizing",
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "abandoned",
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];
export const TERMINAL_TURN_PHASES: readonly TurnPhase[] = [
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "abandoned",
];
/** The phases a cancel still stops: nothing is committed before `committing`. */
export const CANCELLABLE_TURN_PHASES: readonly TurnPhase[] = [
  "accepted",
  "context_pending",
  "context_ready",
  "model_running",
  "proposal_validating",
  "tool_waiting",
  "tool_completed",
];

/**
 * A turn's durable status: what a reconnecting client reads instead of the streamed tokens it may
 * have missed. `attempt` counts the owner claims so far; `outcomeCode` names a refusal or cancel.
 */
export interface TurnStatus {
  readonly sessionId: string;
  readonly messageId: string;
  readonly phase: TurnPhase;
  readonly attempt: number;
  readonly outcomeCode: string | null;
  /** The current waiting call's scoped metadata identity, never its arguments or result text. */
  readonly toolCallId?: string;
}

/** `/v1/runtime/turns/status` and `/v1/runtime/turns/cancel`: one turn, by its message ID. */
export interface TurnRequest {
  readonly scope: BrowserScope;
  readonly sessionId: string;
  readonly messageId: string;
}

/**
 * One NDJSON line of a streamed Talk. Deltas are disposable presentation; the receipt or refusal
 * that ends the stream is the durable outcome.
 */
export type TalkStreamFrame =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly capability: string;
      readonly status: "queued" | "using" | "completed" | "failed";
    }
  | { readonly type: "receipt"; readonly receipt: TalkReceipt }
  | { readonly type: "refused"; readonly status: number; readonly error: string };

function id(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.trim() !== text || new TextEncoder().encode(text).length > 1024)
    throw new ContractDecodeError(path, "ID length out of range");
  return text;
}

export function decodeTurnRequest(value: unknown, path = "turn"): TurnRequest {
  const v = record(value, path);
  exactKeys(
    v,
    ["version", "tenantId", "worldId", "timelineId", "spaceId", "sessionId", "messageId"],
    [],
    path,
  );
  if (v.version !== 1) throw new ContractDecodeError(`${path}.version`, "expected 1");
  const { tenantId, worldId, timelineId, spaceId } = v;
  return Object.freeze({
    scope: decodeBrowserScope({ tenantId, worldId, timelineId, spaceId }),
    sessionId: id(v.sessionId, `${path}.sessionId`),
    messageId: id(v.messageId, `${path}.messageId`),
  });
}

export function decodeTurnStatus(value: unknown, path = "turnStatus"): TurnStatus {
  const v = record(value, path);
  exactKeys(v, ["sessionId", "messageId", "phase", "attempt", "outcomeCode"], ["toolCallId"], path);
  if (v.toolCallId !== undefined && v.phase !== "tool_waiting")
    throw new ContractDecodeError(`${path}.toolCallId`, "expected a waiting turn");
  return Object.freeze({
    sessionId: id(v.sessionId, `${path}.sessionId`),
    messageId: id(v.messageId, `${path}.messageId`),
    phase: literal(v.phase, TURN_PHASES, `${path}.phase`),
    attempt: nonNegativeInteger(v.attempt, `${path}.attempt`),
    outcomeCode: v.outcomeCode === null ? null : string(v.outcomeCode, `${path}.outcomeCode`),
    ...(v.toolCallId === undefined ? {} : { toolCallId: id(v.toolCallId, `${path}.toolCallId`) }),
  });
}

export function decodeTalkStreamFrame(value: unknown, path = "talkStream"): TalkStreamFrame {
  const v = record(value, path);
  const type = literal(v.type, ["delta", "tool", "receipt", "refused"], `${path}.type`);
  if (type === "delta") {
    exactKeys(v, ["type", "text"], [], path);
    return Object.freeze({ type, text: string(v.text, `${path}.text`) });
  }
  if (type === "tool") {
    exactKeys(v, ["type", "callId", "capability", "status"], [], path);
    return Object.freeze({
      type,
      callId: id(v.callId, `${path}.callId`),
      capability: string(v.capability, `${path}.capability`),
      status: literal(v.status, ["queued", "using", "completed", "failed"], `${path}.status`),
    });
  }
  if (type === "receipt") {
    exactKeys(v, ["type", "receipt"], [], path);
    return Object.freeze({ type, receipt: decodeTalkReceipt(v.receipt) });
  }
  exactKeys(v, ["type", "status", "error"], [], path);
  return Object.freeze({
    type,
    status: nonNegativeInteger(v.status, `${path}.status`),
    error: string(v.error, `${path}.error`),
  });
}

/**
 * The `ActorProcess` extension contract (Wave 5 §1): a stable process identity owning a long-lived
 * objective, a checkpoint and a lease epoch, advanced by a sequence of bounded run segments. Each
 * segment claims a new epoch; a write under an older one is refused.
 */
export interface ActorProcess {
  readonly processId: string;
  readonly actorId: string;
  readonly objective: "fixture-tally";
  readonly target: number;
  readonly checkpoint: number;
  readonly state: "active" | "completed";
  readonly leaseEpoch: number;
  readonly segments: readonly ActorProcessSegment[];
}
export interface ActorProcessSegment {
  readonly segment: number;
  readonly leaseEpoch: number;
  readonly fromCheckpoint: number;
  readonly toCheckpoint: number;
}
